"""Unified chat session lifecycle: app transcript + LangGraph thread/checkpoint + local thread data."""

from __future__ import annotations

import logging
import os
import time
from typing import Any

import httpx

from evoflow.persistence import chat_message_repositories as msg_repo
from evoflow.persistence import session_repositories as sess_repo
from evoflow.persistence.db import get_db, run_db_with_retry
from evoflow.persistence.session_context_fields import resolve_primary_model_name
from evoflow.persistence.timestamps import coerce_to_epoch_ms

logger = logging.getLogger(__name__)

__all__ = [
    # Unified write entries
    "persist_user_message",
    "append_message_and_touch_session",
    "append_messages_batch_and_touch_session",
    # Session lifecycle
    "create_new_session",
    "ensure_session_thread",
    "ensure_executor_transcript_session",
    "bind_session_thread",
    "delete_session_full",
    "reset_session_full",
    # LangGraph thread helpers
    "create_langgraph_thread",
    "delete_langgraph_thread",
    "langgraph_thread_usable",
]

# Sidebar hides these; they only host workflow/subagent executor transcripts.
EXECUTOR_SESSION_KEY_PREFIX = "agent:executor:"

# In single-process mode, LangGraph is mounted in-process at /api/langgraph on the Gateway.
# Override with EVOFLOW_LANGGRAPH_URL to use an external LangGraph instance.
LANGGRAPH_BASE_URL = os.getenv("EVOFLOW_LANGGRAPH_URL", "http://127.0.0.1:8070/api/langgraph").rstrip("/")
_HOP_BY_HOP = {"connection", "keep-alive", "host", "content-length", "transfer-encoding"}


def _timeout() -> httpx.Timeout:
    return httpx.Timeout(connect=3.0, read=15.0, write=15.0, pool=15.0)


def _now_ms() -> int:
    return int(time.time() * 1000)


def _extract_user_message_plain_text(content: Any) -> str:
    from evoflow.persistence.chat_message_content import plain_text
    from evoflow.persistence.chat_message_repositories import pack_row_from_message

    try:
        fields = pack_row_from_message(role="user", content=content)
        return plain_text(fields["payload"]).strip()
    except Exception:
        if isinstance(content, str):
            return content.strip()
        return ""


def _provisional_title_for_first_user_message(
    *,
    role: str,
    content: Any,
    existing_title: str,
    prior_user_count: int,
) -> str | None:
    if str(role or "").strip().lower() != "user":
        return None
    if prior_user_count > 0:
        return None
    if not sess_repo.is_replaceable_session_title(existing_title):
        return None
    text = _extract_user_message_plain_text(content)
    prov = sess_repo.provisional_session_title_from_user_text(text)
    return prov or None


def _session_created_at_ms(existing: dict[str, Any], *, now: int) -> int:
    """``createdAt`` from SQL may be Beijing ISO text, not epoch ms."""
    return coerce_to_epoch_ms(existing.get("createdAt"), default_ms=0) or now


def _safe_token_count(value: Any) -> int:
    if value is None or value == "":
        return 0
    if isinstance(value, (int, float)):
        return max(0, int(value))
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    return 0


def _touch_run_active_on_transcript(
    session_key: str,
    *,
    run_id: str | None,
    thread_id: str | None,
    conn: Any,
) -> None:
    """Keep ``evoflow_chat_sessions.run_status`` in sync with transcript writes."""
    from evoflow.persistence.session_run_state import peek_current_run_id
    from evoflow.session_execution.lifecycle import start_session_turn

    sk = str(session_key or "").strip()
    if not sk:
        return
    tid = str(thread_id or "").strip() or None
    rid = str(run_id or "").strip() or peek_current_run_id(session_key=sk, thread_id=tid)
    if not rid:
        return
    start_session_turn(session_key=sk, thread_id=tid, run_id=rid, conn=conn, source="transcript")


async def _langgraph_request(
    method: str,
    path: str,
    *,
    json_body: dict | None = None,
    params: dict | None = None,
) -> httpx.Response | None:
    url = f"{LANGGRAPH_BASE_URL}/{path.lstrip('/')}"
    logger.debug("[chat-session] >>> %s %s json=%s", method, url, json_body is not None)
    try:
        async with httpx.AsyncClient(timeout=_timeout()) as client:
            resp = await client.request(method.upper(), url, json=json_body, params=params)
            if resp.status_code >= 400:
                logger.debug(
                    "[chat-session] <<< %s -> %s body_preview=%s",
                    url,
                    resp.status_code,
                    str(resp.text[:200]),
                )
            else:
                logger.debug("[chat-session] <<< %s -> %s", url, resp.status_code)
            return resp
    except Exception as e:
        logger.debug("[chat-session] !!! %s FAILED: %s: %s", url, type(e).__name__, e)
        logger.debug("LangGraph %s %s failed", method, path, exc_info=True)
        return None


async def delete_langgraph_thread(thread_id: str) -> bool:
    tid = str(thread_id or "").strip()
    if not tid:
        return True
    resp = await _langgraph_request("DELETE", f"threads/{tid}")
    if resp is None:
        return False
    return resp.status_code in (200, 204, 404)


def delete_local_thread_data(thread_id: str) -> None:
    tid = str(thread_id or "").strip()
    if not tid:
        return
    try:
        from evoflow.config.paths import get_paths

        get_paths().delete_thread_dir(tid)
    except Exception:
        logger.debug("delete_local_thread_data failed thread_id=%s", tid, exc_info=True)


def delete_thread_collab_sqlite(thread_id: str) -> None:
    tid = str(thread_id or "").strip()
    if not tid:
        return
    conn = get_db()
    conn.execute("DELETE FROM evoflow_thread_collab WHERE thread_id = ?", (tid,))
    conn.commit()


def delete_thread_tool_approval_sqlite(thread_id: str) -> None:
    from evoflow.persistence.tool_approval_repositories import delete_approvals_for_thread

    delete_approvals_for_thread(thread_id)


def _delete_session_business_data(session_key: str) -> None:
    """Clean up independent business tables when a session is deleted."""
    sk = str(session_key or "").strip()
    if not sk:
        return
    try:
        from evoflow.persistence.todo_repositories import delete_todos

        delete_todos(sk, "")
    except Exception:
        pass
    # delete_todos requires a thread_id; fallback: delete by session_key via raw SQL.
    try:
        conn = get_db()
        conn.execute("DELETE FROM evoflow_todos WHERE session_key = ?", (sk,))
        conn.execute("DELETE FROM evoflow_artifacts WHERE session_key = ?", (sk,))
        conn.commit()
    except Exception:
        pass


async def create_langgraph_thread(session_key: str) -> str | None:
    sk = str(session_key or "").strip()
    if not sk:
        return None
    logger.debug("[chat-session] create_langgraph_thread key=%s base_url=%s", sk, LANGGRAPH_BASE_URL)
    from evoflow.runtime.long_run_limits import LONG_RUN_WALL_MS, LONG_RUN_WALL_SECONDS

    body = {
        "metadata": {
            "session_key": sk,
            "max_execution_time": LONG_RUN_WALL_SECONDS,
            "timeout_ms": LONG_RUN_WALL_MS,
            "execution_mode": "normal",
            "source": "evoflow_chat_session_service",
        }
    }
    resp = await _langgraph_request("POST", "threads", json_body=body)
    if resp is not None and resp.status_code < 400:
        try:
            logger.debug("[chat-session] create_langgraph_thread resp=%s data=%s", resp.status_code, resp.json())
        except Exception:
            logger.debug("[chat-session] create_langgraph_thread resp=%s", resp.status_code)
    else:
        logger.debug("[chat-session] create_langgraph_thread resp=%s", resp.status_code if resp else None)
    if resp is None or resp.status_code not in (200, 201):
        return None
    try:
        data = resp.json()
    except Exception:
        return None
    if isinstance(data, dict):
        tid = data.get("thread_id") or data.get("threadId") or data.get("id")
        if tid:
            logger.debug("[chat-session] create_langgraph_thread SUCCESS tid=%s", tid)
            return str(tid).strip()
    return None


async def langgraph_thread_state(thread_id: str) -> str:
    """Return ``ok`` (usable), ``missing`` (404), or ``unknown``."""
    from evoflow.collab.thread_ids import is_langgraph_lead_thread_id

    tid = str(thread_id or "").strip()
    if not tid or not is_langgraph_lead_thread_id(tid):
        return "unknown"
    resp = await _langgraph_request("GET", f"threads/{tid}/runs", params={"limit": 1})
    if resp is None:
        return "unknown"
    if resp.status_code == 200:
        return "ok"
    if resp.status_code == 404:
        return "missing"
    return "unknown"


async def langgraph_thread_usable(thread_id: str) -> bool:
    return (await langgraph_thread_state(thread_id)) == "ok"


def _default_session_context() -> dict[str, Any]:
    primary = resolve_primary_model_name()
    ctx: dict[str, Any] = {
        "session_mode": "agent",
        "thinking_type": "auto",
        # thinking_enabled / reasoning_effort: set per user message by auto_thinking_decision
        "is_plan_mode": False,
        "subagent_enabled": False,
        "include_search": True,
        # Desktop default: ~/.evoflow/{outputs,uploads}; per-thread sandbox only when explicitly enabled.
        "use_virtual_paths": False,
        "collab_phase": "idle",
    }
    if primary:
        ctx["primary_model_name"] = primary
    return ctx


def make_new_session_key(agent_id: str = "main") -> str:
    import secrets

    aid = str(agent_id or "main").strip() or "main"
    return f"agent:{aid}:new-{secrets.token_hex(4)}"


def ensure_executor_transcript_session(
    executor_thread_id: str,
    *,
    lead_thread_id: str | None = None,
    collab_task_id: str | None = None,
) -> str | None:
    """Resolve/create a chat ``session_key`` for subtask executor transcript writes.

    Lead-bound workers reuse the lead sidebar session. Workflow app runs
    (``SubThread_{subtask_id}``, no lead) get a dedicated non-sidebar session
    ``agent:executor:{thread_id}`` so ``evoflow_chat_messages`` can be written.
    """
    tid = str(executor_thread_id or "").strip()
    if not tid:
        return None
    lead = str(lead_thread_id or "").strip() or None
    try:
        from evoflow.collab.thread_ids import (
            is_collab_executor_thread,
            lead_thread_from_executor_thread,
            normalize_lead_thread_id,
        )

        sk = sess_repo.find_session_key_by_thread_id(tid)
        if sk:
            return sk
        lead = normalize_lead_thread_id(lead) or lead or lead_thread_from_executor_thread(tid)
        if lead:
            sk_lead = sess_repo.find_session_key_by_thread_id(lead)
            if sk_lead:
                return sk_lead
        if not is_collab_executor_thread(tid):
            return None
        sk = f"{EXECUTOR_SESSION_KEY_PREFIX}{tid}"
        now = _now_ms()
        ctx: dict[str, Any] = {"executor_transcript": True}
        cid = str(collab_task_id or "").strip()
        if cid:
            ctx["collab_task_id"] = cid
        sess_repo.upsert_session_row(
            sk,
            thread_id=tid,
            created_at_ms=now,
            updated_at_ms=now,
            message_count=0,
            context=ctx,
            title="节点执行记录",
            agent_id="executor",
            session_status=sess_repo.SESSION_STATUS_ACTIVE,
            **({"collab_task_id": cid} if cid else {}),
        )
        sess_repo.invalidate_session_key_cache(tid)
        return sk
    except Exception:
        logger.debug("ensure_executor_transcript_session failed tid=%s", tid, exc_info=True)
        return None


async def create_new_session(
    *,
    session_key: str | None = None,
    agent_id: str = "main",
    title: str = "",
    context: dict[str, Any] | None = None,
    ensure_thread: bool = True,
    session_status: str | None = None,
) -> dict[str, Any]:
    """Persist a new sidebar session row and optionally create LangGraph thread."""
    sk = str(session_key or "").strip() or make_new_session_key(agent_id)
    if sess_repo.is_session_deleted(sk):
        raise ValueError("session_key is deleted")
    merged_ctx = {**_default_session_context(), **(context or {})}
    now = _now_ms()
    sess_repo.upsert_session_row(
        sk,
        thread_id=None,
        created_at_ms=now,
        updated_at_ms=now,
        message_count=0,
        context=merged_ctx,
        title=title or "新对话",
        session_status=session_status or sess_repo.SESSION_STATUS_ACTIVE,
        agent_id=str(agent_id or "main").strip() or "main",
        session_mode="agent",
    )
    # Phase 0/1: stamp personal ownership when identity tables exist.
    owner = None
    try:
        from evoflow.authz.debug_log import authz_debug
        from evoflow.authz.principals import get_or_create_local_admin, get_principal
        from evoflow.authz.session_ownership import (
            add_session_participant,
            stamp_session_ownership,
        )
        from evoflow.authz.types import DEFAULT_ORG_ID

        ctx_pid = str(
            (merged_ctx or {}).get("created_by") or (merged_ctx or {}).get("principal_id") or ""
        ).strip()
        if ctx_pid:
            maybe = get_principal(ctx_pid)
            if maybe:
                owner = maybe
            else:
                # JWT may resolve to a synthetic principal before DB link; still stamp it.
                owner = {
                    "principal_id": ctx_pid,
                    "org_id": str((merged_ctx or {}).get("org_id") or DEFAULT_ORG_ID),
                    "principal_type": "internal",
                    "display_name": ctx_pid,
                    "primary_email": None,
                    "status": "active",
                    "team_ids": [],
                    "attrs": {},
                }
        if owner is None:
            # True local/desktop path only — no request identity in context.
            owner = get_or_create_local_admin()
        stamp_session_ownership(sk, owner, force=True)
        add_session_participant(sk, str(owner.get("principal_id") or ""))
        authz_debug(
            "chat_session.create.stamp",
            session_key=sk,
            ctx_pid=ctx_pid or None,
            stamped_created_by=str(owner.get("principal_id") or "") or None,
            used_local_admin_fallback=not bool(ctx_pid),
        )
    except Exception:
        owner = None
        logger.debug("create_new_session ownership stamp failed sk=%s", sk, exc_info=True)
    # Default cwd → personal files bucket (private); explicit picker can still bind shared host paths.
    lwr = str(merged_ctx.get("local_workspace_root") or "").strip()
    stamp: dict[str, Any] | None = None
    if owner:
        try:
            from evoflow.authz.workspace_visibility import default_workspace_root_for_principal

            stamp = {
                "org_id": str(owner.get("org_id") or "local"),
                "principal_id": str(owner.get("principal_id") or ""),
                "created_by": str(owner.get("principal_id") or ""),
            }
            if not lwr:
                default_root = default_workspace_root_for_principal(owner)
                if default_root:
                    lwr = default_root
                    merged_ctx["local_workspace_root"] = lwr
                    sess_repo.upsert_session_row(
                        sk,
                        thread_id=None,
                        created_at_ms=now,
                        updated_at_ms=now,
                        message_count=0,
                        context=merged_ctx,
                        title=title or "新对话",
                        session_status=session_status or sess_repo.SESSION_STATUS_ACTIVE,
                        agent_id=str(agent_id or "main").strip() or "main",
                        session_mode="agent",
                        local_workspace_root=lwr,
                    )
        except Exception:
            pass
    tid: str | None = None
    if ensure_thread:
        tid = await ensure_session_thread(sk)
    if lwr:
        from evoflow.persistence import workspace_repositories as ws_repo

        try:
            ws_repo.touch_session_workspace(sk, lwr, set_current=True, stamp=stamp)
        except Exception:
            pass
    rows = sess_repo.list_sessions_for_ui(limit=200)
    row = next((r for r in rows if r.get("sessionKey") == sk), None)
    if row:
        return row
    return {
        "sessionKey": sk,
        "key": sk,
        "threadId": tid,
        "title": title or "新对话",
        "createdAt": now,
        "updatedAt": now,
        "messageCount": 0,
        "context": merged_ctx,
    }


def bind_session_thread(
    session_key: str,
    thread_id: str,
    *,
    context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Bind an existing LangGraph thread to a sidebar session (task jump / collab)."""
    from evoflow.collab.thread_ids import resolve_langgraph_lead_thread_id

    sk = str(session_key or "").strip()
    tid = resolve_langgraph_lead_thread_id(thread_id)
    if not sk or not tid:
        raise ValueError("session_key and valid LangGraph lead thread_id required")
    existing = sess_repo.load_session_map().get(sk) or {}
    ui_row = sess_repo.get_session_row_for_ui(sk)
    now = _now_ms()
    merged_ctx = dict(existing.get("context") if isinstance(existing.get("context"), dict) else {})
    if ui_row and isinstance(ui_row.get("context"), dict):
        merged_ctx = {**merged_ctx, **ui_row["context"]}
    if context:
        merged_ctx = {**merged_ctx, **context}
        for k, v in list(context.items()):
            if v is None:
                merged_ctx.pop(k, None)
    merged_ctx.setdefault("taskRelated", True)
    sess_repo.upsert_session_row(
        sk,
        thread_id=tid,
        created_at_ms=_session_created_at_ms(existing, now=now),
        updated_at_ms=now,
        message_count=int(existing.get("messageCount") or 0) or msg_repo.count_messages(sk),
        context=merged_ctx,
        title=str(existing.get("title") or (ui_row or {}).get("title") or ""),
        session_status=sess_repo.SESSION_STATUS_ACTIVE,
    )
    row = sess_repo.get_session_row_for_ui(sk)
    if row:
        return {"ok": True, **row}
    return {
        "ok": True,
        "sessionKey": sk,
        "threadId": tid,
        "messageCount": msg_repo.count_messages(sk),
    }


async def ensure_session_thread(
    session_key: str,
    *,
    force_recreate: bool = False,
) -> str:
    """Return a LangGraph thread_id for execution; create and persist if missing or stale.

    By default a persisted lead UUID is trusted without HTTP probing
    (``EVOFLOW_ENSURE_THREAD_PROBE=1`` restores GET ``/threads/{id}/runs`` checks).

    ``force_recreate=True`` (used when the stream already 404'd on this thread)
    always probes LangGraph and rebuilds a fresh thread when the old one is gone,
    so a restart-dropped checkpoint can never pin the UI to a stale thread_id.
    """
    import time as _time

    from evoflow.collab.thread_ids import resolve_langgraph_lead_thread_id

    sk = str(session_key or "").strip()
    if not sk:
        raise ValueError("session_key required")
    _t0 = _time.perf_counter()
    _phase_ms: dict[str, float] = {}
    existing = sess_repo.load_session_map().get(sk) or {}
    tid = resolve_langgraph_lead_thread_id(str(existing.get("threadId") or "").strip()) or ""
    if tid:
        try:
            from langgraph_sdk import get_client

            from app.gateway.streaming.goal_stream_events import is_goal_active_for_session
            from evoflow.langgraph_run_config import (
                default_langgraph_thread_metadata,
                ensure_langgraph_thread_exists,
                resolve_langgraph_base_url,
            )

            if is_goal_active_for_session(sk):
                client = get_client(url=resolve_langgraph_base_url())
                await ensure_langgraph_thread_exists(
                    client,
                    tid,
                    metadata=default_langgraph_thread_metadata(
                        source="hosted_goal_pinned_lead",
                        session_key=sk,
                    ),
                )
                return tid
        except Exception:
            logger.debug("ensure_session_thread hosted pin failed sk=%s tid=%s", sk, tid, exc_info=True)
    _t_state = _time.perf_counter()
    # Hot path: trust a persisted lead UUID. Probing GET /threads/{id}/runs via the
    # same Gateway HTTP stack was 0.5–3s+ under load and dominated click→POST.
    # Stale threads after LangGraph restart are recreated on stream 404
    # (frontend ``_ensureThreadAfterLangGraphMissing``).
    _probe_raw = (os.environ.get("EVOFLOW_ENSURE_THREAD_PROBE") or "").strip().lower()
    _probe = _probe_raw in ("1", "true", "yes", "on")
    if tid and not _probe and not force_recreate:
        _phase_ms["langgraph_thread_state_ms"] = 0.0
        try:
            from evoflow.observability.run_latency_trace import write_run_latency_event

            write_run_latency_event(
                tid,
                "ensure_thread_phases",
                {
                    "session_key": sk,
                    "path": "trust_existing",
                    "thread_state": "trusted",
                    "total_ms": round((_time.perf_counter() - _t0) * 1000.0, 2),
                    **_phase_ms,
                },
            )
        except Exception:
            pass
        return tid

    thread_state = await langgraph_thread_state(tid) if tid else "missing"
    _phase_ms["langgraph_thread_state_ms"] = round((_time.perf_counter() - _t_state) * 1000.0, 2)
    if thread_state == "ok":
        try:
            from evoflow.observability.run_latency_trace import write_run_latency_event

            write_run_latency_event(
                tid,
                "ensure_thread_phases",
                {
                    "session_key": sk,
                    "path": "existing_ok",
                    "thread_state": thread_state,
                    "total_ms": round((_time.perf_counter() - _t0) * 1000.0, 2),
                    **_phase_ms,
                },
            )
        except Exception:
            pass
        return tid
    old_collab: dict[str, Any] | None = None
    old_bound = ""
    if tid:
        try:
            from evoflow.persistence import task_repositories as task_repo

            old_collab = task_repo.load_thread_collab(tid)
            if old_collab:
                old_bound = str(old_collab.get("bound_task_id") or "").strip()
        except Exception:
            logger.debug("ensure_session_thread load collab failed sk=%s tid=%s", sk, tid, exc_info=True)
    if tid:
        # LangGraph 已无此 thread（404）时跳过 DELETE，避免无意义的代理风暴。
        if thread_state != "missing":
            await delete_langgraph_thread(tid)
        delete_local_thread_data(tid)
        delete_thread_collab_sqlite(tid)
    new_tid = await create_langgraph_thread(sk)
    if not new_tid:
        raise RuntimeError("Failed to create LangGraph thread")
    now = _now_ms()
    merged_ctx = dict(existing.get("context") if isinstance(existing.get("context"), dict) else {})
    # 侧栏「员工新建对话」只造 session_key，首次 ensure-thread 才落库：补默认 Agent 上下文
    if not existing or not str(merged_ctx.get("session_mode") or "").strip():
        for k, v in _default_session_context().items():
            merged_ctx.setdefault(k, v)
    if old_bound:
        merged_ctx["collab_task_id"] = old_bound
    # Thread recreation after LangGraph restart is not user activity — keep updated_at.
    sess_repo.upsert_session_row(
        sk,
        thread_id=new_tid,
        created_at_ms=_session_created_at_ms(existing, now=now),
        updated_at_ms=0,
        message_count=int(existing.get("messageCount") or 0) or msg_repo.count_messages(sk),
        context=merged_ctx,
        title=str(existing.get("title") or ""),
        session_mode=str(merged_ctx.get("session_mode") or "agent"),
        **({"collab_task_id": old_bound} if old_bound else {}),
    )
    if old_collab and old_bound:
        try:
            from evoflow.persistence import task_repositories as task_repo

            migrated = dict(old_collab)
            migrated["bound_task_id"] = old_bound
            task_repo.save_thread_collab(new_tid, migrated)
        except Exception:
            logger.debug("ensure_session_thread migrate collab failed sk=%s new_tid=%s", sk, new_tid, exc_info=True)
    try:
        from evoflow.observability.run_latency_trace import write_run_latency_event

        write_run_latency_event(
            new_tid,
            "ensure_thread_phases",
            {
                "session_key": sk,
                "path": "recreate",
                "thread_state": thread_state,
                "total_ms": round((_time.perf_counter() - _t0) * 1000.0, 2),
                **_phase_ms,
            },
        )
    except Exception:
        pass
    return new_tid


async def delete_session_full(session_key: str) -> dict[str, Any]:
    """Delete transcript, session row, LangGraph thread/checkpoint, and local thread data."""
    sk = str(session_key or "").strip()
    if not sk:
        raise ValueError("session_key required")
    row = sess_repo.load_session_map().get(sk) or {}
    tid = str(row.get("threadId") or "").strip()

    msg_repo.delete_messages_for_session(sk)
    from evoflow.persistence import workspace_repositories as ws_repo
    from evoflow.persistence.session_tool_binding_repositories import delete_bindings_for_session
    from evoflow.persistence.tool_approval_repositories import delete_approvals_for_session

    ws_repo.clear_session_workspace_history(sk)
    delete_bindings_for_session(sk)
    delete_approvals_for_session(sk)
    _delete_session_business_data(sk)
    sess_repo.mark_session_deleted(sk)

    lg_ok = True
    if tid:
        lg_ok = await delete_langgraph_thread(tid)
        delete_local_thread_data(tid)
        delete_thread_collab_sqlite(tid)
        delete_thread_tool_approval_sqlite(tid)
        sess_repo.delete_sessions_by_thread_id(tid)

    return {"ok": True, "sessionKey": sk, "threadId": tid or None, "langgraph_deleted": lg_ok}


async def fork_session_full(
    session_key: str,
    *,
    through_seq: int | None = None,
    through_message_id: str | None = None,
    before_message_id: str | None = None,
    title: str | None = None,
) -> dict[str, Any]:
    """Fork a conversation into a new session (native-style branch).

    Copies transcript rows up to an optional boundary into a new ``session_key``
    with a fresh LangGraph thread. Parent session is left intact.

    Cut rules (combined as the minimum inclusive seq when several are set):
    - ``through_seq`` / ``through_message_id``: inclusive (copy through that row)
    - ``before_message_id``: exclusive (copy strictly before that row; 0 = empty)
    """
    src = str(session_key or "").strip()
    if not src:
        raise ValueError("session_key required")
    if sess_repo.is_session_deleted(src):
        raise ValueError("session not found")

    parent = sess_repo.get_session_row_for_ui(src) or sess_repo.load_session_map().get(src) or {}
    if not parent:
        raise ValueError("session not found")

    cut = int(through_seq) if through_seq is not None else None
    mid = str(through_message_id or "").strip()
    before_mid = str(before_message_id or "").strip()
    if mid:
        resolved = msg_repo.resolve_seq_for_message_id(src, mid)
        if resolved is None:
            raise ValueError("through_message_id not found in session")
        cut = resolved if cut is None else min(cut, resolved)
    if before_mid:
        resolved_before = msg_repo.resolve_seq_for_message_id(src, before_mid)
        if resolved_before is None:
            raise ValueError("before_message_id not found in session")
        exclusive = max(0, int(resolved_before) - 1)
        cut = exclusive if cut is None else min(cut, exclusive)
    if cut is not None and cut < 0:
        raise ValueError("through_seq must be >= 0")

    parent_ctx = parent.get("context") if isinstance(parent.get("context"), dict) else {}
    child_ctx = dict(parent_ctx)
    # Fresh branch: do not inherit live collab / run bindings.
    child_ctx.pop("collab_task_id", None)
    child_ctx["collab_phase"] = "idle"
    child_ctx["forked_from_session_key"] = src
    if cut is not None:
        child_ctx["fork_cut_seq"] = cut
    if mid:
        child_ctx["fork_cut_message_id"] = mid
    if before_mid:
        child_ctx["fork_before_message_id"] = before_mid
    # Prefer flat UI fields when context is missing keys.
    if not str(child_ctx.get("local_workspace_root") or "").strip():
        lwr0 = str(parent.get("localWorkspaceRoot") or "").strip()
        if lwr0:
            child_ctx["local_workspace_root"] = lwr0
    if parent.get("useVirtualPaths") is not None and "use_virtual_paths" not in child_ctx:
        child_ctx["use_virtual_paths"] = bool(parent.get("useVirtualPaths"))
    if not str(child_ctx.get("model_name") or "").strip() and parent.get("modelName"):
        child_ctx["model_name"] = parent.get("modelName")
    if not str(child_ctx.get("primary_model_name") or "").strip() and parent.get("primaryModelName"):
        child_ctx["primary_model_name"] = parent.get("primaryModelName")
    if not str(child_ctx.get("session_mode") or "").strip() and parent.get("sessionMode"):
        child_ctx["session_mode"] = parent.get("sessionMode")

    agent_id = str(parent.get("agentId") or parent.get("agent_id") or "").strip()
    if not agent_id:
        # agent:main:new-xxxx → main
        parts = src.split(":")
        agent_id = parts[1] if len(parts) >= 2 and parts[0] == "agent" else "main"

    parent_title = str(parent.get("title") or "").strip() or "新对话"
    if str(title or "").strip():
        child_title = str(title).strip()
    elif before_mid:
        child_title = f"{parent_title} (编辑)"
    else:
        child_title = f"{parent_title} (分叉)"

    child_row = await create_new_session(
        agent_id=agent_id,
        title=child_title,
        context=child_ctx,
        ensure_thread=True,
    )
    dst = str(child_row.get("sessionKey") or child_row.get("key") or "").strip()
    new_tid = str(child_row.get("threadId") or "").strip() or None
    if not dst:
        raise RuntimeError("fork failed: no child session_key")

    copied = msg_repo.copy_messages_for_fork(
        src,
        dst,
        through_seq=cut,
        new_thread_id=new_tid,
    )
    now = _now_ms()
    sess_repo.upsert_session_row(
        dst,
        thread_id=new_tid,
        created_at_ms=int(child_row.get("createdAt") or now),
        updated_at_ms=now,
        message_count=copied,
        context=child_ctx,
        title=child_title,
        session_status=sess_repo.SESSION_STATUS_ACTIVE,
        agent_id=agent_id,
        session_mode=str(child_ctx.get("session_mode") or parent.get("sessionMode") or "agent"),
        model_name=parent.get("modelName") or child_ctx.get("model_name"),
        primary_model_name=parent.get("primaryModelName") or child_ctx.get("primary_model_name"),
        local_workspace_root=parent.get("localWorkspaceRoot") or child_ctx.get("local_workspace_root"),
        use_virtual_paths=parent.get("useVirtualPaths")
        if parent.get("useVirtualPaths") is not None
        else child_ctx.get("use_virtual_paths"),
        thinking_enabled=parent.get("thinkingEnabled"),
        reasoning_effort=parent.get("reasoningEffort") or child_ctx.get("reasoning_effort"),
        is_plan_mode=parent.get("isPlanMode"),
        subagent_enabled=parent.get("subagentEnabled"),
        include_search=parent.get("includeSearch"),
        memory_enabled=parent.get("memoryEnabled"),
    )

    lwr = str(
        parent.get("localWorkspaceRoot") or child_ctx.get("local_workspace_root") or ""
    ).strip()
    if lwr:
        from evoflow.persistence import workspace_repositories as ws_repo

        try:
            ws_repo.touch_session_workspace(dst, lwr, set_current=True)
        except Exception:
            logger.debug("fork_session_full touch workspace failed sk=%s", dst, exc_info=True)

    ui = sess_repo.get_session_row_for_ui(dst) or child_row
    return {
        "ok": True,
        "sessionKey": dst,
        "threadId": new_tid,
        "forkedFromSessionKey": src,
        "forkCutSeq": cut,
        "messageCount": copied,
        "session": ui,
    }


async def reset_session_full(session_key: str) -> dict[str, Any]:
    """Clear transcript and replace LangGraph thread (fresh checkpoint) while keeping session metadata."""
    sk = str(session_key or "").strip()
    if not sk:
        raise ValueError("session_key required")

    row = sess_repo.load_session_map().get(sk) or {}
    old_tid = str(row.get("threadId") or "").strip()
    ctx = row.get("context") if isinstance(row.get("context"), dict) else {}

    msg_repo.delete_messages_for_session(sk)

    # Compaction state is now stored as chat message rows — deleted by delete_messages_for_session above.

    if old_tid:
        await delete_langgraph_thread(old_tid)
        delete_local_thread_data(old_tid)
        delete_thread_collab_sqlite(old_tid)
        delete_thread_tool_approval_sqlite(old_tid)

    new_tid = await create_langgraph_thread(sk)
    if not new_tid:
        raise RuntimeError("Failed to create LangGraph thread after reset")

    now = _now_ms()
    sess_repo.upsert_session_row(
        sk,
        thread_id=new_tid,
        created_at_ms=_session_created_at_ms(row, now=now),
        updated_at_ms=now,
        message_count=0,
        context=ctx,
        title=str(row.get("title") or ""),
    )
    return {"ok": True, "sessionKey": sk, "threadId": new_tid, "previousThreadId": old_tid or None}


async def truncate_session_from_message(
    session_key: str,
    *,
    from_message_id: str,
) -> dict[str, Any]:
    """In-place edit rewind: drop ``from_message_id`` and everything after it.

    Keeps the same ``session_key``. Replaces the LangGraph thread so the next turn
    hydrates only from the remaining DB transcript (source of truth).
    """
    sk = str(session_key or "").strip()
    mid = str(from_message_id or "").strip()
    if not sk:
        raise ValueError("session_key required")
    if not mid:
        raise ValueError("from_message_id required")
    if sess_repo.is_session_deleted(sk):
        raise ValueError("session not found")

    row = sess_repo.get_session_row_for_ui(sk) or sess_repo.load_session_map().get(sk) or {}
    if not row:
        raise ValueError("session not found")

    cut = msg_repo.resolve_seq_for_message_id(sk, mid)
    if cut is None:
        raise ValueError("from_message_id not found in session")

    deleted = msg_repo.delete_messages_from_seq(sk, cut)
    remaining = msg_repo.count_messages(sk)

    old_tid = str(row.get("threadId") or row.get("thread_id") or "").strip()
    ctx = row.get("context") if isinstance(row.get("context"), dict) else {}
    if isinstance(ctx, dict):
        ctx = dict(ctx)
    else:
        ctx = {}

    if old_tid:
        await delete_langgraph_thread(old_tid)
        delete_local_thread_data(old_tid)
        delete_thread_collab_sqlite(old_tid)
        delete_thread_tool_approval_sqlite(old_tid)

    new_tid = await create_langgraph_thread(sk)
    if not new_tid:
        raise RuntimeError("Failed to create LangGraph thread after truncate")

    if remaining > 0:
        msg_repo.remap_session_messages_thread_id(sk, new_tid)

    try:
        from evoflow.agents.middlewares.session_transcript_hydration_middleware import (
            clear_hydration_watermark_cache,
        )

        clear_hydration_watermark_cache()
    except Exception:
        logger.debug("truncate_session clear hydration cache failed", exc_info=True)

    now = _now_ms()
    sess_repo.upsert_session_row(
        sk,
        thread_id=new_tid,
        created_at_ms=_session_created_at_ms(row, now=now),
        updated_at_ms=now,
        message_count=remaining,
        context=ctx,
        title=str(row.get("title") or ""),
    )
    return {
        "ok": True,
        "sessionKey": sk,
        "threadId": new_tid,
        "previousThreadId": old_tid or None,
        "fromMessageId": mid,
        "fromSeq": cut,
        "deletedCount": deleted,
        "messageCount": remaining,
    }


async def persist_user_message(
    session_key: str,
    content: str,
    *,
    run_id: str | None = None,
    message_id: str | None = None,
) -> str | None:
    """Unified entry for writing a user message: ensure thread + append + touch session.

    Consolidates the repeated ``ensure_session_thread + append_message_and_touch_session``
    pattern previously duplicated in goal_service, automation_chat_session, and
    channels/manager.

    Returns the ``thread_id`` on success, or ``None`` if skipped.
    """
    sk = str(session_key or "").strip()
    if not sk or not str(content or "").strip():
        return None
    try:
        thread_id = await ensure_session_thread(sk)
        append_message_and_touch_session(
            sk,
            role="user",
            content=content,
            run_id=run_id,
            thread_id=thread_id,
            message_id=message_id,
        )
        return thread_id
    except Exception:
        logger.debug("persist_user_message failed sk=%s", sk, exc_info=True)
        return None


def append_message_and_touch_session(
    session_key: str,
    *,
    role: str,
    content: Any = None,
    run_id: str | None = None,
    thread_id: str | None = None,
    principal_id: str | None = None,
    **flat_fields: Any,
) -> dict[str, Any] | None:
    sk = str(session_key or "").strip()

    def _write() -> dict[str, Any] | None:
        conn = get_db()
        existing_row = conn.execute(
            "SELECT thread_id, title, created_at, context_json FROM evoflow_chat_sessions WHERE session_key = ? AND is_deleted = 0",
            (sk,),
        ).fetchone()
        existing: dict[str, Any] = {}
        if existing_row:
            existing = {
                "threadId": str(existing_row[0] or "").strip() or None,
                "title": str(existing_row[1] or ""),
                "createdAt": existing_row[2],
                "context": {},
            }
        # Stamp session ownership if caller passes a user and session has none yet
        # (legacy / pre-v134 sessions get attributed to the first touching user).
        if principal_id:
            try:
                from evoflow.authz.principals import get_principal
                from evoflow.authz.session_ownership import stamp_session_ownership

                owner = get_principal(principal_id)
                if owner:
                    stamp_session_ownership(sk, owner, force=False)
            except Exception:
                logger.debug("stamp_session_ownership on append failed sk=%s", sk, exc_info=True)
        prior_user_row = conn.execute(
            "SELECT COUNT(*) FROM evoflow_chat_messages WHERE session_key = ? AND role = 'user'",
            (sk,),
        ).fetchone()
        prior_user_count = int(prior_user_row[0] or 0) if prior_user_row else 0
        append_result = msg_repo.append_message(
            sk,
            role=role,
            content=content,
            run_id=run_id,
            thread_id=thread_id,
            conn=conn,
            **flat_fields,
        )
        from evoflow.agents.middlewares.message_usage_helpers import token_fields_for_session_rollup
        from evoflow.persistence.session_run_state import add_session_token_usage

        if append_result:
            rollup = token_fields_for_session_rollup(
                input_tokens=append_result.get("input_tokens"),
                output_tokens=append_result.get("output_tokens"),
                total_tokens=append_result.get("total_tokens"),
                cache_read_tokens=append_result.get("cache_read_tokens"),
                cache_creation_tokens=append_result.get("cache_creation_tokens"),
                cache_miss_tokens=append_result.get("cache_miss_tokens"),
            )
            add_session_token_usage(sk, conn=conn, **rollup)
            try:
                from evoflow.persistence.usage_ledger import record_llm_chat_usage_in_txn

                role_norm_msg = str(role or "").strip().lower()
                if role_norm_msg in ("assistant", "ai", "model") or rollup.get("total_tokens") or rollup.get(
                    "input_tokens"
                ):
                    record_llm_chat_usage_in_txn(
                        conn,
                        session_key=sk,
                        run_id=run_id,
                        thread_id=thread_id,
                        message_id=str(append_result.get("message_id") or append_result.get("id") or "") or None,
                        model_name=str(append_result.get("model_name") or "") or None,
                        input_tokens=int(rollup.get("input_tokens") or 0),
                        output_tokens=int(rollup.get("output_tokens") or 0),
                        total_tokens=int(rollup.get("total_tokens") or 0),
                        principal_id=principal_id or None,
                    )
            except Exception:
                logger.exception("usage ledger write failed session=%s", sk)
        count = msg_repo.count_messages(sk)
        title_for_row = str(existing.get("title") or "")
        prov = _provisional_title_for_first_user_message(
            role=str(role or ""),
            content=content,
            existing_title=title_for_row,
            prior_user_count=prior_user_count,
        )
        if prov:
            title_for_row = prov
        now = _now_ms()
        role_norm = str(role or "").strip().lower()
        if role_norm == "user" or count > 0:
            sess_repo.activate_session_if_prewarmed(sk, conn=conn)
        _touch_run_active_on_transcript(sk, run_id=run_id, thread_id=thread_id, conn=conn)
        session_row_tid = msg_repo.session_binding_thread_id(
            thread_id,
            str(existing.get("threadId") or "").strip() or None,
        )
        sess_repo.upsert_session_row(
            sk,
            thread_id=session_row_tid,
            created_at_ms=_session_created_at_ms(existing, now=now),
            updated_at_ms=now,
            message_count=count,
            context=existing.get("context") if isinstance(existing.get("context"), dict) else {},
            title=title_for_row,
            session_status=sess_repo.SESSION_STATUS_ACTIVE,
            conn=conn,
        )
        if append_result:
            from evoflow.persistence.stream_mirror_repositories import update_last_persisted_seq

            update_last_persisted_seq(sk, run_id=run_id, conn=conn)
        conn.commit()
        if append_result is None:
            return None
        return {**append_result, "messageCount": count}

    return run_db_with_retry(_write)


def append_messages_batch_and_touch_session(
    session_key: str,
    messages: list[dict[str, Any]],
    *,
    run_id: str | None = None,
    thread_id: str | None = None,
    parent_thread_id: str | None = None,
    round_id: str | None = None,
    skip_if_seq_exists: bool = False,
    principal_id: str | None = None,
) -> dict[str, Any]:
    sk = str(session_key or "").strip()

    def _write() -> dict[str, Any]:
        conn = get_db()
        # Stamp session ownership if caller passes a user and session has none yet
        if principal_id:
            try:
                from evoflow.authz.principals import get_principal
                from evoflow.authz.session_ownership import stamp_session_ownership

                owner = get_principal(principal_id)
                if owner:
                    stamp_session_ownership(sk, owner, force=False)
            except Exception:
                logger.debug("stamp_session_ownership on batch append failed sk=%s", sk, exc_info=True)
        batch = msg_repo.append_messages_batch(
            sk,
            messages,
            run_id=run_id,
            thread_id=thread_id,
            parent_thread_id=parent_thread_id,
            round_id=round_id,
            conn=conn,
            skip_if_seq_exists=skip_if_seq_exists,
        )
        from evoflow.persistence.session_run_state import add_session_token_usage

        add_session_token_usage(
            sk,
            input_tokens=int(batch.get("input_tokens") or 0),
            output_tokens=int(batch.get("output_tokens") or 0),
            total_tokens=int(batch.get("total_tokens") or 0),
            cache_read_tokens=int(batch.get("cache_read_tokens") or 0),
            cache_creation_tokens=int(batch.get("cache_creation_tokens") or 0),
            cache_miss_tokens=int(batch.get("cache_miss_tokens") or 0),
            conn=conn,
        )
        try:
            from evoflow.persistence.usage_ledger import record_llm_chat_usage_in_txn

            # Batch rollup: one ledger row per run when tokens present (idempotent on run).
            if int(batch.get("total_tokens") or 0) or int(batch.get("input_tokens") or 0):
                batch_model = ""
                for m in messages or []:
                    if not isinstance(m, dict):
                        continue
                    batch_model = str(
                        m.get("model_name") or m.get("modelName") or m.get("model") or ""
                    ).strip()
                    if batch_model:
                        break
                record_llm_chat_usage_in_txn(
                    conn,
                    session_key=sk,
                    run_id=run_id,
                    thread_id=thread_id,
                    message_id=f"batch:{int(batch.get('appended') or 0)}",
                    model_name=batch_model or None,
                    input_tokens=int(batch.get("input_tokens") or 0),
                    output_tokens=int(batch.get("output_tokens") or 0),
                    total_tokens=int(batch.get("total_tokens") or 0),
                    principal_id=principal_id or None,
                )
        except Exception:
            logger.exception("usage ledger batch write failed session=%s", sk)
        count = msg_repo.count_messages(sk)
        existing_row = conn.execute(
            "SELECT thread_id, title, created_at, context_json FROM evoflow_chat_sessions WHERE session_key = ? AND is_deleted = 0",
            (sk,),
        ).fetchone()
        existing: dict[str, Any] = {}
        if existing_row:
            existing = {
                "threadId": str(existing_row[0] or "").strip() or None,
                "title": str(existing_row[1] or ""),
                "createdAt": existing_row[2],
                "context": {},
            }
        now = _now_ms()
        has_user = any(str(m.get("role") or "").strip().lower() == "user" for m in messages if isinstance(m, dict))
        if has_user or count > 0:
            sess_repo.activate_session_if_prewarmed(sk, conn=conn)
        _touch_run_active_on_transcript(sk, run_id=run_id, thread_id=thread_id, conn=conn)
        session_row_tid = msg_repo.session_binding_thread_id(
            thread_id,
            str(existing.get("threadId") or "").strip() or None,
        )
        sess_repo.upsert_session_row(
            sk,
            thread_id=session_row_tid,
            created_at_ms=_session_created_at_ms(existing, now=now),
            updated_at_ms=now,
            message_count=count,
            context=existing.get("context") if isinstance(existing.get("context"), dict) else {},
            title=str(existing.get("title") or ""),
            session_status=sess_repo.SESSION_STATUS_ACTIVE,
            conn=conn,
        )
        if int(batch.get("appended") or 0) > 0:
            from evoflow.persistence.stream_mirror_repositories import update_last_persisted_seq

            update_last_persisted_seq(sk, run_id=run_id, conn=conn)
        conn.commit()
        return {**batch, "messageCount": count}

    return run_db_with_retry(_write)
