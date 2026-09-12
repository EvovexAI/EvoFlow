from __future__ import annotations

from fastapi import APIRouter, Query, Depends, Request

from app.gateway.hang_diagnostics import dump_gateway_diagnostics


from evoflow.authz.http_guard import require_org_admin


def _org_admin_dep(request: Request) -> None:
    require_org_admin(request)

router = APIRouter(prefix="/api/debug/hang-diagnostics", tags=["debug"], dependencies=[Depends(_org_admin_dep)])


@router.post("/dump")
async def dump_hang_diagnostics(reason: str = Query(default="manual")) -> dict[str, str | bool]:
    path = dump_gateway_diagnostics(reason=f"manual:{reason}")
    if path is None:
        return {"ok": False, "detail": "diagnostics disabled or dump suppressed by min interval"}
    return {"ok": True, "path": str(path)}
