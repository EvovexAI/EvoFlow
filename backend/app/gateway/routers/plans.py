"""Gateway API for Plan Bundle (Connector mode)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from evoflow.authz.http_guard import require_org_admin
from evoflow.plans import service as plans_service
from evoflow.plans.errors import PlanError

router = APIRouter(prefix="/api/plans", tags=["plans"])


def _http_error(exc: PlanError) -> HTTPException:
    status = 400
    if exc.code.value in {"catalog_not_found", "binding_not_found", "plan_not_bound"}:
        status = 404
    return HTTPException(status_code=status, detail=exc.to_dict())


class CreateBindingBody(BaseModel):
    catalog_id: str = Field(..., min_length=1)
    api_key: str = Field(..., min_length=1)
    tier_id: str | None = None
    display_name: str | None = None
    bound_capabilities: list[str] | None = None
    overrides: dict[str, Any] | None = None


class PatchBindingBody(BaseModel):
    tier_id: str | None = None
    api_key: str | None = None
    display_name: str | None = None
    status: str | None = None
    bound_capabilities: list[str] | None = None
    overrides: dict[str, Any] | None = None
    rematerialize: bool | None = Field(
        default=None,
        description="Re-run vendor materialize (restore Plan URL + refill chat models)",
    )


@router.get("/catalog")
async def get_catalog() -> dict[str, Any]:
    return {"items": plans_service.list_catalog()}


@router.get("/bindings")
async def get_bindings(request: Request, include_disabled: bool = True) -> dict[str, Any]:
    require_org_admin(request)
    return {"items": plans_service.list_bindings(include_disabled=include_disabled)}


@router.get("/bindings/{binding_id}")
async def get_binding(request: Request, binding_id: str) -> dict[str, Any]:
    require_org_admin(request)
    try:
        return plans_service.get_binding(binding_id)
    except PlanError as exc:
        raise _http_error(exc) from exc


@router.post("/bindings")
async def create_binding(request: Request, body: CreateBindingBody) -> dict[str, Any]:
    require_org_admin(request)
    try:
        return plans_service.create_binding(body.model_dump(exclude_none=True))
    except PlanError as exc:
        raise _http_error(exc) from exc


@router.patch("/bindings/{binding_id}")
async def patch_binding(
    request: Request, binding_id: str, body: PatchBindingBody
) -> dict[str, Any]:
    require_org_admin(request)
    try:
        return plans_service.patch_binding(binding_id, body.model_dump(exclude_none=True))
    except PlanError as exc:
        raise _http_error(exc) from exc


@router.delete("/bindings/{binding_id}")
async def delete_binding(request: Request, binding_id: str) -> dict[str, Any]:
    require_org_admin(request)
    try:
        return plans_service.delete_binding(binding_id)
    except PlanError as exc:
        raise _http_error(exc) from exc


@router.get("/resolve")
async def resolve_route(
    request: Request,
    capability: str,
    vendor: str | None = None,
    binding_id: str | None = None,
) -> dict[str, Any]:
    require_org_admin(request)
    try:
        route = plans_service.resolve_capability(
            capability,
            vendor=vendor,
            binding_id=binding_id,
            allow_missing=True,
            redact_key=True,
        )
        return {"route": route}
    except PlanError as exc:
        raise _http_error(exc) from exc


class VerifyBindingBody(BaseModel):
    capabilities: list[str] | None = Field(
        default=None,
        description="Subset of capabilities to probe; default = all bound entitlements",
    )
    model_ids: list[str] | None = Field(
        default=None,
        description="Optional chat/embedding model ids or config names to probe",
    )


@router.post("/bindings/{binding_id}/verify")
async def verify_binding(
    request: Request, binding_id: str, body: VerifyBindingBody | None = None
) -> dict[str, Any]:
    """Live-probe Agent Plan capabilities (chat, embedding, TTS/ASR, image, …)."""
    require_org_admin(request)
    payload = body or VerifyBindingBody()
    try:
        return await plans_service.verify_binding(
            binding_id,
            capabilities=payload.capabilities,
            model_ids=payload.model_ids,
        )
    except PlanError as exc:
        raise _http_error(exc) from exc
