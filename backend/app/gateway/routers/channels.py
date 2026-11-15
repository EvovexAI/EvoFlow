"""Gateway router for IM channel management."""

from __future__ import annotations

import hmac
import logging
import os
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from evoflow.authz.http_guard import require_org_admin

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/channels", tags=["channels"])


class ChannelStatusResponse(BaseModel):
    service_running: bool
    channels: dict[str, dict]


class ChannelRestartResponse(BaseModel):
    success: bool
    message: str


class ChannelEnableRequest(BaseModel):
    enabled: bool


class ChannelEnableResponse(BaseModel):
    success: bool
    message: str
    enabled: bool


class ChannelConfigResponse(BaseModel):
    name: str
    enabled: bool
    running: bool
    config: dict[str, Any]


class FeishuPushRequest(BaseModel):
    """Body for proactive Feishu push (interactive markdown card)."""

    text: str = Field(..., min_length=1, max_length=49_000, description="Markdown body shown in the card")
    receive_id: str = Field(..., min_length=1, description="Target id (e.g. group chat_id)")
    receive_id_type: str = Field(
        default="chat_id",
        min_length=1,
        max_length=32,
        description="Feishu receive_id_type, e.g. chat_id, open_id, union_id",
    )


class FeishuPushResponse(BaseModel):
    success: bool
    message: str


class FeishuRegistrationBeginResponse(BaseModel):
    session_id: str
    qr_url: str = Field(..., description="Scan this URL with Feishu app to create and authorize the bot")
    status: str = "pending"


class FeishuRegistrationPollResponse(BaseModel):
    session_id: str
    status: str = Field(..., description="pending | scanning | completed | failed | expired")
    app_id: str | None = None
    app_secret: str | None = None
    error: str | None = None


class FeishuRegistrationApplyResponse(BaseModel):
    success: bool
    message: str
    channel_running: bool = False


class FeishuRegistrationApplyRequest(BaseModel):
    enabled: bool = Field(default=True, description="Whether to enable the Feishu channel after applying credentials")


class WeixinRegistrationBeginResponse(BaseModel):
    session_id: str
    qr_url: str = Field(..., description="URL or payload to render as QR (iLink get_bot_qrcode response)")
    status: str = "pending"


class WeixinRegistrationPollResponse(BaseModel):
    session_id: str
    status: str = Field(..., description="pending | scanning | completed | failed | expired")
    qr_url: str | None = Field(
        default=None,
        description="Present while pending/scanning so the UI can refresh the image after server-side QR refresh",
    )
    account_id: str | None = None
    token: str | None = None
    base_url: str | None = None
    user_id: str | None = None
    error: str | None = None


class WeixinRegistrationApplyRequest(BaseModel):
    enabled: bool = Field(default=True, description="Whether to enable the Weixin channel after applying credentials")
    agent_code: str = Field(
        default="",
        max_length=64,
        description=(
            "If set, the WeChat bot is bound to this proactive employee agent and its messages "
            "route to that agent. Empty string (default) binds it to the channel-wide main "
            "agent (lead_agent) — 多账号默认都接主智能体."
        ),
    )
    display_name: str = Field(
        default="",
        max_length=64,
        description="Optional human-friendly label for this WeChat binding (shown in the accounts list).",
    )


class WeixinRegistrationApplyResponse(BaseModel):
    success: bool
    message: str
    channel_running: bool = False


class WeixinAccountOut(BaseModel):
    """One WeChat (iLink) bot binding in the multi-account list."""

    account_id: str = Field(..., description="iLink bot id — the weixin account slot key")
    agent_code: str = ""
    is_main_agent: bool = Field(default=True, description="True when agent_code is empty (routes to the main agent)")
    display_name: str = ""
    bot_id_suffix: str = ""
    enabled: bool = True
    bound_at: str = ""
    base_url: str = ""
    running: bool = Field(default=False, description="Whether the ``weixin:<account_id>`` channel instance is live")
    role_name: str = Field(default="", description="Employee role_name when agent_code is set")


class WeixinAccountsResponse(BaseModel):
    success: bool = True
    accounts: list[WeixinAccountOut]


class WeixinAccountPatchRequest(BaseModel):
    """Partial update of one WeChat binding (rename / enable / 改绑 employee)."""

    display_name: str | None = Field(default=None, max_length=64)
    enabled: bool | None = None
    agent_code: str | None = Field(
        default=None,
        max_length=64,
        description="New employee binding. ``\"\"`` re-routes the bot to the main agent.",
    )


class WeixinAccountPatchResponse(BaseModel):
    success: bool
    message: str
    account: WeixinAccountOut | None = None


class WeixinAccountDeleteResponse(BaseModel):
    success: bool
    message: str


class WecomRegistrationBeginResponse(BaseModel):
    session_id: str
    qr_url: str = Field(..., description="URL rendered into the QR. WeCom mobile app scans this directly.")
    fallback_url: str = Field(
        ...,
        description="Human-openable HTML landing page URL. Keep as a '点此打开' fallback link in the UI for scanners that don't recognize qr_url as a deep link.",
    )
    status: str = "pending"


class WecomRegistrationPollResponse(BaseModel):
    session_id: str
    status: str = Field(..., description="pending | scanning | completed | failed | expired")
    qr_url: str | None = Field(
        default=None,
        description="Present while pending/scanning so the UI can refresh the image after server-side QR refresh",
    )
    bot_id: str | None = None
    secret: str | None = None
    error: str | None = None


class WecomRegistrationApplyRequest(BaseModel):
    enabled: bool = Field(default=True, description="Whether to enable the WeCom channel after applying credentials")
    agent_code: str = Field(
        default="",
        description=(
            "If set, the resulting bot is bound to this proactive employee agent and stored "
            "under ``channels.wecom.accounts[<agent_code>]`` so its messages route to that "
            "agent. Empty string means the channel-wide primary bot."
        ),
    )


class WecomRegistrationApplyResponse(BaseModel):
    success: bool
    message: str
    channel_running: bool = False


class DingtalkRegistrationBeginResponse(BaseModel):
    session_id: str
    qr_url: str = Field(..., description="URL to render as QR (DingTalk device-flow authorization)")
    status: str = "pending"


class DingtalkRegistrationPollResponse(BaseModel):
    session_id: str
    status: str = Field(..., description="pending | scanning | completed | failed | expired")
    qr_url: str | None = Field(
        default=None,
        description="Present while pending/scanning so the UI can refresh the image after server-side QR refresh",
    )
    client_id: str | None = None
    client_secret: str | None = None
    error: str | None = None


class DingtalkRegistrationApplyRequest(BaseModel):
    enabled: bool = Field(default=True, description="Whether to enable the DingTalk channel after applying credentials")


class DingtalkRegistrationApplyResponse(BaseModel):
    success: bool
    message: str
    channel_running: bool = False


def _channels_section_from_app_config(cfg: Any) -> dict[str, Any] | None:
    """Resolve ``channels`` from AppConfig (extras may live on ``model_extra``, as attributes, or in ``model_dump()``)."""
    ch = getattr(cfg, "channels", None)
    if isinstance(ch, dict):
        return ch
    extra = getattr(cfg, "model_extra", None) or {}
    if isinstance(extra, dict):
        nested = extra.get("channels")
        if isinstance(nested, dict):
            return nested
    if hasattr(cfg, "model_dump"):
        dumped = cfg.model_dump(mode="json")
        if isinstance(dumped, dict):
            nested = dumped.get("channels")
            if isinstance(nested, dict):
                return nested
    return None


def get_feishu_push_secret() -> str | None:
    """Return configured secret for POST /api/channels/feishu/push, or None if disabled."""
    from evoflow.config.app_config import get_app_config

    cfg = get_app_config()
    channels = _channels_section_from_app_config(cfg)
    if isinstance(channels, dict):
        feishu = channels.get("feishu")
        if isinstance(feishu, dict):
            raw = feishu.get("push_secret")
            if raw is not None and str(raw).strip():
                return str(raw).strip()
    env = os.getenv("EVOFLOW_FEISHU_PUSH_SECRET", "").strip()
    return env or None


def get_feishu_automation_default_chat_id() -> str | None:
    """Default Feishu ``chat_id`` for automation push when ``feishu_push_enabled`` is on.

    Resolution order:

    1. ``channels.feishu.automation_push_chat_id`` in ``config.yaml`` if set (optional admin override).
    2. Learned Feishu ``chat_id`` on this machine: persisted under ``{paths.base_dir}/state/`` (see
       :mod:`app.channels.feishu_automation_learned_chat`), updated when inbound ``chat_id`` changes.
    """
    from evoflow.config.app_config import get_app_config

    cfg = get_app_config()
    channels = _channels_section_from_app_config(cfg)
    if isinstance(channels, dict):
        feishu = channels.get("feishu")
        if isinstance(feishu, dict):
            raw = feishu.get("automation_push_chat_id")
            if raw is not None and str(raw).strip():
                return str(raw).strip()
    try:
        from app.channels.feishu_automation_learned_chat import read_learned_feishu_automation_chat_id

        learned = read_learned_feishu_automation_chat_id()
        if learned:
            return learned
    except Exception:
        logger.debug("read learned feishu automation chat_id failed", exc_info=True)
    return None


def _extract_request_push_secret(request: Request) -> str | None:
    direct = (request.headers.get("X-EvoFlow-Feishu-Push-Secret") or "").strip()
    if direct:
        return direct
    auth = request.headers.get("Authorization") or ""
    if len(auth) > 7 and auth[:7].lower() == "bearer ":
        return auth[7:].strip()
    return None


def _secrets_equal(expected: str, provided: str | None) -> bool:
    if not provided:
        return False
    try:
        return hmac.compare_digest(expected.encode("utf-8"), provided.encode("utf-8"))
    except Exception:
        return False


@router.get("", response_model=ChannelStatusResponse)
@router.get("/", response_model=ChannelStatusResponse)
async def get_channels_status() -> ChannelStatusResponse:
    """Get the status of all IM channels.

    Starting the channel service here must never block the response: the
    background startup path waits on ``langgraph_ready_event``, so an inline
    ``await start_channel_service()`` could hold the panel for minutes on a
    cold gateway. Kick it as a background task and answer with registry
    defaults immediately.
    """
    import asyncio

    from app.channels.service import (
        get_channel_service,
        registry_channel_status,
        start_channel_service,
    )

    service = get_channel_service()
    if service is None:
        try:
            asyncio.create_task(start_channel_service())
        except Exception:
            logger.exception("Background channel service start failed to schedule")
        return ChannelStatusResponse(**registry_channel_status(service_running=False))
    status = service.get_status()
    return ChannelStatusResponse(**status)


@router.get("/push-targets")
async def list_channel_push_targets(request: Request, limit: int = 200) -> dict[str, Any]:
    """List IM sessions available as result-push destinations."""
    require_org_admin(request)
    from app.gateway.channel_result_push import list_push_targets

    return {"targets": list_push_targets(limit=limit)}


class _PushToOriginRequest(BaseModel):
    """Body for ``POST /api/channels/push-to-origin``."""

    session_key: str = Field(..., min_length=1, description="IM session_key whose origin chat/bot should receive the push")
    text: str = Field(default="", description="Markdown body")
    paths: list[str] = Field(default_factory=list, description="Local files/images to attach")
    title: str = Field(default="", description="Optional bold title prepended to the body")


@router.post("/push-to-origin")
async def push_to_origin(body: _PushToOriginRequest) -> dict[str, Any]:
    """Bridge for processes that own no ChannelService (LangGraph / harness tools).

    ``channels.send_message`` runs inside the agent process, where the
    ``channels.push_to_inbound_origin`` runtime port is never registered (the
    adapter is installed by ``create_app()`` in the Gateway). Without this route
    the tool answered "channel push adapter not registered" and nothing was sent,
    even with Feishu healthy.

    Routing stays authoritative on the Gateway: the session index written on
    inbound decides chat + bot, so callers still cannot pick a bot.
    """
    from app.gateway.channel_result_push import push_to_inbound_origin

    result = await push_to_inbound_origin(
        session_key=body.session_key,
        text=body.text,
        paths=list(body.paths or []),
        title=body.title,
    )
    return result if isinstance(result, dict) else {"ok": False, "error": "push_failed"}


@router.get("/messages")
async def list_channel_messages(
    request: Request,
    page: int = 1,
    page_size: int = 50,
    channel: str | None = None,
    direction: str | None = None,
    status: str | None = None,
    kind: str | None = None,
    task_id: str | None = None,
    since_hours: float | None = None,
    q: str | None = None,
) -> dict[str, Any]:
    """Paginated IM channel message audit (inbound/outbound) for ops observability."""
    require_org_admin(request)
    from evoflow.persistence.channel_push_repositories import list_paginated

    return list_paginated(
        page=page,
        page_size=page_size,
        channel=channel,
        direction=direction,
        status=status,
        kind=kind,
        task_id=task_id,
        since_hours=since_hours,
        q=q,
    )


@router.get("/bindings")
async def list_channel_bindings(
    request: Request,
    channel: str | None = None,
    q: str | None = None,
) -> dict[str, Any]:
    """Employee ↔ IM bot bindings for ops (how / status / who / when)."""
    require_org_admin(request)
    from evoflow.persistence.channel_push_repositories import list_channel_bindings as _list

    return _list(channel=channel, q=q)


@router.post("/{name}/restart", response_model=ChannelRestartResponse)
async def restart_channel(request: Request, name: str) -> ChannelRestartResponse:
    """Restart a specific IM channel."""
    require_org_admin(request)
    from app.channels.service import get_channel_service

    service = get_channel_service()
    if service is None:
        raise HTTPException(status_code=503, detail="Channel service is not running")

    success = await service.restart_channel(name)
    if success:
        logger.info("Channel %s restarted successfully", name)
        return ChannelRestartResponse(success=True, message=f"Channel {name} restarted successfully")
    else:
        logger.warning("Failed to restart channel %s", name)
        return ChannelRestartResponse(success=False, message=f"Failed to restart channel {name}")


@router.post("/{name}/enable", response_model=ChannelEnableResponse)
async def enable_channel(http_request: Request, name: str, request: ChannelEnableRequest) -> ChannelEnableResponse:
    """Enable or disable a specific IM channel."""
    require_org_admin(http_request)
    from app.channels.service import get_channel_service

    service = get_channel_service()
    if service is None:
        raise HTTPException(status_code=503, detail="Channel service is not running")

    success = await service.set_channel_enabled(name, request.enabled)
    if success:
        action = "enabled" if request.enabled else "disabled"
        logger.info("Channel %s %s successfully", name, action)
        return ChannelEnableResponse(success=True, message=f"Channel {name} {action} successfully", enabled=request.enabled)
    else:
        action = "enable" if request.enabled else "disable"
        logger.warning("Failed to %s channel %s", action, name)
        return ChannelEnableResponse(success=False, message=f"Failed to {action} channel {name}", enabled=request.enabled)


@router.get("/{name}/config", response_model=ChannelConfigResponse)
async def get_channel_config(request: Request, name: str) -> ChannelConfigResponse:
    """Get the configuration of a specific IM channel."""
    require_org_admin(request)
    from app.channels.service import get_channel_service

    service = get_channel_service()
    if service is None:
        raise HTTPException(status_code=503, detail="Channel service is not running")

    config, enabled, running = service.get_channel_config(name)
    return ChannelConfigResponse(name=name, enabled=enabled, running=running, config=config or {})


@router.put("/{name}/config", response_model=ChannelRestartResponse)
async def update_channel_config(request: Request, name: str, config: dict[str, Any]) -> ChannelRestartResponse:
    """Update the configuration of a specific IM channel."""
    require_org_admin(request)
    from app.channels.service import get_channel_service

    service = get_channel_service()
    if service is None:
        raise HTTPException(status_code=503, detail="Channel service is not running")

    success = await service.update_channel_config(name, config)
    if success:
        logger.info("Channel %s config updated successfully", name)
        return ChannelRestartResponse(success=True, message=f"Channel {name} config updated successfully")
    else:
        logger.warning("Failed to update channel %s config", name)
        return ChannelRestartResponse(success=False, message=f"Failed to update channel {name} config")


@router.post("/feishu/push", response_model=FeishuPushResponse)
async def feishu_push(request: Request, body: FeishuPushRequest) -> FeishuPushResponse:
    """Send a proactive Feishu message (markdown card). Intended for cron or other schedulers.

    Configure ``channels.feishu.push_secret`` in ``config.yaml`` or set ``EVOFLOW_FEISHU_PUSH_SECRET``.
    Send the same value in header ``X-EvoFlow-Feishu-Push-Secret`` or ``Authorization: Bearer <secret>``.
    Requires the Feishu channel to be enabled and running (Gateway started with channel service).
    """
    expected = get_feishu_push_secret()
    if not expected:
        raise HTTPException(
            status_code=503,
            detail="Feishu push is not configured. Set channels.feishu.push_secret or EVOFLOW_FEISHU_PUSH_SECRET.",
        )
    if not _secrets_equal(expected, _extract_request_push_secret(request)):
        raise HTTPException(status_code=401, detail="Invalid or missing push secret.")

    from app.channels.service import get_channel_service

    service = get_channel_service()
    if service is None or not service.get_status().get("service_running"):
        raise HTTPException(status_code=503, detail="Channel service is not running.")

    try:
        await service.feishu_push_markdown(body.receive_id, body.text, receive_id_type=body.receive_id_type)
    except RuntimeError as e:
        msg = str(e)
        # Feishu Open Platform rejected the request (bad chat_id, bot not in group, scope, etc.)
        status = 502 if "Feishu message.create failed" in msg else 503
        raise HTTPException(status_code=status, detail=msg) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        logger.exception("Feishu proactive push failed")
        raise HTTPException(status_code=500, detail=str(e) or type(e).__name__) from e

    return FeishuPushResponse(success=True, message="Message sent.")


# -- Feishu QR code registration endpoints ---------------------------------


@router.post("/feishu/registration/begin", response_model=FeishuRegistrationBeginResponse)
async def feishu_registration_begin(request: Request) -> FeishuRegistrationBeginResponse:
    """Begin Feishu QR registration. Returns a QR URL to scan with the Feishu app.

    After scanning and authorizing in the Feishu app, poll the ``/poll`` endpoint
    until ``status == "completed"``, then call ``/apply`` to save credentials
    and start the channel automatically.
    """
    require_org_admin(request)
    from app.channels.feishu_registration import FeishuRegistrationError, get_registration_client

    client = get_registration_client()
    try:
        session = await client.begin()
    except FeishuRegistrationError as e:
        raise HTTPException(status_code=502, detail=f"Feishu registration failed: {e.message}")
    except Exception as e:
        logger.exception("Feishu registration begin failed")
        raise HTTPException(status_code=500, detail=str(e) or type(e).__name__)

    return FeishuRegistrationBeginResponse(
        session_id=session.session_id,
        qr_url=session.qr_url or "",
        status=session.status,
    )


@router.get("/feishu/registration/{session_id}/poll", response_model=FeishuRegistrationPollResponse)
async def feishu_registration_poll(request: Request, session_id: str) -> FeishuRegistrationPollResponse:
    """Poll Feishu registration status.

    Call this every 2-3 seconds after ``/begin``.  When ``status == "completed"``,
    the response contains ``app_id`` and ``app_secret``.
    """
    require_org_admin(request)
    from app.channels.feishu_registration import FeishuRegistrationError, get_registration_client

    client = get_registration_client()
    try:
        session = await client.poll(session_id)
    except FeishuRegistrationError as e:
        raise HTTPException(status_code=404, detail=e.message)
    except Exception as e:
        logger.exception("Feishu registration poll failed")
        raise HTTPException(status_code=500, detail=str(e) or type(e).__name__)

    return FeishuRegistrationPollResponse(
        session_id=session.session_id,
        status=session.status,
        app_id=session.app_id if session.status == "completed" else None,
        app_secret=session.app_secret if session.status == "completed" else None,
        error=session.error if session.status in ("failed", "expired") else None,
    )


@router.post("/feishu/registration/{session_id}/apply", response_model=FeishuRegistrationApplyResponse)
async def feishu_registration_apply(
    request: Request,
    session_id: str,
    body: FeishuRegistrationApplyRequest = FeishuRegistrationApplyRequest(),
) -> FeishuRegistrationApplyResponse:
    """Apply Feishu registration credentials.

    Saves ``app_id`` / ``app_secret`` to ``config.yaml`` and automatically starts
    (or restarts) the Feishu channel.  Intended to be called after ``/poll``
    returns ``status == "completed"``.
    """
    require_org_admin(request)
    from app.channels.feishu_registration import get_registration_client
    from app.channels.service import get_channel_service

    client = get_registration_client()
    session = client.get_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Registration session not found")

    if session.status != "completed":
        msg = {
            "expired": "Registration session expired. Please start a new registration.",
            "failed": f"Registration failed: {session.error or 'unknown error'}",
        }.get(session.status, f"Registration is not complete (status={session.status})")
        raise HTTPException(status_code=400, detail=msg)

    if not session.app_id or not session.app_secret:
        raise HTTPException(status_code=500, detail="Registration completed but credentials are missing")

    # Save credentials and start the channel
    service = get_channel_service()
    if service is not None:
        success = await service.update_channel_config(
            "feishu",
            {"app_id": session.app_id, "app_secret": session.app_secret, "enabled": body.enabled},
        )
        if not success:
            raise HTTPException(status_code=500, detail="Failed to persist Feishu credentials")

        # Check if channel is now running
        _, _, running = service.get_channel_config("feishu")
        return FeishuRegistrationApplyResponse(
            success=True,
            message="Feishu credentials saved and channel started",
            channel_running=running,
        )
    else:
        # Channel service not running — still persist credentials
        from evoflow.config.app_config import get_app_config, update_channels_section_and_save

        cfg = get_app_config()
        channels = _channels_section_from_app_config(cfg) or {}
        feishu_cfg = dict(channels.get("feishu", {}))
        feishu_cfg.update({"app_id": session.app_id, "app_secret": session.app_secret, "enabled": body.enabled})
        channels["feishu"] = feishu_cfg
        update_channels_section_and_save(channels)

        return FeishuRegistrationApplyResponse(
            success=True,
            message="Feishu credentials saved. Restart the Gateway to activate the channel.",
            channel_running=False,
        )


# -- Weixin iLink QR registration (EvoPanel / Control UI) --------------------


@router.post("/weixin/registration/begin", response_model=WeixinRegistrationBeginResponse)
async def weixin_registration_begin(request: Request) -> WeixinRegistrationBeginResponse:
    """Begin Weixin (personal WeChat) iLink QR login. Returns ``qr_url`` to render as a QR image."""
    require_org_admin(request)
    from app.channels.weixin_registration import WeixinRegistrationError, get_weixin_registration_client

    client = get_weixin_registration_client()
    try:
        session = await client.begin()
    except WeixinRegistrationError as e:
        code = getattr(e, "code", "") or ""
        status = 503 if code == "missing_dependency" else 502
        raise HTTPException(status_code=status, detail=e.message or code) from e
    except Exception as e:
        logger.exception("Weixin registration begin failed")
        raise HTTPException(status_code=500, detail=str(e) or type(e).__name__) from e

    return WeixinRegistrationBeginResponse(
        session_id=session.session_id,
        qr_url=session.qr_scan_url,
        status=session.status,
    )


@router.get("/weixin/registration/{session_id}/poll", response_model=WeixinRegistrationPollResponse)
async def weixin_registration_poll(request: Request, session_id: str) -> WeixinRegistrationPollResponse:
    """Poll Weixin iLink QR status (call every ~2s after ``/begin``)."""
    require_org_admin(request)
    from app.channels.weixin_registration import WeixinRegistrationError, get_weixin_registration_client

    client = get_weixin_registration_client()
    try:
        session = await client.poll(session_id)
    except WeixinRegistrationError as e:
        raise HTTPException(status_code=404, detail=e.message) from e
    except Exception as e:
        logger.exception("Weixin registration poll failed")
        raise HTTPException(status_code=500, detail=str(e) or type(e).__name__) from e

    err = session.error if session.status in ("failed", "expired") else None
    qr = session.qr_scan_url if session.status in ("pending", "scanning") else None
    return WeixinRegistrationPollResponse(
        session_id=session.session_id,
        status=session.status,
        qr_url=qr,
        account_id=session.account_id if session.status == "completed" else None,
        token=session.token if session.status == "completed" else None,
        base_url=session.confirmed_base_url if session.status == "completed" else None,
        user_id=session.user_id if session.status == "completed" else None,
        error=err,
    )


@router.post("/weixin/registration/{session_id}/apply", response_model=WeixinRegistrationApplyResponse)
async def weixin_registration_apply(
    request: Request,
    session_id: str,
    body: WeixinRegistrationApplyRequest = WeixinRegistrationApplyRequest(),
) -> WeixinRegistrationApplyResponse:
    """Save WeChat bot credentials as ONE account binding and (re)start the channel.

    Multi-account: every scan creates/updates its own ``evoflow_bot_bindings`` row
    (``platform="weixin"``, slot = iLink account_id). ``agent_code`` empty binds the
    bot to the main agent (主智能体); set it to route the bot to an employee.
    """
    require_org_admin(request)
    from app.channels.service import get_channel_service
    from app.channels.weixin_registration import get_weixin_registration_client
    from app.channels.weixin_setup import save_weixin_credentials

    client = get_weixin_registration_client()
    session = client.get_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Registration session not found")

    if session.status != "completed":
        msg = {
            "expired": "Registration session expired. Please start a new registration.",
            "failed": f"Registration failed: {session.error or 'unknown error'}",
        }.get(session.status, f"Registration is not complete (status={session.status})")
        raise HTTPException(status_code=400, detail=msg)

    if not session.account_id or not session.token:
        raise HTTPException(status_code=500, detail="Registration completed but credentials are missing")

    agent_code = str(body.agent_code or "").strip()
    display_name = str(body.display_name or "").strip()
    base_url = (session.confirmed_base_url or session.init_base_url or "").rstrip("/")
    save_weixin_credentials(
        account_id=session.account_id,
        token=session.token,
        base_url=base_url,
        user_id=str(session.user_id or ""),
    )

    # One row per WeChat bot (1 bot ⇄ 1 binding; one employee ⇄ at most one bot).
    from evoflow.proactive.weixin_binding import sync_weixin_account_binding

    try:
        binding = sync_weixin_account_binding(
            session.account_id,
            token=session.token,
            agent_code=agent_code,
            display_name=display_name,
            base_url=base_url,
            enabled=body.enabled,
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    # Mirror the accounts dict into the persisted channel config so the generic
    # GET /channels/weixin/config shape and channels.js stay coherent.
    session_block: dict[str, Any] = {"base_url": base_url}
    if display_name:
        session_block["display_name"] = display_name
    if agent_code:
        session_block["assistant_id"] = agent_code
    accounts = await _current_weixin_accounts_mirror()
    accounts[session.account_id] = {
        **accounts.get(session.account_id, {}),
        "bot_id": session.account_id,
        "account_id": session.account_id,
        "token": session.token,
        "base_url": base_url,
        "agent_code": agent_code,
        "enabled": body.enabled,
        "session": session_block,
    }
    payload = {"enabled": body.enabled, "accounts": accounts}

    service = get_channel_service()
    if service is not None:
        success = await service.update_channel_config("weixin", payload)
        if not success:
            raise HTTPException(status_code=500, detail="Failed to persist Weixin credentials")

        # Also persist to SQLite database (evoflow_channel_configs) for settings API
        try:
            from evoflow.persistence import config_repositories as cfg_repo

            cfg_repo.upsert_channel_config("weixin", payload)
        except Exception:
            logger.warning("Failed to persist Weixin config to SQLite database", exc_info=True)

        _, _, running = service.get_channel_config("weixin")
        target = f"employee {agent_code}" if agent_code else "main agent"
        return WeixinRegistrationApplyResponse(
            success=True,
            message=f"WeChat account {binding.get('bot_id_suffix')} bound to {target}",
            channel_running=running,
        )

    from evoflow.config.app_config import get_app_config, update_channels_section_and_save

    cfg = get_app_config()
    channels = _channels_section_from_app_config(cfg) or {}
    weixin_cfg = dict(channels.get("weixin", {}))
    weixin_cfg["accounts"] = accounts
    weixin_cfg["enabled"] = body.enabled
    channels["weixin"] = weixin_cfg
    update_channels_section_and_save(channels)

    return WeixinRegistrationApplyResponse(
        success=True,
        message="WeChat account bound. Restart the Gateway to activate the channel.",
        channel_running=False,
    )


async def _current_weixin_accounts_mirror() -> dict[str, Any]:
    """Current ``channels.weixin.accounts`` dict from the live service or SQLite."""
    from app.channels.service import get_channel_service

    service = get_channel_service()
    if service is not None:
        cfg = service._config.get("weixin")
        if isinstance(cfg, dict) and isinstance(cfg.get("accounts"), dict):
            return dict(cfg["accounts"])
    try:
        from evoflow.persistence import config_repositories as cfg_repo

        return dict((cfg_repo.get_channel_config("weixin") or {}).get("accounts") or {})
    except Exception:
        return {}


def _weixin_accounts_mirror_payload() -> dict[str, Any]:
    """Build the ``accounts`` dict from evoflow_bot_bindings (single source of truth)."""
    from evoflow.persistence.config_repositories import list_bot_bindings

    accounts: dict[str, Any] = {}
    for row in list_bot_bindings("weixin", enabled_only=False):
        session = dict(row.get("session_config") or {})
        accounts[str(row["bot_id"])] = {
            "bot_id": row["bot_id"],
            "account_id": row["bot_id"],
            "token": row["bot_secret"],
            "base_url": str(session.get("base_url") or ""),
            "agent_code": str(row.get("agent_code") or ""),
            "enabled": bool(row.get("enabled", True)),
            "session": session,
        }
    return accounts


async def _persist_weixin_accounts_mirror_and_restart() -> bool:
    """Sync the accounts mirror from bindings and restart the weixin channel family.

    Returns True when the channel service handled it (restart scheduled); False
    means only the YAML/SQLite mirror was updated and the caller should tell the
    user to restart the Gateway.
    """
    from evoflow.persistence import config_repositories as cfg_repo

    payload = {"accounts": _weixin_accounts_mirror_payload()}
    from app.channels.service import get_channel_service

    service = get_channel_service()
    if service is not None:
        ok = await service.update_channel_config("weixin", payload)
        if not ok:
            raise HTTPException(status_code=500, detail="Failed to persist Weixin accounts")
        try:
            cfg_repo.upsert_channel_config("weixin", payload)
        except Exception:
            logger.warning("Failed to persist Weixin config to SQLite database", exc_info=True)
        return True

    from evoflow.config.app_config import get_app_config, update_channels_section_and_save

    cfg = get_app_config()
    channels = _channels_section_from_app_config(cfg) or {}
    weixin_cfg = dict(channels.get("weixin", {}))
    weixin_cfg.update(payload)
    channels["weixin"] = weixin_cfg
    update_channels_section_and_save(channels)
    return False


@router.get("/weixin/accounts", response_model=WeixinAccountsResponse)
async def list_weixin_accounts(request: Request) -> WeixinAccountsResponse:
    """List all bound WeChat (iLink) accounts: bindings + runtime state (增删改查之「查」)."""
    require_org_admin(request)
    from evoflow.persistence.config_repositories import list_bot_bindings
    from evoflow.proactive.weixin_binding import weixin_binding_public

    rows = list_bot_bindings("weixin", enabled_only=False)
    running_ids: set[str] = set()
    from app.channels.service import get_channel_service

    service = get_channel_service()
    if service is not None:
        entry = service.get_status().get("channels", {}).get("weixin", {})
        running_ids = {str(a) for a in (entry.get("bound_accounts") or [])}

    accounts: list[WeixinAccountOut] = []
    for row in rows:
        pub = weixin_binding_public(row)
        role_name = ""
        code = pub.get("agent_code") or ""
        if code:
            try:
                from evoflow.proactive.repositories import ProactiveRepository

                role = ProactiveRepository.get_role(code)
                role_name = str(getattr(role, "role_name", "") or "") if role else ""
            except Exception:
                role_name = ""
        # Legacy/absorbed bindings carry an empty bound_at — fall back to the
        # credential file's saved_at so the UI can show when the account was bound.
        bound_at = str(pub.get("bound_at") or "")
        if not bound_at:
            try:
                from app.channels.weixin_setup import load_weixin_credentials

                creds = load_weixin_credentials(str(row.get("bot_id") or ""))
                bound_at = str((creds or {}).get("saved_at") or "")
            except Exception:
                bound_at = ""
        accounts.append(
            WeixinAccountOut(
                account_id=pub.get("account_id") or str(row.get("bot_id") or ""),
                agent_code=code,
                is_main_agent=not code,
                display_name=pub.get("display_name") or "",
                bot_id_suffix=pub.get("bot_id_suffix") or "",
                enabled=bool(pub.get("enabled", True)),
                bound_at=bound_at,
                base_url=pub.get("base_url") or "",
                running=str(row.get("bot_id") or "") in running_ids,
                role_name=role_name,
            )
        )
    return WeixinAccountsResponse(success=True, accounts=accounts)


@router.patch("/weixin/accounts/{account_id}", response_model=WeixinAccountPatchResponse)
async def patch_weixin_account(
    request: Request,
    account_id: str,
    body: WeixinAccountPatchRequest,
) -> WeixinAccountPatchResponse:
    """Rename / enable / re-bind one WeChat account (增删改查之「改」).

    ``agent_code`` swap takes effect after the channel family restart (scheduled
    off the request path by ``update_channel_config``).
    """
    require_org_admin(request)
    from evoflow.persistence.config_repositories import get_bot_binding
    from evoflow.proactive.weixin_binding import update_weixin_account_binding

    if get_bot_binding("weixin", account_id) is None:
        raise HTTPException(status_code=404, detail="WeChat account binding not found")

    try:
        binding = update_weixin_account_binding(
            account_id,
            agent_code=body.agent_code,
            display_name=body.display_name,
            enabled=body.enabled,
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    await _persist_weixin_accounts_mirror_and_restart()
    account = WeixinAccountOut(
        account_id=binding.get("account_id") or account_id,
        agent_code=binding.get("agent_code") or "",
        is_main_agent=not (binding.get("agent_code") or ""),
        display_name=binding.get("display_name") or "",
        bot_id_suffix=binding.get("bot_id_suffix") or "",
        enabled=bool(binding.get("enabled", True)),
        bound_at=binding.get("bound_at") or "",
        base_url=binding.get("base_url") or "",
    )
    return WeixinAccountPatchResponse(success=True, message="WeChat account updated", account=account)


@router.delete("/weixin/accounts/{account_id}", response_model=WeixinAccountDeleteResponse)
async def delete_weixin_account(request: Request, account_id: str) -> WeixinAccountDeleteResponse:
    """Unbind and remove one WeChat account binding (增删改查之「删」).

    Stops the ``weixin:<account_id>`` instance, deletes the binding row and the
    local credential file. The WeChat-side bot itself must be removed in the
    WeChat app — this only stops EvoFlow from answering it.
    """
    require_org_admin(request)
    from evoflow.persistence.config_repositories import get_bot_binding
    from evoflow.proactive.weixin_binding import remove_weixin_account_binding

    binding = get_bot_binding("weixin", account_id)
    if binding is None:
        raise HTTPException(status_code=404, detail="WeChat account binding not found")

    # If the bot was bound to an employee, clear that role's weixin fields too.
    role_code = str(binding.get("agent_code") or "").strip()
    if role_code:
        try:
            from evoflow.proactive.repositories import ProactiveRepository

            role = ProactiveRepository.get_role(role_code)
            if role is not None and str(getattr(role.config, "weixin_account_id", "") or "").strip() == account_id:
                cfg = role.config
                cfg.weixin_account_id = ""
                cfg.weixin_bound_at = ""
                role.config = cfg
                ProactiveRepository.save_role(role)
        except Exception:
            logger.warning("weixin account delete: role cleanup failed agent=%s", role_code, exc_info=True)

    from app.channels.service import get_channel_service

    service = get_channel_service()
    stopped = False
    if service is not None:
        stopped = await service.stop_account_instance("weixin", account_id)

    deleted = remove_weixin_account_binding(account_id)
    if not deleted and not stopped:
        raise HTTPException(status_code=404, detail="WeChat account binding not found")

    # Best-effort: drop the persisted credential file (sync/context-token files
    # are kept so re-binding the same bot resumes its cursor).
    try:
        from app.channels.weixin_setup import _weixin_home

        cred_path = _weixin_home() / f"{account_id}.json"
        if cred_path.exists():
            cred_path.unlink()
    except Exception:
        logger.warning("weixin account delete: credential file cleanup failed", exc_info=True)

    await _persist_weixin_accounts_mirror_and_restart()
    logger.info("WeChat account unbound: account=%s role=%s stopped=%s", account_id, role_code or "-", stopped)
    return WeixinAccountDeleteResponse(
        success=True,
        message="WeChat account unbound. Remove the bot inside the WeChat app if you no longer want it there.",
    )


# -- WeCom (Enterprise WeChat) QR registration (EvoPanel / Control UI) -------


@router.post("/wecom/registration/begin", response_model=WecomRegistrationBeginResponse)
async def wecom_registration_begin(request: Request) -> WecomRegistrationBeginResponse:
    """Begin WeCom (Enterprise WeChat) QR registration. Returns ``qr_url`` to render as a QR image.

    The QR flow uses WeCom's admin-console bot-creation endpoints (same as
    hermes-agent's ``qr_scan_for_bot_info``).  Scan with the WeCom app to create
    an AI Bot and obtain ``bot_id`` / ``secret``.
    """
    require_org_admin(request)
    from app.channels.wecom_registration import WecomRegistrationError, get_wecom_registration_client

    client = get_wecom_registration_client()
    try:
        session = await client.begin()
    except WecomRegistrationError as e:
        raise HTTPException(status_code=502, detail=e.message) from e
    except Exception as e:
        logger.exception("WeCom registration begin failed")
        raise HTTPException(status_code=500, detail=str(e) or type(e).__name__) from e

    return WecomRegistrationBeginResponse(
        session_id=session.session_id,
        qr_url=session.qr_url,
        fallback_url=session.fallback_url,
        status=session.status,
    )


@router.get("/wecom/registration/{session_id}/poll", response_model=WecomRegistrationPollResponse)
async def wecom_registration_poll(request: Request, session_id: str) -> WecomRegistrationPollResponse:
    """Poll WeCom QR status (call every ~3s after ``/begin``)."""
    require_org_admin(request)
    from app.channels.wecom_registration import WecomRegistrationError, get_wecom_registration_client

    client = get_wecom_registration_client()
    try:
        session = await client.poll(session_id)
    except WecomRegistrationError as e:
        raise HTTPException(status_code=404, detail=e.message) from e
    except Exception as e:
        logger.exception("WeCom registration poll failed")
        raise HTTPException(status_code=500, detail=str(e) or type(e).__name__) from e

    err = session.error if session.status in ("failed", "expired") else None
    return WecomRegistrationPollResponse(
        session_id=session.session_id,
        status=session.status,
        qr_url=session.qr_url if session.status in ("pending", "scanning") else None,
        bot_id=session.bot_id if session.status == "completed" else None,
        secret=session.secret if session.status == "completed" else None,
        error=err,
    )


@router.post("/wecom/registration/{session_id}/apply", response_model=WecomRegistrationApplyResponse)
async def wecom_registration_apply(
    request: Request,
    session_id: str,
    body: WecomRegistrationApplyRequest = WecomRegistrationApplyRequest(),
) -> WecomRegistrationApplyResponse:
    """Save WeCom credentials to disk and ``config.yaml``, then start or restart the channel."""
    require_org_admin(request)
    from app.channels.service import get_channel_service
    from app.channels.wecom_registration import get_wecom_registration_client
    from app.channels.wecom_setup import save_wecom_credentials

    client = get_wecom_registration_client()
    session = client.get_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Registration session not found")

    if session.status != "completed":
        msg = {
            "expired": "Registration session expired. Please start a new registration.",
            "failed": f"Registration failed: {session.error or 'unknown error'}",
        }.get(session.status, f"Registration is not complete (status={session.status})")
        raise HTTPException(status_code=400, detail=msg)

    if not session.bot_id or not session.secret:
        raise HTTPException(status_code=500, detail="Registration completed but credentials are missing")

    save_wecom_credentials(bot_id=session.bot_id, secret=session.secret)

    service = get_channel_service()
    if service is not None:
        if body.agent_code:
            # Per-employee binding: write to channels.wecom.accounts[<agent_code>]
            # so the channel service expands this into a per-account instance and
            # routes the bot's messages to that proactive employee agent.
            from evoflow.persistence import config_repositories as cfg_repo

            current_cfg = cfg_repo.get_channel_config("wecom") or {}
            accounts = dict(current_cfg.get("accounts") or {})
            accounts[body.agent_code] = {
                **accounts.get(body.agent_code, {}),
                "bot_id": session.bot_id,
                "secret": session.secret,
            }
            payload = {"enabled": body.enabled, "accounts": accounts}
        else:
            payload = {
                "bot_id": session.bot_id,
                "secret": session.secret,
                "enabled": body.enabled,
            }

        success = await service.update_channel_config("wecom", payload)
        if not success:
            raise HTTPException(status_code=500, detail="Failed to persist WeCom credentials")

        # Also persist to SQLite database (evoflow_channel_configs) for settings API
        try:
            from evoflow.persistence import config_repositories as cfg_repo

            cfg_repo.upsert_channel_config("wecom", payload)
        except Exception:
            logger.warning("Failed to persist WeCom config to SQLite database", exc_info=True)

        _, _, running = service.get_channel_config("wecom")
        return WecomRegistrationApplyResponse(
            success=True,
            message=(
                f"WeCom credentials saved and bound to employee {body.agent_code}"
                if body.agent_code
                else "WeCom credentials saved and channel started"
            ),
            channel_running=running,
        )

    from evoflow.config.app_config import get_app_config, update_channels_section_and_save

    cfg = get_app_config()
    channels = _channels_section_from_app_config(cfg) or {}
    wecom_cfg = dict(channels.get("wecom", {}))
    if body.agent_code:
        accounts = dict(wecom_cfg.get("accounts") or {})
        accounts[body.agent_code] = {
            **accounts.get(body.agent_code, {}),
            "bot_id": session.bot_id,
            "secret": session.secret,
        }
        wecom_cfg["accounts"] = accounts
        wecom_cfg["enabled"] = body.enabled
    else:
        wecom_cfg.update({
            "bot_id": session.bot_id,
            "secret": session.secret,
            "enabled": body.enabled,
        })
    channels["wecom"] = wecom_cfg
    update_channels_section_and_save(channels)

    return WecomRegistrationApplyResponse(
        success=True,
        message=(
            f"WeCom credentials saved and bound to employee {body.agent_code}. "
            "Restart the Gateway to activate the channel."
            if body.agent_code
            else "WeCom credentials saved. Restart the Gateway to activate the channel."
        ),
        channel_running=False,
    )


# -- DingTalk (钉钉) device-flow QR registration (EvoPanel / Control UI) ----


@router.post("/dingtalk/registration/begin", response_model=DingtalkRegistrationBeginResponse)
async def dingtalk_registration_begin(request: Request) -> DingtalkRegistrationBeginResponse:
    """Begin DingTalk device-flow QR registration. Returns ``qr_url`` to render as a QR image.

    Scan with the DingTalk app to authorize; on success the device-flow returns
    Client ID (AppKey) and Client Secret (AppSecret) automatically.

    NOTE: the onboarding bridge is branded "OpenClaw" on DingTalk's side (a
    third-party ecosystem endpoint, not DingTalk's official enterprise bot-creation
    page) and may change without notice.
    """
    require_org_admin(request)
    from app.channels.dingtalk_registration import DingtalkRegistrationError, get_dingtalk_registration_client

    client = get_dingtalk_registration_client()
    try:
        session = await client.begin()
    except DingtalkRegistrationError as e:
        raise HTTPException(status_code=502, detail=e.message) from e
    except Exception as e:
        logger.exception("DingTalk registration begin failed")
        raise HTTPException(status_code=500, detail=str(e) or type(e).__name__) from e

    return DingtalkRegistrationBeginResponse(
        session_id=session.session_id,
        qr_url=session.qr_url,
        status=session.status,
    )


@router.get("/dingtalk/registration/{session_id}/poll", response_model=DingtalkRegistrationPollResponse)
async def dingtalk_registration_poll(request: Request, session_id: str) -> DingtalkRegistrationPollResponse:
    """Poll DingTalk device-flow status (call every ~3s after ``/begin``)."""
    require_org_admin(request)
    from app.channels.dingtalk_registration import DingtalkRegistrationError, get_dingtalk_registration_client

    client = get_dingtalk_registration_client()
    try:
        session = await client.poll(session_id)
    except DingtalkRegistrationError as e:
        raise HTTPException(status_code=404, detail=e.message) from e
    except Exception as e:
        logger.exception("DingTalk registration poll failed")
        raise HTTPException(status_code=500, detail=str(e) or type(e).__name__) from e

    err = session.error if session.status in ("failed", "expired") else None
    return DingtalkRegistrationPollResponse(
        session_id=session.session_id,
        status=session.status,
        qr_url=session.qr_url if session.status in ("pending", "scanning") else None,
        client_id=session.client_id if session.status == "completed" else None,
        client_secret=session.client_secret if session.status == "completed" else None,
        error=err,
    )


@router.post("/dingtalk/registration/{session_id}/apply", response_model=DingtalkRegistrationApplyResponse)
async def dingtalk_registration_apply(
    request: Request,
    session_id: str,
    body: DingtalkRegistrationApplyRequest = DingtalkRegistrationApplyRequest(),
) -> DingtalkRegistrationApplyResponse:
    """Save DingTalk credentials to ``config.yaml``, then start or restart the channel."""
    require_org_admin(request)
    from app.channels.dingtalk_registration import get_dingtalk_registration_client
    from app.channels.service import get_channel_service

    client = get_dingtalk_registration_client()
    session = client.get_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Registration session not found")

    if session.status != "completed":
        msg = {
            "expired": "Registration session expired. Please start a new registration.",
            "failed": f"Registration failed: {session.error or 'unknown error'}",
        }.get(session.status, f"Registration is not complete (status={session.status})")
        raise HTTPException(status_code=400, detail=msg)

    if not session.client_id or not session.client_secret:
        raise HTTPException(status_code=500, detail="Registration completed but credentials are missing")

    payload = {
        "client_id": session.client_id,
        "client_secret": session.client_secret,
        "enabled": body.enabled,
    }

    service = get_channel_service()
    if service is not None:
        success = await service.update_channel_config("dingtalk", payload)
        if not success:
            raise HTTPException(status_code=500, detail="Failed to persist DingTalk credentials")

        # Also persist to SQLite database (evoflow_channel_configs) for settings API
        try:
            from evoflow.persistence import config_repositories as cfg_repo

            cfg_repo.upsert_channel_config("dingtalk", payload)
        except Exception:
            logger.warning("Failed to persist DingTalk config to SQLite database", exc_info=True)

        _, _, running = service.get_channel_config("dingtalk")
        return DingtalkRegistrationApplyResponse(
            success=True,
            message="DingTalk credentials saved and channel started",
            channel_running=running,
        )

    from evoflow.config.app_config import get_app_config, update_channels_section_and_save

    cfg = get_app_config()
    channels = _channels_section_from_app_config(cfg) or {}
    dingtalk_cfg = dict(channels.get("dingtalk", {}))
    dingtalk_cfg.update(payload)
    channels["dingtalk"] = dingtalk_cfg
    update_channels_section_and_save(channels)

    return DingtalkRegistrationApplyResponse(
        success=True,
        message="DingTalk credentials saved. Restart the Gateway to activate the channel.",
        channel_running=False,
    )
