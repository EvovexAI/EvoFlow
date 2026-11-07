"""ChatGPT / Codex subscription auth for Settings → 模型."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from evoflow.authz.http_guard import require_org_admin

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/codex-auth", tags=["codex-auth"])


class DeviceStartRequest(BaseModel):
    open_browser: bool = Field(default=False, description="Try opening the verification URL locally")


class DevicePollRequest(BaseModel):
    session_id: str = Field(..., min_length=1)


class EnsureModelRequest(BaseModel):
    model: str = Field(default="gpt-5.4", description="Codex model id")
    display_name: str | None = Field(default=None)
    set_primary: bool = Field(default=False)


def _http_from_auth_error(exc: Exception) -> HTTPException:
    from evoflow.models.codex_oauth import CodexAuthError

    if isinstance(exc, CodexAuthError):
        status = 429 if exc.code == "codex_rate_limited" else (401 if exc.relogin_required else 400)
        detail: dict[str, Any] = {"message": str(exc), "code": exc.code, "relogin_required": exc.relogin_required}
        if exc.retry_after is not None:
            detail["retry_after"] = exc.retry_after
        return HTTPException(status_code=status, detail=detail)
    return HTTPException(status_code=500, detail=str(exc))


@router.get("/status")
async def codex_auth_status(http_request: Request) -> dict[str, Any]:
    require_org_admin(http_request)
    from evoflow.models.codex_oauth import get_auth_status

    return get_auth_status()


@router.post("/device/start")
async def codex_device_start(http_request: Request, body: DeviceStartRequest) -> dict[str, Any]:
    require_org_admin(http_request)
    from evoflow.models.codex_oauth import CodexAuthError, start_device_login

    try:
        return start_device_login(open_browser=body.open_browser)
    except CodexAuthError as exc:
        raise _http_from_auth_error(exc) from exc


@router.post("/device/poll")
async def codex_device_poll(http_request: Request, body: DevicePollRequest) -> dict[str, Any]:
    require_org_admin(http_request)
    from evoflow.models.codex_oauth import CodexAuthError, poll_device_login

    try:
        return poll_device_login(body.session_id)
    except CodexAuthError as exc:
        raise _http_from_auth_error(exc) from exc


@router.post("/import-cli")
async def codex_import_cli(http_request: Request) -> dict[str, Any]:
    require_org_admin(http_request)
    from evoflow.models.codex_oauth import CodexAuthError, import_cli_and_save

    try:
        return import_cli_and_save()
    except CodexAuthError as exc:
        raise _http_from_auth_error(exc) from exc


@router.post("/refresh")
async def codex_refresh(http_request: Request) -> dict[str, Any]:
    require_org_admin(http_request)
    from evoflow.models.codex_oauth import CodexAuthError, get_auth_status, resolve_runtime_tokens

    try:
        resolve_runtime_tokens(force_refresh=True, refresh_if_expiring=True)
        return get_auth_status()
    except CodexAuthError as exc:
        raise _http_from_auth_error(exc) from exc


@router.delete("")
@router.post("/logout")
async def codex_logout(http_request: Request) -> dict[str, Any]:
    require_org_admin(http_request)
    from evoflow.models.codex_oauth import clear_auth_store, get_auth_status

    cleared = clear_auth_store()
    status = get_auth_status()
    status["cleared"] = cleared
    return status


@router.post("/ensure-model")
async def codex_ensure_model(http_request: Request, body: EnsureModelRequest) -> dict[str, Any]:
    """Create/update a Panel model row that uses the Codex Responses provider."""
    require_org_admin(http_request)
    from evoflow.config import (
        add_model_to_config,
        get_app_config,
        reload_models_from_db,
        update_model_in_config,
    )
    from evoflow.models.codex_oauth import DEFAULT_CODEX_BASE_URL, codex_runtime_use_path, get_auth_status
    from evoflow.persistence import config_repositories as cfg_repo

    status = get_auth_status()
    if not status.get("logged_in"):
        raise HTTPException(
            status_code=401,
            detail={
                "message": status.get("error") or "Not signed in",
                "code": status.get("error_code") or "codex_auth_missing",
            },
        )

    model_id = str(body.model or "gpt-5.4").strip() or "gpt-5.4"
    name = f"codex-{model_id}".replace("/", "-").replace(" ", "-")
    display = (body.display_name or "").strip() or f"Codex {model_id}"
    use_path = codex_runtime_use_path()
    row = {
        "name": name,
        "vendor": "openai-codex",
        "model": model_id,
        "display_name": display,
        "description": "ChatGPT / Codex subscription (OAuth)",
        "use": use_path,
        "base_url": DEFAULT_CODEX_BASE_URL,
        "api_key": "",
        "supports_thinking": True,
        "supports_reasoning_effort": True,
        "supports_vision": True,
        "request_timeout": 300.0,
        "max_retries": 2,
    }

    try:
        config = get_app_config()
        existing = config.get_model_config(name)
        if existing is None:
            add_model_to_config(row)
            created = True
        else:
            update_model_in_config(name, row)
            created = False
        reload_models_from_db()

        if body.set_primary:
            config = get_app_config()
            config.primary_model = name
            cfg_repo.set_app_setting("primary_model", name)

        return {
            "ok": True,
            "created": created,
            "model_name": name,
            "primary_model": name if body.set_primary else None,
            "use": use_path,
            "auth": status,
        }
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("ensure-model failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc
