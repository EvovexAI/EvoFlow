"""Read-only queries for ``evoflow_obs_*`` SQLite tables."""

from __future__ import annotations

import json
import re
import sqlite3
from datetime import UTC, datetime, timedelta
from typing import Any

from evoflow.observability.gateway_paths import normalize_gateway_obs_path
from evoflow.observability.provider_labels import normalize_stored_provider
from evoflow.observability.response_error import extract_response_error_message
from evoflow.observability.sqlite_store import ObservabilitySqliteStore
from evoflow.observability.tables import ObservabilityTable
from evoflow.observability.tool_filters import (
    llm_tool_visibility_sql,
    tool_invocation_and_suffix,
    tool_invocation_where,
)


class ObservabilityDiskFullError(RuntimeError):
    """Raised when observability SQLite hits ``database or disk is full``."""


def disk_full_user_message() -> str:
    return (
        "观测数据库所在磁盘空间不足（sqlite: database or disk is full）。"
        "请释放系统盘空间（建议至少 2GB），或在 backend 目录执行 data retention 清理 "
        "data/observability/evoflow_observability.db，并将 EVOFLOW_HOME 迁到空间充足的盘。"
    )


def enrich_model_row_thinking(row: dict[str, Any]) -> None:
    """Attach unified thinking context + human label to a model invocation row."""
    if not isinstance(row, dict):
        return
    try:
        from evoflow.observability.thinking_context import (
            extract_thinking_from_stored_request,
            format_thinking_label,
        )

        ctx = extract_thinking_from_stored_request(row.get("request_json"), row=row)
        if ctx:
            row["evoflow_thinking"] = ctx
            row["thinking_label"] = format_thinking_label(ctx)
        for key in ("reasoning_effort", "thinking_type", "session_mode"):
            if not row.get(key) and ctx.get(key):
                row[key] = ctx[key]
        if row.get("thinking_enabled") is None and ctx.get("thinking_enabled") is not None:
            row["thinking_enabled"] = 1 if ctx["thinking_enabled"] else 0
        if row.get("thinking_budget_tokens") is None and ctx.get("thinking_budget_tokens") is not None:
            row["thinking_budget_tokens"] = ctx["thinking_budget_tokens"]
    except Exception:
        pass


def _store() -> ObservabilitySqliteStore | None:
    try:
        from evoflow.config.app_config import get_app_config
        from evoflow.debug.trace_sink import observability_enabled

        if not observability_enabled():
            return None
        cfg = get_app_config().observability
        return ObservabilitySqliteStore(cfg.sqlite_path)
    except Exception:
        return None


def _row_to_dict(cursor: sqlite3.Cursor, row: sqlite3.Row) -> dict[str, Any]:
    return {k: row[k] for k in row.keys()}


def _int_usage_token(v: Any) -> int:
    if v is None or v is False:
        return 0
    try:
        return int(v)
    except (TypeError, ValueError):
        return 0


def _pick_in_out_total_flat(usage_like: dict[str, Any]) -> tuple[int, int, int]:
    """(input, output, total) from a flat usage dict (OpenAI-style keys)."""
    inp = _int_usage_token(usage_like.get("input_tokens")) or _int_usage_token(usage_like.get("prompt_tokens"))
    out = _int_usage_token(usage_like.get("output_tokens")) or _int_usage_token(usage_like.get("completion_tokens"))
    tot = _int_usage_token(usage_like.get("total_tokens"))
    if tot <= 0 and (inp or out):
        tot = inp + out
    return inp, out, tot


def compaction_fields_from_usage_payload(u: Any) -> dict[str, Any]:
    """Extract compaction metadata embedded in usage_json by vendor_roundtrip."""
    if not isinstance(u, dict):
        return {}
    comp = u.get("compaction")
    if not isinstance(comp, dict):
        return {}
    return {
        "compaction_before_gate_tokens": comp.get("compaction_before_gate_tokens"),
        "compaction_after_gate_tokens": comp.get("compaction_after_gate_tokens"),
        "compaction_saved_gate_tokens": comp.get("compaction_saved_gate_tokens"),
        "compaction_saved_pct": comp.get("compaction_saved_pct"),
        "compaction_passes": comp.get("compaction_passes"),
        "compaction_note": comp.get("compaction_note"),
        "compaction_applied": comp.get("compaction_applied"),
        "compaction_pass": u.get("compaction_pass"),
    }


def token_triplet_from_usage_payload(u: Any) -> tuple[int, int, int]:
    """Normalize ``usage_json`` / ``llm_output`` shapes from ``evoflow_obs_model_invocations``."""
    from evoflow.agents.middlewares.message_usage_helpers import normalize_usage_counts

    if not isinstance(u, dict):
        return (0, 0, 0)
    for layer in _usage_payload_layers(u):
        normed = normalize_usage_counts(layer)
        if normed:
            return (
                int(normed.get("input_tokens") or 0),
                int(normed.get("output_tokens") or 0),
                int(normed.get("total_tokens") or 0),
            )
    return (0, 0, 0)


def _usage_payload_layers(u: dict[str, Any]) -> list[dict[str, Any]]:
    """Flatten nested usage blobs from observability ``usage_json``."""
    layers: list[dict[str, Any]] = []
    for layer in (
        u.get("token_usage") if isinstance(u.get("token_usage"), dict) else None,
        u.get("usage") if isinstance(u.get("usage"), dict) else None,
        u,
    ):
        if isinstance(layer, dict):
            layers.append(layer)
    rm = u.get("response_metadata")
    if isinstance(rm, dict):
        us2 = rm.get("usage")
        if isinstance(us2, dict):
            layers.append(us2)
    um = u.get("usage_metadata")
    if isinstance(um, dict):
        layers.append(um)
    lo = u.get("llm_output")
    if isinstance(lo, dict):
        layers.extend(_usage_payload_layers(lo))
    rms = u.get("response_metadata_subset")
    if isinstance(rms, dict):
        for sub in rms.values():
            if isinstance(sub, dict):
                layers.append(sub)
    return layers


def cache_tokens_from_usage_payload(u: Any) -> dict[str, int | None]:
    """Extract prompt-cache token breakdown from observability ``usage_json``."""
    from evoflow.agents.middlewares.message_usage_helpers import normalize_usage_counts

    if not isinstance(u, dict):
        return {
            "cache_read_tokens": None,
            "cache_creation_tokens": None,
            "cache_miss_tokens": None,
        }
    merged: dict[str, int] = {}
    for layer in _usage_payload_layers(u):
        normed = normalize_usage_counts(layer)
        if not normed:
            continue
        for key in ("cache_read_tokens", "cache_creation_tokens", "cache_miss_tokens"):
            val = _int_usage_token(normed.get(key))
            if val > 0:
                merged[key] = max(merged.get(key, 0), val)
    if not merged:
        return {
            "cache_read_tokens": None,
            "cache_creation_tokens": None,
            "cache_miss_tokens": None,
        }
    return {
        "cache_read_tokens": merged.get("cache_read_tokens"),
        "cache_creation_tokens": merged.get("cache_creation_tokens"),
        "cache_miss_tokens": merged.get("cache_miss_tokens"),
    }


def observability_status() -> dict[str, Any]:
    try:
        from evoflow.config.app_config import get_app_config
        from evoflow.config.data_paths import resolve_observability_db_config_path
        from evoflow.debug.trace_sink import observability_enabled

        obs = get_app_config().observability
        enabled = observability_enabled()
        # Resolve path without opening/creating the SQLite file when disabled.
        path = str(resolve_observability_db_config_path((obs.sqlite_path or "").strip() or None))
        return {
            "enabled": enabled,
            "sqlite_path": path,
            "file_mirror": bool(obs.file_mirror),
        }
    except Exception as exc:
        return {"enabled": False, "sqlite_path": "", "error": str(exc)}


def _percentile(values: list[float], p: float) -> float | None:
    if not values:
        return None
    s = sorted(values)
    idx = min(len(s) - 1, max(0, int(round((p / 100.0) * (len(s) - 1)))))
    return round(float(s[idx]), 2)


def fetch_overview(*, since_hours: float | None = None) -> dict[str, Any]:
    st = _store()
    if st is None:
        return {"enabled": False}
    conn = st._connection()  # noqa: SLF001 — shared schema bootstrap
    conn.row_factory = sqlite3.Row
    T = ObservabilityTable
    since = _since_iso(since_hours)
    tool_w = tool_invocation_where("ended_at >= ?" if since else None)
    tool_and = tool_invocation_and_suffix("duration_ms IS NOT NULL", "ended_at >= ?" if since else None)
    tool_p: tuple[Any, ...] = (since,) if since else ()
    model_w = " WHERE requested_at >= ?" if since else ""
    model_and = " AND requested_at >= ?" if since else ""
    model_p: tuple[Any, ...] = (since,) if since else ()
    trace_extra = " AND occurred_at >= ?" if since else ""
    trace_p: tuple[Any, ...] = (since,) if since else ()

    if since:
        thread_count = conn.execute(
            f"""
            SELECT COUNT(DISTINCT thread_id) FROM {T.TOOL_INVOCATIONS}
            {tool_invocation_where("thread_id IS NOT NULL", "thread_id != ''", "ended_at >= ?")}
            """,
            (since,),
        ).fetchone()[0]
    else:
        thread_count = conn.execute(f"SELECT COUNT(*) FROM {T.THREADS}").fetchone()[0]

    tool_row = conn.execute(
        f"""
        SELECT COUNT(*) AS n,
               SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
               AVG(duration_ms) AS avg_ms,
               SUM(duration_ms) AS sum_ms
        FROM {T.TOOL_INVOCATIONS}{tool_w}
        """,
        tool_p,
    ).fetchone()
    model_row = conn.execute(
        f"""
        SELECT COUNT(*) AS n,
               AVG(latency_ms) AS avg_latency
        FROM {T.MODEL_INVOCATIONS}{model_w}
        """,
        model_p,
    ).fetchone()
    tool_durations = [
        float(r[0])
        for r in conn.execute(
            f"SELECT duration_ms FROM {T.TOOL_INVOCATIONS} WHERE duration_ms IS NOT NULL{tool_and}",
            tool_p,
        ).fetchall()
        if r[0] is not None
    ]
    model_latencies = [
        float(r[0])
        for r in conn.execute(
            f"SELECT latency_ms FROM {T.MODEL_INVOCATIONS} WHERE latency_ms IS NOT NULL{model_and}",
            model_p,
        ).fetchall()
        if r[0] is not None
    ]
    ttft_values = [
        float(r[0])
        for r in conn.execute(
            f"SELECT first_token_latency_ms FROM {T.MODEL_INVOCATIONS} WHERE first_token_latency_ms IS NOT NULL{model_and}",
            model_p,
        ).fetchall()
        if r[0] is not None
    ]
    top_slow_tools = [
        _row_to_dict(conn, r)
        for r in conn.execute(
            f"""
            SELECT tool_name, COUNT(*) AS call_count,
                   AVG(duration_ms) AS avg_duration_ms,
                   MAX(duration_ms) AS max_duration_ms,
                   SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error_count
            FROM {T.TOOL_INVOCATIONS}{tool_w}
            GROUP BY tool_name
            ORDER BY max_duration_ms DESC
            LIMIT 10
            """,
            tool_p,
        ).fetchall()
    ]
    thread_slow_w = tool_invocation_where(
        "thread_id IS NOT NULL",
        "thread_id != ''",
        "ended_at >= ?" if since else None,
    )
    top_slow_threads = [
        _row_to_dict(conn, r)
        for r in conn.execute(
            f"""
            SELECT thread_id,
                   COUNT(*) AS tool_calls,
                   SUM(duration_ms) AS total_tool_ms,
                   MAX(duration_ms) AS max_tool_ms
            FROM {T.TOOL_INVOCATIONS}{thread_slow_w}
            GROUP BY thread_id
            ORDER BY total_tool_ms DESC
            LIMIT 10
            """,
            tool_p if since else (),
        ).fetchall()
    ]
    total_tokens = {"input": 0, "output": 0, "total": 0}
    model_token_by_name: dict[str, dict[str, Any]] = {}
    usage_sql = f"SELECT model, usage_json FROM {T.MODEL_INVOCATIONS} WHERE usage_json IS NOT NULL AND usage_json != ''{model_and}"
    for (
        model,
        usage_json,
    ) in conn.execute(usage_sql, model_p).fetchall():
        model_key = str(model or "").strip() or "—"
        if model_key not in model_token_by_name:
            model_token_by_name[model_key] = {
                "model": model_key,
                "invocations": 0,
                "input_tokens": 0,
                "output_tokens": 0,
                "total_tokens": 0,
            }
        model_token_by_name[model_key]["invocations"] += 1
        try:
            u = json.loads(usage_json)
            inp, out, tot = token_triplet_from_usage_payload(u)
            total_tokens["input"] += inp
            total_tokens["output"] += out
            total_tokens["total"] += tot
            model_token_by_name[model_key]["input_tokens"] += inp
            model_token_by_name[model_key]["output_tokens"] += out
            model_token_by_name[model_key]["total_tokens"] += tot
        except (json.JSONDecodeError, TypeError, ValueError):
            continue
    model_token_stats = sorted(
        model_token_by_name.values(),
        key=lambda r: (int(r.get("total_tokens") or 0), int(r.get("invocations") or 0)),
        reverse=True,
    )
    # Latency from collab_cycle model_response trace rows
    trace_lat = conn.execute(
        f"""
        SELECT AVG(CAST(json_extract(payload_json, '$.elapsed_ms') AS REAL)) AS avg_ms,
               COUNT(*) AS n
        FROM {T.TRACE_EVENTS}
        WHERE event = 'model_response'
          AND json_extract(payload_json, '$.elapsed_ms') IS NOT NULL{trace_extra}
        """,
        trace_p,
    ).fetchone()
    n_tools = int(tool_row[0] or 0)
    n_tool_err = int(tool_row[1] or 0)
    return {
        "enabled": True,
        "since_hours": since_hours,
        "since_iso": since,
        "thread_count": int(thread_count or 0),
        "tool_invocations": n_tools,
        "tool_errors": n_tool_err,
        "tool_error_rate": round(n_tool_err / n_tools, 4) if n_tools else 0.0,
        "tool_avg_duration_ms": round(float(tool_row[2] or 0), 2),
        "tool_duration_p95_ms": _percentile(tool_durations, 95),
        "tool_total_duration_ms": round(float(tool_row[3] or 0), 2),
        "model_invocations": int(model_row[0] or 0),
        "model_avg_latency_ms": round(float(model_row[1] or 0), 2) if model_row[1] else None,
        "model_latency_p95_ms": _percentile(model_latencies, 95),
        "model_ttft_p50_ms": _percentile(ttft_values, 50),
        "model_ttft_p95_ms": _percentile(ttft_values, 95),
        "model_ttft_p99_ms": _percentile(ttft_values, 99),
        "model_ttft_count": len(ttft_values),
        "trace_model_response_count": int(trace_lat[1] or 0),
        "trace_model_avg_latency_ms": round(float(trace_lat[0] or 0), 2) if trace_lat[0] else None,
        "total_tokens": total_tokens,
        "model_token_stats": model_token_stats,
        "top_slow_tools": top_slow_tools,
        "top_slow_threads": top_slow_threads,
    }


def _paginate(
    table: str,
    *,
    page: int,
    page_size: int,
    where: str = "",
    params: tuple[Any, ...] = (),
    order_by: str = "ROWID DESC",
) -> dict[str, Any]:
    st = _store()
    if st is None:
        return {"enabled": False, "items": [], "total": 0, "page": page, "page_size": page_size}
    conn = st._connection()  # noqa: SLF001
    conn.row_factory = sqlite3.Row
    w = f" WHERE {where}" if where else ""
    try:
        total = conn.execute(f"SELECT COUNT(*) FROM {table}{w}", params).fetchone()[0]
        offset = max(0, (page - 1) * page_size)
        rows = conn.execute(
            f"SELECT * FROM {table}{w} ORDER BY {order_by} LIMIT ? OFFSET ?",
            (*params, page_size, offset),
        ).fetchall()
    except sqlite3.OperationalError as exc:
        if "full" in str(exc).lower():
            raise ObservabilityDiskFullError(disk_full_user_message()) from exc
        raise
    items = [_row_to_dict(conn, r) for r in rows]
    return {
        "enabled": True,
        "items": items,
        "total": int(total),
        "page": page,
        "page_size": page_size,
        "pages": max(1, (int(total) + page_size - 1) // page_size),
    }


_GATEWAY_ORDER_BY = {
    "occurred_at": "occurred_at DESC",
    "duration_ms": "duration_ms DESC",
}


def gateway_request_summary(*, since_hours: float | None = 24) -> dict[str, Any]:
    st = _store()
    if st is None:
        return {"enabled": False}
    conn = st._connection()  # noqa: SLF001
    conn.row_factory = sqlite3.Row
    since = _since_iso(since_hours)
    where = " WHERE occurred_at >= ?" if since else ""
    params: tuple[Any, ...] = (since,) if since else ()
    row = conn.execute(
        f"""
        SELECT COUNT(*) AS n,
               AVG(duration_ms) AS avg_duration_ms,
               MAX(duration_ms) AS max_duration_ms,
               SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS errors
        FROM {ObservabilityTable.GATEWAY_REQUESTS}{where}
        """,
        params,
    ).fetchone()
    status_rows = [
        _row_to_dict(conn, r)
        for r in conn.execute(
            f"""
            SELECT (status_code / 100) || 'xx' AS status_family, COUNT(*) AS count
            FROM {ObservabilityTable.GATEWAY_REQUESTS}{where}
            GROUP BY status_family
            ORDER BY status_family
            """,
            params,
        ).fetchall()
    ]
    slow_paths = [
        _row_to_dict(conn, r)
        for r in conn.execute(
            f"""
            SELECT method, path, COUNT(*) AS count, AVG(duration_ms) AS avg_duration_ms, MAX(duration_ms) AS max_duration_ms
            FROM {ObservabilityTable.GATEWAY_REQUESTS}{where}
            GROUP BY method, path
            ORDER BY max_duration_ms DESC
            LIMIT 10
            """,
            params,
        ).fetchall()
    ]
    total = int(row["n"] or 0)
    return {
        "enabled": True,
        "since_hours": since_hours,
        "since_iso": since,
        "request_count": total,
        "error_count": int(row["errors"] or 0),
        "error_rate": round(float(row["errors"] or 0) / total, 4) if total else 0.0,
        "avg_duration_ms": round(float(row["avg_duration_ms"] or 0), 2),
        "max_duration_ms": round(float(row["max_duration_ms"] or 0), 2),
        "status_families": status_rows,
        "slow_paths": slow_paths,
    }


def gateway_request_hotspots(
    *,
    since_hours: float | None = 1,
    top_n: int = 15,
    min_requests: int = 5,
    min_error_rate: float = 0.2,
    slow_avg_ms: float = 2000.0,
) -> dict[str, Any]:
    """Aggregate frequent / high-error / slow routes (paths normalized to ``{id}`` templates)."""
    st = _store()
    if st is None:
        return {"enabled": False}
    conn = st._connection()  # noqa: SLF001
    conn.row_factory = sqlite3.Row
    since = _since_iso(since_hours)
    where = " WHERE occurred_at >= ?" if since else ""
    params: tuple[Any, ...] = (since,) if since else ()
    rows = conn.execute(
        f"""
        SELECT method, path,
               COUNT(*) AS requests,
               AVG(duration_ms) AS avg_duration_ms,
               MAX(duration_ms) AS max_duration_ms,
               SUM(CASE WHEN status_code >= 400 AND status_code < 500 THEN 1 ELSE 0 END) AS status4xx,
               SUM(CASE WHEN status_code >= 500 THEN 1 ELSE 0 END) AS status5xx
        FROM {ObservabilityTable.GATEWAY_REQUESTS}{where}
        GROUP BY method, path
        """,
        params,
    ).fetchall()

    merged: dict[tuple[str, str], dict[str, float | int | str]] = {}
    for r in rows:
        method = str(r["method"] or "GET").upper()
        route = normalize_gateway_obs_path(str(r["path"] or ""))
        key = (method, route)
        bucket = merged.get(key)
        if bucket is None:
            bucket = {
                "method": method,
                "route": route,
                "requests": 0,
                "status4xx": 0,
                "status5xx": 0,
                "avg_duration_ms": 0.0,
                "max_duration_ms": 0.0,
                "_dur_sum": 0.0,
            }
            merged[key] = bucket
        req = int(r["requests"] or 0)
        bucket["requests"] = int(bucket["requests"]) + req
        bucket["status4xx"] = int(bucket["status4xx"]) + int(r["status4xx"] or 0)
        bucket["status5xx"] = int(bucket["status5xx"]) + int(r["status5xx"] or 0)
        bucket["_dur_sum"] = float(bucket["_dur_sum"]) + float(r["avg_duration_ms"] or 0) * req
        bucket["max_duration_ms"] = max(float(bucket["max_duration_ms"]), float(r["max_duration_ms"] or 0))

    items: list[dict[str, Any]] = []
    for bucket in merged.values():
        req = int(bucket["requests"])
        err4 = int(bucket["status4xx"])
        err5 = int(bucket["status5xx"])
        avg_ms = float(bucket["_dur_sum"]) / req if req else 0.0
        items.append(
            {
                "method": bucket["method"],
                "route": bucket["route"],
                "requests": req,
                "status4xx": err4,
                "status5xx": err5,
                "error_rate": round((err4 + err5) / req, 4) if req else 0.0,
                "avg_duration_ms": round(avg_ms, 2),
                "max_duration_ms": round(float(bucket["max_duration_ms"]), 2),
            }
        )

    min_req = max(1, int(min_requests))
    top = max(1, min(50, int(top_n)))
    frequent = sorted(items, key=lambda x: x["requests"], reverse=True)[:top]
    high_error = sorted(
        [x for x in items if x["requests"] >= min_req and x["error_rate"] >= min_error_rate],
        key=lambda x: (x["error_rate"], x["requests"]),
        reverse=True,
    )[:top]
    slow = sorted(
        [x for x in items if x["requests"] >= min_req and x["avg_duration_ms"] >= slow_avg_ms],
        key=lambda x: x["avg_duration_ms"],
        reverse=True,
    )[:top]

    return {
        "enabled": True,
        "since_hours": since_hours,
        "since_iso": since,
        "thresholds": {
            "min_requests": min_req,
            "min_error_rate": min_error_rate,
            "slow_avg_ms": slow_avg_ms,
            "top_n": top,
        },
        "frequent": frequent,
        "high_error_rate": high_error,
        "slow": slow,
    }


def list_gateway_requests(
    *,
    page: int = 1,
    page_size: int = 20,
    path: str | None = None,
    method: str | None = None,
    status_code: int | None = None,
    status_family: str | None = None,
    min_duration_ms: float | None = None,
    since_hours: float | None = None,
    sort_by: str = "occurred_at",
) -> dict[str, Any]:
    clauses: list[str] = []
    params: list[Any] = []
    if path:
        clauses.append("path LIKE ?")
        params.append(f"%{path.strip()}%")
    if method:
        clauses.append("method = ?")
        params.append(method.strip().upper())
    if status_code is not None:
        clauses.append("status_code = ?")
        params.append(int(status_code))
    fam = (status_family or "").strip().lower()
    if fam in {"2xx", "3xx", "4xx", "5xx"}:
        start = int(fam[0]) * 100
        clauses.append("status_code >= ? AND status_code < ?")
        params.extend([start, start + 100])
    if min_duration_ms is not None:
        try:
            clauses.append("duration_ms >= ?")
            params.append(float(min_duration_ms))
        except (TypeError, ValueError):
            pass
    since = _since_iso(since_hours)
    if since:
        clauses.append("occurred_at >= ?")
        params.append(since)
    order = _GATEWAY_ORDER_BY.get((sort_by or "occurred_at").strip(), _GATEWAY_ORDER_BY["occurred_at"])
    return _paginate(
        ObservabilityTable.GATEWAY_REQUESTS,
        page=max(1, page),
        page_size=min(100, max(1, page_size)),
        where=" AND ".join(clauses),
        params=tuple(params),
        order_by=order,
    )


_TOOL_ORDER_BY = {
    "ended_at": "ended_at DESC",
    "duration_ms": "duration_ms DESC",
}


def _since_iso(hours: float | None) -> str | None:
    if hours is None:
        return None
    try:
        h = float(hours)
    except (TypeError, ValueError):
        return None
    if h <= 0:
        return None
    return (datetime.now(UTC) - timedelta(hours=h)).isoformat().replace("+00:00", "Z")


def list_tool_invocations(
    *,
    page: int = 1,
    page_size: int = 20,
    thread_id: str | None = None,
    tool_name: str | None = None,
    status: str | None = None,
    sort_by: str = "ended_at",
    min_duration_ms: float | None = None,
    since_hours: float | None = None,
    include_internal: bool = False,
) -> dict[str, Any]:
    clauses: list[str] = [llm_tool_visibility_sql(include_internal=include_internal)]
    params: list[Any] = []
    if thread_id:
        clauses.append("thread_id = ?")
        params.append(thread_id.strip())
    if tool_name:
        clauses.append("tool_name = ?")
        params.append(tool_name.strip())
    if status:
        clauses.append("status = ?")
        params.append(status.strip())
    if min_duration_ms is not None:
        try:
            clauses.append("duration_ms >= ?")
            params.append(float(min_duration_ms))
        except (TypeError, ValueError):
            pass
    since = _since_iso(since_hours)
    if since:
        clauses.append("ended_at >= ?")
        params.append(since)
    where = " AND ".join(clauses)
    order = _TOOL_ORDER_BY.get((sort_by or "ended_at").strip(), _TOOL_ORDER_BY["ended_at"])
    return _paginate(
        ObservabilityTable.TOOL_INVOCATIONS,
        page=max(1, page),
        page_size=min(100, max(1, page_size)),
        where=where,
        params=tuple(params),
        order_by=order,
    )


_MODEL_ORDER_BY = {
    "requested_at": "requested_at DESC",
    "latency_ms": "latency_ms DESC",
    "first_token_latency_ms": "first_token_latency_ms DESC",
}


_MODEL_JSON_TRUNCATE_BYTES = 100 * 1024  # 100 KB per request_json / response_json
_MESSAGE_COUNT_RE = re.compile(r'"message_count"\s*:\s*(\d+)')
_MESSAGES_TRUNC_RE = re.compile(r'"messages_truncated"\s*:\s*"tail_\d+_of_(\d+)"')
_MESSAGES_STORED_TRUNC_RE = re.compile(
    r'"messages_truncated"\s*:\s*"(?:stored_tail_\d+_of_|omitted_all_of_|tail_\d+_of_)(\d+)"'
)


def _message_count_from_request_raw(req_raw: Any) -> int | None:
    """Best-effort message_count from stored request_json (even if mid-cut)."""
    if req_raw is None or req_raw == "":
        return None
    if isinstance(req_raw, dict):
        try:
            from evoflow.observability.thinking_context import resolve_vendor_request_from_stored

            vendor_req = resolve_vendor_request_from_stored(req_raw)
        except Exception:
            vendor_req = req_raw if isinstance(req_raw, dict) else None
        if isinstance(vendor_req, dict):
            if vendor_req.get("message_count") is not None:
                try:
                    return int(vendor_req["message_count"])
                except (TypeError, ValueError):
                    pass
            trunc = str(vendor_req.get("messages_truncated") or "")
            m = _MESSAGES_STORED_TRUNC_RE.search(json.dumps({"messages_truncated": trunc}, ensure_ascii=False))
            if not m and trunc:
                m2 = re.search(r"(?:of_|omitted_all_of_)(\d+)$", trunc)
                if m2:
                    try:
                        return int(m2.group(1))
                    except ValueError:
                        pass
            msgs = vendor_req.get("messages")
            if isinstance(msgs, list):
                return len(msgs)
        return None

    text = str(req_raw)
    # Prefer explicit field even when JSON is truncated mid-string.
    m = _MESSAGE_COUNT_RE.search(text)
    if m:
        try:
            return int(m.group(1))
        except ValueError:
            pass
    m = _MESSAGES_STORED_TRUNC_RE.search(text)
    if m:
        try:
            return int(m.group(1))
        except ValueError:
            pass
    m = _MESSAGES_TRUNC_RE.search(text)
    if m:
        try:
            return int(m.group(1))
        except ValueError:
            pass
    try:
        req_obj = json.loads(text)
    except (json.JSONDecodeError, TypeError, ValueError):
        return None
    return _message_count_from_request_raw(req_obj)


def _truncate_json_field(value: Any, max_bytes: int = _MODEL_JSON_TRUNCATE_BYTES) -> str | None:
    """Truncate a JSON string to ``max_bytes``, appending a truncation marker."""
    if value is None:
        return None
    s = str(value)
    if len(s) <= max_bytes:
        return s
    return s[:max_bytes] + '\n… [truncated]'


def _tool_name_from_call_dict(tc: dict[str, Any]) -> str:
    fn = tc.get("function")
    if isinstance(fn, dict):
        name = str(fn.get("name", "") or "").strip()
        if name:
            return name
    return str(tc.get("name", "") or "").strip()


def _unwrap_message_body(msg: Any) -> dict[str, Any] | None:
    if not isinstance(msg, dict):
        return None
    inner = msg.get("data")
    if isinstance(inner, dict) and msg.get("type") in ("ai", "human", "tool", "system", "AIMessageChunk"):
        return inner
    return msg


def _normalize_finish_reason(raw: Any) -> str:
    text = str(raw or "").strip().lower()
    if not text:
        return ""
    half = len(text) // 2
    if half > 0 and text[:half] == text[half:]:
        return text[:half]
    return text


def _reasoning_from_message_body(msg_body: dict[str, Any]) -> str:
    ak = msg_body.get("additional_kwargs")
    if isinstance(ak, dict):
        rc = ak.get("reasoning_content")
        if isinstance(rc, str) and rc.strip():
            return rc.strip()
    content = msg_body.get("content")
    if isinstance(content, list):
        parts: list[str] = []
        for part in content:
            if isinstance(part, dict) and part.get("type") == "thinking":
                t = part.get("thinking")
                if isinstance(t, str) and t.strip():
                    parts.append(t.strip())
        if parts:
            return "\n\n".join(parts)
    return ""


def _finish_reason_from_response_dict(resp: dict[str, Any]) -> str:
    generations = resp.get("generations")
    if isinstance(generations, list):
        for row in generations:
            gens = row if isinstance(row, list) else [row]
            for gen in gens:
                if not isinstance(gen, dict):
                    continue
                gi = gen.get("generation_info")
                if isinstance(gi, dict):
                    fr = _normalize_finish_reason(gi.get("finish_reason"))
                    if fr:
                        return fr
    choices = resp.get("choices")
    if isinstance(choices, list):
        for ch in choices:
            if isinstance(ch, dict):
                fr = _normalize_finish_reason(ch.get("finish_reason"))
                if fr:
                    return fr
    return ""


def _tool_names_from_message_body(msg_body: dict[str, Any]) -> list[str]:
    """Collect tool names from ``tool_calls``, ``tool_call_chunks``, and OpenAI-style ``additional_kwargs.tool_calls``."""
    names: list[str] = []
    seen: set[str] = set()

    def _add_from_list(tcs: Any) -> None:
        if not isinstance(tcs, list):
            return
        for tc in tcs:
            if not isinstance(tc, dict):
                continue
            name = _tool_name_from_call_dict(tc)
            if name and name not in seen:
                seen.add(name)
                names.append(name)

    _add_from_list(msg_body.get("tool_calls"))
    # Streaming responses accumulate tool_call_chunks instead of tool_calls
    _add_from_list(msg_body.get("tool_call_chunks"))
    ak = msg_body.get("additional_kwargs")
    if isinstance(ak, dict):
        _add_from_list(ak.get("tool_calls"))
    return names


def _response_summary_from_json(response_json: Any) -> dict[str, Any] | None:
    """Extract a lightweight summary from ``response_json`` for list display.

    Returns ``None`` when the JSON is empty/unparseable, otherwise a dict with
    ``kind``, ``toolNames``, and ``contentPreview``.
    """
    if not response_json:
        return None
    try:
        resp = json.loads(response_json) if isinstance(response_json, str) else response_json
    except (json.JSONDecodeError, TypeError, ValueError):
        return None
    if not isinstance(resp, dict):
        return None

    # Error response
    err_msg = extract_response_error_message(resp)
    if err_msg:
        return {"kind": "error", "toolNames": [], "contentPreview": err_msg[:500]}

    tool_names: set[str] = set()
    content_parts: list[str] = []

    def _collect(msg: Any) -> None:
        body = _unwrap_message_body(msg)
        if body is None:
            return
        content = body.get("content")
        if content is not None:
            if isinstance(content, str):
                t = content.strip()
                if t:
                    content_parts.append(t)
            elif isinstance(content, list):
                for part in content:
                    if isinstance(part, dict) and part.get("type") == "text":
                        t = str(part.get("text", "") or "").strip()
                        if t:
                            content_parts.append(t)
        for name in _tool_names_from_message_body(body):
            tool_names.add(name)

    # generations (LangChain-style)
    generations = resp.get("generations")
    if isinstance(generations, list):
        for row in generations:
            gens = row if isinstance(row, list) else [row]
            for gen in gens:
                if not isinstance(gen, dict):
                    continue
                text = gen.get("text")
                if isinstance(text, str) and text.strip():
                    content_parts.append(text.strip())
                _collect(gen.get("message"))

    # choices (OpenAI-style)
    choices = resp.get("choices")
    if isinstance(choices, list):
        for ch in choices:
            if not isinstance(ch, dict):
                continue
            _collect(ch.get("message"))
            _collect(ch.get("delta"))

    # messages (direct array)
    messages = resp.get("messages")
    if isinstance(messages, list):
        for msg in messages:
            _collect(msg)

    has_tools = len(tool_names) > 0
    has_content = bool(content_parts)
    if has_tools and has_content:
        kind = "tools_and_content"
    elif has_tools:
        kind = "tools"
    elif has_content:
        kind = "content"
    else:
        kind = "empty"

    content_preview = "\n\n".join(dict.fromkeys(content_parts))[:500] if content_parts else ""
    return {
        "kind": kind,
        "toolNames": sorted(tool_names),
        "contentPreview": content_preview,
    }


def _summarize_response_for_list(resp: Any) -> dict[str, Any] | None:
    """Lightweight summary of a model response for the list view (no full JSON)."""
    if resp is None:
        return None
    if isinstance(resp, str):
        t = resp.strip()
        if not t:
            return None
        return {"kind": "content", "kind_label_zh": "文本", "kind_label_en": "Text", "tool_names": [], "has_tools": False, "has_content": True, "content_preview": t[:200]}
    if not isinstance(resp, dict):
        return None
    err_msg = extract_response_error_message(resp)
    if err_msg:
        return {"kind": "error", "kind_label_zh": "错误", "kind_label_en": "Error", "tool_names": [], "has_tools": False, "has_content": bool(err_msg), "content_preview": err_msg[:200]}
    tool_names: list[str] = []
    has_tools = False
    has_content = False
    content_preview = ""
    reasoning_parts: list[str] = []

    def _collect(msg: Any) -> None:
        nonlocal has_tools, has_content, content_preview
        msg_body = _unwrap_message_body(msg)
        if msg_body is None:
            return
        c = msg_body.get("content")
        if c is not None:
            txt = _content_to_text(c)
            if txt:
                has_content = True
                if not content_preview:
                    content_preview = txt[:200]
        reasoning = _reasoning_from_message_body(msg_body)
        if reasoning:
            reasoning_parts.append(reasoning)
        for name in _tool_names_from_message_body(msg_body):
            tool_names.append(name)
            has_tools = True

    generations = resp.get("generations")
    if isinstance(generations, list):
        for row in generations:
            gens = row if isinstance(row, list) else [row]
            for g in gens:
                if not isinstance(g, dict):
                    continue
                text = str(g.get("text", "")).strip()
                if text:
                    has_content = True
                    if not content_preview:
                        content_preview = text[:200]
                msg = g.get("message")
                if isinstance(msg, dict):
                    _collect(msg)

    choices = resp.get("choices")
    if isinstance(choices, list):
        for ch in choices:
            if not isinstance(ch, dict):
                continue
            msg = ch.get("message") or ch.get("delta")
            if isinstance(msg, dict):
                _collect(msg)

    messages = resp.get("messages")
    if isinstance(messages, list):
        for msg in messages:
            if isinstance(msg, dict):
                _collect(msg)

    reasoning_text = "\n\n".join(dict.fromkeys(p for p in reasoning_parts if p))
    finish_reason = _finish_reason_from_response_dict(resp)
    if not has_tools and not has_content:
        if reasoning_text and "length" in finish_reason:
            preview = reasoning_text[:200]
            note = (
                "输出 token 已用尽，thinking 被截断，未产生正文。"
                f" [Thinking] {preview}{'…' if len(reasoning_text) > 200 else ''}"
            )
            return {
                "kind": "truncated_thinking",
                "kind_label_zh": "Thinking截断",
                "kind_label_en": "Truncated thinking",
                "tool_names": [],
                "has_tools": False,
                "has_content": False,
                "has_reasoning": True,
                "content_preview": note,
            }
        if reasoning_text:
            preview = reasoning_text[:200]
            return {
                "kind": "reasoning",
                "kind_label_zh": "Thinking",
                "kind_label_en": "Thinking",
                "tool_names": [],
                "has_tools": False,
                "has_content": False,
                "has_reasoning": True,
                "content_preview": f"[Thinking] {preview}{'…' if len(reasoning_text) > 200 else ''}",
            }
        return None

    unique_tools = list(dict.fromkeys(t for t in tool_names if t))
    if has_tools and has_content:
        return {"kind": "tools_and_content", "kind_label_zh": "工具+文本", "kind_label_en": "Tools+text", "tool_names": unique_tools, "has_tools": True, "has_content": True, "content_preview": content_preview}
    if has_tools:
        tool_preview = "调用工具: " + ", ".join(unique_tools[:5])
        if len(unique_tools) > 5:
            tool_preview += f" …共{len(unique_tools)}个"
        return {"kind": "tools", "kind_label_zh": "工具", "kind_label_en": "Tools", "tool_names": unique_tools, "has_tools": True, "has_content": False, "content_preview": tool_preview}
    return {"kind": "content", "kind_label_zh": "文本", "kind_label_en": "Text", "tool_names": [], "has_tools": False, "has_content": True, "content_preview": content_preview}


def _content_to_text(content: Any) -> str:
    """Extract text from a response content field."""
    if content is None:
        return ""
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts: list[str] = []
        for p in content:
            if p is None:
                continue
            if isinstance(p, str):
                parts.append(p)
            elif isinstance(p, dict):
                if p.get("type") == "text" and p.get("text") is not None:
                    parts.append(str(p["text"]))
                elif p.get("text") is not None:
                    parts.append(str(p["text"]))
        return "\n".join(parts).strip()
    if isinstance(content, dict):
        try:
            return json.dumps(content)
        except Exception:
            return str(content)
    return str(content).strip()


def _iso_delta_ms(ts_a: str, ts_b: str) -> float | None:
    """Difference in milliseconds between two ISO timestamps (b - a)."""
    try:
        dt_a = datetime.fromisoformat(ts_a.strip())
        dt_b = datetime.fromisoformat(ts_b.strip())
        if dt_a.tzinfo is None:
            dt_a = dt_a.replace(tzinfo=UTC)
        if dt_b.tzinfo is None:
            dt_b = dt_b.replace(tzinfo=UTC)
        return round((dt_b - dt_a).total_seconds() * 1000.0, 2)
    except (ValueError, TypeError):
        return None


def _enrich_total_cycle_ms(items: list[dict[str, Any]]) -> None:
    """Add ``total_cycle_ms`` to each row: wall-clock from this model call's
    ``requested_at`` to the **next** model call in the same thread.

    Includes model inference (``latency_ms``) + post-model processing +
    tool execution + pre-model middleware of the next cycle — i.e. the full
    "round" duration that was previously invisible in the Requests list.

    ``None`` when this is the last call in the thread (no successor).
    """
    st = _store()
    if st is None:
        return
    conn = st._connection()  # noqa: SLF001
    conn.row_factory = sqlite3.Row
    T = ObservabilityTable
    for row in items:
        if not isinstance(row, dict):
            continue
        tid = str(row.get("thread_id") or "").strip()
        req_ts = str(row.get("requested_at") or "").strip()
        if not tid or not req_ts:
            row["total_cycle_ms"] = None
            continue
        next_row = conn.execute(
            f"SELECT requested_at FROM {T.MODEL_INVOCATIONS} "
            "WHERE thread_id = ? AND requested_at > ? "
            "ORDER BY requested_at ASC LIMIT 1",
            (tid, req_ts),
        ).fetchone()
        if next_row and next_row["requested_at"]:
            row["total_cycle_ms"] = _iso_delta_ms(req_ts, str(next_row["requested_at"]))
        else:
            row["total_cycle_ms"] = None


def list_model_invocations(
    *,
    page: int = 1,
    page_size: int = 20,
    thread_id: str | None = None,
    invocation_kind: str | None = None,
    provider: str | None = None,
    model: str | None = None,
    q: str | None = None,
    status: str | None = None,
    sort_by: str = "requested_at",
    min_latency_ms: float | None = None,
    since_hours: float | None = None,
) -> dict[str, Any]:
    clauses: list[str] = []
    params: list[Any] = []
    if thread_id:
        clauses.append("thread_id = ?")
        params.append(thread_id.strip())
    if invocation_kind:
        clauses.append("invocation_kind = ?")
        params.append(invocation_kind.strip())
    if provider:
        clauses.append("provider = ?")
        params.append(provider.strip())
    if model:
        clauses.append("model LIKE ?")
        params.append(f"%{model.strip()}%")
    if q:
        needle = f"%{q.strip()}%"
        clauses.append("(id LIKE ? OR thread_id LIKE ? OR run_id LIKE ? OR model LIKE ?)")
        params.extend([needle, needle, needle, needle])
    if min_latency_ms is not None:
        try:
            clauses.append("latency_ms >= ?")
            params.append(float(min_latency_ms))
        except (TypeError, ValueError):
            pass
    since = _since_iso(since_hours)
    if since:
        clauses.append("requested_at >= ?")
        params.append(since)
    where = " AND ".join(clauses)
    order = _MODEL_ORDER_BY.get((sort_by or "requested_at").strip(), _MODEL_ORDER_BY["requested_at"])
    out = _paginate(
        ObservabilityTable.MODEL_INVOCATIONS,
        page=max(1, page),
        page_size=min(100, max(1, page_size)),
        where=where,
        params=tuple(params),
        order_by=order,
    )
    if not out.get("enabled"):
        return out
    items = out.get("items")
    if isinstance(items, list):
        for row in items:
            if not isinstance(row, dict):
                continue
            # Payload message count (vendor_request.messages length), not user-turn count.
            # Prefer explicit message_count; tolerate truncated / non-JSON request_json.
            row["message_count"] = _message_count_from_request_raw(row.get("request_json"))
            enrich_model_row_thinking(row)
            if row.get("provider") is not None or row.get("model") is not None:
                row["provider"] = normalize_stored_provider(
                    str(row.get("provider") or "").strip() or None,
                    model=str(row.get("model") or "").strip() or None,
                )
            # Strip large JSON blobs from list — load on demand via detail endpoint
            row.pop("request_json", None)
            # Compute lightweight response_summary before stripping response_json
            resp_raw = row.get("response_json")
            if resp_raw:
                try:
                    resp_obj = json.loads(resp_raw) if isinstance(resp_raw, str) else resp_raw
                    row["response_summary"] = _summarize_response_for_list(resp_obj)
                except (json.JSONDecodeError, TypeError, ValueError):
                    row["response_summary"] = None
            else:
                row["response_summary"] = None
            row.pop("response_json", None)
            row["usage_json"] = _truncate_json_field(row.get("usage_json"))

            raw = row.get("usage_json")
            if raw is None or raw == "":
                row["usage_input_tokens"] = None
                row["usage_output_tokens"] = None
                row["usage_total_tokens"] = None
            else:
                try:
                    u = json.loads(raw) if isinstance(raw, str) else raw
                except (json.JSONDecodeError, TypeError):
                    u = None
                inp, out_t, tot = token_triplet_from_usage_payload(u)
                if inp or out_t or tot:
                    row["usage_input_tokens"] = inp
                    row["usage_output_tokens"] = out_t
                    row["usage_total_tokens"] = tot
                else:
                    row["usage_input_tokens"] = None
                    row["usage_output_tokens"] = None
                    row["usage_total_tokens"] = None
                row.update(compaction_fields_from_usage_payload(u))
                cache = cache_tokens_from_usage_payload(u)
                row["usage_cache_read_tokens"] = cache.get("cache_read_tokens") or row.get("cache_read_tokens")
                row["usage_cache_creation_tokens"] = cache.get("cache_creation_tokens") or row.get(
                    "cache_creation_tokens"
                )
                row["usage_cache_miss_tokens"] = cache.get("cache_miss_tokens") or row.get("cache_miss_tokens")
    if isinstance(items, list):
        from evoflow.observability.cache_metrics import enrich_model_row_cost

        for row in items:
            if isinstance(row, dict):
                enrich_model_row_cost(row)
        _enrich_total_cycle_ms(items)
    if status and isinstance(items, list):
        want = status.strip().lower()
        filtered: list[dict[str, Any]] = []
        for row in items:
            if not isinstance(row, dict):
                continue
            lat = row.get("latency_ms")
            summary = row.get("response_summary")
            row_status = "success"
            if isinstance(summary, dict) and summary.get("kind") == "error":
                row_status = "error"
            elif isinstance(summary, dict) and summary.get("kind") in {"truncated_thinking", "warning"}:
                row_status = "warning"
            elif lat is not None and float(lat) > 60_000:
                row_status = "warning"
            if want in {row_status, "failed" if row_status == "error" else row_status}:
                filtered.append(row)
        out["items"] = filtered
        out["total"] = len(filtered)
    return out


def get_model_invocation_detail(row_id: str) -> dict[str, Any] | None:
    """Fetch a single model invocation row by ID, with full JSON fields."""
    st = _store()
    if st is None:
        return None
    conn = st._connection()  # noqa: SLF001
    conn.row_factory = sqlite3.Row
    row = conn.execute(
        f"SELECT * FROM {ObservabilityTable.MODEL_INVOCATIONS} WHERE id = ?",
        (row_id,),
    ).fetchone()
    if row is None:
        return None
    out = _row_to_dict(conn, row)
    enrich_model_row_thinking(out)
    from evoflow.observability.cache_metrics import enrich_model_row_cost

    enrich_model_row_cost(out)
    # Enrich total_cycle_ms: wall-clock to the next model call in the same thread.
    _enrich_total_cycle_ms([out])
    return out


def list_threads(*, page: int = 1, page_size: int = 20) -> dict[str, Any]:
    return _paginate(
        ObservabilityTable.THREADS,
        page=max(1, page),
        page_size=min(100, max(1, page_size)),
        order_by="last_seen_at DESC",
    )


def thread_timeline(thread_id: str, *, limit: int = 200) -> dict[str, Any]:
    st = _store()
    tid = (thread_id or "").strip()
    if st is None or not tid:
        return {"enabled": False, "items": []}
    conn = st._connection()  # noqa: SLF001
    conn.row_factory = sqlite3.Row
    T = ObservabilityTable
    limit = min(500, max(1, limit))
    events = [
        {**_row_to_dict(conn, r), "kind": "trace"}
        for r in conn.execute(
            f"""
            SELECT id, thread_id, run_id, lane, occurred_at, event, payload_json
            FROM {T.TRACE_EVENTS}
            WHERE thread_id = ?
            ORDER BY occurred_at ASC
            LIMIT ?
            """,
            (tid, limit),
        ).fetchall()
    ]
    tools = [
        {**_row_to_dict(conn, r), "kind": "tool"}
        for r in conn.execute(
            f"""
            SELECT id, thread_id, tool_call_id, tool_name, started_at, ended_at,
                   duration_ms, status, error_type, error_message, invocation_source
            FROM {T.TOOL_INVOCATIONS}
            WHERE thread_id = ? AND {llm_tool_visibility_sql()}
            ORDER BY ended_at ASC
            LIMIT ?
            """,
            (tid, limit),
        ).fetchall()
    ]
    models = [
        {**_row_to_dict(conn, r), "kind": "model"}
        for r in conn.execute(
            f"""
            SELECT id, thread_id, provider, model, stage, invocation_kind, requested_at, latency_ms, trace_id, usage_json, started_at, status
            FROM {T.MODEL_INVOCATIONS}
            WHERE thread_id = ?
            ORDER BY requested_at ASC
            LIMIT ?
            """,
            (tid, limit),
        ).fetchall()
    ]
    merged: list[dict[str, Any]] = []
    for row in events:
        merged.append({"at": row.get("occurred_at"), **row})
    for row in tools:
        merged.append({"at": row.get("ended_at") or row.get("started_at"), **row})
    for row in models:
        item = {"at": row.get("requested_at"), **row}
        raw = row.get("usage_json")
        if raw:
            try:
                u = json.loads(raw) if isinstance(raw, str) else raw
                item.update(compaction_fields_from_usage_payload(u))
            except (json.JSONDecodeError, TypeError):
                pass
        merged.append(item)
    merged.sort(key=lambda x: str(x.get("at") or ""))
    return {"enabled": True, "thread_id": tid, "items": merged[:limit]}


def _slim_tool_row_for_insights(row: dict[str, Any]) -> dict[str, Any]:
    out = str(row.get("output_text") or "")
    em = str(row.get("error_message") or "")
    preview = (em or out)[:500]
    if preview and len(em or out) > 500:
        preview += "…"
    return {
        "id": row.get("id"),
        "thread_id": row.get("thread_id"),
        "tool_name": row.get("tool_name"),
        "tool_call_id": row.get("tool_call_id"),
        "started_at": row.get("started_at"),
        "ended_at": row.get("ended_at"),
        "duration_ms": row.get("duration_ms"),
        "status": row.get("status"),
        "error_type": row.get("error_type"),
        "error_message": row.get("error_message"),
        "output_preview": preview or None,
        "invocation_source": row.get("invocation_source"),
    }


def _slim_model_row_for_insights(row: dict[str, Any]) -> dict[str, Any]:
    raw = row.get("usage_json")
    inp = out_t = tot = None
    u: Any = None
    if raw:
        try:
            u = json.loads(raw) if isinstance(raw, str) else raw
            inp, out_t, tot = token_triplet_from_usage_payload(u)
        except (json.JSONDecodeError, TypeError):
            u = None
    comp = compaction_fields_from_usage_payload(u) if isinstance(u, dict) else {}
    cache = cache_tokens_from_usage_payload(u) if isinstance(u, dict) else {}
    return {
        "id": row.get("id"),
        "thread_id": row.get("thread_id"),
        "provider": normalize_stored_provider(
            str(row.get("provider") or "").strip() or None,
            model=str(row.get("model") or "").strip() or None,
        ),
        "model": row.get("model"),
        "stage": row.get("stage"),
        "invocation_kind": row.get("invocation_kind"),
        "requested_at": row.get("requested_at"),
        "latency_ms": row.get("latency_ms"),
        "first_token_latency_ms": row.get("first_token_latency_ms"),
        "model_call_seq": row.get("model_call_seq"),
        "trace_id": row.get("trace_id"),
        "usage_input_tokens": inp,
        "usage_output_tokens": out_t,
        "usage_total_tokens": tot,
        "usage_cache_read_tokens": cache.get("cache_read_tokens"),
        "usage_cache_creation_tokens": cache.get("cache_creation_tokens"),
        "usage_cache_miss_tokens": cache.get("cache_miss_tokens"),
        **comp,
    }


def fetch_insights(*, limit: int = 10, since_hours: float | None = 24) -> dict[str, Any]:
    """Aggregated rankings for automation / AI assistants (global, all threads)."""
    st = _store()
    lim = min(50, max(1, int(limit or 10)))
    if st is None:
        return {"enabled": False}
    conn = st._connection()  # noqa: SLF001
    conn.row_factory = sqlite3.Row
    T = ObservabilityTable
    since = _since_iso(since_hours)
    tool_since = tool_invocation_and_suffix("ended_at >= ?" if since else None)
    model_since = " AND requested_at >= ?" if since else ""
    tool_params: tuple[Any, ...] = (since,) if since else ()
    model_params: tuple[Any, ...] = (since,) if since else ()

    slow_tools = [
        _slim_tool_row_for_insights(_row_to_dict(conn, r))
        for r in conn.execute(
            f"""
            SELECT * FROM {T.TOOL_INVOCATIONS}
            WHERE duration_ms IS NOT NULL{tool_since}
            ORDER BY duration_ms DESC
            LIMIT ?
            """,
            (*tool_params, lim),
        ).fetchall()
    ]
    tool_errors = [
        _slim_tool_row_for_insights(_row_to_dict(conn, r))
        for r in conn.execute(
            f"""
            SELECT * FROM {T.TOOL_INVOCATIONS}
            WHERE status = 'error'{tool_since}
            ORDER BY ended_at DESC
            LIMIT ?
            """,
            (*tool_params, lim),
        ).fetchall()
    ]
    slow_models = [
        _slim_model_row_for_insights(_row_to_dict(conn, r))
        for r in conn.execute(
            f"""
            SELECT * FROM {T.MODEL_INVOCATIONS}
            WHERE latency_ms IS NOT NULL{model_since}
            ORDER BY latency_ms DESC
            LIMIT ?
            """,
            (*model_params, lim),
        ).fetchall()
    ]
    slow_ttft_models = [
        _slim_model_row_for_insights(_row_to_dict(conn, r))
        for r in conn.execute(
            f"""
            SELECT * FROM {T.MODEL_INVOCATIONS}
            WHERE first_token_latency_ms IS NOT NULL{model_since}
            ORDER BY first_token_latency_ms DESC
            LIMIT ?
            """,
            (*model_params, lim),
        ).fetchall()
    ]
    token_candidates: list[dict[str, Any]] = []
    scan_limit = max(lim * 40, 200)
    for r in conn.execute(
        f"""
        SELECT * FROM {T.MODEL_INVOCATIONS}
        WHERE usage_json IS NOT NULL AND usage_json != ''{model_since}
        ORDER BY requested_at DESC
        LIMIT ?
        """,
        (*model_params, scan_limit),
    ).fetchall():
        row = _slim_model_row_for_insights(_row_to_dict(conn, r))
        if int(row.get("usage_total_tokens") or 0) > 0:
            token_candidates.append(row)
    token_candidates.sort(
        key=lambda x: (int(x.get("usage_total_tokens") or 0), float(x.get("latency_ms") or 0)),
        reverse=True,
    )
    top_token_models = token_candidates[:lim]

    im_errors: list[dict[str, Any]] = []
    im_since = " WHERE occurred_at >= ?" if since else ""
    im_params: tuple[Any, ...] = (since,) if since else ()
    for r in conn.execute(
        f"""
        SELECT id, thread_id, occurred_at, payload_json
        FROM {T.IM_CHANNEL_ERRORS}{im_since}
        ORDER BY occurred_at DESC
        LIMIT ?
        """,
        (*im_params, lim),
    ).fetchall():
        row = _row_to_dict(conn, r)
        payload = row.get("payload_json")
        try:
            row["payload"] = json.loads(payload) if isinstance(payload, str) else payload
        except json.JSONDecodeError:
            row["payload"] = payload
        row.pop("payload_json", None)
        im_errors.append(row)

    overview = fetch_overview(since_hours=since_hours)
    return {
        "enabled": True,
        "schema": "evoflow.observability.insights.v1",
        "generated_at": datetime.now(UTC).isoformat(),
        "since_hours": since_hours,
        "since_iso": since,
        "limit": lim,
        "overview": overview,
        "slowest_tool_invocations": slow_tools,
        "recent_tool_errors": tool_errors,
        "slowest_model_invocations": slow_models,
        "slowest_ttft_model_invocations": slow_ttft_models,
        "highest_token_model_invocations": top_token_models,
        "recent_im_channel_errors": im_errors,
        "query_hints": {
            "tools_by_duration": "/api/observability/tools?sort_by=duration_ms&status=error",
            "models_by_latency": "/api/observability/models?sort_by=latency_ms&min_latency_ms=3000",
            "per_thread_trace": "/api/debug/agent-trace/analysis?thread_id=<uuid>",
            "per_thread_export": "/api/debug/agent-trace/export?thread_id=<uuid>&omit_model_payloads=1",
        },
    }


def thread_insights(thread_id: str, *, limit: int = 10) -> dict[str, Any]:
    """Per-thread rankings (SQLite only)."""
    tid = (thread_id or "").strip()
    lim = min(50, max(1, int(limit or 10)))
    tools = list_tool_invocations(
        thread_id=tid,
        page=1,
        page_size=lim,
        sort_by="duration_ms",
    )
    tool_errors = list_tool_invocations(
        thread_id=tid,
        page=1,
        page_size=lim,
        status="error",
        sort_by="ended_at",
    )
    models = list_model_invocations(
        thread_id=tid,
        page=1,
        page_size=lim,
        sort_by="latency_ms",
    )
    models_by_ttft = list_model_invocations(
        thread_id=tid,
        page=1,
        page_size=lim,
        sort_by="first_token_latency_ms",
    )
    all_models = list_model_invocations(thread_id=tid, page=1, page_size=min(200, lim * 20))
    token_rows = [r for r in (all_models.get("items") or []) if isinstance(r, dict) and int(r.get("usage_total_tokens") or 0) > 0]
    token_rows.sort(key=lambda x: int(x.get("usage_total_tokens") or 0), reverse=True)
    return {
        "enabled": True,
        "schema": "evoflow.observability.thread_insights.v1",
        "thread_id": tid,
        "limit": lim,
        "slowest_tool_invocations": [_slim_tool_row_for_insights(r) for r in (tools.get("items") or [])[:lim] if isinstance(r, dict)],
        "recent_tool_errors": [_slim_tool_row_for_insights(r) for r in (tool_errors.get("items") or [])[:lim] if isinstance(r, dict)],
        "slowest_model_invocations": [_slim_model_row_for_insights(r) for r in (models.get("items") or [])[:lim] if isinstance(r, dict)],
        "slowest_ttft_model_invocations": [_slim_model_row_for_insights(r) for r in (models_by_ttft.get("items") or [])[:lim] if isinstance(r, dict)],
        "highest_token_model_invocations": [_slim_model_row_for_insights(r) for r in token_rows[:lim] if isinstance(r, dict)],
    }


def fetch_errors_summary(*, since_hours: float | None = 168) -> dict[str, Any]:
    """Grouped tool errors and model latency by invocation_kind."""
    st = _store()
    if st is None:
        return {"enabled": False}
    conn = st._connection()  # noqa: SLF001
    conn.row_factory = sqlite3.Row
    T = ObservabilityTable
    since = _since_iso(since_hours)
    tool_w = tool_invocation_where("status = 'error'", "ended_at >= ?" if since else None)
    tool_p: tuple[Any, ...] = (since,) if since else ()
    model_w = " WHERE 1=1" + (" AND requested_at >= ?" if since else "")
    model_p: tuple[Any, ...] = (since,) if since else ()

    by_error_type = [
        _row_to_dict(conn, r)
        for r in conn.execute(
            f"""
            SELECT COALESCE(NULLIF(TRIM(error_type), ''), '—') AS error_type,
                   COUNT(*) AS count
            FROM {T.TOOL_INVOCATIONS}{tool_w}
            GROUP BY error_type
            ORDER BY count DESC
            LIMIT 30
            """,
            tool_p,
        ).fetchall()
    ]
    by_tool_name = [
        _row_to_dict(conn, r)
        for r in conn.execute(
            f"""
            SELECT tool_name,
                   COUNT(*) AS error_count,
                   COALESCE(NULLIF(TRIM(error_type), ''), '—') AS top_error_type
            FROM {T.TOOL_INVOCATIONS}{tool_w}
            GROUP BY tool_name
            ORDER BY error_count DESC
            LIMIT 30
            """,
            tool_p,
        ).fetchall()
    ]
    model_by_kind = [
        _row_to_dict(conn, r)
        for r in conn.execute(
            f"""
            SELECT COALESCE(NULLIF(TRIM(invocation_kind), ''), 'main') AS invocation_kind,
                   COUNT(*) AS call_count,
                   AVG(latency_ms) AS avg_latency_ms,
                   MAX(latency_ms) AS max_latency_ms
            FROM {T.MODEL_INVOCATIONS}{model_w}
            GROUP BY invocation_kind
            ORDER BY avg_latency_ms DESC
            """,
            model_p,
        ).fetchall()
    ]
    return {
        "enabled": True,
        "since_hours": since_hours,
        "since_iso": since,
        "by_error_type": by_error_type,
        "by_tool_name": by_tool_name,
        "model_by_kind": model_by_kind,
    }


def fetch_trends(*, days: int = 7, since_hours: float | None = None) -> dict[str, Any]:
    """Daily buckets for tool/model volume and errors (AI trend charts)."""
    st = _store()
    if st is None:
        return {"enabled": False}
    conn = st._connection()  # noqa: SLF001
    conn.row_factory = sqlite3.Row
    T = ObservabilityTable
    d = min(90, max(1, int(days or 7)))
    if since_hours is not None:
        since = _since_iso(since_hours)
    else:
        since = (datetime.now(UTC) - timedelta(days=d)).isoformat().replace("+00:00", "Z")
    tool_p = (since,)
    model_p = (since,)

    tool_daily = [
        _row_to_dict(conn, r)
        for r in conn.execute(
            f"""
            SELECT substr(ended_at, 1, 10) AS day,
                   COUNT(*) AS tool_calls,
                   SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS tool_errors,
                   AVG(duration_ms) AS avg_duration_ms,
                   MAX(duration_ms) AS max_duration_ms
            FROM {T.TOOL_INVOCATIONS}
            {tool_invocation_where("ended_at >= ?")}
            GROUP BY day
            ORDER BY day ASC
            """,
            tool_p,
        ).fetchall()
    ]
    model_daily = [
        _row_to_dict(conn, r)
        for r in conn.execute(
            f"""
            SELECT substr(requested_at, 1, 10) AS day,
                   COUNT(*) AS model_calls,
                   AVG(latency_ms) AS avg_latency_ms,
                   MAX(latency_ms) AS max_latency_ms
            FROM {T.MODEL_INVOCATIONS}
            WHERE requested_at >= ?
            GROUP BY day
            ORDER BY day ASC
            """,
            model_p,
        ).fetchall()
    ]
    return {
        "enabled": True,
        "days": d,
        "since_iso": since,
        "tool_daily": tool_daily,
        "model_daily": model_daily,
    }


def empty_thread_observability_metrics() -> dict[str, Any]:
    return {
        "model_invocations": 0,
        "tool_invocations": 0,
        "tool_errors": 0,
        "run_count": 0,
        "tokens": {"input": 0, "output": 0, "total": 0},
        "primary_model": None,
        "models_used": [],
        "avg_model_latency_ms": None,
        "avg_tool_duration_ms": None,
    }


def fetch_observability_breakdown_by_thread(
    thread_ids: list[str],
    *,
    since_hours: float | None = None,
) -> dict[str, dict[str, Any]]:
    """Per-thread model/tool/token metrics keyed by ``thread_id``."""
    ids = [str(t).strip() for t in (thread_ids or []) if str(t).strip()]
    out: dict[str, dict[str, Any]] = {tid: empty_thread_observability_metrics() for tid in ids}
    if not ids:
        return out

    st = _store()
    if st is None:
        return out

    conn = st._connection()  # noqa: SLF001
    conn.row_factory = sqlite3.Row
    T = ObservabilityTable
    since = _since_iso(since_hours)
    placeholders = ",".join("?" * len(ids))
    model_time_clause = " AND requested_at >= ?" if since else ""
    tool_time_clause = tool_invocation_and_suffix("ended_at >= ?" if since else None)
    run_time_clause = " AND started_at >= ?" if since else ""
    time_params: tuple[Any, ...] = (since,) if since else ()

    for row in conn.execute(
        f"""
        SELECT thread_id, COUNT(*) AS n, AVG(latency_ms) AS avg_latency
        FROM {T.MODEL_INVOCATIONS}
        WHERE thread_id IN ({placeholders}){model_time_clause}
        GROUP BY thread_id
        """,
        (*ids, *time_params),
    ).fetchall():
        tid = str(row["thread_id"] or "").strip()
        if tid not in out:
            continue
        out[tid]["model_invocations"] = int(row["n"] or 0)
        if row["avg_latency"] is not None:
            out[tid]["avg_model_latency_ms"] = round(float(row["avg_latency"]), 2)

    for row in conn.execute(
        f"""
        SELECT thread_id,
               COUNT(*) AS n,
               SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
               AVG(duration_ms) AS avg_duration
        FROM {T.TOOL_INVOCATIONS}
        WHERE thread_id IN ({placeholders}){tool_time_clause}
        GROUP BY thread_id
        """,
        (*ids, *time_params),
    ).fetchall():
        tid = str(row["thread_id"] or "").strip()
        if tid not in out:
            continue
        out[tid]["tool_invocations"] = int(row["n"] or 0)
        out[tid]["tool_errors"] = int(row["errors"] or 0)
        if row["avg_duration"] is not None:
            out[tid]["avg_tool_duration_ms"] = round(float(row["avg_duration"]), 2)

    for row in conn.execute(
        f"""
        SELECT thread_id, COUNT(*) AS n
        FROM {T.RUNS}
        WHERE thread_id IN ({placeholders}){run_time_clause}
        GROUP BY thread_id
        """,
        (*ids, *time_params),
    ).fetchall():
        tid = str(row["thread_id"] or "").strip()
        if tid in out:
            out[tid]["run_count"] = int(row["n"] or 0)

    usage_rows = conn.execute(
        f"""
        SELECT thread_id, model, provider, usage_json
        FROM {T.MODEL_INVOCATIONS}
        WHERE thread_id IN ({placeholders})
          AND usage_json IS NOT NULL AND usage_json != ''{model_time_clause}
        """,
        (*ids, *time_params),
    ).fetchall()

    per_thread_models: dict[str, dict[str, dict[str, Any]]] = {tid: {} for tid in ids}
    for row in usage_rows:
        tid = str(row["thread_id"] or "").strip()
        if tid not in out:
            continue
        model_key = str(row["model"] or "").strip() or "—"
        provider = normalize_stored_provider(
            str(row["provider"] or "").strip() or None,
            model=model_key,
        )
        stat_key = f"{provider or ''}:{model_key}"
        bucket = per_thread_models[tid]
        if stat_key not in bucket:
            bucket[stat_key] = {
                "model": model_key,
                "provider": provider,
                "invocations": 0,
                "input_tokens": 0,
                "output_tokens": 0,
                "total_tokens": 0,
            }
        bucket[stat_key]["invocations"] += 1
        try:
            u = json.loads(row["usage_json"]) if isinstance(row["usage_json"], str) else row["usage_json"]
            inp, out_t, tot = token_triplet_from_usage_payload(u)
            out[tid]["tokens"]["input"] += inp
            out[tid]["tokens"]["output"] += out_t
            out[tid]["tokens"]["total"] += tot
            bucket[stat_key]["input_tokens"] += inp
            bucket[stat_key]["output_tokens"] += out_t
            bucket[stat_key]["total_tokens"] += tot
        except (json.JSONDecodeError, TypeError, ValueError):
            continue

    for tid in ids:
        models = sorted(
            per_thread_models[tid].values(),
            key=lambda r: (int(r.get("total_tokens") or 0), int(r.get("invocations") or 0)),
            reverse=True,
        )
        out[tid]["models_used"] = models
        out[tid]["primary_model"] = models[0]["model"] if models else None

    return out


def fetch_task_observability_metrics(
    thread_ids: list[str],
    *,
    main_task_id: str | None = None,
    since_hours: float | None = None,
    by_thread: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Aggregate model/tool/run/lifecycle metrics for a set of collab thread ids."""
    st = _store()
    if st is None:
        return {"enabled": False, "error": "observability_unavailable"}

    ids = [str(t).strip() for t in (thread_ids or []) if str(t).strip()]
    since_iso = _since_iso(since_hours)
    if not ids:
        return {
            "enabled": True,
            "schema": "evoflow.task_observability.v1",
            "since_hours": since_hours,
            "since_iso": since_iso,
            "model_invocations": 0,
            "tool_invocations": 0,
            "tool_errors": 0,
            "tool_error_rate": 0.0,
            "run_count": 0,
            "lifecycle_events": 0,
            "tokens": {"input": 0, "output": 0, "total": 0},
            "models_used": [],
            "primary_model": None,
            "avg_model_latency_ms": None,
            "avg_model_ttft_ms": None,
            "avg_tool_duration_ms": None,
            "lifecycle_by_event": [],
        }

    breakdown = by_thread if by_thread is not None else fetch_observability_breakdown_by_thread(ids, since_hours=since_hours)

    total_tokens = {"input": 0, "output": 0, "total": 0}
    model_stats: dict[str, dict[str, Any]] = {}
    n_model = 0
    n_tool = 0
    n_tool_err = 0
    n_runs = 0
    lat_sum = 0.0
    lat_n = 0
    tool_dur_sum = 0.0
    tool_dur_n = 0

    for row in breakdown.values():
        n_model += int(row.get("model_invocations") or 0)
        n_tool += int(row.get("tool_invocations") or 0)
        n_tool_err += int(row.get("tool_errors") or 0)
        n_runs += int(row.get("run_count") or 0)
        tok = row.get("tokens") if isinstance(row.get("tokens"), dict) else {}
        total_tokens["input"] += int(tok.get("input") or 0)
        total_tokens["output"] += int(tok.get("output") or 0)
        total_tokens["total"] += int(tok.get("total") or 0)
        mi = int(row.get("model_invocations") or 0)
        if row.get("avg_model_latency_ms") is not None and mi > 0:
            lat_sum += float(row["avg_model_latency_ms"]) * mi
            lat_n += mi
        ti = int(row.get("tool_invocations") or 0)
        if row.get("avg_tool_duration_ms") is not None and ti > 0:
            tool_dur_sum += float(row["avg_tool_duration_ms"]) * ti
            tool_dur_n += ti
        for m in row.get("models_used") or []:
            if not isinstance(m, dict):
                continue
            model_key = str(m.get("model") or "").strip() or "—"
            provider = m.get("provider")
            stat_key = f"{provider or ''}:{model_key}"
            if stat_key not in model_stats:
                model_stats[stat_key] = {
                    "model": model_key,
                    "provider": provider,
                    "invocations": 0,
                    "input_tokens": 0,
                    "output_tokens": 0,
                    "total_tokens": 0,
                }
            model_stats[stat_key]["invocations"] += int(m.get("invocations") or 0)
            model_stats[stat_key]["input_tokens"] += int(m.get("input_tokens") or 0)
            model_stats[stat_key]["output_tokens"] += int(m.get("output_tokens") or 0)
            model_stats[stat_key]["total_tokens"] += int(m.get("total_tokens") or 0)

    models_used = sorted(
        model_stats.values(),
        key=lambda r: (int(r.get("total_tokens") or 0), int(r.get("invocations") or 0)),
        reverse=True,
    )

    lifecycle_by_event: list[dict[str, Any]] = []
    lifecycle_total = 0
    mid = str(main_task_id or "").strip()
    if mid:
        conn = st._connection()  # noqa: SLF001
        conn.row_factory = sqlite3.Row
        T = ObservabilityTable
        since = since_iso
        lc_clause = " AND occurred_at >= ?" if since else ""
        lc_params: tuple[Any, ...] = (mid, *((since,) if since else ()))
        lifecycle_rows = conn.execute(
            f"""
            SELECT event, COUNT(*) AS count
            FROM {T.TASK_LIFECYCLE_EVENTS}
            WHERE main_task_id = ?{lc_clause}
            GROUP BY event
            ORDER BY count DESC
            """,
            lc_params,
        ).fetchall()
        lifecycle_by_event = [_row_to_dict(conn, r) for r in lifecycle_rows]
        lifecycle_total = sum(int(r.get("count") or 0) for r in lifecycle_by_event)

    return {
        "enabled": True,
        "schema": "evoflow.task_observability.v1",
        "since_hours": since_hours,
        "since_iso": since_iso,
        "model_invocations": n_model,
        "tool_invocations": n_tool,
        "tool_errors": n_tool_err,
        "tool_error_rate": round(n_tool_err / n_tool, 4) if n_tool else 0.0,
        "run_count": n_runs,
        "lifecycle_events": lifecycle_total,
        "lifecycle_by_event": lifecycle_by_event,
        "tokens": total_tokens,
        "models_used": models_used,
        "primary_model": models_used[0]["model"] if models_used else None,
        "avg_model_latency_ms": round(lat_sum / lat_n, 2) if lat_n else None,
        "avg_model_ttft_ms": None,
        "avg_tool_duration_ms": round(tool_dur_sum / tool_dur_n, 2) if tool_dur_n else None,
    }
