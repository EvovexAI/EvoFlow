"""Gateway REST API for SQLite observability (``evoflow_obs_*``)."""

from __future__ import annotations

import asyncio
import sqlite3
from collections.abc import Callable
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Depends, Request

from evoflow.observability import analysis_report as obs_report
from evoflow.observability import eval_metrics as obs_eval
from evoflow.observability import latency_waterfall as obs_waterfall
from evoflow.observability import queries as obs_queries
from evoflow.observability.queries import ObservabilityDiskFullError, disk_full_user_message


from evoflow.authz.http_guard import require_org_admin


def _org_admin_dep(request: Request) -> None:
    require_org_admin(request)

router = APIRouter(prefix="/api/observability", tags=["observability"], dependencies=[Depends(_org_admin_dep)])


def _disk_full_http(exc: BaseException) -> HTTPException:
    return HTTPException(
        status_code=507,
        detail={
            "error": "disk_full",
            "message": str(exc) if str(exc) else disk_full_user_message(),
        },
    )


def _run_obs_or_disk_full(callable_: Callable[..., Any], /, *args: Any, **kwargs: Any) -> Any:
    """Run blocking SQLite observability query (worker thread only)."""
    try:
        return callable_(*args, **kwargs)
    except ObservabilityDiskFullError as exc:
        raise _disk_full_http(exc) from exc
    except sqlite3.OperationalError as exc:
        if "full" in str(exc).lower():
            raise _disk_full_http(ObservabilityDiskFullError(disk_full_user_message())) from exc
        raise


async def _obs_or_disk_full(callable_: Callable[..., Any], /, *args: Any, **kwargs: Any) -> Any:
    """Offload sync observability SQLite work so the gateway event loop stays responsive."""
    return await asyncio.to_thread(_run_obs_or_disk_full, callable_, *args, **kwargs)


def _build_mcp_status_payload() -> dict[str, Any]:
    from evoflow.mcp.status import build_mcp_status_snapshot

    return build_mcp_status_snapshot()


def _build_runtime_status_payload() -> dict[str, Any]:
    """Collect runtime status off the Gateway event loop (includes observability SQLite)."""
    import time
    from datetime import UTC, datetime, timedelta

    result: dict[str, Any] = {
        "timestamp": datetime.now(UTC).isoformat(),
    }

    try:
        from app.gateway.automation_runner import get_automation_scheduler_status

        result["automation_scheduler"] = get_automation_scheduler_status()
    except Exception as e:
        result["automation_scheduler"] = {"error": str(e)[:200]}

    try:
        from app.gateway.task_queue_runner import get_task_queue_status

        result["task_queue"] = get_task_queue_status()
    except Exception as e:
        result["task_queue"] = {"error": str(e)[:200]}

    try:
        from evoflow.persistence.session_run_state import list_all_active_sessions

        active_sessions = list_all_active_sessions()
        result["active_sessions"] = {
            "count": len(active_sessions),
            "sessions": active_sessions[:20],
        }
    except Exception as e:
        result["active_sessions"] = {"error": str(e)[:200], "count": 0, "sessions": []}

    try:
        from app.gateway.routers.langgraph_proxy import _active_stream_proxies

        now = time.time()
        active_streams = [
            {
                "thread_id": tid,
                "started_at": datetime.fromtimestamp(start_ts, tz=UTC).isoformat(),
                "duration_seconds": round(now - start_ts, 1),
            }
            for tid, start_ts in list(_active_stream_proxies.items())
        ]
        result["active_streams"] = {
            "count": len(active_streams),
            "streams": active_streams[:20],
        }
    except Exception as e:
        result["active_streams"] = {"error": str(e)[:200], "count": 0, "streams": []}

    try:
        from app.gateway.streaming.background_worker import StreamBackgroundWorker

        workers = StreamBackgroundWorker._workers
        active_workers = [
            {"thread_id": tid, "is_alive": w.is_alive()}
            for tid, w in workers.items()
            if w.is_alive()
        ]
        result["background_workers"] = {
            "total": len(workers),
            "active": len(active_workers),
            "workers": active_workers[:20],
        }
    except Exception as e:
        result["background_workers"] = {"error": str(e)[:200], "total": 0, "active": 0, "workers": []}

    result["channel_service"] = {"running": False, "channels": [], "note": "Channel service status not available"}

    try:
        st = obs_queries._store()
        if st is not None:
            conn = st._connection()
            conn.row_factory = sqlite3.Row
            T = obs_queries.ObservabilityTable.MODEL_INVOCATIONS
            active_thread_ids: set[str] = set()
            for s in (result.get("active_sessions") or {}).get("sessions", []):
                tid = s.get("thread_id")
                if tid:
                    active_thread_ids.add(str(tid))
            for w in (result.get("background_workers") or {}).get("workers", []):
                tid = w.get("thread_id")
                if tid:
                    active_thread_ids.add(str(tid))

            rows = conn.execute(
                f"""
                SELECT invocation_kind, thread_id, model, requested_at, latency_ms,
                       stage, collab_phase
                FROM {T}
                WHERE invocation_kind IS NOT NULL AND invocation_kind != ''
                ORDER BY requested_at DESC
                LIMIT 800
                """,
            ).fetchall()

            five_min_ago_iso = (datetime.now(UTC) - timedelta(minutes=5)).isoformat()
            kind_recent_rows = conn.execute(
                f"""
                SELECT COALESCE(NULLIF(TRIM(invocation_kind), ''), 'main') AS kind,
                       COUNT(*) AS n
                FROM {T}
                WHERE invocation_kind IS NOT NULL AND invocation_kind != ''
                  AND requested_at >= ?
                GROUP BY kind
                """,
                (five_min_ago_iso.replace("+00:00", "Z"),),
            ).fetchall()
            kind_recent_count = {str(r["kind"]): int(r["n"] or 0) for r in kind_recent_rows}

            kind_latest: dict[str, dict[str, Any]] = {}
            for row in rows:
                kind = str(row["invocation_kind"] or "")
                if not kind or kind in kind_latest:
                    continue
                kind_latest[kind] = {
                    "invocation_kind": kind,
                    "thread_id": str(row["thread_id"] or ""),
                    "model": str(row["model"] or ""),
                    "requested_at": str(row["requested_at"] or ""),
                    "latency_ms": float(row["latency_ms"] or 0),
                    "stage": str(row["stage"] or ""),
                    "collab_phase": str(row["collab_phase"] or ""),
                }

            agents: list[dict[str, Any]] = []
            for kind, info in kind_latest.items():
                recent_count = kind_recent_count.get(kind, 0)
                agents.append({
                    **info,
                    "is_active": recent_count > 0 or info["thread_id"] in active_thread_ids,
                    "recent_calls_5min": recent_count,
                })

            kind_order = {
                "main": 0, "subagent": 1, "title": 2, "mission_state": 3,
                "memory": 4, "compress": 5, "tool_summary": 6,
                "hosted": 7, "hosted_panel": 8, "hosted_closure": 9,
            }
            agents.sort(key=lambda a: kind_order.get(a["invocation_kind"], 99))
            result["agent_activities"] = {
                "total": len(agents),
                "active_count": sum(1 for a in agents if a["is_active"]),
                "agents": agents,
            }
        else:
            result["agent_activities"] = {"total": 0, "active_count": 0, "agents": []}
    except Exception as e:
        result["agent_activities"] = {"error": str(e)[:200], "total": 0, "active_count": 0, "agents": []}

    result["summary"] = {
        "automation_running": result.get("automation_scheduler", {}).get("backend_loop_running", False),
        "task_queue_running": result.get("task_queue", {}).get("backend_loop_running", False),
        "active_sessions_count": result.get("active_sessions", {}).get("count", 0),
        "active_streams_count": result.get("active_streams", {}).get("count", 0),
        "active_workers_count": result.get("background_workers", {}).get("active", 0),
        "channel_service_running": result.get("channel_service", {}).get("running", False),
        "active_agents_count": result.get("agent_activities", {}).get("active_count", 0),
    }

    return result


@router.get("/status")
async def get_status() -> dict:
    return await _obs_or_disk_full(obs_queries.observability_status)


@router.get("/mcp-status")
async def get_mcp_status() -> dict:
    """Get MCP server status and loaded tools (read-only; never triggers MCP init)."""
    return await asyncio.to_thread(_build_mcp_status_payload)


@router.get("/overview")
async def get_overview(
    since_hours: float | None = Query(None, ge=0, le=24 * 90),
) -> dict:
    return await _obs_or_disk_full(obs_queries.fetch_overview, since_hours=since_hours)


@router.get("/dashboard")
async def get_dashboard(
    since_hours: float | None = Query(None, ge=0, le=24 * 90),
    agent_filter: str = Query("all", description="all or invocation_kind filter"),
) -> dict:
    from evoflow.observability.dashboard import fetch_dashboard_bundle

    return await _obs_or_disk_full(
        fetch_dashboard_bundle,
        since_hours=since_hours,
        agent_filter=agent_filter,
    )


@router.get("/gateway-requests/summary")
async def get_gateway_request_summary(
    since_hours: float | None = Query(24, ge=0, le=24 * 90),
) -> dict:
    return await _obs_or_disk_full(obs_queries.gateway_request_summary, since_hours=since_hours)


@router.get("/gateway-requests")
async def list_gateway_requests(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    path: str | None = None,
    method: str | None = None,
    status_code: int | None = Query(None, ge=100, le=599),
    status_family: str | None = Query(None, description="2xx / 3xx / 4xx / 5xx"),
    sort_by: str = Query("occurred_at", description="occurred_at (default) or duration_ms (slowest first)"),
    min_duration_ms: float | None = Query(None, ge=0),
    since_hours: float | None = Query(None, ge=0, le=24 * 90),
) -> dict:
    return await _obs_or_disk_full(
        obs_queries.list_gateway_requests,
        page=page,
        page_size=page_size,
        path=path,
        method=method,
        status_code=status_code,
        status_family=status_family,
        sort_by=sort_by,
        min_duration_ms=min_duration_ms,
        since_hours=since_hours,
    )


@router.get("/tools")
async def list_tools(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    thread_id: str | None = None,
    tool_name: str | None = None,
    status: str | None = None,
    sort_by: str = Query(
        "ended_at",
        description="ended_at (default, newest first) or duration_ms (slowest first)",
    ),
    min_duration_ms: float | None = Query(None, ge=0),
    since_hours: float | None = Query(None, ge=0, le=24 * 90),
    include_internal: bool = Query(False, description="Include scheduler:* internal tool rows"),
) -> dict:
    return await _obs_or_disk_full(
        obs_queries.list_tool_invocations,
        page=page,
        page_size=page_size,
        thread_id=thread_id,
        tool_name=tool_name,
        status=status,
        sort_by=sort_by,
        min_duration_ms=min_duration_ms,
        since_hours=since_hours,
        include_internal=include_internal,
    )


@router.get("/models")
async def list_models(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    thread_id: str | None = None,
    invocation_kind: str | None = None,
    provider: str | None = None,
    model: str | None = None,
    q: str | None = None,
    status: str | None = None,
    sort_by: str = Query(
        "requested_at",
        description="requested_at (default) or latency_ms (slowest first)",
    ),
    min_latency_ms: float | None = Query(None, ge=0),
    since_hours: float | None = Query(None, ge=0, le=24 * 90),
) -> dict:
    return await _obs_or_disk_full(
        obs_queries.list_model_invocations,
        page=page,
        page_size=page_size,
        thread_id=thread_id,
        invocation_kind=invocation_kind,
        provider=provider,
        model=model,
        q=q,
        status=status,
        sort_by=sort_by,
        min_latency_ms=min_latency_ms,
        since_hours=since_hours,
    )


@router.get("/models/summary")
async def get_models_summary(
    since_hours: float | None = Query(None, ge=0, le=24 * 90),
    agent_filter: str = Query("all"),
) -> dict:
    from evoflow.observability.summaries import fetch_models_summary

    return await _obs_or_disk_full(fetch_models_summary, since_hours=since_hours, agent_filter=agent_filter)


@router.get("/models/{row_id}")
async def get_model_detail(row_id: str) -> dict:
    """Fetch a single model invocation with full request_json / response_json."""
    row = await _obs_or_disk_full(obs_queries.get_model_invocation_detail, row_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Model invocation not found")
    return row


@router.get("/threads")
async def list_threads(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
) -> dict:
    return await _obs_or_disk_full(obs_queries.list_threads, page=page, page_size=page_size)


@router.get("/threads/{thread_id}/timeline")
async def thread_timeline(
    thread_id: str,
    limit: int = Query(200, ge=1, le=500),
) -> dict:
    return await _obs_or_disk_full(obs_queries.thread_timeline, thread_id, limit=limit)


@router.get("/insights")
async def get_insights(
    limit: int = Query(10, ge=1, le=50),
    since_hours: float | None = Query(24, ge=0, le=24 * 90),
) -> dict:
    """Global slow/error/token rankings for periodic AI analysis."""
    return await _obs_or_disk_full(obs_queries.fetch_insights, limit=limit, since_hours=since_hours)


@router.get("/threads/{thread_id}/insights")
async def get_thread_insights(
    thread_id: str,
    limit: int = Query(10, ge=1, le=50),
) -> dict:
    return await _obs_or_disk_full(obs_queries.thread_insights, thread_id, limit=limit)


@router.get("/report")
async def get_report(
    since_hours: float = Query(168, ge=0, le=24 * 90),
    limit: int = Query(10, ge=1, le=50),
) -> dict:
    """Seven-dimension bundle + rule-based recommendations for AI reviewers."""
    return await _obs_or_disk_full(obs_report.fetch_report, since_hours=since_hours, limit=limit)


@router.get("/eval-snapshot")
async def get_eval_snapshot(
    since_hours: float = Query(168, ge=0, le=24 * 90),
    limit: int = Query(10, ge=1, le=50),
    sample_k: int = Query(5, ge=1, le=20),
) -> dict:
    """Eval bundle: report + eval metrics + sampled threads with health_score and slim analysis."""
    return await _obs_or_disk_full(
        obs_eval.fetch_eval_snapshot,
        since_hours=since_hours,
        limit=limit,
        sample_k=sample_k,
    )


@router.get("/errors/summary")
async def get_errors_summary(
    since_hours: float = Query(168, ge=0, le=24 * 90),
) -> dict:
    return await _obs_or_disk_full(obs_queries.fetch_errors_summary, since_hours=since_hours)


@router.get("/trends")
async def get_trends(
    days: int = Query(7, ge=1, le=90),
    since_hours: float | None = Query(None, ge=0, le=24 * 90),
) -> dict:
    return await _obs_or_disk_full(obs_queries.fetch_trends, days=days, since_hours=since_hours)


@router.get("/waterfall/{thread_id}")
async def get_waterfall(thread_id: str) -> dict:
    """Per-thread latency waterfall: pre_model → model(TTFT + inference) → post_model."""
    return await _obs_or_disk_full(obs_waterfall.build_thread_waterfall, thread_id=thread_id)


@router.get("/waterfall-summary")
async def get_waterfall_summary(
    since_hours: float = Query(168, ge=0, le=24 * 90),
    sample_limit: int = Query(20, ge=1, le=100),
) -> dict:
    """Aggregate latency breakdown across recent threads, with bottleneck detection."""
    return await _obs_or_disk_full(
        obs_waterfall.build_waterfall_summary,
        since_hours=since_hours,
        sample_limit=sample_limit,
    )


@router.get("/agents/summary")
async def get_agents_summary(
    since_hours: float | None = Query(None, ge=0, le=24 * 90),
    agent_filter: str = Query("all"),
) -> dict:
    from evoflow.observability.summaries import fetch_agents_summary

    return await _obs_or_disk_full(fetch_agents_summary, since_hours=since_hours, agent_filter=agent_filter)


@router.get("/providers/summary")
async def get_providers_summary(
    since_hours: float | None = Query(None, ge=0, le=24 * 90),
) -> dict:
    from evoflow.observability.summaries import fetch_providers_summary

    return await _obs_or_disk_full(fetch_providers_summary, since_hours=since_hours)


@router.get("/tools/summary")
async def get_tools_summary(
    since_hours: float | None = Query(None, ge=0, le=24 * 90),
    tool_name: str | None = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
) -> dict:
    from evoflow.observability.summaries import fetch_tools_summary

    return await _obs_or_disk_full(fetch_tools_summary, since_hours=since_hours, tool_name=tool_name, page=page, page_size=page_size)


@router.get("/gateway-requests/hotspots")
async def get_gateway_request_hotspots(
    since_hours: float | None = Query(1, ge=0, le=24 * 90, description="Lookback window (default 1h)"),
    top_n: int = Query(15, ge=1, le=50),
    min_requests: int = Query(5, ge=1, le=1000),
    min_error_rate: float = Query(0.2, ge=0, le=1, description="Flag routes with error_rate >= this"),
    slow_avg_ms: float = Query(2000, ge=0, description="Flag routes with avg_duration_ms >= this"),
) -> dict:
    return await _obs_or_disk_full(
        obs_queries.gateway_request_hotspots,
        since_hours=since_hours,
        top_n=top_n,
        min_requests=min_requests,
        min_error_rate=min_error_rate,
        slow_avg_ms=slow_avg_ms,
    )


@router.get("/gateway-requests/by-route")
async def get_gateway_routes_summary(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    since_hours: float | None = Query(None, ge=0, le=24 * 90),
) -> dict:
    from evoflow.observability.summaries import fetch_gateway_routes_summary

    return await _obs_or_disk_full(
        fetch_gateway_routes_summary,
        page=page,
        page_size=page_size,
        since_hours=since_hours,
    )


@router.get("/threads/summary")
async def get_threads_summary(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    since_hours: float | None = Query(None, ge=0, le=24 * 90),
) -> dict:
    from evoflow.observability.summaries import fetch_threads_summary

    return await _obs_or_disk_full(
        fetch_threads_summary,
        page=page,
        page_size=page_size,
        since_hours=since_hours,
    )


@router.get("/analytics/summary")
async def get_analytics_summary(
    since_hours: float | None = Query(None, ge=0, le=24 * 90),
) -> dict:
    from evoflow.observability.summaries import fetch_analytics_summary

    return await _obs_or_disk_full(fetch_analytics_summary, since_hours=since_hours)


@router.get("/runtime-status")
async def get_runtime_status() -> dict:
    """聚合系统实时运行状态：自动化、任务队列、活跃会话、Channel 服务等。"""
    return await asyncio.to_thread(_build_runtime_status_payload)
