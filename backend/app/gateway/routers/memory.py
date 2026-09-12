"""Memory API router for retrieving and managing global memory data."""

import logging

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from evoflow.agents.memory.updater import (
    clear_memory_data,
    delete_memory_fact,
    get_memory_data,
    list_memory_agent_slots,
    reload_memory_data,
)
from evoflow.config.agents_config import AGENT_NAME_PATTERN
from evoflow.config.memory_config import get_memory_config

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["memory"])


class ContextSection(BaseModel):
    """Model for context sections (user and history)."""

    summary: str = Field(default="", description="Summary content")
    updatedAt: str = Field(default="", description="Last update timestamp")


class UserContext(BaseModel):
    """Model for user context."""

    workContext: ContextSection = Field(default_factory=ContextSection)
    personalContext: ContextSection = Field(default_factory=ContextSection)
    topOfMind: ContextSection = Field(default_factory=ContextSection)


class HistoryContext(BaseModel):
    """Model for history context."""

    recentMonths: ContextSection = Field(default_factory=ContextSection)
    earlierContext: ContextSection = Field(default_factory=ContextSection)
    longTermBackground: ContextSection = Field(default_factory=ContextSection)


class Fact(BaseModel):
    """Model for a memory fact."""

    id: str = Field(..., description="Unique identifier for the fact")
    content: str = Field(..., description="Fact content")
    category: str = Field(default="context", description="Fact category")
    confidence: float = Field(default=0.5, description="Confidence score (0-1)")
    createdAt: str = Field(default="", description="Creation timestamp")
    source: str = Field(default="unknown", description="Source thread ID")


class MemoryResponse(BaseModel):
    """Response model for memory data."""

    version: str = Field(default="1.0", description="Memory schema version")
    lastUpdated: str = Field(default="", description="Last update timestamp")
    user: UserContext = Field(default_factory=UserContext)
    history: HistoryContext = Field(default_factory=HistoryContext)
    facts: list[Fact] = Field(default_factory=list)


class MemoryConfigResponse(BaseModel):
    """Response model for memory configuration."""

    enabled: bool = Field(..., description="Whether memory is enabled")
    storage_path: str = Field(..., description="Path to memory storage file")
    debounce_seconds: int = Field(..., description="Debounce time for memory updates")
    max_facts: int = Field(..., description="Maximum number of facts to store")
    fact_confidence_threshold: float = Field(..., description="Minimum confidence threshold for facts")
    injection_enabled: bool = Field(..., description="Whether memory injection is enabled")
    max_injection_tokens: int = Field(..., description="Maximum tokens for memory injection")


class MemoryStatusResponse(BaseModel):
    """Response model for memory status."""

    config: MemoryConfigResponse
    data: MemoryResponse


class MemoryAgentSlot(BaseModel):
    """One memory scope (global or per-agent file)."""

    id: str | None = Field(None, description="Agent id; null means global / default lead memory")
    display_name: str = Field("", description="Short label for UI")
    description: str = Field("", description="Optional subtitle from agent config")
    has_memory_file: bool = Field(False, description="Whether a JSON file already exists on disk")


class MemoryAgentsListResponse(BaseModel):
    """List of memory scopes for dashboard / settings UI."""

    agents: list[MemoryAgentSlot]


def _normalize_agent_query(agent: str | None) -> str | None:
    if agent is None:
        return None
    stripped = agent.strip()
    if not stripped:
        return None
    if not AGENT_NAME_PATTERN.match(stripped):
        raise HTTPException(status_code=400, detail=f"Invalid agent id {stripped!r}; must match {AGENT_NAME_PATTERN.pattern}")
    return stripped


def _require_legacy_memory_scope(request: Request, agent: str | None) -> None:
    """Gate legacy JSON memory: global = org_admin; agent = memory namespace visible."""
    from evoflow.authz.http_guard import require_memory_namespace_visible, require_org_admin
    from evoflow.memory.document_codec import namespace_for_agent_key

    agent_name = _normalize_agent_query(agent)
    if not agent_name:
        require_org_admin(request)
        return
    require_memory_namespace_visible(request, namespace_for_agent_key(agent_name))


@router.get(
    "/memory/agents",
    response_model=MemoryAgentsListResponse,
    summary="List Memory Scopes",
    description="List global memory plus each agent that has config and/or SQLite chat memory.",
)
async def list_memory_agents(request: Request) -> MemoryAgentsListResponse:
    from evoflow.authz.http_guard import require_memory_namespace_visible, resolve_authz_from_request
    from evoflow.memory.document_codec import namespace_for_agent_key

    raw = list_memory_agent_slots()
    authz = resolve_authz_from_request(request)
    if authz.get("is_admin") or not str(authz.get("principal_id") or "").strip():
        return MemoryAgentsListResponse(agents=[MemoryAgentSlot(**row) for row in raw])
    out = []
    for row in raw:
        aid = row.get("id") if isinstance(row, dict) else None
        if aid is None:
            continue  # hide global from non-admin
        try:
            require_memory_namespace_visible(request, namespace_for_agent_key(str(aid)))
        except Exception:
            continue
        out.append(MemoryAgentSlot(**row))
    return MemoryAgentsListResponse(agents=out)


@router.get(
    "/memory/namespaces",
    summary="List memory hub namespaces (agent / workspace / person)",
)
async def list_memory_namespaces_api(request: Request) -> dict:
    from evoflow.memory.migrate_legacy import ensure_legacy_migrated
    from evoflow.memory.namespaces_api import list_memory_namespaces

    ensure_legacy_migrated()
    return list_memory_namespaces(request)


class MemoryNamespaceClearRequest(BaseModel):
    namespace: str = Field(..., description="e.g. agent:main / workspace:ws-… / person:code")


@router.post(
    "/memory/namespace/clear",
    summary="Soft-clear all atoms in a namespace",
)
async def clear_memory_namespace(request: Request, body: MemoryNamespaceClearRequest) -> dict:
    from evoflow.authz.http_guard import require_memory_namespace_visible
    from evoflow.memory.store import clear_namespace

    ns = (body.namespace or "").strip()
    if not ns or ":" not in ns:
        raise HTTPException(status_code=400, detail="namespace required as kind:owner")
    require_memory_namespace_visible(request, ns)
    cleared = clear_namespace(ns)
    return {"ok": True, "namespace": ns, "cleared": cleared}


@router.get(
    "/memory",
    response_model=MemoryResponse,
    summary="Get Memory Data",
    description="Retrieve memory data for the global store or a specific agent (agents/{id}/memory.json).",
)
async def get_memory(
    request: Request,
    agent: str | None = Query(None, description="Agent id; omit for global memory"),
) -> MemoryResponse:
    """Get the current global memory data.

    Returns:
        The current memory data with user context, history, and facts.

    Example Response:
        ```json
        {
            "version": "1.0",
            "lastUpdated": "2024-01-15T10:30:00Z",
            "user": {
                "workContext": {"summary": "Working on EvoFlow project", "updatedAt": "..."},
                "personalContext": {"summary": "Prefers concise responses", "updatedAt": "..."},
                "topOfMind": {"summary": "Building memory API", "updatedAt": "..."}
            },
            "history": {
                "recentMonths": {"summary": "Recent development activities", "updatedAt": "..."},
                "earlierContext": {"summary": "", "updatedAt": ""},
                "longTermBackground": {"summary": "", "updatedAt": ""}
            },
            "facts": [
                {
                    "id": "fact_abc123",
                    "content": "User prefers TypeScript over JavaScript",
                    "category": "preference",
                    "confidence": 0.9,
                    "createdAt": "2024-01-15T10:30:00Z",
                    "source": "thread_xyz"
                }
            ]
        }
        ```
    """
    _require_legacy_memory_scope(request, agent)
    agent_name = _normalize_agent_query(agent)
    memory_data = get_memory_data(agent_name)
    return MemoryResponse(**memory_data)


@router.post(
    "/memory/reload",
    response_model=MemoryResponse,
    summary="Reload Memory Data",
    description="Reload memory data from the storage file, refreshing the in-memory cache.",
)
async def reload_memory(
    request: Request,
    agent: str | None = Query(None, description="Agent id; omit for global memory"),
) -> MemoryResponse:
    """Reload memory data from file.

    This forces a reload of the memory data from the storage file,
    useful when the file has been modified externally.

    Returns:
        The reloaded memory data.
    """
    _require_legacy_memory_scope(request, agent)
    agent_name = _normalize_agent_query(agent)
    memory_data = reload_memory_data(agent_name)
    return MemoryResponse(**memory_data)


@router.delete(
    "/memory",
    response_model=MemoryResponse,
    summary="Clear All Memory Data",
    description="Delete all saved memory for the global store or one agent and reset to an empty structure.",
)
async def clear_memory(
    request: Request,
    agent: str | None = Query(None, description="Agent id; omit to clear global memory"),
) -> MemoryResponse:
    """Clear all persisted memory data."""
    _require_legacy_memory_scope(request, agent)
    try:
        agent_name = _normalize_agent_query(agent)
        memory_data = clear_memory_data(agent_name)
    except OSError as exc:
        raise HTTPException(status_code=500, detail="Failed to clear memory data.") from exc

    return MemoryResponse(**memory_data)


@router.delete(
    "/memory/facts/{fact_id}",
    response_model=MemoryResponse,
    summary="Delete Memory Fact",
    description="Delete a single saved memory fact by its fact id (global or agent scope).",
)
async def delete_memory_fact_endpoint(
    request: Request,
    fact_id: str,
    agent: str | None = Query(None, description="Agent id; omit for global memory"),
) -> MemoryResponse:
    """Delete a single fact from memory by fact id."""
    _require_legacy_memory_scope(request, agent)
    try:
        agent_name = _normalize_agent_query(agent)
        memory_data = delete_memory_fact(fact_id, agent_name)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=f"Memory fact '{fact_id}' not found.") from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail="Failed to delete memory fact.") from exc

    return MemoryResponse(**memory_data)


@router.get(
    "/memory/config",
    response_model=MemoryConfigResponse,
    summary="Get Memory Configuration",
    description="Retrieve the current memory system configuration.",
)
async def get_memory_config_endpoint() -> MemoryConfigResponse:
    """Get the memory system configuration.

    Returns:
        The current memory configuration settings.

    Example Response:
        ```json
        {
            "enabled": true,
            "storage_path": ".evoflow/memory.json",
            "debounce_seconds": 30,
            "max_facts": 100,
            "fact_confidence_threshold": 0.7,
            "injection_enabled": true,
            "max_injection_tokens": 2000
        }
        ```
    """
    config = get_memory_config()
    return MemoryConfigResponse(
        enabled=config.enabled,
        storage_path=config.storage_path,
        debounce_seconds=config.debounce_seconds,
        max_facts=config.max_facts,
        fact_confidence_threshold=config.fact_confidence_threshold,
        injection_enabled=config.injection_enabled,
        max_injection_tokens=config.max_injection_tokens,
    )


@router.get(
    "/memory/status",
    response_model=MemoryStatusResponse,
    summary="Get Memory Status",
    description="Retrieve both memory configuration and current data in a single request.",
)
async def get_memory_status(
    request: Request,
    agent: str | None = Query(None, description="Agent id; omit for global memory in `data`"),
) -> MemoryStatusResponse:
    """Get the memory system status including configuration and data.

    Returns:
        Combined memory configuration and current data.
    """
    _require_legacy_memory_scope(request, agent)
    config = get_memory_config()
    agent_name = _normalize_agent_query(agent)
    memory_data = get_memory_data(agent_name)

    return MemoryStatusResponse(
        config=MemoryConfigResponse(
            enabled=config.enabled,
            storage_path=config.storage_path,
            debounce_seconds=config.debounce_seconds,
            max_facts=config.max_facts,
            fact_confidence_threshold=config.fact_confidence_threshold,
            injection_enabled=config.injection_enabled,
            max_injection_tokens=config.max_injection_tokens,
        ),
        data=MemoryResponse(**memory_data),
    )


# ---------------------------------------------------------------------------
# Unified mem_* atoms API (Owned KB engine)
# ---------------------------------------------------------------------------


class MemoryAtomOut(BaseModel):
    id: str
    namespace_id: str = ""
    layer: str = "semantic"
    kind: str = "fact"
    content: str = ""
    summary: str = ""
    importance: float = 0.5
    confidence: float = 0.7
    pin: bool = False
    source: str = ""
    subject_key: str = ""
    created_at: str = ""
    updated_at: str = ""


class MemoryAtomsListResponse(BaseModel):
    namespace: str
    atoms: list[MemoryAtomOut]


class MemoryAtomCreateRequest(BaseModel):
    content: str = Field(..., min_length=1)
    layer: str = "semantic"
    kind: str = "fact"
    summary: str = ""
    pin: bool = False
    confidence: float = 0.9
    importance: float | None = None
    subject_key: str = ""


class MemoryAtomPatchRequest(BaseModel):
    pin: bool | None = None
    content: str | None = None
    summary: str | None = None


class MemoryRecallRequest(BaseModel):
    query: str = Field(..., min_length=1)
    top_k: int = Field(default=8, ge=1, le=32)
    layers: list[str] | None = None


class MemoryRecallResponse(BaseModel):
    namespace: str
    query: str
    hits: list[MemoryAtomOut]


def _atom_out(row: dict) -> MemoryAtomOut:
    return MemoryAtomOut(
        id=str(row.get("id") or ""),
        namespace_id=str(row.get("namespace_id") or ""),
        layer=str(row.get("layer") or "semantic"),
        kind=str(row.get("kind") or "fact"),
        content=str(row.get("content") or ""),
        summary=str(row.get("summary") or ""),
        importance=float(row.get("importance") or 0.5),
        confidence=float(row.get("confidence") or 0.7),
        pin=bool(row.get("pin")),
        source=str(row.get("source") or ""),
        subject_key=str(row.get("subject_key") or ""),
        created_at=str(row.get("created_at") or ""),
        updated_at=str(row.get("updated_at") or ""),
    )


def _resolve_list_namespace(
    *,
    agent: str | None,
    namespace: str | None,
) -> str:
    from evoflow.memory.document_codec import namespace_for_agent_key

    ns = (namespace or "").strip()
    if ns:
        return ns
    agent_name = _normalize_agent_query(agent)
    return namespace_for_agent_key(agent_name)


def _require_resolved_namespace(request: Request, *, agent: str | None, namespace: str | None) -> str:
    from evoflow.authz.http_guard import require_memory_namespace_visible

    ns = _resolve_list_namespace(agent=agent, namespace=namespace)
    require_memory_namespace_visible(request, ns)
    return ns


@router.get(
    "/memory/atoms",
    response_model=MemoryAtomsListResponse,
    summary="List memory atoms",
)
async def list_memory_atoms(
    request: Request,
    agent: str | None = Query(None, description="Agent id; omit for global"),
    namespace: str | None = Query(None, description="Full namespace id e.g. workspace:ws-… / person:code"),
    layer: str | None = Query(None, description="episodic|semantic|procedural"),
    pinned_only: bool = Query(False),
    limit: int = Query(100, ge=1, le=500),
) -> MemoryAtomsListResponse:
    from evoflow.memory.facade import list_atoms
    from evoflow.memory.migrate_legacy import ensure_legacy_migrated

    ensure_legacy_migrated()
    ns = _require_resolved_namespace(request, agent=agent, namespace=namespace)
    layers = [layer] if layer else None
    rows = list_atoms(ns, layers=layers, pinned_only=pinned_only, limit=limit)
    return MemoryAtomsListResponse(namespace=ns, atoms=[_atom_out(r) for r in rows])


@router.post(
    "/memory/atoms",
    response_model=MemoryAtomOut,
    summary="Create memory atom",
)
async def create_memory_atom(
    request: Request,
    body: MemoryAtomCreateRequest,
    agent: str | None = Query(None),
) -> MemoryAtomOut:
    from evoflow.authz.http_guard import require_memory_namespace_visible
    from evoflow.memory.document_codec import namespace_for_agent_key
    from evoflow.memory.facade import list_atoms, remember
    from evoflow.memory.migrate_legacy import ensure_legacy_migrated

    ensure_legacy_migrated()
    agent_name = _normalize_agent_query(agent)
    ns = namespace_for_agent_key(agent_name)
    require_memory_namespace_visible(request, ns)
    aid = remember(
        ns,
        body.content,
        layer=body.layer,
        kind=body.kind,
        summary=body.summary,
        pin=body.pin,
        confidence=body.confidence,
        importance=body.importance,
        subject_key=body.subject_key,
        source="manual",
    )
    if not aid:
        raise HTTPException(status_code=400, detail="Failed to create atom")
    rows = list_atoms(ns, limit=500)
    for r in rows:
        if r.get("id") == aid:
            return _atom_out(r)
    from evoflow.memory.store import get_atom

    atom = get_atom(aid)
    if not atom:
        raise HTTPException(status_code=500, detail="Atom created but not readable")
    return _atom_out(atom)


@router.patch(
    "/memory/atoms/{atom_id}",
    response_model=MemoryAtomOut,
    summary="Patch memory atom (pin / content)",
)
async def patch_memory_atom(request: Request, atom_id: str, body: MemoryAtomPatchRequest) -> MemoryAtomOut:
    from evoflow.authz.http_guard import require_memory_namespace_visible
    from evoflow.memory.facade import pin_atom, remember
    from evoflow.memory.store import get_atom

    atom = get_atom(atom_id)
    if not atom:
        raise HTTPException(status_code=404, detail="Atom not found")
    require_memory_namespace_visible(request, str(atom.get("namespace_id") or ""))
    if body.pin is not None:
        pin_atom(atom_id, body.pin)
    if body.content is not None or body.summary is not None:
        remember(
            str(atom.get("namespace_id") or ""),
            body.content if body.content is not None else str(atom.get("content") or ""),
            layer=str(atom.get("layer") or "semantic"),
            kind=str(atom.get("kind") or "fact"),
            summary=body.summary if body.summary is not None else str(atom.get("summary") or ""),
            pin=bool(atom.get("pin")) if body.pin is None else body.pin,
            confidence=float(atom.get("confidence") or 0.7),
            importance=float(atom.get("importance") or 0.5),
            subject_key=str(atom.get("subject_key") or ""),
            atom_id=atom_id,
            source=str(atom.get("source") or "manual"),
        )
    updated = get_atom(atom_id)
    if not updated:
        raise HTTPException(status_code=404, detail="Atom not found after patch")
    return _atom_out(updated)


@router.delete(
    "/memory/atoms/{atom_id}",
    summary="Forget memory atom",
)
async def delete_memory_atom(request: Request, atom_id: str) -> dict:
    from evoflow.authz.http_guard import require_memory_namespace_visible
    from evoflow.memory.facade import forget
    from evoflow.memory.store import get_atom

    atom = get_atom(atom_id)
    if not atom:
        raise HTTPException(status_code=404, detail="Atom not found")
    require_memory_namespace_visible(request, str(atom.get("namespace_id") or ""))
    if not forget(atom_id):
        raise HTTPException(status_code=404, detail="Atom not found")
    return {"ok": True, "id": atom_id}


@router.post(
    "/memory/recall",
    response_model=MemoryRecallResponse,
    summary="Trial recall (debug)",
)
async def trial_memory_recall(
    request: Request,
    body: MemoryRecallRequest,
    agent: str | None = Query(None),
    namespace: str | None = Query(None),
) -> MemoryRecallResponse:
    from evoflow.memory.facade import recall
    from evoflow.memory.migrate_legacy import ensure_legacy_migrated

    ensure_legacy_migrated()
    ns = _require_resolved_namespace(request, agent=agent, namespace=namespace)
    hits = recall(
        [ns],
        body.query,
        layers=body.layers,
        top_k=body.top_k,
        max_chars=2000,
    )
    return MemoryRecallResponse(
        namespace=ns,
        query=body.query,
        hits=[_atom_out(h) for h in hits],
    )


class MemoryConsolidateRequest(BaseModel):
    namespace: str | None = Field(None, description="e.g. agent:main or person:xiaomi")
    agent: str | None = Field(None, description="Shorthand → agent:{id} namespace")
    async_job: bool = Field(False, description="Enqueue kb_jobs mem_consolidate")
    trigger: str = Field("manual", description="manual|idle|threshold|after_wrap_up")


@router.post(
    "/memory/consolidate",
    summary="Consolidate memory namespace",
)
async def consolidate_memory(request: Request, body: MemoryConsolidateRequest) -> dict:
    from evoflow.authz.http_guard import require_memory_namespace_visible
    from evoflow.memory.document_codec import namespace_for_agent_key
    from evoflow.memory.facade import consolidate
    from evoflow.memory.migrate_legacy import ensure_legacy_migrated

    ensure_legacy_migrated()
    ns = (body.namespace or "").strip()
    if not ns and body.agent is not None:
        agent_name = _normalize_agent_query(body.agent)
        ns = namespace_for_agent_key(agent_name)
    if not ns:
        raise HTTPException(status_code=400, detail="namespace or agent required")
    require_memory_namespace_visible(request, ns)
    result = consolidate(ns, trigger=body.trigger or "manual", async_job=body.async_job)
    return {"ok": True, **result}


@router.get(
    "/memory/graph",
    summary="Memory namespace entity graph",
)
async def get_memory_graph(
    request: Request,
    agent: str | None = Query(None),
    namespace: str | None = Query(None, description="Override namespace id"),
    center: str | None = Query(None),
    limit: int = Query(80, ge=1, le=300),
) -> dict:
    from evoflow.memory.graph import get_graph
    from evoflow.memory.migrate_legacy import ensure_legacy_migrated

    ensure_legacy_migrated()
    ns = _require_resolved_namespace(request, agent=agent, namespace=namespace)
    return get_graph(ns, center=center, limit=limit)


@router.get(
    "/memory/graph/nodes/{node_id}/atoms",
    summary="Atoms linked to a memory graph node",
)
async def get_memory_graph_node_atoms(
    request: Request,
    node_id: str,
    limit: int = Query(40, ge=1, le=200),
) -> dict:
    from evoflow.authz.http_guard import require_memory_namespace_visible, require_org_admin
    from evoflow.memory.graph import atoms_for_node

    atoms = atoms_for_node(node_id, limit=limit)
    ns_ids = {
        str(a.get("namespace_id") or a.get("namespace") or "").strip()
        for a in atoms
        if isinstance(a, dict)
    }
    ns_ids.discard("")
    if not ns_ids:
        require_org_admin(request)
    else:
        for ns in ns_ids:
            require_memory_namespace_visible(request, ns)
    return {
        "node_id": node_id,
        "atoms": [_atom_out(a) for a in atoms],
        "count": len(atoms),
    }


@router.post(
    "/memory/graph/rebuild",
    summary="Rebuild memory graph (LLM extract enqueue)",
)
async def rebuild_memory_graph(
    request: Request,
    agent: str | None = Query(None),
    namespace: str | None = Query(None),
    clear: bool = Query(True),
) -> dict:
    from evoflow.memory.graph import rebuild_graph
    from evoflow.memory.migrate_legacy import ensure_legacy_migrated

    ensure_legacy_migrated()
    ns = _require_resolved_namespace(request, agent=agent, namespace=namespace)
    result = rebuild_graph(ns, clear=clear)
    return {"ok": True, **result}


@router.post(
    "/memory/assets-sync",
    summary="Sync Asset Hub memory files to graph namespace",
)
async def sync_assets_to_graph(
    request: Request,
    entity_type: str = Query("user", description="Entity type: user, employee, workspace"),
    entity_id: str = Query("", description="Entity ID"),
    dry_run: bool = Query(False, description="Preview only, don't write"),
) -> dict:
    """Sync Asset Hub memory files to the memory graph system.

    Reads markdown files from the Asset Hub and creates/updates graph atoms.
    This bridges the gap between the new file-based assets and the old graph system.
    """
    from evoflow.authz.http_guard import require_asset_entity_visible

    require_asset_entity_visible(request, entity_type, entity_id or "user")
    from evoflow.memory.assets_to_graph import (
        sync_user_memory_to_graph,
        sync_workspace_memory_to_graph,
    )

    if entity_type == "user":
        result = sync_user_memory_to_graph("user:default")
    elif entity_type == "workspace" and entity_id:
        result = sync_workspace_memory_to_graph(entity_id)
    else:
        return {"ok": False, "error": "Unsupported entity type for sync"}

    return {"ok": True, **result}


@router.get(
    "/memory/recall-snapshot",
    summary="Last-turn memory injection snapshot for a thread",
)
async def get_memory_recall_snapshot(
    request: Request,
    thread_id: str = Query(..., description="Chat thread id"),
) -> dict:
    from evoflow.authz.http_guard import require_thread_visible
    from evoflow.memory.recall_snapshot import get_thread_recall

    require_thread_visible(request, thread_id)
    snap = get_thread_recall(thread_id)
    if not snap:
        return {
            "thread_id": thread_id,
            "hit_count": 0,
            "hits": [],
            "standing_preview": "",
            "query": "",
            "updated_at": "",
        }
    return snap


