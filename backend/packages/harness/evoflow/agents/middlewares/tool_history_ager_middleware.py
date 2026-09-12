"""Age cold-zone tools: batch merge into [tool:history] or per-tool summary; LLM in background."""

from __future__ import annotations

import logging
from typing import Any

try:
    from typing import override
except ImportError:
    from typing import override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import AIMessage, ToolMessage
from langgraph.runtime import Runtime

from evoflow.agents.context_compaction_core import message_token_estimate
from evoflow.agents.middleware_state import replace_messages_in_state
from evoflow.config.tool_results_config import get_tool_results_config, tool_result_compression_active, tool_uses_llm_summary
from evoflow.context.shaped_tool_cache import remember_shaped
from evoflow.context.tool_history_ager_queue import ToolSummaryJob, get_tool_history_summary_queue
from evoflow.context.tool_history_merge import ToolRoundEntry, apply_cold_zone_policy
from evoflow.context.tool_result_summarizer import is_already_shaped, is_frozen_tool_history
from evoflow.context.tool_tokens import count_tool_tokens

logger = logging.getLogger(__name__)


def _thread_id_from_runtime(runtime: Runtime) -> str:
    ctx = getattr(runtime, "context", None) or {}
    if isinstance(ctx, dict):
        for key in ("thread_id", "session_key"):
            val = ctx.get(key)
            if val:
                return str(val).strip()
    try:
        from langgraph.config import get_config

        tid = str(get_config().get("configurable", {}).get("thread_id") or "").strip()
        if tid:
            return tid
    except Exception:
        pass
    return "default"


def _boundary_by_recent_tools(messages: list, keep_full_tools: int) -> int:
    """Suffix keeps the newest ``keep_full_tools`` tool rounds; all older rounds are cold (batch-merge)."""
    tool_indices = [i for i, m in enumerate(messages) if isinstance(m, ToolMessage)]
    n_tools = len(tool_indices)
    if n_tools <= keep_full_tools:
        return len(messages)

    cold_tools = n_tools - keep_full_tools
    first_hot = tool_indices[cold_tools]
    boundary = first_hot
    if boundary > 0 and isinstance(messages[boundary - 1], AIMessage):
        boundary -= 1
    return max(0, boundary)


def _boundary_by_tail_tokens(messages: list, min_messages: int, token_budget: int) -> int:
    n = len(messages)
    min_protect = min(min_messages, max(0, n - 1))
    accumulated = 0
    boundary = n
    for i in range(n - 1, -1, -1):
        msg_tokens = message_token_estimate(messages[i])
        if accumulated + msg_tokens > token_budget and (n - i) >= min_protect:
            boundary = i
            break
        accumulated += msg_tokens
        boundary = i
    return max(boundary, n - min_protect)


def _prune_boundary(messages: list, keep_full_tools: int, token_budget: int) -> int:
    """Cold prefix vs hot suffix: recent tool rounds stay full; older rounds batch-merge."""
    by_tools = _boundary_by_recent_tools(messages, keep_full_tools)
    min_messages = min(keep_full_tools * 2, max(4, len(messages) - 1))
    by_tokens = _boundary_by_tail_tokens(messages, min_messages, token_budget)
    # Tool-count split wins; token budget can only shrink cold zone (higher boundary index).
    return min(by_tools, by_tokens)


def _background_jobs_for_candidates(
    thread_id: str,
    candidates: list[ToolRoundEntry],
) -> list[ToolSummaryJob]:
    cfg = get_tool_results_config()
    if not cfg.history_background_llm or not cfg.llm_summary_enabled:
        return []

    jobs: list[ToolSummaryJob] = []
    batch_raw: list[str] = []
    batch_ids: list[str] = []

    for e in candidates:
        if not e.tool_call_id or not e.raw_content:
            continue
        if not tool_uses_llm_summary(e.tool_name):
            continue
        if count_tool_tokens(e.raw_content) <= cfg.tier_small_tokens:
            continue
        if is_frozen_tool_history(e.content) or is_already_shaped(e.raw_content):
            continue
        batch_raw.append(f"### {e.tool_name} ({e.tool_call_id})\n{e.raw_content[:4000]}")
        batch_ids.append(e.tool_call_id)

    # Batch LLM summary path requires ≥2 raw rounds; otherwise per-tool path
    # is more efficient (1 raw → 1 per-tool job, no batch overhead).
    # ``history_merge_min_tools`` (default 1) is for the synchronous cold-zone
    # merge into [tool:history] block — reusing it here would force every single
    # raw round into a batch with itself, defeating the per-tool job path below.
    batch_min = max(2, cfg.history_merge_min_tools)
    if len(batch_ids) >= batch_min:
        jobs.append(
            ToolSummaryJob(
                thread_id=thread_id,
                tool_call_id="__history_batch__",
                tool_name="tool_history",
                content="\n\n".join(batch_raw),
            )
        )
        return jobs

    for e in candidates:
        if not e.tool_call_id or not e.raw_content:
            continue
        if not tool_uses_llm_summary(e.tool_name):
            continue
        if count_tool_tokens(e.raw_content) <= cfg.tier_small_tokens:
            continue
        if is_already_shaped(e.raw_content):
            continue
        jobs.append(
            ToolSummaryJob(
                thread_id=thread_id,
                tool_call_id=e.tool_call_id,
                tool_name=e.tool_name,
                content=e.raw_content,
            )
        )
    return jobs


def apply_tool_history_fast(
    messages: list,
    *,
    thread_id: str,
    prior_tool_history_blocks: list[str] | None = None,
) -> tuple[list | None, list[ToolSummaryJob]]:
    """Hot path: cold-zone batch merge or per-tool rule summary; queue background LLM."""
    if not tool_result_compression_active():
        return None, []
    cfg = get_tool_results_config()
    if not cfg.enabled or not cfg.history_summarize_enabled:
        return None, []

    if len(messages) < 4:
        return None, []

    boundary = _prune_boundary(messages, cfg.history_keep_full_tools, cfg.history_tail_token_budget)
    merged, candidates = apply_cold_zone_policy(
        messages,
        boundary=boundary,
        thread_id=thread_id,
        prior_tool_history_blocks=prior_tool_history_blocks,
    )

    for e in candidates:
        if e.tool_call_id and e.content:
            remember_shaped(thread_id, e.tool_call_id, e.content)

    bg_jobs = _background_jobs_for_candidates(thread_id, candidates)

    if merged is None:
        return None, bg_jobs

    logger.info(
        "Tool history aged thread=%s boundary=%d candidates=%d bg_jobs=%d",
        thread_id,
        boundary,
        len(candidates),
        len(bg_jobs),
    )
    return merged, bg_jobs


class ToolHistoryAgerMiddleware(AgentMiddleware[AgentState]):
    """Cold-zone batch [tool:history]; background LLM refines shaped_tool_cache.

    **Currently unused**: ToolHistory aging runs through ``apply_tool_history_fast``
    invoked by ``ContextCompactionMiddleware`` instead of this standalone middleware.
    This class is kept for completeness / future agents that prefer a standalone
    middleware over a piggy-back in ContextCompactionMiddleware. If you mount it,
    note that AgentState uses ``add_messages`` reducer — must use
    ``replace_messages_in_state`` (not raw ``{"messages": aged}``) to actually drop
    cold tool messages instead of appending the tool_history block on top.
    """

    state_schema = AgentState

    @override
    def before_model(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        messages = state.get("messages") or []
        if not isinstance(messages, list) or len(messages) < 4:
            return None
        thread_id = _thread_id_from_runtime(runtime)
        aged, bg_jobs = apply_tool_history_fast(messages, thread_id=thread_id)
        if bg_jobs:
            get_tool_history_summary_queue().enqueue(bg_jobs)
        if aged is None:
            return None
        # AgentState.messages 用 Annotated[list, add_messages] reducer：直接返回
        # {"messages": aged} 只会 merge by id，旧的 cold ToolMessage 不会被 drop，
        # 反而会让新增的 tool_history block 追加到末尾——每轮都会重复堆积。
        # 必须用 RemoveMessage + REMOVE_ALL_MESSAGES 全量替换。
        return replace_messages_in_state(aged)

    @override
    async def abefore_model(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        return self.before_model(state, runtime)
