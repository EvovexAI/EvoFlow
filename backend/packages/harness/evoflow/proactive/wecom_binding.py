"""Per-employee WeCom (Enterprise WeChat) AI Bot binding helpers.

Each smart employee can QR-scan (same flow as Settings → IM) to create/bind a
dedicated WeCom bot. Credentials live on the role ``config_json`` and are
synced into ``channels.wecom.accounts[<agent_code>]`` so the WeCom channel
can run multiple WebSocket clients and route inbound chat to that agent.

Mirrors :mod:`evoflow.proactive.feishu_binding` so the panel needs only
parameterise ``channel`` instead of duplicating glue per platform.
"""

from __future__ import annotations

import copy
import logging
from typing import Any

from evoflow.proactive.repositories import ProactiveRepository
from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)


def wecom_binding_public(cfg: Any) -> dict[str, Any]:
    """UI-safe binding snapshot (never includes secret)."""
    bot_id = str(getattr(cfg, "wecom_bot_id", "") or "").strip()
    secret = str(getattr(cfg, "wecom_secret", "") or "").strip()
    bound_at = str(getattr(cfg, "wecom_bound_at", "") or "").strip()
    intro_sent_at = str(getattr(cfg, "wecom_intro_sent_at", "") or "").strip()
    bound = bool(bot_id and secret)
    return {
        "bound": bound,
        "bot_id_suffix": f"…{bot_id[-4:]}" if bound and len(bot_id) >= 4 else (bot_id if bound else ""),
        "bound_at": bound_at if bound else "",
        "intro_sent_at": intro_sent_at if bound else "",
    }


def _channels_section() -> dict[str, Any]:
    from evoflow.config.app_config import get_app_config

    cfg = get_app_config()
    dumped = cfg.model_dump(mode="json") if hasattr(cfg, "model_dump") else {}
    ch = dumped.get("channels") if isinstance(dumped, dict) else None
    if isinstance(ch, dict):
        return copy.deepcopy(ch)
    extra = getattr(cfg, "model_extra", None) or {}
    nested = extra.get("channels") if isinstance(extra, dict) else None
    if isinstance(nested, dict):
        return copy.deepcopy(nested)
    attr = getattr(cfg, "channels", None)
    if isinstance(attr, dict):
        return copy.deepcopy(attr)
    return {}


def _persist_wecom_accounts(accounts: dict[str, Any], *, ensure_enabled: bool = True) -> None:
    """Write ``channels.wecom.accounts`` (and optionally enable the channel).

    Invariant 1: one bot is bound to **at most one** employee. ``bot_id`` collisions
    across multiple ``accounts[*].bot_id`` are detected by the channel service on
    restart, but we double-check here before writing so the panel surfaces a clear
    error instead of an opaque start failure.
    """
    from evoflow.config.app_config import update_channels_section_and_save

    # Sanity-check 1:1 invariant before writing to SQLite.
    seen_bot_ids: dict[str, str] = {}
    for code, acc in accounts.items():
        bid = str(acc.get("bot_id") or "").strip()
        if not bid:
            continue
        if bid in seen_bot_ids and seen_bot_ids[bid] != code:
            raise ValueError(
                f"wecom.accounts.bot_id duplicated between "
                f"{seen_bot_ids[bid]!r} and {code!r}: every bot may bind at most one employee"
            )
        seen_bot_ids[bid] = code

    channels = _channels_section()
    wecom = dict(channels.get("wecom") or {})
    wecom["accounts"] = accounts
    if ensure_enabled and accounts:
        wecom["enabled"] = True
    channels["wecom"] = wecom
    update_channels_section_and_save(channels)

    try:
        from evoflow.runtime.ports import get_channel_service

        service = get_channel_service()
        if service is not None:
            cfg = dict(service._config.get("wecom") or {})
            cfg["accounts"] = copy.deepcopy(accounts)
            if ensure_enabled and accounts:
                cfg["enabled"] = True
            service._config["wecom"] = cfg
    except Exception:
        logger.debug("wecom_binding: sync ChannelService memory skipped", exc_info=True)


def sync_role_account_to_channel(
    agent_code: str,
    *,
    bot_id: str,
    secret: str,
    role_name: str = "",
) -> dict[str, Any]:
    """Upsert ``channels.wecom.accounts[agent_code]`` for this employee bot."""
    code = str(agent_code or "").strip()
    if not code:
        raise ValueError("agent_code is required")
    bid = str(bot_id or "").strip()
    sec = str(secret or "").strip()
    if not bid or not sec:
        raise ValueError("bot_id and secret are required")

    channels = _channels_section()
    wecom = dict(channels.get("wecom") or {})
    accounts = dict(wecom.get("accounts") or {}) if isinstance(wecom.get("accounts"), dict) else {}

    # Reject 1:1 violation that would arise from re-using an existing bot on a new employee.
    for existing_code, existing_acc in accounts.items():
        if existing_code == code:
            continue
        if str(existing_acc.get("bot_id") or "").strip() == bid:
            raise ValueError(
                f"bot_id {bid!r} is already bound to employee {existing_code!r}; "
                f"a WeCom bot may bind to at most one employee"
            )

    accounts[code] = {
        "bot_id": bid,
        "secret": sec,
        "enabled": True,
        "name": str(role_name or code).strip() or code,
        "session": {"assistant_id": code},
    }
    _persist_wecom_accounts(accounts, ensure_enabled=True)
    return accounts[code]


def remove_role_account_from_channel(agent_code: str) -> bool:
    """Remove employee account from ``channels.wecom.accounts``."""
    code = str(agent_code or "").strip()
    if not code:
        return False
    channels = _channels_section()
    wecom = dict(channels.get("wecom") or {})
    accounts = dict(wecom.get("accounts") or {}) if isinstance(wecom.get("accounts"), dict) else {}
    if code not in accounts:
        return False
    del accounts[code]
    _persist_wecom_accounts(accounts, ensure_enabled=bool(accounts) or bool(wecom.get("enabled")))
    return True


async def restart_wecom_channel_if_possible() -> bool:
    """Best-effort restart so new employee bots start receiving messages."""
    try:
        from evoflow.runtime.ports import get_channel_service

        service = get_channel_service()
        if service is None:
            return False
        return await service.restart_channel("wecom")
    except Exception:
        logger.warning("wecom_binding: restart wecom channel failed", exc_info=True)
        return False


async def apply_registration_to_role(
    agent_code: str,
    *,
    bot_id: str,
    secret: str,
) -> dict[str, Any]:
    """Persist binding on the role and sync/restart the WeCom channel."""
    code = str(agent_code or "").strip()
    role = ProactiveRepository.get_role(code)
    if role is None:
        raise LookupError(f"Role '{code}' not found")

    cfg = role.config
    cfg.wecom_bot_id = str(bot_id or "").strip()
    cfg.wecom_secret = str(secret or "").strip()
    cfg.wecom_bound_at = utc_now_iso_z()
    # Reset intro flags on (re-)bind so a fresh intro is sent (when push_employee_self_intro
    # supports WeCom in a later release).
    cfg.wecom_intro_sent_at = ""

    role.config = cfg
    ProactiveRepository.save_role(role)

    sync_role_account_to_channel(
        code,
        bot_id=cfg.wecom_bot_id,
        secret=cfg.wecom_secret,
        role_name=role.role_name,
    )
    running = await restart_wecom_channel_if_possible()

    return {
        "ok": True,
        "agent_code": code,
        "channel_running": bool(running),
        "binding": wecom_binding_public(cfg),
        "bot_id": str(cfg.wecom_bot_id or "").strip(),
        "role_name": str(role.role_name or code).strip() or code,
    }


async def unbind_role_wecom(agent_code: str) -> dict[str, Any]:
    """Clear role WeCom credentials and remove the channel account."""
    code = str(agent_code or "").strip()
    role = ProactiveRepository.get_role(code)
    if role is None:
        raise LookupError(f"Role '{code}' not found")

    cfg = role.config
    cfg.wecom_bot_id = ""
    cfg.wecom_secret = ""
    cfg.wecom_bound_at = ""
    cfg.wecom_intro_sent_at = ""
    role.config = cfg
    ProactiveRepository.save_role(role)

    remove_role_account_from_channel(code)
    running = await restart_wecom_channel_if_possible()
    return {
        "ok": True,
        "agent_code": code,
        "channel_running": bool(running),
        "binding": wecom_binding_public(cfg),
    }
