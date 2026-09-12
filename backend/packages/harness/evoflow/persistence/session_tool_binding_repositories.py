"""SQLite persistence for the session scenario trajectory table and chat_sessions tool snapshot.

The legacy two-table design (a mode-cache snapshot table + a separate binding
events table) is replaced by a single append-only trajectory table,
``evoflow_session_scenario_trajectory``. Every state change (session init,
scenario switch, tool search load, …) appends one row carrying the eager tools,
the loaded deferred tools, and a free-form detail blob. Reads that previously
queried the latest snapshot now read the most recent trajectory row for a
session+scenario pair (``ORDER BY id DESC LIMIT 1``).
"""

from __future__ import annotations

import json
from typing import Any

from evoflow.persistence.db import get_db
from evoflow.timeutil import beijing_now_iso

_TRAJECTORY_TABLE = "evoflow_session_scenario_trajectory"


def _ensure_binding_schema() -> None:
    """Ensure the trajectory table and chat_sessions tool columns exist.

    Delegates to :func:`ensure_app_schema`, which creates the v74 trajectory
    table (and drops the two legacy tables) when the schema is below v74. The
    chat_sessions ``active_tools_json`` / ``pending_tools_json`` columns come
    from earlier schema versions.
    """
    from evoflow.persistence.db import _raw_connection
    from evoflow.persistence.schema import ensure_app_schema

    conn = _raw_connection()
    if conn is None:
        get_db()
        conn = _raw_connection()
    if conn is None:
        return
    has_table = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        (_TRAJECTORY_TABLE,),
    ).fetchone()
    has_cols = conn.execute(
        "SELECT 1 FROM pragma_table_info('evoflow_chat_sessions') WHERE name='active_tools_json'"
    ).fetchone()
    if has_table and has_cols:
        return
    ensure_app_schema(conn)


def _normalize_tool_names(names: list[str] | None) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for raw in names or []:
        n = str(raw or "").strip().lower()
        if not n or n in seen:
            continue
        seen.add(n)
        out.append(n)
    return out


def _dump_names(names: list[str] | None) -> str:
    return json.dumps(_normalize_tool_names(names), ensure_ascii=False)


def _parse_names(raw: Any) -> list[str]:
    if raw is None:
        return []
    if isinstance(raw, list):
        return _normalize_tool_names([str(x) for x in raw])
    text = str(raw or "").strip()
    if not text:
        return []
    try:
        data = json.loads(text)
    except Exception:
        return []
    if isinstance(data, list):
        return _normalize_tool_names([str(x) for x in data])
    return []


def _row_to_binding(row: Any, fallback_scenario: str = "") -> dict[str, Any]:
    """Map a trajectory row to the legacy binding snapshot dict shape.

    Trajectory columns: id, session_key, thread_id, scenario_key, event_type,
    eager_tools_json, loaded_deferred_json, detail_json, created_at, updated_at.
    """
    return {
        "scenario_key": str(row[3] or fallback_scenario),
        "eager_tools": _parse_names(row[5]),
        "loaded_deferred": _parse_names(row[6]),
        "updated_at": str(row[9] if len(row) > 9 else row[8] or ""),
    }


def get_scenario_binding(session_key: str, scenario_key: str) -> dict[str, Any] | None:
    """Latest trajectory row for ``session_key`` + ``scenario_key`` (append-only read)."""
    _ensure_binding_schema()
    sk = str(session_key or "").strip()
    sc = str(scenario_key or "").strip().lower()
    if not sk or not sc:
        return None
    row = get_db().execute(
        f"""
        SELECT * FROM {_TRAJECTORY_TABLE}
        WHERE session_key = ? AND scenario_key = ?
        ORDER BY id DESC
        LIMIT 1
        """,
        (sk, sc),
    ).fetchone()
    if not row:
        return None
    return _row_to_binding(row, fallback_scenario=sc)


def get_loaded_deferred_for_scenario(session_key: str, scenario_key: str) -> list[str]:
    row = get_scenario_binding(session_key, scenario_key)
    if not row:
        return []
    return list(row.get("loaded_deferred") or [])


def list_scenario_bindings_for_session(session_key: str) -> dict[str, list[str]]:
    """Deferred-only map (backward compatible)."""
    full = list_full_scenario_bindings_for_session(session_key)
    return {k: list(v.get("loaded_deferred") or []) for k, v in full.items()}


def list_full_scenario_bindings_for_session(session_key: str) -> dict[str, dict[str, Any]]:
    """Per-scenario latest trajectory row for a session.

    Returns ``{mode: {eager_tools, loaded_deferred, updated_at}}`` for every
    scenario that has at least one trajectory row, using the most recent row
    per scenario. The dict structure is preserved for view / catalog callers.
    """
    _ensure_binding_schema()
    sk = str(session_key or "").strip()
    if not sk:
        return {}
    rows = get_db().execute(
        f"""
        SELECT t.*
        FROM {_TRAJECTORY_TABLE} t
        JOIN (
            SELECT scenario_key, MAX(id) AS max_id
            FROM {_TRAJECTORY_TABLE}
            WHERE session_key = ?
            GROUP BY scenario_key
        ) latest
          ON latest.scenario_key = t.scenario_key
         AND latest.max_id = t.id
        WHERE t.session_key = ?
        ORDER BY t.scenario_key ASC
        """,
        (sk, sk),
    ).fetchall()
    out: dict[str, dict[str, Any]] = {}
    for row in rows:
        key = str(row[3] or "").strip().lower()
        if not key:
            continue
        out[key] = _row_to_binding(row, fallback_scenario=key)
    return out


def upsert_scenario_binding(
    session_key: str,
    scenario_key: str,
    *,
    eager_tools: list[str] | None = None,
    loaded_deferred: list[str] | None = None,
    thread_id: str | None = None,
    event_type: str = "binding_snapshot",
    detail: dict[str, Any] | None = None,
) -> dict[str, list[str]]:
    """Append a single trajectory row (the merged snapshot + event write).

    Replaces the legacy two-step flow (snapshot upsert into the cache table
    followed by a separate ``append_binding_event`` insert). One INSERT writes
    session_key / scenario_key / event_type / eager_tools_json /
    loaded_deferred_json / detail_json / created_at / updated_at / thread_id.
    """
    _ensure_binding_schema()
    sk = str(session_key or "").strip()
    sc = str(scenario_key or "").strip().lower()
    if not sk or not sc:
        return {"eager_tools": [], "loaded_deferred": []}
    eager = _normalize_tool_names(eager_tools)
    deferred = _normalize_tool_names(loaded_deferred)
    now = beijing_now_iso()
    tid = str(thread_id or "").strip()
    etype = str(event_type or "binding_snapshot").strip() or "binding_snapshot"
    detail_payload = dict(detail or {})
    get_db().execute(
        f"""
        INSERT INTO {_TRAJECTORY_TABLE} (
            session_key, thread_id, scenario_key, event_type,
            eager_tools_json, loaded_deferred_json, detail_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            sk,
            tid,
            sc,
            etype,
            _dump_names(eager),
            _dump_names(deferred),
            json.dumps(detail_payload, ensure_ascii=False),
            now,
            now,
        ),
    )
    get_db().commit()
    return {"eager_tools": eager, "loaded_deferred": deferred}


def set_loaded_deferred_for_scenario(
    session_key: str,
    scenario_key: str,
    names: list[str] | None,
    *,
    thread_id: str | None = None,
) -> list[str]:
    existing = get_scenario_binding(session_key, scenario_key)
    eager = list(existing.get("eager_tools") or []) if existing else []
    result = upsert_scenario_binding(
        session_key,
        scenario_key,
        eager_tools=eager,
        loaded_deferred=names,
        thread_id=thread_id,
        event_type="set_loaded_deferred",
    )
    return result["loaded_deferred"]


def delete_bindings_for_session(session_key: str) -> None:
    """Delete all trajectory rows for a session and reset chat_sessions tool columns."""
    _ensure_binding_schema()
    sk = str(session_key or "").strip()
    if not sk:
        return
    conn = get_db()
    conn.execute(f"DELETE FROM {_TRAJECTORY_TABLE} WHERE session_key = ?", (sk,))
    conn.execute(
        """
        UPDATE evoflow_chat_sessions
        SET active_tools_json = '[]', pending_tools_json = '[]'
        WHERE session_key = ? AND is_deleted = 0
        """,
        (sk,),
    )
    conn.commit()


def _derive_tool_fields_for_mode(session_key: str, mode: str) -> dict[str, list[str]]:
    from evoflow.agents.lead_agent.intent_tool_profile import normalize_session_mode
    from evoflow.session_tool_binding.agent_tools import (
        bound_tools_for_session_agent,
        effective_bound_tools_for_session_agent,
        filter_loaded_for_agent_mode,
        pending_activation_for_session_agent,
    )

    sk = str(session_key or "").strip()
    m = normalize_session_mode(mode)
    row = get_scenario_binding(sk, m) or {} if sk else {}
    bound = bound_tools_for_session_agent(sk, m) if sk else list(row.get("eager_tools") or [])
    loaded = filter_loaded_for_agent_mode(sk, m, list(row.get("loaded_deferred") or [])) if sk else list(
        row.get("loaded_deferred") or []
    )
    pending = pending_activation_for_session_agent(sk, m, loaded_deferred=loaded) if sk else []
    effective = (
        effective_bound_tools_for_session_agent(sk, m, loaded_deferred=loaded) if sk else sorted({*bound, *loaded})
    )
    return {
        "bound_tools": bound,
        "loaded_deferred": loaded,
        "pending_activation": pending,
        "effective_tools": effective,
        "active_tools": effective,
        "pending_tools": pending,
    }


def sync_chat_session_tool_snapshot(
    session_key: str,
    *,
    current_mode: str,
    active_tools: list[str] | None = None,
    pending_tools: list[str] | None = None,
) -> dict[str, Any]:
    """Write current-mode active / pending tools onto ``evoflow_chat_sessions``."""
    _ensure_binding_schema()
    sk = str(session_key or "").strip()
    mode = str(current_mode or "ask").strip().lower()
    if not sk:
        return {}
    derived = _derive_tool_fields_for_mode(sk, mode)
    active = _normalize_tool_names(active_tools if active_tools is not None else derived["active_tools"])
    pending = _normalize_tool_names(pending_tools if pending_tools is not None else derived["pending_tools"])
    get_db().execute(
        """
        UPDATE evoflow_chat_sessions
        SET active_tools_json = ?, pending_tools_json = ?, session_mode = ?
        WHERE session_key = ? AND is_deleted = 0
        """,
        (_dump_names(active), _dump_names(pending), mode, sk),
    )
    get_db().commit()
    return {
        "session_key": sk,
        "current_mode": mode,
        "session_mode": mode,
        "active_tools": active,
        "pending_tools": pending,
        "bound_tools": derived["bound_tools"],
        "loaded_deferred": derived["loaded_deferred"],
        "pending_activation": pending,
        "effective_tools": active,
    }


def get_chat_session_tool_snapshot(session_key: str) -> dict[str, Any] | None:
    _ensure_binding_schema()
    sk = str(session_key or "").strip()
    if not sk:
        return None
    row = get_db().execute(
        """
        SELECT session_mode, active_tools_json, pending_tools_json, updated_at
        FROM evoflow_chat_sessions
        WHERE session_key = ? AND is_deleted = 0
        """,
        (sk,),
    ).fetchone()
    if not row:
        return None
    mode = str(row[0] or "ask").strip().lower() or "ask"
    # Columns are a write-through cache; always re-derive so a stale main-mode
    # snapshot cannot outrank the session's current agent allowlist.
    derived = _derive_tool_fields_for_mode(sk, mode)
    return {
        "session_key": sk,
        "current_mode": mode,
        "session_mode": mode,
        "active_tools": derived["active_tools"],
        "pending_tools": derived["pending_tools"],
        "bound_tools": derived["bound_tools"],
        "loaded_deferred": derived["loaded_deferred"],
        "pending_activation": derived["pending_activation"],
        "effective_tools": derived["effective_tools"],
        "updated_at": str(row[3] or ""),
    }


def append_binding_event(
    *,
    session_key: str,
    scenario_key: str,
    event_type: str,
    tool_names: list[str] | None = None,
    thread_id: str | None = None,
    detail: dict[str, Any] | None = None,
) -> None:
    """Append a binding event as a trajectory row.

    Kept for backward compatibility with callers that record an event without a
    full snapshot. Internally delegates to :func:`upsert_scenario_binding`,
    carrying ``tool_names`` through ``detail`` so the single INSERT still writes
    one trajectory row. Service code should prefer calling
    ``upsert_scenario_binding`` directly with the snapshot fields.
    """
    existing = get_scenario_binding(session_key, scenario_key)
    eager = list(existing.get("eager_tools") or []) if existing else []
    payload = dict(detail or {})
    if tool_names:
        payload["event_tool_names"] = _normalize_tool_names(tool_names)
    upsert_scenario_binding(
        session_key,
        scenario_key,
        eager_tools=eager,
        loaded_deferred=tool_names,
        thread_id=thread_id,
        event_type=event_type,
        detail=payload,
    )
