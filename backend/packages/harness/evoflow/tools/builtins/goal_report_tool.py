"""Hosted goal lifecycle tool — only bound in ``hosted_goal_mode`` runs."""

from __future__ import annotations

import json
import logging
import time
from typing import Literal

from langchain.tools import ToolRuntime, tool
from langgraph.typing import ContextT

from evoflow.agents.goal.goal_runtime import (
    clip_goal_summary_text,
    goal_mode_from_runtime,
    load_goal_row,
    patch_goal_state,
    resolve_session_key,
)
from evoflow.agents.goal.goal_trace_log import clip_goal_trace_text, format_goal_state_patch, log_goal_trace

logger = logging.getLogger(__name__)

goal_report_ui_metadata = {
    "group": "builtin",
    "label": "目标汇报",
    "icon": "🎯",
    "description": "目标模式下汇报进度或宣告完成（写入目标 Goal 状态）。",
}

GoalReportAction = Literal["progress", "wait_user", "complete"]


def _session_key_from_runtime(runtime: ToolRuntime[ContextT, dict] | None) -> str:
    if runtime is None:
        return ""
    return resolve_session_key(runtime)


def _log_goal_report(
    *,
    event: str,
    session_key: str,
    turn_no: int | None,
    max_steps: int | None,
    goal_text: str,
    action: str,
    summary: str,
    result: str,
    decision: str,
    state_patch: str = "",
    level: int = logging.INFO,
) -> None:
    log_goal_trace(
        event,
        session_key=session_key,
        turn_no=turn_no,
        max_steps=max_steps,
        goal_text=goal_text,
        user_input=f"goal_report(action={action}) summary={clip_goal_trace_text(summary, max_len=480)}",
        tool_result=result,
        decision=decision,
        action=f"goal_report:{action}",
        state_patch=state_patch,
        level=level,
    )


@tool("goal_report", parse_docstring=True)
def goal_report_tool(
    runtime: ToolRuntime[ContextT, dict],
    action: GoalReportAction,
    summary: str,
    question: str | None = None,
) -> str:
    """在**目标模式**下向系统汇报 Goal 状态（推荐调用；纯文本时由判定模型理解后更新状态）。

    - ``progress``：记录阶段性进展，run 会继续自动推进。
    - ``complete``：目标已全部完成；提供 ``summary`` 作为完成说明。

    Args:
        action: ``progress`` | ``complete``（兼容旧值 ``wait_user``，会当作 ``progress`` 处理）。
        summary: 进展或完成说明（1–2000 字）。
        question: 已废弃；若传入会并入 ``summary``。

    Returns:
        JSON：``{ok, action, goal_status, status}``。
    """
    session_key = _session_key_from_runtime(runtime)
    act = str(action or "").strip().lower()
    body = str(summary or "").strip()

    if not goal_mode_from_runtime(runtime):
        result = json.dumps(
            {"ok": False, "error": "goal_report 仅在目标模式（hosted_goal_mode）下可用"},
            ensure_ascii=False,
        )
        _log_goal_report(
            event="goal_report-拒绝",
            session_key=session_key,
            turn_no=None,
            max_steps=None,
            goal_text="",
            action=act,
            summary=body,
            result=result,
            decision="非 hosted_goal_mode，工具不可用",
            level=logging.WARNING,
        )
        return result

    if not session_key:
        result = json.dumps({"ok": False, "error": "missing session_key"}, ensure_ascii=False)
        _log_goal_report(
            event="goal_report-失败",
            session_key="",
            turn_no=None,
            max_steps=None,
            goal_text="",
            action=act,
            summary=body,
            result=result,
            decision="缺少 session_key",
            level=logging.WARNING,
        )
        return result

    row = load_goal_row(session_key)
    if not row:
        result = json.dumps({"ok": False, "error": "未找到活跃的目标会话"}, ensure_ascii=False)
        _log_goal_report(
            event="goal_report-失败",
            session_key=session_key,
            turn_no=None,
            max_steps=None,
            goal_text="",
            action=act,
            summary=body,
            result=result,
            decision="SQLite 无 enabled Goal 行",
            level=logging.WARNING,
        )
        return result

    goal_text = str(row.get("prompt") or "").strip()
    max_steps = int(row.get("max_steps") or 50)
    prev_step = int(row.get("step_count") or 0)

    if not body:
        result = json.dumps({"ok": False, "error": "summary 不能为空"}, ensure_ascii=False)
        _log_goal_report(
            event="goal_report-失败",
            session_key=session_key,
            turn_no=prev_step or 1,
            max_steps=max_steps,
            goal_text=goal_text,
            action=act,
            summary=body,
            result=result,
            decision="summary 为空",
            level=logging.WARNING,
        )
        return result

    if len(body) > 2000:
        body = body[:2000] + "…"

    # #12: goal_report 不再写 step_count — middleware 是唯一计数源，避免双重计数。
    # step_count 由 GoalAutoContinueMiddleware 在 after_model 统一管理。

    if act == "complete":
        summary_body = clip_goal_summary_text(body, max_len=2000)
        patch_goal_state(
            session_key,
            goal_status="completed",
            status="idle",
            last_error=None,
            ended_at=int(time.time() * 1000),
            completion_outcome="任务完成",
            goal_summary=summary_body,
        )
        # 主动更新 session 表 run_status — 不依赖流结束兜底，避免 goal 完成后
        # session 仍显示"运行中"（兜底有时间窗口，且 ensure_session_run_active
        # 可能在竞态窗口内把 done 愈合回 running）。
        try:
            from evoflow.session_execution.lifecycle import force_end_session_turn

            force_end_session_turn(
                session_key=session_key,
                source="goal_report_complete",
                reason="completed",
            )
        except Exception:
            logger.debug(
                "goal_report complete: force_end_session_turn failed sk=%s",
                session_key,
                exc_info=True,
            )
        result = json.dumps(
            {
                "ok": True,
                "action": "complete",
                "goal_status": "completed",
                "status": "idle",
                "summary": summary_body,
                "turn_no": prev_step or 1,
                "max_steps": max_steps,
            },
            ensure_ascii=False,
        )
        _log_goal_report(
            event="goal_report-完成",
            session_key=session_key,
            turn_no=prev_step or 1,
            max_steps=max_steps,
            goal_text=goal_text,
            action=act,
            summary=summary_body,
            result=result,
            decision="模型主动汇报目标完成",
            state_patch=format_goal_state_patch(
                goal_status="completed", status="idle", goal_summary="(written)"
            ),
        )
        return result

    if act == "wait_user":
        # 兼容旧 action：不再暂停，当作 progress 继续自动推进
        q = str(question or body).strip()
        progress_summary = clip_goal_summary_text(q or body, max_len=2000)
        patch_goal_state(
            session_key,
            goal_status="active",
            status="running",
        )
        result = json.dumps(
            {
                "ok": True,
                "action": "progress",
                "goal_status": "active",
                "status": "running",
                "summary": progress_summary,
                "turn_no": prev_step or 1,
                "max_steps": max_steps,
                "legacy_wait_user": True,
            },
            ensure_ascii=False,
        )
        _log_goal_report(
            event="goal_report-进展",
            session_key=session_key,
            turn_no=prev_step or 1,
            max_steps=max_steps,
            goal_text=goal_text,
            action=act,
            summary=progress_summary,
            result=result,
            decision="legacy wait_user 已映射为 progress，继续自动续跑",
            state_patch=format_goal_state_patch(status="running"),
        )
        return result

    if act == "progress":
        patch_goal_state(
            session_key,
            goal_status="active",
            status="running",
        )
        result = json.dumps(
            {
                "ok": True,
                "action": "progress",
                "goal_status": "active",
                "status": "running",
                "summary": body,
                "turn_no": prev_step or 1,
                "max_steps": max_steps,
            },
            ensure_ascii=False,
        )
        _log_goal_report(
            event="goal_report-进展",
            session_key=session_key,
            turn_no=prev_step or 1,
            max_steps=max_steps,
            goal_text=goal_text,
            action=act,
            summary=body,
            result=result,
            decision="模型汇报阶段性进展，允许自动续跑",
            state_patch=format_goal_state_patch(status="running"),
        )
        return result

    result = json.dumps(
        {"ok": False, "error": f"unknown action: {action!r}"},
        ensure_ascii=False,
    )
    _log_goal_report(
        event="goal_report-失败",
        session_key=session_key,
        turn_no=prev_step or 1,
        max_steps=max_steps,
        goal_text=goal_text,
        action=act,
        summary=body,
        result=result,
        decision="未知 action",
        level=logging.WARNING,
    )
    return result
