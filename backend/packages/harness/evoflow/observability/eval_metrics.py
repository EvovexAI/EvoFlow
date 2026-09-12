"""Evaluation metrics, health scores, sample thread selection, and eval snapshot bundle."""

from __future__ import annotations

import sqlite3
from datetime import UTC, datetime
from typing import Any

from evoflow.observability import queries as q
from evoflow.observability.tables import ObservabilityTable
from evoflow.observability.tool_filters import llm_tool_visibility_sql


def fetch_invalid_tool_calls_summary(*, since_hours: float | None = 168) -> dict[str, Any]:
    """Aggregate ``invalid_tool_calls_count`` from collab_cycle ``model_response`` trace rows."""
    st = q._store()
    if st is None:
        return {"enabled": False}
    conn = st._connection()  # noqa: SLF001
    conn.row_factory = sqlite3.Row
    T = ObservabilityTable
    since = q._since_iso(since_hours)
    trace_extra = " AND occurred_at >= ?" if since else ""
    trace_p: tuple[Any, ...] = (since,) if since else ()

    row = conn.execute(
        f"""
        SELECT COUNT(*) AS response_count,
               SUM(CASE WHEN CAST(json_extract(payload_json, '$.invalid_tool_calls_count') AS INTEGER) > 0
                        THEN 1 ELSE 0 END) AS responses_with_invalid,
               SUM(CAST(COALESCE(json_extract(payload_json, '$.invalid_tool_calls_count'), 0) AS INTEGER))
                   AS total_invalid_tool_calls
        FROM {T.TRACE_EVENTS}
        WHERE lane = 'collab_cycle' AND event = 'model_response'{trace_extra}
        """,
        trace_p,
    ).fetchone()
    response_count = int(row["response_count"] or 0) if row else 0
    responses_with_invalid = int(row["responses_with_invalid"] or 0) if row else 0
    total_invalid = int(row["total_invalid_tool_calls"] or 0) if row else 0
    rate = (responses_with_invalid / response_count) if response_count else 0.0

    by_thread = [
        q._row_to_dict(conn, r)
        for r in conn.execute(
            f"""
            SELECT thread_id,
                   COUNT(*) AS model_responses,
                   SUM(CAST(COALESCE(json_extract(payload_json, '$.invalid_tool_calls_count'), 0) AS INTEGER))
                       AS invalid_tool_calls
            FROM {T.TRACE_EVENTS}
            WHERE lane = 'collab_cycle' AND event = 'model_response'
              AND thread_id IS NOT NULL AND thread_id != ''{trace_extra}
            GROUP BY thread_id
            HAVING invalid_tool_calls > 0
            ORDER BY invalid_tool_calls DESC
            LIMIT 20
            """,
            trace_p,
        ).fetchall()
    ]

    return {
        "enabled": True,
        "since_hours": since_hours,
        "since_iso": since,
        "model_response_count": response_count,
        "responses_with_invalid_tool_calls": responses_with_invalid,
        "invalid_tool_call_rate": round(rate, 4),
        "total_invalid_tool_calls": total_invalid,
        "top_threads_by_invalid": by_thread,
    }


def fetch_thread_tool_density(*, since_hours: float | None = 168, limit: int = 20) -> dict[str, Any]:
    """Per-thread tool invocation counts; flags threads above approximate P95 density."""
    st = q._store()
    if st is None:
        return {"enabled": False}
    conn = st._connection()  # noqa: SLF001
    conn.row_factory = sqlite3.Row
    T = ObservabilityTable
    since = q._since_iso(since_hours)
    where_parts = [llm_tool_visibility_sql(), "thread_id IS NOT NULL", "thread_id != ''"]
    tool_p: tuple[Any, ...] = ()
    if since:
        where_parts.append("ended_at >= ?")
        tool_p = (since,)
    tool_where = " AND ".join(where_parts)

    rows = [
        q._row_to_dict(conn, r)
        for r in conn.execute(
            f"""
            SELECT thread_id,
                   COUNT(*) AS tool_calls,
                   SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS tool_errors,
                   SUM(duration_ms) AS total_tool_ms
            FROM {T.TOOL_INVOCATIONS}
            WHERE {tool_where}
            GROUP BY thread_id
            ORDER BY tool_calls DESC
            LIMIT 200
            """,
            tool_p,
        ).fetchall()
    ]
    counts = [int(r.get("tool_calls") or 0) for r in rows]
    p95_threshold: int | None = None
    if counts:
        p95_val = q._percentile([float(c) for c in counts], 95.0)
        p95_threshold = int(p95_val) if p95_val is not None else None

    dense = [r for r in rows if p95_threshold is not None and int(r.get("tool_calls") or 0) >= p95_threshold]
    dense.sort(key=lambda x: int(x.get("tool_calls") or 0), reverse=True)

    return {
        "enabled": True,
        "since_hours": since_hours,
        "thread_count_with_tools": len(rows),
        "tool_calls_p95_threshold": p95_threshold,
        "dense_threads": dense[:limit],
        "top_by_tool_calls": rows[:limit],
    }


def fetch_compress_kind_stats(*, since_hours: float | None = 168) -> dict[str, Any]:
    """Share of model calls and latency attributable to compress/memory invocation kinds."""
    summary = q.fetch_errors_summary(since_hours=since_hours)
    if not summary.get("enabled"):
        return {"enabled": False}
    kinds = summary.get("model_by_kind") if isinstance(summary.get("model_by_kind"), list) else []
    total_calls = sum(int(k.get("call_count") or 0) for k in kinds if isinstance(k, dict))
    aux_kinds = frozenset({"compress", "memory", "tool_summary"})
    aux_calls = 0
    aux_max_latency = 0.0
    for k in kinds:
        if not isinstance(k, dict):
            continue
        kind = str(k.get("invocation_kind") or "")
        cnt = int(k.get("call_count") or 0)
        if kind in aux_kinds:
            aux_calls += cnt
            aux_max_latency = max(aux_max_latency, float(k.get("max_latency_ms") or 0))
    ratio = (aux_calls / total_calls) if total_calls else 0.0
    return {
        "enabled": True,
        "since_hours": since_hours,
        "total_model_calls": total_calls,
        "auxiliary_kind_calls": aux_calls,
        "auxiliary_kind_ratio": round(ratio, 4),
        "auxiliary_max_latency_ms": round(aux_max_latency, 2) if aux_max_latency else None,
        "model_by_kind": kinds,
    }


def compute_thread_health_score(
    *,
    thread_id: str,
    since_hours: float | None = 168,
    overview: dict[str, Any] | None = None,
    invalid_summary: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """
    Heuristic 0–100 score for sampling priority (higher = healthier).

    Formula (plan): 100 - penalties for error rate, slow tools, tokens, invalid tools, density.
    """
    tid = (thread_id or "").strip()
    insights = q.thread_insights(tid, limit=10)
    tools = insights.get("slowest_tool_invocations") or []
    errors = insights.get("recent_tool_errors") or []
    tokens = insights.get("highest_token_model_invocations") or []
    ttft_models = insights.get("slowest_ttft_model_invocations") or []

    tool_n = len(tools) + len(errors)
    err_n = len(errors)
    err_rate = (err_n / tool_n) if tool_n else 0.0

    max_tool_ms = 0.0
    for row in tools:
        if isinstance(row, dict):
            max_tool_ms = max(max_tool_ms, float(row.get("duration_ms") or 0))

    max_tokens = 0
    for row in tokens:
        if isinstance(row, dict):
            max_tokens = max(max_tokens, int(row.get("usage_total_tokens") or 0))

    ov = overview if isinstance(overview, dict) else q.fetch_overview(since_hours=since_hours)
    global_p95_tool = float(ov.get("tool_duration_p95_ms") or 60_000)
    slow_tool_ratio = min(1.0, max_tool_ms / global_p95_tool) if global_p95_tool > 0 else 0.0
    token_norm = min(1.0, max_tokens / 150_000) if max_tokens else 0.0

    max_ttft_ms = 0.0
    for row in ttft_models:
        if isinstance(row, dict):
            max_ttft_ms = max(max_ttft_ms, float(row.get("first_token_latency_ms") or 0))
    global_p95_ttft = float(ov.get("model_ttft_p95_ms") or 10_000)
    ttft_norm = min(1.0, max_ttft_ms / global_p95_ttft) if global_p95_ttft > 0 else 0.0

    inv = invalid_summary if isinstance(invalid_summary, dict) else fetch_invalid_tool_calls_summary(
        since_hours=since_hours
    )
    invalid_norm = 0.0
    for row in inv.get("top_threads_by_invalid") or []:
        if isinstance(row, dict) and str(row.get("thread_id") or "") == tid:
            inv_count = int(row.get("invalid_tool_calls") or 0)
            invalid_norm = min(1.0, inv_count / 10.0)
            break

    density = fetch_thread_tool_density(since_hours=since_hours, limit=5)
    dense_norm = 0.0
    p95_thr = density.get("tool_calls_p95_threshold")
    for row in density.get("top_by_tool_calls") or []:
        if isinstance(row, dict) and str(row.get("thread_id") or "") == tid:
            calls = int(row.get("tool_calls") or 0)
            if p95_thr and calls >= int(p95_thr):
                dense_norm = min(1.0, calls / max(int(p95_thr) * 2, 1))
            break

    score = 100.0
    score -= 20.0 * err_rate
    score -= 15.0 * slow_tool_ratio
    score -= 15.0 * token_norm
    score -= 10.0 * invalid_norm
    score -= 10.0 * dense_norm
    score -= 10.0 * ttft_norm
    score = max(0.0, min(100.0, round(score, 1)))

    return {
        "thread_id": tid,
        "health_score": score,
        "components": {
            "tool_error_rate": round(err_rate, 4),
            "max_tool_duration_ms": max_tool_ms,
            "max_usage_total_tokens": max_tokens,
            "max_first_token_latency_ms": max_ttft_ms,
            "first_token_latency_norm": round(ttft_norm, 4),
            "invalid_tool_calls_norm": round(invalid_norm, 4),
            "tool_density_norm": round(dense_norm, 4),
        },
        "insights_schema": insights.get("schema"),
    }


def pick_sample_threads(
    *,
    since_hours: float = 168,
    sample_k: int = 5,
    insights: dict[str, Any] | None = None,
    overview: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """
    Select up to ``sample_k`` threads for deep review: slow, errors, high token.

    Default mix (K=5): 2 slow threads, 2 error threads, 1 high-token thread.
    """
    k = max(1, min(20, int(sample_k or 5)))
    ins = insights if isinstance(insights, dict) else q.fetch_insights(limit=15, since_hours=since_hours)
    ov = overview if isinstance(overview, dict) else q.fetch_overview(since_hours=since_hours)

    picked: list[dict[str, Any]] = []
    seen: set[str] = set()

    def _add(tid: str, reason: str, extra: dict[str, Any] | None = None) -> None:
        tid = (tid or "").strip()
        if not tid or tid in seen or len(picked) >= k:
            return
        seen.add(tid)
        entry: dict[str, Any] = {"thread_id": tid, "sample_reason": reason}
        if extra:
            entry.update(extra)
        picked.append(entry)

    slow_slots = max(1, k * 2 // 5) if k >= 3 else 1
    error_slots = max(1, k * 2 // 5) if k >= 3 else 1
    token_slots = max(1, k - slow_slots - error_slots)

    for row in (ov.get("top_slow_threads") or [])[:slow_slots]:
        if isinstance(row, dict):
            _add(
                str(row.get("thread_id") or ""),
                "top_slow_thread",
                {
                    "total_tool_ms": row.get("total_tool_ms"),
                    "tool_calls": row.get("tool_calls"),
                },
            )

    for row in (ins.get("recent_tool_errors") or [])[: error_slots * 2]:
        if isinstance(row, dict):
            _add(str(row.get("thread_id") or ""), "recent_tool_error", {"tool_name": row.get("tool_name")})

    for row in (ins.get("highest_token_model_invocations") or [])[:token_slots]:
        if isinstance(row, dict):
            _add(
                str(row.get("thread_id") or ""),
                "highest_token_invocation",
                {"usage_total_tokens": row.get("usage_total_tokens")},
            )

    inv = fetch_invalid_tool_calls_summary(since_hours=since_hours)
    for row in (inv.get("top_threads_by_invalid") or []):
        if len(picked) >= k:
            break
        if isinstance(row, dict):
            _add(
                str(row.get("thread_id") or ""),
                "high_invalid_tool_calls",
                {"invalid_tool_calls": row.get("invalid_tool_calls")},
            )

    return picked[:k]


def build_eval_findings(dimensions: dict[str, Any]) -> list[dict[str, Any]]:
    """Structured findings for LLM expansion (schema evoflow.eval.finding.v1)."""
    findings: list[dict[str, Any]] = []
    eval_dim = dimensions.get("eval") if isinstance(dimensions.get("eval"), dict) else {}

    inv = eval_dim.get("invalid_tool_calls") if isinstance(eval_dim.get("invalid_tool_calls"), dict) else {}
    rate = float(inv.get("invalid_tool_call_rate") or 0)
    total_inv = int(inv.get("total_invalid_tool_calls") or 0)
    if rate >= 0.05 or total_inv >= 10:
        findings.append(
            _finding(
                "model_invalid_tool_calls_high",
                "P1" if rate < 0.15 else "P0",
                "model",
                "invalid_tool_call_rate",
                rate,
                0.05,
                "模型返回 invalid_tool_calls；检查工具 schema 与 prompt 中的参数示例",
                [{"metric": "total_invalid_tool_calls", "value": total_inv}],
            )
        )

    density = eval_dim.get("thread_tool_density") if isinstance(eval_dim.get("thread_tool_density"), dict) else {}
    dense = density.get("dense_threads") if isinstance(density.get("dense_threads"), list) else []
    if len(dense) >= 3:
        findings.append(
            _finding(
                "tool_density_high",
                "P2",
                "tool",
                "dense_thread_count",
                len(dense),
                3,
                "部分会话工具调用过密；检查重复 read/search、loop_detection 是否触发",
                [{"thread_id": d.get("thread_id"), "tool_calls": d.get("tool_calls")} for d in dense[:5] if isinstance(d, dict)],
            )
        )

    compress = eval_dim.get("compress_kind") if isinstance(eval_dim.get("compress_kind"), dict) else {}
    aux_ratio = float(compress.get("auxiliary_kind_ratio") or 0)
    if aux_ratio >= 0.25:
        findings.append(
            _finding(
                "model_auxiliary_kind_ratio_high",
                "P1",
                "model",
                "auxiliary_kind_ratio",
                aux_ratio,
                0.25,
                "compress/memory/tool_summary 占比较高；调低 summarization threshold 或减小上下文",
                [],
            )
        )

    return findings


def _finding(
    fid: str,
    priority: str,
    dimension: str,
    metric: str,
    value: float | int,
    threshold: float | int,
    suggested_action: str,
    evidence: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "id": fid,
        "schema": "evoflow.eval.finding.v1",
        "priority": priority,
        "dimension": dimension,
        "metric": metric,
        "value": value,
        "threshold": threshold,
        "suggested_action": suggested_action,
        "evidence": evidence,
    }


def _slim_thread_analysis(thread_id: str, *, limit: int = 10) -> dict[str, Any]:
    """SQLite-only per-thread analysis (no agent-trace export)."""
    tid = (thread_id or "").strip()
    ins = q.thread_insights(tid, limit=limit)
    return {
        "schema": "evoflow.eval.thread_analysis.v1",
        "thread_id": tid,
        "source": "observability_sqlite",
        "slowest_tool_calls": ins.get("slowest_tool_invocations"),
        "tool_errors": ins.get("recent_tool_errors"),
        "slowest_model_invocations": ins.get("slowest_model_invocations"),
        "highest_token_model_invocations": ins.get("highest_token_model_invocations"),
    }


def fetch_eval_snapshot(
    *,
    since_hours: float = 168,
    limit: int = 10,
    sample_k: int = 5,
) -> dict[str, Any]:
    """Single bundle: report + eval metrics + sampled threads with health scores."""
    if q._store() is None:
        return {"enabled": False}

    from evoflow.observability import analysis_report as obs_report  # lazy: avoid import cycle

    report = obs_report.fetch_report(since_hours=since_hours, limit=limit)
    invalid_summary = fetch_invalid_tool_calls_summary(since_hours=since_hours)
    density = fetch_thread_tool_density(since_hours=since_hours)
    compress_stats = fetch_compress_kind_stats(since_hours=since_hours)
    overview = report.get("overview") if isinstance(report.get("overview"), dict) else {}

    eval_dimensions = {
        "invalid_tool_calls": invalid_summary,
        "thread_tool_density": density,
        "compress_kind": compress_stats,
    }
    dimensions = dict(report.get("dimensions") or {})
    dimensions["eval"] = eval_dimensions

    eval_findings = build_eval_findings(dimensions)
    recs = list(report.get("recommendations") or [])
    # report.fetch_report already merges eval recommendations via build_recommendations

    samples_meta = pick_sample_threads(
        since_hours=since_hours,
        sample_k=sample_k,
        insights=q.fetch_insights(limit=limit, since_hours=since_hours),
        overview=overview,
    )
    sample_threads: list[dict[str, Any]] = []
    for meta in samples_meta:
        tid = str(meta.get("thread_id") or "")
        health = compute_thread_health_score(
            thread_id=tid,
            since_hours=since_hours,
            overview=overview,
            invalid_summary=invalid_summary,
        )
        sample_threads.append(
            {
                **meta,
                "health_score": health.get("health_score"),
                "health_components": health.get("components"),
                "analysis": _slim_thread_analysis(tid, limit=limit),
                "agent_trace_analysis_url": f"/api/debug/agent-trace/analysis?thread_id={tid}&limit={limit}",
                "agent_trace_export_url": f"/api/debug/agent-trace/export?thread_id={tid}&omit_model_payloads=1",
            }
        )

    return {
        "enabled": True,
        "schema": "evoflow.eval.snapshot.v1",
        "generated_at": datetime.now(UTC).isoformat(),
        "window": report.get("window"),
        "since_hours": since_hours,
        "sample_k": sample_k,
        "report_schema": report.get("schema"),
        "overview": overview,
        "trends": report.get("trends"),
        "dimensions": dimensions,
        "recommendations": recs,
        "eval_findings": eval_findings,
        "sample_threads": sample_threads,
        "endpoints": {
            "eval_snapshot": f"/api/observability/eval-snapshot?since_hours={since_hours}&sample_k={sample_k}",
            "report": report.get("endpoints", {}).get("report"),
            "playbook": "internal design docs (not published in this repository)",
            "eval_skill": "skills/custom/evoflow-eval-analysis/SKILL.md",
        },
    }
