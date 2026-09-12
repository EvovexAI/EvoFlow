"""Gateway API for user-defined environment variables (EvoPanel settings)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from evoflow.authz.http_guard import require_org_admin
from evoflow.persistence.custom_env_settings import (
    DEFAULT_CUSTOM_ENV,
    get_custom_env_settings,
    get_custom_env_settings_masked,
    replace_custom_env_vars,
)
from evoflow.persistence.custom_env_validation import verify_custom_env_vars
from evoflow.persistence.runtime_env import apply_runtime_env_to_environ

router = APIRouter(prefix="/api/settings", tags=["settings"])


class CustomEnvVarItem(BaseModel):
    key: str = ""
    value: str = ""


class CustomEnvResponse(BaseModel):
    vars: list[dict[str, Any]] = Field(default_factory=list)
    defaults: dict[str, Any] = Field(default_factory=lambda: dict(DEFAULT_CUSTOM_ENV))


class CustomEnvPutBody(BaseModel):
    vars: list[CustomEnvVarItem] = Field(default_factory=list)


class CustomEnvVerifyResultItem(BaseModel):
    key: str = ""
    ok: bool = False
    message: str = ""
    skipped: bool = False


class CustomEnvVerifyResponse(BaseModel):
    results: list[CustomEnvVerifyResultItem] = Field(default_factory=list)


@router.get("/custom-env", response_model=CustomEnvResponse)
async def get_custom_env_api(request: Request) -> CustomEnvResponse:
    require_org_admin(request)
    apply_runtime_env_to_environ()
    return CustomEnvResponse(
        vars=get_custom_env_settings_masked().get("vars", []),
        defaults=dict(DEFAULT_CUSTOM_ENV),
    )


@router.get("/custom-env/raw", response_model=CustomEnvResponse)
async def get_custom_env_raw_api(request: Request) -> CustomEnvResponse:
    """Return unmasked values for settings editor (local gateway only)."""
    require_org_admin(request)
    apply_runtime_env_to_environ()
    return CustomEnvResponse(vars=get_custom_env_settings().get("vars", []))


@router.put("/custom-env", response_model=CustomEnvResponse)
async def put_custom_env_api(request: Request, body: CustomEnvPutBody) -> CustomEnvResponse:
    require_org_admin(request)
    payload = [{"key": v.key, "value": v.value} for v in body.vars]
    replace_custom_env_vars(payload)
    apply_runtime_env_to_environ()
    return CustomEnvResponse(vars=get_custom_env_settings().get("vars", []))


@router.post("/custom-env/verify", response_model=CustomEnvVerifyResponse)
async def verify_custom_env_api(request: Request, body: CustomEnvPutBody) -> CustomEnvVerifyResponse:
    require_org_admin(request)
    payload = [{"key": v.key, "value": v.value} for v in body.vars]
    raw = verify_custom_env_vars(payload)
    return CustomEnvVerifyResponse(
        results=[CustomEnvVerifyResultItem(**item) for item in raw]
    )
