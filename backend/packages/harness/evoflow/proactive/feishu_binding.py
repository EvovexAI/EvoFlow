"""Per-employee Feishu PersonalAgent binding helpers.

Each smart employee can QR-scan (same flow as Settings → IM) to create/bind a
dedicated Feishu bot. Credentials live on the role ``config_json`` and are
synced into ``channels.feishu.accounts[<agent_code>]`` so the Feishu channel
can run multiple WebSocket clients and route inbound chat to that agent.
"""

from __future__ import annotations

import copy
import logging
from typing import Any

from evoflow.proactive.repositories import ProactiveRepository
from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)


def feishu_binding_public(cfg: Any) -> dict[str, Any]:
    """UI-safe binding snapshot (never includes app_secret)."""
    app_id = str(getattr(cfg, "feishu_app_id", "") or "").strip()
    open_id = str(getattr(cfg, "feishu_open_id", "") or "").strip()
    bound_at = str(getattr(cfg, "feishu_bound_at", "") or "").strip()
    intro_sent_at = str(getattr(cfg, "feishu_intro_sent_at", "") or "").strip()
    if not intro_sent_at and open_id:
        sent = getattr(cfg, "feishu_intro_sent", None) or {}
        if isinstance(sent, dict):
            intro_sent_at = str(sent.get(f"open_id:{open_id}") or "").strip()
    bound = bool(app_id and str(getattr(cfg, "feishu_app_secret", "") or "").strip())
    return {
        "bound": bound,
        "app_id": app_id if bound else "",
        "open_id": open_id if bound else "",
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


def _persist_feishu_accounts(accounts: dict[str, Any], *, ensure_enabled: bool = True) -> None:
    """Write ``channels.feishu.accounts`` (and optionally enable the channel).

    Never copies employee credentials into unlabeled primary ``app_id`` /
    ``app_secret``. When only employee accounts exist, FeishuChannel.start
    bootstraps a tagged WS via ``bootstrap_account_id`` so inbound still routes
    to the employee agent — without making that bot look like the global
    personal-assistant primary.
    """
    from evoflow.config.app_config import update_channels_section_and_save

    channels = _channels_section()
    feishu = dict(channels.get("feishu") or {})
    feishu["accounts"] = accounts
    if ensure_enabled and accounts:
        feishu["enabled"] = True
    channels["feishu"] = feishu
    update_channels_section_and_save(channels)

    # Keep ChannelService in-memory config aligned when running.
    try:
        from evoflow.runtime.ports import get_channel_service

        service = get_channel_service()
        if service is not None:
            cfg = dict(service._config.get("feishu") or {})
            cfg["accounts"] = copy.deepcopy(accounts)
            if ensure_enabled and accounts:
                cfg["enabled"] = True
            # Do not mutate primary app_id/app_secret from employee accounts.
            service._config["feishu"] = cfg
    except Exception:
        logger.debug("feishu_binding: sync ChannelService memory skipped", exc_info=True)


def _clear_role_feishu_credentials(role: Any) -> None:
    """Wipe Feishu fields on a role config (does not touch channel accounts)."""
    cfg = role.config
    cfg.feishu_app_id = ""
    cfg.feishu_app_secret = ""
    cfg.feishu_open_id = ""
    cfg.feishu_bound_at = ""
    cfg.feishu_intro_sent_at = ""
    cfg.feishu_intro_sent = {}
    role.config = cfg


def find_agent_code_for_feishu_app_id(app_id: str) -> str:
    """Return the employee ``agent_code`` that currently owns this Feishu app_id.

    Used to remap inbound events when a stale WebSocket is still tagged with a
    previous employee after QR re-bind / steal.
    """
    aid = str(app_id or "").strip()
    if not aid:
        return ""
    try:
        for role in ProactiveRepository.list_roles():
            code = str(getattr(role, "agent_code", "") or "").strip()
            cfg = getattr(role, "config", None)
            if not code or cfg is None:
                continue
            if str(getattr(cfg, "feishu_app_id", "") or "").strip() == aid:
                return code
    except Exception:
        logger.debug("feishu_binding: find owner for app_id failed", exc_info=True)
    try:
        from evoflow.persistence.config_repositories import get_bot_binding

        row = get_bot_binding("feishu", aid)
        if row:
            return str(row.get("agent_code") or "").strip()
    except Exception:
        logger.debug("feishu_binding: bot_bindings owner lookup failed", exc_info=True)
    return ""


def steal_feishu_app_id_from_other_roles(app_id: str, *, keep_agent_code: str) -> list[str]:
    """Auto-unbind every other employee that still holds this Feishu ``app_id``.

    One Feishu bot (cli_…) may only map to one employee. Re-scanning onto the
    correct role must clear the mistaken prior binding so inbound routing and
    WS clients do not fight over the same credentials.
    """
    aid = str(app_id or "").strip()
    keep = str(keep_agent_code or "").strip()
    if not aid or not keep:
        return []

    cleared: list[str] = []
    try:
        roles = ProactiveRepository.list_roles()
    except Exception:
        logger.debug("feishu_binding: list_roles for steal failed", exc_info=True)
        return []

    for other in roles:
        other_code = str(getattr(other, "agent_code", "") or "").strip()
        if not other_code or other_code == keep:
            continue
        cfg = getattr(other, "config", None)
        if cfg is None:
            continue
        if str(getattr(cfg, "feishu_app_id", "") or "").strip() != aid:
            continue
        try:
            _clear_role_feishu_credentials(other)
            ProactiveRepository.save_role(other)
            remove_role_account_from_channel(other_code)
            cleared.append(other_code)
            logger.info(
                "feishu_binding: stole app_id=%s from agent=%s → keep=%s",
                aid,
                other_code,
                keep,
            )
        except Exception:
            logger.warning(
                "feishu_binding: failed to clear stolen binding from %s",
                other_code,
                exc_info=True,
            )

    # Flat table (ops / migration path): same bot_id may still point at the loser.
    try:
        from evoflow.persistence.config_repositories import delete_bot_binding, get_bot_binding

        row = get_bot_binding("feishu", aid)
        if row is not None:
            owner = str(row.get("agent_code") or "").strip()
            if owner and owner != keep:
                delete_bot_binding("feishu", aid)
    except Exception:
        logger.debug("feishu_binding: bot_bindings steal cleanup skipped", exc_info=True)

    return cleared


def sync_role_account_to_channel(
    agent_code: str,
    *,
    app_id: str,
    app_secret: str,
    open_id: str = "",
    role_name: str = "",
) -> dict[str, Any]:
    """Upsert ``channels.feishu.accounts[agent_code]`` for this employee bot.

    Also drops any other account slots that still carry the same ``app_id``
    (stale JSON after a mistaken bind).
    """
    code = str(agent_code or "").strip()
    if not code:
        raise ValueError("agent_code is required")
    aid = str(app_id or "").strip()
    secret = str(app_secret or "").strip()
    if not aid or not secret:
        raise ValueError("app_id and app_secret are required")

    channels = _channels_section()
    feishu = dict(channels.get("feishu") or {})
    accounts = dict(feishu.get("accounts") or {}) if isinstance(feishu.get("accounts"), dict) else {}
    # Drop duplicate app_id slots before writing the winner.
    for other_code, acc in list(accounts.items()):
        if other_code == code or not isinstance(acc, dict):
            continue
        if str(acc.get("app_id") or "").strip() == aid:
            del accounts[other_code]
            logger.info(
                "feishu_binding: removed duplicate accounts[%s] for app_id=%s",
                other_code,
                aid,
            )
    accounts[code] = {
        "app_id": aid,
        "app_secret": secret,
        "enabled": True,
        "open_id": str(open_id or "").strip(),
        "name": str(role_name or code).strip() or code,
        "session": {"assistant_id": code},
    }
    _persist_feishu_accounts(accounts, ensure_enabled=True)

    # Keep flat table in sync so ChannelService 1-row-per-bot_id path cannot
    # resurrect a stale employee WS after steal / re-bind.
    try:
        from evoflow.persistence.config_repositories import upsert_bot_binding

        upsert_bot_binding(
            platform="feishu",
            bot_id=aid,
            agent_code=code,
            bot_secret=secret,
            workspace_root="",
            session_config={"assistant_id": code},
            enabled=True,
            bound_at=utc_now_iso_z(),
        )
    except Exception:
        logger.debug("feishu_binding: upsert bot_bindings skipped", exc_info=True)

    return accounts[code]


def remove_role_account_from_channel(agent_code: str) -> bool:
    """Remove employee account from ``channels.feishu.accounts`` (+ flat table)."""
    code = str(agent_code or "").strip()
    if not code:
        return False
    channels = _channels_section()
    feishu = dict(channels.get("feishu") or {})
    accounts = dict(feishu.get("accounts") or {}) if isinstance(feishu.get("accounts"), dict) else {}
    removed = False
    stale_app = ""
    if code in accounts:
        acc = accounts.get(code) if isinstance(accounts.get(code), dict) else {}
        stale_app = str((acc or {}).get("app_id") or "").strip()
        del accounts[code]
        _persist_feishu_accounts(accounts, ensure_enabled=bool(accounts) or bool(feishu.get("enabled")))
        removed = True
    try:
        from evoflow.persistence.config_repositories import delete_bot_binding, get_bot_binding_by_agent

        row = get_bot_binding_by_agent("feishu", code)
        bid = str((row or {}).get("bot_id") or stale_app or "").strip()
        if bid:
            delete_bot_binding("feishu", bid)
            removed = True
    except Exception:
        logger.debug("feishu_binding: delete bot_bindings skipped", exc_info=True)
    return removed


async def restart_feishu_channel_if_possible() -> bool:
    """Best-effort restart so new employee bots start receiving messages."""
    try:
        from evoflow.runtime.ports import get_channel_service

        service = get_channel_service()
        if service is None:
            return False
        return await service.restart_channel("feishu")
    except Exception:
        logger.warning("feishu_binding: restart feishu channel failed", exc_info=True)
        return False


async def apply_registration_to_role(
    agent_code: str,
    *,
    app_id: str,
    app_secret: str,
    open_id: str = "",
) -> dict[str, Any]:
    """Persist binding on the role and sync/restart the Feishu channel.

    If this ``app_id`` was previously bound to another employee (wrong QR),
    that prior binding is cleared automatically (steal / 抢绑).
    """
    code = str(agent_code or "").strip()
    role = ProactiveRepository.get_role(code)
    if role is None:
        raise LookupError(f"Role '{code}' not found")

    aid = str(app_id or "").strip()
    stolen_from = steal_feishu_app_id_from_other_roles(aid, keep_agent_code=code)

    cfg = role.config
    prev_open_id = str(getattr(cfg, "feishu_open_id", "") or "").strip()
    new_open_id = str(open_id or "").strip()
    same_binder = bool(new_open_id and new_open_id == prev_open_id)

    cfg.feishu_app_id = aid
    cfg.feishu_app_secret = str(app_secret or "").strip()
    cfg.feishu_open_id = new_open_id
    cfg.feishu_bound_at = utc_now_iso_z()
    # Same scanner re-binding: keep intro markers so Gateway restart / next
    # private message cannot re-spam 「自我介绍」. Only reset private-chat
    # markers when the binder open_id actually changes.
    if not same_binder:
        sent = dict(getattr(cfg, "feishu_intro_sent", None) or {})
        for key in list(sent.keys()):
            if str(key).startswith("open_id:"):
                sent.pop(key, None)
        cfg.feishu_intro_sent = sent
        cfg.feishu_intro_sent_at = ""

    # Ensure feishu stays in approval channels when bound.
    channels = list(cfg.approval_channels or [])
    if "feishu" not in channels:
        channels.append("feishu")
        cfg.approval_channels = channels

    role.config = cfg
    ProactiveRepository.save_role(role)

    sync_role_account_to_channel(
        code,
        app_id=cfg.feishu_app_id,
        app_secret=cfg.feishu_app_secret,
        open_id=cfg.feishu_open_id,
        role_name=role.role_name,
    )
    running = await restart_feishu_channel_if_possible()

    # Best-effort self-introduction to the scanner's private chat (dedicated bot).
    # Non-fatal: the first-@ fallback inside FeishuChannel still covers groups.
    # Guard against re-sending when the channel restart already delivered the intro.
    try:
        from evoflow.proactive.self_intro import push_employee_self_intro

        if str(cfg.feishu_open_id or "").strip():
            # push_employee_self_intro persists feishu_intro_sent / _at on success.
            await push_employee_self_intro(
                code,
                receive_id=str(cfg.feishu_open_id).strip(),
                receive_id_type="open_id",
            )
    except Exception:
        logger.debug("feishu_binding: self-intro push skipped code=%s", code, exc_info=True)

    return {
        "ok": True,
        "agent_code": code,
        "channel_running": bool(running),
        "binding": feishu_binding_public(cfg),
        "app_id": str(cfg.feishu_app_id or "").strip(),
        "role_name": str(role.role_name or code).strip() or code,
        "stolen_from": stolen_from,
    }


async def unbind_role_feishu(agent_code: str) -> dict[str, Any]:
    """Clear role Feishu credentials and remove the channel account."""
    code = str(agent_code or "").strip()
    role = ProactiveRepository.get_role(code)
    if role is None:
        raise LookupError(f"Role '{code}' not found")

    _clear_role_feishu_credentials(role)
    cfg = role.config
    ProactiveRepository.save_role(role)

    remove_role_account_from_channel(code)
    running = await restart_feishu_channel_if_possible()
    return {
        "ok": True,
        "agent_code": code,
        "channel_running": bool(running),
        "binding": feishu_binding_public(cfg),
    }
