"""Product usage / cost ledger API (main app DB — not observability).

Access scoping: admins see all usage; regular users only see usage attributed
to their own ``principal_id`` (orphan/install-level rows are admin-only).
Isolation is always on.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query, Request

from evoflow.persistence.usage_ledger import (
    fetch_usage_by_category,
    fetch_usage_by_principal,
    fetch_usage_by_sku,
    fetch_usage_daily,
    fetch_usage_daily_by_sku,
    fetch_usage_summary,
)

router = APIRouter(prefix="/api/usage", tags=["usage"])


def _usage_scope(request: Request) -> dict[str, Any]:
    """Resolve (principal_id, include_orphan) for the current request.

    Returns ``{"principal_id": None, "include_orphan": True}`` for admins / full view,
    or ``{"principal_id": <pid>, "include_orphan": False}`` for a normal user.
    """
    try:
        from evoflow.authz.context import resolve_request_principal

        p = resolve_request_principal(request)
        uid = str((p or {}).get("principal_id") or "").strip() or None
        is_admin = bool((p or {}).get("principal_id") and __import__(
            "evoflow.authz.admin_grants", fromlist=["is_org_admin"]
        ).is_org_admin(uid) if uid else False)
    except Exception:
        uid = None
        is_admin = False
    if is_admin or not uid:
        return {"principal_id": None, "include_orphan": True}
    return {"principal_id": uid, "include_orphan": False}


@router.get("/summary")
async def get_usage_summary(
    request: Request,
    from_day: str | None = Query(None, alias="from", description="YYYY-MM-DD (UTC)"),
    to_day: str | None = Query(None, alias="to", description="YYYY-MM-DD (UTC)"),
    category: str | None = Query(None),
) -> dict[str, Any]:
    scope = _usage_scope(request)
    return fetch_usage_summary(
        from_day=from_day,
        to_day=to_day,
        category=category,
        principal_id=scope["principal_id"],
        include_orphan=scope["include_orphan"],
    )


@router.get("/daily")
async def get_usage_daily(
    request: Request,
    from_day: str | None = Query(None, alias="from"),
    to_day: str | None = Query(None, alias="to"),
    category: str | None = Query(None),
) -> dict[str, Any]:
    scope = _usage_scope(request)
    return fetch_usage_daily(
        from_day=from_day,
        to_day=to_day,
        category=category,
        principal_id=scope["principal_id"],
        include_orphan=scope["include_orphan"],
    )


@router.get("/daily-by-sku")
async def get_usage_daily_by_sku(
    request: Request,
    from_day: str | None = Query(None, alias="from"),
    to_day: str | None = Query(None, alias="to"),
    category: str | None = Query("llm"),
    top_n: int = Query(8, ge=1, le=20),
) -> dict[str, Any]:
    scope = _usage_scope(request)
    return fetch_usage_daily_by_sku(
        from_day=from_day,
        to_day=to_day,
        category=category,
        top_n=top_n,
        principal_id=scope["principal_id"],
        include_orphan=scope["include_orphan"],
    )


@router.get("/by-category")
async def get_usage_by_category(
    request: Request,
    from_day: str | None = Query(None, alias="from"),
    to_day: str | None = Query(None, alias="to"),
) -> dict[str, Any]:
    scope = _usage_scope(request)
    return fetch_usage_by_category(
        from_day=from_day,
        to_day=to_day,
        principal_id=scope["principal_id"],
        include_orphan=scope["include_orphan"],
    )


@router.get("/by-sku")
async def get_usage_by_sku(
    request: Request,
    from_day: str | None = Query(None, alias="from"),
    to_day: str | None = Query(None, alias="to"),
    category: str | None = Query("llm"),
) -> dict[str, Any]:
    scope = _usage_scope(request)
    return fetch_usage_by_sku(
        from_day=from_day,
        to_day=to_day,
        category=category,
        principal_id=scope["principal_id"],
        include_orphan=scope["include_orphan"],
    )


@router.get("/by-principal")
async def get_usage_by_principal(
    request: Request,
    from_day: str | None = Query(None, alias="from"),
    to_day: str | None = Query(None, alias="to"),
    category: str | None = Query(None),
    limit: int = Query(100, ge=1, le=500),
) -> dict[str, Any]:
    """Admin-only: cost / tokens broken down by user (principal)."""
    from fastapi import HTTPException

    try:
        from evoflow.authz.admin_grants import is_org_admin
        from evoflow.authz.context import resolve_request_principal

        p = resolve_request_principal(request)
        uid = str((p or {}).get("principal_id") or "").strip()
        if not uid or not is_org_admin(uid):
            raise HTTPException(status_code=403, detail="org_admin required")
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=403, detail="org_admin required")
    return fetch_usage_by_principal(
        from_day=from_day,
        to_day=to_day,
        category=category,
        limit=limit,
    )
