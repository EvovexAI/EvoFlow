"""Worker tool: progress bar — registered name ``progress``."""

from __future__ import annotations

import json
from typing import Annotated

from langchain.tools import InjectedToolCallId, ToolRuntime, tool
from langgraph.typing import ContextT

from evoflow.collab.collab_tool_names import PROGRESS
from evoflow.collab.task_progress import apply_subtask_progress_report
from evoflow.tools.builtins.subtask_work_checklist_tool import _resolve_collab_ids


@tool(PROGRESS, parse_docstring=True)
async def progress_tool(
    runtime: ToolRuntime[ContextT, dict],
    progress: int,
    tool_call_id: Annotated[str, InjectedToolCallId],
    main_task_id: str | None = None,
    subtask_id: str | None = None,
    current_step: str | None = None,
    status: str | None = None,
) -> str:
    """Update this subtask's progress bar (0–100). Call while working.

    Args:
        progress: Integer 0–100 for this subtask.
        main_task_id: Optional if runtime has collab ids.
        subtask_id: Optional if runtime has collab ids.
        current_step: Short what-you-are-doing now.
        status: Optional ``in_progress``; finish with ``done``.
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
