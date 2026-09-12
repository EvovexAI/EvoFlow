"""Tool approval policy: global default (app_settings) + per-session override (chat_sessions)."""

from __future__ import annotations

from typing import Any

from evoflow.persistence import config_repositories as cfg_repo
from evoflow.persistence.db import get_db

POLICY_PROMPT = "prompt"        # every sensitive tool call asks for confirmation
POLICY_SESSION = "session"      # approve once per tool name, auto-run until session ends
POLICY_GRANT_ALL = "grant_all"  # all tools auto-run, never ask
VALID_POLICIES = frozenset({POLICY_PROMPT, POLICY_SESSION, POLICY_GRANT_ALL})

APP_SETTING_KEY = "tool_approval.default_policy"
DEFAULT_POLICY_DOC: dict[str, Any] = {"mode": POLICY_SESSION}


def normalize_policy(mode: str | None) -> str:
    m = str(mode or "").strip().lower()
    if m in VALID_POLICIES:
        return m
    return POLICY_SESSION


def get_global_default_policy() -> str:
    raw = cfg_repo.get_app_setting(APP_SETTING_KEY)
    if isinstance(raw, dict):
        return normalize_policy(raw.get("mode"))
    if isinstance(raw, str) and raw.strip():
        return normalize_policy(raw)
    return POLICY_SESSION


def reconcile_prompt_snapshots_with_global(global_policy: str | None = None) -> int:
    """When global is grant_all, drop legacy ``prompt`` snapshots so sessions inherit global."""
    policy = normalize_policy(global_policy) if global_policy is not None else get_global_default_policy()
    if policy != POLICY_GRANT_ALL:
        return 0
    conn = get_db()
    cur = conn.execute(
        """
        UPDATE evoflow_chat_sessions
        SET tool_approval_policy = NULL
        WHERE is_deleted = 0 AND tool_approval_policy = ?
        """,
        (POLICY_PROMPT,),
    )
    conn.commit()
    return int(cur.rowcount or 0)


def set_global_default_policy(mode: str) -> str:
    policy = normalize_policy(mode)
    cfg_repo.set_app_setting(APP_SETTING_KEY, {"mode": policy})
    reconcile_prompt_snapshots_with_global(policy)
    return policy


def get_session_policy_raw(session_key: str) -> str | None:
    sk = str(session_key or "").strip()
    if not sk:
        return None
    row = (
        get_db()
        .execute(
            "SELECT tool_approval_policy FROM evoflow_chat_sessions WHERE session_key = ? AND is_deleted = 0",
            (sk,),
        )
        .fetchone()
    )
    if not row:
        return None
    raw = row[0]
    if raw is None or not str(raw).strip():
        return None
    return normalize_policy(str(raw))


def set_session_policy(session_key: str, mode: str | None) -> str | None:
    """Persist session-level policy (``None`` clears override → inherit global at read time)."""
    sk = str(session_key or "").strip()
    if not sk:
        return None
    from evoflow.persistence.session_repositories import upsert_session_row

    if mode is None or not str(mode).strip():
        conn = get_db()
        conn.execute(
            """
            UPDATE evoflow_chat_sessions
            SET tool_approval_policy = NULL
            WHERE session_key = ? AND is_deleted = 0
            """,
            (sk,),
        )
        conn.commit()
        return None

    policy = normalize_policy(mode)
    # Upsert so policy persists even when the session row was not created yet (e.g. UI set before first send).
    upsert_session_row(sk, tool_approval_policy=policy)
    return policy


def effective_policy(session_key: str) -> str:
    """Resolved policy: runtime preset (if set) or session column or global default."""
    try:
        from evoflow.persistence.permission_preset_store import effective_preset_spec

        return effective_preset_spec(session_key).tool_approval_policy
    except Exception:
        raw = get_session_policy_raw(session_key)
        if raw:
            return raw
        return get_global_default_policy()


def effective_policy_for_thread(thread_id: str) -> str:
    from evoflow.persistence.session_repositories import find_session_key_by_thread_id

    tid = str(thread_id or "").strip()
    if not tid:
        return get_global_default_policy()
    sk = find_session_key_by_thread_id(tid)
    if not sk:
        return get_global_default_policy()
    return effective_policy(sk)


def policy_for_new_session(explicit: str | None = None) -> str | None:
    """Persist only an explicit per-session override; ``None`` inherits global at read time."""
    if explicit is not None and str(explicit).strip():
        return normalize_policy(explicit)
    return None


def is_grant_all_policy(policy: str) -> bool:
    return normalize_policy(policy) == POLICY_GRANT_ALL


def is_session_policy(policy: str) -> bool:
    return normalize_policy(policy) == POLICY_SESSION


def is_prompt_policy(policy: str) -> bool:
    return normalize_policy(policy) == POLICY_PROMPT
