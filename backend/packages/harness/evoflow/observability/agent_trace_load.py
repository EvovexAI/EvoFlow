"""Load per-thread agent-trace sections from ``evoflow_obs_*`` SQLite (no log files)."""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from evoflow.observability.sqlite_store import ObservabilitySqliteStore
from evoflow.observability.tables import ObservabilityTable
from evoflow.observability.tool_filters import llm_tool_visibility_sql
from evoflow.timeutil import parse_iso_to_ms


def _store() -> ObservabilitySqliteStore | None:
    try:
        from evoflow.config.app_config import get_app_config
        from evoflow.debug.trace_sink import observability_enabled

        if not observability_enabled():
            return None
        return ObservabilitySqliteStore(get_app_config().observability.sqlite_path)
    except Exception:
        return None


def _parse_payload_json(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        obj = json.loads(raw)
        return obj if isinstance(obj, dict) else {}
    except (json.JSONDecodeError, TypeError):
        return {}


def trace_events_by_lane(thread_id: str, lane: str) -> list[dict[str, Any]]:
    st = _store()
    tid = (thread_id or "").strip()
    if st is None or not tid:
        return []
    conn = st._connection()  # noqa: SLF001
    conn.row_factory = sqlite3.Row
    T = ObservabilityTable
    rows = conn.execute(
        f"""
        SELECT occurred_at, event, payload_json
        FROM {T.TRACE_EVENTS}
        WHERE thread_id = ? AND lane = ?
        ORDER BY occurred_at ASC
        """,
        (tid, lane),
    ).fetchall()
    out: list[dict[str, Any]] = []
    for r in rows:
        body = _parse_payload_json(r["payload_json"])
        if not body:
            body = {"event": r["event"], "ts": r["occurred_at"]}
        elif "ts" not in body and r["occurred_at"]:
            body.setdefault("ts", r["occurred_at"])
        if "event" not in body and r["event"]:
            body["event"] = r["event"]
        body.setdefault("thread_id", tid)
        out.append(body)
    return out


def load_collab_cycle(thread_id: str) -> list[dict[str, Any]]:
    return trace_events_by_lane(thread_id, "collab_cycle")


def load_lead_agent_round(thread_id: str) -> list[dict[str, Any]]:
    return trace_events_by_lane(thread_id, "lead_agent_round")


def load_run_latency(thread_id: str) -> list[dict[str, Any]]:
    return trace_events_by_lane(thread_id, "run_latency")


def load_tool_call_io(thread_id: str) -> list[dict[str, Any]]:
    st = _store()
    tid = (thread_id or "").strip()
    if st is None or not tid:
        return []
    conn = st._connection()  # noqa: SLF001
    conn.row_factory = sqlite3.Row
    T = ObservabilityTable
    rows = conn.execute(
        f"""
        SELECT tool_name, tool_call_id, started_at, ended_at, duration_ms, status,
               input_json, output_text, error_type, error_message
        FROM {T.TOOL_INVOCATIONS}
        WHERE thread_id = ? AND {llm_tool_visibility_sql()}
        ORDER BY ended_at ASC
        """,
        (tid,),
    ).fetchall()
    out: list[dict[str, Any]] = []
    for r in rows:
        inp: Any = {}
        if r["input_json"]:
            try:
                inp = json.loads(r["input_json"])
            except (json.JSONDecodeError, TypeError):
                inp = r["input_json"]
        row: dict[str, Any] = {
            "thread_id": tid,
            "timestamp": r["ended_at"] or r["started_at"],
            "tool_name": r["tool_name"],
            "tool_call_id": r["tool_call_id"],
            "input": inp,
            "output": r["output_text"] or "",
            "status": r["status"],
            "duration_ms": round(float(r["duration_ms"] or 0), 2),
        }
        if r["error_type"]:
            row["error_type"] = r["error_type"]
        if r["error_message"]:
            row["error_message"] = r["error_message"]
        out.append(row)
    return out


def load_task_lifecycle_trace(thread_id: str) -> list[dict[str, Any]]:
    st = _store()
    tid = (thread_id or "").strip()
    if st is None or not tid:
        return []
    conn = st._connection()  # noqa: SLF001
    conn.row_factory = sqlite3.Row
    T = ObservabilityTable
    rows = conn.execute(
        f"""
        SELECT occurred_at, schema_version, event, main_task_id, subtask_id, status, detail_json
        FROM {T.TASK_LIFECYCLE_EVENTS}
        WHERE thread_id = ?
        ORDER BY occurred_at ASC
        """,
        (tid,),
    ).fetchall()
    out: list[dict[str, Any]] = []
    for r in rows:
        row: dict[str, Any] = {
            "thread_id": tid,
            "ts": r["occurred_at"],
            "schema": r["schema_version"] or "evoflow.task_lifecycle.v1",
            "event": r["event"],
        }
        if r["main_task_id"]:
            row["main_task_id"] = r["main_task_id"]
        if r["subtask_id"]:
            row["subtask_id"] = r["subtask_id"]
        if r["status"]:
            row["status"] = r["status"]
        if r["detail_json"]:
            detail = _parse_payload_json(r["detail_json"])
            if detail:
                row["detail"] = detail
        out.append(row)
    return out


def load_im_channel_errors(thread_id: str) -> list[dict[str, Any]]:
    st = _store()
    tid = (thread_id or "").strip()
    if st is None or not tid:
        return []
    conn = st._connection()  # noqa: SLF001
    conn.row_factory = sqlite3.Row
    T = ObservabilityTable
    rows = conn.execute(
        f"""
        SELECT occurred_at, payload_json
        FROM {T.IM_CHANNEL_ERRORS}
        WHERE thread_id = ?
        ORDER BY occurred_at ASC
        """,
        (tid,),
    ).fetchall()
    out: list[dict[str, Any]] = []
    for r in rows:
        body = _parse_payload_json(r["payload_json"])
        if not body:
            body = {"ts": r["occurred_at"]}
        body.setdefault("thread_id", tid)
        out.append(body)
    return out


def load_model_sections(thread_id: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """``(model_request_payloads, model_vendor_roundtrip)`` shaped like file parsers."""
    st = _store()
    tid = (thread_id or "").strip()
    if st is None or not tid:
        return [], []
    conn = st._connection()  # noqa: SLF001
    conn.row_factory = sqlite3.Row
    T = ObservabilityTable
    rows = conn.execute(
        f"""
        SELECT provider, model, stage, trace_id, requested_at, latency_ms,
               first_token_latency_ms, request_json, response_json,
               usage_json, invocation_kind
        FROM {T.MODEL_INVOCATIONS}
        WHERE thread_id = ?
        ORDER BY requested_at ASC
        """,
        (tid,),
    ).fetchall()
    payloads: list[dict[str, Any]] = []
    roundtrips: list[dict[str, Any]] = []
    for r in rows:
        stage = str(r["stage"] or "").strip()
        ts_ms = parse_iso_to_ms(r["requested_at"]) or None
        if stage == "vendor_roundtrip":
            req_wrap = _parse_payload_json(r["request_json"])
            vendor_request = None
            if isinstance(req_wrap, dict):
                from evoflow.observability.thinking_context import resolve_vendor_request_from_stored

                vendor_request = resolve_vendor_request_from_stored(req_wrap)
            elif req_wrap is not None:
                vendor_request = req_wrap
            response_body = _parse_payload_json(r["response_json"]) if r["response_json"] else None
            roundtrips.append(
                {
                    "thread_id": tid,
                    "ts_ms": ts_ms,
                    "provider": r["provider"],
                    "model": r["model"],
                    "latency_ms": r["latency_ms"],
                    "invocation_kind": r["invocation_kind"],
                    "trace_id": r["trace_id"],
                    "vendor_request": vendor_request,
                    "response": response_body,
                }
            )
        else:
            rec = _parse_payload_json(r["request_json"])
            if not rec:
                continue
            if ts_ms is not None and "ts_ms" not in rec:
                rec["ts_ms"] = ts_ms
            rec.setdefault("thread_id", tid)
            rec.setdefault("provider", r["provider"])
            rec.setdefault("model", r["model"])
            if r["invocation_kind"] and not rec.get("invocation_kind"):
                rec["invocation_kind"] = r["invocation_kind"]
            if r["usage_json"] and not rec.get("usage_json"):
                rec["usage_json"] = r["usage_json"]
            payloads.append(rec)
    payloads.sort(key=lambda x: int(x.get("ts_ms") or 0))
    roundtrips.sort(key=lambda x: int(x.get("ts_ms") or 0))
    return payloads, roundtrips


def sqlite_source_label() -> str:
    st = _store()
    if st is None:
        return ""
    try:
        return f"sqlite:{st.resolved_path()}"
    except Exception:
        return "sqlite:evoflow_observability.db"


def list_recent_threads(*, limit: int = 50) -> list[dict[str, Any]]:
    st = _store()
    if st is None:
        return []
    conn = st._connection()  # noqa: SLF001
    conn.row_factory = sqlite3.Row
    T = ObservabilityTable
    limit = max(1, min(200, limit))
    rows = conn.execute(
        f"""
        SELECT thread_id, last_seen_at
        FROM {T.THREADS}
        WHERE thread_id IS NOT NULL AND thread_id != '' AND thread_id != '_no_thread'
        ORDER BY last_seen_at DESC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()
    out: list[dict[str, Any]] = []
    for r in rows:
        tid = str(r["thread_id"] or "").strip()
        if not tid:
            continue
        ms = parse_iso_to_ms(r["last_seen_at"]) or 0
        out.append({"thread_id": tid, "updated_at_ms": ms or 0})
    return out
