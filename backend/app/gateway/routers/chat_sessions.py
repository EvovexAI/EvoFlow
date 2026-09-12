"""Chat session index + application-owned transcript (not LangGraph checkpoint)."""

from __future__ import annotations

import json
import logging
import sqlite3
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from app.gateway.db_async import run_db
from evoflow.persistence import chat_message_repositories as msg_repo
from evoflow.persistence import chat_session_service as chat_svc
from evoflow.persistence import session_repositories as sess_repo
from evoflow.persistence import workspace_repositories as ws_repo

router = APIRouter(prefix="/api/chat/sessions", tags=["chat-sessions"])
logger = logging.getLogger(__name__)


def _transcript_db_busy_http(e: sqlite3.OperationalError) -> HTTPException | None:
    msg = str(e).lower()
    if "locked" in msg or "busy" in msg:
        return HTTPException(status_code=503, detail="database busy, retry shortly")
    return None


def _request_principal_id(request: Request | None) -> str | None:
    """Resolve current principal_id from the HTTP request (JWT / local admin)."""
    try:
        from evoflow.authz.context import resolve_request_principal

        p = resolve_request_principal(request)
        uid = str((p or {}).get("principal_id") or "").strip()
        return uid or None
    except Exception:
        return None


def _require_session_access(request: Request | None, session_key: str) -> str:
    """Normalize session_key and enforce ownership visibility (404 if hidden)."""
    from evoflow.authz.http_guard import require_session_visible

    key = str(session_key or "").strip()
    if not key:
        raise HTTPException(status_code=422, detail="session_key required")
    require_session_visible(request, key)
    return key

class SessionRowResponse(BaseModel):
    sessionKey: str
    key: str
    threadId: str | None = None
    title: str = ""
    createdAt: int = 0
    updatedAt: int = 0
    messageCount: int = 0
    context: dict[str, Any] = Field(default_factory=dict)
    localWorkspaceRoot: str | None = None
    useVirtualPaths: bool | None = None
    modelName: str | None = None
    primaryModelName: str | None = None
    sessionMode: str | None = None
    thinkingEnabled: bool | None = None
    reasoningEffort: str | None = None
    isPlanMode: bool | None = None
    subagentEnabled: bool | None = None
    includeSearch: bool | None = None
    memoryEnabled: bool | None = None
    useClaudeCodeChat: bool | None = None
    collabPhase: str | None = None
    collabTaskId: str | None = None
    agentId: str | None = None
    activatedScenarios: list[str] = Field(default_factory=list)
    runStatus: str = "idle"
    currentRunId: str | None = None
    currentTurnStartedAt: str | None = Field(
        default=None,
        description="ISO8601 wall-clock start of the current assistant turn (evoflow_chat_sessions.current_turn_started_at)",
    )
    currentTurnEndedAt: str | None = Field(
        default=None,
        description="ISO8601 wall-clock end of the latest assistant turn (evoflow_chat_sessions.current_turn_ended_at)",
    )
    inputTokens: int = 0
    outputTokens: int = 0
    totalTokens: int = 0
    isPinned: bool = False
    pinOrder: int = 0
    hiddenFromList: bool = False
    toolApprovalPolicy: str | None = Field(
        default=None,
        description="Session override: prompt | session | grant_all; null = inherit global",
    )
    effectiveToolApprovalPolicy: str | None = Field(
        default=None,
        description="Resolved tool approval policy for this session",
    )
    permissionPreset: str | None = Field(
        default=None,
        description="Session runtime preset: read-only | default | full-access; null = derive",
    )
    effectivePermissionPreset: str | None = Field(
        default=None,
        description="Resolved runtime permission preset for UI",
    )
    orgId: str | None = None
    scopeId: str | None = None
    createdBy: str | None = None


class SessionListResponse(BaseModel):
    source: str = Field(
        default="evoflow_chat_sessions",
        description="Sidebar index in evoflow.db; messages in evoflow_chat_messages.",
    )
    sessions: list[SessionRowResponse]


class WorkspaceGroupSummaryResponse(BaseModel):
    workspaceKey: str
    localWorkspaceRoot: str | None = None
    useVirtualPaths: bool = False
    sessionCount: int = 0
    maxUpdatedAt: int = 0


class WorkspaceGroupsListResponse(BaseModel):
    source: str = "evoflow_chat_sessions"
    groups: list[WorkspaceGroupSummaryResponse] = Field(default_factory=list)


class ThreadTitleMapResponse(BaseModel):
    titles: dict[str, str] = Field(default_factory=dict)


class AppendMessageBody(BaseModel):
    role: str
    contentJson: dict[str, Any] | None = None
    content: Any | None = None
    messageId: str | None = None
    toolCallId: str | None = None
    toolName: str | None = None
    modelName: str | None = None
    inputTokens: int | None = None
    outputTokens: int | None = None
    totalTokens: int | None = None
    runId: str | None = None
    threadId: str | None = None
    parentThreadId: str | None = None


class AppendMessagesBatchBody(BaseModel):
    messages: list[dict[str, Any]] = Field(default_factory=list)
    runId: str | None = None
    threadId: str | None = None


class MessagesListResponse(BaseModel):
    sessionKey: str
    messages: list[dict[str, Any]]
    messageCount: int = 0
    source: str = "evoflow_chat_messages"
    hasMore: bool = False
    oldestSeq: int | None = None


class LiveRunSnapshotBody(BaseModel):
    runId: str
    threadId: str | None = None
    status: str = "running"
    partialText: str = ""
    partialTools: list[dict[str, Any]] = Field(default_factory=list)
    partialDisplaySegments: list[dict[str, Any]] = Field(default_factory=list)
    lastEventAtMs: int | None = None


class CreateSessionBody(BaseModel):
    sessionKey: str | None = None
    agentId: str = "main"
    title: str = ""
    context: dict[str, Any] | None = None
    ensureThread: bool = True


class ForkSessionBody(BaseModel):
    """Fork (branch) a conversation into a new session — native-style."""

    throughSeq: int | None = Field(
        default=None,
        ge=0,
        description="Inclusive transcript seq cut; 0 = empty branch; omit to copy the full history",
    )
    throughMessageId: str | None = Field(
        default=None,
        description="Optional message_id cut (resolved to seq; combined with throughSeq as min)",
    )
    beforeMessageId: str | None = Field(
        default=None,
        description="Exclusive cut: copy history strictly before this message_id (edit/backtrack)",
    )
    title: str | None = Field(default=None, description="Optional title for the forked session")


class TruncateSessionBody(BaseModel):
    """In-place rewind for editing a sent user message (same session)."""

    fromMessageId: str = Field(
        min_length=1,
        description="Delete this message_id and every transcript row after it",
    )


class WorkspaceHistoryResponse(BaseModel):
    sessionKey: str
    paths: list[str] = Field(default_factory=list)
    currentPath: str | None = None


class WorkspaceHistoryPutBody(BaseModel):
    paths: list[str] = Field(default_factory=list)


class BindWorkspaceBody(BaseModel):
    path: str


class BindThreadBody(BaseModel):
    threadId: str = Field(min_length=1)
    context: dict[str, Any] | None = None


class SessionPinBody(BaseModel):
    pinned: bool = True


class SessionHiddenBody(BaseModel):
    hidden: bool = True


class SessionTitleBody(BaseModel):
    title: str = Field(min_length=1, max_length=500)


class PinnedOrderBody(BaseModel):
    sessionKeys: list[str] = Field(default_factory=list)


class UpdateSessionContextBody(BaseModel):
    context: dict[str, Any] = Field(default_factory=dict)


class SessionModeItem(BaseModel):
    value: str
    label: str
    visible: bool = True
    scenario: str | None = None  # 对应后端模式键: ask / agent / plan / None(=auto)


class SessionModesResponse(BaseModel):
    modes: list[SessionModeItem]
    default_mode: str = "agent"


# 模式定义 —— visible=true 的模式在 UI 选择器中显示；
# 每个模式映射到后端模式系统 (ask / agent / plan)，scenario=None 表示 Auto(模型自动选)。
_SESSION_MODE_DEFINITIONS: list[dict[str, Any]] = [
    {
        "value": "auto",
        "label": "Auto",
        "visible": False,
        "scenario": None,
    },
    {
        "value": "ask",
        "label": "Ask",
        "visible": True,
        "scenario": "ask",
    },
    {
        "value": "agent",
        "label": "Agent",
        "visible": True,
        "scenario": "agent",
    },
    {
        "value": "plan",
        "label": "Plan",
        "visible": True,
        "scenario": "plan",
    },
    # --- 隐藏模式（兼容旧数据，UI 不展示）---
    {"value": "flash", "label": "闪速", "visible": False, "scenario": None},
    {"value": "thinking", "label": "思考", "visible": False, "scenario": None},
    {"value": "pro", "label": "Pro", "visible": False, "scenario": None},
    {"value": "ultra", "label": "Ultra", "visible": False, "scenario": None},
]


@router.get(
    "/session-modes",
    response_model=SessionModesResponse,
    summary="Get session mode definitions (visible modes, labels, scenario mapping)",
)
async def get_session_modes() -> SessionModesResponse:
    """前端启动时调用，动态控制模式选择器的显示项与各模式对应的场景。"""
    return SessionModesResponse(
        modes=[SessionModeItem(**m) for m in _SESSION_MODE_DEFINITIONS],
        default_mode="agent",
    )


class SetSessionScenarioBody(BaseModel):
    scenario: str | None = Field(default=None, description="模式键: ask / agent / plan / None(=auto)")


@router.put(
    "/{session_key:path}/scenario",
    summary="Set activated mode for a session (ask / agent / plan / auto)",
)
async def set_session_scenario(request: Request, session_key: str, body: SetSessionScenarioBody) -> dict[str, Any]:
    """用户从模式选择器手动切换模式。scenario=None 清除模式(回到 Auto)。"""
    key = _require_session_access(request, session_key)
    key = session_key.strip()
    if not key:
        raise HTTPException(status_code=422, detail="session_key required")
    if sess_repo.is_session_deleted(key):
        raise HTTPException(status_code=404, detail="session not found")
    raw = (body.scenario or "").strip().lower()
    valid = {"", "ask", "agent", "plan", "chat", "workspace"}
    if raw not in valid:
        raise HTTPException(status_code=422, detail=f"invalid scenario: {raw}")
    from evoflow.agents.lead_agent.intent_tool_profile import normalize_scenario_key

    norm = normalize_scenario_key(raw) if raw else ""
    scenarios: list[str] = [norm] if norm and norm != "ask" else []
    # session_mode is the single source of truth after the v75 migration
    # (the legacy scenario JSON column was dropped).
    sess_repo.set_session_mode(key, sess_repo.derive_session_mode(scenarios))
    row = sess_repo.get_session_row_for_ui(key)
    out_scenario = norm if norm and norm != "ask" else "auto"
    return {"ok": True, "sessionKey": key, "scenario": out_scenario, "session": row}


@router.get("/workspace-groups", response_model=WorkspaceGroupsListResponse, summary="Workspace folders with session counts")
async def list_workspace_groups(request: Request) -> WorkspaceGroupsListResponse:
  summaries = await run_db(sess_repo.summarize_sessions_by_workspace_for_ui)
  registered = await run_db(ws_repo.list_global_workspace_paths)
  try:
      from evoflow.authz.http_guard import resolve_authz_from_request
      from evoflow.authz.workspace_visibility import filter_visible_workspace_paths
      from evoflow.persistence.session_repositories import (
          WORKSPACE_GROUP_PROACTIVE,
          WORKSPACE_GROUP_UNBOUND,
          WORKSPACE_GROUP_VIRTUAL,
      )

      authz = resolve_authz_from_request(request)
      registered = filter_visible_workspace_paths(
          registered,
          authz.get("principal"),
          is_admin=bool(authz.get("is_admin")),
          personal_scope_id=authz.get("personal_scope"),
          org_scope_id=authz.get("org_scope"),
      )
      kept: list[dict] = []
      for s in summaries or []:
          wk = str((s or {}).get("workspaceKey") or "")
          if wk in {
              WORKSPACE_GROUP_UNBOUND,
              WORKSPACE_GROUP_VIRTUAL,
              WORKSPACE_GROUP_PROACTIVE,
          }:
              kept.append(s)
              continue
          root = str((s or {}).get("localWorkspaceRoot") or "").strip()
          if not root or filter_visible_workspace_paths(
              [root],
              authz.get("principal"),
              is_admin=bool(authz.get("is_admin")),
              personal_scope_id=authz.get("personal_scope"),
              org_scope_id=authz.get("org_scope"),
          ):
              kept.append(s)
      summaries = kept
  except Exception:
      pass
  groups = sess_repo.merge_workspace_group_summaries_for_ui(summaries, registered)
  return WorkspaceGroupsListResponse(
      groups=[WorkspaceGroupSummaryResponse(**g) for g in groups],
  )


def _session_acl_kwargs(request: Request | None) -> dict[str, Any]:
    """Build list/search ACL SQL (isolation always on)."""
    try:
        from evoflow.authz.context import resolve_request_authz
        from evoflow.authz.debug_log import authz_debug
        from evoflow.authz.session_ownership import acl_session_list_filter_sql

        ctx = resolve_request_authz(request)
        principal = ctx.get("principal") or {}
        is_admin = bool(ctx.get("is_org_admin"))
        sql, params = acl_session_list_filter_sql(principal, is_admin=is_admin)
        authz_debug(
            "chat_session.list.acl",
            jwt_present=isinstance(getattr(request.state, "webui_user", None), dict) if request else False,
            principal_id=str(principal.get("principal_id") or "") or None,
            is_org_admin=is_admin,
            acl_active=bool(sql),
            has_auth_header=bool((request.headers.get("authorization") or "").strip()) if request else False,
        )
        if not sql:
            return {}
        return {"acl_sql": sql, "acl_params": params}
    except Exception:
        logger.debug("session acl filter skipped", exc_info=True)
        return {}


@router.get("", response_model=SessionListResponse, summary="List chat sessions")
async def list_chat_sessions(
    request: Request,
    limit: int = Query(default=20, ge=1, le=200),
    offset: int = Query(default=0, ge=0, le=10000),
    search: str = Query(default="", description="Search sessions by title and message content across all sessions"),
    workspace_key: str | None = Query(
        default=None,
        description="Filter by workspace folder: __unbound__, __virtual__, or bound local path",
    ),
) -> SessionListResponse:
    acl_kw = _session_acl_kwargs(request)
    q = str(search or "").strip()
    if q:
        rows = await run_db(sess_repo.search_sessions_for_ui, q, limit=max(limit, 50), **acl_kw)
        return SessionListResponse(
            source="evoflow_chat_sessions",
            sessions=[SessionRowResponse(**r) for r in rows],
        )
    rows = await run_db(
        sess_repo.list_sessions_for_ui,
        limit=limit,
        offset=offset,
        workspace_key=workspace_key,
        **acl_kw,
    )
    # run_status reconcile moved off list hot path — use GET .../execution/state or startup sweep
    return SessionListResponse(
        source="evoflow_chat_sessions",
        sessions=[SessionRowResponse(**r) for r in rows],
    )


@router.get(
    "/titles-by-thread",
    response_model=ThreadTitleMapResponse,
    summary="Resolve session titles for LangGraph thread_id values",
)
async def get_titles_by_thread(
    thread_ids: str = Query(default="", description="Comma-separated LangGraph thread_id values"),
) -> ThreadTitleMapResponse:
    raw = [p.strip() for p in str(thread_ids or "").split(",")]
    ids = [p for p in raw if p][:100]
    if not ids:
        return ThreadTitleMapResponse(titles={})
    return ThreadTitleMapResponse(titles=sess_repo.resolve_titles_by_thread_ids(ids))


@router.post("", response_model=SessionRowResponse, summary="Create a new chat session")
async def create_chat_session(request: Request, body: CreateSessionBody) -> SessionRowResponse:
    ctx = dict(body.context or {})
    jwt_present = False
    pid = ""
    try:
        from evoflow.authz.context import resolve_request_principal
        from evoflow.authz.debug_log import authz_debug

        jwt_present = isinstance(getattr(request.state, "webui_user", None), dict)
        principal = resolve_request_principal(request)
        pid = str(principal.get("principal_id") or "").strip()
        # Always stamp from the authenticated request principal — never trust
        # client-supplied created_by/principal_id (and never leave them empty so
        # create_new_session falls back to local-admin).
        if pid:
            ctx["created_by"] = pid
            ctx["principal_id"] = pid
        uname = None
        attrs = principal.get("attrs") if isinstance(principal.get("attrs"), dict) else {}
        if attrs:
            uname = str(attrs.get("username") or "").strip() or None
        is_admin = False
        if pid:
            from evoflow.authz import admin_grants as admin_mod

            is_admin = bool(admin_mod.is_org_admin(pid))
        authz_debug(
            "chat_session.create.request",
            jwt_present=jwt_present,
            principal_id=pid or None,
            display_name=str(principal.get("display_name") or "") or None,
            username=uname,
            is_org_admin=is_admin,
            title=str(body.title or "")[:80] or None,
            agent_id=str(body.agentId or "main"),
            client_created_by=str((body.context or {}).get("created_by") or "") or None,
            has_auth_header=bool((request.headers.get("authorization") or "").strip()),
        )
    except Exception:
        logger.debug("create_chat_session identity resolve failed", exc_info=True)
    try:
        row = await chat_svc.create_new_session(
            session_key=body.sessionKey,
            agent_id=body.agentId,
            title=body.title,
            context=ctx,
            ensure_thread=body.ensureThread,
        )
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    try:
        from evoflow.authz.debug_log import authz_debug

        authz_debug(
            "chat_session.create.result",
            session_key=str(row.get("sessionKey") or row.get("session_key") or "") or None,
            created_by=str(row.get("createdBy") or row.get("created_by") or "") or None,
            scope_id=str(row.get("scopeId") or row.get("scope_id") or "") or None,
            request_principal_id=pid or None,
            jwt_present=jwt_present,
        )
    except Exception:
        pass
    return SessionRowResponse(**row)


@router.get("/by-thread/{thread_id}/messages", response_model=MessagesListResponse, summary="List transcript by LangGraph thread_id")
async def list_messages_by_thread(
    request: Request,
    thread_id: str,
    limit: int = Query(default=200, ge=1, le=5000),
    all: bool = Query(default=False, description="Return full transcript in one response"),
) -> MessagesListResponse:
    from evoflow.authz.http_guard import require_thread_visible

    tid = thread_id.strip()
    if not tid:
        raise HTTPException(status_code=422, detail="thread_id required")
    require_thread_visible(request, tid)

    from evoflow.collab.thread_ids import is_collab_executor_thread

    cap = 5000 if all else min(int(limit or 200), 5000)

    # Subtask worker threads ({lead}__sub__{subtask_id}) must not fall through to lead session_key
    # lookup — that would return the entire main chat transcript instead of this node only.
    if is_collab_executor_thread(tid):
        messages = msg_repo.conversation_archive_from_thread_id(tid, limit=cap)
        return MessagesListResponse(
            sessionKey="",
            messages=messages,
            messageCount=len(messages),
            source="evoflow_chat_messages",
            hasMore=False,
            oldestSeq=None,
        )

    sk = sess_repo.find_session_key_by_thread_id(tid)
    if sk and not sess_repo.is_session_deleted(sk):
        if all:
            page = msg_repo.list_messages_for_display_all(sk)
            messages = list(page.get("messages") or [])
            if messages:
                return MessagesListResponse(
                    sessionKey=sk,
                    messages=messages,
                    messageCount=msg_repo.count_lead_messages(sk),
                    source="evoflow_chat_messages",
                    hasMore=False,
                    oldestSeq=None,
                )
        else:
            messages = msg_repo.list_messages_for_display(sk, limit=min(cap, 5000))
            if messages:
                return MessagesListResponse(
                    sessionKey=sk,
                    messages=messages,
                    messageCount=msg_repo.count_lead_messages(sk),
                    source="evoflow_chat_messages",
                )
    archived = msg_repo.conversation_archive_from_thread_id(tid, limit=cap)
    if archived:
        return MessagesListResponse(
            sessionKey=sk or "",
            messages=archived,
            messageCount=len(archived),
            source="evoflow_chat_messages",
            hasMore=False,
            oldestSeq=None,
        )
    return MessagesListResponse(sessionKey=sk or "", messages=[], messageCount=0)




class ToolResultFullResponse(BaseModel):
    toolCallId: str
    toolName: str
    content: str
    contentBytes: int = 0
    preview: str = ""
    args: dict[str, Any] = Field(default_factory=dict)


class KnowledgeMapResponse(BaseModel):
    threadId: str
    sessionKey: str = ""
    header: dict[str, Any] | None = None
    nodes: list[dict[str, Any]] = Field(default_factory=list)
    edges: list[dict[str, Any]] = Field(default_factory=list)
    graphVersion: int = 0
    nodeCount: int = 0
    edgeCount: int = 0


class KnowledgeMapNodeStatusPatchRequest(BaseModel):
    status: str = Field(..., description="active | parked | resolved | verified | refuted | blocked | collapsed")


class KnowledgeMapNodePatchResponse(BaseModel):
    ok: bool = True
    node: dict[str, Any] | None = None
    graphVersion: int = 0


class SessionArtifactsResponse(BaseModel):
    sessionKey: str
    threadId: str | None = None
    items: list[dict[str, Any]] = Field(default_factory=list)


def _knowledge_map_payload(*, thread_id: str, session_key: str = "") -> KnowledgeMapResponse:
    from evoflow.persistence.exploration_graph_repositories import (
        load_graph_snapshot_for_session,
        resolve_scope_thread_id,
    )

    snap = load_graph_snapshot_for_session(session_key, thread_id=thread_id)
    scope = str(snap.get("thread_id") or "").strip() or resolve_scope_thread_id(thread_id)
    header = snap.get("header") if isinstance(snap.get("header"), dict) else None
    return KnowledgeMapResponse(
        threadId=scope or thread_id.strip(),
        sessionKey=session_key,
        header=header,
        nodes=list(snap.get("nodes") or []),
        edges=list(snap.get("edges") or []),
        graphVersion=int((header or {}).get("graph_version") or 0),
        nodeCount=int((header or {}).get("node_count") or 0),
        edgeCount=int((header or {}).get("edge_count") or 0),
    )


@router.get(
    "/{session_key:path}/tool-results/{tool_call_id}",
    response_model=ToolResultFullResponse,
    summary="Fetch full tool output (lazy UI expand)",
)
async def get_session_tool_result(request: Request, session_key: str, tool_call_id: str) -> ToolResultFullResponse:
    key = _require_session_access(request, session_key)
    key = session_key.strip()
    tcid = str(tool_call_id or "").strip()
    if not key or not tcid:
        raise HTTPException(status_code=422, detail="session_key and tool_call_id required")
    if sess_repo.is_session_deleted(key):
        raise HTTPException(status_code=404, detail="session not found")
    try:
        payload = msg_repo.get_tool_result_for_display(key, tcid)
    except sqlite3.OperationalError as e:
        busy = _transcript_db_busy_http(e)
        if busy:
            raise busy
        raise
    if not payload:
        raise HTTPException(status_code=404, detail="tool result not found")
    return ToolResultFullResponse(**payload)


@router.get(
    "/{session_key:path}/pending-clarification",
    response_model=ToolResultFullResponse | None,
    summary="Pending ask_clarification for session sidebar (authoritative DB scan)",
)
async def get_session_pending_clarification(request: Request, session_key: str) -> ToolResultFullResponse | None:
    key = _require_session_access(request, session_key)
    key = session_key.strip()
    if not key:
        raise HTTPException(status_code=422, detail="session_key required")
    if sess_repo.is_session_deleted(key):
        return None
    try:
        payload = msg_repo.get_pending_clarification_for_session(key)
    except sqlite3.OperationalError as e:
        busy = _transcript_db_busy_http(e)
        if busy:
            raise busy
        raise
    if not payload:
        return None
    return ToolResultFullResponse(**payload)


class ManualContextCompactionResponse(BaseModel):
    ok: bool = True
    changed: bool = False
    reason: str = ""
    beforeGateTokens: int = 0
    afterGateTokens: int = 0
    beforeMessageCount: int = 0
    afterMessageCount: int = 0
    contextUsage: dict[str, Any] = Field(default_factory=dict)
    persistedSummary: bool = False


@router.post(
    "/{session_key:path}/compact-context",
    response_model=ManualContextCompactionResponse,
    summary="Manually compact session context (same pipeline as automatic compaction)",
)
async def compact_session_context(request: Request, session_key: str) -> ManualContextCompactionResponse:
    key = _require_session_access(request, session_key)
    from evoflow.agents.manual_context_compaction import ManualCompactionError, run_manual_context_compaction

    key = session_key.strip()
    if not key:
        raise HTTPException(status_code=422, detail="session_key required")
    if sess_repo.is_session_deleted(key):
        raise HTTPException(status_code=404, detail="session not found")
    row = sess_repo.get_session_row_for_ui(key)
    if not row:
        raise HTTPException(status_code=404, detail="session not found")
    try:
        result = await run_manual_context_compaction(key, session_row=row)
    except ManualCompactionError as e:
        raise HTTPException(status_code=e.status_code, detail=str(e)) from e
    except sqlite3.OperationalError as e:
        busy = _transcript_db_busy_http(e)
        if busy:
            raise busy
        raise
    return ManualContextCompactionResponse(
        ok=result.ok,
        changed=result.changed,
        reason=result.reason,
        beforeGateTokens=result.before_gate_tokens,
        afterGateTokens=result.after_gate_tokens,
        beforeMessageCount=result.before_message_count,
        afterMessageCount=result.after_message_count,
        contextUsage=result.context_usage,
        persistedSummary=result.persisted_summary,
    )


@router.get(
    "/{session_key:path}/knowledge-map",
    response_model=KnowledgeMapResponse,
    summary="Session knowledge/logic mind map (nodes/edges)",
)
async def get_session_knowledge_map(request: Request, session_key: str) -> KnowledgeMapResponse:
    key = _require_session_access(request, session_key)
    key = session_key.strip()
    if not key:
        raise HTTPException(status_code=422, detail="session_key required")
    if sess_repo.is_session_deleted(key):
        raise HTTPException(status_code=404, detail="session not found")
    row = sess_repo.get_session_row_for_ui(key)
    if not row:
        raise HTTPException(status_code=404, detail="session not found")
    tid = str(row.get("threadId") or row.get("thread_id") or "").strip()
    return _knowledge_map_payload(thread_id=tid, session_key=key)


@router.get(
    "/{session_key:path}/artifacts",
    response_model=SessionArtifactsResponse,
    summary="List session chat deliverables (append-ordered)",
)
async def get_session_artifacts(request: Request, session_key: str) -> SessionArtifactsResponse:
    key = _require_session_access(request, session_key)
    key = session_key.strip()
    if not key:
        raise HTTPException(status_code=422, detail="session_key required")
    if sess_repo.is_session_deleted(key):
        raise HTTPException(status_code=404, detail="session not found")
    row = sess_repo.get_session_row_for_ui(key)
    if not row:
        raise HTTPException(status_code=404, detail="session not found")
    tid = str(row.get("threadId") or row.get("thread_id") or "").strip() or None

    def _load() -> list[dict[str, Any]]:
        from evoflow.persistence.artifact_repositories import list_session_artifacts

        return list_session_artifacts(key)

    try:
        items = await run_db(_load)
    except sqlite3.OperationalError as e:
        busy = _transcript_db_busy_http(e)
        if busy:
            raise busy
        raise
    return SessionArtifactsResponse(sessionKey=key, threadId=tid, items=items)


@router.get(
    "/by-thread/{thread_id}/knowledge-map",
    response_model=KnowledgeMapResponse,
    summary="Knowledge/logic mind map snapshot by LangGraph thread_id",
)
async def get_knowledge_map_by_thread(thread_id: str) -> KnowledgeMapResponse:
    tid = thread_id.strip()
    if not tid:
        raise HTTPException(status_code=422, detail="thread_id required")
    sk = sess_repo.find_session_key_by_thread_id(tid) or ""
    return _knowledge_map_payload(thread_id=tid, session_key=sk)


@router.patch(
    "/{session_key:path}/knowledge-map/nodes/{external_id:path}",
    response_model=KnowledgeMapNodePatchResponse,
    summary="User patch mind map node status (evopanel)",
)
async def patch_session_knowledge_map_node_status(request: Request, 
    session_key: str,
    external_id: str,
    body: KnowledgeMapNodeStatusPatchRequest,
) -> KnowledgeMapNodePatchResponse:
    key = _require_session_access(request, session_key)
    from evoflow.exploration_graph.node_status import is_user_patchable_status, normalize_node_status
    from evoflow.persistence.exploration_graph_repositories import (
        get_graph_header,
        resolve_mind_map_thread_id,
        user_patch_node_status,
    )

    key = session_key.strip()
    eid = str(external_id or "").strip()
    if not key or not eid:
        raise HTTPException(status_code=422, detail="session_key and external_id required")
    st = normalize_node_status(body.status)
    if not is_user_patchable_status(st):
        raise HTTPException(status_code=422, detail=f"unsupported status: {body.status}")
    if sess_repo.is_session_deleted(key):
        raise HTTPException(status_code=404, detail="session not found")
    row = sess_repo.get_session_row_for_ui(key)
    if not row:
        raise HTTPException(status_code=404, detail="session not found")
    tid = str(row.get("threadId") or row.get("thread_id") or "").strip()
    scope = resolve_mind_map_thread_id(tid, session_key=key)
    if not scope:
        raise HTTPException(status_code=404, detail="mind map not found for session")
    try:
        node = user_patch_node_status(scope, eid, st, session_key=key)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except sqlite3.OperationalError as e:
        busy = _transcript_db_busy_http(e)
        if busy:
            raise busy
        raise
    if node is None:
        raise HTTPException(status_code=404, detail="node not found")
    header = get_graph_header(scope)
    return KnowledgeMapNodePatchResponse(
        ok=True,
        node=node.model_dump(mode="json"),
        graphVersion=int(header.graph_version if header else 0),
    )


@router.get("/{session_key:path}/messages", response_model=MessagesListResponse, summary="List session transcript")
async def list_session_messages(
    request: Request,
    session_key: str,
    limit: int = Query(default=40, ge=1, le=200),
    before_seq: int | None = Query(default=None, ge=1, description="Load older rows strictly before this seq"),
    all: bool = Query(default=False, description="Return full session transcript in one response"),
    for_model: bool = Query(default=False, description="LangGraph input.messages shape"),
) -> MessagesListResponse:
    key = _require_session_access(request, session_key)
    if await run_db(sess_repo.is_session_deleted, key):
        raise HTTPException(status_code=404, detail="session not found")
    if for_model:
        messages = await run_db(msg_repo.list_messages_for_model_input, key, limit=None)
        source = "evoflow_chat_messages"
        message_count = await run_db(msg_repo.count_lead_messages, key)
        return MessagesListResponse(
            sessionKey=key,
            messages=messages,
            messageCount=message_count,
            source=source,
            hasMore=False,
            oldestSeq=None,
        )
    if all:
        if before_seq is not None:
            raise HTTPException(status_code=422, detail="all incompatible with before_seq")
        page = await run_db(msg_repo.list_messages_for_display_all, key)
        messages = list(page.get("messages") or [])
        return MessagesListResponse(
            sessionKey=key,
            messages=messages,
            messageCount=await run_db(msg_repo.count_lead_messages, key),
            source="evoflow_chat_messages",
            hasMore=False,
            oldestSeq=None,
        )
    if before_seq is not None:
        page = await run_db(
            msg_repo.list_messages_for_display_paginated,
            key,
            limit=limit,
            before_seq=before_seq,
        )
        messages = list(page.get("messages") or [])
        return MessagesListResponse(
            sessionKey=key,
            messages=messages,
            messageCount=await run_db(msg_repo.count_lead_messages, key),
            source="evoflow_chat_messages",
            hasMore=bool(page.get("has_more")),
            oldestSeq=page.get("oldest_seq"),
        )
    page = await run_db(msg_repo.list_messages_for_display_paginated, key, limit=limit)
    messages = list(page.get("messages") or [])
    if messages:
        return MessagesListResponse(
            sessionKey=key,
            messages=messages,
            messageCount=await run_db(msg_repo.count_lead_messages, key),
            source="evoflow_chat_messages",
            hasMore=bool(page.get("has_more")),
            oldestSeq=page.get("oldest_seq"),
        )
    messages, source = await run_db(msg_repo.list_messages_for_display_with_im_fallback, key, limit=limit)
    return MessagesListResponse(
        sessionKey=key,
        messages=messages,
        messageCount=await run_db(msg_repo.count_lead_messages, key),
        source=source,
        hasMore=False,
        oldestSeq=None,
    )


@router.get("/{session_key:path}/live-run", summary="Read lightweight live snapshot for an in-progress session run")
async def get_live_run_snapshot(request: Request, session_key: str) -> dict[str, Any]:
    key = _require_session_access(request, session_key)
    from app.gateway.db_async import run_db
    from evoflow.persistence import live_run_repositories as live_repo

    key = session_key.strip()
    if not key:
        raise HTTPException(status_code=422, detail="session_key required")

    def _read() -> dict[str, Any]:
        if sess_repo.is_session_deleted(key):
            return {"deleted": True}
        return {"deleted": False, "snapshot": live_repo.get_live_run_snapshot(key)}

    result = await run_db(_read)
    if result.get("deleted"):
        raise HTTPException(status_code=404, detail="session not found")
    return {"ok": True, "sessionKey": key, "snapshot": result.get("snapshot")}


@router.put("/{session_key:path}/live-run", summary="Upsert lightweight live snapshot for an in-progress session run")
async def put_live_run_snapshot(request: Request, session_key: str, body: LiveRunSnapshotBody) -> dict[str, Any]:
    key = _require_session_access(request, session_key)
    from app.gateway.db_async import run_db
    from evoflow.persistence import live_run_repositories as live_repo

    key = session_key.strip()
    if not key:
        raise HTTPException(status_code=422, detail="session_key required")

    def _write() -> dict[str, Any]:
        if sess_repo.is_session_deleted(key):
            return {"deleted": True}
        snapshot = live_repo.upsert_live_run_snapshot(
            key,
            run_id=body.runId,
            thread_id=body.threadId,
            status=body.status,
            partial_text=body.partialText,
            partial_tools=body.partialTools,
            partial_display_segments=body.partialDisplaySegments,
            last_event_at_ms=body.lastEventAtMs,
        )
        return {"deleted": False, "snapshot": snapshot}

    result = await run_db(_write)
    if result.get("deleted"):
        raise HTTPException(status_code=404, detail="session not found")
    return {"ok": True, "sessionKey": key, "snapshot": result.get("snapshot")}


@router.delete("/{session_key:path}/live-run", summary="Clear lightweight live snapshot for a session run")
async def delete_live_run_snapshot(request: Request, session_key: str) -> dict[str, Any]:
    key = _require_session_access(request, session_key)
    from app.gateway.db_async import run_db
    from evoflow.persistence import live_run_repositories as live_repo

    key = session_key.strip()
    if not key:
        raise HTTPException(status_code=422, detail="session_key required")

    def _delete() -> dict[str, Any]:
        if sess_repo.is_session_deleted(key):
            return {"deleted": True}
        return {"deleted": False, "deleted_snapshot": live_repo.delete_live_run_snapshot(key)}

    result = await run_db(_delete)
    if result.get("deleted"):
        raise HTTPException(status_code=404, detail="session not found")
    return {"ok": True, "sessionKey": key, "deleted": result.get("deleted_snapshot")}


@router.post("/{session_key:path}/heartbeat", summary="Frontend heartbeat: update last_event_at for live run")
async def session_heartbeat(request: Request, session_key: str) -> dict[str, Any]:
    """R2-1: Frontend sends this when returning from background to signal it's still alive.

    Updates evoflow_chat_live_runs.last_event_at to current time, preventing
    backend from treating the run as stale during frontend background periods.
    """
    key = _require_session_access(request, session_key)
    from evoflow.persistence.live_run_repositories import update_live_run_heartbeat

    key = session_key.strip()
    if not key:
        raise HTTPException(status_code=422, detail="session_key required")

    last_event_at_ms = update_live_run_heartbeat(key)
    return {"ok": True, "sessionKey": key, "lastEventAtMs": last_event_at_ms}


@router.get("/{session_key:path}/live-run/check", summary="Check if live run was completed")
async def check_live_run_completed(request: Request, session_key: str) -> dict[str, Any]:
    """R2-2: Check if a live run was completed while frontend was in background.

    Returns completion status so frontend can refresh messages instead of
    attempting to resume a dead stream.
    """
    key = _require_session_access(request, session_key)
    from evoflow.persistence.live_run_repositories import get_live_run_snapshot

    key = session_key.strip()
    if not key:
        raise HTTPException(status_code=422, detail="session_key required")

    snapshot = get_live_run_snapshot(key)
    if not snapshot:
        return {"completed": False, "status": None, "runId": None}

    status = str(snapshot.get("status") or "").strip().lower()
    completed = status.startswith("completed_")

    return {
        "completed": completed,
        "status": status,
        "runId": snapshot.get("runId"),
    }


@router.get("/{session_key:path}/execution/state", summary="Session run status (evoflow_chat_sessions only)")
async def get_session_execution_state(request: Request, session_key: str) -> dict[str, Any]:
    key = _require_session_access(request, session_key)
    from evoflow.session_execution import build_session_execution_state

    key = session_key.strip()
    if not key:
        raise HTTPException(status_code=422, detail="session_key required")
    try:
        return await build_session_execution_state(key)
    except ValueError as exc:
        msg = str(exc)
        if "not found" in msg:
            raise HTTPException(status_code=404, detail=msg) from exc
        raise HTTPException(status_code=422, detail=msg) from exc


@router.get("/{session_key:path}/runtime-status", summary="Aggregated session runtime recovery status (deprecated — prefer execution/state)")
async def get_session_runtime_status(request: Request, session_key: str) -> dict[str, Any]:
    """Backward-compatible alias for ``GET .../execution/state`` (SQLite read model)."""
    key = _require_session_access(request, session_key)
    from evoflow.session_execution import build_session_execution_state
    try:
        return await build_session_execution_state(key)
    except ValueError as exc:
        msg = str(exc)
        if "not found" in msg:
            raise HTTPException(status_code=404, detail=msg) from exc
        raise HTTPException(status_code=422, detail=msg) from exc


_VALID_APPEND_ROLES = frozenset({"user", "assistant", "tool"})
# HTTP clients (EvoPanel) may only append user rows; assistant/tool → TranscriptMiddleware.
_CLIENT_HTTP_APPEND_ROLES = frozenset({"user"})
_MAX_APPEND_CONTENT_BYTES = 256 * 1024  # 256 KiB per message content


def _validate_append_body(role: str, content: Any) -> None:
    """Validate role and content size for transcript append endpoints."""
    r = str(role or "").strip().lower()
    if r not in _VALID_APPEND_ROLES:
        raise HTTPException(status_code=422, detail=f"role must be one of {sorted(_VALID_APPEND_ROLES)}, got: {role!r}")
    try:
        raw = json.dumps(content, ensure_ascii=False) if content is not None else ""
    except (TypeError, ValueError):
        raw = str(content)
    if len(raw.encode("utf-8")) > _MAX_APPEND_CONTENT_BYTES:
        raise HTTPException(status_code=413, detail=f"content too large (max {_MAX_APPEND_CONTENT_BYTES} bytes)")


def _validate_client_http_append_role(role: str) -> None:
    r = str(role or "").strip().lower()
    if r not in _CLIENT_HTTP_APPEND_ROLES:
        raise HTTPException(
            status_code=422,
            detail=(
                "client may only append user messages; "
                "assistant/tool transcript is written by TranscriptMiddleware"
            ),
        )


def _flat_append_kwargs(body: AppendMessageBody) -> dict[str, Any]:
    return {
        "message_id": body.messageId,
        "content_json": body.contentJson,
        "tool_call_id": body.toolCallId,
        "tool_name": body.toolName,
        "model_name": body.modelName,
        "input_tokens": body.inputTokens,
        "output_tokens": body.outputTokens,
        "total_tokens": body.totalTokens,
    }


@router.post("/{session_key:path}/messages", summary="Append one transcript message")
async def append_session_message(request: Request, session_key: str, body: AppendMessageBody) -> dict[str, Any]:
    key = _require_session_access(request, session_key)
    if sess_repo.is_session_deleted(key):
        raise HTTPException(status_code=404, detail="session not found")
    _validate_client_http_append_role(body.role)
    _validate_append_body(body.role, body.content)
    uid = _request_principal_id(request)
    try:
        result = chat_svc.append_message_and_touch_session(
            key,
            role=body.role,
            content=body.content,
            run_id=body.runId,
            thread_id=body.threadId,
            parent_thread_id=body.parentThreadId,
            principal_id=uid,
            **_flat_append_kwargs(body),
        )
    except sqlite3.OperationalError as e:
        busy = _transcript_db_busy_http(e)
        if busy:
            raise busy from e
        logger.exception("append_session_message sqlite error session_key=%s", key)
        raise HTTPException(status_code=500, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    if result is None:
        return {"ok": True, "skipped": True, "messageCount": msg_repo.count_messages(key)}
    return {"ok": True, **result}


@router.post("/{session_key:path}/messages/batch", summary="Append transcript messages (flat columns, dedupe by messageId)")
async def append_session_messages_batch(request: Request, session_key: str, body: AppendMessagesBatchBody) -> dict[str, Any]:
    key = _require_session_access(request, session_key)
    if sess_repo.is_session_deleted(key):
        raise HTTPException(status_code=404, detail="session not found")
    for item in body.messages:
        if isinstance(item, dict):
            role = str(item.get("role", ""))
            _validate_client_http_append_role(role)
            _validate_append_body(role, item.get("content"))
    try:
        result = chat_svc.append_messages_batch_and_touch_session(
            key,
            body.messages,
            run_id=body.runId,
            thread_id=body.threadId,
            principal_id=_request_principal_id(request),
        )
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    return {"ok": True, **result}


# ── Pending inject (mid-turn ↑ steering) ─────────────────────────────────────


class PendingInjectBody(BaseModel):
    content: Any | None = None
    contentJson: dict[str, Any] | None = None
    messageId: str | None = None
    toolName: str | None = None
    runId: str | None = None
    threadId: str | None = None


@router.post(
    "/{session_key:path}/pending-inject",
    summary="Enqueue a user message for mid-turn injection (↑ immediate)",
)
async def enqueue_pending_inject(request: Request, session_key: str, body: PendingInjectBody) -> dict[str, Any]:
    """Enqueue a user message into the pending-inject queue.

    The message is NOT written directly into ``evoflow_chat_messages``.
    Instead it is held in a **process-local** pending queue (native-style);
    the next ``before_model`` hydration pass drains it into the transcript
    with proper seq ordering. Restart / refresh drops unconsumed steers.
    """
    key = _require_session_access(request, session_key)
    key = session_key.strip()
    if not key:
        raise HTTPException(status_code=422, detail="session_key required")
    if sess_repo.is_session_deleted(key):
        raise HTTPException(status_code=404, detail="session not found")

    # Generate a message_id if the client didn't supply one.
    import uuid as _uuid

    mid = str(body.messageId or "").strip() or f"user-inject-{_uuid.uuid4()}"

    # Validate content size (same limit as regular append).
    content_val = body.contentJson if body.contentJson is not None else body.content
    _validate_append_body("user", content_val)

    try:
        from evoflow.persistence.pending_inject_repository import enqueue_pending_inject

        result = enqueue_pending_inject(
            key,
            message_id=mid,
            content=body.content,
            content_json=body.contentJson,
            role="user",
            tool_name=body.toolName,
            run_id=body.runId,
            thread_id=body.threadId,
        )
    except Exception as e:
        logger.exception("pending_inject enqueue failed session_key=%s", key)
        raise HTTPException(status_code=500, detail=str(e)) from e

    if result is None:
        # Already queued (deduplicated).
        return {"ok": True, "enqueued": False, "messageId": mid}
    return {
        "ok": True,
        "enqueued": True,
        "messageId": mid,
        "id": result.get("id"),
    }


@router.get(
    "/{session_key:path}/pending-inject/status",
    summary="Get pending-inject queue status for a session",
)
async def get_pending_inject_status(request: Request, session_key: str) -> dict[str, Any]:
    """Return unconsumed steers + last consumed info (runtime pending_steers mirror).

    Used by the frontend to:
    - restore composer preview after refresh / session switch
    - decide whether a ↑ message was already seen by the model
    - know whether to trigger a follow-up run after the current turn ends
    """
    key = _require_session_access(request, session_key)
    key = session_key.strip()
    if not key:
        raise HTTPException(status_code=422, detail="session_key required")
    if sess_repo.is_session_deleted(key):
        raise HTTPException(status_code=404, detail="session not found")

    try:
        from evoflow.persistence.pending_inject_repository import (
            count_unconsumed_pending_injects,
            list_unconsumed_pending_injects,
            pending_inject_last_consumed_info,
        )

        pending_count = count_unconsumed_pending_injects(key)
        last_consumed = pending_inject_last_consumed_info(key)
        items_raw = list_unconsumed_pending_injects(key)
    except Exception:
        logger.exception("pending_inject status query error session_key=%s", key)
        raise HTTPException(status_code=500, detail="internal error")

    # Normalize nested keys to camelCase (defensive if repo returns snake_case).
    if isinstance(last_consumed, dict):
        last_consumed = {
            "messageId": last_consumed.get("messageId") or last_consumed.get("message_id"),
            "consumedAt": last_consumed.get("consumedAt") or last_consumed.get("consumed_at"),
            "consumedByRunId": last_consumed.get("consumedByRunId")
            or last_consumed.get("consumed_by_run_id"),
        }

    items = [
        {
            "messageId": str(it.get("message_id") or "").strip(),
            "text": str(it.get("text") or "").strip(),
            "createdAt": it.get("created_at"),
            "runId": it.get("run_id"),
        }
        for it in items_raw
        if str(it.get("message_id") or "").strip()
    ]

    return {
        "ok": True,
        "sessionKey": key,
        "pendingCount": pending_count,
        "items": items,
        "lastConsumed": last_consumed,
    }


@router.post(
    "/{session_key:path}/pending-inject/restore",
    summary="Pop unconsumed steers for interrupt→composer restore (runtime-aligned)",
)
async def restore_pending_injects(request: Request, session_key: str) -> dict[str, Any]:
    """Clear Core-equivalent pending queue and return texts for the composer.

    runtime interrupt clears ``pending_input``; the TUI restores steers to the
    composer. We delete unconsumed SQLite rows so the next turn does not
    drain them again after the user already has them in the input box.
    """
    key = _require_session_access(request, session_key)
    key = session_key.strip()
    if not key:
        raise HTTPException(status_code=422, detail="session_key required")
    if sess_repo.is_session_deleted(key):
        raise HTTPException(status_code=404, detail="session not found")

    try:
        from evoflow.persistence.pending_inject_repository import pop_unconsumed_pending_injects

        items_raw = pop_unconsumed_pending_injects(key)
    except Exception:
        logger.exception("pending_inject restore error session_key=%s", key)
        raise HTTPException(status_code=500, detail="internal error")

    items = [
        {
            "messageId": str(it.get("message_id") or "").strip(),
            "text": str(it.get("text") or "").strip(),
        }
        for it in items_raw
        if str(it.get("text") or "").strip()
    ]
    return {"ok": True, "sessionKey": key, "restored": items, "count": len(items)}


@router.post("/{session_key:path}/ensure-thread", summary="Ensure LangGraph execution thread for session")
async def ensure_session_thread(
    request: Request,
    session_key: str,
    force_recreate: bool = Query(
        default=False,
        description="Probe LangGraph and rebuild the thread when the persisted one is missing (after stream 404)",
    ),
) -> dict[str, Any]:
    import time as _time

    key = _require_session_access(request, session_key)
    if sess_repo.is_session_deleted(key):
        raise HTTPException(status_code=404, detail="session not found")
    _t0 = _time.perf_counter()
    try:
        thread_id = await chat_svc.ensure_session_thread(key, force_recreate=force_recreate)
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    _ensure_ms = round((_time.perf_counter() - _t0) * 1000.0, 2)
    # Hot path: do not COUNT(*) the transcript on every ensure-thread (old/long
    # sessions were paying multi-second TTFT here). Prefer denormalized row count.
    row = sess_repo.load_session_map().get(key) or {}
    message_count = int(row.get("messageCount") or 0)
    try:
        from evoflow.observability.run_latency_trace import write_run_latency_event

        write_run_latency_event(
            str(thread_id or ""),
            "ensure_thread",
            {
                "session_key": key,
                "duration_ms": _ensure_ms,
                "message_count": message_count,
                "message_count_source": "session_row",
            },
        )
    except Exception:
        pass
    return {
        "ok": True,
        "sessionKey": key,
        "threadId": thread_id,
        "messageCount": message_count,
    }


@router.post(
    "/{session_key:path}/prime-hydration",
    summary="Prime process-local transcript hydration cache (no LLM run)",
)
async def prime_session_hydration(request: Request, session_key: str) -> dict[str, Any]:
    """Warm ensure-thread + hydration watermark so the next before_model may skip rebuild."""
    key = _require_session_access(request, session_key)
    key = session_key.strip()
    if not key:
        raise HTTPException(status_code=422, detail="session_key required")
    if sess_repo.is_session_deleted(key):
        raise HTTPException(status_code=404, detail="session not found")
    try:
        thread_id = await chat_svc.ensure_session_thread(key)
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    try:
        from evoflow.agents.middlewares.session_transcript_hydration_middleware import (
            prime_hydration_cache_for_session,
        )

        result = await run_db(
            prime_hydration_cache_for_session,
            key,
            thread_id=thread_id,
        )
    except Exception as e:
        logger.exception("prime-hydration failed session_key=%s", key)
        raise HTTPException(status_code=500, detail=f"prime-hydration failed: {e}") from e
    out = dict(result or {})
    out.setdefault("ok", True)
    out["sessionKey"] = key
    out["threadId"] = thread_id
    return out


@router.post("/{session_key:path}/bind-thread", summary="Bind task/collab LangGraph thread to session")
async def bind_session_thread(
    request: Request, session_key: str, body: BindThreadBody
) -> dict[str, Any]:
    key = _require_session_access(request, session_key)
    if sess_repo.is_session_deleted(key):
        raise HTTPException(status_code=404, detail="session not found")
    try:
        result = chat_svc.bind_session_thread(key, body.threadId.strip(), context=body.context)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    return result


class RunActiveBody(BaseModel):
    runId: str
    threadId: str | None = None


@router.post("/{session_key:path}/run-active", summary="Bind current LangGraph run id to session (for transcript + checkpoint sync)")
async def mark_session_run_active(request: Request, session_key: str, body: RunActiveBody) -> dict[str, Any]:
    key = _require_session_access(request, session_key)
    from evoflow.session_execution import start_session_turn

    key = session_key.strip()
    rid = str(body.runId or "").strip()
    if not key or not rid:
        raise HTTPException(status_code=422, detail="session_key and runId required")
    if sess_repo.is_session_deleted(key):
        raise HTTPException(status_code=404, detail="session not found")
    row_before = sess_repo.get_session_row_for_ui(key) or {}
    existing_rid = str(row_before.get("current_run_id") or row_before.get("currentRunId") or "").strip()
    start_session_turn(
        session_key=key,
        thread_id=str(body.threadId or "").strip() or None,
        run_id=rid,
        source="run_active_api",
    )
    tid = str(body.threadId or "").strip() or None
    if tid and existing_rid != rid:
        try:
            from app.gateway.streaming.stream_mirror import clear_mirror_for_thread

            clear_mirror_for_thread(tid, session_key=key)
        except Exception:
            pass
    row = sess_repo.get_session_row_for_ui(key)
    return {"ok": True, "sessionKey": key, "runId": rid, "session": row}


@router.post("/{session_key:path}/execution/stop", summary="Stop session execution (LangGraph cancel + idle + partial persist)")
async def stop_session_execution_route(
    request: Request,
    session_key: str,
    userInitiated: bool = Query(default=True, description="False = chatSend prep (cancel current run only)"),
) -> dict[str, Any]:
    from evoflow.session_execution import stop_session_execution

    key = _require_session_access(request, session_key)
    if sess_repo.is_session_deleted(key):
        raise HTTPException(status_code=404, detail="session not found")
    try:
        result = await stop_session_execution(key, user_initiated=userInitiated)
    except ValueError as exc:
        msg = str(exc)
        if "not found" in msg:
            raise HTTPException(status_code=404, detail=msg) from exc
        raise HTTPException(status_code=422, detail=msg) from exc
    return {
        "ok": result.ok,
        "sessionKey": result.session_key,
        "runId": result.run_id,
        "phase": result.phase,
        "cancelledRunIds": result.cancelled_run_ids,
        "session": result.session,
    }


@router.post("/{session_key:path}/run-idle", summary="Mark session run_status idle (deprecated — prefer execution/stop)")
async def mark_session_run_idle(request: Request, session_key: str) -> dict[str, Any]:
    key = _require_session_access(request, session_key)
    from evoflow.session_execution import mark_session_idle

    key = session_key.strip()
    if not key:
        raise HTTPException(status_code=422, detail="session_key required")
    if sess_repo.is_session_deleted(key):
        raise HTTPException(status_code=404, detail="session not found")
    result = await mark_session_idle(key)
    return {"ok": True, "sessionKey": key, "session": result.session}


@router.post("/{session_key:path}/reset", summary="Reset session: clear transcript + new LangGraph thread")
async def reset_chat_session(request: Request, session_key: str) -> dict[str, Any]:
    key = _require_session_access(request, session_key)
    try:
        return await chat_svc.reset_session_full(key)
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e


@router.post(
    "/{session_key:path}/truncate",
    summary="Truncate transcript from a message (in-place edit rewind; same session)",
)
async def truncate_chat_session(request: Request, session_key: str, body: TruncateSessionBody) -> dict[str, Any]:
    key = _require_session_access(request, session_key)
    mid = str(body.fromMessageId or "").strip()
    if not mid:
        raise HTTPException(status_code=422, detail="fromMessageId required")
    try:
        return await chat_svc.truncate_session_from_message(key, from_message_id=mid)
    except ValueError as e:
        msg = str(e) or "truncate failed"
        status = 404 if "not found" in msg.lower() else 422
        raise HTTPException(status_code=status, detail=msg) from e
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e


@router.post(
    "/{session_key:path}/fork",
    summary="Fork session: copy transcript into a new session (parent unchanged)",
)
async def fork_chat_session(
    request: Request, session_key: str, body: ForkSessionBody | None = None
) -> dict[str, Any]:
    key = _require_session_access(request, session_key)
    payload = body or ForkSessionBody()
    try:
        return await chat_svc.fork_session_full(
            key,
            through_seq=payload.throughSeq,
            through_message_id=payload.throughMessageId,
            before_message_id=payload.beforeMessageId,
            title=payload.title,
        )
    except ValueError as e:
        msg = str(e) or "fork failed"
        status = 404 if "not found" in msg.lower() else 422
        raise HTTPException(status_code=status, detail=msg) from e
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e


@router.patch("/{session_key:path}/pin", summary="Pin or unpin session in sidebar")
async def patch_session_pin(request: Request, session_key: str, body: SessionPinBody) -> dict[str, Any]:
    key = _require_session_access(request, session_key)
    if sess_repo.is_session_deleted(key):
        raise HTTPException(status_code=404, detail="session not found")
    sess_repo.set_session_pinned(key, pinned=bool(body.pinned))
    row = sess_repo.get_session_row_for_ui(key)
    return {"ok": True, "sessionKey": key, "session": row}


@router.patch(
    "/{session_key:path}/hidden",
    summary="Hide or show session in the main sidebar list",
)
async def patch_session_hidden(request: Request, session_key: str, body: SessionHiddenBody) -> dict[str, Any]:
    key = _require_session_access(request, session_key)
    if sess_repo.is_session_deleted(key):
        raise HTTPException(status_code=404, detail="session not found")
    sess_repo.set_session_hidden_from_list(key, hidden=bool(body.hidden))
    row = sess_repo.get_session_row_for_ui(key)
    return {"ok": True, "sessionKey": key, "session": row}


@router.patch("/{session_key:path}/title", summary="Rename session (sidebar title)")
async def patch_session_title(request: Request, session_key: str, body: SessionTitleBody) -> dict[str, Any]:
    key = _require_session_access(request, session_key)
    title = str(body.title or "").strip()
    if not key or not title:
        raise HTTPException(status_code=422, detail="session_key and title required")
    if sess_repo.is_session_deleted(key):
        raise HTTPException(status_code=404, detail="session not found")
    sess_repo.update_session_title(key, title)
    row = sess_repo.get_session_row_for_ui(key)
    return {"ok": True, "sessionKey": key, "session": row}


@router.put("/pinned-order", summary="Reorder pinned sessions (drag)")
async def put_pinned_session_order(body: PinnedOrderBody) -> dict[str, Any]:
    keys = [str(k or "").strip() for k in (body.sessionKeys or []) if str(k or "").strip()]
    if not keys:
        raise HTTPException(status_code=422, detail="sessionKeys required")
    sess_repo.reorder_pinned_sessions(keys)
    rows = sess_repo.list_sessions_for_ui(limit=max(20, len(keys) + 5))
    return {"ok": True, "sessions": rows}


@router.get(
    "/{session_key:path}/workspace-history",
    response_model=WorkspaceHistoryResponse,
    summary="List workspace paths bound to this session (most recent first)",
)
async def get_session_workspace_history(request: Request, session_key: str) -> WorkspaceHistoryResponse:
    key = _require_session_access(request, session_key)
    if sess_repo.is_session_deleted(key):
        raise HTTPException(status_code=404, detail="session not found")
    ws_repo.import_session_current_to_history_if_empty(key)
    paths = ws_repo.list_session_workspace_paths(key)
    current = ws_repo.get_session_current_workspace(key)
    return WorkspaceHistoryResponse(sessionKey=key, paths=paths, currentPath=current)


@router.put(
    "/{session_key:path}/workspace-history",
    response_model=WorkspaceHistoryResponse,
    summary="Replace session workspace history list",
)
async def put_session_workspace_history(
    request: Request,
    session_key: str,
    body: WorkspaceHistoryPutBody,
) -> WorkspaceHistoryResponse:
    key = _require_session_access(request, session_key)
    if sess_repo.is_session_deleted(key):
        raise HTTPException(status_code=404, detail="session not found")
    from evoflow.authz.http_guard import require_workspace_path_visible
    from evoflow.authz.resource_visibility import stamp_kwargs_from_request

    stamp = stamp_kwargs_from_request(request)
    for p in body.paths or []:
        ps = str(p or "").strip()
        if ps:
            require_workspace_path_visible(request, ps)
    paths = ws_repo.set_session_workspace_paths(key, body.paths or [], stamp=stamp or None)
    current = ws_repo.get_session_current_workspace(key)
    return WorkspaceHistoryResponse(sessionKey=key, paths=paths, currentPath=current)


@router.post(
    "/{session_key:path}/workspace-bind",
    response_model=WorkspaceHistoryResponse,
    summary="Bind workspace path to session (history + current)",
)
async def bind_session_workspace(
    request: Request,
    session_key: str,
    body: BindWorkspaceBody,
) -> WorkspaceHistoryResponse:
    """Bind local workspace root for a chat session (EvoPanel sidebar). Required before terminal/read/write tools."""
    key = _require_session_access(request, session_key)
    path = str(body.path or "").strip()
    if not key or not path:
        raise HTTPException(status_code=422, detail="session_key and path required")
    if sess_repo.is_session_deleted(key):
        raise HTTPException(status_code=404, detail="session not found")
    from evoflow.authz.http_guard import require_workspace_path_visible
    from evoflow.authz.resource_visibility import stamp_kwargs_from_request

    require_workspace_path_visible(request, path)
    stamp = stamp_kwargs_from_request(request)
    paths = ws_repo.touch_session_workspace(key, path, user_pinned=True, stamp=stamp or None)
    current = ws_repo.get_session_current_workspace(key)
    return WorkspaceHistoryResponse(sessionKey=key, paths=paths, currentPath=current)


@router.get(
    "/{session_key:path}",
    response_model=SessionRowResponse,
    summary="Get one chat session by key",
)
async def get_chat_session(request: Request, session_key: str) -> SessionRowResponse:
    """Load a single sidebar row (modelName / workspace / mode) without list pagination."""
    key = _require_session_access(request, session_key)
    if sess_repo.is_session_deleted(key):
        raise HTTPException(status_code=404, detail="session not found")
    row = await run_db(sess_repo.get_session_row_for_ui, key)
    if not row:
        raise HTTPException(status_code=404, detail="session not found")
    return SessionRowResponse(**row)


@router.patch("/{session_key:path}/context", summary="Update session context fields (memory_enabled, etc.)")
async def patch_session_context(
    request: Request, session_key: str, body: UpdateSessionContextBody
) -> dict[str, Any]:
    key = _require_session_access(request, session_key)
    if sess_repo.is_session_deleted(key):
        raise HTTPException(status_code=404, detail="session not found")

    prev_agent = ""
    try:
        prev_row = sess_repo.get_session_row_for_ui(key) or {}
        prev_ctx = prev_row.get("context") if isinstance(prev_row.get("context"), dict) else {}
        prev_agent = str(prev_ctx.get("agent_id") or prev_row.get("agentId") or "").strip()
    except Exception:
        prev_agent = ""

    sess_repo.upsert_session_row(key, context=body.context)
    row = sess_repo.get_session_row_for_ui(key)

    # Role switch: rewrite active/pending tool columns under the new agent allowlist.
    # Must not rely on session_key embedding (often still agent:main:…) — flat agent_id is source of truth.
    try:
        new_ctx = row.get("context") if isinstance(row, dict) and isinstance(row.get("context"), dict) else {}
        ctx_patch = body.context if isinstance(body.context, dict) else {}
        new_agent = str(
            new_ctx.get("agent_id")
            or (row.get("agentId") if isinstance(row, dict) else None)
            or ctx_patch.get("agent_id")
            or ctx_patch.get("agent_name")
            or ""
        ).strip()
        agent_touched = "agent_id" in ctx_patch or "agent_name" in ctx_patch
        if agent_touched and new_agent:
            from evoflow.session_tool_binding.agent_tools import invalidate_agent_tool_names_cache
            from evoflow.session_tool_binding.service import repair_session_tool_state

            invalidate_agent_tool_names_cache()
            repair_session_tool_state(key)
            row = sess_repo.get_session_row_for_ui(key)
            logger.info(
                "patch_session_context: repaired tools after role switch session=%s %s -> %s active=%s pending=%s",
                key,
                prev_agent or "?",
                new_agent,
                (row or {}).get("activeTools"),
                (row or {}).get("pendingTools"),
            )
    except Exception:
        logger.warning("patch_session_context: tool snapshot refresh failed", exc_info=True)

    return {"ok": True, "sessionKey": key, "session": row}


@router.delete("/{session_key:path}", summary="Delete session (transcript + LangGraph thread + local data)")
async def delete_chat_session(request: Request, session_key: str) -> dict[str, Any]:
    key = _require_session_access(request, session_key)
    try:
        return await chat_svc.delete_session_full(key)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
