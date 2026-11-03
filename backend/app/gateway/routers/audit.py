"""Operation audit log — admin read API (append-only store, see audit_log.py)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query

from app.gateway.deps.license import require_premium
from evoflow.authz.http_guard import require_org_admin
from evoflow.persistence import audit_log

router = APIRouter(
    prefix="/api/audit",
    tags=["audit"],
    dependencies=[Depends(require_premium)],
)


@router.get("/actions")
def list_audit_actions_endpoint(
    request: Any,
    resource_type: str | None = Query(None),
    resource_id: str | None = Query(None),
    action: str | None = Query(None),
    actor_id: str | None = Query(None),
    limit: int = Query(100, ge=1, le=500),
) -> dict[str, Any]:
    """Newest-first audit rows.

    权限：指定单资源（resource_type=app + resource_id）时，对该应用可见即可读
    （与详情页可见性一致）；不带资源过滤的全局列表仍 org-admin 专属。
    """
    if resource_type == "app" and resource_id:
        from evoflow.authz.http_guard import require_app_visible

        require_app_visible(request, resource_id)
    else:
        require_org_admin(request)
    items = audit_log.list_actions(
        resource_type=resource_type,
        resource_id=resource_id,
        action=action,
        actor_id=actor_id,
        limit=limit,
    )
    return {"items": items, "count": len(items)}
