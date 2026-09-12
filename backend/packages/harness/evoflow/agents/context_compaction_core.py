"""Hermes-style context compaction for LangChain message lists (main agent)."""

from __future__ import annotations

import contextvars
import json
import logging
import re
import threading
import time
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Literal

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, ToolMessage, messages_to_dict

from evoflow.config.summarization_config import get_summarization_config
from evoflow.config.tool_results_config import (
    prune_preserve_tool_names,
    tool_output_token_cap,
    tool_result_shaping_active,
)
from evoflow.context.compaction_token_utils import (
    _CHARS_PER_TOKEN,
    _CJK_RE,
    count_text_tokens,
)
from evoflow.context.compaction_token_utils import (
    SUMMARY_FAILURE_COOLDOWN_SECONDS as _SUMMARY_FAILURE_COOLDOWN_SECONDS,
)
from evoflow.models import create_chat_model
from evoflow.utils.model_context_length import compression_threshold_tokens

from evoflow.agents.compaction_trigger import (
    get_compaction_trigger_cache,
    normalize_thread_id,
    round_trigger_rearmed,
)

logger = logging.getLogger(__name__)

_SUMMARY_CONTENT_RATIO = 0.22
_MIN_SUMMARY_TOKENS = 800
_SUMMARY_TOKENS_CEILING = 8_000
_TAIL_TOKEN_RATIO = 0.18
_TAIL_SOFT_CEILING_RATIO = 1.2
_PRUNE_TOOL_MIN_TOKENS = 48
_PRUNED_TOOL_PLACEHOLDER = "[Old tool output cleared to save context space]"
_TAIL_TOOL_CAP_TOKENS = 4096


def _compaction_tool_truncate_tokens(cfg: Any) -> int:
    """Align compaction tail caps with write-time shaper when shaping is on."""
    if tool_result_shaping_active():
        return tool_output_token_cap()
    return int(getattr(cfg, "critical_tool_truncate_tokens", _TAIL_TOOL_CAP_TOKENS) or _TAIL_TOOL_CAP_TOKENS)


def _compaction_moderate_truncate_tokens(cfg: Any) -> int:
    if tool_result_shaping_active():
        return min(tool_output_token_cap(), int(getattr(cfg, "moderate_tool_truncate_tokens", 1024) or 1024))
    return int(getattr(cfg, "moderate_tool_truncate_tokens", 1024) or 1024)
_TAIL_TOOL_CAP_NAMES = frozenset({"read_file", "worker", "search_code_index", "grep", "glob", "list_dir"})

# Tiered tool pruning: critical tools get head+tail preservation when pruned,
# moderate tools get shorter truncation, other tools are fully cleared.
_CRITICAL_PRUNE_TOOLS = frozenset({
    "read_file", "grep", "search_code_index", "search_content", "worker",
})
_MODERATE_PRUNE_TOOLS = frozenset({
    "execute_command", "list_dir", "search_file", "web_search", "web_fetch",
})
_CONTENT_MAX = 6000
_CONTENT_HEAD = 4000
_CONTENT_TAIL = 1500
_TOOL_ARGS_MAX = 1500
_TOOL_ARGS_HEAD = 1200
_MIN_MESSAGES_TO_COMPRESS = 8

# Legacy aliases — policy lives in compaction_trigger.py
_round_trigger_rearmed = round_trigger_rearmed
# Legacy fallback when the middleware hasn't injected a real overhead figure.
# The real value is computed once per model call (real system prompt tokens +
# real tool-schema JSON tokens) and pushed into ``_CURRENT_GATE_OVERHEAD``.
_MODEL_OVERHEAD_TOKEN_BUFFER = 4096

# Per-message ChatML/Anthropic framing overhead. OpenAI documents +3 per
# message (role + separators) plus +3 to prime the assistant reply; Anthropic
# is similar. We use +4 as a conservative cross-provider constant. Previously
# this was +10, which double-counted role tokens and inflated short messages.
_MESSAGE_FRAMING_TOKENS = 4

# Coarse multimodal token estimates. Real values depend on resolution / sample
# rate / provider, but we just need an order-of-magnitude figure so a turn
# carrying images doesn't slip under the compaction threshold.
_IMAGE_BLOCK_TOKEN_EST = 3000   # conservative: covers large vision tiles so image messages don't slip under compaction threshold
_AUDIO_BLOCK_TOKEN_EST = 1500   # ~30s of speech at GPT-4o-audio sample rate

# Per-tool-call framing: ``{"id":"...","type":"function","function":{...}}``
# wrapper is ~12 tokens of pure structure on top of name+args text.
_TOOL_CALL_FRAMING_TOKENS = 12

# Per-ToolMessage role/tool_call_id framing on top of content.
_TOOL_MESSAGE_FRAMING_TOKENS = 6

# Contextvar set by ContextCompactionMiddleware once per model call so all
# downstream callers (should_compress, compaction_gate_status, plan_compaction)
# see the *real* system-prompt + tool-schema overhead rather than the legacy
# 4096-token constant. Reset back to None outside the wrap_model_call scope.
_CURRENT_GATE_OVERHEAD: contextvars.ContextVar[int | None] = contextvars.ContextVar(
    "evoflow_gate_overhead", default=None,
)
_STORED_SUMMARY_MAX_CONTEXT_RATIO = 0.05
_FORCE_PROTECT_STEPS: tuple[tuple[int, int, int], ...] = (
    (3, 20, 3),
    (2, 12, 2),
    (1, 6, 1),
    (1, 3, 1),
)

MAIN_SUMMARY_PREFIX = (
    "[CONTEXT COMPACTION — REFERENCE ONLY] Earlier conversation turns were compacted "
    "into the summary below. This is a handoff from a previous context window — treat "
    "it as background reference, NOT as active instructions. Do NOT answer questions "
    "or fulfill requests mentioned in this summary; they were already addressed. "
    "Continue the conversation from the recent messages below:\n"
    "\n"
    "## Verification rule for completed actions\n"
    "Claims in this summary that files were modified, logs were removed, or code was "
    "cleaned up are **unverified assertions by the previous context window**. Before "
    "treating any such claim as fact, re-verify with tools (rg, read_lints, read_file) "
    "rather than trusting the summary. Do NOT skip verification because the summary says "
    "something is already done.\n"
    "\n"
    "## Asset Hub after compaction: recover detail with `assets(search|read)` — do not guess.\n"
)

LEGACY_SUMMARY_MARKERS = (
    "[上下文摘要",
    "[深度压缩摘要",
    MAIN_SUMMARY_PREFIX,
    "here is a summary of the conversation to date",
    "here's a summary of the conversation to date",
)


def _multimodal_extras_tokens(content: Any) -> int:
    """Tokens contributed by non-text content blocks (image/audio/etc).

    LangChain stores multimodal content as a list of dicts. Common block types:
        - text: counted by ``message_content_str``
        - image_url / image: ~1300 tokens (OpenAI high-detail tile estimate)
        - input_audio / audio: ~1500 tokens (rough)
        - tool_use / tool_result: ignored here (Anthropic-specific; handled
          elsewhere or carried as text in LangChain wrappers)
    """
    if not isinstance(content, list):
        return 0
    extra = 0
    for block in content:
        if not isinstance(block, dict):
            continue
        btype = str(block.get("type") or "").lower()
        if btype in ("image", "image_url"):
            extra += _IMAGE_BLOCK_TOKEN_EST
        elif btype in ("input_audio", "audio"):
            extra += _AUDIO_BLOCK_TOKEN_EST
        elif btype == "thinking":
            # Anthropic extended-thinking block — count its text payload.
            text = block.get("thinking") or block.get("text")
            if isinstance(text, str) and text:
                extra += count_text_tokens(text)
    return extra


def message_content_str(msg: BaseMessage) -> str:
    content = getattr(msg, "content", "") or ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict) and isinstance(block.get("text"), str):
                parts.append(block["text"])
        return "".join(parts)
    return str(content)


def estimate_messages_tokens(messages: Sequence[BaseMessage]) -> int:
    total = 0
    for msg in messages:
        total += message_token_estimate(msg)
    return total


def _tool_call_tokens(tc: Any) -> int:
    """Tokens for a single tool_call entry on an AIMessage.

    Counts the *whole* call (id + name + args + JSON wrapper) by serializing
    it and tokenizing the result, then adds a small framing constant for the
    surrounding ``{"id":...,"type":"function","function":{...}}`` shell.
    Previously we only counted ``str(args)`` which severely underestimated
    turns with many tool calls.
    """
    if isinstance(tc, dict):
        # Normalize both LangChain shape (``{"name","args","id"}``) and the
        # raw OpenAI shape (``{"id","type","function":{"name","arguments"}}``).
        try:
            serialized = json.dumps(tc, ensure_ascii=False, default=str)
        except Exception:
            serialized = str(tc)
        return count_text_tokens(serialized) + _TOOL_CALL_FRAMING_TOKENS
    return count_text_tokens(str(tc)) + _TOOL_CALL_FRAMING_TOKENS


def message_token_estimate(msg: BaseMessage) -> int:
    """Estimate the wire-format token cost of a single message.

    Counts content text + multimodal blocks + reasoning + tool_calls (whole
    serialized entries, not just args) + per-message framing. The framing
    constant (+4) approximates ChatML/Anthropic role separators and is much
    closer to provider truth than the legacy +10.
    """
    content = getattr(msg, "content", "") or ""
    tokens = count_text_tokens(message_content_str(msg))
    tokens += _multimodal_extras_tokens(content)

    if isinstance(msg, AIMessage):
        extra = getattr(msg, "additional_kwargs", None) or {}
        reasoning = extra.get("reasoning_content")
        if reasoning:
            tokens += count_text_tokens(str(reasoning))
        for tc in msg.tool_calls or []:
            tokens += _tool_call_tokens(tc)

    if isinstance(msg, ToolMessage):
        # ToolMessages carry tool_call_id + tool name on top of content; the
        # legacy estimator dropped these entirely. They're small but add up
        # over long tool-heavy histories.
        tokens += _TOOL_MESSAGE_FRAMING_TOKENS
        name = getattr(msg, "name", None)
        if isinstance(name, str) and name:
            tokens += count_text_tokens(name)
        tcid = getattr(msg, "tool_call_id", None)
        if isinstance(tcid, str) and tcid:
            tokens += count_text_tokens(tcid)

    return tokens + _MESSAGE_FRAMING_TOKENS


def set_gate_overhead_tokens(tokens: int) -> contextvars.Token:
    """Push the real (system prompt + tool schema) overhead for this call.

    Called by ``ContextCompactionMiddleware`` once per model invocation. The
    value flows through ``estimate_gate_tokens`` so threshold checks see the
    actual prompt budget instead of the legacy 4096-token guess.
    """
    return _CURRENT_GATE_OVERHEAD.set(max(0, int(tokens)))


def reset_gate_overhead_tokens(token: contextvars.Token) -> None:
    _CURRENT_GATE_OVERHEAD.reset(token)


def current_gate_overhead_tokens() -> int:
    """Active overhead figure, or the legacy default if middleware hasn't pushed one."""
    override = _CURRENT_GATE_OVERHEAD.get()
    if override is not None:
        return override
    return _MODEL_OVERHEAD_TOKEN_BUFFER


def estimate_gate_tokens(messages: Sequence[BaseMessage]) -> int:
    """Message token estimate plus real system-prompt / tool-schema overhead.

    The overhead comes from the contextvar set by the compaction middleware
    (real tokens computed once per call). When unset (tests / legacy callers)
    falls back to ``_MODEL_OVERHEAD_TOKEN_BUFFER`` for backwards compatibility.
    """
    return estimate_messages_tokens(messages) + current_gate_overhead_tokens()


def estimate_tokens_after_last_model_message(messages: Sequence[BaseMessage]) -> int:
    """Estimate tokens for items after the last ``AIMessage`` (runtime growth delta)."""
    typed = list(messages)
    last_ai = -1
    for i, msg in enumerate(typed):
        if isinstance(msg, AIMessage):
            last_ai = i
    if last_ai < 0 or last_ai >= len(typed) - 1:
        return 0
    return estimate_messages_tokens(typed[last_ai + 1 :])


def resolve_compaction_gate_tokens(
    messages: Sequence[BaseMessage],
    *,
    session_key: str = "",
) -> int:
    """Active-context size for compaction triggers — runtime ``get_total_token_usage``.

    Runtime: ``last_token_usage.total_tokens`` + estimated tokens of items after the
    last model-generated item. No ``max`` with a full-history tiktoken re-estimate.

    Before any provider usage sample exists, fall back to a local gate estimate
    (bootstrap only).
    """
    sk = str(session_key or "").strip()
    last_api = 0
    if sk:
        try:
            from evoflow.persistence.session_context_usage import load_last_observed_active_tokens

            last_api = load_last_observed_active_tokens(sk)
        except Exception:
            last_api = 0
    if last_api > 0:
        return last_api + estimate_tokens_after_last_model_message(messages)
    return estimate_gate_tokens(messages)

def _cap_summary_text(text: str, *, context_length: int) -> str:
    """Cap stored/reused summary size so compaction state cannot grow without bound.

    Uses head + tail retention (70/30 token budget split) with paragraph-boundary
    alignment so structured summary sections at the tail (Key Context / Pending Asks /
    Remaining Work) aren't lost. Falls back to head-only when body is too small.
    """
    raw = str(text or "").strip()
    if not raw:
        return raw
    max_tokens = max(_MIN_SUMMARY_TOKENS, int(context_length * _STORED_SUMMARY_MAX_CONTEXT_RATIO))
    if count_text_tokens(raw) <= max_tokens:
        return raw
    if raw.startswith(MAIN_SUMMARY_PREFIX[:20]):
        prefix = MAIN_SUMMARY_PREFIX
        body = raw[len(MAIN_SUMMARY_PREFIX) :].lstrip()
    else:
        prefix = ""
        body = raw
    budget = max(256, max_tokens - count_text_tokens(prefix) - 32)
    if count_text_tokens(body) <= budget:
        return raw

    # head + tail 保留：按 token 预算的 70/30 分配（reserve ~16 tokens for marker）
    head_budget = int(budget * 0.70)
    tail_budget = max(64, budget - head_budget - 16)

    # 字符近似（4 chars/token），按段落边界裁剪以保留章节结构
    head_chars = max(256, head_budget * _CHARS_PER_TOKEN)
    tail_chars = max(256, tail_budget * _CHARS_PER_TOKEN)

    if len(body) <= head_chars + tail_chars + 64:
        # body 太短，无法做 head/tail 切分，退化为简单 head 截断
        truncated_body = body[: head_chars + tail_chars].rstrip()
        suffix = "\n\n[Summary truncated to fit context budget.]"
        return f"{prefix}\n{truncated_body}{suffix}" if prefix else f"{truncated_body}{suffix}"

    head_part = body[:head_chars]
    tail_part = body[-tail_chars:]

    # 在 head 后半段找最后一个段落边界（\n\n），避免切断章节中间
    nl_head = head_part.rfind("\n\n")
    if nl_head > head_chars // 2:
        head_part = head_part[:nl_head]

    # 在 tail 前半段找第一个段落边界，从该处开始保留尾部
    nl_tail = tail_part.find("\n\n")
    if 0 < nl_tail < tail_chars // 2:
        tail_part = tail_part[nl_tail:].lstrip()

    truncated_body = (
        f"{head_part.rstrip()}"
        "\n\n[... earlier summary content truncated to fit context budget ...]\n\n"
        f"{tail_part.lstrip()}"
    )
    return f"{prefix}\n{truncated_body}" if prefix else truncated_body


def _emergency_force_plan(messages: list[BaseMessage]) -> CompactionPlan | None:
    """Last-resort structural fold when protect rules leave no compressible middle."""
    n = len(messages)
    if n < 3:
        return None
    working = _prune_old_tool_results(messages, protect_tail_count=2, protect_tail_tokens=800)
    head_end = _align_boundary_forward(working, min(2, max(1, n - 2)))
    compress_end = max(head_end + 1, n - 2)
    compress_end = _align_boundary_backward(working, compress_end)
    if head_end >= compress_end:
        head_end = 1
        compress_end = max(2, n - 1)
    middle = [m for m in working[head_end:compress_end] if not is_compaction_message(m)]
    if not middle:
        return None
    middle_tokens = sum(message_token_estimate(m) for m in middle)
    logger.warning(
        "Context compaction emergency force plan msgs=%d head_end=%d compress_end=%d middle=%d",
        n,
        head_end,
        compress_end,
        len(middle),
    )
    return CompactionPlan(
        working=working,
        head_end=head_end,
        compress_end=compress_end,
        middle=middle,
        middle_tokens=middle_tokens,
        original_count=n,
    )


def _resolve_compaction_plan(
    messages: list[BaseMessage],
    *,
    context_length: int,
    threshold_ratio: float,
    aggressive_ratio: float,
    protect_first_n: int,
    protect_tail_messages: int,
    protect_tail_tool_rounds: int,
    aggressive: bool,
    force: bool,
) -> CompactionPlan | None:
    """Resolve a compaction plan; when ``force``, relax protect rules then emergency fold."""
    # 早返回：消息数太少时省掉所有循环
    if len(messages) < _MIN_MESSAGES_TO_COMPRESS:
        return None

    protect_steps: list[tuple[int, int, int]] = [(protect_first_n, protect_tail_messages, protect_tail_tool_rounds)]
    if force:
        for step in _FORCE_PROTECT_STEPS:
            if step not in protect_steps:
                protect_steps.append(step)

    aggressives = (aggressive, not aggressive)
    for pfn, ptm, pttr in protect_steps:
        for agg in aggressives:
            plan = plan_compaction(
                messages,
                context_length=context_length,
                threshold_ratio=threshold_ratio,
                aggressive_ratio=aggressive_ratio,
                protect_first_n=pfn,
                protect_tail_messages=ptm,
                protect_tail_tool_rounds=pttr,
                aggressive=agg,
            )
            if plan is not None:
                if (pfn, ptm, pttr) != (protect_first_n, protect_tail_messages, protect_tail_tool_rounds):
                    logger.warning(
                        "Context compaction plan succeeded with relaxed protect first=%d tail=%d tools=%d aggressive=%s",
                        pfn,
                        ptm,
                        pttr,
                        agg,
                    )
                return plan
        if not force:
            break

    if force:
        emergency = _emergency_force_plan(messages)
        if emergency is not None:
            return emergency
        skip = explain_plan_compaction_skip(
            messages,
            context_length=context_length,
            threshold_ratio=threshold_ratio,
            aggressive_ratio=aggressive_ratio,
            protect_first_n=protect_first_n,
            protect_tail_messages=protect_tail_messages,
            protect_tail_tool_rounds=protect_tail_tool_rounds,
            aggressive=aggressive,
        )
        logger.warning("Context compaction emergency plan failed: %s", skip or "unknown")
    return None


def detect_user_language(messages: Sequence[BaseMessage]) -> Literal["zh", "en"]:
    """Infer summary language from recent real user turns; default zh for EvoFlow.

    Heuristic uses weighted comparison of CJK chars vs. English words (≥2 letters),
    so single-letter variable names and stray Chinese terms don't flip the result.
    Default ``zh`` reflects EvoFlow's primary user base.
    """
    samples: list[str] = []
    for msg in reversed(list(messages)):
        if not isinstance(msg, HumanMessage):
            continue
        if is_compaction_message(msg):
            continue
        name = getattr(msg, "name", None)
        if name and str(name).strip() in {
            "conversation_summary",
            "tool_history",
            "todo_reminder",
            "collab_phase_hint",
        }:
            continue
        text = message_content_str(msg).strip()
        if not text:
            continue
        samples.append(text)
        if len(samples) >= 6:
            break
    if not samples:
        return "zh"

    joined = " ".join(samples)
    cjk = len(_CJK_RE.findall(joined))
    # 至少 2 字母才算英文词，过滤变量名 / 单字符噪声
    latin_words = len(re.findall(r"[A-Za-z]{2,}", joined))

    # 强信号：纯英文（无 CJK 且有足够英文词）
    if cjk == 0 and latin_words >= 8:
        return "en"
    # 强信号：英文占绝对主导（少量混入的中文术语不算）
    if latin_words >= 20 and cjk <= 3:
        return "en"
    # 强信号：纯中文（CJK 多且英文词稀少）
    if cjk >= 10 and latin_words <= cjk // 5:
        return "zh"

    # 混合场景按加权比较：一个中文字 ≈ 半个英文词的信息量
    cjk_weight = cjk
    latin_weight = latin_words * 2
    if latin_weight > cjk_weight * 1.5:
        return "en"

    # 其他混合 / 不确定 → 默认中文（产品定位）
    return "zh"


def is_compaction_message(msg: BaseMessage) -> bool:
    name = getattr(msg, "name", None)
    if name and str(name).strip() in {"conversation_summary", "tool_history"}:
        return True
    text = message_content_str(msg).strip()
    lower = text.lower()
    if lower.startswith("here is a summary of the conversation to date"):
        return True
    if lower.startswith("here's a summary of the conversation to date"):
        return True
    return any(text.startswith(marker) for marker in LEGACY_SUMMARY_MARKERS if not marker.startswith("here"))


def is_conversation_summary_human(msg: BaseMessage) -> bool:
    if not isinstance(msg, HumanMessage):
        return False
    name = str(getattr(msg, "name", None) or "").strip()
    if name == "tool_history":
        return False
    if name == "conversation_summary":
        return True
    text = message_content_str(msg).strip()
    lower = text.lower()
    if lower.startswith("here is a summary of the conversation to date"):
        return True
    if lower.startswith("here's a summary of the conversation to date"):
        return True
    return any(text.startswith(marker) for marker in LEGACY_SUMMARY_MARKERS if not marker.startswith("here"))


def is_tool_history_human(msg: BaseMessage) -> bool:
    if not isinstance(msg, HumanMessage):
        return False
    name = str(getattr(msg, "name", None) or "").strip()
    if name == "tool_history":
        return True
    from evoflow.context.tool_result_summarizer import is_frozen_tool_history

    return is_frozen_tool_history(message_content_str(msg))


def _strip_summary_body_for_merge(content: str) -> str:
    text = (content or "").strip()
    if not text:
        return ""
    lower = text.lower()
    if lower.startswith("here is a summary of the conversation to date"):
        return text.split("\n", 1)[1].strip() if "\n" in text else ""
    if lower.startswith("here's a summary of the conversation to date"):
        return text.split("\n", 1)[1].strip() if "\n" in text else ""
    for marker in LEGACY_SUMMARY_MARKERS:
        if marker.startswith("here"):
            continue
        if text.startswith(marker):
            return text.split("\n", 1)[1].strip() if "\n" in text else ""
    if text.startswith(MAIN_SUMMARY_PREFIX):
        return text[len(MAIN_SUMMARY_PREFIX) :].lstrip()
    return text


def partition_compaction_artifacts(
    messages: list[BaseMessage],
) -> tuple[list[BaseMessage], list[str], list[str]]:
    """Pull prior summary/tool-history blocks out so the next pass emits at most one of each."""
    stripped: list[BaseMessage] = []
    summary_bodies: list[str] = []
    tool_history_bodies: list[str] = []
    for msg in messages:
        if is_conversation_summary_human(msg):
            body = _strip_summary_body_for_merge(message_content_str(msg))
            if body:
                summary_bodies.append(body)
            continue
        if is_tool_history_human(msg):
            body = message_content_str(msg).strip()
            if body:
                tool_history_bodies.append(body)
            continue
        stripped.append(msg)
    return stripped, summary_bodies, tool_history_bodies


def dedupe_compaction_artifacts(messages: list[BaseMessage]) -> list[BaseMessage]:
    """Safety net: keep only the first conversation summary and first tool-history block."""
    out: list[BaseMessage] = []
    seen_summary = False
    seen_tool_history = False
    for msg in messages:
        if is_conversation_summary_human(msg):
            if seen_summary:
                continue
            seen_summary = True
        elif is_tool_history_human(msg):
            if seen_tool_history:
                continue
            seen_tool_history = True
        out.append(msg)
    return out


def _last_conversation_summary_index(messages: Sequence[BaseMessage]) -> int:
    last = -1
    for i, msg in enumerate(messages):
        if is_conversation_summary_human(msg):
            last = i
    return last


def _hydration_pre_summary_bridge(messages: Sequence[BaseMessage], *, before_idx: int) -> list[BaseMessage]:
    """Pre-compaction user turns loaded by DB hydration (Runtime: user asks old→new)."""
    from evoflow.agents.message_analysis_utils import is_real_user_message

    return [m for m in messages[:before_idx] if is_real_user_message(m)]


def _is_hydration_pre_summary_bridge(messages: Sequence[BaseMessage], summary_idx: int) -> bool:
    """True when messages before the summary marker are real user turns only (DB bridge)."""
    from evoflow.agents.message_analysis_utils import is_real_user_message

    if summary_idx <= 0:
        return False
    saw_user = False
    for msg in messages[:summary_idx]:
        if is_conversation_summary_human(msg) or is_tool_history_human(msg):
            continue
        if is_real_user_message(msg):
            saw_user = True
            continue
        return False
    return saw_user


def _extract_preserved_user_messages(
    messages: Sequence[BaseMessage],
    *,
    end_idx: int,
    max_turns: int = 3,
) -> list[BaseMessage]:
    """Collect recent real user turns from ``messages[:end_idx]`` (runtime pre-summary stitch)."""
    from evoflow.agents.message_analysis_utils import is_real_user_message
    from evoflow.persistence.chat_message_repositories import _PRE_COMPACTION_KEEP_USER_TURNS

    cap = max(1, int(max_turns or _PRE_COMPACTION_KEEP_USER_TURNS))
    stop = max(0, min(int(end_idx), len(messages)))
    kept: list[BaseMessage] = []
    for msg in messages[:stop]:
        if is_real_user_message(msg):
            kept.append(msg)
    if len(kept) <= cap:
        return kept
    return kept[-cap:]


def transcript_has_conversation_summary(messages: Sequence[BaseMessage]) -> bool:
    return any(is_conversation_summary_human(m) for m in messages)


def should_passthrough_db_hydrated_transcript(
    messages: Sequence[BaseMessage],
    gate: dict[str, Any],
    *,
    force: bool = False,
) -> bool:
    """DB hydration already stitched [bridge][summary][tail] — never refold in memory."""
    if force or gate.get("should_trigger"):
        return False
    if not transcript_has_conversation_summary(messages):
        return False
    return True


def try_fold_hydrated_transcript(
    messages: list[BaseMessage],
    *,
    summary: str,
    protect_tail_messages: int = 12,
) -> tuple[list[BaseMessage], bool] | None:
    """No-op reshaping for DB-hydrated transcripts (post-compaction tail stays complete).

    Hydration already stitches ``[pre-summary user turns] → [summary] → [post tail]`` from
    ``evoflow_chat_messages``. Refolds must not trim or reorder the post-compaction
    segment — only a future explicit re-compaction may replace the summary body.
    """
    _ = (messages, summary, protect_tail_messages)
    return None


def _with_summary_prefix(summary: str) -> str:
    text = (summary or "").strip()
    for marker in LEGACY_SUMMARY_MARKERS:
        if marker.startswith("here"):
            continue
        if text.startswith(marker):
            text = text.split("\n", 1)[1].lstrip() if "\n" in text else ""
            break
    if text.startswith(MAIN_SUMMARY_PREFIX):
        return text
    return f"{MAIN_SUMMARY_PREFIX}\n{text}" if text else MAIN_SUMMARY_PREFIX


def _serialize_messages(turns: Sequence[BaseMessage]) -> str:
    parts: list[str] = []
    for msg in turns:
        role = msg.type if hasattr(msg, "type") else "unknown"
        content = message_content_str(msg)
        if len(content) > _CONTENT_MAX:
            content = content[:_CONTENT_HEAD] + "\n...[truncated]...\n" + content[-_CONTENT_TAIL:]
        if isinstance(msg, ToolMessage):
            tid = getattr(msg, "tool_call_id", "") or ""
            parts.append(f"[TOOL RESULT {tid}]: {content}")
            continue
        if isinstance(msg, AIMessage) and msg.tool_calls:
            tc_lines = []
            for tc in msg.tool_calls:
                if isinstance(tc, dict):
                    name = tc.get("name") or tc.get("function", {}).get("name", "?")
                    args = tc.get("args") or tc.get("function", {}).get("arguments", "")
                    args_s = str(args)
                    if len(args_s) > _TOOL_ARGS_MAX:
                        args_s = args_s[:_TOOL_ARGS_HEAD] + "..."
                    tc_lines.append(f"  {name}({args_s})")
            content = (content or "") + "\n[Tool calls:\n" + "\n".join(tc_lines) + "\n]"
        parts.append(f"[{role.upper()}]: {content}")
    return "\n\n".join(parts)


def _compute_summary_budget(
    turns: Sequence[BaseMessage],
    *,
    context_length: int,
    summary_ratio: float | None = None,
) -> int:
    cfg = get_summarization_config()
    ratio = summary_ratio if summary_ratio is not None else cfg.summary_content_ratio
    content_tokens = estimate_messages_tokens(turns)
    budget = int(content_tokens * ratio)
    # Higher ceiling for larger context windows; floor at 8K for standard models.
    ceiling = max(_SUMMARY_TOKENS_CEILING, int(context_length * 0.08))
    ceiling = min(ceiling, _SUMMARY_TOKENS_CEILING * 2)  # hard cap at 16K
    return max(_MIN_SUMMARY_TOKENS, min(budget, ceiling))


def _tail_start_cap_by_tool_rounds(
    messages: list[BaseMessage],
    head_end: int,
    keep_tool_rounds: int,
) -> int:
    """Earliest index where tail may start when keeping only ``keep_tool_rounds`` recent tools."""
    tool_indices = [i for i, m in enumerate(messages) if isinstance(m, ToolMessage)]
    if len(tool_indices) <= keep_tool_rounds:
        return len(messages)
    cold_tools = len(tool_indices) - keep_tool_rounds
    cut = tool_indices[cold_tools]
    if cut > 0 and isinstance(messages[cut - 1], AIMessage):
        cut -= 1
    return max(cut, head_end + 1)


def _find_tail_start(
    messages: list[BaseMessage],
    head_end: int,
    token_budget: int,
    min_tail: int,
) -> int:
    n = len(messages)
    min_tail = min(min_tail, max(0, n - head_end - 1))
    soft_ceiling = int(token_budget * _TAIL_SOFT_CEILING_RATIO)
    accumulated = 0
    cut_idx = n

    for i in range(n - 1, head_end - 1, -1):
        msg_tokens = message_token_estimate(messages[i])
        if accumulated + msg_tokens > soft_ceiling and (n - i) >= min_tail:
            break
        accumulated += msg_tokens
        cut_idx = i

    fallback = n - min_tail
    if cut_idx > fallback:
        cut_idx = fallback
    if cut_idx <= head_end:
        cut_idx = max(fallback, head_end + 1)
    cut_idx = _align_boundary_backward(messages, cut_idx)
    return max(cut_idx, head_end + 1)


def _align_boundary_forward(messages: list[BaseMessage], idx: int) -> int:
    while idx < len(messages) and isinstance(messages[idx], ToolMessage):
        idx += 1
    return idx


def _align_boundary_backward(messages: list[BaseMessage], idx: int) -> int:
    if idx <= 0 or idx >= len(messages):
        return idx
    check = idx - 1
    while check >= 0 and isinstance(messages[check], ToolMessage):
        check -= 1
    if check >= 0 and isinstance(messages[check], AIMessage) and messages[check].tool_calls:
        idx = check
    return idx


def _prune_old_tool_results(
    messages: list[BaseMessage],
    protect_tail_count: int,
    protect_tail_tokens: int,
) -> list[BaseMessage]:
    if not messages:
        return messages
    n = len(messages)
    min_protect = min(protect_tail_count, max(0, n - 1))
    accumulated = 0
    boundary = n
    for i in range(n - 1, -1, -1):
        msg_tokens = message_token_estimate(messages[i])
        if accumulated + msg_tokens > protect_tail_tokens and (n - i) >= min_protect:
            boundary = i
            break
        accumulated += msg_tokens
        boundary = i
    prune_boundary = max(boundary, n - min_protect)

    cfg = get_summarization_config()
    preserve_tools = prune_preserve_tool_names()
    result: list[BaseMessage] = []
    for i, msg in enumerate(messages):
        if i < prune_boundary and isinstance(msg, ToolMessage):
            tool_name = str(getattr(msg, "name", None) or "").strip().lower()
            content = message_content_str(msg)
            # Always preserve: archived summaries, user-configured preserve list, clarification tools
            if "[tool:history]" in content or "[tool:summary]" in content or "[ToolResult summary" in content or "[ToolResult persisted" in content or "Full output:" in content:
                result.append(msg)
                continue
            if tool_name in preserve_tools:
                result.append(msg)
                continue
            if getattr(msg, "name", None) == "ask_clarification":
                result.append(msg)
                continue
            # Tiered pruning: critical → head+tail, moderate → truncate, other → clear
            tok_count = count_text_tokens(content)
            if tool_name in _CRITICAL_PRUNE_TOOLS:
                # Critical tools: preserve head+tail to retain file paths and key results
                cap = _compaction_tool_truncate_tokens(cfg)
                if tok_count > cap:
                    result.append(
                        ToolMessage(
                            content=_truncate_text_for_token_budget(content, cap),
                            tool_call_id=msg.tool_call_id,
                            name=getattr(msg, "name", None),
                        )
                    )
                    continue
            elif tool_name in _MODERATE_PRUNE_TOOLS:
                # Moderate tools: shorter truncation preserves command output gist
                cap = _compaction_moderate_truncate_tokens(cfg)
                if tok_count > cap:
                    result.append(
                        ToolMessage(
                            content=_truncate_text_for_token_budget(content, cap),
                            tool_call_id=msg.tool_call_id,
                            name=getattr(msg, "name", None),
                        )
                    )
                    continue
            else:
                # Other tools: clear entirely when above minimum threshold
                if content != _PRUNED_TOOL_PLACEHOLDER and tok_count > cfg.prune_tool_min_tokens:
                    result.append(
                        ToolMessage(
                            content=_PRUNED_TOOL_PLACEHOLDER,
                            tool_call_id=msg.tool_call_id,
                            name=getattr(msg, "name", None),
                        )
                    )
                    continue
        result.append(msg)
    return result


def _truncate_text_for_token_budget(text: str, max_tokens: int) -> str:
    raw = str(text or "")
    if not raw or count_text_tokens(raw) <= max_tokens:
        return raw
    if len(raw) <= _CONTENT_HEAD + _CONTENT_TAIL + 96:
        return raw[: max(256, len(raw) // 2)] + "\n\n[Truncated for context budget.]"
    omitted = max(0, count_text_tokens(raw) - max_tokens)
    return (
        f"{raw[:_CONTENT_HEAD]}\n\n"
        f"[... ~{omitted} tokens omitted for context budget; use read_file/worker search to re-fetch ...]\n\n"
        f"{raw[-_CONTENT_TAIL:]}"
    )


def _shrink_oversized_tail_tool_outputs(
    messages: list[BaseMessage],
    *,
    tail_start: int,
    max_tool_tokens: int | None = None,
) -> list[BaseMessage]:
    """Cap huge read_file/worker outputs kept verbatim in the protected tail."""
    if tail_start < 0 or tail_start >= len(messages):
        return messages
    cfg = get_summarization_config()
    cap_tokens = max_tool_tokens if max_tool_tokens is not None else _compaction_tool_truncate_tokens(cfg)
    cap_names = _TAIL_TOOL_CAP_NAMES | _CRITICAL_PRUNE_TOOLS | _MODERATE_PRUNE_TOOLS
    out: list[BaseMessage] = list(messages)
    changed = False
    for i in range(tail_start, len(out)):
        msg = out[i]
        if not isinstance(msg, ToolMessage):
            continue
        tool_name = str(getattr(msg, "name", None) or "").strip().lower()
        if tool_name not in cap_names:
            continue
        content = message_content_str(msg)
        if count_text_tokens(content) <= cap_tokens:
            continue
        shrunk = _truncate_text_for_token_budget(content, cap_tokens)
        if shrunk == content:
            continue
        out[i] = ToolMessage(
            content=shrunk,
            tool_call_id=msg.tool_call_id,
            name=getattr(msg, "name", None),
        )
        changed = True
    if changed:
        logger.info(
            "Context compaction capped oversized tail tool outputs tail_start=%d msgs=%d",
            tail_start,
            len(messages),
        )
    return out


def _get_tool_call_id(tc: Any) -> str:
    if isinstance(tc, dict):
        return str(tc.get("id", "") or "")
    return str(getattr(tc, "id", "") or "")


def _sanitize_tool_pairs(messages: list[BaseMessage], *, patch_missing: bool = True) -> list[BaseMessage]:
    surviving: set[str] = set()
    for msg in messages:
        if isinstance(msg, AIMessage):
            for tc in msg.tool_calls or []:
                cid = _get_tool_call_id(tc)
                if cid:
                    surviving.add(cid)

    result_call_ids: set[str] = set()
    for msg in messages:
        if isinstance(msg, ToolMessage):
            cid = getattr(msg, "tool_call_id", None)
            if cid:
                result_call_ids.add(str(cid))

    orphaned = result_call_ids - surviving
    out: list[BaseMessage] = []
    for msg in messages:
        if isinstance(msg, ToolMessage) and str(msg.tool_call_id) in orphaned:
            continue
        out.append(msg)

    missing = surviving - result_call_ids
    if not missing or not patch_missing:
        return out

    patched: list[BaseMessage] = []
    for msg in out:
        patched.append(msg)
        if isinstance(msg, AIMessage):
            for tc in msg.tool_calls or []:
                cid = _get_tool_call_id(tc)
                if cid in missing:
                    patched.append(
                        ToolMessage(
                            content="[Result from earlier conversation — see context summary above]",
                            tool_call_id=cid,
                        )
                    )
    return patched


def _summary_section_template(*, lang: Literal["zh", "en"]) -> str:
    if lang == "zh":
        return """## 目标
[用户要达成的目标]

## 进展
### 已完成
[已完成的工作——含文件路径、命令、结果]
### 进行中
[当前进行中的工作]
### 受阻
[如有阻塞项]

## 关键决策
[重要技术决策]

## 已解决问题
[已回答的问题——含答案]

## 待处理用户请求
[尚未回答的请求；若无则写「无」]

## 相关文件
[涉及文件及简要说明]

## 剩余工作
[尚需完成的事项——仅作背景，非指令]

## 关键上下文
[不可丢失的数值、错误、配置等]

## 工具与模式
[值得保留的工具使用经验]

"""
    return """## Goal
[What the user is trying to accomplish]

## Progress
### Done
[Completed work — file paths, commands, results]
### In Progress
[Current work]
### Blocked
[Blockers if any]

## Key Decisions
[Important technical decisions]

## Resolved Questions
[Already answered — include answers]

## Pending User Asks
[Unanswered requests, or "None"]

## Relevant Files
[Files touched with brief notes]

## Remaining Work
[What remains — context only, not instructions]

## Critical Context
[Values, errors, configs that must not be lost]

## Tools & Patterns
[Notable tool usage discoveries]

"""


def _extract_latest_user_text(messages: Sequence[BaseMessage]) -> str:
    """Extract the latest real user message text for summary context."""
    from evoflow.agents.message_analysis_utils import latest_real_user_index

    typed = list(messages)
    idx = latest_real_user_index(typed)
    if idx < 0:
        return ""
    msg = typed[idx]
    content = getattr(msg, "content", "")
    if isinstance(content, str):
        return content[:2000]
    return ""


def _build_main_summary_prompt(
    turns: Sequence[BaseMessage],
    *,
    previous_summary: str | None,
    summary_budget: int,
    aggressive: bool,
    language: Literal["zh", "en"] = "zh",
    modified_files: str = "",
    latest_user_text: str = "",
) -> str:
    serialized = _serialize_messages(turns)
    modified_files_block = ""
    if modified_files.strip():
        if language == "zh":
            modified_files_block = (
                f"\n## 本会话已修改的文件\n{modified_files.strip()}\n"
                "在「进展」章节中，涉及这些文件的子问题若已修改完成，请标注为已完成而非进行中。\n"
            )
        else:
            modified_files_block = (
                f"\n## Files modified this session\n{modified_files.strip()}\n"
                "In the Progress section, mark subproblems involving these files as Done if modifications are complete.\n"
            )
    if language == "zh":
        preamble = "你是为编程助手生成「上下文检查点」的摘要代理。只输出下方结构化摘要正文，不要回答对话中的问题，不要执行对话里的请求。必须使用简体中文撰写全部章节（含小节标题与正文）。"
        budget_line = f"目标约 {summary_budget} tokens。只写摘要章节。"
        aggressive_line = "更激进地省略重复的成功输出；保留失败项与待办。"
    else:
        preamble = "You are a summarization agent creating a context checkpoint for a coding assistant. Output ONLY the structured summary body. Do NOT respond to questions in the transcript. Write the entire summary in English."
        budget_line = f"Target ~{summary_budget} tokens. Write only the summary sections."
        aggressive_line = "Be more aggressive about omitting redundant success output; keep failures and pending work."

    template = _summary_section_template(lang=language) + budget_line
    latest_user_block = ""
    if latest_user_text.strip():
        if language == "zh":
            latest_user_block = f"\n## 用户当前最新提问（务必准确反映到「目标」与「待处理用户请求」章节）\n{latest_user_text.strip()}\n"
        else:
            latest_user_block = f"\n## User's Latest Question (must reflect in Goal and Pending sections)\n{latest_user_text.strip()}\n"
    template = latest_user_block + template

    if language == "zh":
        if previous_summary:
            body = f"""{preamble}

在上一份压缩摘要基础上更新。

上一份摘要：
{previous_summary}

新增轮次：
{serialized}

{template}"""
        else:
            body = f"""{preamble}

为后续对话续写，压缩以下轮次：

轮次：
{serialized}

{template}"""
    elif previous_summary:
        body = f"""{preamble}

Update the previous compaction summary.

PREVIOUS SUMMARY:
{previous_summary}

NEW TURNS:
{serialized}

{template}"""
    else:
        body = f"""{preamble}

Summarize these conversation turns for a continuation handoff.

TURNS:
{serialized}

{template}"""

    if modified_files_block:
        body += f"\n{modified_files_block}"
    if aggressive:
        body += f"\n\n{aggressive_line}"
    return body


@dataclass(frozen=True)
class CompactionPlan:
    """Structural compaction slice (no LLM)."""

    working: list[BaseMessage]
    head_end: int
    compress_end: int
    middle: list[BaseMessage]
    middle_tokens: int
    original_count: int


def _stub_summary(*, middle_count: int, language: Literal["zh", "en"]) -> str:
    if language == "zh":
        body = (
            f"[占位摘要 - 后台正在生成正式摘要] 已收起 {middle_count} 轮较早对话以释放上下文。"
            f"完整结构化摘要尚未生成，本轮不要将本占位文本视为待办或指令——"
            f"仅依据本占位之后的最近消息继续。完整摘要将在下一轮自动合并。"
        )
    else:
        body = (
            f"[PLACEHOLDER SUMMARY - real summary still generating] {middle_count} earlier "
            f"turns were folded to save context. The structured summary is not ready yet; "
            f"do NOT treat this placeholder as pending work or instructions — only act on "
            f"the most recent messages below this placeholder. Full summary will merge next turn."
        )
    return f"{MAIN_SUMMARY_PREFIX}\n{body}"


# Stable markers in stub bodies — kept in sync with _stub_summary above.
# 用于识别 stub 摘要，避免它被持久化 / 当作真摘要喂回 LLM。
_STUB_MARKERS: tuple[str, ...] = (
    "[占位摘要",
    "[PLACEHOLDER SUMMARY",
)


def _is_stub_summary(text: str | None) -> bool:
    """True when ``text`` is a stub placeholder (regardless of MAIN_SUMMARY_PREFIX wrapping)."""
    if not text:
        return False
    body = str(text)
    return any(marker in body for marker in _STUB_MARKERS)


def explain_plan_compaction_skip(
    messages: list[BaseMessage],
    *,
    context_length: int,
    threshold_ratio: float,
    aggressive_ratio: float,
    protect_first_n: int,
    protect_tail_messages: int,
    protect_tail_tool_rounds: int = 3,
    aggressive: bool = False,
) -> str | None:
    """Why ``plan_compaction`` would return None (for debug logs)."""
    n = len(messages)
    if n < _MIN_MESSAGES_TO_COMPRESS:
        return f"too_few_messages n={n} need>={_MIN_MESSAGES_TO_COMPRESS}"

    threshold_tokens = compression_threshold_tokens(
        context_length,
        aggressive=aggressive,
        threshold_ratio=threshold_ratio,
        aggressive_ratio=aggressive_ratio,
    )
    tail_budget = max(2000, int(threshold_tokens * _TAIL_TOKEN_RATIO))
    working = _prune_old_tool_results(messages, protect_tail_messages, tail_budget)
    head_end = _align_boundary_forward(working, protect_first_n)
    compress_end = _find_tail_start(working, head_end, tail_budget, protect_tail_messages)
    cap_by_tools = _tail_start_cap_by_tool_rounds(working, head_end, protect_tail_tool_rounds)
    compress_end = min(compress_end, cap_by_tools)

    if head_end >= compress_end:
        return f"no_middle_segment head_end={head_end} compress_end={compress_end} n={n} protect_tail_tools={protect_tail_tool_rounds}"

    middle = [m for m in working[head_end:compress_end] if not is_compaction_message(m)]
    if not middle:
        return f"middle_empty head_end={head_end} compress_end={compress_end} n={n}"
    return None


def compaction_gate_status(
    messages: Sequence[BaseMessage],
    *,
    context_length: int,
    threshold_ratio: float,
    aggressive_ratio: float,
    protect_first_n: int = 3,
    protect_tail_messages: int = 20,
    protect_tail_tool_rounds: int = 3,
    thread_id: str = "",
    force: bool = False,
    compaction_cooldown_seconds: float = 0.0,
    compaction_hysteresis_enabled: bool = False,
    compaction_trigger_message_count: int = 0,
    session_key: str = "",
    log_phase: str = "gate",
    evaluate_policy: bool = True,
) -> dict[str, Any]:
    """Token threshold + plan feasibility snapshot for console debugging."""
    typed = list(messages)
    n = len(typed)
    tokens = resolve_compaction_gate_tokens(typed, session_key=session_key)
    threshold = compression_threshold_tokens(
        context_length,
        aggressive=False,
        threshold_ratio=threshold_ratio,
        aggressive_ratio=aggressive_ratio,
    )
    min_msgs = _MIN_MESSAGES_TO_COMPRESS
    tid = normalize_thread_id(thread_id)
    cache = get_compaction_trigger_cache()
    snap = cache.snapshot(tid)
    last_msg_count = snap.message_count if snap is not None else 0
    # Message-count round trigger disabled (runtime-aligned); kept for log fields only.
    round_trigger = round_trigger_rearmed(
        n,
        compaction_trigger_message_count=compaction_trigger_message_count,
        last_compress_message_count=last_msg_count,
    )
    token_ok = tokens >= threshold
    count_ok = n >= min_msgs
    trigger = token_ok and count_ok
    if not count_ok:
        block = f"message_count {n} < min {min_msgs}"
    elif not token_ok:
        block = f"tokens {tokens} < threshold {threshold}"
    else:
        block = explain_plan_compaction_skip(
            typed,
            context_length=context_length,
            threshold_ratio=threshold_ratio,
            aggressive_ratio=aggressive_ratio,
            protect_first_n=protect_first_n,
            protect_tail_messages=protect_tail_messages,
            protect_tail_tool_rounds=protect_tail_tool_rounds,
        )
    if evaluate_policy:
        llm_decision = cache.evaluate(
            thread_id=tid,
            tokens=tokens,
            message_count=n,
            min_messages=min_msgs,
            context_length=context_length,
            threshold_ratio=threshold_ratio,
            aggressive_ratio=aggressive_ratio,
            force=force,
            compaction_cooldown_seconds=compaction_cooldown_seconds,
            compaction_hysteresis_enabled=compaction_hysteresis_enabled,
            compaction_trigger_message_count=compaction_trigger_message_count,
            session_key=session_key or None,
            log_phase=log_phase,
        )
        llm_allowed = llm_decision.allow
        trigger_reason = llm_decision.reason
        same_run = llm_decision.same_run
        in_cooldown = llm_decision.in_cooldown
    else:
        llm_allowed = True
        trigger_reason = "diagnostic"
        same_run = False
        in_cooldown = False
    cooldown_active = (
        evaluate_policy
        and not force
        and token_ok
        and compaction_cooldown_seconds > 0
        and in_cooldown
    )
    if (
        evaluate_policy
        and trigger
        and block is None
        and not llm_allowed
        and cooldown_active
    ):
        block = (
            trigger_reason
            if trigger_reason not in ("below_threshold",)
            else f"cooldown active ({compaction_cooldown_seconds:.0f}s)"
        )
    return {
        "message_count": n,
        "tokens": tokens,
        "context_length": context_length,
        "threshold": threshold,
        "threshold_ratio": threshold_ratio,
        "token_over_threshold": token_ok,
        "round_trigger": round_trigger,
        "round_trigger_threshold": int(compaction_trigger_message_count or 0),
        "count_ok": count_ok,
        "should_trigger": (
            trigger and block is None and llm_allowed if evaluate_policy else False
        ),
        "should_refold_cached": (
            trigger and block is None and cooldown_active and not llm_allowed
            if evaluate_policy
            else False
        ),
        "block_reason": block,
        "cooldown_active": cooldown_active,
        "trigger_reason": trigger_reason,
        "same_run": same_run,
        "allow_compress": llm_allowed if evaluate_policy else None,
        "evaluate_policy": evaluate_policy,
    }


def log_compaction_gate(
    messages: Sequence[BaseMessage],
    *,
    thread_id: str,
    context_length: int,
    threshold_ratio: float,
    aggressive_ratio: float,
    protect_first_n: int,
    protect_tail_messages: int,
    protect_tail_tool_rounds: int,
    phase: str,
    model_name: str | None = None,
    force: bool = False,
    compaction_cooldown_seconds: float = 0.0,
    compaction_hysteresis_enabled: bool = False,
    compaction_trigger_message_count: int = 0,
    session_key: str = "",
    evaluate_policy: bool = True,
) -> dict[str, Any]:
    """Emit one-line compaction decision to harness console (INFO)."""
    status = compaction_gate_status(
        messages,
        context_length=context_length,
        threshold_ratio=threshold_ratio,
        aggressive_ratio=aggressive_ratio,
        protect_first_n=protect_first_n,
        protect_tail_messages=protect_tail_messages,
        protect_tail_tool_rounds=protect_tail_tool_rounds,
        thread_id=thread_id,
        force=force,
        compaction_cooldown_seconds=compaction_cooldown_seconds,
        compaction_hysteresis_enabled=compaction_hysteresis_enabled,
        compaction_trigger_message_count=compaction_trigger_message_count,
        session_key=session_key,
        log_phase=phase,
        evaluate_policy=evaluate_policy,
    )
    tokens = int(status["tokens"])
    window = max(1, int(status["context_length"]))
    pct = round(tokens / window * 100.0, 1)
    need = bool(status.get("allow_compress") if evaluate_policy else status.get("should_trigger"))
    # Always print occupancy triage fields (evaluate() also logs when policy on).
    logger.info(
        "[context-compaction] 压缩判定 tokens=%d/%d (%.1f%%) need_compress=%s "
        "threshold=%d phase=%s thread=%s model=%s msgs=%d reason=%s",
        tokens,
        window,
        pct,
        "yes" if need else "no",
        int(status["threshold"]),
        phase,
        (thread_id or "")[:16],
        model_name or "?",
        status["message_count"],
        status.get("trigger_reason") or status.get("block_reason") or "",
    )
    try:
        from evoflow.context.model_request_token_estimate import current_gate_overhead_meta
        from evoflow.observability.compaction_file_log import count_message_rounds, log_compaction_trace

        rounds = count_message_rounds(messages)
        log_compaction_trace(
            "gate检查",
            thread_id=thread_id,
            session_key=session_key,
            model_name=model_name,
            phase=phase,
            force=force,
            context_length=status["context_length"],
            model_context=f"{status['context_length'] // 1000}k",
            gate_tokens=status["tokens"],
            occupancy_pct=pct,
            need_compress=need,
            threshold=status["threshold"],
            threshold_ratio=threshold_ratio,
            aggressive_ratio=aggressive_ratio,
            should_trigger=status["should_trigger"],
            should_refold_cached=status.get("should_refold_cached"),
            block_reason=status.get("block_reason") or "",
            cooldown_active=status.get("cooldown_active"),
            token_over_threshold=status.get("token_over_threshold"),
            count_ok=status.get("count_ok"),
            allow_compress=status.get("allow_compress"),
            trigger_reason=status.get("trigger_reason") or "",
            same_turn=status.get("same_run"),
            diagnostic_only=not status.get("evaluate_policy", True),
            **rounds,
            **(current_gate_overhead_meta() or {}),
        )
    except Exception:
        logger.debug("compaction trace log failed (gate)", exc_info=True)
    return status


def compaction_token_snapshot(
    messages: Sequence[BaseMessage],
    *,
    context_length: int,
) -> dict[str, Any]:
    """History vs gate token counts for compaction before/after visibility."""
    hist = estimate_messages_tokens(messages)
    gate = estimate_gate_tokens(messages)
    ctx_k = max(1, context_length // 1000)
    pct = (gate / context_length * 100.0) if context_length > 0 else 0.0
    snap: dict[str, Any] = {
        "message_count": len(messages),
        "history_tokens": hist,
        "gate_tokens": gate,
        "overhead_tokens": max(0, gate - hist),
        "context_length": context_length,
        "context_k": ctx_k,
        "pct_of_context": round(pct, 1),
    }
    try:
        from evoflow.context.model_request_token_estimate import current_gate_overhead_meta

        meta = current_gate_overhead_meta()
        if meta:
            for key in ("system_tokens", "tools_tokens", "tool_count"):
                if key in meta:
                    snap[key] = meta[key]
    except Exception:
        pass
    return snap


def _format_compaction_snapshot_brief(snap: dict[str, Any]) -> str:
    return (
        f"{snap['gate_tokens']} tok ({snap['pct_of_context']}%/{snap['context_k']}k) "
        f"{snap['message_count']} msgs"
    )


def log_compaction_pass_result(
    before: Sequence[BaseMessage],
    after: Sequence[BaseMessage],
    *,
    context_length: int,
    thread_id: str,
    model_name: str | None = None,
    pass_label: str,
) -> None:
    """Log one compaction pass: tokens/messages before → after."""
    b = compaction_token_snapshot(before, context_length=context_length)
    a = compaction_token_snapshot(after, context_length=context_length)
    saved = b["gate_tokens"] - a["gate_tokens"]
    saved_pct = (saved / b["gate_tokens"] * 100.0) if b["gate_tokens"] > 0 else 0.0
    logger.info(
        "[context-compaction] PASS %s thread=%s model=%s | %s → %s | Δ -%d tok (-%.1f%%)",
        pass_label,
        (thread_id or "")[:16],
        model_name or "?",
        _format_compaction_snapshot_brief(b),
        _format_compaction_snapshot_brief(a),
        saved,
        saved_pct,
    )
    try:
        from evoflow.observability.compaction_file_log import count_message_rounds, log_compaction_trace

        log_compaction_trace(
            "压缩进行中",
            thread_id=thread_id,
            model_name=model_name,
            pass_label=pass_label,
            context_length=context_length,
            model_context=f"{context_length // 1000}k",
            before=_format_compaction_snapshot_brief(b),
            after=_format_compaction_snapshot_brief(a),
            saved_tokens=saved,
            saved_pct=f"{saved_pct:.1f}%",
            **count_message_rounds(after),
        )
    except Exception:
        logger.debug("compaction trace log failed (pass)", exc_info=True)


def log_compaction_model_payload(
    before: Sequence[BaseMessage],
    after: Sequence[BaseMessage],
    *,
    context_length: int,
    thread_id: str,
    model_name: str | None = None,
    passes: list[str] | None = None,
    note: str = "",
) -> None:
    """Log final model-bound context: compression before → after (ephemeral payload)."""
    b = compaction_token_snapshot(before, context_length=context_length)
    a = compaction_token_snapshot(after, context_length=context_length)
    saved = b["gate_tokens"] - a["gate_tokens"]
    saved_pct = (saved / b["gate_tokens"] * 100.0) if b["gate_tokens"] > 0 else 0.0
    pass_s = ",".join(passes) if passes else "-"
    note_s = f" note={note}" if note else ""
    if saved <= 0:
        effect = "无减少" if saved == 0 else f"增加 {-saved} tok"
    else:
        effect = f"减少 {saved} tok (-{saved_pct:.1f}%)"
    logger.info(
        "[context-compaction] 模型上下文 thread=%s model=%s | 压缩前: %s | 压缩后: %s | %s | passes=[%s]%s",
        (thread_id or "")[:16],
        model_name or "?",
        _format_compaction_snapshot_brief(b),
        _format_compaction_snapshot_brief(a),
        effect,
        pass_s,
        note_s,
    )
    try:
        from evoflow.observability.compaction_file_log import count_message_rounds, log_compaction_trace

        log_compaction_trace(
            "模型上下文",
            thread_id=thread_id,
            model_name=model_name,
            context_length=context_length,
            model_context=f"{context_length // 1000}k",
            before=_format_compaction_snapshot_brief(b),
            after=_format_compaction_snapshot_brief(a),
            effect=effect,
            passes=passes or [],
            note=note,
            gate_tokens=a["gate_tokens"],
            history_tokens=a["history_tokens"],
            overhead_tokens=a["overhead_tokens"],
            pct_of_context=a["pct_of_context"],
            **count_message_rounds(after),
        )
    except Exception:
        logger.debug("compaction trace log failed (payload)", exc_info=True)


def log_compaction_skipped(
    messages: Sequence[BaseMessage],
    *,
    context_length: int,
    thread_id: str,
    model_name: str | None = None,
    threshold: int,
    reason: str = "below_threshold",
) -> None:
    snap = compaction_token_snapshot(messages, context_length=context_length)
    logger.info(
        "[context-compaction] 未压缩 thread=%s model=%s | 当前 %s | threshold=%d (%s)",
        (thread_id or "")[:16],
        model_name or "?",
        _format_compaction_snapshot_brief(snap),
        threshold,
        reason,
    )
    try:
        from evoflow.observability.compaction_file_log import count_message_rounds, log_compaction_trace

        log_compaction_trace(
            "未触发压缩",
            thread_id=thread_id,
            model_name=model_name,
            context_length=context_length,
            model_context=f"{context_length // 1000}k",
            gate_tokens=snap["gate_tokens"],
            history_tokens=snap["history_tokens"],
            overhead_tokens=snap["overhead_tokens"],
            pct_of_context=snap["pct_of_context"],
            threshold=threshold,
            reason=reason,
            should_trigger=False,
            **count_message_rounds(messages),
        )
    except Exception:
        logger.debug("compaction trace log failed (skipped)", exc_info=True)


def plan_compaction(
    messages: list[BaseMessage],
    *,
    context_length: int,
    threshold_ratio: float,
    aggressive_ratio: float,
    protect_first_n: int,
    protect_tail_messages: int,
    protect_tail_tool_rounds: int = 3,
    aggressive: bool = False,
) -> CompactionPlan | None:
    # 内联早返回检查，避免在 explain_plan_compaction_skip 中重复 prune/align/find_tail
    n = len(messages)
    if n < _MIN_MESSAGES_TO_COMPRESS:
        return None

    threshold_tokens = compression_threshold_tokens(
        context_length,
        aggressive=aggressive,
        threshold_ratio=threshold_ratio,
        aggressive_ratio=aggressive_ratio,
    )
    tail_budget = max(2000, int(threshold_tokens * _TAIL_TOKEN_RATIO))

    working = _prune_old_tool_results(messages, protect_tail_messages, tail_budget)
    head_end = _align_boundary_forward(working, protect_first_n)
    compress_end = _find_tail_start(working, head_end, tail_budget, protect_tail_messages)
    cap_by_tools = _tail_start_cap_by_tool_rounds(working, head_end, protect_tail_tool_rounds)
    compress_end = min(compress_end, cap_by_tools)

    if head_end >= compress_end:
        return None

    middle = [m for m in working[head_end:compress_end] if not is_compaction_message(m)]
    if not middle:
        return None

    if estimate_gate_tokens(working) >= threshold_tokens:
        working = _shrink_oversized_tail_tool_outputs(working, tail_start=compress_end)
        # working 可能被替换为收缩后的新列表，重算 middle 以保持引用一致
        middle = [m for m in working[head_end:compress_end] if not is_compaction_message(m)]

    middle_tokens = sum(message_token_estimate(m) for m in middle)
    return CompactionPlan(
        working=working,
        head_end=head_end,
        compress_end=compress_end,
        middle=middle,
        middle_tokens=middle_tokens,
        original_count=n,
    )


def _lean_compaction_tool_history(messages: Sequence[BaseMessage]) -> list[BaseMessage]:
    """At most one tool-history block to prepend after fold."""
    for msg in messages:
        if is_tool_history_human(msg):
            return [msg]
    return []


def _lean_compaction_active_turn(messages: Sequence[BaseMessage]) -> list[BaseMessage]:
    """Latest real user message and everything after it (current turn tool/AI hops)."""
    from evoflow.agents.message_analysis_utils import latest_real_user_index

    typed = list(messages)
    idx = latest_real_user_index(typed)
    if idx < 0:
        return [
            m
            for m in typed
            if not is_conversation_summary_human(m) and not is_tool_history_human(m)
        ]
    return [
        m
        for m in typed[idx:]
        if not is_conversation_summary_human(m) and not is_tool_history_human(m)
    ]


_DATA_IMAGE_URI_RE = re.compile(
    r"data:image/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+",
    re.IGNORECASE,
)


def _strip_data_image_uris_from_text(text: str) -> str:
    raw = str(text or "")
    if "data:image" not in raw.lower():
        return raw
    return _DATA_IMAGE_URI_RE.sub("[Image — base64 data omitted to save context]", raw)


def _image_block_placeholder(block: dict[str, Any]) -> dict[str, str]:
    url = block.get("image_url", {})
    if isinstance(url, dict):
        url_val = str(url.get("url") or "")
        if url_val.startswith("data:"):
            mime = url_val.split(";")[0].replace("data:", "") or "image"
            return {"type": "text", "text": f"[Image ({mime}) — base64 data omitted to save context]"}
    source = block.get("source")
    if isinstance(source, dict):
        media = str(source.get("media_type") or source.get("mime_type") or "image")
        return {"type": "text", "text": f"[Image ({media}) — base64 data omitted to save context]"}
    return {"type": "text", "text": "[Image — data omitted to save context]"}


def _is_vision_content_block(block: dict[str, Any]) -> bool:
    btype = str(block.get("type") or "").lower()
    if btype in ("image", "image_url", "input_image"):
        return True
    source = block.get("source")
    if isinstance(source, dict) and str(source.get("type") or "").lower() in ("base64", "image", "url"):
        return True
    return False


def strip_image_base64_from_messages(
    messages: list[BaseMessage],
    *,
    strip_all: bool = False,
) -> list[BaseMessage]:
    """Replace image_url/image content blocks with text placeholders in old messages.

    ``ViewImageMiddleware`` injects ``HumanMessage`` instances containing full base64
    image data.  These messages persist in conversation history and are resent
    to the model on every turn, wasting context with large base64 payloads.

    This function replaces image blocks in messages **before the current active
    turn** (i.e. messages before the latest real user message) with lightweight
    text placeholders, so old images don't bloat the model context.

    Messages within the current active turn (latest user message onward) are
    preserved unchanged so the model can still see images from the current turn
    unless ``strip_all=True`` (emergency overflow after vendor image+text token errors).
    """
    from evoflow.agents.message_analysis_utils import latest_real_user_index

    if not messages:
        return messages

    # Only strip images from messages before the current active turn.
    boundary = latest_real_user_index(list(messages))
    if boundary < 0 or strip_all:
        boundary = len(messages)  # no user message / emergency — strip all

    result: list[BaseMessage] | None = None
    for i in range(min(boundary, len(messages))):
        msg = messages[i]
        content = getattr(msg, "content", None)
        msg_changed = False
        new_content: Any = content

        if isinstance(content, str):
            stripped_text = _strip_data_image_uris_from_text(content)
            if stripped_text != content:
                new_content = stripped_text
                msg_changed = True
        elif isinstance(content, list):
            new_blocks: list[Any] = []
            for block in content:
                if isinstance(block, dict) and _is_vision_content_block(block):
                    msg_changed = True
                    new_blocks.append(_image_block_placeholder(block))
                    continue
                if isinstance(block, dict) and isinstance(block.get("text"), str):
                    text = block["text"]
                    stripped_text = _strip_data_image_uris_from_text(text)
                    if stripped_text != text:
                        msg_changed = True
                        new_blocks.append({**block, "text": stripped_text})
                        continue
                if isinstance(block, str):
                    stripped_text = _strip_data_image_uris_from_text(block)
                    if stripped_text != block:
                        msg_changed = True
                        new_blocks.append(stripped_text)
                        continue
                new_blocks.append(block)
            if msg_changed:
                new_content = new_blocks

        if msg_changed:
            if result is None:
                result = list(messages)
            result[i] = msg.model_copy(update={"content": new_content})

    return result if result is not None else messages


def apply_compaction_with_summary(plan: CompactionPlan, summary: str) -> list[BaseMessage]:
    """Fold to: tool_history + [pre-summary user turns] + conversation_summary + tail."""
    text = summary if summary.strip().startswith(MAIN_SUMMARY_PREFIX[:20]) else _with_summary_prefix(summary)
    working = plan.working
    summary_idx = _last_conversation_summary_index(working)
    compressed: list[BaseMessage] = []
    compressed.extend(_lean_compaction_tool_history(working))

    if summary_idx >= 0 and _is_hydration_pre_summary_bridge(working, summary_idx):
        compressed.extend(_hydration_pre_summary_bridge(working, before_idx=summary_idx))
    else:
        preserve_end = summary_idx if summary_idx >= 0 else plan.compress_end
        compressed.extend(
            _extract_preserved_user_messages(working, end_idx=preserve_end)
        )
    compressed.append(HumanMessage(content=text, name="conversation_summary"))
    # Use the tail boundary computed by plan_compaction (plan.compress_end),
    # NOT _lean_compaction_active_turn which ignores compress_end and returns
    # everything from the latest user message — effectively undoing the
    # compression when the user message is far from the end.
    tail_start = plan.compress_end
    if 0 < tail_start < len(working):
        active_turn = [
            m for m in working[tail_start:]
            if not is_conversation_summary_human(m) and not is_tool_history_human(m)
        ]
    else:
        active_turn = _lean_compaction_active_turn(working)
    # Fill empty ToolMessage content — many models (e.g. DeepSeek) return empty
    # output when they receive a tool result with empty content, treating it
    # as "nothing to respond to".
    patched_turn: list[BaseMessage] = []
    for msg in active_turn:
        if isinstance(msg, ToolMessage):
            content = getattr(msg, "content", None)
            if content is None or (isinstance(content, str) and not content.strip()):
                msg = ToolMessage(
                    content="[Tool completed — no output]",
                    tool_call_id=msg.tool_call_id,
                    name=getattr(msg, "name", None),
                )
        patched_turn.append(msg)
    compressed.extend(patched_turn)
    return dedupe_compaction_artifacts(_sanitize_tool_pairs(compressed, patch_missing=False))


def persist_compaction_summary_from_messages(
    messages: Sequence[BaseMessage],
    *,
    thread_id: str,
    session_key: str | None = None,
    force_write: bool = True,
) -> dict[str, Any] | None:
    """Write the ``conversation_summary`` row from folded messages immediately after compress."""
    sk = str(session_key or "").strip()
    if not sk:
        sk = get_context_compaction_engine()._resolve_session_key(thread_id)
    if not sk:
        logger.warning(
            "persist_compaction_summary_from_messages: missing session_key thread=%s",
            str(thread_id or "")[:16],
        )
        try:
            from evoflow.observability.compaction_file_log import log_compaction_trace

            log_compaction_trace(
                "摘要落库失败",
                thread_id=str(thread_id or ""),
                level=logging.WARNING,
                note="missing session_key",
            )
        except Exception:
            pass
        return None
    for msg in reversed(messages):
        if not is_conversation_summary_human(msg):
            continue
        text = message_content_str(msg)
        if not text.strip():
            continue
        from evoflow.persistence.chat_message_repositories import persist_conversation_summary
        from evoflow.persistence.transcript_run_id import resolve_run_id_for_transcript

        row = persist_conversation_summary(
            sk,
            text,
            thread_id=str(thread_id or "").strip() or None,
            run_id=resolve_run_id_for_transcript(
                sk,
                role="user",
                thread_id=str(thread_id or "").strip() or None,
            ),
            skip_if_unchanged=not force_write,
            force_write=force_write,
        )
        if row is not None:
            logger.info(
                "compaction summary persisted session=%s seq=%s message_id=%s thread=%s skipped=%s",
                sk[:24],
                row.get("seq"),
                row.get("message_id"),
                str(thread_id or "")[:16],
                row.get("skipped"),
            )
        return row
    try:
        from evoflow.observability.compaction_file_log import log_compaction_trace

        log_compaction_trace(
            "摘要落库失败",
            session_key=sk,
            thread_id=str(thread_id or ""),
            level=logging.WARNING,
            note="no conversation_summary in folded messages",
        )
    except Exception:
        pass
    return None


def _rehydrate_model_messages_after_compress(
    *,
    session_key: str | None,
    thread_id: str,
    fallback: list[BaseMessage],
) -> list[BaseMessage]:
    """After summary persist, rebuild model payload from DB (same path as next-round hydration)."""
    sk = str(session_key or "").strip()
    if not sk:
        sk = get_context_compaction_engine()._resolve_session_key(thread_id)
    if not sk:
        return fallback
    try:
        from evoflow.agents.middlewares.session_transcript_hydration_middleware import (
            load_model_messages_for_session,
        )

        rehydrated = load_model_messages_for_session(sk)
        if rehydrated:
            logger.info(
                "Context compaction rehydrated from DB session=%s folded_msgs=%d db_msgs=%d thread=%s",
                sk[:24],
                len(fallback),
                len(rehydrated),
                str(thread_id or "")[:16],
            )
            try:
                from evoflow.observability.compaction_file_log import log_compaction_trace

                log_compaction_trace(
                    "压缩后DB重组",
                    session_key=sk,
                    thread_id=str(thread_id or ""),
                    msgs_before_fold=len(fallback),
                    msgs_after_fold=len(rehydrated),
                    note="post_compress_rehydrate",
                )
            except Exception:
                pass
            return rehydrated
    except Exception:
        logger.warning(
            "rehydrate after compress failed session=%s thread=%s",
            sk[:24],
            str(thread_id or "")[:16],
            exc_info=True,
        )
    return fallback


def upgrade_conversation_summary(messages: list[BaseMessage], summary: str) -> list[BaseMessage] | None:
    # 防御性：拒绝把 stub 写回 conversation_summary，避免"用 stub 覆盖现有 stub/真摘要"。
    if _is_stub_summary(summary):
        return None
    text = summary if summary.strip().startswith(MAIN_SUMMARY_PREFIX[:20]) else _with_summary_prefix(summary)
    for i, msg in enumerate(messages):
        if isinstance(msg, HumanMessage) and str(getattr(msg, "name", None) or "").strip() == "conversation_summary":
            updated = msg.model_copy(update={"content": text})
            out = list(messages)
            out[i] = updated
            return out
    return None


class ContextCompactionEngine:
    """Per-thread compaction cooldown state; summaries live in ``evoflow_chat_messages`` only."""

    def __init__(self) -> None:
        self._cooldown_until: dict[str, float] = {}
        # Summary LLM failure cooldown only; compress snapshots live in compaction_trigger.
        self._state_lock = threading.RLock()

    def _tid(self, thread_id: str) -> str:
        return str(thread_id or "").strip() or "default"

    def _resolve_session_key(self, thread_id: str, session_key: str | None = None) -> str:
        sk = str(session_key or "").strip()
        if sk:
            return sk
        try:
            from evoflow.persistence.session_repositories import find_session_key_by_thread_id

            return find_session_key_by_thread_id(self._tid(thread_id)) or ""
        except Exception:
            return ""

    def get_previous_summary(self, thread_id: str, *, session_key: str | None = None) -> str | None:
        """Load latest compaction summary from ``evoflow_chat_messages`` (includes stub anchors)."""
        sk = self._resolve_session_key(thread_id, session_key)
        if not sk:
            return None
        try:
            from evoflow.persistence.chat_message_repositories import load_conversation_summary_text

            return load_conversation_summary_text(sk)
        except Exception:
            logger.debug("get_previous_summary load failed session=%s", sk[:24], exc_info=True)
            return None

    @staticmethod
    def get_real_previous_summary_for_llm(
        thread_id: str,
        *,
        session_key: str | None = None,
    ) -> str | None:
        """Previous summary for background/summary LLM — never feed stub placeholders."""
        engine = get_context_compaction_engine()
        prev = engine.get_previous_summary(thread_id, session_key=session_key)
        if prev and _is_stub_summary(prev):
            return None
        return prev

    def load_tool_history_blocks(self, thread_id: str, *, session_key: str | None = None) -> list[str]:
        return []

    def set_previous_summary(
        self,
        thread_id: str,
        summary: str,
        *,
        session_key: str | None = None,
        context_length: int = 128_000,
        force_write: bool = True,
    ) -> str:
        """Persist summary to ``evoflow_chat_messages`` (stub + real summaries)."""
        tid = self._tid(thread_id)
        capped = _cap_summary_text(summary, context_length=context_length)
        text = capped if capped.strip().startswith(MAIN_SUMMARY_PREFIX[:20]) else _with_summary_prefix(capped)
        sk = self._resolve_session_key(tid, session_key)
        if sk:
            try:
                from evoflow.persistence.chat_message_repositories import persist_conversation_summary

                persist_conversation_summary(
                    sk,
                    text,
                    thread_id=tid,
                    skip_if_unchanged=not force_write,
                    force_write=force_write,
                )
            except Exception:
                logger.warning(
                    "set_previous_summary persist failed session=%s thread=%s",
                    sk[:24],
                    tid[:16],
                    exc_info=True,
                )
        return text

    def absorb_extracted_summaries(
        self,
        thread_id: str,
        summary_bodies: Sequence[str],
        *,
        session_key: str | None = None,
    ) -> None:
        """No-op: compaction summaries are read/written only via ``evoflow_chat_messages``."""
        del thread_id, summary_bodies, session_key

    def _cooldown_seconds_remaining(self, thread_id: str, *, cooldown_seconds: float) -> float:
        return get_compaction_trigger_cache().cooldown_remaining(
            self._tid(thread_id),
            cooldown_seconds=cooldown_seconds,
        )

    def compaction_cooldown_active(
        self,
        thread_id: str,
        *,
        cooldown_seconds: float,
    ) -> bool:
        return get_compaction_trigger_cache().cooldown_active(
            self._tid(thread_id),
            cooldown_seconds=cooldown_seconds,
        )

    def mark_compress_completed(
        self,
        thread_id: str,
        *,
        before_gate_tokens: int,
        message_count: int | None = None,
        after_gate_tokens: int | None = None,
        run_id: str | None = None,
        session_key: str | None = None,
    ) -> None:
        get_compaction_trigger_cache().record_compress(
            self._tid(thread_id),
            run_id=run_id,
            session_key=session_key or self._resolve_session_key(thread_id),
            before_gate_tokens=before_gate_tokens,
            after_gate_tokens=after_gate_tokens if after_gate_tokens is not None else before_gate_tokens,
            message_count=message_count or 0,
        )

    def should_compress(
        self,
        messages: Sequence[BaseMessage],
        *,
        thread_id: str,
        context_length: int,
        threshold_ratio: float,
        aggressive_ratio: float,
        aggressive: bool = False,
        force: bool = False,
        compaction_cooldown_seconds: float = 0.0,
        compaction_hysteresis_enabled: bool = False,
        compaction_release_ratio: float = 0.42,
        compaction_min_middle_tokens: int = 1500,
        compaction_trigger_message_count: int = 0,
        run_id: str | None = None,
        session_key: str | None = None,
        log_phase: str = "should_compress",
    ) -> bool:
        """True when estimated tokens >= threshold and cooldown / hysteresis allow a compress LLM call."""
        del compaction_min_middle_tokens, compaction_release_ratio
        tokens = resolve_compaction_gate_tokens(messages, session_key=str(session_key or ""))
        decision = get_compaction_trigger_cache().evaluate(
            thread_id=self._tid(thread_id),
            tokens=tokens,
            message_count=len(messages),
            min_messages=_MIN_MESSAGES_TO_COMPRESS,
            context_length=context_length,
            threshold_ratio=threshold_ratio,
            aggressive_ratio=aggressive_ratio,
            force=force,
            aggressive=aggressive,
            compaction_cooldown_seconds=compaction_cooldown_seconds,
            compaction_hysteresis_enabled=compaction_hysteresis_enabled,
            compaction_trigger_message_count=compaction_trigger_message_count,
            run_id=run_id,
            session_key=session_key or self._resolve_session_key(thread_id) or None,
            log_phase=log_phase,
        )
        return decision.allow

    def try_fold_hydrated_transcript(
        self,
        messages: list[BaseMessage],
        *,
        thread_id: str,
        session_key: str | None = None,
        protect_tail_messages: int = 12,
    ) -> tuple[list[BaseMessage], bool] | None:
        """Structural fold for DB-hydrated transcripts (summary row already in *messages*)."""
        prev = self.get_previous_summary(thread_id, session_key=session_key)
        if not prev:
            for msg in reversed(messages):
                if is_conversation_summary_human(msg):
                    prev = message_content_str(msg)
                    break
        if not prev:
            return None
        return try_fold_hydrated_transcript(
            messages,
            summary=prev,
            protect_tail_messages=protect_tail_messages,
        )

    def try_refold_with_cached_summary(
        self,
        messages: list[BaseMessage],
        *,
        thread_id: str,
        context_length: int,
        threshold_ratio: float,
        aggressive_ratio: float,
        protect_first_n: int,
        protect_tail_messages: int,
        protect_tail_tool_rounds: int,
        aggressive: bool = False,
        force: bool = False,
    ) -> tuple[list[BaseMessage], bool] | None:
        """Structural fold using stored summary — no compress LLM (cooldown / cheap path)."""
        if force:
            return None
        if transcript_has_conversation_summary(messages):
            return None
        prev = self.get_previous_summary(thread_id)
        if not prev:
            return None
        plan = _resolve_compaction_plan(
            messages,
            context_length=context_length,
            threshold_ratio=threshold_ratio,
            aggressive_ratio=aggressive_ratio,
            protect_first_n=protect_first_n,
            protect_tail_messages=protect_tail_messages,
            protect_tail_tool_rounds=protect_tail_tool_rounds,
            aggressive=aggressive,
            force=False,
        )
        if plan is None or not plan.middle:
            return try_fold_hydrated_transcript(
                messages,
                summary=prev,
                protect_tail_messages=protect_tail_messages,
            )
        before = estimate_gate_tokens(messages)
        folded = apply_compaction_with_summary(plan, prev)
        after = estimate_gate_tokens(folded)
        threshold = compression_threshold_tokens(
            context_length,
            aggressive=aggressive,
            threshold_ratio=threshold_ratio,
            aggressive_ratio=aggressive_ratio,
        )
        saved_enough = after < before - max(256, int(before * 0.01))
        shrunk_msgs = len(folded) < len(messages)
        still_over = after >= threshold
        if not saved_enough and not (shrunk_msgs and still_over):
            hydrated = try_fold_hydrated_transcript(
                messages,
                summary=prev,
                protect_tail_messages=protect_tail_messages,
            )
            if hydrated is not None:
                return hydrated
            return None
        logger.info(
            "[context-compaction] cached-summary refold thread=%s %d→%d msgs gate %d→%d",
            self._tid(thread_id)[:16],
            len(messages),
            len(folded),
            before,
            after,
        )
        return folded, True

    def try_apply_pending_summary(
        self,
        messages: list[BaseMessage],
        *,
        thread_id: str,
        summary: str,
        context_length: int,
        threshold_ratio: float,
        aggressive_ratio: float,
        protect_first_n: int,
        protect_tail_messages: int,
        protect_tail_tool_rounds: int = 3,
        session_key: str | None = None,
    ) -> list[BaseMessage] | None:
        text = summary if summary.strip().startswith(MAIN_SUMMARY_PREFIX[:20]) else _with_summary_prefix(summary)
        text = _cap_summary_text(text, context_length=context_length)

        upgraded = upgrade_conversation_summary(messages, text)
        if upgraded is not None:
            self.set_previous_summary(thread_id, text, session_key=session_key, context_length=context_length)
            if self.should_compress(
                upgraded,
                thread_id=thread_id,
                context_length=context_length,
                threshold_ratio=threshold_ratio,
                aggressive_ratio=aggressive_ratio,
            ):
                refold_plan = _resolve_compaction_plan(
                    messages,
                    context_length=context_length,
                    threshold_ratio=threshold_ratio,
                    aggressive_ratio=aggressive_ratio,
                    protect_first_n=protect_first_n,
                    protect_tail_messages=protect_tail_messages,
                    protect_tail_tool_rounds=protect_tail_tool_rounds,
                    aggressive=True,
                    force=True,
                )
                if refold_plan is not None:
                    folded = apply_compaction_with_summary(refold_plan, text)
                    # 重新入队后台 LLM：refold 产生了新的 middle 段，需要让后台 LLM 把它合并
                    # 进真摘要。不入队会导致这段内容在下一轮被硬剪掉、信息丢失。
                    if refold_plan.middle:
                        try:
                            from evoflow.context.context_compaction_queue import (
                                CompactionJob,
                                get_context_compaction_queue,
                            )

                            tid = self._tid(thread_id)
                            language = detect_user_language(messages)
                            refold_job = CompactionJob(
                                thread_id=tid,
                                middle_payload=messages_to_dict(refold_plan.middle),
                                context_length=context_length,
                                previous_summary=text,
                                aggressive=True,
                                language=language,
                                session_key=self._resolve_session_key(thread_id),
                            )
                            get_context_compaction_queue().enqueue(refold_job)
                            logger.info(
                                "Context compaction refold enqueued background LLM thread=%s middle_tokens=%d",
                                thread_id,
                                refold_plan.middle_tokens,
                            )
                        except Exception as exc:  # pragma: no cover - defensive
                            logger.warning(
                                "Context compaction refold enqueue failed thread=%s: %s",
                                thread_id,
                                exc,
                            )
                    logger.info("Context compaction re-folded after pending summary upgrade thread=%s", thread_id)
                    return folded
            logger.info("Context compaction upgraded existing summary thread=%s", thread_id)
            return upgraded

        plan = plan_compaction(
            messages,
            context_length=context_length,
            threshold_ratio=threshold_ratio,
            aggressive_ratio=aggressive_ratio,
            protect_first_n=protect_first_n,
            protect_tail_messages=protect_tail_messages,
            protect_tail_tool_rounds=protect_tail_tool_rounds,
            aggressive=False,
        )
        if plan is None:
            # 故意不存 previous_summary：当 upgrade_conversation_summary 返回 None
            # 且当前 messages 也不够长无法 fold，意味着这份 pending summary 对应的是
            # 一份"已不存在"的对话状态（例如用户已重置/清空 thread）。把它存进缓存
            # 会污染新对话（下次 fold 把陌生历史当现有摘要喂给模型）。宁可丢弃
            # 这次后台 LLM 的工作，也不要把不属于当前对话的摘要塞进来。
            # 参见 test_try_apply_pending_summary_skips_store_when_plan_none。
            return None
        folded = apply_compaction_with_summary(plan, text)
        self.set_previous_summary(thread_id, text, session_key=session_key, context_length=context_length)
        # 同样需要把新 middle 入队后台 LLM 升级摘要（一致性：跟 upgrade-then-refold 分支对齐）。
        if plan.middle:
            try:
                from evoflow.context.context_compaction_queue import (
                    CompactionJob,
                    get_context_compaction_queue,
                )

                tid = self._tid(thread_id)
                language = detect_user_language(messages)
                new_job = CompactionJob(
                    thread_id=tid,
                    middle_payload=messages_to_dict(plan.middle),
                    context_length=context_length,
                    previous_summary=text,
                    aggressive=False,
                    language=language,
                    session_key=self._resolve_session_key(thread_id, session_key),
                )
                get_context_compaction_queue().enqueue(new_job)
                logger.info(
                    "Context compaction pending-then-fold enqueued background LLM thread=%s middle_tokens=%d",
                    thread_id,
                    plan.middle_tokens,
                )
            except Exception as exc:  # pragma: no cover - defensive
                logger.warning(
                    "Context compaction pending-then-fold enqueue failed thread=%s: %s",
                    thread_id,
                    exc,
                )
        return folded

    async def generate_summary_for_turns(
        self,
        turns: Sequence[BaseMessage],
        *,
        thread_id: str,
        context_length: int,
        previous_summary: str | None,
        aggressive: bool,
        language: Literal["zh", "en"] = "zh",
        session_key: str | None = None,
        model_name: str | None = None,
        latest_user_text: str = "",
    ) -> str | None:
        raw = await self._generate_summary(
            turns,
            thread_id=thread_id,
            context_length=context_length,
            previous_summary=previous_summary,
            aggressive=aggressive,
            language=language,
            model_name=model_name,
            latest_user_text=latest_user_text,
        )
        if not raw:
            return None
        text = _with_summary_prefix(raw)
        self.set_previous_summary(thread_id, text, session_key=session_key, context_length=context_length)
        return text

    def compress_messages_fast(
        self,
        messages: list[BaseMessage],
        *,
        thread_id: str,
        context_length: int,
        threshold_ratio: float = 0.50,
        aggressive_ratio: float = 0.85,
        protect_first_n: int = 3,
        protect_tail_messages: int = 20,
        protect_tail_tool_rounds: int = 3,
        aggressive: bool = False,
        force: bool = False,
        compaction_cooldown_seconds: float = 60.0,
        compaction_hysteresis_enabled: bool = True,
        compaction_release_ratio: float = 0.42,
        compaction_min_middle_tokens: int = 1500,
        compaction_trigger_message_count: int = 0,
        model_name: str | None = None,
    ) -> tuple[list[BaseMessage], bool, Any | None]:
        """Hot path: prune + fold middle with cached/stub summary; queue LLM refinement."""
        from evoflow.context.context_compaction_queue import CompactionJob

        if not force and not self.should_compress(
            messages,
            thread_id=thread_id,
            context_length=context_length,
            threshold_ratio=threshold_ratio,
            aggressive_ratio=aggressive_ratio,
            aggressive=aggressive,
            compaction_cooldown_seconds=compaction_cooldown_seconds,
            compaction_hysteresis_enabled=compaction_hysteresis_enabled,
            compaction_release_ratio=compaction_release_ratio,
            compaction_trigger_message_count=compaction_trigger_message_count,
        ):
            return messages, False, None

        plan = _resolve_compaction_plan(
            messages,
            context_length=context_length,
            threshold_ratio=threshold_ratio,
            aggressive_ratio=aggressive_ratio,
            protect_first_n=protect_first_n,
            protect_tail_messages=protect_tail_messages,
            protect_tail_tool_rounds=protect_tail_tool_rounds,
            aggressive=aggressive,
            force=force,
        )
        if plan is None:
            return messages, False, None

        # min_middle_tokens 闸门：middle 段太小时不入队后台 LLM
        # （同步路径有同样检查；不加这个会浪费 LLM 调用且摘要质量差）
        if not force and plan.middle_tokens < compaction_min_middle_tokens:
            logger.info(
                "[context-compaction] fast skip thread=%s middle_tokens=%d < min=%d",
                thread_id[:16],
                plan.middle_tokens,
                compaction_min_middle_tokens,
            )
            return messages, False, None

        tid = self._tid(thread_id)
        language = detect_user_language(messages)
        prev = self.get_previous_summary(thread_id, session_key=self._resolve_session_key(thread_id))
        prev_for_llm = self.get_real_previous_summary_for_llm(
            thread_id,
            session_key=self._resolve_session_key(thread_id),
        )
        if prev:
            prev = _cap_summary_text(prev, context_length=context_length)
        using_stub = prev is None or _is_stub_summary(prev)
        summary = prev if prev and not using_stub else _stub_summary(middle_count=len(plan.middle), language=language)

        # 记录压缩前的 gate tokens（用于后续冷却基线对比）
        before_gate_tokens = estimate_gate_tokens(messages)

        compressed = apply_compaction_with_summary(plan, summary)

        persist_compaction_summary_from_messages(
            compressed,
            thread_id=thread_id,
            session_key=self._resolve_session_key(thread_id),
            force_write=True,
        )
        compressed = _rehydrate_model_messages_after_compress(
            session_key=self._resolve_session_key(thread_id),
            thread_id=thread_id,
            fallback=compressed,
        )

        # CompactionJob 喂给后台 LLM 的 previous_summary 必须是真摘要或 None。
        enqueue_background = using_stub
        if enqueue_background and compaction_cooldown_seconds > 0 and self.compaction_cooldown_active(
            thread_id,
            cooldown_seconds=compaction_cooldown_seconds,
        ):
            try:
                from evoflow.context.context_compaction_queue import get_context_compaction_queue

                if get_context_compaction_queue().has_pending_job(tid):
                    enqueue_background = False
            except Exception:
                pass
        if not using_stub and compaction_cooldown_seconds > 0 and self.compaction_cooldown_active(
            thread_id,
            cooldown_seconds=compaction_cooldown_seconds,
        ):
            enqueue_background = False

        job = (
            CompactionJob(
                thread_id=tid,
                middle_payload=messages_to_dict(plan.middle),
                context_length=context_length,
                previous_summary=prev_for_llm,
                aggressive=aggressive,
                language=language,
                session_key=self._resolve_session_key(thread_id),
                model_name=model_name,
            )
            if enqueue_background
            else None
        )

        # 标记压缩完成，触发冷却窗口；否则后台模式下每轮都会重做一遍压缩。
        self.mark_compress_completed(
            thread_id,
            before_gate_tokens=before_gate_tokens,
            message_count=plan.original_count,
            after_gate_tokens=estimate_gate_tokens(compressed),
            session_key=self._resolve_session_key(thread_id),
        )

        logger.info(
            "Context compaction fast thread=%s %d→%d msgs (dropped %d, aggressive=%s, middle_tokens≈%d, stub=%s)",
            thread_id,
            plan.original_count,
            len(compressed),
            len(plan.middle),
            aggressive,
            plan.middle_tokens,
            using_stub,
        )
        return compressed, True, job

    async def compress_messages(
        self,
        messages: list[BaseMessage],
        *,
        thread_id: str,
        context_length: int,
        threshold_ratio: float = 0.50,
        aggressive_ratio: float = 0.85,
        protect_first_n: int = 3,
        protect_tail_messages: int = 20,
        protect_tail_tool_rounds: int = 3,
        aggressive: bool = False,
        force: bool = False,
        compaction_cooldown_seconds: float = 60.0,
        compaction_hysteresis_enabled: bool = True,
        compaction_release_ratio: float = 0.42,
        compaction_min_middle_tokens: int = 1500,
        compaction_trigger_message_count: int = 0,
        model_name: str | None = None,
        session_key: str | None = None,
        record_turn_mark: bool = True,
        skip_trigger_check: bool = False,
    ) -> tuple[list[BaseMessage], bool]:
        """Synchronous compaction (LLM on hot path). Used when background LLM is disabled.

        Trigger policy is evaluated once in ``build_ephemeral_model_messages`` via
        ``compaction_gate_status``. Pipeline callers pass ``skip_trigger_check=True``.
        """
        before_gate_tokens = estimate_gate_tokens(messages)
        if not skip_trigger_check:
            gate = compaction_gate_status(
                messages,
                context_length=context_length,
                threshold_ratio=threshold_ratio,
                aggressive_ratio=aggressive_ratio,
                protect_first_n=protect_first_n,
                protect_tail_messages=protect_tail_messages,
                protect_tail_tool_rounds=protect_tail_tool_rounds,
                thread_id=thread_id,
                force=force,
                compaction_cooldown_seconds=compaction_cooldown_seconds,
                compaction_hysteresis_enabled=compaction_hysteresis_enabled,
                compaction_trigger_message_count=compaction_trigger_message_count,
                session_key=session_key or "",
            )
            if not force and not gate["should_trigger"]:
                if gate.get("should_refold_cached"):
                    refold = self.try_refold_with_cached_summary(
                        messages,
                        thread_id=thread_id,
                        context_length=context_length,
                        threshold_ratio=threshold_ratio,
                        aggressive_ratio=aggressive_ratio,
                        protect_first_n=protect_first_n,
                        protect_tail_messages=protect_tail_messages,
                        protect_tail_tool_rounds=protect_tail_tool_rounds,
                    )
                    if refold is not None:
                        return refold
                if gate.get("token_over_threshold") and gate.get("block_reason"):
                    logger.info(
                        "[context-compaction] compress_messages retry with relaxed protect thread=%s tokens=%d reason=%s",
                        thread_id[:16],
                        gate["tokens"],
                        gate["block_reason"],
                    )
                    force = True
                else:
                    logger.info(
                        "[context-compaction] compress_messages skipped thread=%s tokens=%d threshold=%d reason=%s",
                        thread_id[:16],
                        gate["tokens"],
                        gate["threshold"],
                        gate["block_reason"] or "unknown",
                    )
                    return messages, False

        plan = _resolve_compaction_plan(
            messages,
            context_length=context_length,
            threshold_ratio=threshold_ratio,
            aggressive_ratio=aggressive_ratio,
            protect_first_n=protect_first_n,
            protect_tail_messages=protect_tail_messages,
            protect_tail_tool_rounds=protect_tail_tool_rounds,
            aggressive=aggressive,
            force=force,
        )
        if plan is None:
            skip = explain_plan_compaction_skip(
                messages,
                context_length=context_length,
                threshold_ratio=threshold_ratio,
                aggressive_ratio=aggressive_ratio,
                protect_first_n=protect_first_n,
                protect_tail_messages=protect_tail_messages,
                protect_tail_tool_rounds=protect_tail_tool_rounds,
                aggressive=aggressive,
            )
            plan_tokens = estimate_gate_tokens(messages)
            plan_threshold = compression_threshold_tokens(
                context_length,
                aggressive=aggressive,
                threshold_ratio=threshold_ratio,
                aggressive_ratio=aggressive_ratio,
            )
            logger.warning(
                "[context-compaction] compress_messages plan=None thread=%s tokens=%d threshold=%d %s",
                thread_id[:16],
                plan_tokens,
                plan_threshold,
                skip or "unknown",
            )
            return messages, False

        if (
            not force
            and plan is not None
            and plan.middle_tokens < compaction_min_middle_tokens
        ):
            refold = self.try_refold_with_cached_summary(
                messages,
                thread_id=thread_id,
                context_length=context_length,
                threshold_ratio=threshold_ratio,
                aggressive_ratio=aggressive_ratio,
                protect_first_n=protect_first_n,
                protect_tail_messages=protect_tail_messages,
                protect_tail_tool_rounds=protect_tail_tool_rounds,
            )
            if refold is not None:
                return refold
            logger.info(
                "[context-compaction] skip LLM thread=%s middle_tokens=%d < min=%d",
                thread_id[:16],
                plan.middle_tokens,
                compaction_min_middle_tokens,
            )
            return messages, False

        language = detect_user_language(messages)
        prev = self.get_previous_summary(thread_id)
        summary = await self._generate_summary(
            plan.middle,
            thread_id=thread_id,
            context_length=context_length,
            previous_summary=prev,
            aggressive=aggressive,
            language=language,
            model_name=model_name,
            latest_user_text=_extract_latest_user_text(messages),
        )
        if not summary:
            summary = f"{MAIN_SUMMARY_PREFIX}\nSummary generation was unavailable. {len(plan.middle)} turns were removed. Continue from recent messages and current workspace state."
        else:
            summary = _with_summary_prefix(summary)

        compressed = apply_compaction_with_summary(plan, summary)
        persist_compaction_summary_from_messages(
            compressed,
            thread_id=thread_id,
            session_key=session_key or self._resolve_session_key(thread_id),
            force_write=True,
        )
        compressed = _rehydrate_model_messages_after_compress(
            session_key=session_key or self._resolve_session_key(thread_id),
            thread_id=thread_id,
            fallback=compressed,
        )
        try:
            from evoflow.observability.compaction_file_log import log_compaction_trace

            log_compaction_trace(
                "同步压缩完成",
                thread_id=thread_id,
                session_key=session_key or self._resolve_session_key(thread_id),
                message_count=len(compressed),
                compress_streaming=False,
                note="LLM ainvoke non-streaming; summary persisted before main model",
            )
        except Exception:
            pass
        if record_turn_mark:
            self.mark_compress_completed(
                thread_id,
                before_gate_tokens=before_gate_tokens,
                message_count=plan.original_count,
                after_gate_tokens=compaction_token_snapshot(compressed, context_length=context_length)[
                    "gate_tokens"
                ],
                session_key=session_key or self._resolve_session_key(thread_id),
            )
        logger.info(
            "Context compaction sync thread=%s %d→%d msgs (dropped %d, aggressive=%s)",
            thread_id,
            plan.original_count,
            len(compressed),
            len(plan.middle),
            aggressive,
        )
        return compressed, True

    async def _generate_summary(
        self,
        turns: Sequence[BaseMessage],
        *,
        thread_id: str,
        context_length: int,
        previous_summary: str | None,
        aggressive: bool,
        language: Literal["zh", "en"] = "zh",
        model_name: str | None = None,
        latest_user_text: str = "",
    ) -> str | None:
        tid = self._tid(thread_id)
        now = time.monotonic()
        # 失败冷却的读写都在锁内进行，避免多线程同时通过冷却检查或丢失冷却标记。
        with self._state_lock:
            if now < self._cooldown_until.get(tid, 0):
                return None

        budget = _compute_summary_budget(turns, context_length=context_length)
        modified_files = ""
        try:
            from evoflow.context.working_memory import format_write_registry_for_analyzer

            modified_files = format_write_registry_for_analyzer(thread_id)
        except Exception:
            modified_files = ""
        prompt = _build_main_summary_prompt(
            turns,
            previous_summary=previous_summary,
            summary_budget=budget,
            aggressive=aggressive,
            language=language,
            modified_files=modified_files,
            latest_user_text=latest_user_text,
        )

        try:
            cfg = get_summarization_config()
            resolved = cfg.model_name or model_name
            model = create_chat_model(
                name=resolved,
                thinking_enabled=False,
                invocation_kind="compress",
            )
            from evoflow.context.internal_model_invoke import ainvoke_internal_chat_model

            response = await ainvoke_internal_chat_model(model, [{"role": "user", "content": prompt}])
            content = getattr(response, "content", "") or ""
            if not isinstance(content, str):
                content = str(content)
            text = content.strip()
            if not text:
                return None
            with self._state_lock:
                self._cooldown_until.pop(tid, None)
            return text
        except Exception as exc:
            with self._state_lock:
                self._cooldown_until[tid] = now + _SUMMARY_FAILURE_COOLDOWN_SECONDS
            logger.warning(
                "Context compaction summary failed (thread=%s): %s",
                tid,
                exc,
            )
            return None


_context_compaction_engine: ContextCompactionEngine | None = None
_engine_factory_lock = threading.Lock()


def get_context_compaction_engine() -> ContextCompactionEngine:
    global _context_compaction_engine
    # Double-checked locking: 大部分情况快速路径无锁，只有未初始化时进入锁内。
    if _context_compaction_engine is None:
        with _engine_factory_lock:
            if _context_compaction_engine is None:
                _context_compaction_engine = ContextCompactionEngine()
    return _context_compaction_engine
