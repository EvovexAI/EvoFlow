"""Application-owned chat transcript — scalar columns + ``content_json`` body."""

from __future__ import annotations

import json
from typing import Any

from evoflow.persistence.chat_message_content import (
    dumps_payload,
    loads_payload,
    model_body_text,
    pack_payload,
    plain_text,
    tool_body_text,
    tool_calls,
)
from evoflow.persistence.db import db_connection_lock, get_db, run_db_transaction
from evoflow.persistence.timestamps import iso_z_to_ms, ms_to_iso_z, now_iso_z

# Real user turns kept immediately before the compaction marker (runtime-aligned).
_PRE_COMPACTION_KEEP_USER_TURNS = 3

_SELECT_COLS = """
    seq, role, run_id, thread_id, parent_thread_id, created_at,
    message_id, content_json, tool_call_id, tool_name,
    model_name, input_tokens, output_tokens, total_tokens,
    cache_read_tokens, cache_creation_tokens, cache_miss_tokens,
    round_id
"""


def resolve_parent_thread_id(
    thread_id: str | None,
    *,
    explicit: str | None = None,
) -> str | None:
    """Derive lead thread from executor ``{lead}__sub__{subtask}`` when not explicit."""
    parent = str(explicit or "").strip() or None
    if parent:
        return parent
    from evoflow.collab.thread_ids import is_collab_executor_thread, lead_thread_from_executor_thread

    tid = str(thread_id or "").strip()
    if not tid or not is_collab_executor_thread(tid):
        return None
    return lead_thread_from_executor_thread(tid)


def session_binding_thread_id(
    message_thread_id: str | None,
    existing_session_thread_id: str | None = None,
) -> str | None:
    """``evoflow_chat_sessions.thread_id`` must stay on the lead thread, not executor sub-threads."""
    tid = str(message_thread_id or "").strip() or None
    if not tid:
        return str(existing_session_thread_id or "").strip() or None
    from evoflow.collab.thread_ids import is_collab_executor_thread, lead_thread_from_executor_thread

    if is_collab_executor_thread(tid):
        lead = lead_thread_from_executor_thread(tid)
        if lead:
            return lead
        # SubThread_* (workflow / no-lead) — keep session bound to the executor id
        return tid
    return tid


def _is_lead_scope_chat_row(row: dict[str, Any]) -> bool:
    """True for main Lead transcript rows (exclude subtask executor threads / legacy mirrors)."""
    from evoflow.collab.conversation_scope import is_subtask_mirror_chat_row
    from evoflow.collab.thread_ids import is_collab_executor_thread

    if is_subtask_mirror_chat_row(row):
        return False
    if str(row.get("parent_thread_id") or "").strip():
        return False
    tid = str(row.get("thread_id") or "").strip()
    if tid and is_collab_executor_thread(tid):
        return False
    return True


def _next_seq(session_key: str, conn: Any) -> int:
    """Return the next seq for a session.

    Uses ``SELECT MAX(seq)+1`` inside the same transaction that will INSERT,
    which is safe under SQLite's serialized write model *as long as* the caller
    holds a write lock (``run_db_transaction`` or an explicit ``conn`` in a
    ``BEGIN IMMEDIATE`` transaction).  For callers that need cross-transaction
    safety, pass an explicit ``seq`` via ``append_message(seq=...)``.
    """
    row = conn.execute(
        "SELECT COALESCE(MAX(seq), 0) FROM evoflow_chat_messages WHERE session_key = ?",
        (session_key.strip(),),
    ).fetchone()
    return int(row[0] or 0) + 1


# native-style contextual user fragments: persisted for model hydration, hidden in chat UI.
_HIDDEN_CONTEXT_USER_NAMES = frozenset(
    {
        "goal",
        "goal_controller",
        "hosted_autofollow",
        "task_autofollow",
        "tool_approval_resume",
        "tool_approval_command",
        # Proactive duty full brief (board + tool rules); visible beat is separate.
        "proactive_duty_brief",
        # 小V 当前页快照（ephemeral Human；不应进用户气泡）
        "xiaomi_ui_context",
    }
)

# Injected user messages that should NOT be persisted as transcript rows.
# NOTE: "conversation_summary" is intentionally NOT in this set — compaction
# summaries are now persisted as chat message rows (role=user, tool_name=
# "conversation_summary") so that hydration naturally picks them up.
_INJECTED_USER_TOOL_NAMES = frozenset(
    {
        "tool_history",
        "todo_reminder",
        "collab_phase_hint",
        "xiaomi_ui_context",
    }
)


def _is_hidden_context_user_transcript(*, role: str, payload: dict[str, Any], tool_name: str | None) -> bool:
    if role != "user":
        return False
    if str(tool_name or "").strip() in _HIDDEN_CONTEXT_USER_NAMES:
        return True
    text = plain_text(payload).lstrip()
    return text.startswith("<xiaomi_ui_context>")


def _is_injected_user_transcript(*, role: str, payload: dict[str, Any], tool_name: str | None) -> bool:
    """Context compaction / tool-history blocks must never land in evoflow_chat_messages as user.

    Exception: ``conversation_summary`` rows ARE persisted (they carry the
    compaction marker that hydration uses to skip earlier messages).
    """
    if role != "user":
        return False
    tn = str(tool_name or "").strip()
    if tn == "conversation_summary":
        # Persisted compaction summaries — must NOT be filtered out.
        return False
    if tn in _INJECTED_USER_TOOL_NAMES:
        return True
    text = plain_text(payload).lstrip()
    if not text:
        return False
    if text.startswith("<xiaomi_ui_context>"):
        return True
    lower = text.lower()
    if lower.startswith("here is a summary of the conversation to date"):
        return True
    if lower.startswith("here's a summary of the conversation to date"):
        return True
    markers = (
        "[CONTEXT COMPACTION",
        "[上下文摘要",
        "[深度压缩摘要",
        "[tool:history]",
        "[tool:summary]",
        "__evf_tool_approval_v1__:",
        "__evf_tool_approval_replay_v1__:",
    )
    return any(text.startswith(m) for m in markers)


def _pick_usage(msg: dict[str, Any]) -> tuple[int | None, int | None, int | None, int | None, int | None, int | None]:
    from evoflow.agents.middlewares.message_usage_helpers import resolve_token_fields_for_persist

    return resolve_token_fields_for_persist(msg)


def _pick_model_name(msg: dict[str, Any]) -> str | None:
    for key in ("model_name", "model"):
        v = msg.get(key)
        if isinstance(v, str) and v.strip():
            return v.strip()
    rm = msg.get("response_metadata")
    if isinstance(rm, dict):
        for key in ("model_name", "model"):
            v = rm.get(key)
            if isinstance(v, str) and v.strip():
                return v.strip()
    return None


def pack_row_from_message(
    *,
    role: str | None = None,
    content: Any = None,
    message_id: str | None = None,
    content_json: dict[str, Any] | str | None = None,
    tool_call_id: str | None = None,
    tool_name: str | None = None,
    model_name: str | None = None,
    input_tokens: int | None = None,
    output_tokens: int | None = None,
    total_tokens: int | None = None,
    cache_read_tokens: int | None = None,
    cache_creation_tokens: int | None = None,
    cache_miss_tokens: int | None = None,
    raw: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Normalize one transcript append into DB columns + ``content_json`` payload."""
    from evoflow.agents.middlewares.message_usage_helpers import resolve_token_fields_for_persist

    src = raw if isinstance(raw, dict) else {}
    r, _mt = _infer_role_and_type(src, role_hint=role)
    payload = pack_payload(role=r, content=content, raw=src, content_json=content_json)
    mid = str(message_id or src.get("id") or src.get("message_id") or "").strip() or None
    tcid = str(tool_call_id or src.get("tool_call_id") or src.get("toolCallId") or "").strip() or None
    tname = str(tool_name or src.get("name") or src.get("tool_name") or "").strip() or None
    mname = model_name or _pick_model_name(src)
    inp, out, tot, cread, ccreate, cmiss = resolve_token_fields_for_persist(
        src if isinstance(src, dict) and src else None,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        total_tokens=total_tokens,
        cache_read_tokens=cache_read_tokens,
        cache_creation_tokens=cache_creation_tokens,
        cache_miss_tokens=cache_miss_tokens,
    )
    return {
        "role": r,
        "message_id": mid,
        "content_json": dumps_payload(payload),
        "payload": payload,
        "tool_call_id": tcid,
        "tool_name": tname,
        "model_name": mname,
        "input_tokens": inp,
        "output_tokens": out,
        "total_tokens": tot,
        "cache_read_tokens": cread,
        "cache_creation_tokens": ccreate,
        "cache_miss_tokens": cmiss,
    }


def normalize_transcript_fields(**kwargs: Any) -> dict[str, Any]:
    """Legacy alias for collab persist callers."""
    return pack_row_from_message(**kwargs)


def _infer_role_and_type(msg: dict[str, Any], *, role_hint: str | None = None) -> tuple[str, str]:
    role = str(role_hint or msg.get("role") or "").strip().lower()
    msg_type = str(msg.get("type") or "").strip()
    t_lower = msg_type.lower()
    if not role:
        if t_lower in ("human", "humanmessage"):
            role = "user"
        elif t_lower in ("ai", "aimessage", "aimessagechunk"):
            role = "assistant"
        elif t_lower in ("tool", "toolmessage"):
            role = "tool"
        else:
            role = "assistant"
    if not msg_type:
        if role == "user":
            msg_type = "human"
        elif role == "assistant":
            msg_type = "ai"
        elif role == "tool":
            msg_type = "tool"
        else:
            msg_type = role
    return role, msg_type


def _normalize_content_for_dedupe(text: str) -> str:
    return " ".join(str(text or "").split())


def message_id_exists(session_key: str, message_id: str, *, conn: Any | None = None) -> bool:
    sk = str(session_key or "").strip()
    mid = str(message_id or "").strip()
    if not sk or not mid:
        return False
    db = conn or get_db()
    row = db.execute(
        "SELECT 1 FROM evoflow_chat_messages WHERE session_key = ? AND message_id = ? LIMIT 1",
        (sk, mid),
    ).fetchone()
    return row is not None


def transcript_duplicate_exists(
    session_key: str,
    *,
    role: str,
    content_text: str,
    tool_call_id: str | None = None,
    run_id: str | None = None,
    conn: Any | None = None,
) -> bool:
    """Detect duplicate transcript rows (frontend batch retries)."""
    sk = str(session_key or "").strip()
    r = str(role or "").strip().lower()
    if not sk or r not in ("user", "assistant", "tool"):
        return False
    db = conn or get_db()
    tcid = str(tool_call_id or "").strip() or None
    if r == "tool" and tcid:
        row = db.execute(
            """
            SELECT 1 FROM evoflow_chat_messages
            WHERE session_key = ? AND role = 'tool' AND tool_call_id = ?
            LIMIT 1
            """,
            (sk, tcid),
        ).fetchone()
        return row is not None
    target = _normalize_content_for_dedupe(content_text)
    if not target:
        return False
    rid = str(run_id or "").strip() or None
    # Optimization: fetch only content_json + tool_call_id to reduce I/O,
    # and limit to recent 64 rows.  The Python-side comparison is unavoidable
    # because content_json is a serialized payload (not a plain text column),
    # but we avoid loading other columns and cap at 64 rows.
    if rid:
        rows = db.execute(
            """
            SELECT content_json FROM evoflow_chat_messages
            WHERE session_key = ? AND role = ?
              AND (run_id = ? OR run_id IS NULL OR run_id = '')
            ORDER BY seq DESC
            LIMIT 32
            """,
            (sk, r, rid),
        ).fetchall()
    else:
        rows = db.execute(
            """
            SELECT content_json FROM evoflow_chat_messages
            WHERE session_key = ? AND role = ?
            ORDER BY seq DESC
            LIMIT 64
            """,
            (sk, r),
        ).fetchall()
    for row in rows:
        payload = loads_payload(str(row[0] or ""))
        if _normalize_content_for_dedupe(plain_text(payload)) == target:
            return True
    return False


def seq_exists(session_key: str, seq: int, *, conn: Any | None = None) -> bool:
    sk = str(session_key or "").strip()
    if not sk or int(seq) < 1:
        return False
    db = conn or get_db()
    row = db.execute(
        "SELECT 1 FROM evoflow_chat_messages WHERE session_key = ? AND seq = ? LIMIT 1",
        (sk, int(seq)),
    ).fetchone()
    return row is not None


def delete_messages_for_session(session_key: str, *, conn: Any | None = None) -> int:
    sk = str(session_key or "").strip()
    if not sk:
        return 0
    def _delete(db: Any) -> int:
        cur = db.execute("DELETE FROM evoflow_chat_messages WHERE session_key = ?", (sk,))
        return int(cur.rowcount or 0)

    if conn is not None:
        return _delete(conn)
    return run_db_transaction(_delete)


def delete_messages_from_seq(session_key: str, from_seq: int, *, conn: Any | None = None) -> int:
    """Delete transcript rows with ``seq >= from_seq`` (inclusive). Returns deleted count."""
    sk = str(session_key or "").strip()
    cut = int(from_seq)
    if not sk or cut < 1:
        return 0

    def _delete(db: Any) -> int:
        cur = db.execute(
            "DELETE FROM evoflow_chat_messages WHERE session_key = ? AND seq >= ?",
            (sk, cut),
        )
        return int(cur.rowcount or 0)

    if conn is not None:
        return _delete(conn)
    return run_db_transaction(_delete)


def remap_session_messages_thread_id(
    session_key: str,
    new_thread_id: str,
    *,
    conn: Any | None = None,
) -> int:
    """Point remaining transcript rows at a replacement LangGraph thread."""
    sk = str(session_key or "").strip()
    tid = str(new_thread_id or "").strip()
    if not sk or not tid:
        return 0

    def _remap(db: Any) -> int:
        cur = db.execute(
            "UPDATE evoflow_chat_messages SET thread_id = ? WHERE session_key = ?",
            (tid, sk),
        )
        return int(cur.rowcount or 0)

    if conn is not None:
        return _remap(conn)
    return run_db_transaction(_remap)


def count_messages(session_key: str) -> int:
    sk = str(session_key or "").strip()
    if not sk:
        return 0
    # Hold lock across execute+fetchone: shared conn cursors are invalidated if
    # another thread runs a statement between the two calls.
    with db_connection_lock():
        row = get_db().execute(
            "SELECT COUNT(*) FROM evoflow_chat_messages WHERE session_key = ?",
            (sk,),
        ).fetchone()
        return int((row[0] if row else 0) or 0)


def resolve_seq_for_message_id(session_key: str, message_id: str, *, conn: Any | None = None) -> int | None:
    """Return the seq for ``message_id`` in ``session_key``, or None."""
    sk = str(session_key or "").strip()
    mid = str(message_id or "").strip()
    if not sk or not mid:
        return None
    db = conn or get_db()
    row = db.execute(
        """
        SELECT seq FROM evoflow_chat_messages
        WHERE session_key = ? AND message_id = ?
        ORDER BY seq ASC
        LIMIT 1
        """,
        (sk, mid),
    ).fetchone()
    if not row:
        return None
    try:
        return int(row[0])
    except (TypeError, ValueError):
        return None


def copy_messages_for_fork(
    source_session_key: str,
    dest_session_key: str,
    *,
    through_seq: int | None = None,
    new_thread_id: str | None = None,
    conn: Any | None = None,
) -> int:
    """Copy transcript rows into a forked session (same seqs; remap session/thread).

    ``through_seq=0`` copies nothing (empty branch, e.g. edit of the first user turn).
    Returns the number of rows inserted.
    """
    src = str(source_session_key or "").strip()
    dst = str(dest_session_key or "").strip()
    if not src or not dst or src == dst:
        return 0
    tid = str(new_thread_id or "").strip() or None
    cut = int(through_seq) if through_seq is not None else None
    if cut is not None and cut < 0:
        raise ValueError("through_seq must be >= 0")
    if cut == 0:
        return 0

    def _copy(db: Any) -> int:
        # Dest must be empty to keep UNIQUE(session_key, seq) / message_id semantics clean.
        existing = db.execute(
            "SELECT COUNT(*) FROM evoflow_chat_messages WHERE session_key = ?",
            (dst,),
        ).fetchone()
        if int((existing[0] if existing else 0) or 0) > 0:
            raise ValueError("dest session already has messages")
        if cut is None:
            cur = db.execute(
                """
                INSERT INTO evoflow_chat_messages (
                    session_key, seq, role, run_id, thread_id, parent_thread_id,
                    created_at, updated_at,
                    message_id, content_json, tool_call_id, tool_name,
                    model_name, input_tokens, output_tokens, total_tokens,
                    cache_read_tokens, cache_creation_tokens, cache_miss_tokens,
                    round_id
                )
                SELECT
                    ?, seq, role, run_id, ?, NULL,
                    created_at, COALESCE(updated_at, created_at),
                    message_id, content_json, tool_call_id, tool_name,
                    model_name, input_tokens, output_tokens, total_tokens,
                    cache_read_tokens, cache_creation_tokens, cache_miss_tokens,
                    round_id
                FROM evoflow_chat_messages
                WHERE session_key = ?
                ORDER BY seq ASC
                """,
                (dst, tid, src),
            )
        else:
            cur = db.execute(
                """
                INSERT INTO evoflow_chat_messages (
                    session_key, seq, role, run_id, thread_id, parent_thread_id,
                    created_at, updated_at,
                    message_id, content_json, tool_call_id, tool_name,
                    model_name, input_tokens, output_tokens, total_tokens,
                    cache_read_tokens, cache_creation_tokens, cache_miss_tokens,
                    round_id
                )
                SELECT
                    ?, seq, role, run_id, ?, NULL,
                    created_at, COALESCE(updated_at, created_at),
                    message_id, content_json, tool_call_id, tool_name,
                    model_name, input_tokens, output_tokens, total_tokens,
                    cache_read_tokens, cache_creation_tokens, cache_miss_tokens,
                    round_id
                FROM evoflow_chat_messages
                WHERE session_key = ? AND seq <= ?
                ORDER BY seq ASC
                """,
                (dst, tid, src, cut),
            )
        return int(cur.rowcount or 0)

    if conn is not None:
        return _copy(conn)
    return run_db_transaction(_copy)


def _row_to_internal(row: tuple[Any, ...]) -> dict[str, Any]:
    (
        seq,
        role,
        run_id,
        thread_id,
        parent_thread_id,
        created_at,
        message_id,
        content_json,
        tool_call_id,
        tool_name,
        model_name,
        input_tokens,
        output_tokens,
        total_tokens,
        cache_read_tokens,
        cache_creation_tokens,
        cache_miss_tokens,
        round_id,
    ) = row
    payload = loads_payload(str(content_json or ""))
    out: dict[str, Any] = {
        "seq": int(seq),
        "role": str(role),
        "payload": payload,
        "content_json": str(content_json or ""),
        "content": payload.get("content"),
        "run_id": run_id,
        "thread_id": thread_id,
        "parent_thread_id": parent_thread_id,
        "created_at_ms": iso_z_to_ms(created_at),
        "message_id": message_id,
        "tool_call_id": tool_call_id,
        "tool_name": tool_name,
        "model_name": model_name,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": total_tokens,
        "cache_read_tokens": cache_read_tokens,
        "cache_creation_tokens": cache_creation_tokens,
        "cache_miss_tokens": cache_miss_tokens,
        "round_id": round_id,
    }
    tc = tool_calls(payload)
    if tc:
        out["tool_calls"] = tc
    return out


def _resolve_run_id_for_append(
    session_key: str,
    *,
    role: str,
    run_id: str | None = None,
    thread_id: str | None = None,
    raw: dict[str, Any] | None = None,
) -> str | None:
    from evoflow.persistence.transcript_run_id import resolve_run_id_for_transcript

    return resolve_run_id_for_transcript(
        session_key,
        role=role,
        run_id=run_id,
        thread_id=thread_id,
        raw=raw,
    )


def append_message(
    session_key: str,
    *,
    role: str,
    content: Any = None,
    run_id: str | None = None,
    thread_id: str | None = None,
    round_id: str | None = None,
    conn: Any | None = None,
    skip_if_message_id_exists: bool = True,
    skip_if_seq_exists: bool = False,
    seq: int | None = None,
    **flat_kwargs: Any,
) -> dict[str, Any] | None:
    sk = str(session_key or "").strip()
    raw = flat_kwargs.pop("raw", None) if isinstance(flat_kwargs, dict) else None
    explicit_parent = str(
        flat_kwargs.pop("parent_thread_id", None) or flat_kwargs.pop("parentThreadId", None) or ""
    ).strip() or None
    rid_round = str(
        round_id
        or flat_kwargs.pop("round_id", None)
        or flat_kwargs.pop("roundId", None)
        or ""
    ).strip() or None
    for _meta_key in ("thread_id", "threadId", "run_id", "runId", "seq", "round_id", "roundId"):
        flat_kwargs.pop(_meta_key, None)
    fields = pack_row_from_message(
        role=role,
        content=content,
        raw=raw if isinstance(raw, dict) else None,
        content_json=flat_kwargs.pop("content_json", None) or flat_kwargs.pop("contentJson", None),
        message_id=flat_kwargs.pop("message_id", None) or flat_kwargs.pop("messageId", None),
        tool_call_id=flat_kwargs.pop("tool_call_id", None) or flat_kwargs.pop("toolCallId", None),
        tool_name=flat_kwargs.pop("tool_name", None) or flat_kwargs.pop("toolName", None),
        model_name=flat_kwargs.pop("model_name", None) or flat_kwargs.pop("modelName", None),
        input_tokens=flat_kwargs.pop("input_tokens", None) or flat_kwargs.pop("inputTokens", None),
        output_tokens=flat_kwargs.pop("output_tokens", None) or flat_kwargs.pop("outputTokens", None),
        total_tokens=flat_kwargs.pop("total_tokens", None) or flat_kwargs.pop("totalTokens", None),
        cache_read_tokens=flat_kwargs.pop("cache_read_tokens", None) or flat_kwargs.pop("cacheReadTokens", None),
        cache_creation_tokens=flat_kwargs.pop("cache_creation_tokens", None) or flat_kwargs.pop("cacheCreationTokens", None),
        cache_miss_tokens=flat_kwargs.pop("cache_miss_tokens", None) or flat_kwargs.pop("cacheMissTokens", None),
    )
    r = fields["role"]
    payload = fields["payload"]
    if not sk or r not in ("user", "assistant", "tool"):
        raise ValueError("session_key and role (user|assistant|tool) required")
    if _is_injected_user_transcript(role=r, payload=payload, tool_name=fields.get("tool_name")):
        return None
    mid = fields.get("message_id")
    if skip_if_message_id_exists and mid and message_id_exists(sk, mid, conn=conn):
        return None
    dedupe_text = plain_text(payload)
    tool_name_for_dedupe = str(fields.get("tool_name") or "").strip()
    # Each compaction summary is a new versioned marker row (no in-place overwrite).
    skip_transcript_dedupe = tool_name_for_dedupe == "conversation_summary"
    tid_for_run = str(thread_id or "").strip() or None
    if not tid_for_run and isinstance(raw, dict):
        tid_for_run = str(raw.get("thread_id") or raw.get("threadId") or "").strip() or None
    rid = _resolve_run_id_for_append(
        sk,
        role=r,
        run_id=run_id,
        thread_id=tid_for_run,
        raw=raw if isinstance(raw, dict) else None,
    )
    if transcript_duplicate_exists(
        sk,
        role=r,
        content_text=dedupe_text,
        tool_call_id=fields.get("tool_call_id"),
        run_id=rid,
        conn=conn,
    ) and not skip_transcript_dedupe:
        return None
    def _insert(db: Any) -> dict[str, Any] | None:
        if seq is not None:
            target_seq = int(seq)
            if target_seq < 1:
                raise ValueError("seq must be >= 1")
            if skip_if_seq_exists and seq_exists(sk, target_seq, conn=db):
                return None
        else:
            target_seq = _next_seq(sk, db)
        now = now_iso_z()
        tid = tid_for_run or str(thread_id or "").strip() or None
        parent_tid = resolve_parent_thread_id(
            tid,
            explicit=explicit_parent,
        )
        db.execute(
            """
            INSERT INTO evoflow_chat_messages (
                session_key, seq, role, run_id, thread_id, parent_thread_id,
                created_at, updated_at,
                message_id, content_json, tool_call_id, tool_name,
                model_name, input_tokens, output_tokens, total_tokens,
                cache_read_tokens, cache_creation_tokens, cache_miss_tokens,
                round_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                sk,
                target_seq,
                r,
                rid,
                tid,
                parent_tid,
                now,
                now,
                fields.get("message_id"),
                fields.get("content_json"),
                fields.get("tool_call_id"),
                fields.get("tool_name"),
                fields.get("model_name"),
                fields.get("input_tokens"),
                fields.get("output_tokens"),
                fields.get("total_tokens"),
                fields.get("cache_read_tokens"),
                fields.get("cache_creation_tokens"),
                fields.get("cache_miss_tokens"),
                rid_round,
            ),
        )
        out = {
            "session_key": sk,
            "seq": target_seq,
            "role": r,
            "created_at_ms": iso_z_to_ms(now),
            "message_id": mid,
            "round_id": rid_round,
            "model_name": fields.get("model_name"),
            "input_tokens": fields.get("input_tokens"),
            "output_tokens": fields.get("output_tokens"),
            "total_tokens": fields.get("total_tokens"),
            "cache_read_tokens": fields.get("cache_read_tokens"),
            "cache_creation_tokens": fields.get("cache_creation_tokens"),
            "cache_miss_tokens": fields.get("cache_miss_tokens"),
        }
        if rid:
            _backfill_run_id_on_turn_tail(sk, rid, thread_id=tid, conn=db)
        return out

    if conn is not None:
        return _insert(conn)
    return run_db_transaction(_insert)


def append_messages_batch(
    session_key: str,
    items: list[dict[str, Any]],
    *,
    run_id: str | None = None,
    thread_id: str | None = None,
    parent_thread_id: str | None = None,
    round_id: str | None = None,
    conn: Any | None = None,
    skip_if_seq_exists: bool = False,
) -> dict[str, Any]:
    sk = str(session_key or "").strip()
    if not sk:
        return {"appended": 0, "skipped": 0}

    def _batch(db: Any) -> dict[str, Any]:
        appended = 0
        skipped = 0
        token_totals = {
            "input_tokens": 0,
            "output_tokens": 0,
            "total_tokens": 0,
            "cache_read_tokens": 0,
            "cache_creation_tokens": 0,
            "cache_miss_tokens": 0,
        }
        for item in items:
            if not isinstance(item, dict):
                skipped += 1
                continue
            row = dict(item)
            row["run_id"] = str(row.get("run_id") or row.get("runId") or run_id or "").strip() or None
            row.setdefault("thread_id", thread_id)
            if row.get("parentThreadId") and not row.get("parent_thread_id"):
                row["parent_thread_id"] = row.get("parentThreadId")
            row.setdefault("parent_thread_id", parent_thread_id)
            row_round = str(
                row.get("round_id") or row.get("roundId") or round_id or ""
            ).strip() or None
            explicit_seq = row.get("seq")
            try:
                seq_arg = int(explicit_seq) if explicit_seq is not None else None
            except (TypeError, ValueError):
                seq_arg = None
            res = append_message(
                sk,
                role=str(row.get("role") or ""),
                content=row.get("content"),
                content_json=row.get("content_json") or row.get("contentJson"),
                run_id=row.get("run_id") or row.get("runId"),
                thread_id=row.get("thread_id") or row.get("threadId"),
                round_id=row_round,
                conn=db,
                skip_if_message_id_exists=True,
                skip_if_seq_exists=skip_if_seq_exists,
                seq=seq_arg,
                message_id=row.get("message_id") or row.get("messageId"),
                tool_call_id=row.get("tool_call_id") or row.get("toolCallId"),
                tool_name=row.get("tool_name") or row.get("toolName"),
                model_name=row.get("model_name") or row.get("modelName"),
                input_tokens=row.get("input_tokens") or row.get("inputTokens"),
                output_tokens=row.get("output_tokens") or row.get("outputTokens"),
                total_tokens=row.get("total_tokens") or row.get("totalTokens"),
                cache_read_tokens=row.get("cache_read_tokens") or row.get("cacheReadTokens"),
                cache_creation_tokens=row.get("cache_creation_tokens") or row.get("cacheCreationTokens"),
                cache_miss_tokens=row.get("cache_miss_tokens") or row.get("cacheMissTokens"),
                parent_thread_id=row.get("parent_thread_id") or row.get("parentThreadId"),
                raw=row,
            )
            if res:
                appended += 1
                for key in token_totals:
                    token_totals[key] += int(res.get(key) or 0)
            else:
                skipped += 1
        batch_run = str(run_id or "").strip() or None
        if batch_run:
            _backfill_run_id_on_turn_tail(sk, batch_run, thread_id=thread_id, conn=db)
        return {"appended": appended, "skipped": skipped, **token_totals}

    if conn is not None:
        return _batch(conn)
    return run_db_transaction(_batch)


def list_messages(
    session_key: str,
    *,
    limit: int = 200,
    offset: int = 0,
    before_seq: int | None = None,
    min_seq: int | None = None,
    round_id: str | None = None,
) -> list[dict[str, Any]]:
    sk = str(session_key or "").strip()
    if not sk:
        return []
    lim = max(1, min(int(limit), 500))
    off = max(0, int(offset))
    clauses = ["session_key = ?"]
    params: list[Any] = [sk]
    rid = str(round_id or "").strip()
    if rid:
        clauses.append("round_id = ?")
        params.append(rid)
    if before_seq is not None:
        clauses.append("seq < ?")
        params.append(int(before_seq))
    if min_seq is not None:
        clauses.append("seq >= ?")
        params.append(int(min_seq))
    params.extend([lim, off])
    rows = (
        get_db()
        .execute(
            f"""
        SELECT {_SELECT_COLS}
        FROM evoflow_chat_messages
        WHERE {' AND '.join(clauses)}
        ORDER BY seq DESC
        LIMIT ? OFFSET ?
        """,
            tuple(params),
        )
        .fetchall()
    )
    return [_row_to_internal(tuple(r)) for r in reversed(rows)]


def _slim_tool_payload_for_display(
    payload: dict[str, Any],
    tool_call_id: str,
    tool_name: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Slim tool body inside ``content_json`` for UI list API (full body via tool-results)."""
    tcid = str(tool_call_id or "").strip()
    tname = str(tool_name or "tool")
    if not tcid or payload.get("content") is None:
        return payload, {}
    try:
        from evoflow.tools.tool_result_store import slim_content_for_ui

        display_content, meta = slim_content_for_ui(tcid, tname, payload.get("content"))
        if not meta:
            return payload, {}
        out = dict(payload)
        out["content"] = display_content
        return out, meta
    except Exception:
        return payload, {}


def _row_to_display_dict(row: dict[str, Any]) -> dict[str, Any]:
    role = row["role"]
    if role == "user":
        msg_type = "human"
    elif role == "assistant":
        msg_type = "ai"
    elif role == "tool":
        msg_type = "tool"
    else:
        msg_type = role
    payload = row.get("payload") if isinstance(row.get("payload"), dict) else loads_payload(str(row.get("content_json") or ""))
    slim_meta: dict[str, Any] = {}
    if role == "tool" or msg_type == "tool":
        tcid = str(row.get("tool_call_id") or "").strip()
        tname = str(row.get("tool_name") or row.get("name") or "tool")
        payload, slim_meta = _slim_tool_payload_for_display(payload, tcid, tname)
    msg: dict[str, Any] = {
        "role": role,
        "type": msg_type,
        "content_json": payload,
    }
    if slim_meta:
        msg.update(slim_meta)
    if row.get("message_id"):
        msg["id"] = row["message_id"]
    if row.get("run_id"):
        msg["run_id"] = row["run_id"]
    if row.get("round_id"):
        msg["round_id"] = row["round_id"]
    if row.get("thread_id"):
        msg["thread_id"] = row["thread_id"]
    if row.get("parent_thread_id"):
        msg["parent_thread_id"] = row["parent_thread_id"]
    if row.get("model_name"):
        msg["model_name"] = row["model_name"]
    if row.get("input_tokens") is not None:
        msg["input_tokens"] = row["input_tokens"]
    if row.get("output_tokens") is not None:
        msg["output_tokens"] = row["output_tokens"]
    if row.get("total_tokens") is not None:
        msg["total_tokens"] = row["total_tokens"]
    if row.get("cache_read_tokens") is not None:
        msg["cache_read_tokens"] = row["cache_read_tokens"]
    if row.get("cache_creation_tokens") is not None:
        msg["cache_creation_tokens"] = row["cache_creation_tokens"]
    if row.get("cache_miss_tokens") is not None:
        msg["cache_miss_tokens"] = row["cache_miss_tokens"]
    if row.get("tool_call_id"):
        msg["tool_call_id"] = row["tool_call_id"]
    if row.get("tool_name"):
        msg["name"] = row["tool_name"]
    um: dict[str, Any] = {}
    if row.get("input_tokens") is not None:
        um["input_tokens"] = row["input_tokens"]
    if row.get("output_tokens") is not None:
        um["output_tokens"] = row["output_tokens"]
    if row.get("total_tokens") is not None:
        um["total_tokens"] = row["total_tokens"]
    for cache_key in ("cache_read_tokens", "cache_creation_tokens", "cache_miss_tokens"):
        if row.get(cache_key) is not None:
            um[cache_key] = row[cache_key]
    if um:
        msg["usage_metadata"] = um
    if row.get("model_name"):
        msg["model_name"] = row["model_name"]
        rm = msg.setdefault("response_metadata", {})
        if isinstance(rm, dict):
            rm["model_name"] = row["model_name"]
    if row.get("seq") is not None:
        msg["seq"] = int(row["seq"])
    ts_ms = row.get("created_at_ms")
    if ts_ms:
        msg["timestamp"] = ms_to_iso_z(ts_ms)
    return msg


def _parse_tool_call_args(raw_tc: dict[str, Any]) -> dict[str, Any]:
    """Normalize persisted assistant tool_calls entry args."""
    raw = raw_tc.get("args")
    if isinstance(raw, dict):
        return dict(raw)
    if isinstance(raw, str) and raw.strip():
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                return parsed
        except Exception:
            pass
    fn = raw_tc.get("function")
    if isinstance(fn, dict):
        args_raw = fn.get("arguments")
        if isinstance(args_raw, dict):
            return dict(args_raw)
        if isinstance(args_raw, str) and args_raw.strip():
            try:
                parsed = json.loads(args_raw)
                if isinstance(parsed, dict):
                    return parsed
            except Exception:
                pass
    return {}


def _tool_call_id_of(raw_tc: dict[str, Any]) -> str:
    return str(raw_tc.get("id") or raw_tc.get("tool_call_id") or "").strip()


def _tool_name_of(raw_tc: dict[str, Any]) -> str:
    name = raw_tc.get("name") or raw_tc.get("tool_name") or raw_tc.get("toolName")
    if isinstance(name, str) and name.strip():
        return name.strip()
    fn = raw_tc.get("function")
    if isinstance(fn, dict):
        fn_name = fn.get("name")
        if isinstance(fn_name, str) and fn_name.strip():
            return fn_name.strip()
    return "tool"


def find_tool_call_in_session(session_key: str, tool_call_id: str) -> dict[str, Any] | None:
    """Lookup assistant tool_calls entry by id (args are the authoritative request payload)."""
    sk = str(session_key or "").strip()
    tcid = str(tool_call_id or "").strip()
    if not sk or not tcid:
        return None
    rows = (
        get_db()
        .execute(
            """
            SELECT content_json
            FROM evoflow_chat_messages
            WHERE session_key = ? AND role = 'assistant'
            ORDER BY seq DESC
            LIMIT ?
            """,
            (sk, 2000),
        )
        .fetchall()
    )
    for row in rows:
        payload = loads_payload(str(row[0] or ""))
        tcs = tool_calls(payload) or []
        for tc in tcs:
            if not isinstance(tc, dict):
                continue
            if _tool_call_id_of(tc) != tcid:
                continue
            return {
                "toolCallId": tcid,
                "toolName": _tool_name_of(tc),
                "args": _parse_tool_call_args(tc),
            }
    return None


def get_tool_result_for_display(session_key: str, tool_call_id: str) -> dict[str, Any] | None:
    """Full tool output + request args from ``evoflow_chat_messages`` (lazy UI expand)."""
    sk = str(session_key or "").strip()
    tcid = str(tool_call_id or "").strip()
    if not sk or not tcid:
        return None
    row = get_db().execute(
        """
        SELECT tool_name, content_json
        FROM evoflow_chat_messages
        WHERE session_key = ? AND role = 'tool' AND tool_call_id = ?
        ORDER BY seq DESC
        LIMIT 1
        """,
        (sk, tcid),
    ).fetchone()
    call_meta = find_tool_call_in_session(sk, tcid)
    if not row and not call_meta:
        return None
    tname = str(row[0] or "tool").strip() if row else str(call_meta.get("toolName") or "tool").strip() or "tool"
    body = tool_body_text(loads_payload(str(row[1] or ""))) if row else ""
    from evoflow.tools.tool_result_store import build_preview_text

    args = call_meta.get("args") if isinstance(call_meta, dict) else None
    return {
        "toolCallId": tcid,
        "toolName": tname,
        "content": body,
        "contentBytes": len(body.encode("utf-8")),
        "preview": build_preview_text(body, tool_name=tname),
        "args": dict(args) if isinstance(args, dict) else {},
    }


def update_tool_transcript_content(
    session_key: str,
    tool_call_id: str,
    *,
    content: Any,
    tool_name: str | None = None,
) -> bool:
    """Overwrite an existing tool row body (e.g. pending_approval → executed result).

    Transcript insert dedupes by ``tool_call_id``, so approval replay must UPDATE
    the pending row instead of appending a second tool message.
    """
    sk = str(session_key or "").strip()
    tcid = str(tool_call_id or "").strip()
    if not sk or not tcid:
        return False
    payload = pack_payload(role="tool", content=content if content is not None else "")
    body = dumps_payload(payload)
    tname = str(tool_name or "").strip() or None
    now = now_iso_z()

    def _upd(db: Any) -> bool:
        if tname:
            cur = db.execute(
                """
                UPDATE evoflow_chat_messages
                SET content_json = ?, tool_name = ?, updated_at = ?
                WHERE session_key = ? AND role = 'tool' AND tool_call_id = ?
                """,
                (body, tname, now, sk, tcid),
            )
        else:
            cur = db.execute(
                """
                UPDATE evoflow_chat_messages
                SET content_json = ?, updated_at = ?
                WHERE session_key = ? AND role = 'tool' AND tool_call_id = ?
                """,
                (body, now, sk, tcid),
            )
        return int(getattr(cur, "rowcount", 0) or 0) > 0

    return bool(run_db_transaction(_upd))


def _row_payload(row: dict[str, Any]) -> dict[str, Any]:
    payload = row.get("payload")
    if isinstance(payload, dict):
        return payload
    return loads_payload(str(row.get("content_json") or ""))


def get_pending_clarification_for_session(session_key: str) -> dict[str, Any] | None:
    """Authoritative pending ask_clarification for UI sidebar (DB scan, no frontend heuristics)."""
    sk = str(session_key or "").strip()
    if not sk:
        return None
    rows = list_messages(sk, limit=500)
    if not rows:
        return None

    last_user_seq: int | None = None
    for row in reversed(rows):
        if _is_real_user_transcript_row(row):
            last_user_seq = int(row.get("seq") or 0)
            break

    pending_tcid: str | None = None
    pending_ask_seq: int | None = None
    for row in reversed(rows):
        seq = int(row.get("seq") or 0)
        if last_user_seq is not None and seq <= last_user_seq:
            break
        if str(row.get("role") or "").lower() != "assistant":
            continue
        payload = _row_payload(row)
        tcs = tool_calls(payload) or []
        for tc in reversed(tcs):
            if not isinstance(tc, dict):
                continue
            if _tool_name_of(tc).lower() != "ask_clarification":
                continue
            tcid = _tool_call_id_of(tc)
            if tcid:
                pending_tcid = tcid
                pending_ask_seq = seq
                break
        if pending_tcid:
            break

    if not pending_tcid:
        for row in reversed(rows):
            seq = int(row.get("seq") or 0)
            if last_user_seq is not None and seq <= last_user_seq:
                break
            if str(row.get("role") or "").lower() != "tool":
                continue
            tname = str(row.get("tool_name") or row.get("name") or "").strip().lower()
            if tname != "ask_clarification":
                continue
            tcid = str(row.get("tool_call_id") or "").strip()
            if tcid:
                pending_tcid = tcid
                pending_ask_seq = seq
                break

    if not pending_tcid or pending_ask_seq is None:
        return None

    for row in rows:
        seq = int(row.get("seq") or 0)
        if seq <= pending_ask_seq:
            continue
        if str(row.get("role") or "").lower() != "user":
            continue
        text = plain_text(_row_payload(row)).strip()
        if text.startswith("__EVF_CLARIFY_ANS"):
            return None
        if _is_real_user_transcript_row(row):
            return None

    return get_tool_result_for_display(sk, pending_tcid)


def _is_real_user_transcript_row(row: dict[str, Any]) -> bool:
    """True for genuine user transcript rows (not compaction / tool-history injections)."""
    role = str(row.get("role") or "").strip().lower()
    if role != "user":
        return False
    tn = str(row.get("tool_name") or "").strip()
    if tn == "conversation_summary":
        return False
    payload = row.get("payload") if isinstance(row.get("payload"), dict) else loads_payload(str(row.get("content_json") or ""))
    if _is_injected_user_transcript(role=role, payload=payload, tool_name=tn):
        return False
    if _is_hidden_context_user_transcript(role=role, payload=payload, tool_name=tn):
        return False
    return bool(plain_text(payload).strip())


def _is_hidden_context_user_transcript_row(row: dict[str, Any]) -> bool:
    role = str(row.get("role") or "").strip().lower()
    payload = row.get("payload") if isinstance(row.get("payload"), dict) else loads_payload(str(row.get("content_json") or ""))
    return _is_hidden_context_user_transcript(role=role, payload=payload, tool_name=row.get("tool_name"))


def _find_latest_real_user_lead_row(session_key: str) -> dict[str, Any] | None:
    """Newest main-session user row with real content (scan backward in transcript)."""
    sk = str(session_key or "").strip()
    if not sk:
        return None
    offset = 0
    batch = 500
    max_scan = 5000
    scanned = 0
    while scanned < max_scan:
        chunk = list_messages(sk, limit=batch, offset=offset)
        if not chunk:
            break
        scanned += len(chunk)
        for row in reversed(chunk):
            if not _is_lead_scope_chat_row(row):
                continue
            if _is_real_user_transcript_row(row):
                return row
        if len(chunk) < batch:
            break
        offset += len(chunk)
    return None


def _anchor_latest_real_user_into_lead_rows(rows: list[dict[str, Any]], session_key: str) -> list[dict[str, Any]]:
    """Ensure a genuine user turn is present for model context when the tail omits one.

    After ``conversation_summary`` exists, post-compaction rows are stitched verbatim
    from DB (summary row through latest). User context for that segment is injected
    via system prompt — do not splice session-wide user rows into the transcript.
    """
    if not rows:
        return rows

    summary_idx = -1
    for i, row in enumerate(rows):
        if str(row.get("tool_name") or "").strip() == "conversation_summary":
            summary_idx = i

    if summary_idx >= 0:
        return rows

    if any(_is_real_user_transcript_row(r) for r in rows):
        return rows
    anchor = _find_latest_real_user_lead_row(session_key)
    if anchor is None:
        return rows
    anchor_seq = int(anchor.get("seq") or 0)
    if any(int(r.get("seq") or 0) == anchor_seq for r in rows):
        return rows
    return [anchor, *rows]


def _payload_for_row(row: dict[str, Any]) -> dict[str, Any]:
    payload = row.get("payload")
    if isinstance(payload, dict):
        return payload
    return loads_payload(str(row.get("content_json") or ""))


def _supervisor_action_and_task_id(row: dict[str, Any]) -> tuple[str | None, str | None]:
    """Parse ``action`` / ``taskId`` from a supervisor ToolMessage row.

    The ToolMessage content is supervisor's JSON output (e.g. action=monitor_execution_step).
    Returns (None, None) when the row is not a supervisor tool message.
    """
    if str(row.get("role") or "").strip().lower() != "tool":
        return None, None
    if str(row.get("tool_name") or "").strip() != "supervisor":
        return None, None
    body = tool_body_text(_payload_for_row(row))
    if not body or not body.strip():
        return None, None
    try:
        data = json.loads(body)
    except Exception:
        return None, None
    if not isinstance(data, dict):
        return None, None
    action = data.get("action")
    task_id = data.get("taskId") or data.get("task_id")
    action_s = str(action).strip() if isinstance(action, str) and action.strip() else None
    task_s = str(task_id).strip() if isinstance(task_id, str) and task_id.strip() else None
    return action_s, task_s


def _prune_monitor_execution_step_rows(
    rows: list[dict[str, Any]],
    *,
    keep_last_per_task: int = 1,
) -> list[dict[str, Any]]:
    """Drop older ``supervisor(action=monitor_execution_step)`` tool rows per task_id.

    Keeps the latest ``keep_last_per_task`` per ``task_id`` so model context retains
    just enough monitor snapshots; UI transcript itself is untouched (this only
    filters what we feed back to the model during hydration).
    """
    if not rows or keep_last_per_task < 1:
        return rows

    by_task: dict[str, list[int]] = {}
    for i, row in enumerate(rows):
        action, task_id = _supervisor_action_and_task_id(row)
        if action != "monitor_execution_step" or not task_id:
            continue
        by_task.setdefault(task_id, []).append(i)

    if not by_task:
        return rows

    drop: set[int] = set()
    for idxs in by_task.values():
        if len(idxs) <= keep_last_per_task:
            continue
        for j in idxs[:-keep_last_per_task]:
            drop.add(j)

    if not drop:
        return rows
    return [row for i, row in enumerate(rows) if i not in drop]


def find_latest_compaction_seq(session_key: str) -> int | None:
    """Return the seq of the newest persisted ``conversation_summary`` row, or None.

    When non-None, hydration should load rows from this seq onward (inclusive),
    skipping earlier messages that have already been folded into the summary.
    """
    sk = str(session_key or "").strip()
    if not sk:
        return None
    row = get_db().execute(
        """
        SELECT seq FROM evoflow_chat_messages
        WHERE session_key = ? AND role = 'user' AND tool_name = 'conversation_summary'
        ORDER BY seq DESC LIMIT 1
        """,
        (sk,),
    ).fetchone()
    if not row:
        return None
    return int(row[0])


def get_session_hydration_watermark(session_key: str) -> tuple[int, int | None]:
    """Cheap ``(max_seq, compaction_seq)`` for hydration cache fingerprinting."""
    sk = str(session_key or "").strip()
    if not sk:
        return 0, None
    row = get_db().execute(
        "SELECT COALESCE(MAX(seq), 0) FROM evoflow_chat_messages WHERE session_key = ?",
        (sk,),
    ).fetchone()
    max_seq = int(row[0] or 0) if row else 0
    return max_seq, find_latest_compaction_seq(sk)

def load_conversation_summary_text(session_key: str) -> str | None:
    """Load body text of the newest ``conversation_summary`` row (SSOT for compaction)."""
    sk = str(session_key or "").strip()
    if not sk:
        return None
    row = get_db().execute(
        """
        SELECT content_json FROM evoflow_chat_messages
        WHERE session_key = ? AND role = 'user' AND tool_name = 'conversation_summary'
        ORDER BY seq DESC LIMIT 1
        """,
        (sk,),
    ).fetchone()
    if not row or not row[0]:
        return None
    payload = loads_payload(str(row[0]))
    body = plain_text(payload)
    return body.strip() if body.strip() else None


def _new_compaction_summary_message_id(session_key: str) -> str:
    """Fresh id per compress event — never reuse hydrated/runtime message ids."""
    import uuid

    sk = str(session_key or "").strip() or "session"
    return f"compaction-summary:{sk}:{uuid.uuid4().hex}"


def persist_conversation_summary(
    session_key: str,
    summary_text: str,
    *,
    thread_id: str | None = None,
    run_id: str | None = None,
    message_id: str | None = None,
    skip_if_unchanged: bool = True,
    force_write: bool = False,
) -> dict[str, Any] | None:
    """Persist compaction summary — always INSERT a new row at transcript tail.

    Same contract as user messages via ``append_message`` (new seq + message_id).
    Never UPDATE an existing row — hydration anchors on ``find_latest_compaction_seq``.
    """
    sk = str(session_key or "").strip()
    text = str(summary_text or "").strip()
    if not sk or not text:
        return None
    if skip_if_unchanged and not force_write:
        existing_seq = find_latest_compaction_seq(sk)
        existing = load_conversation_summary_text(sk)
        if existing and existing.strip() == text:
            return {"seq": existing_seq, "skipped": True} if existing_seq else None
    tid = str(thread_id or "").strip() or None
    mid = str(message_id or "").strip() or _new_compaction_summary_message_id(sk)
    rid = _resolve_run_id_for_append(
        sk,
        role="user",
        run_id=run_id,
        thread_id=tid,
        raw=None,
    )
    appended = append_message(
        sk,
        role="user",
        content=text,
        thread_id=tid,
        run_id=rid,
        message_id=mid,
        tool_name="conversation_summary",
        skip_if_message_id_exists=False,
    )
    if appended is not None:
        try:
            from evoflow.observability.compaction_file_log import log_summary_db_persist

            log_summary_db_persist(
                session_key=sk,
                thread_id=thread_id,
                row=appended,
                summary_chars=len(text),
                note="append compaction marker",
            )
        except Exception:
            pass
    return appended


def _prune_stale_compaction_summary_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Hydration sends only the newest ``conversation_summary`` row to the model."""
    if not rows:
        return rows
    summary_idxs = [
        i
        for i, row in enumerate(rows)
        if str(row.get("tool_name") or "").strip() == "conversation_summary"
    ]
    if len(summary_idxs) <= 1:
        return rows
    drop = set(summary_idxs[:-1])
    return [row for i, row in enumerate(rows) if i not in drop]


def _find_pre_compaction_anchor_seq(
    session_key: str,
    compaction_seq: int,
    *,
    user_turns: int = _PRE_COMPACTION_KEEP_USER_TURNS,
) -> int:
    """Return the seq of the oldest real user turn within the last *user_turns*
    **before** the compaction marker (Runtime: preserve user asks old→new).

    Hydration loads from this seq onward (through summary + post-compaction tail).
    Post-compaction assistant/tool hops stay in the post-summary tail verbatim.

    Falls back to ``compaction_seq`` when fewer user turns exist before the marker.
    """
    sk = str(session_key or "").strip()
    if not sk or compaction_seq is None:
        return compaction_seq  # type: ignore[return-value]
    want_turns = max(1, int(user_turns))
    found_user_seqs: list[int] = []
    offset = 0
    batch = 500
    max_scan = 5000
    scanned = 0
    while len(found_user_seqs) < want_turns and scanned < max_scan:
        chunk = list_messages(sk, limit=batch, offset=offset, before_seq=compaction_seq)
        if not chunk:
            break
        scanned += len(chunk)
        offset += len(chunk)
        for row in reversed(chunk):  # newest→oldest
            if not _is_lead_scope_chat_row(row):
                continue
            if not _is_real_user_transcript_row(row):
                continue
            seq = int(row.get("seq") or 0)
            if seq > 0:
                found_user_seqs.append(seq)
                if len(found_user_seqs) >= want_turns:
                    break
        if len(chunk) < batch:
            break
    if not found_user_seqs:
        return compaction_seq
    return found_user_seqs[-1]


def _lead_row_at_seq(session_key: str, seq: int) -> dict[str, Any] | None:
    sk = str(session_key or "").strip()
    if not sk or seq is None:
        return None
    row = get_db().execute(
        f"""
        SELECT {_SELECT_COLS}
        FROM evoflow_chat_messages
        WHERE session_key = ? AND seq = ?
        LIMIT 1
        """,
        (sk, int(seq)),
    ).fetchone()
    if not row:
        return None
    internal = _row_to_internal(tuple(row))
    if not _is_lead_scope_chat_row(internal):
        return None
    return internal


def _filter_pre_compaction_bridge_rows(
    rows: list[dict[str, Any]],
    *,
    compaction_seq: int,
) -> list[dict[str, Any]]:
    """Keep only real user rows in ``[anchor, compaction_seq)`` — no stale summaries or assistant/tool hops."""
    cap = int(compaction_seq)
    return [
        row
        for row in rows
        if int(row.get("seq") or 0) < cap and _is_real_user_transcript_row(row)
    ]


def list_lead_chat_rows_for_model_hydration(
    session_key: str,
    *,
    limit: int | None = None,
    keep_last_monitor_per_task: int = 1,
    round_id: str | None = None,
) -> list[dict[str, Any]]:
    """Tail transcript for model hydration; always retains the latest genuine user turn.

    If a persisted ``conversation_summary`` row exists, hydration starts from
    that row's seq onward (inclusive) — earlier messages have been folded into
    the summary and are skipped to avoid sending stale full context.

    **User-message bridge** (runtime-aligned): load the most recent
    ``_PRE_COMPACTION_KEEP_USER_TURNS`` real user turns immediately before compaction via
    ``_find_pre_compaction_anchor_seq``.  The resulting message sequence is:

        [pre-compaction user messages old→new] → [latest summary] → [post-compaction tail from DB]

    Post-compaction tail is loaded verbatim from ``compaction_seq`` onward (no tail
    cap, no session-wide user splice). Stale ``conversation_summary`` rows in the
    loaded range are dropped so only the newest marker is hydrated (older rows remain
    on disk for UI history).

    ``limit`` is optional. ``None`` (default) loads the full lead transcript (or the
    full post-compaction stitch). A positive int keeps only the newest N lead rows
    for callers that still want a bound. Token compaction — not a fixed row cap —
    is the primary context safety valve.

    ``round_id`` is ignored for model hydration (kept for call-site compatibility).
    Scoping by round previously dumped ≤500 raw rows and skipped the summary stitch.

    Verbose ``supervisor(action=monitor_execution_step)`` tool rows balloon model
    context (each row is multi-KB JSON, called in a loop), so we keep only the
    latest ``keep_last_monitor_per_task`` per ``task_id``. The on-disk transcript
    and UI views are untouched — this filter only narrows what the model sees on
    re-hydration. Set ``keep_last_monitor_per_task=0`` to disable.
    """
    _ = round_id  # deprecated for model hydration
    compaction_seq = find_latest_compaction_seq(session_key)
    stitch_meta: dict[str, Any] = {"compaction_seq": compaction_seq}
    row_cap = None if limit is None else max(1, int(limit))
    if compaction_seq is not None:
        anchor_seq = _find_pre_compaction_anchor_seq(session_key, compaction_seq)
        pre_cap = max(_PRE_COMPACTION_KEEP_USER_TURNS * 4, 12)
        pre_rows = _filter_pre_compaction_bridge_rows(
            _list_lead_chat_rows_from_min_seq(session_key, anchor_seq, max_want=pre_cap),
            compaction_seq=int(compaction_seq),
        )
        summary_row = _lead_row_at_seq(session_key, int(compaction_seq))
        post_rows = _list_lead_chat_rows_from_min_seq(
            session_key,
            int(compaction_seq) + 1,
            max_want=row_cap,
        )
        stitch_meta.update(
            anchor_seq=anchor_seq,
            pre_bridge_rows=len(pre_rows),
            post_tail_rows=len(post_rows),
            has_summary_row=summary_row is not None,
            mode="compaction_stitch",
        )
        tail: list[dict[str, Any]] = [*pre_rows]
        if summary_row is not None:
            tail.append(summary_row)
        tail.extend(post_rows)
    else:
        tail = _list_lead_chat_rows(session_key, limit=row_cap)
        stitch_meta["mode"] = "full_tail"
    anchored = _anchor_latest_real_user_into_lead_rows(tail, session_key)
    pruned_summaries = _prune_stale_compaction_summary_rows(anchored)
    stitch_meta["hydrated_rows"] = len(pruned_summaries)
    try:
        from evoflow.observability.compaction_file_log import log_compaction_trace

        log_compaction_trace(
            "hydration拼接",
            session_key=session_key,
            **stitch_meta,
        )
    except Exception:
        pass
    if keep_last_monitor_per_task < 1:
        return pruned_summaries
    return _prune_monitor_execution_step_rows(pruned_summaries, keep_last_per_task=keep_last_monitor_per_task)


def latest_real_user_question_text(
    session_key: str = "",
    *,
    thread_id: str | None = None,
) -> str:
    """Plain-text body of the newest real user message for this session/thread."""
    sk = str(session_key or "").strip()
    if not sk and thread_id:
        from evoflow.persistence.session_repositories import find_session_key_by_thread_id

        sk = find_session_key_by_thread_id(str(thread_id).strip()) or ""
    row = _find_latest_real_user_lead_row(sk) if sk else None
    if row is None:
        return ""
    payload = row.get("payload") if isinstance(row.get("payload"), dict) else loads_payload(str(row.get("content_json") or ""))
    return plain_text(payload).strip()


def list_recent_real_user_texts(
    session_key: str = "",
    *,
    thread_id: str | None = None,
    limit: int = 10,
) -> list[dict[str, str]]:
    """Return up to ``limit`` recent real user message texts as ``{text, ts}`` dicts.

    Used as a DB fallback for ``user_requests_store`` when the in-memory store is
    empty (e.g. after process restart).  Scans backward through the transcript,
    collecting genuine user messages (not compaction / tool-history injections).
    """
    sk = str(session_key or "").strip()
    if not sk and thread_id:
        from evoflow.persistence.session_repositories import find_session_key_by_thread_id

        sk = find_session_key_by_thread_id(str(thread_id).strip()) or ""
    if not sk:
        return []
    want = max(1, min(int(limit), 50))
    collected: list[dict[str, str]] = []
    offset = 0
    batch = 500
    max_scan = 5000
    scanned = 0
    while len(collected) < want and scanned < max_scan:
        chunk = list_messages(sk, limit=batch, offset=offset)
        if not chunk:
            break
        scanned += len(chunk)
        for row in reversed(chunk):
            if not _is_lead_scope_chat_row(row):
                continue
            # Exclude compaction summaries (tool_name=conversation_summary) —
            # _is_real_user_transcript_row deliberately lets them through because
            # hydration needs the marker, but user_requests must only show real
            # user messages.
            if str(row.get("tool_name") or "").strip() == "conversation_summary":
                continue
            if _is_real_user_transcript_row(row):
                payload = (
                    row.get("payload")
                    if isinstance(row.get("payload"), dict)
                    else loads_payload(str(row.get("content_json") or ""))
                )
                text = plain_text(payload).strip()
                if text:
                    # _row_to_internal stores epoch ms in "created_at_ms" (Beijing ISO source).
                    ts_ms = row.get("created_at_ms") or 0
                    try:
                        from evoflow.persistence.timestamps import ms_to_iso_z

                        ts = ms_to_iso_z(ts_ms)[11:16] if ts_ms else ""
                    except Exception:
                        ts = ""
                    collected.append({"text": text[:500], "ts": ts})
                    if len(collected) >= want:
                        break
        if len(chunk) < batch:
            break
        offset += len(chunk)
    collected.reverse()
    return collected


def _list_lead_chat_rows_from_min_seq(
    session_key: str,
    min_seq: int,
    *,
    max_want: int | None = None,
) -> list[dict[str, Any]]:
    """Chronological lead-scope rows with ``seq >= min_seq`` (hydration SSOT stitch).

    Unlike ``_list_lead_chat_rows(..., min_seq=...)`` which keeps only the *newest*
    ``limit`` rows, this walks forward from ``min_seq`` so post-compaction transcript
    grows monotonically in model context instead of sliding away older rows.

    Implementation note: ``list_messages`` pages with ``ORDER BY seq DESC`` then
    reverses *within each page* to ASC. Concatenating page0+page1 therefore yields
    ``[newer_window_asc] + [older_window_asc]`` — older user turns land *after*
    newer ones, so monitoring's "用户最新问题" and the model both see a stale ask.
    Collect pages, sort by ``seq`` ascending; if ``max_want`` is set and over that,
    keep the newest window so the latest real user turn is never dropped.
    ``max_want=None`` loads the full range from ``min_seq``.
    """
    sk = str(session_key or "").strip()
    if not sk:
        return []
    want = None if max_want is None else max(1, int(max_want))
    collected: list[dict[str, Any]] = []
    offset = 0
    batch = 500
    while True:
        chunk = list_messages(sk, limit=batch, offset=offset, min_seq=int(min_seq))
        if not chunk:
            break
        offset += len(chunk)
        for row in chunk:
            if not _is_lead_scope_chat_row(row):
                continue
            collected.append(row)
        # Do not stop on short pages: list_messages may clamp limit below ``batch``.
        # Empty chunk is the only end signal (offset walks the full DESC window).

    collected.sort(key=lambda r: int(r.get("seq") or 0))
    if want is not None and len(collected) > want:
        collected = collected[-want:]
    return collected


def _list_lead_chat_rows(
    session_key: str,
    *,
    limit: int | None = 200,
    before_seq: int | None = None,
    max_want: int | None = None,
    min_seq: int | None = None,
    round_id: str | None = None,
) -> list[dict[str, Any]]:
    """Return main-session rows, skipping subtask executor / legacy mirror rows.

    When ``limit`` is ``None``, load the full lead transcript (paginated).
    When ``limit`` is set, return up to that many newest rows (optionally further
    capped by ``max_want``).

    When ``min_seq`` is set, only rows with ``seq >= min_seq`` are considered
    (used by hydration to start from a compaction marker onward).
    When ``round_id`` is set, only rows tagged with that proactive duty round.
    """
    sk = str(session_key or "").strip()
    if not sk:
        return []
    if limit is None:
        want: int | None = None
    else:
        want = max(1, int(limit))
        if max_want is not None:
            want = min(want, max(1, int(max_want)))
    collected: list[dict[str, Any]] = []
    offset = 0
    batch = 500
    while True:
        if want is not None and len(collected) >= want:
            break
        chunk = list_messages(
            sk,
            limit=batch,
            offset=offset,
            before_seq=before_seq,
            min_seq=min_seq,
            round_id=round_id,
        )
        if not chunk:
            break
        offset += len(chunk)
        for row in reversed(chunk):
            if not _is_lead_scope_chat_row(row):
                continue
            collected.append(row)
            if want is not None and len(collected) >= want:
                break
        # Empty chunk ends; short pages may be limit clamps — keep offset paging.
    collected.reverse()
    return collected


def count_lead_messages(session_key: str) -> int:
    """Non-subtask-mirror rows in the session transcript.

    Uses a SQL filter approximating ``_is_lead_scope_chat_row`` so list endpoints
    do not materialize up to 5000 lead rows just to count them.
    """
    sk = str(session_key or "").strip()
    if not sk:
        return 0
    # Hold lock across execute+fetchone (shared-conn cursor race → fetchone None).
    with db_connection_lock():
        row = get_db().execute(
            """
            SELECT COUNT(*) FROM evoflow_chat_messages
            WHERE session_key = ?
              AND (parent_thread_id IS NULL OR TRIM(parent_thread_id) = '')
              AND (
                message_id IS NULL
                OR TRIM(message_id) = ''
                OR message_id NOT LIKE 'Subtask\\_%' ESCAPE '\\'
              )
              AND (
                thread_id IS NULL
                OR TRIM(thread_id) = ''
                OR (
                  INSTR(thread_id, '__sub__') = 0
                  AND INSTR(thread_id, '::sub::') = 0
                  AND thread_id NOT LIKE 'SubThread\\_%' ESCAPE '\\'
                )
              )
            """,
            (sk,),
        ).fetchone()
        return int((row[0] if row else 0) or 0)


def _enrich_run_ids_for_display_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    from evoflow.persistence.transcript_run_id import enrich_run_ids_in_order

    return enrich_run_ids_in_order(rows)


def backfill_missing_run_ids_in_session(
    session_key: str,
    *,
    thread_id: str | None = None,
    conn: Any | None = None,
) -> int:
    """Persist turn-scoped run_id onto rows that were stored without it (middleware legacy)."""
    sk = str(session_key or "").strip()
    if not sk:
        return 0
    db = conn or get_db()
    tid = str(thread_id or "").strip() or None
    if tid:
        raw_rows = db.execute(
            """
            SELECT seq, role, run_id FROM evoflow_chat_messages
            WHERE session_key = ?
              AND (thread_id = ? OR thread_id IS NULL OR TRIM(thread_id) = '')
            ORDER BY seq ASC
            """,
            (sk, tid),
        ).fetchall()
    else:
        raw_rows = db.execute(
            """
            SELECT seq, role, run_id FROM evoflow_chat_messages
            WHERE session_key = ?
            ORDER BY seq ASC
            """,
            (sk,),
        ).fetchall()
    if not raw_rows:
        return 0
    items = [{"seq": int(r[0]), "role": str(r[1]), "run_id": r[2]} for r in raw_rows]
    enriched = _enrich_run_ids_for_display_rows(items)
    updated = 0

    def _write(db_conn: Any) -> int:
        nonlocal updated
        now = now_iso_z()
        for before, after in zip(items, enriched):
            new_rid = str(after.get("run_id") or "").strip()
            old_rid = str(before.get("run_id") or "").strip()
            if not new_rid or new_rid == old_rid:
                continue
            cur = db_conn.execute(
                """
                UPDATE evoflow_chat_messages
                SET run_id = ?, updated_at = ?
                WHERE session_key = ? AND seq = ?
                  AND (run_id IS NULL OR TRIM(run_id) = '')
                """,
                (new_rid, now, sk, int(before["seq"])),
            )
            updated += int(cur.rowcount or 0)
        return updated

    if conn is not None:
        return _write(conn)
    return run_db_transaction(_write)


def list_messages_for_display(
    session_key: str,
    *,
    limit: int = 200,
    before_seq: int | None = None,
) -> list[dict[str, Any]]:
    """Rows shaped for EvoPanel ``buildHistoryViewFromRaw``."""
    page = list_messages_for_display_paginated(session_key, limit=limit, before_seq=before_seq)
    return list(page.get("messages") or [])


_SESSION_DISPLAY_ALL_CAP = 5000


def list_messages_for_display_all(
    session_key: str,
    *,
    max_rows: int = _SESSION_DISPLAY_ALL_CAP,
    round_id: str | None = None,
    include_hidden: bool = False,
) -> dict[str, Any]:
    """Full chronological display transcript for one session (single response, no cursor).

    When ``round_id`` is set, only that proactive duty round is returned.
    When ``include_hidden`` is true, keep native-style hidden user rows (e.g. duty brief).
    """
    sk = str(session_key or "").strip()
    rid = str(round_id or "").strip() or None
    cap = max(1, min(int(max_rows), _SESSION_DISPLAY_ALL_CAP))
    if not sk:
        return {"messages": [], "has_more": False, "oldest_seq": None, "round_id": rid}
    lead_rows = _list_lead_chat_rows(sk, limit=cap, max_want=cap, round_id=rid)
    if sk and any(not str(r.get("run_id") or "").strip() for r in lead_rows):
        _backfill_missing_run_ids_in_session_safe(sk)
        lead_rows = _list_lead_chat_rows(sk, limit=cap, max_want=cap, round_id=rid)
    lead_rows = _enrich_run_ids_for_display_rows(lead_rows)
    if not include_hidden:
        lead_rows = [r for r in lead_rows if not _is_hidden_context_user_transcript_row(r)]
    messages = [_row_to_display_dict(r) for r in lead_rows]
    oldest_seq = int(lead_rows[0]["seq"]) if lead_rows else None
    return {"messages": messages, "has_more": False, "oldest_seq": oldest_seq, "round_id": rid}


def list_messages_for_display_paginated(
    session_key: str,
    *,
    limit: int = 40,
    before_seq: int | None = None,
) -> dict[str, Any]:
    """Chronological display rows with cursor pagination (newest page when ``before_seq`` is None).

    Page windows are soft-aligned to real user turns: if the oldest row would be an
    orphan assistant (mid-turn cut), older rows are prepended until the owning user
    message is included so UI collapse can keep one AI bubble per turn.
    """
    sk = str(session_key or "").strip()
    lim = max(1, min(int(limit), 200))
    if not sk:
        return {"messages": [], "has_more": False, "oldest_seq": None}
    lead_rows = _list_lead_chat_rows(sk, limit=lim + 1, before_seq=before_seq)
    has_more = len(lead_rows) > lim
    if has_more:
        lead_rows = lead_rows[-lim:]
    if sk and before_seq is None and any(not str(r.get("run_id") or "").strip() for r in lead_rows):
        _backfill_missing_run_ids_in_session_safe(sk)
        lead_rows = _list_lead_chat_rows(sk, limit=lim + 1, before_seq=before_seq)
        has_more = len(lead_rows) > lim
        if has_more:
            lead_rows = lead_rows[-lim:]
    lead_rows = _enrich_run_ids_for_display_rows(lead_rows)
    lead_rows = [r for r in lead_rows if not _is_hidden_context_user_transcript_row(r)]
    lead_rows = _align_display_page_to_user_turn(sk, lead_rows, page_limit=lim)
    messages = [_row_to_display_dict(r) for r in lead_rows]
    oldest_seq = int(lead_rows[0]["seq"]) if lead_rows else None
    # Re-check has_more against the (possibly extended) oldest seq
    if oldest_seq is not None:
        older = _list_lead_chat_rows(sk, limit=1, before_seq=oldest_seq)
        has_more = bool(older)
    return {"messages": messages, "has_more": has_more, "oldest_seq": oldest_seq}


def _align_display_page_to_user_turn(
    session_key: str,
    rows: list[dict[str, Any]],
    *,
    page_limit: int,
) -> list[dict[str, Any]]:
    """Prepend older rows until the page starts on a real user (or transcript start)."""
    sk = str(session_key or "").strip()
    if not sk or not rows:
        return rows
    out = list(rows)
    # Already starts on a real user — nothing to do.
    if _is_real_user_transcript_row(out[0]):
        return out
    max_extend = max(24, min(80, int(page_limit) * 2))
    guard = 0
    while guard < max_extend and out and not _is_real_user_transcript_row(out[0]):
        guard += 1
        try:
            cursor = int(out[0].get("seq") or 0)
        except (TypeError, ValueError):
            break
        if cursor < 1:
            break
        # Fetch a small older window; skip hidden context users when prepending.
        older_chunk = _list_lead_chat_rows(sk, limit=8, before_seq=cursor)
        if not older_chunk:
            break
        visible = [r for r in older_chunk if not _is_hidden_context_user_transcript_row(r)]
        if not visible:
            # Only hidden rows older — advance cursor past them
            try:
                cursor = int(older_chunk[0].get("seq") or 0)
            except (TypeError, ValueError):
                break
            if cursor < 1:
                break
            # Force progress: prepend nothing but lower bound via re-fetch with older before
            older_chunk = _list_lead_chat_rows(sk, limit=1, before_seq=cursor)
            if not older_chunk:
                break
            visible = [r for r in older_chunk if not _is_hidden_context_user_transcript_row(r)]
            if not visible:
                break
        # Prepend oldest→newest so out[0] moves backward
        for r in reversed(visible):
            out.insert(0, r)
            if _is_real_user_transcript_row(r):
                return out
    return out



def latest_run_id_for_thread_id(thread_id: str) -> str | None:
    """Most recent non-empty ``run_id`` on rows for one checkpoint ``thread_id``."""
    tid = str(thread_id or "").strip()
    if not tid:
        return None
    db = get_db()
    row = db.execute(
        """
        SELECT run_id FROM evoflow_chat_messages
        WHERE thread_id = ?
          AND run_id IS NOT NULL AND TRIM(run_id) != ''
        ORDER BY seq DESC LIMIT 1
        """,
        (tid,),
    ).fetchone()
    if not row:
        return None
    rid = str(row[0] or "").strip()
    return rid or None


def latest_user_run_id(session_key: str, *, thread_id: str | None = None) -> str | None:
    """Most recent user row ``run_id`` for checkpoint / turn backfill."""
    sk = str(session_key or "").strip()
    if not sk:
        return None
    tid = str(thread_id or "").strip() or None
    db = get_db()
    if tid:
        row = db.execute(
            """
            SELECT run_id FROM evoflow_chat_messages
            WHERE session_key = ? AND role = 'user'
              AND run_id IS NOT NULL AND TRIM(run_id) != ''
              AND (thread_id = ? OR thread_id IS NULL OR TRIM(thread_id) = '')
            ORDER BY seq DESC LIMIT 1
            """,
            (sk, tid),
        ).fetchone()
    else:
        row = db.execute(
            """
            SELECT run_id FROM evoflow_chat_messages
            WHERE session_key = ? AND role = 'user'
              AND run_id IS NOT NULL AND TRIM(run_id) != ''
            ORDER BY seq DESC LIMIT 1
            """,
            (sk,),
        ).fetchone()
    if not row:
        return None
    rid = str(row[0] or "").strip()
    return rid or None


def _backfill_run_id_on_turn_tail(
    session_key: str,
    run_id: str | None,
    *,
    thread_id: str | None = None,
    conn: Any | None = None,
) -> None:
    """Tag assistant/tool rows in the same turn when batch/checkpoint missed ``run_id``."""
    sk = str(session_key or "").strip()
    rid = str(run_id or "").strip()
    if not sk or not rid:
        return
    db = conn or get_db()
    tid = str(thread_id or "").strip() or None
    user_row = db.execute(
        """
        SELECT seq FROM evoflow_chat_messages
        WHERE session_key = ? AND role = 'user' AND run_id = ?
        ORDER BY seq DESC LIMIT 1
        """,
        (sk, rid),
    ).fetchone()
    if not user_row:
        row = db.execute(
            """
            SELECT seq FROM evoflow_chat_messages
            WHERE session_key = ? AND role = 'user'
            ORDER BY seq DESC LIMIT 1
            """,
            (sk,),
        ).fetchone()
        if not row:
            return
        min_seq = int(row[0])
    else:
        min_seq = int(user_row[0])
    if tid:
        next_user = db.execute(
            """
            SELECT seq FROM evoflow_chat_messages
            WHERE session_key = ? AND role = 'user' AND seq > ?
              AND (thread_id = ? OR thread_id IS NULL OR TRIM(thread_id) = '')
            ORDER BY seq ASC LIMIT 1
            """,
            (sk, min_seq, tid),
        ).fetchone()
    else:
        next_user = db.execute(
            """
            SELECT seq FROM evoflow_chat_messages
            WHERE session_key = ? AND role = 'user' AND seq > ?
            ORDER BY seq ASC LIMIT 1
            """,
            (sk, min_seq),
        ).fetchone()
    max_seq = int(next_user[0]) - 1 if next_user else None
    if max_seq is not None and max_seq < min_seq:
        return
    if tid:
        if max_seq is not None:
            db.execute(
                """
                UPDATE evoflow_chat_messages
                SET run_id = ?
                WHERE session_key = ? AND seq >= ? AND seq <= ?
                  AND (run_id IS NULL OR TRIM(run_id) = '')
                  AND (thread_id = ? OR thread_id IS NULL OR TRIM(thread_id) = '')
                """,
                (rid, sk, min_seq, max_seq, tid),
            )
        else:
            db.execute(
                """
                UPDATE evoflow_chat_messages
                SET run_id = ?
                WHERE session_key = ? AND seq >= ?
                  AND (run_id IS NULL OR TRIM(run_id) = '')
                  AND (thread_id = ? OR thread_id IS NULL OR TRIM(thread_id) = '')
                """,
                (rid, sk, min_seq, tid),
            )
    elif max_seq is not None:
        db.execute(
            """
            UPDATE evoflow_chat_messages
            SET run_id = ?
            WHERE session_key = ? AND seq >= ? AND seq <= ?
              AND (run_id IS NULL OR TRIM(run_id) = '')
            """,
            (rid, sk, min_seq, max_seq),
        )
    else:
        db.execute(
            """
            UPDATE evoflow_chat_messages
            SET run_id = ?
            WHERE session_key = ? AND seq >= ?
              AND (run_id IS NULL OR TRIM(run_id) = '')
            """,
            (rid, sk, min_seq),
        )
    # NOTE: do not commit here — the caller (append_message / append_messages_batch)
    # manages the transaction via run_db_transaction or an explicit conn.
    # Committing prematurely would break atomicity of the enclosing write.


def _backfill_missing_run_ids_in_session_safe(session_key: str, *, thread_id: str | None = None) -> int:
    """Backfill run_id in a fire-and-forget write transaction, safe to call from read paths.

    Unlike ``backfill_missing_run_ids_in_session``, this always opens its own
    transaction via ``run_db_transaction`` and never commits a caller's
    transaction prematurely.
    """
    sk = str(session_key or "").strip()
    if not sk:
        return 0
    try:
        return run_db_transaction(lambda db: backfill_missing_run_ids_in_session(sk, thread_id=thread_id, conn=db))
    except Exception:
        return 0


def list_messages_for_display_with_im_fallback(
    session_key: str,
    *,
    limit: int = 200,
) -> tuple[list[dict[str, Any]], str]:
    """Return transcript rows from ``evoflow_chat_messages`` only."""
    sk = str(session_key or "").strip()
    return list_messages_for_display(sk, limit=limit), "evoflow_chat_messages"


def _content_to_langgraph_blocks(content: Any) -> list[dict[str, Any]]:
    if isinstance(content, str):
        text = content.strip()
        return [{"type": "text", "text": text}] if text else []
    if isinstance(content, list):
        return [x for x in content if isinstance(x, dict)]
    if isinstance(content, dict):
        return [content]
    return []


def transcript_row_text_for_model(row: dict[str, Any]) -> str:
    """Text sent to the model from ``content_json``."""
    payload = row.get("payload") if isinstance(row.get("payload"), dict) else loads_payload(str(row.get("content_json") or ""))
    return model_body_text(payload)


def recent_text_pairs_for_suggestions(session_key: str, *, limit: int = 6) -> list[dict[str, str]]:
    rows = list_messages(session_key, limit=200)
    pairs: list[dict[str, str]] = []
    for row in rows:
        role = row["role"]
        if role not in ("user", "assistant"):
            continue
        payload = row.get("payload") if isinstance(row.get("payload"), dict) else loads_payload(str(row.get("content_json") or ""))
        text = plain_text(payload).strip()
        if not text:
            continue
        pairs.append({"role": role, "content": text})
    return pairs[-max(1, limit) :]


def list_messages_for_model_input(session_key: str, *, limit: int | None = None) -> list[dict[str, Any]]:
    """LangGraph-shaped messages for debugging/API: user + assistant (with tool_calls) + tool rows."""
    from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

    from evoflow.agents.middlewares.session_transcript_hydration_middleware import (
        lead_transcript_rows_to_lc_messages,
    )

    rows = list_lead_chat_rows_for_model_hydration(session_key, limit=limit)
    out: list[dict[str, Any]] = []
    for msg in lead_transcript_rows_to_lc_messages(rows):
        if isinstance(msg, HumanMessage):
            blocks = _content_to_langgraph_blocks(msg.content)
            if not blocks and isinstance(msg.content, str) and msg.content.strip():
                blocks = [{"type": "text", "text": msg.content}]
            if not blocks:
                continue
            out.append({"role": "user", "content": blocks})
        elif isinstance(msg, AIMessage):
            content = msg.content
            if isinstance(content, list):
                blocks = _content_to_langgraph_blocks(content)
            elif isinstance(content, str) and content.strip():
                blocks = [{"type": "text", "text": content}]
            else:
                blocks = []
            entry: dict[str, Any] = {
                "role": "assistant",
                "content": blocks if blocks else (content if isinstance(content, str) else ""),
            }
            if msg.tool_calls:
                entry["tool_calls"] = msg.tool_calls
            if not entry.get("content") and not entry.get("tool_calls"):
                continue
            out.append(entry)
        elif isinstance(msg, ToolMessage):
            tcid = str(msg.tool_call_id or "").strip()
            if not tcid:
                continue
            out.append(
                {
                    "role": "tool",
                    "content": msg.content if msg.content is not None else "",
                    "tool_call_id": tcid,
                    "name": str(msg.name or "tool"),
                }
            )
    return out


def list_rows_for_thread_id(thread_id: str, *, limit: int = 200) -> list[dict[str, Any]]:
    """All transcript rows for a specific LangGraph ``thread_id`` (Lead or executor)."""
    from evoflow.collab.thread_ids import is_collab_executor_thread, lead_thread_from_executor_thread
    from evoflow.persistence import session_repositories as sess_repo

    tid = str(thread_id or "").strip()
    if not tid:
        return []
    lim = max(1, min(int(limit), 5000))
    sk = sess_repo.find_session_key_by_thread_id(tid)
    if not sk and is_collab_executor_thread(tid):
        lead = lead_thread_from_executor_thread(tid)
        if lead:
            sk = sess_repo.find_session_key_by_thread_id(lead)
    db = get_db()
    if sk:
        rows = db.execute(
            f"""
            SELECT {_SELECT_COLS}
            FROM evoflow_chat_messages
            WHERE session_key = ? AND thread_id = ?
            ORDER BY seq ASC
            LIMIT ?
            """,
            (sk, tid, lim),
        ).fetchall()
    else:
        rows = db.execute(
            f"""
            SELECT {_SELECT_COLS}
            FROM evoflow_chat_messages
            WHERE thread_id = ?
            ORDER BY seq ASC
            LIMIT ?
            """,
            (tid, lim),
        ).fetchall()
    return [_row_to_internal(tuple(r)) for r in rows]


def list_rows_for_subtask_id(subtask_id: str, *, limit: int = 500) -> list[dict[str, Any]]:
    """Find worker transcript rows by stable ``subtask_id`` (survives lead thread recreate).

    Matches ``SubThread_{sid}``, ``%__sub__{sid}``, and ``message_id`` prefixed with ``{sid}:``.
    """
    from evoflow.collab.thread_ids import SUBTASK_THREAD_SEP

    sid = str(subtask_id or "").strip()
    if not sid:
        return []
    lim = max(1, min(int(limit), 5000))
    exact = f"SubThread_{sid}"
    suffix = f"%{SUBTASK_THREAD_SEP}{sid}"
    mid_prefix = f"{sid}:%"
    db = get_db()
    rows = db.execute(
        f"""
        SELECT {_SELECT_COLS}
        FROM evoflow_chat_messages
        WHERE thread_id = ?
           OR thread_id LIKE ?
           OR message_id LIKE ?
        ORDER BY created_at ASC, seq ASC
        LIMIT ?
        """,
        (exact, suffix, mid_prefix, lim),
    ).fetchall()
    out: list[dict[str, Any]] = []
    for r in rows:
        internal = _row_to_internal(tuple(r))
        tid = str(internal.get("thread_id") or "").strip()
        mid = str(internal.get("message_id") or "").strip()
        if tid == exact or tid.endswith(f"{SUBTASK_THREAD_SEP}{sid}") or mid.startswith(f"{sid}:"):
            out.append(internal)
    return out


def list_messages_for_thread_id(thread_id: str, *, limit: int = 200) -> list[dict[str, Any]]:
    return [_row_to_display_dict(r) for r in list_rows_for_thread_id(thread_id, limit=limit)]


def _archive_from_app_transcript(thread_id: str, *, limit: int) -> list[dict[str, Any]]:
    from evoflow.collab.thread_ids import is_collab_executor_thread
    from evoflow.persistence import session_repositories as sess_repo

    tid = str(thread_id or "").strip()
    if not tid:
        return []
    if is_collab_executor_thread(tid):
        return [_row_to_display_dict(row) for row in list_rows_for_thread_id(tid, limit=limit)]
    sk = sess_repo.find_session_key_by_thread_id(tid)
    if not sk:
        return []
    rows = _list_lead_chat_rows(sk, limit=limit)
    return [_row_to_display_dict(row) for row in rows]


def conversation_archive_from_thread_id(
    thread_id: str,
    *,
    limit: int = 1200,
) -> list[dict[str, Any]]:
    tid = str(thread_id or "").strip()
    if not tid:
        return []
    return _archive_from_app_transcript(tid, limit=limit)
