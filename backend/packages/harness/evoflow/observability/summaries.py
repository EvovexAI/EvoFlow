"""Aggregated observability summaries for EvoPanel dashboard sub-pages."""

from __future__ import annotations

import json
import sqlite3
from collections import Counter
from typing import Any

from evoflow.observability import eval_metrics as obs_eval
from evoflow.observability.cache_metrics import cache_triplet_from_row, compute_cache_hit_rate
from evoflow.observability.cache_pricing import estimate_row_cache_savings_cny
from evoflow.observability.queries import (
    ObservabilityTable,
    _percentile,
    _since_iso,
    _store,
    list_tool_invocations,
    thread_timeline,
    token_triplet_from_usage_payload,
)
from evoflow.observability.provider_labels import normalize_stored_provider
from evoflow.observability.response_error import (
    extract_response_error_message_from_json,
    response_json_indicates_error,
)
from evoflow.observability.tool_filters import llm_tool_visibility_sql


def _response_has_error(response_json: Any) -> bool:
    return response_json_indicates_error(response_json)


def _infer_row_status(*, response_json: Any, latency_ms: float | None) -> str:
    if response_json_indicates_error(response_json):
        return "error"
    if latency_ms is not None and latency_ms > 60_000:
        return "warning"
    return "success"


def _time_clause(column: str, since_iso: str | None) -> tuple[str, list[Any]]:
    if not since_iso:
        return "", []
    return f" AND {column} >= ?", [since_iso]


def _kind_clause(agent_filter: str | None) -> tuple[str, list[Any]]:
    if not agent_filter or agent_filter in ("all", ""):
        return "", []
    return " AND COALESCE(NULLIF(TRIM(invocation_kind), ''), 'main') = ?", [agent_filter.strip()]


def _kind_to_agent_label(kind: str) -> str:
    """Map invocation_kind to a friendly agent label."""
    kind_map = {
        "main": "主对话",
        "subagent": "子代理",
        "hosted": "目标",
        "hosted_panel": "目标面板",
        "hosted_closure": "目标小结",
        "title": "标题生成",
        "memory": "记忆",
        "compress": "压缩",
        "mission_state": "意图分析",
        "tool_summary": "工具摘要",
        "auxiliary": "辅助",
    }
    return kind_map.get(kind, kind or "—")


def fetch_agents_summary(
    *,
    since_hours: float | None = 168,
    agent_filter: str | None = "all",
) -> dict[str, Any]:
    st = _store()
    if st is None:
        return {"enabled": False, "items": []}
    conn = st._connection()  # noqa: SLF001
    conn.row_factory = sqlite3.Row
    T = ObservabilityTable
    since = _since_iso(since_hours if since_hours and since_hours > 0 else None)
    time_sql, time_params = _time_clause("requested_at", since)
    kind_sql, kind_params = _kind_clause(agent_filter if agent_filter != "all" else None)

    rows = conn.execute(
        f"""
        SELECT COALESCE(NULLIF(TRIM(invocation_kind), ''), 'main') AS kind,
               model, provider, latency_ms, usage_json, response_json
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
                "name": kind,
                "requests": 0,
                "errors": 0,
                "latencies": [],
                "tokens": 0,
                "models": Counter(),
                "tools": 0,
            }
        entry = by_kind[kind]
        entry["requests"] += 1
        lat = row["latency_ms"]
        if lat is not None:
            entry["latencies"].append(float(lat))
        status = _infer_row_status(response_json=row["response_json"], latency_ms=float(lat) if lat else None)
        if status == "error":
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

    tool_since_sql, tool_since_params = _time_clause("ended_at", since)
    tool_rows = conn.execute(
        f"""
        SELECT thread_id, COUNT(*) AS n
        FROM {T.TOOL_INVOCATIONS}
        WHERE {llm_tool_visibility_sql()} AND thread_id IS NOT NULL AND thread_id != ''{tool_since_sql}
        GROUP BY thread_id
        """,
        tuple(tool_since_params),
    ).fetchall()
    thread_tools = {str(r["thread_id"]): int(r["n"] or 0) for r in tool_rows}

    kind_threads = conn.execute(
        f"""
        SELECT DISTINCT thread_id, COALESCE(NULLIF(TRIM(invocation_kind), ''), 'main') AS kind
        FROM {T.MODEL_INVOCATIONS}
        WHERE thread_id IS NOT NULL AND thread_id != ''{time_sql}{kind_sql}
        """,
        (*time_params, *kind_params),
    ).fetchall()
    for row in kind_threads:
        kind = str(row["kind"] or "main")
        tid = str(row["thread_id"] or "")
        if kind in by_kind and tid in thread_tools:
            by_kind[kind]["tools"] += thread_tools[tid]

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
                "tools": entry["tools"],
                "owner": "—",
            }
        )
    return {"enabled": True, "items": items, "since_iso": since}


def fetch_models_summary(
    *,
    since_hours: float | None = 168,
    agent_filter: str | None = "all",
) -> dict[str, Any]:
    st = _store()
    if st is None:
        return {"enabled": False, "items": []}
    conn = st._connection()  # noqa: SLF001
    conn.row_factory = sqlite3.Row
    T = ObservabilityTable
    since = _since_iso(since_hours if since_hours and since_hours > 0 else None)
    time_sql, time_params = _time_clause("requested_at", since)
    kind_sql, kind_params = _kind_clause(agent_filter if agent_filter != "all" else None)

    rows = conn.execute(
        f"""
        SELECT model, provider, invocation_kind, latency_ms, usage_json, response_json,
               cache_read_tokens, cache_creation_tokens, cache_miss_tokens
        FROM {T.MODEL_INVOCATIONS}
        WHERE 1=1{time_sql}{kind_sql}
        """,
        (*time_params, *kind_params),
    ).fetchall()

    by_model: dict[str, dict[str, Any]] = {}
    for row in rows:
        key = str(row["model"] or "").strip() or "—"
        prov = normalize_stored_provider(str(row["provider"] or "").strip() or None, model=key)
        if key not in by_model:
            by_model[key] = {
                "model": key,
                "provider": prov or "—",
                "requests": 0,
                "errors": 0,
                "latencies": [],
                "prompt_tokens": 0,
                "completion_tokens": 0,
                "total_tokens": 0,
                "cache_read_tokens": 0,
                "cache_creation_tokens": 0,
                "cache_miss_tokens": 0,
                "agents": Counter(),
            }
        entry = by_model[key]
        entry["requests"] += 1
        if prov and entry["provider"] == "—":
            entry["provider"] = prov
        lat = row["latency_ms"]
        if lat is not None:
            entry["latencies"].append(float(lat))
        if _response_has_error(row["response_json"]):
            entry["errors"] += 1
        kind = str(row["invocation_kind"] or "main").strip() or "main"
        entry["agents"][kind] += 1
        read, create, miss = cache_triplet_from_row(
            cache_read=row["cache_read_tokens"],
            cache_create=row["cache_creation_tokens"],
            cache_miss=row["cache_miss_tokens"],
            usage_json=row["usage_json"],
        )
        entry["cache_read_tokens"] += read
        entry["cache_creation_tokens"] += create
        entry["cache_miss_tokens"] += miss
        try:
            u = json.loads(row["usage_json"]) if isinstance(row["usage_json"], str) else row["usage_json"]
            inp, out, tot = token_triplet_from_usage_payload(u)
            entry["prompt_tokens"] += inp
            entry["completion_tokens"] += out
            entry["total_tokens"] += tot
        except (json.JSONDecodeError, TypeError, ValueError):
            pass

    items: list[dict[str, Any]] = []
    for _key, entry in sorted(by_model.items(), key=lambda kv: kv[1]["total_tokens"], reverse=True):
        reqs = entry["requests"]
        err_rate = round(100.0 * entry["errors"] / reqs, 1) if reqs else 0.0
        success_rate = round(100.0 - err_rate, 1)
        latencies = entry["latencies"]
        hit_rate = compute_cache_hit_rate(
            entry["cache_read_tokens"],
            entry["cache_miss_tokens"],
            entry["cache_creation_tokens"],
        )
        savings_cny = estimate_row_cache_savings_cny(
            entry["cache_read_tokens"],
            provider=entry["provider"],
            model=entry["model"],
        )
        items.append(
            {
                "model": entry["model"],
                "provider": entry["provider"],
                "requests": reqs,
                "success_rate": success_rate,
                "avg_latency_ms": round(sum(latencies) / len(latencies), 2) if latencies else 0.0,
                "p95_latency_ms": _percentile(latencies, 95) or 0.0,
                "prompt_tokens": entry["prompt_tokens"],
                "completion_tokens": entry["completion_tokens"],
                "tokens": entry["total_tokens"],
                "cache_read_tokens": entry["cache_read_tokens"],
                "cache_creation_tokens": entry["cache_creation_tokens"],
                "cache_miss_tokens": entry["cache_miss_tokens"],
                "cache_hit_rate": hit_rate,
                "cache_hit_rate_pct": round(hit_rate * 100, 1) if hit_rate is not None else None,
                "estimated_savings_cny": round(savings_cny, 4) if savings_cny > 0 else None,
                "cost_usd": None,
                "error_rate": err_rate,
                "main_agents": [name for name, _ in entry["agents"].most_common(3)],
            }
        )
    return {"enabled": True, "items": items, "since_iso": since}


def fetch_providers_summary(*, since_hours: float | None = 168) -> dict[str, Any]:
    models = fetch_models_summary(since_hours=since_hours, agent_filter="all")
    if not models.get("enabled"):
        return {"enabled": False, "items": []}
    by_provider: dict[str, dict[str, Any]] = {}
    for row in models.get("items") or []:
        if not isinstance(row, dict):
            continue
        name = str(row.get("provider") or "—")
        if name not in by_provider:
            by_provider[name] = {
                "name": name,
                "requests": 0,
                "errors": 0,
                "latencies": [],
                "tokens": 0,
                "cache_read_tokens": 0,
                "cache_miss_tokens": 0,
                "cache_creation_tokens": 0,
                "estimated_savings_cny": 0.0,
                "cost_usd": None,
            }
        entry = by_provider[name]
        reqs = int(row.get("requests") or 0)
        entry["requests"] += reqs
        err_rate = float(row.get("error_rate") or 0)
        entry["errors"] += round(reqs * err_rate / 100.0)
        entry["tokens"] += int(row.get("tokens") or 0)
        entry["cache_read_tokens"] += int(row.get("cache_read_tokens") or 0)
        entry["cache_miss_tokens"] += int(row.get("cache_miss_tokens") or 0)
        entry["cache_creation_tokens"] += int(row.get("cache_creation_tokens") or 0)
        entry["estimated_savings_cny"] += float(row.get("estimated_savings_cny") or 0)
        avg_lat = float(row.get("avg_latency_ms") or 0)
        if avg_lat:
            entry["latencies"].append(avg_lat)

    items: list[dict[str, Any]] = []
    for name, entry in sorted(by_provider.items(), key=lambda kv: kv[1]["requests"], reverse=True):
        reqs = entry["requests"]
        err = entry["errors"]
        success_rate = round(100.0 * (1.0 - err / reqs), 1) if reqs else 100.0
        if success_rate >= 95:
            status = "normal"
        elif success_rate >= 85:
            status = "warning"
        else:
            status = "error"
        latencies = entry["latencies"]
        hit_rate = compute_cache_hit_rate(
            entry["cache_read_tokens"],
            entry["cache_miss_tokens"],
            entry["cache_creation_tokens"],
        )
        savings = float(entry["estimated_savings_cny"] or 0)
        items.append(
            {
                "name": name,
                "status": status,
                "requests": reqs,
                "success_rate": success_rate,
                "avg_latency_ms": round(sum(latencies) / len(latencies), 2) if latencies else 0.0,
                "tokens": entry["tokens"],
                "cache_read_tokens": entry["cache_read_tokens"],
                "cache_hit_rate_pct": round(hit_rate * 100, 1) if hit_rate is not None else None,
                "estimated_savings_cny": round(savings, 4) if savings > 0 else None,
                "cost_usd": None,
                "errors": int(err),
            }
        )
    return {"enabled": True, "items": items, "since_iso": models.get("since_iso")}


def fetch_tools_summary(
    *,
    since_hours: float | None = 168,
    tool_name: str | None = None,
    page: int = 1,
    page_size: int = 50,
) -> dict[str, Any]:
    st = _store()
    if st is None:
        return {"enabled": False, "items": [], "calls": [], "total": 0, "page": page, "page_size": page_size, "pages": 0}
    conn = st._connection()  # noqa: SLF001
    conn.row_factory = sqlite3.Row
    T = ObservabilityTable
    since = _since_iso(since_hours if since_hours and since_hours > 0 else None)
    time_sql, time_params = _time_clause("ended_at", since)

    tool_clauses: list[str] = []
    tool_params: list[Any] = []
    if tool_name:
        tool_clauses.append("tool_name LIKE ?")
        tool_params.append(f"%{tool_name}%")

    tool_where = (" AND ".join(tool_clauses), tuple(tool_params)) if tool_clauses else ("", ())
    tool_where_sql = f" AND {tool_where[0]}" if tool_where[0] else ""
    tool_where_params = tuple(tool_where[1])

    agg_rows = conn.execute(
        f"""
        SELECT tool_name,
               COUNT(*) AS requests,
               SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
               AVG(duration_ms) AS avg_duration_ms,
               MAX(duration_ms) AS max_duration_ms
        FROM {T.TOOL_INVOCATIONS}
        WHERE {llm_tool_visibility_sql()}{time_sql}{tool_where_sql}
        GROUP BY tool_name
        ORDER BY requests DESC
        """,
        tuple(time_params) + tool_where_params,
    ).fetchall()

    items: list[dict[str, Any]] = []
    for row in agg_rows:
        reqs = int(row["requests"] or 0)
        errs = int(row["errors"] or 0)
        success_rate = round(100.0 * (1.0 - errs / reqs), 1) if reqs else 100.0
        items.append(
            {
                "name": str(row["tool_name"] or "—"),
                "category": "Tool",
                "requests": reqs,
                "success_rate": success_rate,
                "avg_latency_ms": round(float(row["avg_duration_ms"] or 0), 2),
                "p95_latency_ms": round(float(row["max_duration_ms"] or 0), 2),
                "failure_rate": round(errs / reqs, 4) if reqs else 0.0,
                "main_agent": "—",
            }
        )

    calls_page = list_tool_invocations(
        page=page,
        page_size=page_size,
        tool_name=tool_name,
        since_hours=since_hours if since_hours and since_hours > 0 else None,
    )
    calls: list[dict[str, Any]] = []
    # 收集所有 thread_id 用于批量查询 invocation_kind
    thread_ids = set()
    for row in calls_page.get("items") or []:
        if isinstance(row, dict) and row.get("thread_id"):
            thread_ids.add(str(row.get("thread_id")))

    # 批量查询每个 thread 的 invocation_kind
    thread_to_kind: dict[str, str] = {}
    if thread_ids:
        placeholders = ",".join("?" for _ in thread_ids)
        kind_rows = conn.execute(
            f"""
            SELECT DISTINCT thread_id, invocation_kind
            FROM {T.MODEL_INVOCATIONS}
            WHERE thread_id IN ({placeholders})
            AND invocation_kind IS NOT NULL AND invocation_kind != ''
            """,
            tuple(thread_ids),
        ).fetchall()
        for kr in kind_rows:
            tid = str(kr["thread_id"] or "")
            kind = str(kr["invocation_kind"] or "")
            if tid and kind and tid not in thread_to_kind:
                thread_to_kind[tid] = kind

    for row in calls_page.get("items") or []:
        if not isinstance(row, dict):
            continue
        status_raw = str(row.get("status") or "success")
        status = "failed" if status_raw == "error" else "success"
        dur = float(row.get("duration_ms") or 0)
        thread_id = str(row.get("thread_id") or "—")
        # 从关联查询获取 invocation_kind，映射为友好的 agent 名称
        kind = thread_to_kind.get(thread_id, "")
        agent_name = _kind_to_agent_label(kind) if kind else "—"
        calls.append(
            {
                "id": str(row.get("id") or ""),
                "time": str(row.get("ended_at") or row.get("started_at") or ""),
                "tool_name": str(row.get("tool_name") or "—"),
                "agent": agent_name,
                "request_id": str(row.get("run_id") or row.get("tool_call_id") or "—"),
                "trace_id": thread_id,
                "status": status,
                "latency_ms": dur,
                "input": str(row.get("input_json") or "")[:10000],
                "output": str(row.get("output_text") or "")[:10000],
                "error": str(row.get("error_message") or "") or None,
            }
        )
    return {
        "enabled": True,
        "items": items,
        "calls": calls,
        "total": calls_page.get("total", 0),
        "page": page,
        "page_size": page_size,
        "pages": calls_page.get("pages", 0),
        "since_iso": since,
    }


def fetch_gateway_routes_summary(
    *,
    page: int = 1,
    page_size: int = 50,
    since_hours: float | None = 168,
) -> dict[str, Any]:
    st = _store()
    if st is None:
        return {
            "enabled": False,
            "items": [],
            "summary": {},
            "total": 0,
            "page": page,
            "page_size": page_size,
            "pages": 0,
        }
    conn = st._connection()  # noqa: SLF001
    conn.row_factory = sqlite3.Row
    T = ObservabilityTable.GATEWAY_REQUESTS
    since = _since_iso(since_hours if since_hours and since_hours > 0 else None)
    time_sql, time_params = _time_clause("occurred_at", since)

    total_row = conn.execute(
        f"""
        SELECT COUNT(*) AS cnt FROM (
            SELECT method, path
            FROM {T}
            WHERE 1=1{time_sql}
            GROUP BY method, path
        )
        """,
        tuple(time_params),
    ).fetchone()
    total = int(total_row["cnt"] or 0)
    offset = max(0, (page - 1) * page_size)

    rows = conn.execute(
        f"""
        SELECT method, path,
               COUNT(*) AS requests,
               AVG(duration_ms) AS avg_duration_ms,
               MAX(duration_ms) AS max_duration_ms,
               SUM(CASE WHEN status_code >= 200 AND status_code < 300 THEN 1 ELSE 0 END) AS status2xx,
               SUM(CASE WHEN status_code >= 400 AND status_code < 500 THEN 1 ELSE 0 END) AS status4xx,
               SUM(CASE WHEN status_code >= 500 THEN 1 ELSE 0 END) AS status5xx,
               SUM(CASE WHEN status_code = 429 THEN 1 ELSE 0 END) AS rate_limited
        FROM {T}
        WHERE 1=1{time_sql}
        GROUP BY method, path
        ORDER BY requests DESC
        LIMIT ? OFFSET ?
        """,
        (*time_params, page_size, offset),
    ).fetchall()

    items = [
        {
            "route": str(r["path"] or "—"),
            "method": str(r["method"] or "GET"),
            "requests": int(r["requests"] or 0),
            "avg_latency_ms": round(float(r["avg_duration_ms"] or 0), 2),
            "p95_latency_ms": round(float(r["max_duration_ms"] or 0), 2),
            "status2xx": int(r["status2xx"] or 0),
            "status4xx": int(r["status4xx"] or 0),
            "status5xx": int(r["status5xx"] or 0),
            "rate_limited": int(r["rate_limited"] or 0),
            "upstream": "Gateway",
        }
        for r in rows
    ]

    summary_row = conn.execute(
        f"""
        SELECT COUNT(*) AS total,
               SUM(CASE WHEN status_code >= 400 AND status_code < 500 THEN 1 ELSE 0 END) AS total4xx,
               SUM(CASE WHEN status_code >= 500 THEN 1 ELSE 0 END) AS total5xx,
               SUM(CASE WHEN status_code = 429 THEN 1 ELSE 0 END) AS total_limit
        FROM {T}
        WHERE 1=1{time_sql}
        """,
        tuple(time_params),
    ).fetchone()
    summary = {
        "total": int(summary_row["total"] or 0),
        "total4xx": int(summary_row["total4xx"] or 0),
        "total5xx": int(summary_row["total5xx"] or 0),
        "total_limit": int(summary_row["total_limit"] or 0),
    }
    return {
        "enabled": True,
        "items": items,
        "summary": summary,
        "since_iso": since,
        "total": total,
        "page": page,
        "page_size": page_size,
        "pages": max(1, (total + page_size - 1) // page_size) if total > 0 else 0,
    }


def fetch_threads_summary(
    *,
    page: int = 1,
    page_size: int = 20,
    since_hours: float | None = 168,
) -> dict[str, Any]:
    st = _store()
    if st is None:
        return {"enabled": False, "items": [], "total": 0, "page": page, "page_size": page_size}
    conn = st._connection()  # noqa: SLF001
    conn.row_factory = sqlite3.Row
    T = ObservabilityTable
    since = _since_iso(since_hours if since_hours and since_hours > 0 else None)
    clauses = ["thread_id IS NOT NULL", "thread_id != ''"]
    params: list[Any] = []
    if since:
        clauses.append("last_seen_at >= ?")
        params.append(since)
    where = " AND ".join(clauses)
    total = conn.execute(f"SELECT COUNT(*) FROM {T.THREADS} WHERE {where}", tuple(params)).fetchone()[0]
    offset = max(0, (page - 1) * page_size)
    rows = conn.execute(
        f"""
        SELECT thread_id, assistant_id, first_seen_at, last_seen_at
        FROM {T.THREADS}
        WHERE {where}
        ORDER BY last_seen_at DESC
        LIMIT ? OFFSET ?
        """,
        (*params, page_size, offset),
    ).fetchall()

    since_h = None
    if since_hours and since_hours > 0:
        since_h = float(since_hours)
    overview = obs_q_fetch_overview_safe()
    invalid_summary = {}

    items: list[dict[str, Any]] = []
    for row in rows:
        tid = str(row["thread_id"] or "").strip()
        if not tid:
            continue
        tl = thread_timeline(tid, limit=200)
        tl_items = tl.get("items") if isinstance(tl.get("items"), list) else []
        health = obs_eval.compute_thread_health_score(
            thread_id=tid,
            since_hours=since_h,
            overview=overview if isinstance(overview, dict) else {},
            invalid_summary=invalid_summary if isinstance(invalid_summary, dict) else {},
        )
        score = float(health.get("health_score") or 0)
        if score >= 80:
            status = "success"
        elif score >= 50:
            status = "warning"
        else:
            status = "failed"
        models = [str(it.get("model") or "") for it in tl_items if it.get("kind") == "model" and it.get("model")]
        agent = models[-1] if models else str(row["assistant_id"] or "主对话 Agent")
        items.append(
            {
                "id": tid,
                "thread_id": tid,
                "agent": agent,
                "duration_ms": None,
                "steps": len(tl_items),
                "status": status,
                "started_at": str(row["first_seen_at"] or ""),
                "summary": f"{len(tl_items)} events · health {round(score, 1)}",
                "health_score": score,
            }
        )
    return {
        "enabled": True,
        "items": items,
        "total": int(total),
        "page": page,
        "page_size": page_size,
        "pages": max(1, (int(total) + page_size - 1) // page_size),
        "since_iso": since,
    }


def obs_q_fetch_overview_safe() -> dict[str, Any]:
    from evoflow.observability import queries as obs_q

    return obs_q.fetch_overview(since_hours=168)


def fetch_analytics_summary(*, since_hours: float | None = 168) -> dict[str, Any]:
    from evoflow.observability import queries as obs_q

    since_h = since_hours if since_hours and since_hours > 0 else None
    overview = obs_q.fetch_overview(since_hours=since_h)
    trends = obs_q.fetch_trends(days=7, since_hours=since_h)
    models = fetch_models_summary(since_hours=since_hours, agent_filter="all")
    providers = fetch_providers_summary(since_hours=since_hours)
    agents = fetch_agents_summary(since_hours=since_hours, agent_filter="all")
    if not overview.get("enabled"):
        return {"enabled": False}
    total_tokens = int((overview.get("total_tokens") or {}).get("total") or 0)
    model_calls = int(overview.get("model_invocations") or 0)
    return {
        "enabled": True,
        "total_cost_usd": None,
        "avg_daily_cost_usd": None,
        "avg_cost_per_request_usd": None,
        "total_tokens": total_tokens,
        "model_invocations": model_calls,
        "trends": trends,
        "models": models.get("items") or [],
        "providers": providers.get("items") or [],
        "agents": agents.get("items") or [],
        "since_iso": overview.get("since_iso"),
    }


def enrich_recent_request_row(row: dict[str, Any]) -> dict[str, Any]:
    try:
        from evoflow.observability.queries import enrich_model_row_thinking

        if not row.get("thinking_label"):
            enrich_model_row_thinking(row)
    except Exception:
        pass
    latency = row.get("latency_ms")
    kind = str(row.get("invocation_kind") or "main").strip() or "main"
    model = str(row.get("model") or "").strip()
    provider = normalize_stored_provider(str(row.get("provider") or "").strip() or None, model=model)
    agent_label = kind if kind != "main" else (model or "主对话 Agent")
    status = _infer_row_status(
        response_json=row.get("response_json"),
        latency_ms=float(latency) if latency is not None else None,
    )
    err_msg = str(row.get("error_message") or "").strip() or None
    if not err_msg:
        err_msg = extract_response_error_message_from_json(row.get("response_json"))
    if err_msg:
        status = "error"
    summary = row.get("response_summary")
    reply_preview = None
    if isinstance(summary, dict):
        preview = str(summary.get("contentPreview") or summary.get("content_preview") or "").strip() or None
        tool_calls = summary.get("tool_calls")
        if tool_calls and isinstance(tool_calls, list) and len(tool_calls) > 0:
            tool_names = [str(tc.get("name", "")) for tc in tool_calls if tc.get("name")]
            if tool_names:
                reply_preview = f"🔧 {len(tool_names)} tools: {', '.join(tool_names[:3])}"
        elif preview and not err_msg:
            reply_preview = preview
    prompt = int(row.get("usage_input_tokens") or 0)
    completion = int(row.get("usage_output_tokens") or 0)
    tokens = int(row.get("usage_total_tokens") or 0) or prompt + completion
    cache_read = row.get("usage_cache_read_tokens")
    if cache_read is None:
        cache_read = row.get("cache_read_tokens")
    cache_creation = row.get("usage_cache_creation_tokens")
    if cache_creation is None:
        cache_creation = row.get("cache_creation_tokens")
    cache_miss = row.get("usage_cache_miss_tokens")
    if cache_miss is None:
        cache_miss = row.get("cache_miss_tokens")
    message_count = row.get("message_count")
    if message_count is not None:
        try:
            message_count = int(message_count)
        except (TypeError, ValueError):
            message_count = None
    model_call_seq = row.get("model_call_seq")
    if model_call_seq is not None:
        try:
            model_call_seq = int(model_call_seq)
            if model_call_seq <= 0:
                model_call_seq = None
        except (TypeError, ValueError):
            model_call_seq = None
    from evoflow.observability.cache_metrics import enrich_model_row_cost

    row["usage_input_tokens"] = prompt
    row["usage_output_tokens"] = completion
    row["usage_cache_read_tokens"] = cache_read
    row["usage_cache_creation_tokens"] = cache_creation
    row["usage_cache_miss_tokens"] = cache_miss
    enrich_model_row_cost(row)
    return {
        "id": str(row.get("id") or ""),
        "status": status,
        "agent_label": agent_label,
        "invocation_kind": kind,
        "model": model or "—",
        "provider": provider or "—",
        "latency_ms": float(latency) if latency is not None else None,
        "prompt_tokens": prompt,
        "completion_tokens": completion,
        "tokens": tokens,
        "cache_read_tokens": int(cache_read) if cache_read is not None else None,
        "cache_creation_tokens": int(cache_creation) if cache_creation is not None else None,
        "cache_miss_tokens": int(cache_miss) if cache_miss is not None else None,
        "estimated_cost_cny": row.get("estimated_cost_cny"),
        "cost_usd": None,
        "occurred_at": str(row.get("requested_at") or ""),
        "thread_id": str(row.get("thread_id") or ""),
        "run_id": str(row.get("run_id") or ""),
        "stage": str(row.get("stage") or ""),
        "trace_id": str(row.get("trace_id") or ""),
        "failure_message": err_msg,
        "reply_preview": reply_preview,
        "message_count": message_count,
        "model_call_seq": model_call_seq,
        "thinking_enabled": row.get("thinking_enabled"),
        "reasoning_effort": row.get("reasoning_effort"),
        "thinking_type": row.get("thinking_type"),
        "thinking_budget_tokens": row.get("thinking_budget_tokens"),
        "thinking_label": row.get("thinking_label"),
        "session_mode": row.get("session_mode"),
    }
