"""Reconstruct per-request latency waterfall from trace events + model/tool invocations.

Groups ``collab_cycle`` trace events into model-call cycles and computes
wall-clock time for each phase so reviewers can identify bottlenecks:

    pre_model  →  model (ttft + inference)  →  post_model  →  tool_gap  →  next cycle

Usage::

    wf = build_thread_waterfall(thread_id="<uuid>")
    print(wf["cycles"][0]["phase_breakdown_ms"])
"""

from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime
from typing import Any

from evoflow.observability import queries as q
from evoflow.observability.tables import ObservabilityTable
from evoflow.observability.tool_filters import llm_tool_visibility_sql


def _parse_iso_ms(iso_str: str | None) -> float:
    """Parse ISO-8601 timestamp to epoch milliseconds."""
    if not iso_str or not iso_str.strip():
        return 0.0
    try:
        dt = datetime.fromisoformat(iso_str.strip())
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=UTC)
        return dt.timestamp() * 1000
    except (ValueError, TypeError):
        return 0.0


def _load_trace_events(thread_id: str) -> list[dict[str, Any]]:
    """Load all collab_cycle trace events for *thread_id*, ordered by occurred_at."""
    st = q._store()
    if st is None:
        return []
    conn = st._connection()  # noqa: SLF001
    conn.row_factory = sqlite3.Row
    T = ObservabilityTable
    rows = conn.execute(
        f"""
        SELECT occurred_at, event, payload_json
        FROM {T.TRACE_EVENTS}
        WHERE lane = 'collab_cycle' AND thread_id = ?
        ORDER BY occurred_at ASC
        """,
        (thread_id.strip(),),
    ).fetchall()
    out: list[dict[str, Any]] = []
    for r in rows:
        occ = r["occurred_at"] or ""
        ev = str(r["event"] or "").strip()
        raw = r["payload_json"]
        payload = {}
        if raw:
            try:
                payload = json.loads(raw) if isinstance(raw, str) else raw
            except (json.JSONDecodeError, TypeError):
                payload = {"raw": str(raw)}
        out.append({"occurred_at": occ, "event": ev, "payload": payload, "ts_ms": _parse_iso_ms(occ)})
    return out


def _load_model_invocations_for_timeline(
    thread_id: str,
) -> list[dict[str, Any]]:
    """Load model invocations for *thread_id*, ordered by requested_at."""
    st = q._store()
    if st is None:
        return []
    conn = st._connection()  # noqa: SLF001
    conn.row_factory = sqlite3.Row
    T = ObservabilityTable
    rows = conn.execute(
        f"""
        SELECT requested_at, latency_ms, first_token_latency_ms, provider, model, invocation_kind
        FROM {T.MODEL_INVOCATIONS}
        WHERE thread_id = ?
        ORDER BY requested_at ASC
        """,
        (thread_id.strip(),),
    ).fetchall()
    out: list[dict[str, Any]] = []
    for r in rows:
        out.append(
            {
                "requested_at": r["requested_at"] or "",
                "ts_ms": _parse_iso_ms(r["requested_at"]),
                "latency_ms": float(r["latency_ms"] or 0),
                "first_token_latency_ms": float(r["first_token_latency_ms"] or 0),
                "provider": str(r["provider"] or ""),
                "model": str(r["model"] or ""),
                "invocation_kind": str(r["invocation_kind"] or "").strip() or None,
            }
        )
    return out


def _load_tool_invocations_for_timeline(
    thread_id: str,
) -> list[dict[str, Any]]:
    """Load tool invocations for *thread_id*, ordered by started_at."""
    st = q._store()
    if st is None:
        return []
    conn = st._connection()  # noqa: SLF001
    conn.row_factory = sqlite3.Row
    T = ObservabilityTable
    rows = conn.execute(
        f"""
        SELECT started_at, ended_at, duration_ms, tool_name, status, tool_call_id
        FROM {T.TOOL_INVOCATIONS}
        WHERE thread_id = ? AND {llm_tool_visibility_sql()}
        ORDER BY started_at ASC
        """,
        (thread_id.strip(),),
    ).fetchall()
    out: list[dict[str, Any]] = []
    for r in rows:
        out.append(
            {
                "started_at": r["started_at"] or "",
                "ts_ms": _parse_iso_ms(r["started_at"]),
                "ended_at": r["ended_at"] or "",
                "ended_ts_ms": _parse_iso_ms(r["ended_at"]),
                "duration_ms": float(r["duration_ms"] or 0),
                "tool_name": str(r["tool_name"] or ""),
                "status": str(r["status"] or ""),
                "tool_call_id": str(r["tool_call_id"] or ""),
            }
        )
    return out


def _compute_phase_durations(
    events: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Group sequential collab_cycle events into model-call cycles with durations.

    Each cycle follows: before_model → model_request → model_response → after_model.

    Returns a list of cycles, each containing ``phase_breakdown_ms`` and raw event refs.
    """
    cycles: list[dict[str, Any]] = []
    i = 0
    while i < len(events):
        ev = events[i]["event"]
        if ev != "before_model":
            i += 1
            continue

        cycle: dict[str, Any] = {
            "start_event": events[i],
            "phases": {},
            "phase_breakdown_ms": {},
            "raw_events": [],
        }
        cycle_start_ms = events[i]["ts_ms"]
        i += 1

        # Collect events until the next before_model (or end)
        while i < len(events) and events[i]["event"] != "before_model":
            cycle["raw_events"].append(events[i])
            i += 1

        # Now we have: before_model @ idx_start, then raw events until next before_model or end
        # Find key event timestamps
        before_model_ms = cycle_start_ms
        model_request_ms: float | None = None
        model_response_ms: float | None = None
        after_model_ms: float | None = None
        tool_starts: list[float] = []
        tool_ends: list[float] = []
        tool_total_ms = 0.0

        for re in cycle["raw_events"]:
            ev_name = re["event"]
            t = re["ts_ms"]
            if ev_name == "model_request":
                model_request_ms = t
            elif ev_name == "model_response":
                model_response_ms = t
            elif ev_name == "after_model":
                after_model_ms = t
            elif ev_name == "tool_start":
                tool_starts.append(t)
            elif ev_name == "tool_end":
                tool_ends.append(t)
                # Each tool_end has elapsed_ms in payload
                elapsed = float(re["payload"].get("elapsed_ms") or 0)
                tool_total_ms += elapsed

        # Compute phase durations
        breakdown: dict[str, float] = {}

        if model_request_ms is not None:
            breakdown["pre_model_ms"] = round(model_request_ms - before_model_ms, 2)
        else:
            breakdown["pre_model_ms"] = None

        if model_request_ms is not None and model_response_ms is not None:
            breakdown["model_call_ms"] = round(model_response_ms - model_request_ms, 2)
        elif model_request_ms is not None:
            breakdown["model_call_ms"] = None

        if model_response_ms is not None and after_model_ms is not None:
            breakdown["post_model_ms"] = round(after_model_ms - model_response_ms, 2)
        elif model_response_ms is not None:
            breakdown["post_model_ms"] = None

        if after_model_ms is not None:
            breakdown["total_cycle_ms"] = round(after_model_ms - before_model_ms, 2)
        elif model_response_ms is not None:
            breakdown["total_cycle_ms"] = round(model_response_ms - before_model_ms, 2)
        else:
            breakdown["total_cycle_ms"] = None

        if tool_total_ms > 0:
            breakdown["tool_total_ms"] = round(tool_total_ms, 2)

        # Model response elapsed_ms from trace payload (if available)
        for re in cycle["raw_events"]:
            if re["event"] == "model_response":
                elapsed = re["payload"].get("elapsed_ms")
                if elapsed is not None:
                    breakdown["model_response_elapsed_ms"] = round(float(elapsed), 2)
                    break

        cycle["phase_breakdown_ms"] = breakdown
        cycles.append(cycle)

    return cycles


def _merge_model_invocation_data(
    cycles: list[dict[str, Any]],
    model_invocations: list[dict[str, Any]],
) -> None:
    """Merge model-level TTFT and full latency into cycles based on temporal proximity.

    Because trace events and model invocations use different clock references
    (iso vs perf_counter), we match by index order rather than absolute time.
    """
    for idx, cycle in enumerate(cycles):
        if idx < len(model_invocations):
            mi = model_invocations[idx]
            bd = cycle["phase_breakdown_ms"]
            ttft = mi.get("first_token_latency_ms")
            full = mi.get("latency_ms")
            if ttft is not None and ttft > 0:
                bd["model_ttft_ms"] = round(ttft, 2)
            if full is not None and full > 0:
                bd["model_full_latency_ms"] = round(full, 2)
            if (ttft or 0) > 0 and (full or 0) > 0:
                inference = full - ttft
                if inference > 0:
                    bd["model_inference_ms"] = round(inference, 2)
            bd["model_provider"] = mi.get("provider")
            bd["model_name"] = mi.get("model")
            bd["invocation_kind"] = mi.get("invocation_kind")


def build_thread_waterfall(thread_id: str) -> dict[str, Any]:
    """Build a latency waterfall for *thread_id*.

    Returns::

        {
            "thread_id": "...",
            "total_cycles": N,
            "cycles": [
                {
                    "phase_breakdown_ms": {
                        "pre_model_ms": ...,
                        "model_ttft_ms": ...,
                        "model_inference_ms": ...,
                        "model_full_latency_ms": ...,
                        "post_model_ms": ...,
                        "tool_total_ms": ...,
                        "total_cycle_ms": ...
                    },
                    "model_name": ...,
                    "tool_count": ...
                },
                ...
            ],
            "aggregate": {
                "avg_pre_model_ms": ...,
                "avg_ttft_ms": ...,
                "avg_inference_ms": ...,
                "avg_post_model_ms": ...,
                "avg_tool_ms": ...,
                "avg_total_cycle_ms": ...,
                "p95_ttft_ms": ...,
                "p95_total_cycle_ms": ...
            },
            "bottleneck_phases": [ ... ]
        }
    """
    events = _load_trace_events(thread_id)
    model_invocations = _load_model_invocations_for_timeline(thread_id)

    if not events:
        return {"thread_id": thread_id, "total_cycles": 0, "cycles": [], "aggregate": {}, "bottleneck_phases": []}

    cycles = _compute_phase_durations(events)
    _merge_model_invocation_data(cycles, model_invocations)

    # Count tools per cycle
    for cycle in cycles:
        cycle["tool_count"] = sum(1 for re in cycle.get("raw_events") or [] if re["event"] == "tool_start")

    # Aggregate across cycles
    agg = _compute_aggregate(cycles)
    bottlenecks = _identify_bottlenecks(cycles, agg)

    return {
        "thread_id": thread_id,
        "total_cycles": len(cycles),
        "cycles": cycles,
        "aggregate": agg,
        "bottleneck_phases": bottlenecks,
    }


def _compute_aggregate(cycles: list[dict[str, Any]]) -> dict[str, Any]:
    """Compute average and P95 across all cycles for each phase."""
    keys = [
        ("pre_model_ms", "avg_pre_model_ms"),
        ("model_ttft_ms", "avg_ttft_ms"),
        ("model_inference_ms", "avg_inference_ms"),
        ("model_full_latency_ms", "avg_full_latency_ms"),
        ("post_model_ms", "avg_post_model_ms"),
        ("tool_total_ms", "avg_tool_ms"),
        ("total_cycle_ms", "avg_total_cycle_ms"),
    ]
    values: dict[str, list[float]] = {}
    for k, _ in keys:
        values[k] = []
    for c in cycles:
        bd = c.get("phase_breakdown_ms") or {}
        for k, _ in keys:
            v = bd.get(k)
            if v is not None and isinstance(v, (int, float)) and v > 0:
                values[k].append(float(v))

    agg: dict[str, Any] = {}
    for k, agg_key in keys:
        vals = values.get(k, [])
        if vals:
            agg[agg_key] = round(sum(vals) / len(vals), 2)
        else:
            agg[agg_key] = None

    # P95 for key metrics
    for k, p95_key in [
        ("model_ttft_ms", "p95_ttft_ms"),
        ("total_cycle_ms", "p95_total_cycle_ms"),
        ("pre_model_ms", "p95_pre_model_ms"),
    ]:
        vals = sorted(values.get(k, []))
        if vals:
            idx = min(len(vals) - 1, int(round(0.95 * (len(vals) - 1))))
            agg[p95_key] = round(vals[idx], 2)
        else:
            agg[p95_key] = None

    return agg


def _identify_bottlenecks(
    cycles: list[dict[str, Any]],
    aggregate: dict[str, Any],
) -> list[dict[str, Any]]:
    """Identify phases that are disproportionately slow, per-cycle and in aggregate."""
    findings: list[dict[str, Any]] = []

    # Aggregate bottlenecks
    total_avg = aggregate.get("avg_total_cycle_ms") or 0
    pre_avg = aggregate.get("avg_pre_model_ms") or 0
    if total_avg > 0 and pre_avg / total_avg > 0.3:
        findings.append(
            {
                "type": "aggregate",
                "phase": "pre_model",
                "phenomenon": f"pre_model 占平均周期 {pre_avg / total_avg * 100:.0f}%",
                "hint": "中间件处理或思考时间过长",
            }
        )

    ttft_avg = aggregate.get("avg_ttft_ms") or 0
    if ttft_avg > 5_000:
        findings.append(
            {
                "type": "aggregate",
                "phase": "ttft",
                "phenomenon": f"平均 TTFT {ttft_avg / 1000:.1f}s",
                "hint": "模型 provider 响应慢或长输入压缩瓶颈",
            }
        )

    full_avg = aggregate.get("avg_full_latency_ms") or 0
    inf_avg = aggregate.get("avg_inference_ms") or 0
    if full_avg > 0 and inf_avg / full_avg > 0.6:
        findings.append(
            {
                "type": "aggregate",
                "phase": "inference",
                "phenomenon": f"模型推理占 {inf_avg / full_avg * 100:.0f}% 总延迟",
                "hint": "输出长文本或思考链过长",
            }
        )

    # Per-cycle bottlenecks
    for idx, c in enumerate(cycles):
        bd = c.get("phase_breakdown_ms") or {}
        total = bd.get("total_cycle_ms") or 0
        if total <= 0:
            continue
        for phase, label, threshold_ratio in [
            ("pre_model_ms", "pre_model", 0.4),
            ("model_ttft_ms", "ttft", 0.3),
            ("model_inference_ms", "inference", 0.5),
        ]:
            v = bd.get(phase) or 0
            if v > 0 and v / total > threshold_ratio:
                findings.append(
                    {
                        "type": "cycle",
                        "cycle_index": idx,
                        "phase": label,
                        "phenomenon": f"cycle {idx} {label} {v / 1000:.1f}s 占 {v / total * 100:.0f}%",
                        "duration_ms": round(v, 2),
                    }
                )

    return findings


def build_waterfall_summary(
    *,
    since_hours: float = 168,
    sample_limit: int = 20,
) -> dict[str, Any]:
    """Aggregate waterfall metrics across recent active threads.

    Returns a summary of aggregate phase timing across all threads,
    plus top slow phases, for inclusion in the observability report.
    """
    overview = q.fetch_overview(since_hours=since_hours)
    top_threads = overview.get("top_slow_threads") or []
    thread_ids = [str(r.get("thread_id") or "") for r in top_threads[:sample_limit] if str(r.get("thread_id") or "").strip()]

    if not thread_ids:
        # Fall back to querying thread list
        insights = q.fetch_insights(limit=sample_limit, since_hours=since_hours)
        slow_models = insights.get("slowest_model_invocations") or []
        seen = set()
        for r in slow_models:
            tid = str(r.get("thread_id") or "").strip()
            if tid and tid not in seen:
                seen.add(tid)
                thread_ids.append(tid)
        thread_ids = thread_ids[:sample_limit]

    if not thread_ids:
        return {
            "enabled": True,
            "since_hours": since_hours,
            "sampled_threads": 0,
            "aggregate": {},
            "bottlenecks": [],
        }

    all_aggs: list[dict[str, Any]] = []
    all_bottlenecks: list[dict[str, Any]] = []
    for tid in thread_ids:
        wf = build_thread_waterfall(tid)
        if wf.get("cycles"):
            all_aggs.append(wf["aggregate"])
            all_bottlenecks.extend(wf.get("bottleneck_phases") or [])

    # Merge aggregates
    merged: dict[str, list[float]] = {}
    for agg in all_aggs:
        for k, v in agg.items():
            if isinstance(v, (int, float)) and v is not None:
                merged.setdefault(k, []).append(v)

    summary_agg: dict[str, Any] = {}
    for k, vals in merged.items():
        if vals:
            summary_agg[k] = round(sum(vals) / len(vals), 2)
            s = sorted(vals)
            idx95 = min(len(s) - 1, int(round(0.95 * (len(s) - 1))))
            summary_agg[f"{k}_p95"] = round(s[idx95], 2)
        else:
            summary_agg[k] = None

    # Deduplicate bottlenecks
    seen_bn = set()
    unique_bn: list[dict[str, Any]] = []
    for bn in all_bottlenecks:
        key = json.dumps(bn, sort_keys=True)
        if key not in seen_bn:
            seen_bn.add(key)
            unique_bn.append(bn)

    return {
        "enabled": True,
        "since_hours": since_hours,
        "sampled_threads": len(thread_ids),
        "aggregate": summary_agg,
        "bottlenecks": unique_bn[:20],
    }