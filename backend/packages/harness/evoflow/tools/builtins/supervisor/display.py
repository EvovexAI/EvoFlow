"""Display and formatting helpers for supervisor subtask output.

Provides:
- _subtask_worker_profile_suffix — compact worker_profile line for list_subtasks/get_status
- _subtask_row_dict — structured subtask row for JSON tool results
- _build_monitor_subtask_rows — rich subtask rows with memory snapshots for monitoring
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

_STATUS_ZH_MAP = {
    "pending": "等待中",
    "planned": "已规划",
    "planning": "规划中",
    "executing": "正在处理中",
    "running": "正在处理中",
    "in_progress": "正在处理中",
    "completed": "已完成",
    "failed": "失败",
    "cancelled": "已取消",
    "timed_out": "超时",
}


def _status_zh(v: Any) -> str:
    s = str(v or "").strip().lower()
    return _STATUS_ZH_MAP.get(s, "未知")


def _subtask_worker_profile_suffix(st: dict) -> str:
    """Compact worker_profile line for list_subtasks / get_status (template + constraints)."""
    wp = st.get("worker_profile")
    if not isinstance(wp, dict) or not wp:
        return ""
    parts: list[str] = []
    b = wp.get("base_subagent")
    if b:
        parts.append(f"base={b}")
    tools = wp.get("tools") or []
    if tools:
        t = ",".join(str(x) for x in tools[:12])
        if len(tools) > 12:
            t += ",..."
        parts.append(f"tools={t}")
    skills = wp.get("skills") or []
    if skills:
        s = ",".join(str(x) for x in skills[:12])
        if len(skills) > 12:
            s += ",..."
        parts.append(f"skills={s}")
    dep = wp.get("depends_on") or []
    if dep:
        parts.append(f"deps={','.join(str(x) for x in dep)}")
    ins = (wp.get("instruction") or "").strip()
    if ins:
        _trunc = (ins[:80] + "...") if len(ins) > 80 else ins[:80]
        parts.append(f"instr={_trunc}")
    if not parts:
        return ""
    return " | profile: " + "; ".join(parts)


def _subtask_row_dict(st: dict) -> dict[str, Any]:
    """Structured subtask row for JSON tool results (get_status / list_subtasks)."""
    status = st.get("status", "unknown")
    icon = {"pending": "open", "executing": "running", "completed": "done", "failed": "failed"}.get(status, "open")
    wp = st.get("worker_profile")
    summary = _subtask_worker_profile_suffix(st)
    if summary.startswith(" | profile: "):
        summary = summary[len(" | profile: ") :]
    else:
        summary = ""
    result_text = st.get("result")
    error_text = st.get("error")
    wc = st.get("work_checklist")
    work_checklist = [x for x in wc if isinstance(x, dict)] if isinstance(wc, list) else []
    return {
        "id": st.get("id"),
        "ref": st.get("ref"),
        "name": st.get("name", "unnamed"),
        "status": status,
        "workChecklist": work_checklist,
        "statusZh": _status_zh(status),
        "statusIcon": icon,
        "assignedTo": st.get("assigned_to") or "unassigned",
        "workerProfile": wp if isinstance(wp, dict) else None,
        "workerProfileSummary": summary,
        "result": result_text if isinstance(result_text, str) else (str(result_text) if result_text is not None else None),
        "error": error_text if isinstance(error_text, str) else (str(error_text) if error_text is not None else None),
        "claudeSessionId": st.get("claude_session_id") or st.get("external_session_id"),
        "updatedAt": st.get("updated_at"),
        "completedAt": st.get("completed_at"),
        "startedAt": st.get("started_at"),
    }


def _build_monitor_subtask_rows(
    storage: Any,
    subtasks: list[dict[str, Any]],
    *,
    main_task: dict[str, Any] | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Build rich subtask rows for monitor_execution_step to support lead-agent reasoning."""
    from evoflow.collab.subtask_outcome import get_subtask_execution_preview, get_subtask_task_report

    sub_rows: list[dict[str, Any]] = []
    failed_subtasks: list[dict[str, Any]] = []

    for st in subtasks:
        sid = str(st.get("id") or "")
        s_status = str(st.get("status") or "pending").strip().lower()
        s_err = st.get("error") or st.get("failed_at") or None

        wp = st.get("worker_profile")
        wp_dict = wp if isinstance(wp, dict) else None

        item: dict[str, Any] = {
            "subtaskId": sid,
            "status": s_status,
            "statusZh": _status_zh(s_status),
            "assignedTo": st.get("assigned_to") or "unassigned",
            "workerProfile": wp_dict,
            "workerProfileSummary": _subtask_worker_profile_suffix(st).replace(" | profile: ", ""),
        }

        # Planned tools from worker profile (runtime tool events live in execution_conversation).
        if isinstance(wp_dict, dict):
            raw_tools = wp_dict.get("tools") or []
            if isinstance(raw_tools, list):
                planned = [str(x) for x in raw_tools if str(x).strip()]
                if planned:
                    item["plannedTools"] = planned

        # Attach subtask official outcome (subtask_outcome_report), not task memory.
        tr = get_subtask_task_report(st if isinstance(st, dict) else {})
        if tr:
            item["task_report"] = tr
            item["result"] = tr
            item["summary"] = tr
        prev = get_subtask_execution_preview(st if isinstance(st, dict) else {}, main_task=main_task)
        if prev:
            item["conversation_snippet"] = prev

        if s_err and s_status in {"failed", "timed_out"}:
            item["error"] = s_err
            failed_subtasks.append(item)

        sub_rows.append(item)

    return sub_rows, failed_subtasks


__all__ = [
    "_subtask_worker_profile_suffix",
    "_subtask_row_dict",
    "_build_monitor_subtask_rows",
]
