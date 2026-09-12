"""Memory aggregation and SSE event broadcast helpers.

Provides:
- _persist_main_task_memory_snapshot — aggregate subtask memories into main-task memory
- _broadcast_task_event — best-effort SSE broadcast (channel = main task id)
- _record_supervisor_ui_step — persist compact supervisor step for EvoPanel sidebar
"""

from __future__ import annotations

import logging
import uuid

from langchain.tools import ToolRuntime
from langgraph.typing import ContextT

from evoflow.tools.builtins.supervisor.utils import _clamp_progress, _runtime_thread_id

logger = logging.getLogger(__name__)


def _persist_main_task_memory_snapshot(project: dict, task: dict) -> int:
    """Aggregate subtask memories into the main-task memory file."""
    from evoflow.collab.storage import get_task_detail_storage, task_memory_persistence_enabled
    from evoflow.timeutil import utc_now_iso_z

    if not task_memory_persistence_enabled():
        return 0
    mem_store = get_task_detail_storage()
    project_id = project.get("id")
    task_id = task.get("id")
    if not project_id or not task_id:
        return 0

    main_agent_id = task.get("assigned_to") or ""
    main_mem = mem_store.load_task_memory(project_id, main_agent_id, task_id)
    main_mem["task_id"] = task_id
    main_mem["main_task_id"] = task_id
    main_mem["agent_id"] = main_agent_id
    main_mem["status"] = task.get("status") or "pending"
    main_mem["progress"] = _clamp_progress(task.get("progress"))
    main_mem["current_step"] = "All subtasks completed" if (task.get("status") == "completed") else "Task in progress"

    aggregated_facts = []
    output_parts = []
    seen_fact_ids = set()
    for st in task.get("subtasks", []):
        st_id = st.get("id")
        if not st_id:
            continue
        st_agent_id = (st.get("assigned_to") or task.get("assigned_to") or "") or ""
        st_mem = mem_store.load_task_memory(project_id, st_agent_id, st_id)
        out = (st_mem.get("output_summary") or "").strip()
        if out:
            output_parts.append(f"[{st_id}] {out}")
        for fact in st_mem.get("facts", []) or []:
            fid = fact.get("id") or f"{st_id}:{fact.get('content', '')[:64]}"
            if fid in seen_fact_ids:
                continue
            seen_fact_ids.add(fid)
            aggregated_facts.append({**fact, "task_id": st_id})

    if output_parts:
        main_mem["output_summary"] = "\n".join(output_parts)[:8000]
    main_mem["facts"] = aggregated_facts
    if task.get("status") == "completed":
        now = utc_now_iso_z()
        main_mem["completed_at"] = now

    mem_store.save_task_memory(main_mem)
    return len(aggregated_facts)


async def _broadcast_task_event(main_task_id: str, event_type: str, data: dict) -> None:
    """Best-effort stream inject + WebSocket/SSE fan-out (``/api/events/ws/threads/{id}``)."""
    try:
        from evoflow.collab.sse_notify import broadcast_collab_task_event

        await broadcast_collab_task_event(main_task_id, event_type, data)
    except Exception:
        logger.debug("Failed to broadcast task event to runs/stream", exc_info=True)
    try:
        from evoflow.collab.ws_notify import broadcast_task_event

        await broadcast_task_event(main_task_id, event_type, dict(data))
    except Exception:
        logger.debug("Failed to broadcast task event to ws/sse", exc_info=True)


def _record_supervisor_ui_step(
    runtime: ToolRuntime[ContextT, dict] | None,
    tool_call_id: str,
    action: str,
    label: str,
) -> None:
    """Persist a compact supervisor step for EvoPanel task sidebar (best-effort)."""
    from evoflow.collab.thread_collab import append_sidebar_supervisor_step
    from evoflow.config.paths import get_paths

    tid = _runtime_thread_id(runtime)
    if not tid:
        return
    try:
        sid = (tool_call_id or "").strip()
        step_id = sid if sid else str(uuid.uuid4())
        append_sidebar_supervisor_step(
            get_paths(),
            tid,
            {"id": step_id, "action": action, "label": label, "done": True},
        )
    except Exception:
        logger.debug("append sidebar supervisor step failed", exc_info=True)


__all__ = [
    "_persist_main_task_memory_snapshot",
    "_broadcast_task_event",
    "_record_supervisor_ui_step",
]
