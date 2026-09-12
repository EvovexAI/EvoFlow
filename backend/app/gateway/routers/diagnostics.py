"""System log diagnostics API — known sources, anomaly scan, shareable timeline."""

from __future__ import annotations

from fastapi import APIRouter, Query, Depends, Request

from evoflow.admin import diagnostics as diag


from evoflow.authz.http_guard import require_org_admin


def _org_admin_dep(request: Request) -> None:
    require_org_admin(request)

router = APIRouter(prefix="/api/diagnostics", tags=["diagnostics"], dependencies=[Depends(_org_admin_dep)])


@router.get("/sources")
def diagnostics_sources(
    hours: int = Query(72, ge=1, le=24 * 14, description="Lookback window in hours"),
) -> dict:
    """List known log sources and which ones have recent ERROR/WARN lines."""
    return {"ok": True, **diag.list_sources(hours=hours)}


@router.get("/scan")
def diagnostics_scan(
    hours: int = Query(24, ge=1, le=24 * 14),
    sources: str | None = Query(
        None,
        description="Comma-separated source ids, e.g. gateway,frontend",
    ),
    max_events: int = Query(200, ge=1, le=1000, alias="limit"),
) -> dict:
    """Scan recent ERROR/WARN/anomaly lines from known log files."""
    src_list = None
    if sources and sources.strip():
        src_list = [p.strip() for p in sources.replace(";", ",").split(",") if p.strip()]
    return diag.scan_errors(hours=hours, sources=src_list, max_events=max_events)


@router.get("/timeline")
def diagnostics_timeline(
    hours: int = Query(24, ge=1, le=24 * 14),
    sources: str | None = Query(None, description="Comma-separated source ids"),
    max_events: int = Query(80, ge=1, le=500, alias="limit"),
    format: str = Query("both", description="both | markdown | json"),
) -> dict:
    """Build a shareable anomaly timeline (markdown + events)."""
    src_list = None
    if sources and sources.strip():
        src_list = [p.strip() for p in sources.replace(";", ",").split(",") if p.strip()]
    return diag.anomaly_timeline(
        hours=hours,
        sources=src_list,
        max_events=max_events,
        format=format,
    )


@router.get("/run")
def diagnostics_run(
    focus: str | None = Query(None, description="重点关注模块：员工/对话/定时/知识库/模型"),
) -> dict:
    """Comprehensive system diagnosis: check all module health in one call."""
    from evoflow.admin import platform_handlers as H

    return H.diagnostics_run({"focus": focus or ""})
