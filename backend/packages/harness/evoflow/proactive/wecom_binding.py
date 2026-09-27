"""Per-employee WeCom (Enterprise WeChat) AI Bot binding helpers.

Each smart employee can QR-scan (same flow as Settings → IM) to create/bind a
dedicated WeCom bot. Credentials live in ``evoflow_bot_bindings`` (flat 1:1 table)
so the ChannelService and ChannelManager can load session config for a bot without
parsing a nested JSON blob.

Mirrors :mod:`evoflow.proactive.feishu_binding` so the panel needs only
parameterise ``channel`` instead of duplicating glue per platform.
"""

from __future__ import annotations

import logging
from typing import Any

from evoflow.proactive.repositories import ProactiveRepository
from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Public helpers
# ---------------------------------------------------------------------------


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


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _iter_existing_bindings(platform: str):
    """Yield (agent_code, binding_doc) from the new bot_bindings table.

    Gracefully returns an empty iterator if the table does not exist yet
    (migration window).
    """
    try:
        from evoflow.persistence.config_repositories import list_bot_bindings

        for row in list_bot_bindings(platform):
            yield row.get("agent_code", ""), row
    except Exception:
        pass  # table may not exist during initial migration


def _sync_binding_to_channel_service(platform: str, bot_id: str, agent_code: str, secret: str) -> None:
    """Push the new binding into ChannelService's in-memory config so it takes effect immediately."""
    try:
        from evoflow.runtime.ports import get_channel_service

        service = get_channel_service()
        if service is None:
            return
        cfg: dict = dict(service._config.get(platform) or {})
        accounts: dict = dict(cfg.get("accounts") or {})
        if agent_code not in accounts:
            accounts[agent_code] = {}
        accounts[agent_code].update({
            "bot_id": bot_id,
            "secret": secret,
            "enabled": True,
            "session": {"assistant_id": agent_code},
        })
        cfg["accounts"] = accounts
        cfg["enabled"] = True
        service._config[platform] = cfg
        logger.info("[wecom_binding] in-memory sync ok: agent_code=%s bot_id=%s", agent_code, bot_id)
    except Exception:
        logger.debug("wecom_binding: _sync_binding_to_channel_service failed", exc_info=True)


# ---------------------------------------------------------------------------
# Write path: sync a role→bot binding to the flat table
# ---------------------------------------------------------------------------


def sync_role_account_to_channel(
    agent_code: str,
    *,
    bot_id: str,
    secret: str,
    role_name: str = "",
) -> dict[str, Any]:
    """Upsert the bot→agent binding in ``evoflow_bot_bindings`` (1 row per bot).

    Replaces the old ``channels.wecom.accounts`` JSON blob.  The row carries the
    bot's credentials *and* the session_config in separate columns so a single
    SELECT can return everything ChannelService or ChannelManager needs.

    Returns the canonical account dict (mirrors the old JSON shape so callers
    that depend on the return value are not broken).
    """
    code = str(agent_code or "").strip()
    if not code:
        raise ValueError("agent_code is required")
    bid = str(bot_id or "").strip()
    sec = str(secret or "").strip()
    if not bid or not sec:
        raise ValueError("bot_id and secret are required")

    # 1:1 invariant check — no other agent may claim the same bot_id.
    for existing_code, existing_binding in _iter_existing_bindings("wecom"):
        if existing_code == code:
            continue
        if str(existing_binding.get("bot_id") or "").strip() == bid:
            raise ValueError(
                f"bot_id {bid!r} is already bound to employee {existing_code!r}; "
                f"a WeCom bot may bind at most one employee"
            )

    # Write flat table.
    from evoflow.persistence.config_repositories import upsert_bot_binding

    upsert_bot_binding(
        platform="wecom",
        bot_id=bid,
        agent_code=code,
        bot_secret=sec,
        workspace_root="",
        session_config={"assistant_id": code},
        enabled=True,
        bound_at=utc_now_iso_z(),
    )

    # Hot-sync to in-memory ChannelService config so restart is not required.
    _sync_binding_to_channel_service("wecom", bid, code, sec)

    return {
        "bot_id": bid,
        "secret": sec,
        "enabled": True,
        "name": str(role_name or code).strip() or code,
        "session": {"assistant_id": code},
    }


def remove_role_account_from_channel(agent_code: str) -> bool:
    """Remove the bot→agent binding from ``evoflow_bot_bindings``."""
    code = str(agent_code or "").strip()
    if not code:
        return False

    # Look up the bot_id before deleting so we can clean the in-memory config.
    try:
        from evoflow.persistence.config_repositories import get_bot_binding_by_agent, delete_bot_binding

        binding = get_bot_binding_by_agent("wecom", code)
        if not binding:
            return False
        deleted = delete_bot_binding("wecom", binding["bot_id"])
        if deleted:
            _remove_binding_from_channel_service("wecom", binding["bot_id"])
        return deleted
    except Exception:
        logger.debug("remove_role_account_from_channel: bot_bindings path failed, trying legacy JSON", exc_info=True)
        return _remove_legacy_json(code)


def _remove_binding_from_channel_service(platform: str, bot_id: str) -> None:
    """Remove the account from ChannelService's in-memory config."""
    try:
        from evoflow.runtime.ports import get_channel_service

        service = get_channel_service()
        if service is None:
            return
        cfg: dict = dict(service._config.get(platform) or {})
        accounts: dict = dict(cfg.get("accounts") or {})
        # Remove by bot_id lookup (we don't have agent_code here directly).
        key_to_remove = None
        for k, v in accounts.items():
            if str(v.get("bot_id") or "").strip() == bot_id:
                key_to_remove = k
                break
        if key_to_remove:
            del accounts[key_to_remove]
            cfg["accounts"] = accounts
            service._config[platform] = cfg
            logger.info("[wecom_binding] removed from channel service: bot_id=%s", bot_id)
    except Exception:
        logger.debug("wecom_binding: _remove_binding_from_channel_service failed", exc_info=True)


# Legacy JSON removal (migration bridge — can be deleted after one stable release).
def _remove_legacy_json(agent_code: str) -> bool:
    """Fallback: remove from the old channels.wecom.accounts JSON blob."""
    try:
        from evoflow.config.app_config import update_channels_section_and_save

        channels: dict = {}
        try:
            from evoflow.config.app_config import get_app_config
            cfg = get_app_config()
            dumped = cfg.model_dump(mode="json") if hasattr(cfg, "model_dump") else {}
            ch = dumped.get("channels") if isinstance(dumped, dict) else None
            if isinstance(ch, dict):
                channels = ch
        except Exception:
            pass
        wecom: dict = dict(channels.get("wecom") or {})
        accounts: dict = dict(wecom.get("accounts") or {})
        if agent_code not in accounts:
            return False
        del accounts[agent_code]
        wecom["accounts"] = accounts
        channels["wecom"] = wecom
        update_channels_section_and_save(channels)
        return True
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Channel restart
# ---------------------------------------------------------------------------


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


# ---------------------------------------------------------------------------
# Apply / unbind high-level operations
# ---------------------------------------------------------------------------


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
