"""EvoPanel preferences stored in ``evoflow_app_settings`` (per principal)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from evoflow.authz.http_guard import resolve_authz_from_request
from evoflow.persistence.panel_settings import (
    DEFAULT_PANEL_SETTINGS,
    get_panel_settings,
    patch_panel_settings,
    replace_panel_settings,
)

router = APIRouter(prefix="/api/settings", tags=["settings"])


class PanelSettingsResponse(BaseModel):
    settings: dict[str, Any] = Field(default_factory=dict)
    defaults: dict[str, Any] = Field(default_factory=lambda: dict(DEFAULT_PANEL_SETTINGS))


class PanelSettingsPatchBody(BaseModel):
    settings: dict[str, Any] = Field(default_factory=dict)


def _principal_id(request: Request) -> str | None:
    authz = resolve_authz_from_request(request)
    pid = str(authz.get("principal_id") or "").strip()
    return pid or None


@router.get("/panel", response_model=PanelSettingsResponse)
async def get_panel_ui_settings(request: Request) -> PanelSettingsResponse:
    return PanelSettingsResponse(settings=get_panel_settings(_principal_id(request)))


@router.patch("/panel", response_model=PanelSettingsResponse)
async def patch_panel_ui_settings(
    request: Request, body: PanelSettingsPatchBody
) -> PanelSettingsResponse:
    return PanelSettingsResponse(
        settings=patch_panel_settings(body.settings, principal_id=_principal_id(request))
    )


@router.put("/panel", response_model=PanelSettingsResponse)
async def put_panel_ui_settings(
    request: Request, body: PanelSettingsPatchBody
) -> PanelSettingsResponse:
    return PanelSettingsResponse(
        settings=replace_panel_settings(
            body.settings or {}, principal_id=_principal_id(request)
        )
    )
