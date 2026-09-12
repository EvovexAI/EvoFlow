"""Shared hosted-goal helpers for in-run auto-continue (single lead_agent run)."""

from __future__ import annotations

import logging
from typing import Any

from langgraph.config import get_config

logger = logging.getLogger(__name__)

# Ephemeral goal auto-continue nudge for the next model call (not checkpoint / DB transcript).
_pending_goal_nudges: dict[str, str] = {}


def set_pending_goal_nudge(session_key: str, nudge: str) -> None:
    sk = str(session_key or "").strip()
    text = str(nudge or "").strip()
    if not sk or not text:
        return
    _pending_goal_nudges[sk] = text


def pop_pending_goal_nudge(session_key: str) -> str:
    sk = str(session_key or "").strip()
    if not sk:
        return ""
    return str(_pending_goal_nudges.pop(sk, "") or "").strip()


def peek_pending_goal_nudge(session_key: str) -> str:
    sk = str(session_key or "").strip()
    if not sk:
        return ""
    return str(_pending_goal_nudges.get(sk) or "").strip()


def _configurable() -> dict[str, Any]:
    try:
        cfg = get_config()
        conf = cfg.get("configurable") if isinstance(cfg, dict) else {}
        return dict(conf) if isinstance(conf, dict) else {}
    except Exception:
        return {}


def runtime_context_dict(runtime: Any) -> dict[str, Any]:
    from evoflow.agents.lead_agent.runtime_context import runtime_context_mapping

    return runtime_context_mapping(runtime)


def resolve_session_key(runtime: Any) -> str:
    ctx = runtime_context_dict(runtime)
    sk = str(ctx.get("session_key") or "").strip()
    if sk:
        return sk
    return str(_configurable().get("session_key") or "").strip()


def goal_mode_from_context(ctx: dict[str, Any] | None) -> bool:
    if not isinstance(ctx, dict):
        return False
    if bool(ctx.get("goal_mode")) or bool(ctx.get("hosted_goal_mode")):
        return True
    if bool(ctx.get("goal_automated")) and (
        str(ctx.get("prompt_source") or "").strip() in {"goal", "goal_controller", "hosted_autofollow", "user"}
    ):
        return True
    return False


def infer_goal_mode_from_row(row: dict[str, Any] | None) -> bool:
    """True when SQLite shows an in-flight hosted goal (waiting for chat or actively running)."""
    if not row or not goal_active(row):
        return False
    st = str(row.get("status") or "").strip().lower()
    return st in {"waiting", "running"}


def goal_mode_from_runtime(runtime: Any) -> bool:
    ctx = runtime_context_dict(runtime)
    if goal_mode_from_context(ctx):
        return True
    conf = _configurable()
    if goal_mode_from_context(conf):
        return True
    if bool(conf.get("goal_automated")) and bool(conf.get("session_key")):
        return True
    sk = resolve_session_key(runtime)
    if sk and infer_goal_mode_from_row(load_goal_row(sk)):
        return True
    return False


def load_goal_row(session_key: str) -> dict[str, Any] | None:
    sk = str(session_key or "").strip()
    if not sk:
        return None
    try:
        from evoflow.persistence import goal_repositories as goal_repo

        row = goal_repo.load_goal_session(sk)
    except Exception:
        logger.debug("hosted goal row load failed sk=%s", sk, exc_info=True)
        return None
    if not isinstance(row, dict):
        return None
    gs = str(row.get("goal_status") or "").strip().lower()
    if gs not in {"active", "paused"}:
        return None
    return row


def goal_active(row: dict[str, Any] | None) -> bool:
    if not row:
        return False
    gs = str(row.get("goal_status") or "").strip().lower()
    if gs not in {"active"}:
        return False
    if bool(row.get("continuation_suppressed")):
        return False
    return True


def clip_goal_summary_text(text: str | None, *, max_len: int = 16000) -> str:
    """Strip ``<completed>`` tags, interpreter JSON/noise, and clip for ``goal_summary``."""
    import re

    from evoflow.agents.goal.goal_controller import strip_completed_tag

    body = strip_completed_tag(str(text or "")).strip()
    if not body:
        return ""
    # 判定器 JSON / 内部模板行不应进入用户可见的目标汇报
    body = re.sub(
        r'\{\s*"verdict"\s*:\s*"(?:continue|complete|wait_user)"[^}]*\}',
        "",
        body,
        flags=re.DOTALL | re.IGNORECASE,
    )
    kept: list[str] = []
    for line in body.splitlines():
        s = line.strip()
        if not s:
            kept.append("")
            continue
        if re.match(r"^\[(?:Turn|Assistant reply|Goal)\]", s, re.IGNORECASE):
            continue
        if s.startswith("{") and "verdict" in s:
            continue
        kept.append(line)
    body = "\n".join(kept)
    body = re.sub(r"\n{3,}", "\n\n", body).strip()
    if not body:
        return ""
    if len(body) <= max_len:
        return body
    return body[: max_len - 1] + "…"



def patch_goal_state(session_key: str, **fields: Any) -> None:
    """Write hosted goal runtime fields to SQLite (LangGraph process → EvoPanel poll).

    Uses ``patch_goal_runtime_atomic`` (single ``UPDATE ... WHERE goal_status IN
    ('active','paused')``) to avoid lost-update races when middleware,
    and controller concurrently write the same row. The ``WHERE`` guard means
    stale writes are silently dropped once the goal reaches a terminal state.
    """
    sk = str(session_key or "").strip()
    if not sk or not fields:
        return
    allowed = {
        "goal_status",
        "goal_revision",
        "continuation_suppressed",
        "status",
        "step_count",
        "enabled",
        "last_run_at",
        "last_run_id",
        "last_error",
        "pending_feedback",
        "feedback_prompt",
        "error_count",
        "ended_at",
        "start_time",
        "goal_summary",
        "completion_outcome",
        "interpreter_fallback_streak",
    }
    kwargs: dict[str, Any] = {}
    for key, value in fields.items():
        if key not in allowed:
            continue
        if key == "last_error" and value is None:
            kwargs[key] = ""
        elif value is not None:
            kwargs[key] = value
    if not kwargs:
        return
    try:
        from evoflow.persistence import goal_repositories as goal_repo

        goal_repo.patch_goal_runtime_atomic(sk, fields=kwargs, where_goal_active=True)
    except Exception:
        logger.warning("hosted goal patch failed sk=%s fields=%s", sk, list(kwargs.keys()), exc_info=True)


def build_goal_mode_preamble(*, goal_text: str, max_steps: int) -> str:
    """First-turn preamble: tell the model it's in goal mode."""
    goal = str(goal_text or "").strip()
    head = f"[目标模式 · 第1/{max_steps}轮] 你正处于目标模式，将持续自动推进直到目标完成。"
    tail = (
        "每轮结束时用正文简要汇报进展或完成情况即可——"
        "系统会用判定模型理解你的回复并自动决定续跑或完成。"
        "不需要调用任何特殊汇报工具。"
    )
    if goal:
        return f"{head}\n\n目标：{goal}\n\n{tail}"
    return f"{head}\n\n{tail}"


def build_continue_nudge(*, goal_text: str, turn_no: int, max_steps: int = 50, initiative: int = 60) -> str:
    goal = str(goal_text or "").strip()
    head = f"[Goal 续跑 · 第{turn_no}/{max_steps}轮] 请继续推进目标。"
    # #8: 根据 initiative 级别注入主动性指导，使配置对 lead_agent 实际生效
    if initiative >= 80:
        initiative_hint = "主动性高：可主动补全缺失信息、给出明确下一步并果断执行。"
    elif initiative >= 50:
        initiative_hint = "主动性中等：优先跟随目标推进，必要时给出1条关键建议。"
    else:
        initiative_hint = "主动性保守：严格按目标执行，避免发散。"
    tail = (
        f"{initiative_hint}\n"
        "每轮结束时用正文简要汇报进展或完成情况即可——"
        "系统会用判定模型理解你的回复并自动决定续跑或完成。\n"
        "如果目标已全部完成，在回复中明确说明已完成，系统会判定为 complete。"
    )
    if goal:
        return f"{head}\n\n目标：{goal}\n\n{tail}"
    return f"{head}\n\n{tail}"
