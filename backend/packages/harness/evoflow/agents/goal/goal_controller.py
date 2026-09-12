"""GoalController node: evaluate run.finished → continuation / wait / complete."""

from __future__ import annotations

import logging
import re
import time
from typing import Any

from langchain_core.runnables import RunnableConfig

from evoflow.agents.goal.goal_events import new_goal_event
from evoflow.agents.goal.goal_state import GOAL_CONTROLLER_SOURCE, GoalState
from evoflow.context.internal_model_invoke import ainvoke_internal_chat_model
from evoflow.models import create_chat_model

logger = logging.getLogger(__name__)

_COMPLETED_TAG_RE = re.compile(r"<completed>(.*?)</completed>", re.DOTALL | re.IGNORECASE)


def strip_completed_tag(text: str) -> str:
    return _COMPLETED_TAG_RE.sub("", text or "").strip()


def parse_completed_reason(text: str, *, current_step: int) -> str | None:
    match = _COMPLETED_TAG_RE.search(text or "")
    if not match:
        return None
    if int(current_step or 0) <= 0:
        logger.info("goal_controller: ignore <completed> on step 0")
        return None
    return match.group(1).strip()


def evaluate_goal(state: GoalState) -> str:
    """Return: complete | wait_user | pause | continue | suppressed."""
    goal_status = str(state.get("goal_status") or "active").strip().lower()
    if goal_status == "paused":
        return "pause"
    if goal_status in {"completed", "cleared"}:
        return "complete"
    if bool(state.get("continuation_suppressed")):
        return "suppressed"
    if str(state.get("status") or "") == "waiting_user" or str(state.get("clarification_prompt") or "").strip():
        return "wait_user"
    if str(state.get("status") or "") in {"completed", "failed", "interrupted"}:
        if str(state.get("status") or "") == "completed":
            return "complete"
        return "pause"
    return "continue"


def _configurable(config: RunnableConfig | None) -> dict[str, Any]:
    if not isinstance(config, dict):
        return {}
    conf = config.get("configurable")
    return dict(conf) if isinstance(conf, dict) else {}


def _planner_model_name(cfg: dict[str, Any]) -> str | None:
    name = str(cfg.get("planner_model_name") or cfg.get("model_name") or "").strip()
    return name or None


def _build_planner_messages(state: GoalState) -> list[dict[str, str]]:
    system = str(state.get("planner_system_prompt") or "").strip()
    goal_text = str(state.get("goal_text") or "").strip()
    messages: list[dict[str, str]] = []
    if system:
        messages.append({"role": "system", "content": system})
    elif goal_text:
        messages.append({"role": "system", "content": f"用户目标: {goal_text}"})

    lines: list[str] = []
    if goal_text:
        lines.append(f"[Goal] {goal_text}")
    last_reply = str(state.get("last_agent_reply") or "").strip()
    if last_reply:
        lines.append(f"[Last agent reply]\n{last_reply}")
    for evt in state.get("goal_events") or []:
        if not isinstance(evt, dict):
            continue
        et = str(evt.get("event_type") or "")
        if et == "goal_continuation_created":
            body = str(evt.get("content") or "").strip()
            if body:
                lines.append(f"[Previous continuation]\n{body}")

    user_body = "\n\n".join(lines).strip() or goal_text or "Continue the hosted goal."
    messages.append({"role": "user", "content": user_body})
    return messages


async def call_goal_planner(state: GoalState, config: RunnableConfig | None) -> str:
    cfg = _configurable(config)
    model_name = _planner_model_name(cfg)
    model = create_chat_model(
        name=model_name,
        thinking_enabled=False,
        invocation_kind="hosted_planner",
    )
    messages = _build_planner_messages(state)
    response = await ainvoke_internal_chat_model(model, messages)
    content = getattr(response, "content", "") or ""
    if not isinstance(content, str):
        content = str(content)
    return content.strip()


async def goal_controller_node(state: GoalState, config: RunnableConfig) -> dict[str, Any]:
    """After lead_agent run: sync goal status (no multi-run continuation)."""
    cfg = _configurable(config)
    goal_id = str(state.get("goal_id") or state.get("goal_session_id") or "").strip()
    goal_revision = int(state.get("goal_revision") or 1)
    current_step = int(state.get("current_step") or 0)
    max_steps = int(state.get("max_steps") or cfg.get("max_steps") or 50)
    eval_only = bool(state.get("single_lead_run") or cfg.get("single_lead_run", True))

    verdict = evaluate_goal(state)
    if verdict == "pause":
        return {
            "goal_status": str(state.get("goal_status") or "paused"),
            "run_status": "stopped",
            "pending_continuation": None,
            "status": "interrupted",
        }
    if verdict == "complete":
        return {
            "goal_status": "completed",
            "run_status": "finished",
            "pending_continuation": None,
            "status": "completed",
        }
    if verdict == "wait_user":
        clarification = str(state.get("clarification_prompt") or "").strip()
        evt = new_goal_event(
            event_type="goal_waiting_user",
            goal_id=goal_id,
            goal_revision=goal_revision,
            content=clarification,
        )
        return {
            "status": "waiting_user",
            "run_status": "finished",
            "pending_continuation": None,
            "goal_events": [evt],
        }
    if verdict == "suppressed":
        evt = new_goal_event(
            event_type="continuation_suppressed",
            goal_id=goal_id,
            goal_revision=goal_revision,
            content=str(state.get("stop_reason") or "user_stop"),
        )
        return {
            "goal_status": "active",
            "run_status": "stopped",
            "pending_continuation": None,
            "status": "interrupted",
            "goal_events": [evt],
        }

    started_at = float(state.get("started_at") or time.time())
    max_minutes = float(cfg.get("max_run_minutes") or 0)
    if max_minutes > 0 and (time.time() - started_at) > max_minutes * 60:
        evt = new_goal_event(
            event_type="goal_run_timeout",
            goal_id=goal_id,
            goal_revision=goal_revision,
            content="运行时间到达上限",
        )
        return {
            "goal_status": "completed",
            "status": "completed",
            "run_status": "finished",
            "pending_continuation": None,
            "goal_events": [evt],
        }

    if current_step >= max_steps:
        evt = new_goal_event(
            event_type="goal_max_steps",
            goal_id=goal_id,
            goal_revision=goal_revision,
            content=f"达到最大步数 {max_steps}",
        )
        return {
            "goal_status": "completed",
            "status": "completed",
            "run_status": "finished",
            "pending_continuation": None,
            "goal_events": [evt],
        }

    last_reply = str(state.get("last_agent_reply") or "").strip()
    if last_reply:
        from evoflow.agents.goal.goal_reply_interpreter import interpret_goal_reply_async
        from evoflow.agents.goal.goal_runtime import goal_active, load_goal_row

        # 守卫：goal_report 可能已写终态，重读 SQLite 避免覆盖
        _sk = str(state.get("session_key") or cfg.get("session_key") or "").strip()
        if _sk:
            _fresh_row = load_goal_row(_sk)
            if _fresh_row and not goal_active(_fresh_row):
                logger.info(
                    "goal_controller: SQLite already terminal (goal_status=%s), skip interpreter",
                    _fresh_row.get("goal_status"),
                )
                last_reply = ""

        if last_reply:
            goal_text = str(state.get("goal_text") or cfg.get("goal_text") or "").strip()
        try:
            verdict = await interpret_goal_reply_async(
                goal_text=goal_text,
                assistant_reply=last_reply,
                turn_no=current_step,
                max_steps=max_steps,
                configurable=cfg,
            )
        except Exception as exc:
            logger.warning("goal_controller interpreter failed goal_id=%s: %s", goal_id, exc, exc_info=True)
            verdict = None
        if verdict is not None and verdict.verdict == "complete":
            from evoflow.agents.goal.goal_runtime import clip_goal_summary_text

            completed_from_reply = clip_goal_summary_text(
                verdict.summary or verdict.reason or "任务完成"
            )
            evt = new_goal_event(
                event_type="goal_completed",
                goal_id=goal_id,
                goal_revision=goal_revision,
                content=completed_from_reply,
            )
            return {
                "goal_status": "completed",
                "status": "completed",
                "run_status": "finished",
                "pending_continuation": None,
                "goal_events": [evt],
            }

    if eval_only:
        return {
            "goal_status": "active",
            "status": "continuing",
            "run_status": "finished",
            "pending_continuation": None,
        }

    try:
        raw = await call_goal_planner(state, config)
    except Exception as exc:
        logger.warning("goal_controller planner failed goal_id=%s: %s", goal_id, exc, exc_info=True)
        evt = new_goal_event(
            event_type="goal_planner_failed",
            goal_id=goal_id,
            goal_revision=goal_revision,
            content=str(exc),
        )
        return {
            "status": "failed",
            "run_status": "finished",
            "pending_continuation": None,
            "last_error": str(exc),
            "goal_events": [evt],
        }

    completed_reason = parse_completed_reason(raw, current_step=current_step)
    if completed_reason is not None:
        evt = new_goal_event(
            event_type="goal_completed",
            goal_id=goal_id,
            goal_revision=goal_revision,
            content=completed_reason,
        )
        return {
            "goal_status": "completed",
            "status": "completed",
            "run_status": "finished",
            "pending_continuation": None,
            "goal_events": [evt],
        }

    continuation = strip_completed_tag(raw)
    if not continuation:
        evt = new_goal_event(
            event_type="goal_planner_empty",
            goal_id=goal_id,
            goal_revision=goal_revision,
            content="planner returned empty continuation",
        )
        return {
            "status": "continuing",
            "run_status": "finished",
            "pending_continuation": None,
            "goal_events": [evt],
        }

    evt = new_goal_event(
        event_type="goal_continuation_created",
        goal_id=goal_id,
        goal_revision=goal_revision,
        content=continuation,
        extra={"created_by": GOAL_CONTROLLER_SOURCE},
    )
    return {
        "goal_status": "active",
        "status": "continuing",
        "run_status": "finished",
        "run_trigger": "goal_continuation",
        "pending_continuation": continuation,
        "goal_events": [evt],
    }
