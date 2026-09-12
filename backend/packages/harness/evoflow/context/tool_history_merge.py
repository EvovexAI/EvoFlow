"""Batch-merge cold-zone tool rounds into a single frozen [tool:history] block."""

from __future__ import annotations

import logging
import re
import threading
import time
from dataclasses import dataclass, field

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, ToolMessage

from evoflow.agents.context_compaction_core import is_tool_history_human, message_content_str
from evoflow.config.tool_results_config import (
    get_tool_results_config,
    prune_preserve_tool_names,
    tool_is_llm_summary_candidate,
)
from evoflow.context.tool_result_summarizer import (
    TOOL_HISTORY_PREFIX,
    is_already_shaped,
    is_frozen_tool_history,
    summarize_tool_result_for_history,
)
from evoflow.context.tool_tokens import count_tool_tokens

logger = logging.getLogger(__name__)

_TOOL_HISTORY_NAME = "tool_history"

# Per-thread "last merge timestamp" with bounded memory.
# Without cleanup this dict grows linearly with thread_id over the process
# lifetime → OOM in long-running services. Same pattern as compaction_pending_cache:
# TTL + capacity cap, both enforced lazily on write.
_last_merge_at: dict[str, float] = {}
_last_merge_lock = threading.Lock()
_LAST_MERGE_TTL_SECONDS = 3600.0  # 1 hour — well past typical merge cooldowns
_LAST_MERGE_MAX_ENTRIES = 512


def _evict_last_merge_locked(now: float) -> None:
    """Drop expired and overflow entries; caller must hold ``_last_merge_lock``."""
    if not _last_merge_at:
        return
    # TTL eviction
    expired = [tid for tid, ts in _last_merge_at.items() if (now - ts) > _LAST_MERGE_TTL_SECONDS]
    for tid in expired:
        _last_merge_at.pop(tid, None)
    # Capacity cap (oldest-first)
    overflow = len(_last_merge_at) - _LAST_MERGE_MAX_ENTRIES
    if overflow > 0:
        ordered = sorted(_last_merge_at.items(), key=lambda kv: kv[1])
        for tid, _ in ordered[:overflow]:
            _last_merge_at.pop(tid, None)


@dataclass
class ToolRoundEntry:
    tool_name: str
    tool_call_id: str
    content: str
    args_hint: str = ""
    token_estimate: int = 0
    ai_index: int | None = None
    tool_index: int = 0
    raw_content: str = ""


@dataclass
class _ColdScan:
    candidates: list[ToolRoundEntry] = field(default_factory=list)
    merge_ready: bool = False


def merge_cooldown_elapsed(thread_id: str, cooldown_seconds: float) -> bool:
    tid = str(thread_id or "").strip() or "default"
    with _last_merge_lock:
        last = _last_merge_at.get(tid, 0.0)
    return (time.monotonic() - last) >= cooldown_seconds


def mark_merge_cooldown(thread_id: str) -> None:
    tid = str(thread_id or "").strip() or "default"
    now = time.monotonic()
    with _last_merge_lock:
        # Lazy cleanup on write: bound memory in long-running services where
        # many ephemeral thread_ids accumulate.
        _evict_last_merge_locked(now)
        _last_merge_at[tid] = now


def _args_hint_from_ai(ai: AIMessage | None, tool_call_id: str) -> str:
    if ai is None:
        return ""
    for tc in ai.tool_calls or []:
        cid = str(tc.get("id", "") if isinstance(tc, dict) else getattr(tc, "id", "") or "")
        if cid != tool_call_id:
            continue
        if isinstance(tc, dict):
            args = tc.get("args") or tc.get("function", {}).get("arguments", "")
        else:
            args = getattr(tc, "args", "")
        s = str(args).strip()
        return s[:200] + ("…" if len(s) > 200 else "")
    return ""


def _eligible_cold_tool(msg: ToolMessage, preserve: frozenset[str]) -> bool:
    name = str(getattr(msg, "name", None) or "").strip().lower()
    if name in preserve or getattr(msg, "name", None) == "ask_clarification":
        return False
    content = message_content_str(msg)
    if is_frozen_tool_history(content):
        return False
    if count_tool_tokens(content) < 80 and not is_already_shaped(content):
        return False
    return True


def _scan_cold_prefix(prefix: list[BaseMessage], preserve: frozenset[str]) -> _ColdScan:
    cfg = get_tool_results_config()
    scan = _ColdScan()

    for i, msg in enumerate(prefix):
        if isinstance(msg, HumanMessage) and is_frozen_tool_history(message_content_str(msg)):
            continue
        if not isinstance(msg, ToolMessage) or not _eligible_cold_tool(msg, preserve):
            continue

        raw = message_content_str(msg)
        cid = str(getattr(msg, "tool_call_id", None) or "")
        tool_name = str(getattr(msg, "name", None) or "tool").strip().lower()
        ai: AIMessage | None = None
        ai_idx: int | None = None
        if i > 0 and isinstance(prefix[i - 1], AIMessage):
            ai = prefix[i - 1]
            ai_idx = i - 1

        if is_already_shaped(raw) and not is_frozen_tool_history(raw):
            body = raw
        elif tool_is_llm_summary_candidate(tool_name):
            body = summarize_tool_result_for_history(raw, tool_name, prefer_llm=False)
        else:
            body = raw

        scan.candidates.append(
            ToolRoundEntry(
                tool_name=tool_name,
                tool_call_id=cid,
                content=body,
                args_hint=_args_hint_from_ai(ai, cid),
                token_estimate=count_tool_tokens(raw),
                ai_index=ai_idx,
                tool_index=i,
                raw_content=raw,
            )
        )

    if not scan.candidates or not cfg.history_merge_enabled:
        return scan

    total_tokens = sum(e.token_estimate for e in scan.candidates)
    n_cold = len(scan.candidates)
    # Per-tool [tool:summary] is small; still merge N cold rounds into one [tool:history] block.
    shaped_cold = sum(1 for e in scan.candidates if is_already_shaped(e.raw_content))
    meets_token_floor = total_tokens >= cfg.history_merge_min_tokens
    meets_structural_batch = n_cold >= cfg.history_merge_min_tools and (meets_token_floor or shaped_cold >= cfg.history_merge_min_tools)
    scan.merge_ready = meets_structural_batch
    return scan


def format_tool_history_batch(entries: list[ToolRoundEntry]) -> str:
    tools_line = "; ".join(f"{e.tool_name}({e.args_hint[:80]})" if e.args_hint else e.tool_name for e in entries[:12])
    cores: list[str] = []
    refs: list[str] = []
    for e in entries:
        m = re.search(r"(?m)^core:\s*(.+)$", e.content)
        if m:
            cores.append(m.group(1).strip()[:300])
        for ref_m in re.finditer(r"(?m)(?:ref:|Full output:)\s*(\S+)", e.content):
            refs.append(ref_m.group(1).strip())
    core_body = " | ".join(cores) if cores else "（见 tools 行）"
    lines = [
        f"{TOOL_HISTORY_PREFIX} merged_tools={len(entries)}",
        f"tools: {tools_line}",
        f"core: {core_body[:1200]}",
    ]
    if refs:
        lines.append(f"refs: {', '.join(dict.fromkeys(refs))[:800]}")
    lines.append("（历史工具批次摘要；全文用 read_file 读 refs 路径）")
    return "\n".join(lines)


def _merge_prior_tool_history_blocks(new_body: str, prior_blocks: list[str]) -> str:
    if not prior_blocks:
        return new_body
    prior = "\n\n".join(prior_blocks)
    return f"{new_body}\n\n--- prior tool history ---\n{prior[:8000]}"


def rebuild_cold_prefix(
    prefix: list[BaseMessage],
    *,
    thread_id: str,
    scan: _ColdScan,
    prior_tool_history_blocks: list[str] | None = None,
) -> tuple[list[BaseMessage], bool]:
    if not scan.candidates:
        return list(prefix), False

    # Batch-merge all cold tool rounds; cooldown only limits how often we re-merge the same block.
    if scan.merge_ready:
        drop_indices: set[int] = set()
        for e in scan.candidates:
            drop_indices.add(e.tool_index)
            if e.ai_index is not None:
                drop_indices.add(e.ai_index)

        batch_body = format_tool_history_batch(scan.candidates)
        batch_body = _merge_prior_tool_history_blocks(batch_body, prior_tool_history_blocks or [])
        mark_merge_cooldown(thread_id)
        out: list[BaseMessage] = []
        inserted = False
        first_drop = min(drop_indices)
        for i, msg in enumerate(prefix):
            if is_tool_history_human(msg):
                continue
            if i in drop_indices:
                if not inserted and i == first_drop:
                    out.append(HumanMessage(content=batch_body, name=_TOOL_HISTORY_NAME))
                    inserted = True
                continue
            out.append(msg)
        if not inserted:
            out.insert(0, HumanMessage(content=batch_body, name=_TOOL_HISTORY_NAME))
        logger.info(
            "Tool history batch merge thread=%s tools=%d tokens≈%d",
            thread_id,
            len(scan.candidates),
            sum(e.token_estimate for e in scan.candidates),
        )
        return out, True

    shaped_by_index: dict[int, ToolMessage] = {}
    for e in scan.candidates:
        shaped_by_index[e.tool_index] = ToolMessage(
            content=e.content,
            tool_call_id=e.tool_call_id or "unknown",
            name=e.tool_name,
        )

    out: list[BaseMessage] = []
    changed = False
    for i, msg in enumerate(prefix):
        if is_tool_history_human(msg):
            changed = True
            continue
        if i in shaped_by_index:
            out.append(shaped_by_index[i])
            changed = True
        else:
            out.append(msg)
    return out, changed


def apply_cold_zone_policy(
    messages: list[BaseMessage],
    *,
    boundary: int,
    thread_id: str,
    prior_tool_history_blocks: list[str] | None = None,
) -> tuple[list[BaseMessage] | None, list[ToolRoundEntry]]:
    if boundary <= 0:
        return None, []

    prefix = list(messages[:boundary])
    suffix = list(messages[boundary:])
    preserve = prune_preserve_tool_names()
    scan = _scan_cold_prefix(prefix, preserve)

    from evoflow.agents.context_compaction_core import dedupe_compaction_artifacts

    if not scan.candidates:
        if not prior_tool_history_blocks:
            return None, []
        body = _merge_prior_tool_history_blocks(TOOL_HISTORY_PREFIX, prior_tool_history_blocks)
        new_prefix = [HumanMessage(content=body, name=_TOOL_HISTORY_NAME)] + [m for m in prefix if not is_tool_history_human(m)]
        return dedupe_compaction_artifacts(new_prefix + suffix), []

    new_prefix, changed = rebuild_cold_prefix(
        prefix,
        thread_id=thread_id,
        scan=scan,
        prior_tool_history_blocks=prior_tool_history_blocks,
    )
    if not changed:
        return None, scan.candidates

    return dedupe_compaction_artifacts(new_prefix + suffix), scan.candidates
