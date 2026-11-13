"""ChatGPT / Codex subscription auth for Settings → 模型."""

from __future__ import annotations

import logging
from typing import Any

from evoflow.authz.http_guard import require_org_admin
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/codex-auth", tags=["codex-auth"])


class LoginStartRequest(BaseModel):
    open_browser: bool = Field(default=False, description="Try opening the verification URL locally")


class LoginPollRequest(BaseModel):
    session_id: str = Field(..., min_length=1)


class EnsureModelRequest(BaseModel):
    model: str = Field(..., min_length=1, description="Authorized ChatGPT model slug")
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


def require_local_plan_admin(request: Request) -> None:
    require_org_admin(request)
    if request.client is None or request.client.host not in {"127.0.0.1", "::1"}:
        raise HTTPException(status_code=403, detail="ChatGPT plan settings are local to this installation.")


@router.get("/status")
async def codex_auth_status(http_request: Request) -> dict[str, Any]:
    require_local_plan_admin(http_request)
    from evoflow.models.chatgpt_plan_auth import auth_status

    return await run_in_threadpool(auth_status)


@router.post("/login/start")
async def codex_login_start(http_request: Request, body: LoginStartRequest) -> dict[str, Any]:
    require_local_plan_admin(http_request)
    from evoflow.models.chatgpt_plan_auth import CodexAuthError, start_login

    try:
        return await run_in_threadpool(start_login, open_browser=body.open_browser)
    except CodexAuthError as exc:
        raise _http_from_auth_error(exc) from exc


@router.post("/login/poll")
async def codex_login_poll(http_request: Request, body: LoginPollRequest) -> dict[str, Any]:
    require_local_plan_admin(http_request)
    from evoflow.models.chatgpt_plan_auth import poll_login

    return poll_login(body.session_id)


@router.delete("")
@router.post("/logout")
async def codex_logout(http_request: Request) -> dict[str, Any]:
    require_local_plan_admin(http_request)
    from evoflow.models.chatgpt_plan_auth import CodexAuthError, auth_status, logout

    try:
        await run_in_threadpool(logout)
    except CodexAuthError as exc:
        raise _http_from_auth_error(exc) from exc
    return await run_in_threadpool(auth_status)


@router.get("/models")
async def codex_list_models(http_request: Request) -> dict[str, Any]:
    require_local_plan_admin(http_request)
    from evoflow.models.codex_models import list_chatgpt_plan_models

    return await run_in_threadpool(list_chatgpt_plan_models)


@router.post("/ensure-model")
async def codex_ensure_model(http_request: Request, body: EnsureModelRequest) -> dict[str, Any]:
    """Create/update a Panel model row that uses the Codex Responses provider."""
    require_local_plan_admin(http_request)
    from evoflow.config import (
        add_model_to_config,
        get_app_config,
        reload_models_from_db,
        update_model_in_config,
    )
    from evoflow.models.chatgpt_plan_auth import API_BASE, auth_status
    from evoflow.models.codex_models import list_chatgpt_plan_models
    from evoflow.models.codex_oauth import codex_runtime_use_path
    from evoflow.persistence import config_repositories as cfg_repo

    status = await run_in_threadpool(auth_status)
    if not status.get("logged_in"):
        raise HTTPException(
            status_code=401,
            detail={
                "message": status.get("error") or "Not signed in",
                "code": status.get("error_code") or "codex_auth_missing",
            },
        )

    model_id = body.model.strip()
    catalog = await run_in_threadpool(list_chatgpt_plan_models)
    if not catalog["success"]:
        raise HTTPException(status_code=401 if catalog.get("relogin_required") else 502, detail=catalog["message"])
    meta = next((model for model in catalog["models"] if model["slug"] == model_id), None)
    if meta is None:
        raise HTTPException(status_code=400, detail="The model is unavailable to this ChatGPT plan.")
    name = f"codex-{model_id}".replace("/", "-").replace(" ", "-")
    display = (body.display_name or "").strip() or str(meta.get("display_name") or "").strip() or f"Codex {model_id}"
    use_path = codex_runtime_use_path()
    context_length = meta.get("resolved_context_window") or meta.get("context_window")
    row = {
        "name": name,
        "vendor": "openai-codex",
        "model": model_id,
        "display_name": display,
        "description": "ChatGPT plan via Sign in with ChatGPT",
        "use": use_path,
        "base_url": API_BASE,
        "api_key": "",
        "supports_thinking": bool(meta.get("supports_reasoning", True)),
        "supports_reasoning_effort": bool(meta.get("supports_reasoning", True)),
        "supports_vision": bool(meta.get("supports_vision", True)),
        "request_timeout": 300.0,
        "max_retries": 2,
    }
    if isinstance(context_length, int) and context_length > 0:
        row["context_length"] = context_length

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
