"""Hybrid mode: deprecated turn-level prefetch (use search_code_index read_limit instead)."""

from __future__ import annotations

import logging
import re
from typing import Any

try:
    from typing import override
except ImportError:
    from typing import override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import HumanMessage
from langgraph.config import get_config
from langgraph.runtime import Runtime

from evoflow.agents.memory.conversation_filter import format_message_plain_text
from evoflow.config.agent_orchestration_config import get_agent_orchestration_config, is_hybrid_mode
from evoflow.tools.builtins.scenario_activation import get_activated_scenarios, sync_activated_scenarios_from_mission_storage

logger = logging.getLogger(__name__)

# 非工作区检索意图：跳过 prefetch，避免「介绍一下自己」等对话触发整库预读 + scheduler 行
_NON_WORKSPACE_PREFETCH_RE = re.compile(
    r"(介绍一下|介绍.{0,8}自己|你是谁|你能做什么|有什么功能|evoflow\s*是什么|"
    r"怎么用\s*evoflow|使用方式|能力边界|官网|evovexai)",
    re.IGNORECASE,
)


def _workspace_root(runtime: Runtime) -> str | None:
    ctx = runtime.context if runtime.context else {}
    root = str(ctx.get("local_workspace_root") or "").strip()
    if root:
        return root
    try:
        conf = get_config()
        cfg = conf.get("configurable") if isinstance(conf, dict) else None
        if isinstance(cfg, dict):
            root = str(cfg.get("local_workspace_root") or "").strip()
            if root:
                return root
    except Exception:
        pass
    return None


def _thread_id(runtime: Runtime) -> str | None:
    ctx = runtime.context if runtime.context else {}
    tid = str(ctx.get("thread_id") or "").strip()
    if tid:
        return tid
    try:
        conf = get_config()
        cfg = conf.get("configurable") if isinstance(conf, dict) else None
        if isinstance(cfg, dict):
            tid = str(cfg.get("thread_id") or "").strip()
            if tid:
                return tid
    except Exception:
        pass
    return None


def _prefetch_allowed(query: str, runtime: Runtime) -> bool:
    """Prefetch only for workspace-scoped code exploration, not generic chat/intro."""
    try:
        sync_activated_scenarios_from_mission_storage(runtime)
        active = {str(s or "").strip().lower() for s in (get_activated_scenarios() or []) if str(s).strip()}
    except Exception:
        active = set()
    if "agent" not in active:
        logger.debug("prefetch skipped: agent mode not active (active=%s)", sorted(active))
        return False
    q = (query or "").strip()
    if not q:
        return False
    if _NON_WORKSPACE_PREFETCH_RE.search(q):
        logger.debug("prefetch skipped: non-workspace query heuristics")
        return False
    return True


class PrefetchSchedulerMiddleware(AgentMiddleware[AgentState]):
    """Inject ``<prefetch_context>`` once per user turn when hybrid + workspace bound."""

    def _prefetch_inputs(self, state: AgentState, runtime: Runtime) -> tuple[str, str, str | None] | None:
        orch = get_agent_orchestration_config()
        if not is_hybrid_mode() or not orch.hybrid.prefetch_enabled:
            return None

        root = _workspace_root(runtime)
        if not root:
            return None

        messages = state.get("messages") or []
        if not messages:
            return None
        last = messages[-1]
        if getattr(last, "type", None) != "human":
            return None
        if getattr(last, "name", None) in (
            "prefetch_context",
            "external_memory_prefetch",
            "todo_reminder",
        ):
            return None

        query = format_message_plain_text(last).strip()
        if not query:
            return None

        return query, root, _thread_id(runtime)

    @staticmethod
    def _inject_prefetch_message(fenced: str, root: str) -> dict[str, Any] | None:
        if not fenced.strip():
            return None
        logger.info("prefetch injected for workspace=%s chars=%d", root, len(fenced))
        return {"messages": [HumanMessage(name="prefetch_context", content=fenced)]}

    @override
    def before_model(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        inputs = self._prefetch_inputs(state, runtime)
        if not inputs:
            return None
        query, root, thread_id = inputs
        if not _prefetch_allowed(query, runtime):
            return None

        from evoflow.scheduler.engine import LocalToolScheduler

        sched = LocalToolScheduler(workspace_root=root, thread_id=thread_id)
        try:
            fenced = sched.run_prefetch(query)
        except Exception as e:
            logger.warning("prefetch scheduler failed: %s", e)
            return None
        return self._inject_prefetch_message(fenced, root)

    @override
    async def abefore_model(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        inputs = self._prefetch_inputs(state, runtime)
        if not inputs:
            return None
        query, root, thread_id = inputs
        if not _prefetch_allowed(query, runtime):
            return None

        from evoflow.scheduler.engine import LocalToolScheduler

        sched = LocalToolScheduler(workspace_root=root, thread_id=thread_id)
        try:
            fenced = await sched.run_prefetch_async(query)
        except Exception as e:
            logger.warning("prefetch scheduler failed: %s", e)
            return None
        return self._inject_prefetch_message(fenced, root)
