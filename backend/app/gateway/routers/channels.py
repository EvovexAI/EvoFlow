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


class WeixinRegistrationApplyResponse(BaseModel):
    success: bool
    message: str
    channel_running: bool = False


class WecomRegistrationBeginResponse(BaseModel):
    session_id: str
    qr_url: str = Field(..., description="URL to render as QR (WeCom bot-creation flow)")
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
    """Get the status of all IM channels."""
    from app.channels.service import (
        get_channel_service,
        registry_channel_status,
        start_channel_service,
    )

    service = get_channel_service()
    if service is None:
        try:
            service = await start_channel_service()
        except Exception:
            logger.exception("Channel service unavailable; returning registry defaults")
            return ChannelStatusResponse(**registry_channel_status(service_running=False))
    status = service.get_status()
    return ChannelStatusResponse(**status)


@router.get("/push-targets")
async def list_channel_push_targets(request: Request, limit: int = 200) -> dict[str, Any]:
    """List IM sessions available as result-push destinations."""
    require_org_admin(request)
    from app.gateway.channel_result_push import list_push_targets

    return {"targets": list_push_targets(limit=limit)}


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
    """Save Weixin credentials to disk and ``config.yaml``, then start or restart the channel."""
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

    base_url = (session.confirmed_base_url or session.init_base_url or "").rstrip("/")
    save_weixin_credentials(
        account_id=session.account_id,
        token=session.token,
        base_url=base_url,
        user_id=str(session.user_id or ""),
    )

    payload = {
        "account_id": session.account_id,
        "token": session.token,
        "base_url": base_url,
        "enabled": body.enabled,
    }

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
        return WeixinRegistrationApplyResponse(
            success=True,
            message="Weixin credentials saved and channel started",
            channel_running=running,
        )

    from evoflow.config.app_config import get_app_config, update_channels_section_and_save

    cfg = get_app_config()
    channels = _channels_section_from_app_config(cfg) or {}
    weixin_cfg = dict(channels.get("weixin", {}))
    weixin_cfg.update(payload)
    channels["weixin"] = weixin_cfg
    update_channels_section_and_save(channels)

    return WeixinRegistrationApplyResponse(
        success=True,
        message="Weixin credentials saved. Restart the Gateway to activate the channel.",
        channel_running=False,
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

    payload = {
        "bot_id": session.bot_id,
        "secret": session.secret,
        "enabled": body.enabled,
    }

    service = get_channel_service()
    if service is not None:
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
            message="WeCom credentials saved and channel started",
            channel_running=running,
        )

    from evoflow.config.app_config import get_app_config, update_channels_section_and_save

    cfg = get_app_config()
    channels = _channels_section_from_app_config(cfg) or {}
    wecom_cfg = dict(channels.get("wecom", {}))
    wecom_cfg.update(payload)
    channels["wecom"] = wecom_cfg
    update_channels_section_and_save(channels)

    return WecomRegistrationApplyResponse(
        success=True,
        message="WeCom credentials saved. Restart the Gateway to activate the channel.",
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
