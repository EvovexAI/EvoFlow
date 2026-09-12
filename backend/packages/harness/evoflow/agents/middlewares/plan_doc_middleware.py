"""Persist planning output as a markdown artifact."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

try:
    from typing import override
except ImportError:
    from typing import override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import AIMessage
from langgraph.runtime import Runtime

from evoflow.agents.middlewares.collab_lifecycle_cn_logging import log_collab_lifecycle_cn
from evoflow.collab.models import CollabPhase
from evoflow.collab.thread_collab import load_thread_collab_state
from evoflow.config.paths import VIRTUAL_PATH_PREFIX
from evoflow.persistence import plan_repositories as plan_repo

_PLAN_PREFIX = "# Plan"
_PHASES = frozenset({CollabPhase.PLANNING.value, CollabPhase.PLAN_READY.value, CollabPhase.AWAITING_EXEC.value})


def _now_tag() -> str:
    return datetime.now(UTC).strftime("%Y%m%d-%H%M%S")


def _as_text(content: Any) -> str:
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
    return str(content or "")


def _looks_like_plan_text(text: str) -> bool:
    t = str(text or "").strip()
    if not t:
        return False
    if t.startswith(_PLAN_PREFIX):
        return True
    hints = (
        "任务执行计划",
        "执行计划",
        "执行逻辑",
        "依赖配置",
        "步骤",
        "验收",
        "test plan",
        "execution plan",
    )
    if any(k in t for k in hints):
        return True
    # Table-like plan
    if "|" in t and ("步骤" in t or "任务" in t):
        return True
    # Common plan headings (Chinese)
    if "##" in t and ("目标" in t or "范围" in t or "行动" in t):
        return True
    return False


class PlanDocMiddleware(AgentMiddleware[AgentState]):
    """When in planning phases, save assistant plan markdown to outputs/ and register as artifact."""

    state_schema = AgentState

    def _resolve_effective_phase(self, runtime: Runtime) -> str:
        ctx = runtime.context or {}
        phase = str(ctx.get("collab_phase") or "").strip().lower()
        if phase and phase != CollabPhase.IDLE.value:
            return phase
        tid = str(ctx.get("thread_id") or "").strip()
        if not tid:
            return phase
        try:
            from evoflow.config.paths import get_paths

            disk = load_thread_collab_state(get_paths(), tid)
            p = disk.collab_phase.value if isinstance(disk.collab_phase, CollabPhase) else str(disk.collab_phase or "")
            return str(p or phase).strip().lower()
        except Exception:
            return phase

    def _maybe_persist(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        ctx = runtime.context or {}
        phase = self._resolve_effective_phase(runtime)
        if phase not in _PHASES:
            return None

        thread_id = str(ctx.get("thread_id") or "").strip()
        if not thread_id:
            return None

        messages = state.get("messages") or []
        if not messages:
            return None
        last = messages[-1]
        if not isinstance(last, AIMessage):
            return None

        text = _as_text(getattr(last, "content", "")).strip()
        if not _looks_like_plan_text(text):
            return None

        body = text + ("\n" if not text.endswith("\n") else "")
        stamp = _now_tag()
        plan_repo.save_thread_plan(
            thread_id,
            body,
            plan_md_stamped=body,
            stamped_label=f"plan-{stamp}",
        )

        v_latest = f"{VIRTUAL_PATH_PREFIX}/outputs/plan.md"
        v_stamped = f"{VIRTUAL_PATH_PREFIX}/outputs/plan-{stamp}.md"
        log_collab_lifecycle_cn(
            "计划文档已写入数据库",
            {
                "线程ID": thread_id,
                "协作阶段": phase,
                "计划引用": [v_latest, v_stamped],
            },
        )
        return None

    @override
    def after_model(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        return self._maybe_persist(state, runtime)

    @override
    async def aafter_model(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        return self._maybe_persist(state, runtime)
