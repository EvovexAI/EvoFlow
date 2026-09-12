"""HTTP projection of the in-agent ``platform`` tool.

Lets scripts / curl / external agents drive the same ``dispatch_platform_action``
registry the assistant uses (including ``verification.*``).
"""

from __future__ import annotations

import json
from typing import Any

from fastapi import Request, APIRouter, HTTPException
from evoflow.authz.http_guard import require_org_admin
from pydantic import BaseModel, Field

from evoflow.admin.errors import AdminError, NotFoundError, ValidationError
from evoflow.admin.platform_actions import build_catalog, dispatch_platform_action

router = APIRouter(prefix="/api/platform", tags=["platform"])


class PlatformInvokeBody(BaseModel):
    action: str = Field(..., description="catalog | help | knowledge.list | verification.init | …")
    args: dict[str, Any] | None = Field(
        default=None,
        description="Action args as a JSON object (preferred over args_json)",
    )
    args_json: str | None = Field(
        default=None,
        description="Optional JSON object string; used when args is omitted",
    )
    domain: str | None = Field(default=None, description="For catalog/help filtering")
    confirm: bool = Field(
        default=False,
        description="Required true for write/destructive actions",
    )


@router.get("/catalog")
def platform_catalog(request: Request, domain: str | None = None, detailed: bool = False) -> dict[str, Any]:
    """Shortcut for platform catalog (same as action=catalog)."""
    require_org_admin(request)
    return build_catalog(domain=domain, detailed=detailed or bool(domain))


@router.post("")
@router.post("/")
def platform_invoke(request: Request, body: PlatformInvokeBody) -> dict[str, Any]:
    """Invoke a platform action — same backend as the assistant ``platform`` tool."""
    require_org_admin(request)
    action = (body.action or "").strip()
    if not action:
        raise HTTPException(status_code=400, detail="action is required")

    if body.args is not None:
        try:
            args_json = json.dumps(body.args, ensure_ascii=False)
        except (TypeError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=f"args not JSON-serializable: {exc}") from exc
    else:
        args_json = body.args_json or ""

    try:
        return dispatch_platform_action(
            action,
            args_json=args_json,
            domain=body.domain,
            confirm=bool(body.confirm),
        )
    except ValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except NotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except AdminError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
