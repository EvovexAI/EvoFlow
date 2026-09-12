"""Task detail API router for managing agent task details and facts."""

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from app.gateway.routers.events import emit_task_memory_updated, emit_task_progress
from evoflow.authz.http_guard import require_agent_visible, require_task_visible
from evoflow.collab.storage import (
    get_agent_runtime_storage,
    get_project_storage,
    get_task_detail_storage,
)
from evoflow.timeutil import utc_now_iso_z

router = APIRouter(prefix="/api/task-detail", tags=["task-detail"])

UNASSIGNED_AGENT_ID = "__unassigned__"


def _aggregate_main_task_memory(main_task_id: str, task: dict, memory_storage) -> dict:
    """Build/refresh main-task detail snapshot from subtask details."""
    task_id = task.get("id") or ""
    agent_id = task.get("assigned_to") or UNASSIGNED_AGENT_ID
    memory = memory_storage.load_task_memory(main_task_id, agent_id, task_id)

    facts = []
    summary_parts = []
    seen = set()
    subtasks = task.get("subtasks") or []
    for st in subtasks:
        st_id = st.get("id")
        if not st_id:
            continue
        st_agent = st.get("assigned_to") or task.get("assigned_to") or UNASSIGNED_AGENT_ID
        st_mem = memory_storage.load_task_memory(main_task_id, st_agent, st_id)
        for fact in st_mem.get("facts", []) or []:
            fid = fact.get("id") or f"{st_id}:{fact.get('content', '')[:64]}"
            if fid in seen:
                continue
            seen.add(fid)
            facts.append({**fact, "task_id": st_id})
        from evoflow.collab.subtask_outcome import get_subtask_task_report

        out = get_subtask_task_report(st if isinstance(st, dict) else {})
        if out:
            summary_parts.append(f"[{st_id}] {out}")

    main_row_status = str(task.get("status") or "").strip().lower() or "pending"
    terminal_main = {"completed", "failed", "cancelled"}
    all_subs_completed = bool(subtasks) and all(str(st.get("status") or "").strip().lower() == "completed" for st in subtasks)
    main_disk_progress = int(task.get("progress") or 0)

    if main_row_status in terminal_main:
        status = main_row_status
        progress = main_disk_progress
        current_step = str(memory.get("current_step") or "").strip() or ("All subtasks completed" if main_row_status == "completed" else memory.get("current_step") or "")
    elif all_subs_completed:
        # Do not infer main-task terminal status from subtasks; mirror the persisted main row.
        status = main_row_status if main_row_status not in {"", "pending"} else "executing"
        progress = main_disk_progress
        current_step = "All subtasks completed (close main task via supervisor when ready)"
    elif any((st.get("progress") or 0) > 0 for st in subtasks):
        status = "executing"
        progress = main_disk_progress
        current_step = "Subtasks in progress"
    else:
        status = memory.get("status") or "pending"
        progress = main_disk_progress
        current_step = memory.get("current_step") or ""

    memory["task_id"] = task_id
    memory["main_task_id"] = main_task_id
    memory["agent_id"] = agent_id
    memory["status"] = status
    memory["progress"] = progress
    memory["current_step"] = current_step
    memory["facts"] = facts
    if summary_parts:
        memory["output_summary"] = "\n".join(summary_parts)[:8000]
    memory.setdefault("created_at", utc_now_iso_z())
    if status == "completed":
        memory["completed_at"] = memory.get("completed_at") or utc_now_iso_z()
    memory_storage.save_task_memory(memory)
    return memory


class TaskMemoryResponse(BaseModel):
    """Response model for task memory."""

    task_id: str
    agent_id: str
    status: str
    facts: list[dict]
    output_summary: str
    current_step: str
    progress: int
    created_at: str
    updated_at: str
    completed_at: str | None = None
    parent_task_id: str | None = Field(default=None, description="Set when task_id is a subtask in subtasks[]")
    is_subtask: bool = Field(default=False, description="True when resolving a subtask id")


class AddFactRequest(BaseModel):
    """Request model for adding a fact."""

    content: str = Field(default="", description="Fact content")
    category: str = Field(default="finding", description="Fact category")
    confidence: float = Field(default=0.5, description="Confidence score (0-1)")
    source_message: str | None = Field(default=None, description="Source message ID")


class UpdateProgressRequest(BaseModel):
    """Request model for updating task progress."""

    progress: int = Field(default=0, description="Progress 0-100")
    current_step: str = Field(default="", description="Current step description")


class AgentMemoryResponse(BaseModel):
    """Response model for agent memory."""

    agent_id: str
    agent_name: str
    main_task_id: str
    tasks: list[dict]
    total_tasks: int
    completed_tasks: int


class ProjectFactsResponse(BaseModel):
    """Response model for main task facts."""

    main_task_id: str
    facts: list[dict]
    total: int


class ProjectStatusResponse(BaseModel):
    """Response model for main task runtime status."""

    main_task_id: str
    agents: list[dict]
    tasks: list[dict]


@router.get(
    "/tasks/{task_id}",
    response_model=TaskMemoryResponse,
    summary="Get Task Memory",
    description="Get memory for a main task id or a subtask id (matched in subtasks[]).",
)
async def get_task_memory(http_request: Request, task_id: str) -> TaskMemoryResponse:
    """Get task memory by main task ID or subtask ID."""
    require_task_visible(http_request, task_id)
    projects_storage = get_project_storage()
    memory_storage = get_task_detail_storage()

    # NOTE:
    # Some main tasks may not have `assigned_to` yet (agent_id="").
    # For those cases we still want GET/PUT progress & facts to work
    # consistently by reading/writing under a stable sentinel agent_id.
    bundles = projects_storage.list_projects()
    for bundle in bundles:
        main_task_id = str(bundle.get("id") or "").strip()
        project = projects_storage.load_project(main_task_id)
        if not project:
            continue

        for task in project.get("tasks", []):
            # Main task match
            if task.get("id") == task_id:
                agent_id = task.get("assigned_to") or UNASSIGNED_AGENT_ID
                memory = memory_storage.load_task_memory(task_id, agent_id, task_id)
                if task.get("subtasks"):
                    memory = _aggregate_main_task_memory(task_id, task, memory_storage)
                return TaskMemoryResponse(
                    task_id=memory.get("task_id", task_id),
                    agent_id=memory.get("agent_id", agent_id),
                    status=memory.get("status", "unknown"),
                    facts=memory.get("facts", []),
                    output_summary=memory.get("output_summary", ""),
                    current_step=memory.get("current_step", ""),
                    progress=memory.get("progress", 0),
                    created_at=memory.get("created_at", ""),
                    updated_at=memory.get("updated_at", ""),
                    completed_at=memory.get("completed_at"),
                    parent_task_id=None,
                    is_subtask=False,
                )

            # Subtask match
            parent_main_task_id = task.get("id")
            for st in task.get("subtasks") or []:
                if st.get("id") != task_id:
                    continue
                agent_id = st.get("assigned_to") or task.get("assigned_to") or UNASSIGNED_AGENT_ID
                memory = memory_storage.load_task_memory(str(parent_main_task_id), agent_id, task_id)
                # Fallback: subtask row in project storage can already contain terminal
                # status/result while task-memory file is still empty or lagging.
                sub_status = str(st.get("status") or "").strip()
                sub_progress_raw = st.get("progress")
                try:
                    sub_progress = int(sub_progress_raw) if sub_progress_raw is not None else None
                except (TypeError, ValueError):
                    sub_progress = None
                sub_error = str(st.get("error") or "").strip()

                mem_status = str(memory.get("status") or "").strip()
                mem_summary = str(memory.get("output_summary") or "").strip()
                mem_step = str(memory.get("current_step") or "").strip()
                mem_progress = memory.get("progress")

                if (not mem_status or mem_status == "pending") and sub_status:
                    memory["status"] = sub_status
                if (mem_progress is None or int(mem_progress or 0) <= 0) and sub_progress is not None:
                    memory["progress"] = sub_progress
                if not mem_summary:
                    from evoflow.collab.subtask_outcome import get_subtask_task_report

                    report = get_subtask_task_report(st)
                    if report:
                        memory["output_summary"] = report
                    elif sub_error and not str(st.get("outcome_reported_at") or "").strip():
                        memory["output_summary"] = sub_error
                if not mem_step and sub_status:
                    memory["current_step"] = f"Subtask {sub_status}"
                # Write-through: once fallback is applied, persist to avoid
                # repeatedly reconstructing on every read.
                memory_storage.save_task_memory(memory)

                return TaskMemoryResponse(
                    task_id=memory.get("task_id", task_id),
                    agent_id=memory.get("agent_id", agent_id),
                    status=memory.get("status", "unknown"),
                    facts=memory.get("facts", []),
                    output_summary=memory.get("output_summary", ""),
                    current_step=memory.get("current_step", ""),
                    progress=memory.get("progress", 0),
                    created_at=memory.get("created_at", ""),
                    updated_at=memory.get("updated_at", ""),
                    completed_at=memory.get("completed_at"),
                    parent_task_id=parent_main_task_id,
                    is_subtask=True,
                )

    raise HTTPException(status_code=404, detail=f"Task memory for '{task_id}' not found")


@router.post("/tasks/{task_id}/facts", response_model=dict, summary="Add Task Fact", description="Add a fact to task memory.")
async def add_task_fact(http_request: Request, task_id: str, body: AddFactRequest) -> dict:
    require_task_visible(http_request, task_id)
    """Add a fact to task memory."""
    projects_storage = get_project_storage()
    memory_storage = get_task_detail_storage()
    bundles = projects_storage.list_projects()

    for bundle in bundles:
        main_task_id = str(bundle.get("id") or "").strip()
        project = projects_storage.load_project(main_task_id)
        if project:
            for task in project.get("tasks", []):
                if task.get("id") == task_id:
                    agent_id = task.get("assigned_to") or UNASSIGNED_AGENT_ID
                    memory = memory_storage.load_task_memory(task_id, agent_id, task_id)

                    fact = {
                        "id": f"fact_{utc_now_iso_z()}",
                        "content": body.content,
                        "category": request.category,
                        "confidence": body.confidence,
                        "source_message": body.source_message,
                    }

                    memory.setdefault("facts", []).append(fact)
                    memory_storage.save_task_memory(memory)

                    memory_storage.add_fact_to_project(task_id, fact)

                    await emit_task_memory_updated(task_id, task_id, len(memory.get("facts", [])))

                    return {"success": True, "fact": fact}

    raise HTTPException(status_code=404, detail=f"Task '{task_id}' not found")


@router.put("/tasks/{task_id}/progress", response_model=dict, summary="Update Task Progress", description="Update task progress and current step.")
async def update_task_progress(http_request: Request, task_id: str, body: UpdateProgressRequest) -> dict:
    require_task_visible(http_request, task_id)
    """Update task progress."""
    projects_storage = get_project_storage()
    memory_storage = get_task_detail_storage()
    bundles = projects_storage.list_projects()

    for bundle in bundles:
        main_task_id = str(bundle.get("id") or "").strip()
        project = projects_storage.load_project(main_task_id)
        if project:
            for task in project.get("tasks", []):
                if task.get("id") == task_id:
                    agent_id = task.get("assigned_to") or UNASSIGNED_AGENT_ID
                    memory = memory_storage.load_task_memory(task_id, agent_id, task_id)

                    memory["progress"] = body.progress
                    memory["current_step"] = body.current_step
                    memory["updated_at"] = utc_now_iso_z()

                    memory_storage.save_task_memory(memory)

                    task["progress"] = body.progress
                    projects_storage.save_project(project)

                    await emit_task_progress(task_id, task_id, body.progress, body.current_step)
                    await emit_task_memory_updated(task_id, task_id, len(memory.get("facts", [])))

                    return {"success": True, "progress": body.progress, "current_step": body.current_step}

    raise HTTPException(status_code=404, detail=f"Task '{task_id}' not found")


@router.get("/agents/{agent_id}", response_model=list[AgentMemoryResponse], summary="Get Agent Memories", description="Get all task memories for an agent.")
async def get_agent_memories(http_request: Request, agent_id: str) -> list[AgentMemoryResponse]:
    """Get all task memories for an agent."""
    require_agent_visible(http_request, agent_id)
    projects_storage = get_project_storage()
    memory_storage = get_task_detail_storage()
    runtime_storage = get_agent_runtime_storage()
    bundles = projects_storage.list_projects()

    result = []

    for bundle in bundles:
        main_task_id = str(bundle.get("id") or "").strip()
        project = projects_storage.load_project(main_task_id)
        if project:
            project_tasks = []
            completed_count = 0

            for task in project.get("tasks", []):
                if task.get("assigned_to") == agent_id:
                    memory = memory_storage.load_task_memory(str(task.get("id") or ""), agent_id, str(task.get("id") or ""))
                    project_tasks.append(
                        {
                            "task": task,
                            "memory": memory,
                        }
                    )
                    if task.get("status") == "completed":
                        completed_count += 1

            if project_tasks:
                agent_info = runtime_storage.get_agent(agent_id) or {}
                result.append(
                    AgentMemoryResponse(
                        agent_id=agent_id,
                        agent_name=agent_info.get("agent_name", agent_id),
                        main_task_id=main_task_id,
                        tasks=project_tasks,
                        total_tasks=len(project_tasks),
                        completed_tasks=completed_count,
                    )
                )

    return result


@router.get("/tasks/{main_task_id}/facts", response_model=ProjectFactsResponse, summary="Get Task Facts", description="Get all facts for a main task.")
async def get_project_facts(http_request: Request, main_task_id: str) -> ProjectFactsResponse:
    """Get all facts for a main task."""
    require_task_visible(http_request, main_task_id)
    memory_storage = get_task_detail_storage()
    facts_data = memory_storage.load_project_facts(main_task_id)

    return ProjectFactsResponse(
        main_task_id=main_task_id,
        facts=facts_data.get("facts", []),
        total=len(facts_data.get("facts", [])),
    )


@router.get("/tasks/{main_task_id}/status", response_model=ProjectStatusResponse, summary="Get Task Runtime Status", description="Get runtime status of all agents and tasks in a main task.")
async def get_project_status(http_request: Request, main_task_id: str) -> ProjectStatusResponse:
    """Get main task runtime status."""
    require_task_visible(http_request, main_task_id)
    projects_storage = get_project_storage()
    memory_storage = get_task_detail_storage()
    runtime_storage = get_agent_runtime_storage()

    project = projects_storage.load_project(main_task_id)
    if project is None:
        raise HTTPException(status_code=404, detail=f"Task '{main_task_id}' not found")

    agents = []
    task_map = {}

    for task in project.get("tasks", []):
        task_map[task["id"]] = task
        if task.get("assigned_to"):
            agent_id = task["assigned_to"]
            agent_info = runtime_storage.get_agent(agent_id) or {}
            memory = memory_storage.load_task_memory(main_task_id, agent_id, task["id"])

            agent_found = False
            for a in agents:
                if a["agent_id"] == agent_id:
                    break

            if not agent_found:
                agents.append(
                    {
                        "agent_id": agent_id,
                        "agent_name": agent_info.get("agent_name", agent_id),
                        "status": agent_info.get("status", "idle"),
                        "current_task_id": task["id"],
                        "progress": memory.get("progress", 0),
                        "last_heartbeat": agent_info.get("last_heartbeat"),
                    }
                )

    return ProjectStatusResponse(
        main_task_id=main_task_id,
        agents=agents,
        tasks=[task_map[t["id"]] for t in project.get("tasks", [])],
    )


@router.get("/tasks/{main_task_id}/search", response_model=dict, summary="Search Task Facts", description="Search facts across all agents in a main task.")
async def search_project_facts(http_request: Request, main_task_id: str, keyword: str = "") -> dict:
    """Search facts in a main task."""
    require_task_visible(http_request, main_task_id)
    if not keyword:
        return {"results": [], "total": 0}

    memory_storage = get_task_detail_storage()
    facts_data = memory_storage.load_project_facts(main_task_id)

    results = []
    for fact in facts_data.get("facts", []):
        if keyword.lower() in fact.get("content", "").lower():
            results.append(fact)

    return {
        "results": results,
        "total": len(results),
        "keyword": keyword,
    }
