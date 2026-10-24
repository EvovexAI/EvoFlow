"""Worker tool: terminal outcome — short name ``done`` (legacy ``subtask_outcome_report``)."""

from __future__ import annotations

import json
from typing import Annotated, Any

from langchain.tools import InjectedToolCallId, ToolRuntime, tool
from langgraph.typing import ContextT

from evoflow.collab.collab_tool_names import DONE
from evoflow.collab.subtask_outcome import apply_subtask_outcome_report
from evoflow.tools.builtins.subtask_work_checklist_tool import _resolve_collab_ids


async def _apply_done(
    runtime: ToolRuntime[ContextT, dict],
    outcome: str,
    summary: str,
    tool_call_id: str,
    main_task_id: str | None,
    subtask_id: str | None,
    error: str | None,
    evidence_paths: Any,
    outputs: Any,
    structured_output: Any,
) -> str:
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


@tool(DONE, parse_docstring=True)
async def done_tool(
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
    """Finish this subtask (required once before ending).

    Args:
        outcome: ``completed`` | ``failed`` | ``blocked`` | ``cancelled`` (aliases: done, fail, cancel).
        summary: Short result for Lead / downstream (required).
        main_task_id: Optional if runtime has collab ids.
        subtask_id: Optional if runtime has collab ids.
        error: Failure reason when failed/blocked.
        evidence_paths: Optional file paths (prefer ``outputs``).
        outputs: Optional ``[{type,key,value,label?}]``.
        structured_output: Optional JSON for step ``output_schema``.
    """
    return await _apply_done(
        runtime,
        outcome,
        summary,
        tool_call_id,
        main_task_id,
        subtask_id,
        error,
        evidence_paths,
        outputs,
        structured_output,
    )


@tool("subtask_outcome_report", description="Alias of done (legacy). Prefer done.")
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
    return await _apply_done(
        runtime,
        outcome,
        summary,
        tool_call_id,
        main_task_id,
        subtask_id,
        error,
        evidence_paths,
        outputs,
        structured_output,
    )
