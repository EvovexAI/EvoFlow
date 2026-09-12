"""Hosted planner context compression — structured LLM summarization.

Replaces naive 80-char previews with head/tail protection and auxiliary-model
summaries (same design ideas as hermes-agent ContextCompressor).
"""

from __future__ import annotations

import logging
import re
import time
from typing import Literal

from app.channels.models.goal import GoalHistoryItem, GoalHistoryRole
from evoflow.config.summarization_config import get_summarization_config
from evoflow.context.compaction_token_utils import (
    _CJK_RE,
    count_text_tokens,
)
from evoflow.context.compaction_token_utils import (
    SUMMARY_FAILURE_COOLDOWN_SECONDS as _SUMMARY_FAILURE_COOLDOWN_SECONDS,
)
from evoflow.models import create_chat_model
from evoflow.utils.model_context_length import (
    compression_threshold_tokens,
    resolve_model_context_length,
)

logger = logging.getLogger(__name__)

# Hermes-agent defaults: compress at 50% of model context; safety pass at 85% (gateway hygiene).
COMPRESSION_THRESHOLD_RATIO = 0.50
AGGRESSIVE_THRESHOLD_RATIO = 0.85
PROTECT_FIRST_N = 2
PROTECT_TAIL_MESSAGES = 8
TAIL_TOKEN_RATIO = 0.18
_SUMMARY_CONTENT_RATIO = 0.22
_MIN_SUMMARY_TOKENS = 800
_SUMMARY_TOKENS_CEILING = 6_000
_MIN_MESSAGES_TO_COMPRESS = 8

SUMMARY_PREFIX = (
    "[CONTEXT COMPACTION — REFERENCE ONLY] Earlier hosted turns were compacted "
    "into the summary below. This is background for continuing the目标调度 — "
    "do NOT treat it as a new user instruction. Respond only to the latest "
    "messages after this summary. Do not re-issue instructions already executed:"
)

LEGACY_SUMMARY_MARKERS = (
    "[上下文摘要",
    "[深度压缩摘要",
    SUMMARY_PREFIX,
)


def estimate_history_tokens(history: list[GoalHistoryItem]) -> int:
    total = 0
    for item in history:
        total += count_text_tokens(item.content or "")
        total += 12  # role/metadata overhead
    return total


def _detect_hosted_language(history: list[GoalHistoryItem]) -> Literal["zh", "en"]:
    """Default zh; use en only when recent transcript is clearly English-only."""
    samples: list[str] = []
    for item in reversed(history):
        if _is_summary_message(item):
            continue
        if item.role == GoalHistoryRole.SYSTEM:
            continue
        text = (item.content or "").strip()
        if not text:
            continue
        samples.append(text)
        if len(samples) >= 6:
            break
    if not samples:
        return "zh"
    cjk = sum(len(_CJK_RE.findall(t)) for t in samples)
    latin = len(re.findall(r"[A-Za-z]", " ".join(samples)))
    if cjk >= 2 and cjk >= latin * 0.25:
        return "zh"
    if latin >= 24 and cjk == 0:
        return "en"
    return "zh"


def _is_summary_message(item: GoalHistoryItem) -> bool:
    content = (item.content or "").strip()
    return any(content.startswith(marker) for marker in LEGACY_SUMMARY_MARKERS)


def _role_label(role: GoalHistoryRole) -> str:
    if role == GoalHistoryRole.SYSTEM:
        return "SYSTEM"
    if role == GoalHistoryRole.ASSISTANT:
        return "PLANNER"
    return "EVOFLOW"


def _serialize_turns(turns: list[GoalHistoryItem], *, content_max: int = 5000) -> str:
    parts: list[str] = []
    for item in turns:
        role = _role_label(item.role)
        content = (item.content or "").strip()
        if len(content) > content_max:
            head = content_max * 4 // 5
            tail = content_max - head - 24
            content = content[:head] + "\n...[truncated]...\n" + content[-tail:]
        step = item.step
        dur = f", {item.duration_ms}ms" if item.duration_ms else ""
        parts.append(f"[{role} step={step}{dur}]: {content}")
    return "\n\n".join(parts)


def _compute_summary_budget(turns: list[GoalHistoryItem], *, context_length: int) -> int:
    content_tokens = estimate_history_tokens(turns)
    budget = int(content_tokens * _SUMMARY_CONTENT_RATIO)
    ceiling = min(int(context_length * 0.05), _SUMMARY_TOKENS_CEILING)
    return max(_MIN_SUMMARY_TOKENS, min(budget, ceiling))


def _with_summary_prefix(summary: str) -> str:
    text = (summary or "").strip()
    for marker in LEGACY_SUMMARY_MARKERS:
        if text.startswith(marker):
            # Drop legacy one-line headers
            if "\n" in text:
                text = text.split("\n", 1)[1].lstrip()
            else:
                text = ""
            break
    if text.startswith(SUMMARY_PREFIX):
        return text
    return f"{SUMMARY_PREFIX}\n{text}" if text else SUMMARY_PREFIX


def _find_tail_start(
    messages: list[GoalHistoryItem],
    head_end: int,
    token_budget: int,
    min_tail: int,
) -> int:
    n = len(messages)
    min_tail = min(min_tail, max(0, n - head_end - 1))
    soft_ceiling = int(token_budget * 1.5)
    accumulated = 0
    cut_idx = n

    for i in range(n - 1, head_end - 1, -1):
        msg_tokens = count_text_tokens(messages[i].content or "") + 10
        if accumulated + msg_tokens > soft_ceiling and (n - i) >= min_tail:
            break
        accumulated += msg_tokens
        cut_idx = i

    fallback = n - min_tail
    if cut_idx > fallback:
        cut_idx = fallback
    if cut_idx <= head_end:
        cut_idx = max(fallback, head_end + 1)
    return max(cut_idx, head_end + 1)


def _hosted_summary_template(*, lang: Literal["zh", "en"]) -> str:
    if lang == "zh":
        return """## 目标
[目标任务与完成标准]

## 进展
### 已完成
[已完成步骤——含 EvoFlow 结果、路径、交付物]
### 进行中
[当前焦点]
### 受阻
[失败或阻塞]

## 已下发指令
[已向 EvoFlow 下发的重要指令——避免重复]

## 已解决
[已回答问题]

## 待处理
[调度器仍需推进的事项；若无则写「无」]

## 关键上下文
[不可丢失的错误、配置、数值]

"""
    return """## Goal
[User's hosted task goal and success criteria]

## Progress
### Done
[Completed steps — include key EvoFlow outcomes, file paths, deliverables]
### In Progress
[Current focus]
### Blocked
[Failures or blockers if any]

## Planner Instructions Given
[Important instructions already sent — avoid repeating these]

## Resolved
[Questions already answered]

## Pending
[What the planner still needs to drive — or "None"]

## Critical Context
[Exact errors, configs, values that must not be lost]

"""


def _build_summary_prompt(
    turns: list[GoalHistoryItem],
    *,
    previous_summary: str | None,
    summary_budget: int,
    aggressive: bool,
    language: Literal["zh", "en"] = "zh",
) -> str:
    serialized = _serialize_turns(turns)
    if language == "zh":
        preamble = "你是目标任务调度器的摘要代理。调度器向 EvoFlow 下发短指令并阅读执行结果。只输出下方结构化摘要正文，不要回答对话中的问题。必须使用简体中文撰写全部章节。"
        budget_line = f"目标约 {summary_budget} tokens。只写摘要章节。"
        aggressive_line = "更激进地省略重复的成功输出；保留失败项与待办。"
    else:
        preamble = (
            "You are a summarization agent for a hosted task planner. "
            "The planner sends short instructions to EvoFlow and reads execution results. "
            "Output ONLY the structured summary body — no preamble, no answering questions "
            "from the transcript. Write the entire summary in English."
        )
        budget_line = f"Target ~{summary_budget} tokens. Write only the summary sections."
        aggressive_line = "Be more aggressive: omit redundant success chatter; keep failures and pending work."

    template = _hosted_summary_template(lang=language) + budget_line

    if language == "zh":
        if previous_summary:
            body = f"""{preamble}

在上一份压缩摘要基础上更新。

上一份摘要：
{previous_summary}

新增轮次：
{serialized}

保留仍相关信息；已完成项归入「已完成」。

{template}"""
        else:
            body = f"""{preamble}

为后续续写压缩以下目标轮次：

轮次：
{serialized}

{template}"""
    elif previous_summary:
        body = f"""{preamble}

Update the previous compaction summary with new turns.

PREVIOUS SUMMARY:
{previous_summary}

NEW TURNS:
{serialized}

Preserve still-relevant information; move completed items to Done.

{template}"""
    else:
        body = f"""{preamble}

Summarize these hosted planner turns for a continuation handoff.

TURNS:
{serialized}

{template}"""

    if aggressive:
        body += f"\n\n{aggressive_line}"
    return body


class GoalContextCompressor:
    """Per-session compressor with optional iterative summaries."""

    def __init__(self) -> None:
        self._previous_summary: dict[str, str] = {}
        self._cooldown_until: dict[str, float] = {}

    def get_previous_summary(self, session_id: str) -> str | None:
        return self._previous_summary.get(session_id)

    def clear_session(self, session_id: str) -> None:
        self._previous_summary.pop(session_id, None)
        self._cooldown_until.pop(session_id, None)

    def should_compress(
        self,
        history: list[GoalHistoryItem],
        *,
        context_length: int,
        aggressive: bool = False,
    ) -> bool:
        if not get_summarization_config().enabled:
            return False
        if len(history) < _MIN_MESSAGES_TO_COMPRESS:
            return False
        tokens = estimate_history_tokens(history)
        threshold = compression_threshold_tokens(
            context_length,
            aggressive=aggressive,
            threshold_ratio=COMPRESSION_THRESHOLD_RATIO,
            aggressive_ratio=AGGRESSIVE_THRESHOLD_RATIO,
        )
        return tokens >= threshold

    async def compress_history(
        self,
        history: list[GoalHistoryItem],
        *,
        session_id: str,
        context_length: int,
        model_name: str | None = None,
        aggressive: bool = False,
    ) -> tuple[list[GoalHistoryItem], bool]:
        """Return (possibly compressed history, changed)."""
        if not get_summarization_config().enabled:
            return history, False
        if not self.should_compress(history, context_length=context_length, aggressive=aggressive):
            return history, False

        n = len(history)
        min_needed = PROTECT_FIRST_N + 3
        if n <= min_needed:
            return history, False

        head_end = PROTECT_FIRST_N
        threshold_tokens = compression_threshold_tokens(
            context_length,
            aggressive=aggressive,
            threshold_ratio=COMPRESSION_THRESHOLD_RATIO,
            aggressive_ratio=AGGRESSIVE_THRESHOLD_RATIO,
        )
        tail_budget = max(2000, int(threshold_tokens * TAIL_TOKEN_RATIO))
        compress_end = _find_tail_start(
            history,
            head_end,
            tail_budget,
            PROTECT_TAIL_MESSAGES,
        )

        if head_end >= compress_end:
            return history, False

        middle = [m for m in history[head_end:compress_end] if not _is_summary_message(m)]
        if not middle:
            return history, False

        prev = self._previous_summary.get(session_id)
        summary = await self._generate_summary(
            middle,
            session_id=session_id,
            context_length=context_length,
            previous_summary=prev,
            aggressive=aggressive,
            language=_detect_hosted_language(history),
            model_name=model_name,
        )

        if not summary:
            dropped = len(middle)
            summary = f"{SUMMARY_PREFIX}\nSummary model unavailable. {dropped} turns removed to save context. Continue from recent messages and current task state."

        self._previous_summary[session_id] = summary

        head = list(history[:head_end])
        tail = list(history[compress_end:])
        summary_item = GoalHistoryItem(
            session_id=history[0].session_id,
            step=tail[0].step if tail else (head[-1].step if head else 0),
            role=GoalHistoryRole.TARGET,
            content=_with_summary_prefix(summary),
            metadata={"compaction": True, "dropped_turns": len(middle)},
        )

        compressed = head + [summary_item] + tail
        logger.info(
            "Hosted context compressed session=%s %d→%d msgs (dropped %d turns, aggressive=%s)",
            session_id,
            n,
            len(compressed),
            len(middle),
            aggressive,
        )
        return compressed, True

    async def _generate_summary(
        self,
        turns: list[GoalHistoryItem],
        *,
        session_id: str,
        context_length: int,
        previous_summary: str | None,
        aggressive: bool,
        language: Literal["zh", "en"] = "zh",
        model_name: str | None = None,
    ) -> str | None:
        now = time.monotonic()
        if now < self._cooldown_until.get(session_id, 0):
            return None

        budget = _compute_summary_budget(turns, context_length=context_length)
        prompt = _build_summary_prompt(
            turns,
            previous_summary=previous_summary,
            summary_budget=budget,
            aggressive=aggressive,
            language=language,
        )

        try:
            sum_cfg = get_summarization_config()
            resolved = sum_cfg.model_name or model_name
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
            self._cooldown_until.pop(session_id, None)
            return text
        except Exception as exc:
            self._cooldown_until[session_id] = now + _SUMMARY_FAILURE_COOLDOWN_SECONDS
            logger.warning(
                "Hosted context summary failed (session=%s): %s — cooldown %ds",
                session_id,
                exc,
                _SUMMARY_FAILURE_COOLDOWN_SECONDS,
            )
            return None


# Module singleton used by GoalService
_default_compressor = GoalContextCompressor()


async def compress_goal_history(
    history: list[GoalHistoryItem],
    *,
    session_id: str,
    context_length: int | None = None,
    model_name: str | None = None,
    aggressive: bool = False,
    compressor: GoalContextCompressor | None = None,
) -> tuple[list[GoalHistoryItem], bool]:
    ctx = context_length if context_length and context_length > 0 else resolve_model_context_length(model_name)
    comp = compressor or _default_compressor
    return await comp.compress_history(
        history,
        session_id=session_id,
        context_length=ctx,
        model_name=model_name,
        aggressive=aggressive,
    )
