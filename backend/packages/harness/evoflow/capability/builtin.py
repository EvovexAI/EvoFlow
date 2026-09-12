"""Built-in EvoFlow capabilities registered into the CapabilityRegistry.

Each capability mirrors the logic of the corresponding gateway router but is
exposed as an MCP tool via the :func:`capability` decorator. Handlers use
**lazy imports** (inside the function body) so that importing this module never
triggers heavy service initialization — the registry can be built (and
``tools/list`` answered) even when the backing services are not yet ready.

Registered capabilities (7):

* ``evo_list_sessions``  (session,  Read)  — full-text session search.
* ``evo_create_task``    (task,    Write)  — create a root task bundle.
* ``evo_list_tasks``     (task,    Read)   — list/filter tasks across projects.
* ``evo_get_memory``     (memory,  Read)   — read global or per-agent memory.
* ``evo_list_skills``    (skill,   Read)   — list installed skills.
* ``evo_list_agents``    (agent,   Read)   — list configured agents.
* ``evo_list_models``    (model,   Read)   — list configured AI models.

Call :func:`register_builtin_capabilities` from ``app.py`` lifespan to populate
the global registry.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from pydantic import BaseModel, Field

from .registry import capability, get_registry
from .models import CallerCtx, DangerTier, Surface

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------


class ListSessionsRequest(BaseModel):
    """Search conversation sessions via FTS5."""

    query: str = Field(..., description="Search query string")
    limit: int = Field(default=10, ge=1, le=100, description="Maximum number of results")
    offset: int = Field(default=0, ge=0, description="Offset for pagination")
    assistant_id: Optional[str] = Field(default=None, description="Filter by assistant ID")
    date_from: Optional[str] = Field(default=None, description="Filter by date range start (ISO)")
    date_to: Optional[str] = Field(default=None, description="Filter by date range end (ISO)")
    search_in: str = Field(default="all", description="Where to search: 'user', 'assistant', or 'all'")


class CreateTaskRequest(BaseModel):
    """Create a new root task (same bundle shape as the gateway create_task)."""

    name: str = Field(default="", description="Task name")
    description: str = Field(default="", description="Task description")
    thread_id: Optional[str] = Field(default=None, description="Bind a LangGraph thread to this task")
    run_mode: str = Field(
        default="manual",
        description="unattended = zero-touch queue (auto plan/authorize/dispatch); manual = legacy UI flow",
    )
    model_name: Optional[str] = Field(default=None, description="Session model name pinned at creation for subagent delegation")


class ListTasksRequest(BaseModel):
    """List/filter tasks across all projects."""

    status: Optional[str] = Field(default=None, description="Filter by status: pending|executing|paused|completed|failed|cancelled")
    source: Optional[str] = Field(default=None, description="Filter by 任务来源: chat|workflow|role")
    search: Optional[str] = Field(default=None, description="Search in task name")
    project_id: Optional[str] = Field(default=None, description="Filter by project ID")
    sort: str = Field(default="updated_at", description="Sort field: created_at|updated_at|status|name")
    order: str = Field(default="desc", description="Sort order: asc|desc")


class GetMemoryRequest(BaseModel):
    """Read memory data for the global store or a specific agent."""

    agent: Optional[str] = Field(default=None, description="Agent id; omit for global memory")


class ListSkillsRequest(BaseModel):
    """List all installed skills (public + custom)."""

    enabled_only: bool = Field(default=False, description="Only return enabled skills")


class ListAgentsRequest(BaseModel):
    """List configured agents (main + custom)."""

    tag: Optional[str] = Field(default=None, description="Filter by tag label (substring match)")
    preset_only: bool = Field(default=False, description="Only main + custom preset roles")
    assignable_only: bool = Field(default=False, description="Only subagent/acp/claude-code workers")


class ListModelsRequest(BaseModel):
    """List all configured AI models (sensitive fields masked)."""

    # No parameters — kept as a model so the schema is a proper object form.
    pass


# ---------------------------------------------------------------------------
# Handlers
# ---------------------------------------------------------------------------


@capability(
    name="evo_list_sessions",
    domain="session",
    danger=DangerTier.Read,
    summary="Search conversation sessions using full-text search (FTS5).",
)
def evo_list_sessions(ctx: CallerCtx, p: ListSessionsRequest) -> dict:
    """List/search conversation sessions.

    Mirrors ``routers/sessions.py::search_sessions``.
    """
    try:
        from evoflow.agents.checkpointer.session_search import get_session_search

        search = get_session_search()
        results = search.search(
            query=p.query,
            limit=p.limit,
            offset=p.offset,
            assistant_id=p.assistant_id,
            date_from=p.date_from,
            date_to=p.date_to,
            search_in=p.search_in,
        )
        total = search.get_session_count(
            assistant_id=p.assistant_id,
            date_from=p.date_from,
            date_to=p.date_to,
        )
        return {
            "success": True,
            "results": results,
            "total": total,
            "query": p.query,
            "limit": p.limit,
            "offset": p.offset,
        }
    except Exception as e:  # noqa: BLE001 — surface structured error to the agent
        logger.error("evo_list_sessions failed: %s", e, exc_info=True)
        return {"error": f"搜索会话失败: {e}"}


@capability(
    name="evo_create_task",
    domain="task",
    danger=DangerTier.Write,
    summary="Create a new root task (manual or unattended queue mode).",
)
def evo_create_task(ctx: CallerCtx, p: CreateTaskRequest) -> dict:
    """Create a new task.

    Mirrors ``routers/tasks.py::create_task``.
    """
    try:
        from evoflow.collab.storage import (
            get_project_storage,
            new_project_bundle_root_task,
        )
        from evoflow.timeutil import utc_now_iso_z

        storage = get_project_storage()
        project_data, task = new_project_bundle_root_task(
            p.name,
            p.description,
            thread_id=p.thread_id,
            session_model_name=p.model_name,
        )
        run_mode = str(p.run_mode or "manual").strip().lower()
        if run_mode not in ("unattended", "manual"):
            run_mode = "manual"
        now = utc_now_iso_z()
        task["run_mode"] = run_mode
        from evoflow.collab.task_source import (
            TASK_SOURCE_WORKFLOW,
            resolve_write_source,
        )

        raw_src = TASK_SOURCE_WORKFLOW
        src, channel = resolve_write_source(raw_src, default=raw_src)
        task["source"] = src
        if channel:
            task["source_channel"] = channel
        if run_mode == "unattended":
            task["unattended_stage"] = "queued"
            task["unattended_enqueued_at"] = now
            task["unattended_attempts"] = 0

        if storage.save_project(project_data):
            out = dict(task)
            if run_mode == "unattended":
                out["queue_hint"] = (
                    "Task enqueued for unattended execution; Gateway task queue will pick it up."
                )
            return {"success": True, "task": out}
        return {"error": "任务创建失败"}
    except Exception as e:  # noqa: BLE001
        logger.error("evo_create_task failed: %s", e, exc_info=True)
        return {"error": f"创建任务失败: {e}"}


@capability(
    name="evo_list_tasks",
    domain="task",
    danger=DangerTier.Read,
    summary="List and filter tasks across all projects.",
)
def evo_list_tasks(ctx: CallerCtx, p: ListTasksRequest) -> dict:
    """List tasks with optional filtering and sorting.

    Mirrors ``routers/tasks.py::list_tasks`` (without the thread_id fast-path,
    which is a UI-specific optimization).
    """
    try:
        from evoflow.collab.storage import get_project_storage

        storage = get_project_storage()
        projects = storage.list_projects()

        all_tasks: list[dict] = []
        for project_summary in projects:
            if p.project_id and project_summary["id"] != p.project_id:
                continue
            project = storage.load_project(project_summary["id"])
            if not project:
                continue
            for task in project.get("tasks", []):
                if p.status and task.get("status") != p.status:
                    continue
                if p.source:
                    from evoflow.collab.task_source import sources_equal

                    if not sources_equal(task.get("source"), p.source):
                        continue
                if p.search:
                    name = task.get("name", "").lower()
                    tid = task.get("id", "").lower()
                    if p.search.lower() not in name and p.search.lower() not in tid:
                        continue
                all_tasks.append(dict(task))

        reverse = (p.order or "desc").lower() == "desc"
        sort_field = p.sort or "updated_at"
        if sort_field == "name":
            all_tasks.sort(key=lambda x: x.get("name", "").lower(), reverse=reverse)
        elif sort_field == "status":
            all_tasks.sort(key=lambda x: x.get("status", ""), reverse=reverse)
        elif sort_field == "created_at":
            all_tasks.sort(key=lambda x: x.get("created_at", ""), reverse=reverse)
        else:
            all_tasks.sort(
                key=lambda x: x.get("updated_at", x.get("created_at", "")),
                reverse=reverse,
            )

        return {
            "success": True,
            "tasks": all_tasks,
            "total": len(all_tasks),
        }
    except Exception as e:  # noqa: BLE001
        logger.error("evo_list_tasks failed: %s", e, exc_info=True)
        return {"error": f"获取任务列表失败: {e}"}


@capability(
    name="evo_get_memory",
    domain="memory",
    danger=DangerTier.Read,
    summary="Read memory data (global store or a specific agent scope).",
)
def evo_get_memory(ctx: CallerCtx, p: GetMemoryRequest) -> dict:
    """Get the current memory data.

    Mirrors ``routers/memory.py::get_memory``.
    """
    try:
        from evoflow.agents.memory.updater import get_memory_data

        agent_name: Optional[str] = None
        if p.agent is not None:
            stripped = p.agent.strip()
            if stripped:
                agent_name = stripped
        memory_data = get_memory_data(agent_name)
        return {"success": True, "memory": memory_data}
    except Exception as e:  # noqa: BLE001
        logger.error("evo_get_memory failed: %s", e, exc_info=True)
        return {"error": f"获取记忆失败: {e}"}


@capability(
    name="evo_list_skills",
    domain="skill",
    danger=DangerTier.Read,
    summary="List all installed skills (public and custom).",
)
def evo_list_skills(ctx: CallerCtx, p: ListSkillsRequest) -> dict:
    """List all available skills.

    Mirrors ``routers/skills.py::list_skills``.
    """
    try:
        from evoflow.skills import load_skills

        skills = load_skills(enabled_only=p.enabled_only)
        return {
            "success": True,
            "skills": [
                {
                    "name": s.name,
                    "description": s.description,
                    "license": s.license,
                    "category": s.category,
                    "enabled": s.enabled,
                }
                for s in skills
            ],
        }
    except Exception as e:  # noqa: BLE001
        logger.error("evo_list_skills failed: %s", e, exc_info=True)
        return {"error": f"获取技能列表失败: {e}"}


@capability(
    name="evo_list_agents",
    domain="agent",
    danger=DangerTier.Read,
    summary="List configured agents (main + custom), with optional tag/preset filters.",
)
def evo_list_agents(ctx: CallerCtx, p: ListAgentsRequest) -> dict:
    """List all configured agents.

    Mirrors ``routers/agents.py::list_agents`` (returns a simplified projection
    suitable for an LLM tool — no soul/system_prompt content).
    """
    try:
        from evoflow.config.agents_config import list_custom_agents

        agents: list[dict] = []

        # Main (default) agent first.
        try:
            from evoflow.config.agents_config import load_agent_config

            main_cfg = load_agent_config("main")
            main_tags: list[str] = []
            agents.append(
                {
                    "agent_code": "main",
                    "agent_name": main_cfg.agent_name or main_cfg.name or "main",
                    "description": main_cfg.description or "",
                    "agent_type": main_cfg.agent_type or "main",
                    "tags": main_tags,
                    "model": main_cfg.model,
                }
            )
        except Exception:  # noqa: BLE001 — main agent optional/missing
            agents.append(
                {
                    "agent_code": "main",
                    "agent_name": "main",
                    "description": "",
                    "agent_type": "main",
                    "tags": [],
                    "model": None,
                }
            )

        tag_filter = str(p.tag or "").strip()
        for a in list_custom_agents():
            agent_tags = list(a.tags or [])
            if tag_filter and not any(tag_filter in (t or "") for t in agent_tags):
                continue
            if p.preset_only and a.agent_type not in ("main", "preset"):
                continue
            if p.assignable_only and a.agent_type not in ("subagent", "acp", "claude-code"):
                continue
            agents.append(
                {
                    "agent_code": a.agent_code or a.name or "",
                    "agent_name": a.agent_name or a.name or "",
                    "description": a.description or "",
                    "agent_type": a.agent_type or "custom",
                    "tags": agent_tags,
                    "model": a.model,
                }
            )

        return {"success": True, "agents": agents, "total": len(agents)}
    except Exception as e:  # noqa: BLE001
        logger.error("evo_list_agents failed: %s", e, exc_info=True)
        return {"error": f"获取 Agent 列表失败: {e}"}


@capability(
    name="evo_list_models",
    domain="model",
    danger=DangerTier.Read,
    summary="List all configured AI models (sensitive fields masked).",
)
def evo_list_models(ctx: CallerCtx, p: ListModelsRequest) -> dict:
    """List all available models from configuration.

    Mirrors ``routers/models.py::list_models``.
    """
    try:
        from evoflow.config import get_app_config

        config = get_app_config()
        models = []
        for model in config.models:
            models.append(
                {
                    "name": model.name,
                    "vendor": getattr(model, "vendor", None),
                    "model": model.model,
                    "display_name": model.display_name,
                    "description": model.description,
                    "use": model.use,
                    "supports_thinking": model.supports_thinking,
                    "supports_reasoning_effort": model.supports_reasoning_effort,
                    "supports_vision": getattr(model, "supports_vision", False),
                }
            )
        return {"success": True, "models": models, "total": len(models)}
    except Exception as e:  # noqa: BLE001
        logger.error("evo_list_models failed: %s", e, exc_info=True)
        return {"error": f"获取模型列表失败: {e}"}


# ---------------------------------------------------------------------------
# Registration entry point
# ---------------------------------------------------------------------------

# Names of all capabilities registered by this module (for diagnostics/tests).
BUILTIN_CAPABILITY_NAMES: tuple[str, ...] = (
    "evo_list_sessions",
    "evo_create_task",
    "evo_list_tasks",
    "evo_get_memory",
    "evo_list_skills",
    "evo_list_agents",
    "evo_list_models",
)


def register_builtin_capabilities() -> list[str]:
    """Ensure all built-in capabilities are registered in the global registry.

    The ``@capability`` decorator already registers each capability at import
    time into the process-wide singleton from :func:`get_registry`. This function
    is idempotent: it is safe to call from ``app.py`` lifespan even if the module
    was already imported (e.g. by the bridge). It returns the list of registered
    capability names.

    Returns:
        The names of the built-in capabilities now present in the registry.
    """
    registry = get_registry()
    registered: list[str] = []
    for name in BUILTIN_CAPABILITY_NAMES:
        if registry.get(name) is not None:
            registered.append(name)
    logger.info(
        "register_builtin_capabilities: %d/%d capabilities present in registry",
        len(registered),
        len(BUILTIN_CAPABILITY_NAMES),
    )
    return registered
