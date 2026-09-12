"""Aggregated observability dashboard bundle for EvoPanel."""

from __future__ import annotations

import json
import sqlite3
from collections import Counter
from datetime import UTC, datetime, timedelta
from typing import Any

from evoflow.observability.queries import (
    ObservabilityTable,
    _percentile,
    _row_to_dict,
    _since_iso,
    _store,
    list_model_invocations,
    token_triplet_from_usage_payload,
)
from evoflow.observability.cache_metrics import aggregate_cache_metrics, cache_triplet_from_row, compute_cache_hit_rate
from evoflow.observability.provider_labels import normalize_stored_provider
from evoflow.observability.summaries import _infer_row_status, _response_has_error, enrich_recent_request_row
from evoflow.observability.tool_filters import llm_tool_visibility_sql


def dashboard_pct_delta(current: float, previous: float) -> float | None:
    """Relative change; None when both are zero."""
    if previous == 0:
        if current == 0:
            return None
        return 1.0
    return round((current - previous) / previous, 4)


def dashboard_pts_delta(current: float, previous: float) -> float | None:
    return round(current - previous, 4)


def bucket_thread_health_scores(scores: list[float]) -> dict[str, Any]:
    normal = warning = error = 0
    for raw in scores:
        s = float(raw)
        if s >= 80:
            normal += 1
        elif s >= 50:
            warning += 1
        else:
            error += 1
    total = normal + warning + error
    healthy_pct = round(normal / total, 4) if total else 0.0
    return {
        "healthy_pct": healthy_pct,
        "normal": normal,
        "warning": warning,
        "error": error,
        "total": total,
    }


def build_request_trends(
    model_daily: list[dict[str, Any]],
    tool_daily: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    tool_err_by_day = {str(r.get("day") or ""): int(r.get("tool_errors") or 0) for r in tool_daily}
    out: list[dict[str, Any]] = []
    for row in model_daily:
        day = str(row.get("day") or "")
        total = int(row.get("model_calls") or 0)
        failed = min(total, tool_err_by_day.get(day, 0))
        success = max(0, total - failed)
        out.append({"day": day, "total": total, "success": success, "failed": failed})
    return out


def _time_filter(column: str, since_iso: str | None, until_iso: str | None) -> tuple[str, list[Any]]:
    parts: list[str] = []
    params: list[Any] = []
    if since_iso:
        parts.append(f"{column} >= ?")
        params.append(since_iso)
    if until_iso:
        parts.append(f"{column} < ?")
        params.append(until_iso)
    if not parts:
        return "", []
    return " AND ".join(parts), params


def _model_kind_filter(agent_filter: str | None) -> tuple[str, list[Any]]:
    if not agent_filter or agent_filter in ("all", ""):
        return "", []
    return " AND COALESCE(NULLIF(TRIM(invocation_kind), ''), 'main') = ?", [agent_filter.strip()]


def _aggregate_window_metrics(
    conn: sqlite3.Connection,
    *,
    since_iso: str | None,
    until_iso: str | None,
    agent_filter: str | None,
) -> dict[str, Any]:
    T = ObservabilityTable
    time_clause, time_params = _time_filter("requested_at", since_iso, until_iso)
    kind_clause, kind_params = _model_kind_filter(agent_filter)
    where = ""
    params: list[Any] = []
    if time_clause or kind_clause:
        clauses = [c for c in (time_clause, kind_clause.lstrip(" AND ") if kind_clause else "") if c]
        where = " WHERE " + " AND ".join(clauses)
        params = [*time_params, *kind_params]

    model_row = conn.execute(
        f"""
        SELECT COUNT(*) AS n, AVG(latency_ms) AS avg_latency
        FROM {T.MODEL_INVOCATIONS}{where}
        """,
        tuple(params),
    ).fetchone()

    latencies = [
        float(r[0])
        for r in conn.execute(
            f"SELECT latency_ms FROM {T.MODEL_INVOCATIONS} WHERE latency_ms IS NOT NULL"
            + (f" AND {time_clause}" if time_clause else "")
            + (kind_clause if kind_clause else ""),
            tuple(params),
        ).fetchall()
        if r[0] is not None
    ]

    tool_time_clause, tool_time_params = _time_filter("ended_at", since_iso, until_iso)
    tool_where = f" WHERE {llm_tool_visibility_sql()}" + (f" AND {tool_time_clause}" if tool_time_clause else "")
    tool_row = conn.execute(
        f"""
        SELECT COUNT(*) AS n,
               SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors
        FROM {T.TOOL_INVOCATIONS}{tool_where}
        """,
        tuple(tool_time_params),
    ).fetchone()

    total_tokens = 0
    usage_sql = f"SELECT usage_json FROM {T.MODEL_INVOCATIONS}{where}"
    for (usage_json,) in conn.execute(usage_sql, tuple(params)).fetchall():
        try:
            u = json.loads(usage_json) if isinstance(usage_json, str) else usage_json
            _, _, tot = token_triplet_from_usage_payload(u)
            total_tokens += tot
        except (json.JSONDecodeError, TypeError, ValueError):
            continue

    n_model = int(model_row[0] or 0)
    n_tool = int(tool_row[0] or 0)
    n_tool_err = int(tool_row[1] or 0)
    denom = max(n_model, n_tool, 1)
    success_rate = round(1.0 - (n_tool_err / denom), 4) if denom else 1.0

    return {
        "total_requests": n_model,
        "success_rate": success_rate,
        "avg_latency_ms": round(float(model_row[1] or 0), 2) if model_row[1] else 0.0,
        "total_tokens": total_tokens,
        "tool_calls": n_tool,
        "tool_errors": n_tool_err,
        "latency_p95_ms": _percentile(latencies, 95),
    }


def _fetch_token_daily(
    conn: sqlite3.Connection,
    since_iso: str,
    agent_filter: str | None,
) -> list[dict[str, Any]]:
    T = ObservabilityTable
    kind_clause, kind_params = _model_kind_filter(agent_filter)
    rows = conn.execute(
        f"""
        SELECT substr(requested_at, 1, 10) AS day, usage_json,
               cache_read_tokens, cache_creation_tokens, cache_miss_tokens
        FROM {T.MODEL_INVOCATIONS}
        WHERE requested_at >= ?{kind_clause}
        ORDER BY day ASC
        """,
        (since_iso, *kind_params),
    ).fetchall()
    by_day: dict[str, dict[str, int]] = {}
    for day, usage_json, cache_read, cache_create, cache_miss in rows:
        day_key = str(day or "")
        if day_key not in by_day:
            by_day[day_key] = {
                "prompt_tokens": 0,
                "completion_tokens": 0,
                "total_tokens": 0,
                "cache_read_tokens": 0,
                "cache_creation_tokens": 0,
                "cache_miss_tokens": 0,
            }
        try:
            u = json.loads(usage_json) if isinstance(usage_json, str) else usage_json
            inp, out, tot = token_triplet_from_usage_payload(u)
        except (json.JSONDecodeError, TypeError, ValueError):
            inp, out, tot = 0, 0, 0
        read, create, miss = cache_triplet_from_row(
            cache_read=cache_read,
            cache_create=cache_create,
            cache_miss=cache_miss,
            usage_json=usage_json,
        )
        by_day[day_key]["prompt_tokens"] += inp
        by_day[day_key]["completion_tokens"] += out
        by_day[day_key]["total_tokens"] += tot
        by_day[day_key]["cache_read_tokens"] += read
        by_day[day_key]["cache_creation_tokens"] += create
        by_day[day_key]["cache_miss_tokens"] += miss
    out: list[dict[str, Any]] = []
    for day, vals in sorted(by_day.items()):
        hit_rate = compute_cache_hit_rate(
            vals["cache_read_tokens"],
            vals["cache_miss_tokens"],
            vals["cache_creation_tokens"],
        )
        out.append(
            {
                "day": day,
                "cost_usd": None,
                "cache_hit_rate": hit_rate,
                "cache_hit_rate_pct": round(hit_rate * 100, 1) if hit_rate is not None else None,
                **vals,
            }
        )
    return out


def _fetch_model_ranking(
    conn: sqlite3.Connection,
    since_iso: str | None,
    agent_filter: str | None,
) -> list[dict[str, Any]]:
    T = ObservabilityTable
    clauses = []
    params: list[Any] = []
    if since_iso:
        clauses.append("requested_at >= ?")
        params.append(since_iso)
    kind_clause, kind_params = _model_kind_filter(agent_filter)
    if kind_clause:
        clauses.append(kind_clause.lstrip(" AND "))
        params.extend(kind_params)
    where = f" WHERE {' AND '.join(clauses)}" if clauses else ""

    by_model: dict[str, dict[str, Any]] = {}
    for model, provider, latency_ms, usage_json, response_json, cache_read, cache_create, cache_miss in conn.execute(
        f"""
        SELECT model, provider, latency_ms, usage_json, response_json,
               cache_read_tokens, cache_creation_tokens, cache_miss_tokens
        FROM {T.MODEL_INVOCATIONS}{where}
        """,
        tuple(params),
    ).fetchall():
        key = str(model or "").strip() or "—"
        prov = normalize_stored_provider(str(provider or "").strip() or None, model=key)
        if key not in by_model:
            by_model[key] = {
                "model": key,
                "provider": prov or "—",
                "requests": 0,
                "tokens": 0,
                "cache_read_tokens": 0,
                "cache_creation_tokens": 0,
                "cache_miss_tokens": 0,
                "errors": 0,
                "latencies": [],
                "cost_usd": None,
            }
        by_model[key]["requests"] += 1
        if latency_ms is not None:
            by_model[key]["latencies"].append(float(latency_ms))
        if _response_has_error(response_json):
            by_model[key]["errors"] += 1
        if prov and by_model[key]["provider"] == "—":
            by_model[key]["provider"] = prov
        read, create, miss = cache_triplet_from_row(
            cache_read=cache_read,
            cache_create=cache_create,
            cache_miss=cache_miss,
            usage_json=usage_json,
        )
        by_model[key]["cache_read_tokens"] += read
        by_model[key]["cache_creation_tokens"] += create
        by_model[key]["cache_miss_tokens"] += miss
        try:
            u = json.loads(usage_json) if isinstance(usage_json, str) else usage_json
            _, _, tot = token_triplet_from_usage_payload(u)
            by_model[key]["tokens"] += tot
        except (json.JSONDecodeError, TypeError, ValueError):
            pass

    ranked: list[dict[str, Any]] = []
    for entry in by_model.values():
        reqs = entry["requests"]
        err_rate = round(entry["errors"] / reqs, 4) if reqs else 0.0
        latencies = entry["latencies"]
        hit_rate = compute_cache_hit_rate(
            entry["cache_read_tokens"],
            entry["cache_miss_tokens"],
            entry["cache_creation_tokens"],
        )
        ranked.append(
            {
                "model": entry["model"],
                "provider": entry["provider"],
                "requests": reqs,
                "tokens": entry["tokens"],
                "cache_read_tokens": entry["cache_read_tokens"],
                "cache_creation_tokens": entry["cache_creation_tokens"],
                "cache_miss_tokens": entry["cache_miss_tokens"],
                "cache_hit_rate": hit_rate,
                "cache_hit_rate_pct": round(hit_rate * 100, 1) if hit_rate is not None else None,
                "cost_usd": None,
                "avg_latency_ms": round(sum(latencies) / len(latencies), 2) if latencies else 0.0,
                "error_rate": err_rate,
            }
        )
    return sorted(ranked, key=lambda r: (r["tokens"], r["requests"]), reverse=True)[:10]


def _default_since_iso(hours: float | None) -> str:
    """Bound unbounded dashboard queries (``since_hours=None`` → last 90d)."""
    explicit = _since_iso(hours)
    if explicit:
        return explicit
    return (datetime.now(UTC) - timedelta(days=90)).isoformat().replace("+00:00", "Z")


def _fetch_agents_summary_on_conn(
    conn: sqlite3.Connection,
    *,
    since_iso: str | None,
    agent_filter: str | None,
) -> list[dict[str, Any]]:
    T = ObservabilityTable
    time_sql = ""
    time_params: list[Any] = []
    if since_iso:
        time_sql = " AND requested_at >= ?"
        time_params.append(since_iso)
    kind_sql, kind_params = _model_kind_filter(agent_filter)

    rows = conn.execute(
        f"""
        SELECT COALESCE(NULLIF(TRIM(invocation_kind), ''), 'main') AS kind,
               model, latency_ms, usage_json, response_json
        FROM {T.MODEL_INVOCATIONS}
        WHERE 1=1{time_sql}{kind_sql}
        """,
        (*time_params, *kind_params),
    ).fetchall()

    by_kind: dict[str, dict[str, Any]] = {}
    for row in rows:
        kind = str(row["kind"] or "main")
        if kind not in by_kind:
            by_kind[kind] = {
                "requests": 0,
                "errors": 0,
                "latencies": [],
                "tokens": 0,
                "models": Counter(),
            }
        entry = by_kind[kind]
        entry["requests"] += 1
        lat = row["latency_ms"]
        if lat is not None:
            entry["latencies"].append(float(lat))
        if _infer_row_status(response_json=row["response_json"], latency_ms=float(lat) if lat else None) == "error":
            entry["errors"] += 1
        try:
            u = json.loads(row["usage_json"]) if isinstance(row["usage_json"], str) else row["usage_json"]
            _, _, tot = token_triplet_from_usage_payload(u)
            entry["tokens"] += tot
        except (json.JSONDecodeError, TypeError, ValueError):
            pass
        model_name = str(row["model"] or "").strip()
        if model_name:
            entry["models"][model_name] += 1

    items: list[dict[str, Any]] = []
    for kind, entry in sorted(by_kind.items(), key=lambda kv: kv[1]["requests"], reverse=True):
        reqs = entry["requests"]
        err = entry["errors"]
        success_rate = round(100.0 * (1.0 - err / reqs), 1) if reqs else 100.0
        avg_lat = round(sum(entry["latencies"]) / len(entry["latencies"]), 2) if entry["latencies"] else 0.0
        main_model = entry["models"].most_common(1)[0][0] if entry["models"] else "—"
        if success_rate >= 95:
            status = "normal"
        elif success_rate >= 85:
            status = "warning"
        else:
            status = "error"
        items.append(
            {
                "name": kind,
                "status": status,
                "requests": reqs,
                "success_rate": success_rate,
                "avg_latency_ms": avg_lat,
                "tokens": entry["tokens"],
                "main_model": main_model,
                "tools": 0,
                "owner": "—",
            }
        )
    return items


def _normalize_hours(since_hours: float | None) -> float | None:
    if since_hours is None:
        return None
    try:
        h = float(since_hours)
    except (TypeError, ValueError):
        return 168.0
    if h <= 0:
        return None
    return h


def _infer_request_status(tool_errors: int, latency_ms: float | None, *, response_json: Any = None) -> str:
    if _response_has_error(response_json):
        return "error"
    if tool_errors > 0:
        return "error"
    if latency_ms is not None and latency_ms > 60_000:
        return "warning"
    return "success"


def _build_recent_requests(
    since_hours: float | None,
    agent_filter: str | None,
) -> list[dict[str, Any]]:
    inv_kind = None if not agent_filter or agent_filter == "all" else agent_filter
    page = list_model_invocations(
        page=1,
        page_size=20,
        since_hours=since_hours if since_hours and since_hours > 0 else None,
        invocation_kind=inv_kind,
        sort_by="requested_at",
    )
    items = page.get("items") if isinstance(page.get("items"), list) else []
    out: list[dict[str, Any]] = []
    for row in items:
        if not isinstance(row, dict):
            continue
        out.append(enrich_recent_request_row(row))
    return out


def _fetch_recent_tool_errors(
    conn: sqlite3.Connection,
    since_iso: str | None,
    *,
    limit: int = 5,
) -> list[dict[str, Any]]:
    T = ObservabilityTable
    time_clause, time_params = _time_filter("ended_at", since_iso, None)
    extra = f" AND {time_clause}" if time_clause else ""
    rows = conn.execute(
        f"""
        SELECT tool_name, error_type, error_message, ended_at, thread_id, duration_ms
        FROM {T.TOOL_INVOCATIONS}
        WHERE {llm_tool_visibility_sql()} AND status = 'error'{extra}
        ORDER BY ended_at DESC
        LIMIT ?
        """,
        (*time_params, limit),
    ).fetchall()
    return [_row_to_dict(conn, r) for r in rows]


def fetch_dashboard_bundle(
    *,
    since_hours: float | None = 168,
    agent_filter: str | None = "all",
) -> dict[str, Any]:
    st = _store()
    if st is None:
        return {"enabled": False}

    conn = st._connection()  # noqa: SLF001
    conn.row_factory = sqlite3.Row
    T = ObservabilityTable

    hours = _normalize_hours(since_hours)
    since_iso = _since_iso(hours)
    kpi_since_iso = _default_since_iso(hours)
    if hours is None:
        previous_until_iso = None
        previous_since_iso = None
    else:
        previous_until_iso = since_iso
        previous_since_iso = (datetime.now(UTC) - timedelta(hours=hours * 2)).isoformat().replace("+00:00", "Z")

    current = _aggregate_window_metrics(
        conn, since_iso=kpi_since_iso, until_iso=None, agent_filter=agent_filter
    )
    if hours is None:
        previous = {"total_requests": 0, "success_rate": 0, "avg_latency_ms": 0, "total_tokens": 0}
        deltas = {
            "total_requests_pct": None,
            "success_rate_pts": None,
            "avg_latency_ms_pct": None,
            "total_tokens_pct": None,
        }
    else:
        previous = _aggregate_window_metrics(
            conn, since_iso=previous_since_iso, until_iso=previous_until_iso, agent_filter=agent_filter
        )
        deltas = {
            "total_requests_pct": dashboard_pct_delta(float(current["total_requests"]), float(previous["total_requests"])),
            "success_rate_pts": dashboard_pts_delta(float(current["success_rate"]), float(previous["success_rate"])),
            "avg_latency_ms_pct": dashboard_pct_delta(float(current["avg_latency_ms"]), float(previous["avg_latency_ms"])),
            "total_tokens_pct": dashboard_pct_delta(float(current["total_tokens"]), float(previous["total_tokens"])),
        }

    trend_since = since_iso or kpi_since_iso
    kind_clause, kind_params = _model_kind_filter(agent_filter)
    model_daily = [
        _row_to_dict(conn, r)
        for r in conn.execute(
            f"""
            SELECT substr(requested_at, 1, 10) AS day, COUNT(*) AS model_calls
            FROM {T.MODEL_INVOCATIONS}
            WHERE requested_at >= ?{kind_clause}
            GROUP BY day ORDER BY day ASC
            """,
            (trend_since, *kind_params),
        ).fetchall()
    ]
    tool_daily = [
        _row_to_dict(conn, r)
        for r in conn.execute(
            f"""
            SELECT substr(ended_at, 1, 10) AS day,
                   COUNT(*) AS tool_calls,
                   SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS tool_errors
            FROM {T.TOOL_INVOCATIONS}
            WHERE {llm_tool_visibility_sql()} AND ended_at >= ?
            GROUP BY day ORDER BY day ASC
            """,
            (trend_since,),
        ).fetchall()
    ]

    request_trends = build_request_trends(model_daily, tool_daily)
    spark_requests = [{"day": r["day"], "value": r["total"]} for r in request_trends[-14:]]
    spark_success = [
        {"day": r["day"], "value": round(r["success"] / r["total"], 4) if r["total"] else 0}
        for r in request_trends[-14:]
    ]
    spark_latency = [
        _row_to_dict(conn, r)
        for r in conn.execute(
            f"""
            SELECT substr(requested_at, 1, 10) AS day, AVG(latency_ms) AS value
            FROM {T.MODEL_INVOCATIONS}
            WHERE requested_at >= ? AND latency_ms IS NOT NULL{kind_clause}
            GROUP BY day ORDER BY day ASC
            """,
            (trend_since, *kind_params),
        ).fetchall()
    ][-14:]
    token_daily = _fetch_token_daily(conn, trend_since, agent_filter)
    spark_tokens = [{"day": r["day"], "value": r["total_tokens"]} for r in token_daily[-14:]]

    n_req = max(int(current["total_requests"]), 1)
    avg_tokens_per_request = round(float(current["total_tokens"]) / n_req, 2)
    agents_items = _fetch_agents_summary_on_conn(conn, since_iso=kpi_since_iso, agent_filter=agent_filter)
    recent_tool_errors = _fetch_recent_tool_errors(conn, kpi_since_iso, limit=5)

    kpi_time_clause, kpi_time_params = _time_filter("requested_at", kpi_since_iso, None)
    kpi_kind_clause, kpi_kind_params = _model_kind_filter(agent_filter)
    kpi_clauses = [c for c in (kpi_time_clause, kpi_kind_clause.lstrip(" AND ") if kpi_kind_clause else "") if c]
    kpi_where = f" WHERE {' AND '.join(kpi_clauses)}" if kpi_clauses else ""
    kpi_params = (*kpi_time_params, *kpi_kind_params)
    cache_summary = aggregate_cache_metrics(conn, where_sql=kpi_where, params=kpi_params)

    return {
        "enabled": True,
        "window": {
            "since_hours": hours,
            "since_iso": since_iso,
            "previous_since_iso": previous_since_iso,
        },
        "kpis": {
            "total_requests": int(current["total_requests"]),
            "success_rate": float(current["success_rate"]),
            "avg_latency_ms": float(current["avg_latency_ms"]),
            "total_tokens": int(current["total_tokens"]),
            "tool_calls": int(current.get("tool_calls") or 0),
            "tool_errors": int(current.get("tool_errors") or 0),
            "deltas": deltas,
            "sparklines": {
                "requests": spark_requests,
                "success_rate": spark_success,
                "latency_ms": spark_latency,
                "tokens": spark_tokens,
            },
        },
        "request_trends": request_trends,
        "model_ranking": _fetch_model_ranking(conn, kpi_since_iso, agent_filter),
        "token_trends": token_daily,
        "recent_requests": _build_recent_requests(since_hours=hours, agent_filter=agent_filter),
        "agents_summary": agents_items,
        "recent_tool_errors": recent_tool_errors,
        "summary": {
            "token_cost_usd": None,
            "avg_tokens_per_request": avg_tokens_per_request,
            "tool_calls": int(current.get("tool_calls") or 0),
            "tool_errors": int(current.get("tool_errors") or 0),
            **cache_summary,
        },
    }
