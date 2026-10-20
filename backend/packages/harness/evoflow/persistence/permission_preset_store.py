"""Persist runtime permission preset on chat sessions."""

from __future__ import annotations

import logging

from evoflow.execution_security.permission_preset import (
    PRESET_SPECS,
    normalize_preset_id,
    preset_from_legacy_tool_policy,
    preset_spec,
)
from evoflow.persistence.db import get_db, run_db_transaction
from evoflow.persistence.tool_approval_policy import (
    get_global_default_policy,
    get_session_policy_raw,
)

logger = logging.getLogger(__name__)


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
    """Persist ``permission_preset`` and the matching legacy ``tool_approval_policy`` atomically.

    Both columns must move together so a refresh between two non-atomic writes
    cannot leave the session with a stale preset (e.g. user picks Full Access,
    UI shows Default because the second UPDATE was lost on commit). Also keeps
    ``permission_preset`` and ``tool_approval_policy`` consistent with the same
    PRESET_SPECS mapping.
    """
    sk = str(session_key or "").strip()
    if not sk:
        return None

    if preset_id is None or not str(preset_id).strip():
        target_pid: str | None = None
        target_policy: str | None = None
    else:
        target_pid = normalize_preset_id(preset_id)
        target_policy = PRESET_SPECS[target_pid].tool_approval_policy

    def _do(db) -> int:
        # Single atomic UPDATE: clears or sets both columns together. This
        # protects against the previous two-step upsert+UPDATE path which
        # left the row visible mid-write with mismatched preset/policy
        # values and could lose the permission_preset on commit failure
        # between the two statements.
        cur = db.execute(
            """
            UPDATE evoflow_chat_sessions
            SET permission_preset = ?,
                tool_approval_policy = ?
            WHERE session_key = ? AND is_deleted = 0
            """,
            (target_pid, target_policy, sk),
        )
        return cur.rowcount or 0

    try:
        updated = run_db_transaction(_do)
    except Exception:
        logger.exception("set_session_preset failed session_key=%s", sk)
        raise

    if updated == 0:
        # Session row doesn't exist yet. Seed it via the canonical upsert path
        # so the row is created with the right preset + policy in one shot, then
        # double-check the columns stuck.
        from evoflow.persistence.session_repositories import upsert_session_row

        upsert_session_row(
            sk,
            tool_approval_policy=target_policy,
        )
        def _seed(db) -> int:
            cur = db.execute(
                """
                UPDATE evoflow_chat_sessions
                SET permission_preset = ?
                WHERE session_key = ? AND is_deleted = 0
                """,
                (target_pid, sk),
            )
            return cur.rowcount or 0
        run_db_transaction(_seed)

    return target_pid


def effective_preset(session_key: str) -> str:
    """Resolve runtime preset for UI + gates.

    Prefer an explicit ``permission_preset``. If the legacy ``tool_approval_policy``
    column is ``grant_all`` while the preset column still says ``default`` (half
    applied by older writers), treat the session as full-access so approval
    「全部授权」and settings stay consistent.
    """
    from evoflow.persistence.tool_approval_policy import POLICY_GRANT_ALL

    raw = get_session_preset_raw(session_key)
    session_policy = get_session_policy_raw(session_key)
    if session_policy == POLICY_GRANT_ALL:
        return normalize_preset_id("full-access")
    if raw:
        return normalize_preset_id(raw)
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
