"""In-graph hosted goal orchestration: event-driven Goal ↔ MainAgent loop."""

from __future__ import annotations

import logging
from typing import Any

from langchain_core.runnables import RunnableConfig
from langgraph.graph import END, START, StateGraph
from langgraph_sdk.runtime import ServerRuntime

from evoflow.agents.goal.goal_controller import evaluate_goal, goal_controller_node
from evoflow.agents.goal.goal_state import GoalState
from evoflow.agents.goal.main_agent_runner import stream_lead_agent_goal_step
from evoflow.persistence.transcript_resume_anchor import latest_turn_reply_text

logger = logging.getLogger(__name__)

_GOAL_GRAPH_ID = "goal_agent"

_LEAD_AGENT_CONTEXT_KEYS = frozenset(
    {
        "thread_id",
        "session_key",
        "agent_name",
        "goal_automated",
        "prompt_source",
        "session_mode",
        "thinking_enabled",
        "reasoning_effort",
        "is_plan_mode",
        "subagent_enabled",
        "planner_model_name",
        "max_steps",
        "max_run_minutes",
        "run_trigger",
        "pending_continuation",
    }
)


def _lead_agent_context(cfg: dict[str, Any], *, lead_thread_id: str, session_key: str, continuation: str) -> dict[str, Any]:
    ctx = {
        k: v
        for k, v in cfg.items()
        if k in _LEAD_AGENT_CONTEXT_KEYS and not callable(v) and not isinstance(v, type)
    }
    ctx.setdefault("thread_id", lead_thread_id)
    ctx.setdefault("session_key", session_key)
    ctx.setdefault("goal_automated", True)
    ctx.setdefault("goal_mode", True)
    ctx["prompt_source"] = "goal_controller" if continuation else "user"
    return ctx


def _lead_agent_configurable(cfg: dict[str, Any], *, lead_thread_id: str, session_key: str, continuation: str) -> dict[str, Any]:
    base = _lead_agent_context(cfg, lead_thread_id=lead_thread_id, session_key=session_key, continuation=continuation)
    base["thread_id"] = lead_thread_id
    base["pending_continuation"] = continuation
    return base


def _configurable(config: RunnableConfig | None) -> dict[str, Any]:
    if not isinstance(config, dict):
        return {}
    conf = config.get("configurable")
    return dict(conf) if isinstance(conf, dict) else {}


async def main_agent_node(state: GoalState, config: RunnableConfig) -> dict[str, Any]:
    """One lead-agent run; synthetic continuation only when pending_continuation is set."""
    cfg = _configurable(config)
    lead_thread_id = str(state.get("lead_thread_id") or cfg.get("lead_thread_id") or cfg.get("thread_id") or "").strip()
    session_key = str(state.get("session_key") or cfg.get("session_key") or "").strip()
    continuation = str(state.get("pending_continuation") or "").strip()
    run_trigger = str(state.get("run_trigger") or cfg.get("run_trigger") or "").strip()

    if not lead_thread_id:
        return {
            "status": "failed",
            "last_error": "missing lead_thread_id",
            "pending_continuation": None,
            "run_status": "finished",
        }

    # goal_created / user_steering: real user text is already in chat transcript — no synthetic.
    if run_trigger in {"goal_created", "user_steering"}:
        continuation = ""

    lead_config: dict[str, Any] = {
        "configurable": _lead_agent_configurable(
            cfg,
            lead_thread_id=lead_thread_id,
            session_key=session_key,
            continuation=continuation,
        ),
        "recursion_limit": int(cfg.get("lead_recursion_limit") or 100),
    }

    patch: dict[str, Any] = {
        "run_status": "running",
        "status": "running",
        "pending_continuation": None,
    }

    try:
        run_context = _lead_agent_context(
            cfg,
            lead_thread_id=lead_thread_id,
            session_key=session_key,
            continuation=continuation,
        )
        await stream_lead_agent_goal_step(
            lead_thread_id=lead_thread_id,
            session_key=session_key,
            continuation=continuation,
            lead_config=lead_config,
            run_context=run_context,
        )
        patch["run_status"] = "finished"
    except Exception as exc:
        logger.warning("hosted_goal main_agent failed thread=%s: %s", lead_thread_id, exc, exc_info=True)
        patch.update(
            {
                "status": "failed",
                "last_error": str(exc),
                "run_status": "cancelled",
            }
        )
        return patch

    reply = ""
    if session_key:
        try:
            reply = latest_turn_reply_text(session_key) or ""
        except Exception:
            logger.debug("hosted_goal: latest_turn_reply_text failed sk=%s", session_key, exc_info=True)

    patch["last_agent_reply"] = reply
    patch["current_step"] = int(state.get("current_step") or 0) + 1
    if reply.strip():
        from evoflow.agents.goal.goal_reply_interpreter import interpret_goal_reply_async
        from evoflow.agents.goal.goal_runtime import goal_active, load_goal_row

        # 守卫：goal_report 可能已写终态，重读 SQLite 避免覆盖
        if session_key:
            _fresh_row = load_goal_row(session_key)
            if _fresh_row and not goal_active(_fresh_row):
                logger.info(
                    "hosted_goal main_agent: SQLite already terminal (goal_status=%s), skip interpreter",
                    _fresh_row.get("goal_status"),
                )
                return patch

        goal_text = str(state.get("goal_text") or cfg.get("goal_text") or "").strip()
        max_steps = int(state.get("max_steps") or cfg.get("max_steps") or 50)
        verdict = await interpret_goal_reply_async(
            goal_text=goal_text,
            assistant_reply=reply,
            turn_no=int(patch["current_step"]),
            max_steps=max_steps,
            configurable=cfg,
        )
        if verdict.verdict == "complete":
            patch["goal_status"] = "completed"
            patch["status"] = "completed"
    return patch


def _route_entry(state: GoalState) -> str:
    goal_status = str(state.get("goal_status") or "active").strip().lower()
    if goal_status in {"paused", "completed", "cleared"}:
        return END
    if bool(state.get("continuation_suppressed")):
        return END
    trigger = str(state.get("run_trigger") or "").strip()
    # Web 首条消息已由前端 chatSend 跑完 lead_agent → 直接进入 Goal Controller。
    if trigger in {"goal_created", "user_steering"} and bool(state.get("frontend_chat_done")):
        return "goal_controller"
    # 非 Web / 旧路径：目标文本已在 transcript，由 main_agent 调 lead_agent。
    if trigger in {"goal_created", "user_steering"}:
        return "main_agent"
    return "goal_controller"


def _route_after_controller(state: GoalState) -> str:
    """Single macro lead_agent run: controller only evaluates, never restarts main_agent."""
    _ = evaluate_goal(state)
    return END


def _route_after_main_agent(state: GoalState) -> str:
    st = str(state.get("status") or "").strip()
    if st in {"failed", "waiting_user"}:
        return END
    return "goal_controller"


def _build_hosted_goal_state_graph() -> StateGraph:
    graph = StateGraph(GoalState)
    graph.add_node("goal_controller", goal_controller_node)
    graph.add_node("main_agent", main_agent_node)
    graph.add_conditional_edges(START, _route_entry)
    graph.add_conditional_edges("goal_controller", _route_after_controller)
    graph.add_conditional_edges("main_agent", _route_after_main_agent)
    return graph


def make_goal_graph(config: RunnableConfig, runtime: ServerRuntime | None = None):
    """LangGraph Server entry for ``goal_agent``."""
    _ = (config, runtime)
    return _build_hosted_goal_state_graph().compile()


__all__ = ["make_goal_graph", "_GOAL_GRAPH_ID"]
