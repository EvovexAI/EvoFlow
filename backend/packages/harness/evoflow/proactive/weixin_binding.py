"""Multi-account Weixin (personal WeChat, iLink bot) binding helpers.

Every WeChat iLink bot (one per QR scan) becomes one binding row in
``evoflow_bot_bindings``. Slots in ``channels.weixin.accounts`` are keyed by
the iLink ``account_id`` — **not** by ``agent_code`` — because many bindings
may intentionally carry an empty ``agent_code`` (= route to the channel-wide
default, i.e. the 主智能体). The employee code rides inside the binding row,
and :meth:`app.channels.manager.ChannelManager._weixin_binding_agent_code`
resolves it per inbound message.

Mirrors :mod:`evoflow.proactive.wecom_binding` so the panel needs only
parameterise ``channel`` instead of duplicating glue per platform.
"""

from __future__ import annotations

import logging
from typing import Any

from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Public helpers
# ---------------------------------------------------------------------------


def weixin_binding_public(binding: dict[str, Any] | None) -> dict[str, Any]:
    """UI-safe binding snapshot (never includes the bot token)."""
    if not isinstance(binding, dict):
        return {"bound": False, "account_id": "", "agent_code": "", "is_main_agent": False}
    bot_id = str(binding.get("bot_id") or "").strip()
    code = str(binding.get("agent_code") or "").strip()
    session = binding.get("session_config") if isinstance(binding.get("session_config"), dict) else {}
    enabled = bool(binding.get("enabled", True))
    return {
        "bound": bool(bot_id),
        "account_id": bot_id,
        "agent_code": code,
        "is_main_agent": not code,
        "display_name": str(session.get("display_name") or "").strip(),
        "base_url": str(session.get("base_url") or "").strip(),
        "bot_id_suffix": f"…{bot_id[-4:]}" if bot_id and len(bot_id) >= 4 else bot_id,
        "enabled": enabled,
        "bound_at": str(binding.get("bound_at") or "").strip(),
    }


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _iter_existing_bindings():
    """Yield (bot_id, agent_code, binding_doc) rows from the bot_bindings table.

    Gracefully returns nothing if the table does not exist yet (migration window).
    """
    try:
        from evoflow.persistence.config_repositories import list_bot_bindings

        for row in list_bot_bindings("weixin", enabled_only=False):
            yield (
                str(row.get("bot_id") or "").strip(),
                str(row.get("agent_code") or "").strip(),
                row,
            )
    except Exception:
        pass  # table may not exist during initial migration


def _sync_binding_to_channel_service(
    bot_id: str,
    *,
    agent_code: str,
    token: str,
    base_url: str = "",
    display_name: str = "",
    enabled: bool = True,
) -> None:
    """Push the binding into ChannelService's in-memory config so it takes effect immediately."""
    try:
        from evoflow.runtime.ports import get_channel_service

        service = get_channel_service()
        if service is None:
            return
        cfg: dict = dict(service._config.get("weixin") or {})
        accounts: dict = dict(cfg.get("accounts") or {})
        entry = dict(accounts.get(bot_id) or {})
        entry.update({
            "bot_id": bot_id,
            "account_id": bot_id,
            "token": token,
            "agent_code": agent_code,
            "enabled": enabled,
            "session": {
                **(entry.get("session") if isinstance(entry.get("session"), dict) else {}),
                "display_name": display_name,
                "base_url": base_url,
                **({"assistant_id": agent_code} if agent_code else {}),
            },
        })
        entry["session"] = {k: v for k, v in entry["session"].items() if v}
        accounts[bot_id] = entry
        cfg["accounts"] = accounts
        cfg["enabled"] = True
        service._config["weixin"] = cfg
        logger.info(
            "[weixin_binding] in-memory sync ok: account=%s agent_code=%r",
            bot_id,
            agent_code,
        )
    except Exception:
        logger.debug("weixin_binding: _sync_binding_to_channel_service failed", exc_info=True)


def _remove_binding_from_channel_service(bot_id: str) -> None:
    """Remove the account from ChannelService's in-memory config."""
    try:
        from evoflow.runtime.ports import get_channel_service

        service = get_channel_service()
        if service is None:
            return
        cfg: dict = dict(service._config.get("weixin") or {})
        accounts: dict = dict(cfg.get("accounts") or {})
        # weixin accounts are keyed by the iLink account_id itself.
        key_to_remove = bot_id if bot_id in accounts else None
        if key_to_remove is None:
            for k, v in accounts.items():
                if str((v or {}).get("bot_id") or (v or {}).get("account_id") or "").strip() == bot_id:
                    key_to_remove = k
                    break
        if key_to_remove:
            del accounts[key_to_remove]
            cfg["accounts"] = accounts
            service._config["weixin"] = cfg
            logger.info("[weixin_binding] removed from channel service: account=%s", bot_id)
    except Exception:
        logger.debug("weixin_binding: _remove_binding_from_channel_service failed", exc_info=True)


# ---------------------------------------------------------------------------
# Write path: upsert / update / remove bindings
# ---------------------------------------------------------------------------


def sync_weixin_account_binding(
    account_id: str,
    *,
    token: str,
    agent_code: str = "",
    display_name: str = "",
    base_url: str = "",
    enabled: bool = True,
) -> dict[str, Any]:
    """Upsert the weixin binding row (1 row per bot) and hot-sync ChannelService.

    Invariants enforced here:
    - one iLink bot = one binding row (UNIQUE(platform, bot_id) in the table);
    - one employee = at most one weixin bot (no other bot_id may already carry
      the same non-empty ``agent_code``).
    """
    bid = str(account_id or "").strip()
    sec = str(token or "").strip()
    if not bid or not sec:
        raise ValueError("account_id and token are required")
    code = str(agent_code or "").strip()

    for existing_bot_id, existing_code, _row in _iter_existing_bindings():
        if existing_bot_id == bid:
            continue
        if code and existing_code == code:
            raise ValueError(
                f"employee {code!r} already binds weixin account {existing_bot_id!r}; "
                "one employee may bind at most one WeChat bot"
            )

    from evoflow.persistence.config_repositories import get_bot_binding, upsert_bot_binding

    existing = get_bot_binding("weixin", bid)
    session_config: dict[str, Any] = dict(existing.get("session_config") or {}) if existing else {}
    if base_url:
        session_config["base_url"] = base_url
    if display_name:
        session_config["display_name"] = display_name
    if code:
        session_config["assistant_id"] = code
    else:
        session_config.pop("assistant_id", None)
    bound_at = str(existing.get("bound_at") or "").strip() if existing else utc_now_iso_z()

    upsert_bot_binding(
        platform="weixin",
        bot_id=bid,
        agent_code=code,
        bot_secret=sec,
        workspace_root="",
        session_config=session_config,
        enabled=enabled,
        bound_at=bound_at,
    )

    _sync_binding_to_channel_service(
        bid,
        agent_code=code,
        token=sec,
        base_url=base_url,
        display_name=display_name,
        enabled=enabled,
    )

    from evoflow.persistence.config_repositories import get_bot_binding as _get

    return weixin_binding_public(_get("weixin", bid))


def update_weixin_account_binding(
    account_id: str,
    *,
    agent_code: str | None = None,
    display_name: str | None = None,
    enabled: bool | None = None,
) -> dict[str, Any]:
    """Patch display_name / enabled / 改绑 agent_code on an existing binding."""
    bid = str(account_id or "").strip()
    if not bid:
        raise ValueError("account_id is required")

    from evoflow.persistence.config_repositories import get_bot_binding

    binding = get_bot_binding("weixin", bid)
    if binding is None:
        raise LookupError(f"weixin account {bid!r} is not bound")

    code = binding.get("agent_code") if agent_code is None else str(agent_code or "").strip()
    code = str(code or "").strip()

    for existing_bot_id, existing_code, _row in _iter_existing_bindings():
        if existing_bot_id == bid:
            continue
        if code and existing_code == code:
            raise ValueError(
                f"employee {code!r} already binds weixin account {existing_bot_id!r}; "
                "one employee may bind at most one WeChat bot"
            )

    session_config: dict[str, Any] = dict(binding.get("session_config") or {})
    if display_name is not None:
        session_config["display_name"] = str(display_name or "").strip()
    if code:
        session_config["assistant_id"] = code
    else:
        session_config.pop("assistant_id", None)

    from evoflow.persistence.config_repositories import upsert_bot_binding

    upsert_bot_binding(
        platform="weixin",
        bot_id=bid,
        agent_code=code,
        bot_secret=str(binding.get("bot_secret") or ""),
        workspace_root=str(binding.get("workspace_root") or ""),
        session_config=session_config,
        enabled=bool(binding.get("enabled", True) if enabled is None else enabled),
        bound_at=str(binding.get("bound_at") or ""),
    )

    _sync_binding_to_channel_service(
        bid,
        agent_code=code,
        token=str(binding.get("bot_secret") or ""),
        base_url=str(session_config.get("base_url") or ""),
        display_name=str(session_config.get("display_name") or ""),
        enabled=bool(binding.get("enabled", True) if enabled is None else enabled),
    )

    return weixin_binding_public(get_bot_binding("weixin", bid))


def remove_weixin_account_binding(account_id: str) -> bool:
    """Remove the binding row and clean the in-memory channel config."""
    bid = str(account_id or "").strip()
    if not bid:
        return False
    try:
        from evoflow.persistence.config_repositories import delete_bot_binding

        deleted = delete_bot_binding("weixin", bid)
        if deleted:
            _remove_binding_from_channel_service(bid)
        return deleted
    except Exception:
        logger.debug("remove_weixin_account_binding failed account=%s", bid, exc_info=True)
        return False


# ---------------------------------------------------------------------------
# Channel restart
# ---------------------------------------------------------------------------


async def restart_weixin_channel_if_possible() -> bool:
    """Best-effort restart so new/changed accounts start receiving messages."""
    try:
        from evoflow.runtime.ports import get_channel_service

        service = get_channel_service()
        if service is None:
            return False
        return await service.restart_channel("weixin")
    except Exception:
        logger.warning("weixin_binding: restart weixin channel failed", exc_info=True)
        return False


# ---------------------------------------------------------------------------
# Apply / unbind high-level operations (employee QR binding flow)
# ---------------------------------------------------------------------------


async def apply_registration_to_role(
    agent_code: str,
    *,
    account_id: str,
    token: str,
    base_url: str = "",
    display_name: str = "",
) -> dict[str, Any]:
    """Persist an employee's WeChat bot binding and sync/restart the weixin channel."""
    code = str(agent_code or "").strip()
    from evoflow.proactive.repositories import ProactiveRepository

    role = ProactiveRepository.get_role(code)
    if role is None:
        raise LookupError(f"Role '{code}' not found")

    cfg = role.config
    cfg.weixin_account_id = str(account_id or "").strip()
    cfg.weixin_bound_at = utc_now_iso_z()
    role.config = cfg
    ProactiveRepository.save_role(role)

    binding = sync_weixin_account_binding(
        cfg.weixin_account_id,
        token=str(token or "").strip(),
        agent_code=code,
        display_name=display_name,
        base_url=base_url,
    )
    running = await restart_weixin_channel_if_possible()

    return {
        "ok": True,
        "agent_code": code,
        "channel_running": bool(running),
        "binding": binding,
        "account_id": cfg.weixin_account_id,
        "role_name": str(role.role_name or code).strip() or code,
    }


async def unbind_role_weixin(agent_code: str) -> dict[str, Any]:
    """Clear the employee's WeChat binding (role fields + channel account)."""
    code = str(agent_code or "").strip()
    from evoflow.proactive.repositories import ProactiveRepository

    role = ProactiveRepository.get_role(code)
    if role is None:
        raise LookupError(f"Role '{code}' not found")

    cfg = role.config
    account_id = str(cfg.weixin_account_id or "").strip()
    cfg.weixin_account_id = ""
    cfg.weixin_bound_at = ""
    role.config = cfg
    ProactiveRepository.save_role(role)

    if account_id:
        remove_weixin_account_binding(account_id)
    running = await restart_weixin_channel_if_possible()
    return {
        "ok": True,
        "agent_code": code,
        "channel_running": bool(running),
        "binding": {"bound": False, "account_id": "", "agent_code": "", "is_main_agent": False},
    }
