"""Gateway API for media provider credentials (EvoPanel settings)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from evoflow.authz.http_guard import require_org_admin
from evoflow.community.media_generation.config_helpers import available_media_providers
from evoflow.persistence.media_settings import (
    DEFAULT_MEDIA_CREDENTIALS,
    get_media_credentials_masked,
    patch_media_credentials,
)
from evoflow.persistence.runtime_env import apply_runtime_env_to_environ

router = APIRouter(prefix="/api/settings", tags=["settings"])


class MediaCredentialsResponse(BaseModel):
    credentials: dict[str, Any] = Field(default_factory=dict)
    defaults: dict[str, Any] = Field(default_factory=lambda: dict(DEFAULT_MEDIA_CREDENTIALS))
    available_providers: dict[str, list[str]] = Field(default_factory=dict)


class MediaCredentialsPatchBody(BaseModel):
    credentials: dict[str, Any] = Field(default_factory=dict)


@router.get("/media", response_model=MediaCredentialsResponse)
async def get_media_credentials_api(request: Request) -> MediaCredentialsResponse:
    require_org_admin(request)
    apply_runtime_env_to_environ()
    return MediaCredentialsResponse(
        credentials=get_media_credentials_masked(),
        available_providers=available_media_providers(),
    )


@router.patch("/media", response_model=MediaCredentialsResponse)
async def patch_media_credentials_api(
    request: Request, body: MediaCredentialsPatchBody
) -> MediaCredentialsResponse:
    require_org_admin(request)
    patch_media_credentials(body.credentials)
    apply_runtime_env_to_environ()
    return MediaCredentialsResponse(
        credentials=get_media_credentials_masked(),
        available_providers=available_media_providers(),
    )
