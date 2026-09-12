"""Persist collab subtask messages in ``evoflow_chat_messages`` (single source of truth).

Subtask worker streams use executor ``thread_id`` (``{lead}__sub__{subtask_id}``) with
``parent_thread_id`` pointing at the Lead thread. Query via ``list_subtask_conversation_ui_messages``.
"""

from __future__ import annotations

import json
import logging
from typing import Any
from uuid import uuid4

from evoflow.collab.storage import find_main_task, get_project_storage
from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)


def _normalize_text_content(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, dict):
                t = block.get("text") or block.get("content")
                if t is not None:
                    parts.append(str(t))
            elif block is not None:
                parts.append(str(block))
        return "\n".join(p for p in parts if p).strip()
    try:
        return json.dumps(content, ensure_ascii=False, sort_keys=True)
    except Exception:
        return str(content).strip()


def _display_payload(row: dict[str, Any]) -> dict[str, Any] | None:
    payload = row.get("content_json")
    if isinstance(payload, dict):
        return payload
    if isinstance(row.get("payload"), dict):
        return row["payload"]
    return None


def _display_row_content(row: dict[str, Any]) -> Any:
    payload = _display_payload(row)
    if payload is not None and "content" in payload:
        return payload.get("content")
    return row.get("content")


def _display_row_tool_calls(row: dict[str, Any]) -> Any:
    payload = _display_payload(row)
    if payload is not None and payload.get("tool_calls") is not None:
        return payload.get("tool_calls")
    return row.get("tool_calls")


def _chat_role_from_stream_message(message: dict[str, Any]) -> str | None:
    role = str(message.get("role") or message.get("type") or "assistant").strip().lower()
    if role in {"human", "user", "humanmessage"}:
        return "user"
    if role in {"ai", "assistant", "aimessage", "aimessagechunk"}:
        return "assistant"
    if role in {"tool", "toolmessage"}:
        return "tool"
    return None


def _resolve_subtask_executor_thread(
    *,
    lead_thread: str | None,
    subtask_id: str,
    subtask_row: dict[str, Any] | None = None,
) -> str | None:
    sid = str(subtask_id or "").strip()
    if not sid:
        return None
    lead = str(lead_thread or "").strip() or None
    stored = None
    if isinstance(subtask_row, dict):
        stored = (
            str(subtask_row.get("subtask_thread_id") or subtask_row.get("external_session_id") or "").strip()
            or None
        )
    from evoflow.collab.thread_ids import resolve_subtask_executor_thread_id

    return resolve_subtask_executor_thread_id(lead, sid, stored_subtask_thread_id=stored)


def _legacy_executor_threads_for_subtask(
    *,
    lead_thread: str | None,
    subtask_id: str,
    subtask_row: dict[str, Any] | None = None,
) -> list[str]:
    """Candidate executor thread ids (stored first — survives lead UUID recreation)."""
    sid = str(subtask_id or "").strip()
    if not sid:
        return []
    canonical = _resolve_subtask_executor_thread(
        lead_thread=lead_thread,
        subtask_id=sid,
        subtask_row=subtask_row,
    )
    out: list[str] = []
    seen: set[str] = set()

    def _add(tid: str | None) -> None:
        t = str(tid or "").strip()
        if not t or t in seen:
            return
        seen.add(t)
        out.append(t)

    # Persisted worker thread first — chat rows are keyed by this, not current lead UUID
    if isinstance(subtask_row, dict):
        stored = str(subtask_row.get("subtask_thread_id") or subtask_row.get("external_session_id") or "").strip()
        _add(stored)
    _add(canonical)
    _add(f"SubThread_{sid}")
    from evoflow.collab.thread_ids import collab_subtask_executor_thread_id, normalize_lead_thread_id

    raw_lead = str(lead_thread or "").strip()
    nested_lead = raw_lead if raw_lead and normalize_lead_thread_id(raw_lead) != raw_lead else None
    if nested_lead:
        _add(collab_subtask_executor_thread_id(nested_lead, sid))
    if raw_lead:
        _add(collab_subtask_executor_thread_id(raw_lead, sid))
    return out


def _chat_row_to_ui_message(row: dict[str, Any], *, subtask_id: str) -> dict[str, Any]:
    mid = str(row.get("message_id") or row.get("id") or "").strip()
    role = str(row.get("role") or "assistant").strip() or "assistant"
    content = _display_row_content(row)
    out: dict[str, Any] = {
        "id": mid or f"{subtask_id}:chat:{uuid4().hex[:8]}",
        "role": role,
        "content": content,
        "collab_subtask_id": subtask_id,
        "thread_id": row.get("thread_id"),
    }
    ts = row.get("created_at_ms") or row.get("created_at") or row.get("timestamp")
    if ts is not None:
        out["timestamp"] = ts
    tool_calls = _display_row_tool_calls(row)
    if tool_calls is not None:
        out["tool_calls"] = tool_calls
    tname = str(row.get("tool_name") or row.get("name") or "").strip()
    if tname:
        out["name"] = tname
        out["tool_name"] = tname
    tcid = str(row.get("tool_call_id") or "").strip()
    if tcid:
        out["tool_call_id"] = tcid
    rid = str(row.get("run_id") or row.get("runId") or "").strip()
    if rid:
        out["run_id"] = rid
    mname = str(row.get("model_name") or "").strip()
    if mname:
        out["model_name"] = mname
    um: dict[str, Any] = {}
    for key in ("input_tokens", "output_tokens", "total_tokens"):
        if row.get(key) is not None:
            um[key] = row[key]
            out[key] = row[key]
    if um:
        out["usage_metadata"] = um
    return out


def resolve_subtask_persist_run_id(
    *,
    explicit: str | None = None,
    tool_call_id: str | None = None,
    lead_thread: str | None = None,
    subtask_id: str | None = None,
    subtask_row: dict[str, Any] | None = None,
) -> str | None:
    """Align outcome/tool rows with the active subagent background task ``run_id``."""
    rid = str(explicit or "").strip()
    if rid:
        return rid
    try:
        from evoflow.scheduler.subagent_stream import get_subagent_stream_task_id

        tid = get_subagent_stream_task_id()
        if tid:
            return tid
    except Exception:
        pass
    lead = str(lead_thread or "").strip()
    sid = str(subtask_id or "").strip()
    if lead and sid:
        try:
            from evoflow.collab.thread_ids import normalize_lead_thread_id
            from evoflow.persistence import chat_message_repositories as msg_repo

            lead_norm = normalize_lead_thread_id(lead) or lead
            executor = _resolve_subtask_executor_thread(
                lead_thread=lead_norm,
                subtask_id=sid,
                subtask_row=subtask_row,
            )
            if executor:
                row_rid = msg_repo.latest_run_id_for_thread_id(executor)
                if row_rid:
                    return row_rid
        except Exception:
            logger.debug("resolve_subtask_persist_run_id: thread lookup failed", exc_info=True)
    tc = str(tool_call_id or "").strip()
    return tc or None


def _enrich_subtask_stream_message(
    message: dict[str, Any],
    *,
    default_model_name: str | None = None,
) -> dict[str, Any]:
    """Ensure LangGraph/LangChain AIMessage dicts expose model + token fields for persistence."""
    src = dict(message)
    from evoflow.agents.middlewares.message_usage_helpers import infer_usage_metadata_from_checkpoint_ai_dict
    from evoflow.persistence.chat_message_repositories import _pick_model_name

    um = infer_usage_metadata_from_checkpoint_ai_dict(src)
    if um:
        merged_um = dict(src.get("usage_metadata") or {}) if isinstance(src.get("usage_metadata"), dict) else {}
        merged_um.update(um)
        src["usage_metadata"] = merged_um
        for key, val in um.items():
            src.setdefault(key, val)
    dm = str(default_model_name or "").strip()
    if dm and not _pick_model_name(src):
        src["model_name"] = dm
    return src


def list_subtask_conversation_ui_messages(
    task: dict[str, Any],
    subtask_id: str,
    *,
    subtask_row: dict[str, Any] | None = None,
    limit: int = 500,
) -> list[dict[str, Any]]:
    """Load subtask worker history from ``evoflow_chat_messages`` only.

    Lookup is keyed by stable ``subtask_id`` (+ persisted ``subtask_thread_id``),
    not by the current lead LangGraph UUID (which may change after service restart).
    """
    sid = str(subtask_id or "").strip()
    if not sid or not isinstance(task, dict):
        return []
    lead_thread = str(task.get("thread_id") or "").strip() or None
    row = subtask_row if isinstance(subtask_row, dict) else None
    if row is None:
        for st in task.get("subtasks") or []:
            if isinstance(st, dict) and str(st.get("id") or "").strip() == sid:
                row = st
                break

    cap = max(1, min(int(limit or 500), 5000))
    executor_threads = _legacy_executor_threads_for_subtask(
        lead_thread=lead_thread,
        subtask_id=sid,
        subtask_row=row,
    )
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()

    def _append_ui(row_data: dict[str, Any]) -> None:
        ui = _chat_row_to_ui_message(row_data, subtask_id=sid)
        key = str(ui.get("id") or "") or json.dumps(
            {"role": ui.get("role"), "content": _normalize_text_content(ui.get("content"))},
            ensure_ascii=False,
            sort_keys=True,
        )
        if key in seen:
            return
        seen.add(key)
        rows.append(ui)

    try:
        from evoflow.persistence import chat_message_repositories as msg_repo

        for executor in executor_threads:
            for chat_row in msg_repo.list_messages_for_thread_id(executor, limit=cap):
                if isinstance(chat_row, dict):
                    _append_ui(chat_row)

        # Scan by subtask suffix — finds rows under old {lead}__sub__{sid} after lead recreate
        if len(rows) < cap:
            for chat_row in msg_repo.list_rows_for_subtask_id(sid, limit=cap):
                if isinstance(chat_row, dict):
                    _append_ui(chat_row)

        if not rows and lead_thread:
            from evoflow.persistence.session_repositories import find_session_key_by_thread_id

            session_key = find_session_key_by_thread_id(lead_thread)
            if session_key:
                for chat_row in msg_repo.list_messages(session_key, limit=cap):
                    if not isinstance(chat_row, dict):
                        continue
                    mid = str(chat_row.get("message_id") or "")
                    if mid.startswith(f"{sid}:"):
                        _append_ui(chat_row)
                        continue
                    from evoflow.collab.thread_ids import collab_subtask_executor_thread_id

                    executor = collab_subtask_executor_thread_id(lead_thread, sid)
                    parent = str(chat_row.get("parent_thread_id") or "").strip()
                    msg_tid = str(chat_row.get("thread_id") or "").strip()
                    if parent and msg_tid == executor:
                        _append_ui(chat_row)
    except Exception:
        logger.debug("list_subtask_conversation_ui_messages failed", exc_info=True)

    # Historical workflow runs may have outcome on the subtask row but no chat rows
    # (writes used to require a lead session). Surface the report so the UI is not blank.
    if not rows and isinstance(row, dict):
        try:
            from evoflow.collab.subtask_outcome import build_subtask_outcome_snapshot

            snap = build_subtask_outcome_snapshot(row)
            report = str((snap or {}).get("task_report") or (snap or {}).get("summary") or "").strip()
            if report:
                rows.append(
                    {
                        "id": f"{sid}:outcome-report",
                        "role": "assistant",
                        "content": report,
                        "collab_subtask_id": sid,
                        "source": "subtask_outcome_report",
                    }
                )
        except Exception:
            logger.debug("outcome fallback for empty subtask transcript failed", exc_info=True)

    return rows[-cap:]


def _persist_subtask_message_to_chat(
    *,
    lead_thread: str | None,
    subtask_id: str,
    row_id: str,
    message: dict[str, Any],
    run_id: str | None = None,
    default_model_name: str | None = None,
) -> bool:
    """Write one subtask stream row into ``evoflow_chat_messages`` (executor thread scope).

    Routes through ``chat_session_service.append_message_and_touch_session`` so that
    session metadata (updated_at, message_count, run_status, token rollup) stays
    consistent with all other write paths. Works without a lead thread (workflow apps).
    """
    try:
        from evoflow.collab.thread_ids import collab_subtask_executor_thread_id
        from evoflow.persistence.chat_session_service import (
            append_message_and_touch_session,
            ensure_executor_transcript_session,
        )

        chat_role = _chat_role_from_stream_message(message)
        if not chat_role:
            return False
        lead = str(lead_thread or "").strip() or None
        executor_thread = collab_subtask_executor_thread_id(lead or "", subtask_id)
        session_key = ensure_executor_transcript_session(
            executor_thread,
            lead_thread_id=lead,
        )
        if not session_key:
            return False
        rid = resolve_subtask_persist_run_id(
            explicit=str(run_id or message.get("run_id") or message.get("runId") or "").strip() or None,
            tool_call_id=str(message.get("tool_call_id") or "").strip() or None,
            lead_thread=lead,
            subtask_id=subtask_id,
        )
        src = _enrich_subtask_stream_message(message, default_model_name=default_model_name)
        from evoflow.persistence.chat_message_repositories import pack_row_from_message

        fields = pack_row_from_message(role=chat_role, content=src.get("content"), raw=src, message_id=row_id or None)
        res = append_message_and_touch_session(
            session_key,
            role=chat_role,
            content_json=fields["payload"],
            thread_id=executor_thread,
            parent_thread_id=lead,
            run_id=rid,
            message_id=row_id or None,
            tool_call_id=str(src.get("tool_call_id") or "").strip() or None,
            tool_name=str(src.get("name") or src.get("tool_name") or "").strip() or None,
            raw=src,
        )
        if res:
            return True
        return False
    except Exception:
        logger.debug("persist subtask message to chat failed", exc_info=True)
        return False


def _persist_subtask_entries_to_chat(
    *,
    lead_thread: str | None,
    subtask_id: str,
    entries: list[dict[str, Any]],
    mirror_source_message: dict[str, Any] | None = None,
    default_model_name: str | None = None,
) -> int:
    """Persist multiple subtask entries in a single batch transaction.

    Collects all entries into one ``append_messages_batch_and_touch_session``
    call (1 transaction) instead of N separate ``append_message_and_touch_session``
    calls (N transactions). Supports no-lead workflow executors.
    """
    sid = str(subtask_id or "").strip()
    if not entries or not sid:
        return 0
    try:
        from evoflow.collab.thread_ids import collab_subtask_executor_thread_id
        from evoflow.persistence.chat_message_repositories import pack_row_from_message
        from evoflow.persistence.chat_session_service import (
            append_messages_batch_and_touch_session,
            ensure_executor_transcript_session,
        )

        lead = str(lead_thread or "").strip() or None
        executor_thread = collab_subtask_executor_thread_id(lead or "", sid)
        session_key = ensure_executor_transcript_session(
            executor_thread,
            lead_thread_id=lead,
        )
        if not session_key:
            return 0
    except Exception:
        logger.debug("_persist_subtask_entries_to_chat: setup failed", exc_info=True)
        return 0

    batch_items: list[dict[str, Any]] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        row_id = str(entry.get("id") or "").strip() or f"{sid}:turn:{uuid4().hex[:12]}"
        src = mirror_source_message if isinstance(mirror_source_message, dict) else entry
        run_id = str(src.get("run_id") or src.get("runId") or "").strip() or None
        chat_role = _chat_role_from_stream_message(src)
        if not chat_role:
            continue
        enriched = _enrich_subtask_stream_message(src, default_model_name=default_model_name)
        fields = pack_row_from_message(role=chat_role, content=enriched.get("content"), raw=enriched, message_id=row_id or None)
        item: dict[str, Any] = {
            "role": chat_role,
            "content": enriched.get("content"),
            "content_json": fields["payload"],
            "message_id": row_id or None,
            "tool_call_id": str(enriched.get("tool_call_id") or "").strip() or None,
            "tool_name": str(enriched.get("name") or enriched.get("tool_name") or "").strip() or None,
            "run_id": run_id,
            "thread_id": executor_thread,
            "parent_thread_id": lead,
            "raw": enriched,
        }
        batch_items.append(item)

    if not batch_items:
        return 0

    try:
        result = append_messages_batch_and_touch_session(
            session_key,
            batch_items,
            thread_id=executor_thread,
        )
        return int(result.get("appended") or 0)
    except Exception:
        logger.debug("_persist_subtask_entries_to_chat: batch write failed", exc_info=True)
        return 0


def append_subtask_conversation_messages(
    storage: Any,
    main_task_id: str,
    subtask_id: str,
    messages: list[dict[str, Any]],
) -> bool:
    """Append UI/LangGraph-shaped messages for a subtask (chat DB only)."""
    if not messages:
        return False
    row = find_main_task(storage, main_task_id)
    if not row:
        return False
    _project, task = row
    sid = str(subtask_id or "").strip()
    lead_thread = str(task.get("thread_id") or "").strip() or None
    entries: list[dict[str, Any]] = []
    for msg in messages:
        if not isinstance(msg, dict):
            continue
        role = str(msg.get("role") or "assistant").strip() or "assistant"
        content = msg.get("content")
        text_norm = _normalize_text_content(content)
        if not text_norm and not msg.get("tool_calls"):
            continue
        row_id = str(msg.get("id") or "").strip() or f"{sid}:turn:{uuid4().hex[:12]}"
        entry: dict[str, Any] = {
            "id": row_id,
            "role": role,
            "timestamp": str(msg.get("timestamp") or utc_now_iso_z()),
            "content": content if content is not None else text_norm,
            "collab_subtask_id": sid,
        }
        if msg.get("tool_calls") is not None:
            entry["tool_calls"] = msg.get("tool_calls")
        if msg.get("source"):
            entry["source"] = msg.get("source")
        entries.append(entry)
    added = _persist_subtask_entries_to_chat(lead_thread=lead_thread, subtask_id=sid, entries=entries)
    return added > 0


def append_subtask_conversation_turn(
    storage: Any,
    main_task_id: str,
    subtask_id: str,
    *,
    user_text: str,
    assistant_text: str | None = None,
    source: str = "continue_subtask_session",
) -> None:
    """Persist one user turn and optional assistant reply for a subtask."""
    sid = str(subtask_id or "").strip()
    msgs: list[dict[str, Any]] = []
    user = str(user_text or "").strip()
    if user:
        msgs.append(
            {
                "id": f"{sid}:user:{uuid4().hex[:12]}",
                "role": "user",
                "content": user,
                "source": source,
            }
        )
    assistant = str(assistant_text or "").strip() if assistant_text is not None else ""
    if assistant:
        msgs.append(
            {
                "id": f"{sid}:assistant:{uuid4().hex[:12]}",
                "role": "assistant",
                "content": assistant,
                "source": source,
            }
        )
    append_subtask_conversation_messages(storage, main_task_id, sid, msgs)


def append_collab_subtask_stream_message(
    main_task_id: str,
    subtask_id: str,
    message: object,
    message_index: int,
    *,
    parent_thread_id: str | None = None,
    run_id: str | None = None,
    default_model_name: str | None = None,
) -> bool:
    """Append one subagent stream message to chat transcript."""
    if not isinstance(message, dict):
        return False
    if run_id:
        message = {**message, "run_id": run_id}
    mid = str(main_task_id or "").strip()
    sid = str(subtask_id or "").strip()
    if not mid or not sid:
        return False

    storage = get_project_storage()
    found = find_main_task(storage, mid)
    if not found:
        return False
    _project, task = found

    lead_thread = str(parent_thread_id or task.get("thread_id") or "").strip() or None
    from evoflow.collab.thread_ids import normalize_lead_thread_id

    lead_thread = normalize_lead_thread_id(lead_thread) or lead_thread

    source_message_id = str(message.get("id") or "").strip()
    role = str(message.get("role") or message.get("type") or "assistant").strip() or "assistant"
    # Align message_id with LangGraph / TranscriptMiddleware so stream replica does not duplicate rows.
    row_id = source_message_id or f"{sid}:msg:{message_index}"
    row: dict[str, Any] = {
        "id": row_id,
        "role": role,
        "timestamp": utc_now_iso_z(),
        "content": message.get("content"),
        "tool_calls": message.get("tool_calls"),
        "collab_subtask_id": sid,
    }
    tool_name = str(message.get("name") or message.get("tool_name") or "").strip()
    if tool_name:
        row["name"] = tool_name
        row["tool_name"] = tool_name
    tool_call_id = str(message.get("tool_call_id") or "").strip()
    if tool_call_id:
        row["tool_call_id"] = tool_call_id
    msg_type = str(message.get("type") or "").strip()
    if msg_type:
        row["type"] = msg_type

    added = _persist_subtask_entries_to_chat(
        lead_thread=lead_thread,
        subtask_id=sid,
        entries=[row],
        mirror_source_message=message if isinstance(message, dict) else row,
        default_model_name=default_model_name,
    )
    return added > 0


def flush_collab_subtask_stream_messages(
    main_task_id: str,
    subtask_id: str,
    messages: list[Any],
    *,
    parent_thread_id: str | None = None,
    run_id: str | None = None,
    default_model_name: str | None = None,
) -> int:
    """Terminal flush: persist worker ``stream_messages`` not yet in ``evoflow_chat_messages``."""
    if not isinstance(messages, list) or not messages:
        return 0
    mid = str(main_task_id or "").strip()
    sid = str(subtask_id or "").strip()
    if not mid or not sid:
        return 0
    appended = 0
    for i, message in enumerate(messages):
        if not isinstance(message, dict):
            continue
        tool_name = str(message.get("name") or message.get("tool_name") or "").strip().lower()
        # Canonical outcome row is written synchronously by subtask_outcome_report.
        if tool_name == "subtask_outcome_report":
            continue
        # Reuse append_collab_subtask_stream_message so row_id alignment is
        # guaranteed identical (no duplicate writes from divergent id schemes).
        # source_message_id is handled inside append_collab_subtask_stream_message.
        if append_collab_subtask_stream_message(
            mid,
            sid,
            message,
            i + 1,
            parent_thread_id=parent_thread_id,
            run_id=run_id,
            default_model_name=default_model_name,
        ):
            appended += 1
    return appended


def latest_subtask_conversation_text(
    task: dict[str, Any],
    subtask_id: str,
    *,
    max_len: int = 8000,
    subtask_row: dict[str, Any] | None = None,
) -> str:
    """Return the latest assistant/tool text for a subtask from chat transcript."""
    for msg in reversed(list_subtask_conversation_ui_messages(task, subtask_id, subtask_row=subtask_row, limit=200)):
        role = str(msg.get("role") or msg.get("type") or "").strip().lower()
        if role not in {"assistant", "ai", "tool"}:
            continue
        text = _normalize_text_content(msg.get("content"))
        if text:
            return text[:max_len]
    return ""


def mirror_lead_chat_message_to_task(
    thread_id: str,
    *,
    role: str,
    content: Any,
    message_id: str | None = None,
) -> bool:
    """No-op: Lead transcript is authoritative in ``evoflow_chat_messages``."""
    del thread_id, role, content, message_id
    return False


def reconcile_lead_conversation_from_chat(
    storage: Any,
    main_task_id: str,
    thread_id: str,
) -> int:
    """Bind lead thread to task and return lead chat message count.

    Transcript lives in ``evoflow_chat_messages`` (single source of truth); this does
    not replicate into legacy ``execution_conversation`` on the task row.
    """
    tid = str(thread_id or "").strip()
    mid = str(main_task_id or "").strip()
    if not tid or not mid:
        return 0
    found = find_main_task(storage, mid)
    if not found:
        return 0
    project, task = found
    bound = str(task.get("thread_id") or "").strip()
    if not bound:
        task["thread_id"] = tid
        task["updated_at"] = utc_now_iso_z()
        project["updated_at"] = task["updated_at"]
        try:
            storage.save_project(project)
        except Exception:
            logger.debug("reconcile_lead_conversation_from_chat: bind thread_id failed", exc_info=True)
            return 0
    elif bound != tid:
        logger.debug(
            "reconcile_lead_conversation_from_chat: task %s bound to %s, hint was %s",
            mid,
            bound,
            tid,
        )
    try:
        from evoflow.persistence import chat_message_repositories as msg_repo

        msgs = msg_repo.conversation_archive_from_thread_id(tid, limit=1200)
        return len(msgs) if msgs else 0
    except Exception:
        logger.debug("reconcile_lead_conversation_from_chat: chat lookup failed", exc_info=True)
        return 0


def append_subtask_outcome_record(
    storage: Any,
    main_task_id: str,
    subtask_id: str,
    *,
    status: str,
    task_report: str,
    outcome_reported_at: str,
    run_id: str | None = None,
    tool_call_id: str | None = None,
) -> bool:
    """Persist one canonical outcome row (from ``subtask_outcome_report``) into chat transcript."""
    report = str(task_report or "").strip()
    if not report:
        return False
    sid = str(subtask_id or "").strip()
    mid = str(main_task_id or "").strip()
    if not sid or not mid:
        return False
    at = str(outcome_reported_at or utc_now_iso_z()).strip()
    row_id = f"{sid}:outcome:{at}"
    entry: dict[str, Any] = {
        "id": row_id,
        "role": "tool",
        "type": "tool",
        "name": "subtask_outcome_report",
        "tool_name": "subtask_outcome_report",
        "timestamp": at,
        "content": report,
        "collab_subtask_id": sid,
    }
    row = find_main_task(storage, mid)
    if not row:
        return False
    _project, task = row
    subtask_row = next((st for st in (task.get("subtasks") or []) if str(st.get("id") or "").strip() == sid), None)
    from evoflow.collab.thread_ids import normalize_lead_thread_id

    lead_thread = normalize_lead_thread_id(str(task.get("thread_id") or "").strip()) or None
    if not lead_thread:
        return False
    rid = resolve_subtask_persist_run_id(
        explicit=run_id,
        tool_call_id=tool_call_id,
        lead_thread=lead_thread,
        subtask_id=sid,
        subtask_row=subtask_row if isinstance(subtask_row, dict) else None,
    )
    if rid:
        entry["run_id"] = rid
    if tool_call_id:
        entry["tool_call_id"] = str(tool_call_id).strip()
    added = _persist_subtask_entries_to_chat(lead_thread=lead_thread, subtask_id=sid, entries=[entry])
    return added > 0


__all__ = [
    "append_collab_subtask_stream_message",
    "flush_collab_subtask_stream_messages",
    "append_subtask_conversation_messages",
    "append_subtask_conversation_turn",
    "append_subtask_outcome_record",
    "latest_subtask_conversation_text",
    "resolve_subtask_persist_run_id",
    "list_subtask_conversation_ui_messages",
    "mirror_lead_chat_message_to_task",
    "reconcile_lead_conversation_from_chat",
]
