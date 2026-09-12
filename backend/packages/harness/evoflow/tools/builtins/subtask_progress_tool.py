"""Worker tool: report subtask execution progress (0–100) during collab runs."""

from __future__ import annotations

import json
from typing import Annotated

from langchain.tools import InjectedToolCallId, ToolRuntime, tool
from langgraph.typing import ContextT

from evoflow.collab.task_progress import apply_subtask_progress_report
from evoflow.tools.builtins.subtask_work_checklist_tool import _resolve_collab_ids


@tool("subtask_progress_report", parse_docstring=True)
async def subtask_progress_report_tool(
    runtime: ToolRuntime[ContextT, dict],
    progress: int,
    tool_call_id: Annotated[str, InjectedToolCallId],
    main_task_id: str | None = None,
    subtask_id: str | None = None,
    current_step: str | None = None,
    status: str | None = None,
) -> str:
    """Report this subtask's execution progress (0–100) to collab storage for sidebar / workflow UI.

    **Call repeatedly while working** — chat text alone does not update progress bars or status lights.

    Args:
        progress: Integer 0–100 for **this subtask only** (monotonic increase recommended).
        main_task_id: Main collab task id (optional if runtime has ``collab_task_id``).
        subtask_id: Subtask id (optional if runtime has ``collab_subtask_id``).
        current_step: Short description of what you are doing now (shown to Lead / UI).
        status: Optional ``in_progress`` while running; terminal states use ``subtask_outcome_report``.
    """
    ctx_main, ctx_sub = _resolve_collab_ids(runtime)
    mid = str(main_task_id or ctx_main or "").strip()
    sid = str(subtask_id or ctx_sub or "").strip()
    if not mid or not sid:
        return json.dumps(
            {
                "ok": False,
                "error": "main_task_id and subtask_id are required (or collab_task_id/collab_subtask_id in runtime)",
            },
            ensure_ascii=False,
        )

    res = await apply_subtask_progress_report(
        main_task_id=mid,
        subtask_id=sid,
        progress=progress,
        current_step=current_step,
        status=status,
        reported_by="worker",
    )
    return json.dumps(res, ensure_ascii=False)
