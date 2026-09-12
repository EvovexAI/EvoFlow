"""Create tables and insert rows for ``evoflow_obs_*`` SQLite observability."""

from __future__ import annotations

import json
import logging
import sqlite3
import threading
import uuid
from pathlib import Path
from typing import Any

from evoflow.observability.tables import ObservabilityTable

logger = logging.getLogger(__name__)

# Single migration script — bump ``PRAGMA user_version`` when changing schema.
_SCHEMA_VERSION = 9
_STORED_MODEL_JSON_LIMIT = 512 * 1024


def _is_system_role_message(msg: Any) -> bool:
    if not isinstance(msg, dict):
        return False
    role = str(msg.get("role") or "").strip().lower()
    if role in {"system", "developer"}:
        return True
    typ = str(msg.get("type") or "").strip().lower()
    return typ in {"system", "systemmessage"}


def _tail_messages_preserve_system(messages: list[Any], keep: int) -> list[Any]:
    """Keep all system/developer messages plus the tail of the rest.

    The vendor payload usually puts the system prompt in the first message(s);
    tail-only shrinking would drop it and make the「系统提示词」tab lose content.
    """
    if not messages:
        return []
    system_msgs = [m for m in messages if _is_system_role_message(m)]
    other_msgs = [m for m in messages if not _is_system_role_message(m)]
    if keep <= 0:
        # System prompt must never be dropped just because the tail budget hit 0.
        return system_msgs
    if keep >= len(other_msgs):
        return system_msgs + other_msgs
    return system_msgs + other_msgs[-keep:]


def _truncate_stored_json(value: str | None, *, limit: int = _STORED_MODEL_JSON_LIMIT) -> str | None:
    """Cap stored JSON size without breaking JSON when possible.

    Prefer returning a valid JSON object that still exposes ``message_count`` /
    ``messages_truncated``. Blind mid-string cuts make list parsers fail and the
    Ops UI shows 「—」 for message count. Shrunk ``messages`` always keep
    system/developer messages (system prompt tab depends on them).
    """
    if value is None:
        return None
    cap = max(1024, int(limit))
    text = str(value)
    if len(text) <= cap:
        return text
    try:
        obj = json.loads(text)
    except Exception:
        obj = None
    if isinstance(obj, dict):
        msgs = obj.get("messages")
        full_n = obj.get("message_count")
        if full_n is None and isinstance(msgs, list):
            full_n = len(msgs)
        try:
            full_n_i = int(full_n) if full_n is not None else 0
        except (TypeError, ValueError):
            full_n_i = len(msgs) if isinstance(msgs, list) else 0
        if isinstance(msgs, list):
            for keep in (20, 10, 5, 2, 0):
                slim = dict(obj)
                slim["message_count"] = full_n_i
                slim["messages"] = _tail_messages_preserve_system(msgs, keep)
                slim["messages_truncated"] = f"stored_tail_{keep}_of_{full_n_i}"
                out = json.dumps(slim, ensure_ascii=False, default=str)
                if len(out) <= cap:
                    return out
        meta = {k: v for k, v in obj.items() if k != "messages"}
        meta["message_count"] = full_n_i
        meta["messages"] = []
        meta["messages_truncated"] = f"omitted_all_of_{full_n_i}"
        out = json.dumps(meta, ensure_ascii=False, default=str)
        if len(out) <= cap:
            return out
        # Extreme: count-only stub
        stub = {
            "message_count": full_n_i,
            "messages": [],
            "messages_truncated": f"omitted_all_of_{full_n_i}",
            "model": obj.get("model"),
        }
        out = json.dumps(stub, ensure_ascii=False, default=str)
        if len(out) <= cap:
            return out
    # Absolute last resort (invalid JSON marker) — list parser has regex fallback.
    return text[:cap] + "\n… [truncated]"

_GATEWAY_REQUESTS_SCHEMA = f"""
CREATE TABLE IF NOT EXISTS {ObservabilityTable.GATEWAY_REQUESTS} (
    id TEXT PRIMARY KEY,
    occurred_at TEXT NOT NULL,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    query_string TEXT,
    client_ip TEXT,
    user_agent TEXT,
    request_content_type TEXT,
    response_content_type TEXT,
    status_code INTEGER,
    duration_ms REAL NOT NULL,
    request_headers_json TEXT,
    response_headers_json TEXT,
    request_body_sample TEXT,
    response_body_sample TEXT,
    request_body_truncated INTEGER NOT NULL DEFAULT 0,
    response_body_truncated INTEGER NOT NULL DEFAULT 0,
    error_type TEXT,
    metadata_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_evo_obs_gateway_occurred
    ON {ObservabilityTable.GATEWAY_REQUESTS}(occurred_at);
CREATE INDEX IF NOT EXISTS idx_evo_obs_gateway_path_time
    ON {ObservabilityTable.GATEWAY_REQUESTS}(path, occurred_at);
CREATE INDEX IF NOT EXISTS idx_evo_obs_gateway_status_time
    ON {ObservabilityTable.GATEWAY_REQUESTS}(status_code, occurred_at);
CREATE INDEX IF NOT EXISTS idx_evo_obs_gateway_duration
    ON {ObservabilityTable.GATEWAY_REQUESTS}(duration_ms);
"""

_SCHEMA = f"""
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS {ObservabilityTable.THREADS} (
    thread_id TEXT PRIMARY KEY,
    assistant_id TEXT,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS {ObservabilityTable.RUNS} (
    run_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    graph_id TEXT,
    status TEXT,
    started_at TEXT,
    ended_at TEXT,
    duration_ms REAL,
    error_type TEXT,
    error_message TEXT,
    metadata_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_evo_obs_runs_thread_started
    ON {ObservabilityTable.RUNS}(thread_id, started_at);

CREATE TABLE IF NOT EXISTS {ObservabilityTable.MODEL_INVOCATIONS} (
    id TEXT PRIMARY KEY,
    thread_id TEXT,
    run_id TEXT,
    model_call_seq INTEGER,
    provider TEXT,
    model TEXT,
    stage TEXT,
    trace_id TEXT,
    requested_at TEXT NOT NULL,
    latency_ms REAL,
    first_token_latency_ms REAL,
    request_json TEXT,
    response_json TEXT,
    usage_json TEXT,
    cache_read_tokens INTEGER,
    cache_creation_tokens INTEGER,
    cache_miss_tokens INTEGER,
    collab_phase TEXT,
    checkpoint_id TEXT,
    invocation_kind TEXT,
    started_at TEXT,
    status TEXT NOT NULL DEFAULT 'completed',
    thinking_enabled INTEGER,
    reasoning_effort TEXT,
    thinking_type TEXT,
    thinking_budget_tokens INTEGER,
    session_mode TEXT,
    agent_code TEXT,
    position_code TEXT
);
CREATE INDEX IF NOT EXISTS idx_evo_obs_model_thread_time
    ON {ObservabilityTable.MODEL_INVOCATIONS}(thread_id, requested_at);
CREATE INDEX IF NOT EXISTS idx_evo_obs_model_requested_at
    ON {ObservabilityTable.MODEL_INVOCATIONS}(requested_at);
CREATE INDEX IF NOT EXISTS idx_evo_obs_model_latency
    ON {ObservabilityTable.MODEL_INVOCATIONS}(latency_ms);
CREATE INDEX IF NOT EXISTS idx_evo_obs_model_kind_time
    ON {ObservabilityTable.MODEL_INVOCATIONS}(invocation_kind, requested_at);

CREATE TABLE IF NOT EXISTS {ObservabilityTable.TOOL_INVOCATIONS} (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    run_id TEXT,
    tool_call_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT NOT NULL,
    duration_ms REAL NOT NULL,
    status TEXT NOT NULL,
    input_json TEXT,
    output_text TEXT,
    collab_phase TEXT,
    invocation_source TEXT NOT NULL DEFAULT 'tool_middleware',
    error_type TEXT,
    error_message TEXT,
    error_detail_json TEXT,
    agent_code TEXT,
    position_code TEXT
);
CREATE INDEX IF NOT EXISTS idx_evo_obs_tool_thread_time
    ON {ObservabilityTable.TOOL_INVOCATIONS}(thread_id, ended_at);
CREATE INDEX IF NOT EXISTS idx_evo_obs_tool_name
    ON {ObservabilityTable.TOOL_INVOCATIONS}(tool_name);

CREATE TABLE IF NOT EXISTS {ObservabilityTable.TRACE_EVENTS} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT,
    run_id TEXT,
    lane TEXT NOT NULL DEFAULT 'collab_cycle',
    occurred_at TEXT NOT NULL,
    event TEXT NOT NULL,
    payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evo_obs_trace_thread_time
    ON {ObservabilityTable.TRACE_EVENTS}(thread_id, occurred_at);

CREATE TABLE IF NOT EXISTS {ObservabilityTable.TASK_LIFECYCLE_EVENTS} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT,
    occurred_at TEXT NOT NULL,
    schema_version TEXT,
    event TEXT NOT NULL,
    main_task_id TEXT,
    subtask_id TEXT,
    status TEXT,
    detail_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_evo_obs_tl_thread_time
    ON {ObservabilityTable.TASK_LIFECYCLE_EVENTS}(thread_id, occurred_at);

CREATE TABLE IF NOT EXISTS {ObservabilityTable.IM_CHANNEL_ERRORS} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT,
    occurred_at TEXT NOT NULL,
    payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evo_obs_im_thread_time
    ON {ObservabilityTable.IM_CHANNEL_ERRORS}(thread_id, occurred_at);

{_GATEWAY_REQUESTS_SCHEMA}
"""


def _upgrade_obs_schema(conn: sqlite3.Connection) -> None:
    """Apply additive SQLite migrations (existing DBs keep data)."""
    cur = conn.execute("PRAGMA user_version")
    ver = int(cur.fetchone()[0] or 0)
    if ver >= _SCHEMA_VERSION:
        return
    if ver < 2:
        cols = {str(r[1]) for r in conn.execute(f"PRAGMA table_info({ObservabilityTable.MODEL_INVOCATIONS})")}
        if "invocation_kind" not in cols:
            conn.execute(f"ALTER TABLE {ObservabilityTable.MODEL_INVOCATIONS} ADD COLUMN invocation_kind TEXT")
    if ver < 3:
        cols = {str(r[1]) for r in conn.execute(f"PRAGMA table_info({ObservabilityTable.MODEL_INVOCATIONS})")}
        if "first_token_latency_ms" not in cols:
            conn.execute(
                f"ALTER TABLE {ObservabilityTable.MODEL_INVOCATIONS} ADD COLUMN first_token_latency_ms REAL"
            )
    if ver < 4:
        conn.executescript(_GATEWAY_REQUESTS_SCHEMA)
    if ver < 5:
        conn.execute(
            f"CREATE INDEX IF NOT EXISTS idx_evo_obs_model_requested_at "
            f"ON {ObservabilityTable.MODEL_INVOCATIONS}(requested_at)"
        )
        conn.execute(
            f"CREATE INDEX IF NOT EXISTS idx_evo_obs_model_latency "
            f"ON {ObservabilityTable.MODEL_INVOCATIONS}(latency_ms)"
        )
        conn.execute(
            f"CREATE INDEX IF NOT EXISTS idx_evo_obs_model_kind_time "
            f"ON {ObservabilityTable.MODEL_INVOCATIONS}(invocation_kind, requested_at)"
        )
    if ver < 6:
        cols = {str(r[1]) for r in conn.execute(f"PRAGMA table_info({ObservabilityTable.MODEL_INVOCATIONS})")}
        for col in ("cache_read_tokens", "cache_creation_tokens", "cache_miss_tokens"):
            if col not in cols:
                conn.execute(f"ALTER TABLE {ObservabilityTable.MODEL_INVOCATIONS} ADD COLUMN {col} INTEGER")
    if ver < 7:
        cols = {str(r[1]) for r in conn.execute(f"PRAGMA table_info({ObservabilityTable.MODEL_INVOCATIONS})")}
        if "started_at" not in cols:
            conn.execute(f"ALTER TABLE {ObservabilityTable.MODEL_INVOCATIONS} ADD COLUMN started_at TEXT")
        if "status" not in cols:
            conn.execute(f"ALTER TABLE {ObservabilityTable.MODEL_INVOCATIONS} ADD COLUMN status TEXT NOT NULL DEFAULT 'completed'")
        conn.execute(
            f"CREATE INDEX IF NOT EXISTS idx_evo_obs_model_thread_status "
            f"ON {ObservabilityTable.MODEL_INVOCATIONS}(thread_id, status)"
        )
    if ver < 8:
        cols = {str(r[1]) for r in conn.execute(f"PRAGMA table_info({ObservabilityTable.MODEL_INVOCATIONS})")}
        for col, ddl in (
            ("thinking_enabled", "INTEGER"),
            ("reasoning_effort", "TEXT"),
            ("thinking_type", "TEXT"),
            ("thinking_budget_tokens", "INTEGER"),
            ("session_mode", "TEXT"),
        ):
            if col not in cols:
                conn.execute(f"ALTER TABLE {ObservabilityTable.MODEL_INVOCATIONS} ADD COLUMN {col} {ddl}")
        conn.execute(
            f"CREATE INDEX IF NOT EXISTS idx_evo_obs_model_reasoning_effort "
            f"ON {ObservabilityTable.MODEL_INVOCATIONS}(reasoning_effort, requested_at)"
        )
    if ver < 9:
        for tbl, cols in (
            (ObservabilityTable.MODEL_INVOCATIONS, ("agent_code", "position_code")),
            (ObservabilityTable.TOOL_INVOCATIONS, ("agent_code", "position_code")),
        ):
            existing = {str(r[1]) for r in conn.execute(f"PRAGMA table_info({tbl})")}
            for col in cols:
                if col not in existing:
                    conn.execute(f"ALTER TABLE {tbl} ADD COLUMN {col} TEXT")
        conn.execute(
            f"CREATE INDEX IF NOT EXISTS idx_evo_obs_model_agent_time "
            f"ON {ObservabilityTable.MODEL_INVOCATIONS}(agent_code, requested_at)"
        )
        conn.execute(
            f"CREATE INDEX IF NOT EXISTS idx_evo_obs_tool_agent_time "
            f"ON {ObservabilityTable.TOOL_INVOCATIONS}(agent_code, ended_at)"
        )
    conn.execute(f"PRAGMA user_version = {_SCHEMA_VERSION}")
    conn.commit()


def _ensure_model_thinking_indexes(conn: sqlite3.Connection) -> None:
    """Create thinking-related indexes only after columns exist (safe for old DBs)."""
    cols = {str(r[1]) for r in conn.execute(f"PRAGMA table_info({ObservabilityTable.MODEL_INVOCATIONS})")}
    if "reasoning_effort" in cols:
        conn.execute(
            f"CREATE INDEX IF NOT EXISTS idx_evo_obs_model_reasoning_effort "
            f"ON {ObservabilityTable.MODEL_INVOCATIONS}(reasoning_effort, requested_at)"
        )


def new_row_id() -> str:
    return str(uuid.uuid4())


def _thinking_insert_values(
    *,
    thinking_enabled: int | None = None,
    reasoning_effort: str | None = None,
    thinking_type: str | None = None,
    thinking_budget_tokens: int | None = None,
    session_mode: str | None = None,
) -> tuple[int | None, str | None, str | None, int | None, str | None]:
    effort = str(reasoning_effort or "").strip() or None
    ttype = str(thinking_type or "").strip().lower() or None
    smode = str(session_mode or "").strip() or None
    budget: int | None
    try:
        budget = int(thinking_budget_tokens) if thinking_budget_tokens is not None else None
    except (TypeError, ValueError):
        budget = None
    return thinking_enabled, effort, ttype, budget, smode


class ObservabilitySqliteStore:
    """Thread-safe SQLite writer for ``evoflow_obs_*`` tables."""

    def __init__(self, sqlite_path: str | Path) -> None:
        self._path = Path(sqlite_path) if isinstance(sqlite_path, Path) else Path(str(sqlite_path))
        self._lock = threading.RLock()
        self._conn: sqlite3.Connection | None = None
        self._schema_ready = False

    def resolved_path(self) -> Path:
        from evoflow.config.data_paths import resolve_data_base_dir, resolve_observability_db_config_path
        from evoflow.persistence.data_layout import ensure_data_layout

        raw = str(self._path)
        if raw == ":memory:":
            return Path(raw)
        if self._path.is_absolute():
            return self._path.resolve()
        base = resolve_data_base_dir()
        ensure_data_layout(base)
        return resolve_observability_db_config_path(raw, base_dir=base)

    def _connection(self) -> sqlite3.Connection:
        path = self.resolved_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        if self._conn is None:
            self._conn = sqlite3.connect(str(path), check_same_thread=False, timeout=60.0)
            self._conn.execute("PRAGMA journal_mode=WAL")
        if not self._schema_ready:
            self._conn.executescript(_SCHEMA)
            _upgrade_obs_schema(self._conn)
            _ensure_model_thinking_indexes(self._conn)
            self._schema_ready = True
        return self._conn

    def close(self) -> None:
        with self._lock:
            if self._conn is not None:
                try:
                    self._conn.close()
                except Exception:
                    logger.debug("ObservabilitySqliteStore.close failed", exc_info=True)
                self._conn = None
            self._schema_ready = False

    def touch_thread(self, thread_id: str, *, assistant_id: str | None = None) -> None:
        tid = (thread_id or "").strip()
        if not tid:
            return
        from evoflow.timeutil import beijing_now_iso

        now = beijing_now_iso()
        with self._lock:
            conn = self._connection()
            conn.execute(
                f"""
                INSERT INTO {ObservabilityTable.THREADS}
                    (thread_id, assistant_id, first_seen_at, last_seen_at, metadata_json)
                VALUES (?, ?, ?, ?, NULL)
                ON CONFLICT(thread_id) DO UPDATE SET
                    last_seen_at = excluded.last_seen_at,
                    assistant_id = COALESCE(excluded.assistant_id, assistant_id)
                """,
                (tid, assistant_id, now, now),
            )
            conn.commit()

    def insert_trace_event(
        self,
        *,
        thread_id: str | None,
        run_id: str | None,
        lane: str,
        occurred_at: str,
        event: str,
        payload: dict[str, Any],
    ) -> None:
        tid = (thread_id or "").strip() or None
        payload_json = json.dumps(payload, ensure_ascii=False, default=str)
        with self._lock:
            conn = self._connection()
            conn.execute(
                f"""
                INSERT INTO {ObservabilityTable.TRACE_EVENTS}
                    (thread_id, run_id, lane, occurred_at, event, payload_json)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (tid, (run_id or "").strip() or None, lane, occurred_at, event, payload_json),
            )
            conn.commit()
        if tid:
            self.touch_thread(tid)

    def insert_gateway_request(
        self,
        *,
        occurred_at: str,
        method: str,
        path: str,
        query_string: str | None,
        client_ip: str | None,
        user_agent: str | None,
        request_content_type: str | None,
        response_content_type: str | None,
        status_code: int | None,
        duration_ms: float,
        request_headers: dict[str, Any] | None = None,
        response_headers: dict[str, Any] | None = None,
        request_body_sample: str | None = None,
        response_body_sample: str | None = None,
        request_body_truncated: bool = False,
        response_body_truncated: bool = False,
        error_type: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        def _json_or_none(value: Any, *, limit: int = 512) -> str | None:
            if value is None:
                return None
            try:
                text = json.dumps(value, ensure_ascii=False, default=str)
            except (TypeError, ValueError):
                text = json.dumps({"_error": "non_serializable"}, ensure_ascii=False)
            cap = max(128, int(limit))
            if len(text) > cap:
                return text[:cap]
            return text

        row_id = new_row_id()
        with self._lock:
            conn = self._connection()
            conn.execute(
                f"""
                INSERT INTO {ObservabilityTable.GATEWAY_REQUESTS} (
                    id, occurred_at, method, path, query_string, client_ip, user_agent,
                    request_content_type, response_content_type, status_code, duration_ms,
                    request_headers_json, response_headers_json, request_body_sample,
                    response_body_sample, request_body_truncated, response_body_truncated,
                    error_type, metadata_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    row_id,
                    occurred_at,
                    method.upper(),
                    path,
                    query_string or None,
                    client_ip or None,
                    user_agent or None,
                    request_content_type or None,
                    response_content_type or None,
                    status_code,
                    float(duration_ms),
                    _json_or_none(request_headers),
                    _json_or_none(response_headers),
                    request_body_sample,
                    response_body_sample,
                    1 if request_body_truncated else 0,
                    1 if response_body_truncated else 0,
                    error_type or None,
                    _json_or_none(metadata),
                ),
            )
            conn.commit()

    def insert_tool_invocation(
        self,
        *,
        thread_id: str,
        run_id: str | None,
        tool_call_id: str,
        tool_name: str,
        started_at: str,
        ended_at: str,
        duration_ms: float,
        status: str,
        input_obj: Any,
        output_text: str | None,
        collab_phase: str | None,
        invocation_source: str,
        error_type: str | None = None,
        error_message: str | None = None,
        error_detail: dict[str, Any] | None = None,
        agent_code: str | None = None,
        position_code: str | None = None,
    ) -> None:
        tid = (thread_id or "").strip()
        if not tid:
            return
        row_id = new_row_id()
        try:
            input_json = json.dumps(input_obj, ensure_ascii=False, default=str) if input_obj is not None else None
        except (TypeError, ValueError):
            input_json = json.dumps({"_error": "non_serializable_input"}, ensure_ascii=False)
        err_json = None
        if error_detail:
            try:
                err_json = json.dumps(error_detail, ensure_ascii=False, default=str)
            except (TypeError, ValueError):
                err_json = None
        with self._lock:
            conn = self._connection()
            conn.execute(
                f"""
                INSERT INTO {ObservabilityTable.TOOL_INVOCATIONS} (
                    id, thread_id, run_id, tool_call_id, tool_name,
                    started_at, ended_at, duration_ms, status,
                    input_json, output_text, collab_phase, invocation_source,
                    error_type, error_message, error_detail_json,
                    agent_code, position_code
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    row_id,
                    tid,
                    (run_id or "").strip() or None,
                    tool_call_id,
                    tool_name,
                    started_at,
                    ended_at,
                    float(duration_ms),
                    status,
                    input_json,
                    output_text,
                    (collab_phase or "").strip() or None,
                    invocation_source,
                    error_type,
                    error_message,
                    err_json,
                    (agent_code or "").strip() or None,
                    (position_code or "").strip() or None,
                ),
            )
            conn.commit()
        self.touch_thread(tid)

    def insert_task_lifecycle(
        self,
        *,
        thread_id: str | None,
        occurred_at: str,
        schema_version: str | None,
        event: str,
        main_task_id: str | None,
        subtask_id: str | None,
        status: str | None,
        detail: dict[str, Any] | None,
    ) -> None:
        tid = (thread_id or "").strip() or None
        detail_json = json.dumps(detail, ensure_ascii=False, default=str) if detail else None
        with self._lock:
            conn = self._connection()
            conn.execute(
                f"""
                INSERT INTO {ObservabilityTable.TASK_LIFECYCLE_EVENTS}
                    (thread_id, occurred_at, schema_version, event, main_task_id, subtask_id, status, detail_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    tid,
                    occurred_at,
                    schema_version,
                    event,
                    (main_task_id or "").strip() or None,
                    (subtask_id or "").strip() or None,
                    (status or "").strip() or None,
                    detail_json,
                ),
            )
            conn.commit()
        if tid:
            self.touch_thread(tid)

    def insert_im_channel_error(self, *, thread_id: str | None, occurred_at: str, payload: dict[str, Any]) -> None:
        tid = (thread_id or "").strip() or None
        payload_json = json.dumps(payload, ensure_ascii=False, default=str)
        with self._lock:
            conn = self._connection()
            conn.execute(
                f"""
                INSERT INTO {ObservabilityTable.IM_CHANNEL_ERRORS} (thread_id, occurred_at, payload_json)
                VALUES (?, ?, ?)
                """,
                (tid, occurred_at, payload_json),
            )
            conn.commit()
        if tid:
            self.touch_thread(tid)

    def insert_model_invocation(
        self,
        *,
        thread_id: str | None,
        run_id: str | None,
        model_call_seq: int | None,
        provider: str,
        model: str | None,
        stage: str,
        trace_id: str | None,
        requested_at: str,
        latency_ms: float | None,
        first_token_latency_ms: float | None = None,
        request_json: str | None = None,
        response_json: str | None = None,
        usage_json: str | None = None,
        cache_read_tokens: int | None = None,
        cache_creation_tokens: int | None = None,
        cache_miss_tokens: int | None = None,
        collab_phase: str | None = None,
        checkpoint_id: str | None = None,
        invocation_kind: str | None = None,
        thinking_enabled: int | None = None,
        reasoning_effort: str | None = None,
        thinking_type: str | None = None,
        thinking_budget_tokens: int | None = None,
        session_mode: str | None = None,
        agent_code: str | None = None,
        position_code: str | None = None,
    ) -> None:
        tid = (thread_id or "").strip() or None
        row_id = new_row_id()
        think_vals = _thinking_insert_values(
            thinking_enabled=thinking_enabled,
            reasoning_effort=reasoning_effort,
            thinking_type=thinking_type,
            thinking_budget_tokens=thinking_budget_tokens,
            session_mode=session_mode,
        )
        with self._lock:
            conn = self._connection()
            conn.execute(
                f"""
                INSERT INTO {ObservabilityTable.MODEL_INVOCATIONS} (
                    id, thread_id, run_id, model_call_seq, provider, model, stage, trace_id,
                    requested_at, latency_ms, first_token_latency_ms, request_json, response_json,
                    usage_json, cache_read_tokens, cache_creation_tokens, cache_miss_tokens,
                    collab_phase, checkpoint_id, invocation_kind,
                    thinking_enabled, reasoning_effort, thinking_type, thinking_budget_tokens, session_mode,
                    agent_code, position_code
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    row_id,
                    tid,
                    (run_id or "").strip() or None,
                    model_call_seq,
                    provider,
                    model,
                    stage,
                    (trace_id or "").strip() or None,
                    requested_at,
                    latency_ms,
                    first_token_latency_ms,
                    _truncate_stored_json(request_json),
                    _truncate_stored_json(response_json),
                    usage_json,
                    cache_read_tokens,
                    cache_creation_tokens,
                    cache_miss_tokens,
                    (collab_phase or "").strip() or None,
                    (checkpoint_id or "").strip() or None,
                    (invocation_kind or "").strip() or None,
                    *think_vals,
                    (agent_code or "").strip() or None,
                    (position_code or "").strip() or None,
                ),
            )
            conn.commit()
        if tid:
            self.touch_thread(tid)

    # ── Two-phase model invocation persistence ──────────────────────────
    # Phase 1 (call start): insert_model_invocation_pending → status='running'
    # Phase 2 (call end):   complete_model_invocation      → UPDATE + status='completed'

    def insert_model_invocation_pending(
        self,
        *,
        thread_id: str | None,
        run_id: str | None,
        model_call_seq: int | None,
        provider: str,
        model: str | None,
        stage: str,
        trace_id: str | None,
        requested_at: str,
        request_json: str | None = None,
        collab_phase: str | None = None,
        checkpoint_id: str | None = None,
        invocation_kind: str | None = None,
        thinking_enabled: int | None = None,
        reasoning_effort: str | None = None,
        thinking_type: str | None = None,
        thinking_budget_tokens: int | None = None,
        session_mode: str | None = None,
        agent_code: str | None = None,
        position_code: str | None = None,
    ) -> str:
        """Insert a *running* model-invocation row at call start.

        Returns the generated ``row_id`` so the caller can later call
        :meth:`complete_model_invocation` to fill in latency / response / usage.
        """
        tid = (thread_id or "").strip() or None
        row_id = new_row_id()
        think_vals = _thinking_insert_values(
            thinking_enabled=thinking_enabled,
            reasoning_effort=reasoning_effort,
            thinking_type=thinking_type,
            thinking_budget_tokens=thinking_budget_tokens,
            session_mode=session_mode,
        )
        with self._lock:
            conn = self._connection()
            conn.execute(
                f"""
                INSERT INTO {ObservabilityTable.MODEL_INVOCATIONS} (
                    id, thread_id, run_id, model_call_seq, provider, model, stage, trace_id,
                    requested_at, started_at, status,
                    request_json, collab_phase, checkpoint_id, invocation_kind,
                    thinking_enabled, reasoning_effort, thinking_type, thinking_budget_tokens, session_mode,
                    agent_code, position_code
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    row_id,
                    tid,
                    (run_id or "").strip() or None,
                    model_call_seq,
                    provider,
                    model,
                    stage,
                    (trace_id or "").strip() or None,
                    requested_at,
                    requested_at,  # started_at ≈ requested_at at pending time
                    "running",
                    _truncate_stored_json(request_json),
                    (collab_phase or "").strip() or None,
                    (checkpoint_id or "").strip() or None,
                    (invocation_kind or "").strip() or None,
                    *think_vals,
                    (agent_code or "").strip() or None,
                    (position_code or "").strip() or None,
                ),
            )
            conn.commit()
        if tid:
            self.touch_thread(tid)
        return row_id

    def complete_model_invocation(
        self,
        *,
        row_id: str,
        latency_ms: float | None,
        first_token_latency_ms: float | None = None,
        response_json: str | None = None,
        usage_json: str | None = None,
        cache_read_tokens: int | None = None,
        cache_creation_tokens: int | None = None,
        cache_miss_tokens: int | None = None,
        status: str = "completed",
        request_json: str | None = None,
        thinking_enabled: int | None = None,
        reasoning_effort: str | None = None,
        thinking_type: str | None = None,
        thinking_budget_tokens: int | None = None,
        session_mode: str | None = None,
    ) -> None:
        """Update a pending model-invocation row with completion data.

        *request_json* uses ``COALESCE`` — only overwrites the existing value
        when not ``None`` (Phase 1 may already have written a preview record).

        If *row_id* is not found (e.g. pending insert was skipped or DB was
        reset between phases), the update is silently dropped with a warning.
        """
        think_vals = _thinking_insert_values(
            thinking_enabled=thinking_enabled,
            reasoning_effort=reasoning_effort,
            thinking_type=thinking_type,
            thinking_budget_tokens=thinking_budget_tokens,
            session_mode=session_mode,
        )
        with self._lock:
            conn = self._connection()
            cur = conn.execute(
                f"""
                UPDATE {ObservabilityTable.MODEL_INVOCATIONS}
                SET latency_ms = ?,
                    first_token_latency_ms = ?,
                    response_json = ?,
                    usage_json = ?,
                    cache_read_tokens = ?,
                    cache_creation_tokens = ?,
                    cache_miss_tokens = ?,
                    status = ?,
                    request_json = COALESCE(?, request_json),
                    thinking_enabled = COALESCE(?, thinking_enabled),
                    reasoning_effort = COALESCE(?, reasoning_effort),
                    thinking_type = COALESCE(?, thinking_type),
                    thinking_budget_tokens = COALESCE(?, thinking_budget_tokens),
                    session_mode = COALESCE(?, session_mode)
                WHERE id = ?
                """,
                (
                    latency_ms,
                    first_token_latency_ms,
                    _truncate_stored_json(response_json),
                    usage_json,
                    cache_read_tokens,
                    cache_creation_tokens,
                    cache_miss_tokens,
                    status,
                    _truncate_stored_json(request_json),
                    think_vals[0],
                    think_vals[1],
                    think_vals[2],
                    think_vals[3],
                    think_vals[4],
                    row_id,
                ),
            )
            if cur.rowcount == 0:
                logger.warning(
                    "complete_model_invocation: row %s not found — pending insert may have been skipped",
                    row_id,
                )
            conn.commit()
