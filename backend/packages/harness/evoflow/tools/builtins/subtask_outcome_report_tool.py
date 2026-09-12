"""Worker tool: mandatory terminal status + task report for collaboration subtasks."""

from __future__ import annotations

import json
from typing import Annotated, Any

from langchain.tools import InjectedToolCallId, ToolRuntime, tool
from langgraph.typing import ContextT

from evoflow.collab.subtask_outcome import apply_subtask_outcome_report
from evoflow.tools.builtins.subtask_work_checklist_tool import _resolve_collab_ids


@tool("subtask_outcome_report", parse_docstring=True)
async def subtask_outcome_report_tool(
    runtime: ToolRuntime[ContextT, dict],
    outcome: str,
    summary: str,
    tool_call_id: Annotated[str, InjectedToolCallId],
    main_task_id: str | None = None,
    subtask_id: str | None = None,
    error: str | None = None,
    evidence_paths: Any = None,
    outputs: Any = None,
    structured_output: Any = None,
) -> str:
    """Report final subtask outcome (success / failure / blocked / cancelled) to the collab task store.

    **You must call this once before ending your turn.** Chat text alone does not update the sidebar.

    Args:
        outcome: ``completed`` | ``failed`` | ``blocked`` | ``cancelled`` (aliases: done, fail, cancel).
        summary: Subtask completion report for Lead/collab sidebar (not agent memory - required).
        main_task_id: Main task id (optional if runtime has ``collab_task_id``).
        subtask_id: Subtask id (optional if runtime has ``collab_subtask_id``).
        error: Failure reason (recommended when outcome is failed/blocked).
        evidence_paths: Optional list of output file paths (legacy; prefer ``outputs``).
        outputs: Optional structured deliverables
            ``[{type,key,value,label?}]`` where type is ``file|url|text|other``.
        structured_output: Optional JSON object or JSON string conforming to the step's
            ``output_schema``. If provided, validated and stored as the step's
            structured output for downstream ``input_bindings`` resolution.
            If not provided, the system will attempt to extract JSON from the summary.
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

    paths: list[str] | None = None
    if evidence_paths is not None:
        if isinstance(evidence_paths, list):
            paths = [str(x).strip() for x in evidence_paths if str(x).strip()]
        elif isinstance(evidence_paths, str) and evidence_paths.strip():
            paths = [evidence_paths.strip()]

    res = await apply_subtask_outcome_report(
        main_task_id=mid,
        subtask_id=sid,
        outcome=outcome,
        summary=summary,
        error=error,
        evidence_paths=paths,
        outputs=outputs,
        structured_output=structured_output,
        reported_by="worker",
        followup_runtime=runtime,
        tool_call_id=str(tool_call_id or "").strip() or None,
    )
    return json.dumps(res, ensure_ascii=False)
