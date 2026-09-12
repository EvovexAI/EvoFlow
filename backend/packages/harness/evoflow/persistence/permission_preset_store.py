"""Persist runtime permission preset on chat sessions."""

from __future__ import annotations

from evoflow.execution_security.permission_preset import (
    PRESET_SPECS,
    normalize_preset_id,
    preset_from_legacy_tool_policy,
    preset_spec,
)
from evoflow.persistence.db import get_db
from evoflow.persistence.tool_approval_policy import (
    get_global_default_policy,
    get_session_policy_raw,
    normalize_policy,
)


def get_session_preset_raw(session_key: str) -> str | None:
    sk = str(session_key or "").strip()
    if not sk:
        return None
    row = (
        get_db()
        .execute(
            "SELECT permission_preset FROM evoflow_chat_sessions WHERE session_key = ? AND is_deleted = 0",
            (sk,),
        )
        .fetchone()
    )
    if not row:
        return None
    raw = row[0]
    if raw is None or not str(raw).strip():
        return None
    return normalize_preset_id(str(raw))


def set_session_preset(session_key: str, preset_id: str | None) -> str | None:
    """Persist preset and sync legacy ``tool_approval_policy`` column."""
    sk = str(session_key or "").strip()
    if not sk:
        return None
    from evoflow.persistence.session_repositories import upsert_session_row

    if preset_id is None or not str(preset_id).strip():
        conn = get_db()
        conn.execute(
            """
            UPDATE evoflow_chat_sessions
            SET permission_preset = NULL
            WHERE session_key = ? AND is_deleted = 0
            """,
            (sk,),
        )
        conn.commit()
        return None

    pid = normalize_preset_id(preset_id)
    spec = PRESET_SPECS[pid]
    upsert_session_row(
        sk,
        tool_approval_policy=spec.tool_approval_policy,
    )
    conn = get_db()
    conn.execute(
        """
        UPDATE evoflow_chat_sessions
        SET permission_preset = ?
        WHERE session_key = ? AND is_deleted = 0
        """,
        (pid, sk),
    )
    conn.commit()
    return pid


def effective_preset(session_key: str) -> str:
    raw = get_session_preset_raw(session_key)
    if raw:
        return normalize_preset_id(raw)
    session_policy = get_session_policy_raw(session_key)
    if session_policy:
        return preset_from_legacy_tool_policy(session_policy)
    return preset_from_legacy_tool_policy(get_global_default_policy())


def effective_preset_for_thread(thread_id: str) -> str:
    from evoflow.persistence.session_repositories import find_session_key_by_thread_id

    tid = str(thread_id or "").strip()
    if not tid:
        return preset_from_legacy_tool_policy(get_global_default_policy())
    sk = find_session_key_by_thread_id(tid)
    if not sk:
        return preset_from_legacy_tool_policy(get_global_default_policy())
    return effective_preset(sk)


def effective_preset_spec(session_key: str):
    return preset_spec(effective_preset(session_key))


def effective_preset_spec_for_thread(thread_id: str):
    return preset_spec(effective_preset_for_thread(thread_id))
