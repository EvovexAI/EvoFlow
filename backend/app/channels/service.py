"""ChannelService — manages the lifecycle of all IM channels."""

from __future__ import annotations

import asyncio
import copy
import logging
import os
from typing import Any

from app.channels.manager import DEFAULT_GATEWAY_URL, DEFAULT_LANGGRAPH_URL, ChannelManager, PER_EMPLOYEE_ACCOUNT_CHANNELS
from app.channels.message_bus import MessageBus
from app.channels.store import ChannelStore

logger = logging.getLogger(__name__)

# Channel name → import path for lazy loading
_CHANNEL_REGISTRY: dict[str, str] = {
    "feishu": "app.channels.feishu:FeishuChannel",
    "weixin": "app.channels.weixin:WeixinChannel",
    "wecom": "app.channels.wecom:WecomChannel",
    "dingtalk": "app.channels.dingtalk:DingtalkChannel",
    "slack": "app.channels.slack:SlackChannel",
    "telegram": "app.channels.telegram:TelegramChannel",
}

_CHANNELS_LANGGRAPH_URL_ENV = "EVOFLOW_CHANNELS_LANGGRAPH_URL"
_CHANNELS_GATEWAY_URL_ENV = "EVOFLOW_CHANNELS_GATEWAY_URL"


def _channel_has_primary_credentials(name: str, config: dict[str, Any]) -> bool:
    """Per-channel credential check (returns False ⇒ service should skip starting the instance)."""
    if not isinstance(config, dict):
        return False
    extra = config.get("extra") if isinstance(config.get("extra"), dict) else {}
    if name == "wecom":
        bot_id = str(extra.get("bot_id") or config.get("bot_id") or os.getenv("WECOM_BOT_ID", "")).strip()
        secret = str(extra.get("secret") or config.get("secret") or os.getenv("WECOM_SECRET", "")).strip()
        return bool(bot_id and secret)
    if name == "feishu":
        app_id = str(config.get("app_id") or "").strip()
        app_secret = str(config.get("app_secret") or "").strip()
        return bool(app_id and app_secret)
    if name == "weixin":
        return bool(str(config.get("bot_token") or config.get("token") or "").strip())
    if name == "dingtalk":
        return bool(str(config.get("client_id") or config.get("app_key") or "").strip())
    if name == "slack":
        return bool(str(config.get("bot_token") or "").strip())
    if name == "telegram":
        return bool(str(config.get("bot_token") or "").strip())
    return True


def _merge_account_config(name: str, base_config: dict[str, Any], account_cfg: dict[str, Any]) -> dict[str, Any]:
    """Merge a per-account config block on top of the channel-wide config.

    Account-level keys win; the merged block is what the channel instance sees
    as its top-level config. For WeCom, ``bot_id`` / ``secret`` come from the
    account block; everything else (groups, dm_policy, etc.) is inherited.
    """
    import copy as _copy

    merged = _copy.deepcopy(base_config) if isinstance(base_config, dict) else {}
    if not isinstance(account_cfg, dict):
        return merged
    for key, value in account_cfg.items():
        if key in {"bot_id", "secret", "websocket_url", "app_id", "app_secret", "bot_token", "token", "client_id", "app_key"}:
            # Top-level credentials: copy straight across (channel reads config.get("bot_id") etc.).
            merged[key] = value
        else:
            # Other keys go under ``extra`` so the channel can pull them via
            # ``config.get("extra") or {}`` (matches wecom/feishu convention).
            extra = merged.get("extra")
            if not isinstance(extra, dict):
                extra = {}
                merged["extra"] = extra
            extra[key] = value
    return merged

def resolve_channels_config_from_app() -> dict[str, Any]:
    """Load the ``channels`` subtree from :class:`AppConfig` (YAML extras, attribute, or dump)."""
    from evoflow.config.app_config import get_app_config

    cfg = get_app_config()
    ch = getattr(cfg, "channels", None)
    if isinstance(ch, dict):
        return copy.deepcopy(ch)
    extra = cfg.model_extra or {}
    nested = extra.get("channels")
    if isinstance(nested, dict):
        return copy.deepcopy(nested)
    dumped = cfg.model_dump(mode="json")
    nested = dumped.get("channels")
    if isinstance(nested, dict):
        return copy.deepcopy(nested)
    return {}


def registry_channel_status(*, service_running: bool = False) -> dict[str, Any]:
    """Default channel list when the service is unavailable (UI should still show Feishu/Weixin cards)."""
    channels_status = {name: {"enabled": False, "running": False} for name in _CHANNEL_REGISTRY}
    return {"service_running": service_running, "channels": channels_status}


def _resolve_service_url(
    config: dict[str, Any],
    config_key: str,
    env_key: str,
    default: str,
    *,
    fallback_env_key: str | None = None,
) -> str:
    """Prefer process env over ``config.yaml`` so dev scripts (ports, isolated stack) win.

    ``restart-dev-stack`` sets ``EVOFLOW_CHANNELS_*`` and ``EVOFLOW_LANGGRAPH_URL`` / ``EVOFLOW_GATEWAY_URL``;
    a checked-in ``channels.langgraph_url: http://localhost:2024`` must not override those.
    """
    primary = (os.getenv(env_key, "") or "").strip()
    fallback = (os.getenv(fallback_env_key, "") or "").strip() if fallback_env_key else ""
    env_value = primary or fallback
    chosen_env = env_key if primary else (fallback_env_key or env_key)
    file_value = config.pop(config_key, None)
    if env_value:
        out = env_value.rstrip("/")
        if isinstance(file_value, str) and file_value.strip():
            fv = file_value.strip().rstrip("/")
            if fv != out:
                logger.info(
                    "Channels %s: using %s=%r (overrides config value %r)",
                    config_key,
                    chosen_env,
                    out,
                    file_value,
                )
        return out
    if isinstance(file_value, str) and file_value.strip():
        return file_value.strip().rstrip("/")
    return default.rstrip("/")


class ChannelService:
    """Manages the lifecycle of all configured IM channels.

    Reads configuration from ``config.yaml`` under the ``channels`` key,
    instantiates enabled channels, and starts the ChannelManager dispatcher.
    """

    def __init__(self, channels_config: dict[str, Any] | None = None) -> None:
        self.bus = MessageBus()
        self.store = ChannelStore()
        config = dict(channels_config or {})
        langgraph_url = _resolve_service_url(
            config,
            "langgraph_url",
            _CHANNELS_LANGGRAPH_URL_ENV,
            DEFAULT_LANGGRAPH_URL,
            fallback_env_key="EVOFLOW_LANGGRAPH_URL",
        )
        gateway_url = _resolve_service_url(
            config,
            "gateway_url",
            _CHANNELS_GATEWAY_URL_ENV,
            DEFAULT_GATEWAY_URL,
            fallback_env_key="EVOFLOW_GATEWAY_URL",
        )
        default_session = config.pop("session", None)
        channel_sessions = {name: channel_config.get("session") for name, channel_config in config.items() if isinstance(channel_config, dict)}
        self.manager = ChannelManager(
            bus=self.bus,
            store=self.store,
            langgraph_url=langgraph_url,
            gateway_url=gateway_url,
            default_session=default_session if isinstance(default_session, dict) else None,
            channel_sessions=channel_sessions,
        )
        logger.info("ChannelService: IM → LangGraph %s, channels gateway callbacks %s", langgraph_url, gateway_url)
        self._channels: dict[str, Any] = {}  # name -> Channel instance
        self._config = config
        self._running = False

    def _merged_channels_section(self) -> dict[str, Any]:
        """Build full ``channels`` subtree for YAML: service state + non-channel keys (urls, session)."""
        from evoflow.config.app_config import get_app_config

        cfg = get_app_config()
        merged = copy.deepcopy(cfg.model_dump(mode="json").get("channels") or {})
        for name, entry in self._config.items():
            if isinstance(entry, dict):
                merged[name] = copy.deepcopy(entry)
        return merged

    def _persist_channels_db(self) -> bool:
        """Write merged ``channels`` to SQLite and refresh in-memory :class:`AppConfig`."""
        try:
            from evoflow.config.app_config import update_channels_section_and_save

            update_channels_section_and_save(self._merged_channels_section())
            return True
        except Exception:
            logger.exception("Failed to persist channels to SQLite")
            return False

    @classmethod
    def from_app_config(cls) -> ChannelService:
        """Create a ChannelService from the application config."""
        channels_config = resolve_channels_config_from_app()
        return cls(channels_config=channels_config)

    async def start(self) -> None:
        """Start the manager and all enabled channels (channels start in background)."""
        if self._running:
            return

        await self.manager.start()

        # 初始化飞书流式桥接器（用于子任务输出）
        try:
            from app.channels.feishu_stream_bridge import init_feishu_stream_bridge

            init_feishu_stream_bridge(self.bus)
            logger.info("Feishu stream bridge initialized")
        except Exception:
            logger.warning("Failed to initialize feishu stream bridge", exc_info=True)

        # 所有渠道以异步后台任务启动，不阻塞 Gateway lifespan。
        # 某些渠道（如飞书 WebSocket）可能因网络超时/指数退避耗时数分钟，
        # await 会延迟 Gateway 就绪，影响桌面客户端首次请求体验。
        self._background_tasks: list[asyncio.Task[None]] = []
        for name, channel_config in self._config.items():
            if not isinstance(channel_config, dict):
                continue
            if not channel_config.get("enabled", False):
                logger.info("Channel %s is disabled, skipping", name)
                continue

            task = asyncio.create_task(
                self._background_start_channel(name, channel_config),
                name=f"channel-start-{name}",
            )
            self._background_tasks.append(task)
            logger.info("Channel %s starting in background", name)

        self._running = True
        logger.info(
            "ChannelService started (%d background channel tasks)",
            len(self._background_tasks),
        )

    async def _background_start_channel(self, name: str, config: dict[str, Any]) -> None:
        """Start a single channel as a background task, logging errors without propagating."""
        try:
            await self._start_channel(name, config)
        except Exception:
            logger.exception("Background channel %s failed to start", name)

    async def stop(self) -> None:
        """Stop all channels and the manager."""
        # Wait for background start tasks to finish (timeout per task)
        for task in getattr(self, "_background_tasks", []):
            if not task.done():
                try:
                    await asyncio.wait_for(task, timeout=10.0)
                except TimeoutError:
                    logger.warning("Background channel start task %s timed out", task.get_name())
                except Exception:
                    pass
        for name, channel in list(self._channels.items()):
            try:
                await channel.stop()
                logger.info("Channel %s stopped", name)
            except Exception:
                logger.exception("Error stopping channel %s", name)
        self._channels.clear()

        await self.manager.stop()
        self._running = False
        logger.info("ChannelService stopped")

    async def restart_channel(self, name: str) -> bool:
        """Restart a specific channel. Returns True if successful."""
        if name in self._channels:
            try:
                await self._channels[name].stop()
            except Exception:
                logger.exception("Error stopping channel %s for restart", name)
            del self._channels[name]

        config = self._config.get(name)
        if not config or not isinstance(config, dict):
            logger.warning("No config for channel %s", name)
            return False

        return await self._start_channel(name, config)

    async def set_channel_enabled(self, name: str, enabled: bool) -> bool:
        """Enable or disable a specific channel. Returns True if successful."""
        config = self._config.get(name)
        if not config or not isinstance(config, dict):
            logger.warning("No config for channel %s", name)
            return False

        # Update config
        config["enabled"] = enabled
        self._config[name] = config

        if not self._persist_channels_db():
            return False

        # If channel is currently running, restart it with new enabled state
        if enabled and name not in self._channels:
            return await self._start_channel(name, config)
        elif not enabled and name in self._channels:
            try:
                await self._channels[name].stop()
                del self._channels[name]
            except Exception:
                logger.exception("Error stopping channel %s", name)
                return False

        return True

    def get_channel_config(self, name: str) -> tuple[dict[str, Any] | None, bool, bool]:
        """Get the configuration of a specific channel. Returns (config, enabled, running)."""
        config = self._config.get(name)
        if not config:
            return None, False, False

        enabled = isinstance(config, dict) and config.get("enabled", False)
        running = name in self._channels and self._channels[name].is_running
        return config, enabled, running

    async def update_channel_config(self, name: str, new_config: dict[str, Any]) -> bool:
        """Update the configuration of a specific channel. Returns True if successful."""
        config = self._config.get(name)

        # If channel doesn't exist in config, create a new entry
        if not config or not isinstance(config, dict):
            logger.info("Channel %s not found in config, creating new entry", name)
            config = {"enabled": False}
            self._config[name] = config

        # Update config
        config.update(new_config)
        self._config[name] = config

        if not self._persist_channels_db():
            return False

        # Restart or start channel when enabled
        if name in self._channels:
            try:
                await self._channels[name].stop()
            except Exception:
                logger.exception("Error stopping channel %s for config update", name)
            del self._channels[name]

        if config.get("enabled", False):
            return await self._start_channel(name, config)

        return True

    def _migrate_legacy_accounts_to_table(self, platform: str, legacy_accounts: dict[str, Any]) -> None:
        """One-time migration: copy legacy JSON accounts → evoflow_bot_bindings table."""
        if not legacy_accounts:
            return
        try:
            from evoflow.persistence.config_repositories import upsert_bot_binding, list_bot_bindings

            existing = {r["bot_id"] for r in list_bot_bindings(platform)}
            count = 0
            for agent_code, acc in legacy_accounts.items():
                bid = str(acc.get("bot_id") or "").strip()
                if not bid or bid in existing:
                    continue
                upsert_bot_binding(
                    platform=platform,
                    bot_id=bid,
                    agent_code=str(agent_code or "").strip(),
                    bot_secret=str(acc.get("secret") or "").strip(),
                    workspace_root="",
                    session_config=acc.get("session") or {},
                    enabled=bool(acc.get("enabled", True)),
                    bound_at="",
                )
                existing.add(bid)
                count += 1
            if count:
                logger.info(
                    "[ChannelService] migrated %d legacy %s account(s) to evoflow_bot_bindings",
                    count, platform,
                )
        except Exception:
            logger.exception("[ChannelService] failed to migrate legacy accounts for %s", platform)

    async def _start_channel(self, name: str, config: dict[str, Any]) -> bool:
        """Instantiate and start a single channel.

        Channels that support ``config.accounts`` (per-employee bots) are
        expanded into one channel instance per account. Each instance receives
        its own ``account_id`` so inbound messages can be routed to the
        employee agent. The primary bot (``account_id == ""``) is always
        started when ``bot_id``/``secret`` (or channel equivalent) is
        populated, even if accounts are also defined.

        New per-employee channels (wecom, feishu) read accounts from
        ``evoflow_bot_bindings`` first; legacy JSON in config is used as a
        fallback and migrated on first read.
        """
        import_path = _CHANNEL_REGISTRY.get(name)
        if not import_path:
            logger.warning("Unknown channel type: %s", name)
            return False

        try:
            from evoflow.reflection import resolve_class

            channel_cls = resolve_class(import_path, base_class=None)
        except Exception:
            logger.exception("Failed to import channel class for %s", name)
            return False

        accounts: list[tuple[str, dict[str, Any]]] = []

        # New path: load from evoflow_bot_bindings (flat table).
        # Fall back to legacy JSON in config only if the table has no rows.
        if name in PER_EMPLOYEE_ACCOUNT_CHANNELS:
            from evoflow.persistence.config_repositories import list_bot_bindings

            table_bindings = list_bot_bindings(name)
            if table_bindings:
                for row in table_bindings:
                    accounts.append((row["agent_code"], {
                        "bot_id": row["bot_id"],
                        "secret": row["bot_secret"],
                        "enabled": row["enabled"],
                        "session": row.get("session_config") or {},
                    }))
                logger.info(
                    "[ChannelService] %s: loaded %d bot binding(s) from evoflow_bot_bindings",
                    name, len(accounts),
                )
            else:
                # No rows in the new table yet — try legacy JSON and migrate.
                accounts_cfg = config.get("accounts") if isinstance(config, dict) else None
                if isinstance(accounts_cfg, dict):
                    for aid, entry in accounts_cfg.items():
                        aid_str = str(aid or "").strip()
                        if not aid_str or not isinstance(entry, dict):
                            continue
                        accounts.append((aid_str, entry))
                # Migrate any legacy accounts to the new table on startup.
                if accounts:
                    self._migrate_legacy_accounts_to_table(name, dict(accounts_cfg or {}))
            # Also start the primary bot if it has credentials.
            if _channel_has_primary_credentials(name, config):
                await self._start_channel_instance(name, channel_cls, config, account_id="", instance_key=name)
            for aid, acc_cfg in accounts:
                merged_cfg = _merge_account_config(name, config, acc_cfg)
                if not _channel_has_primary_credentials(name, merged_cfg):
                    logger.warning("Account %s on channel %s has missing credentials, skipping", aid, name)
                    continue
                await self._start_channel_instance(name, channel_cls, merged_cfg, account_id=aid, instance_key=f"{name}:{aid}")
            return True

        # Legacy path for channels without per-employee accounts.
        accounts_cfg = config.get("accounts") if isinstance(config, dict) else None
        if isinstance(accounts_cfg, dict):
            for aid, entry in accounts_cfg.items():
                aid_str = str(aid or "").strip()
                if not aid_str or not isinstance(entry, dict):
                    continue
                accounts.append((aid_str, entry))

        if accounts:
            # Start primary (account_id == "") once if its own credentials are present.
            if _channel_has_primary_credentials(name, config):
                await self._start_channel_instance(name, channel_cls, config, account_id="", instance_key=name)
            # Start one instance per account.
            for aid, acc_cfg in accounts:
                merged_cfg = _merge_account_config(name, config, acc_cfg)
                if not _channel_has_primary_credentials(name, merged_cfg):
                    logger.warning("Account %s on channel %s has missing credentials, skipping", aid, name)
                    continue
                await self._start_channel_instance(name, channel_cls, merged_cfg, account_id=aid, instance_key=f"{name}:{aid}")
            return True

        # Single-instance path (no accounts).
        return await self._start_channel_instance(name, channel_cls, config, account_id="", instance_key=name)

    async def _start_channel_instance(
        self,
        name: str,
        channel_cls: Any,
        config: dict[str, Any],
        *,
        account_id: str,
        instance_key: str,
    ) -> bool:
        try:
            channel = channel_cls(bus=self.bus, config=config, account_id=account_id) if account_id else channel_cls(bus=self.bus, config=config)
            channel.store = self.store
            if name == "feishu":
                channel._claude_code_chat_mode = self.manager._claude_code_chat_mode
            await channel.start()
            self._channels[instance_key] = channel
            logger.info("Channel %s started (account_id=%s)", instance_key, account_id or "-")
            return True
        except TypeError as exc:
            # Backwards compat: channel class doesn't accept ``account_id`` kwarg.
            if "account_id" not in str(exc):
                raise
            try:
                channel = channel_cls(bus=self.bus, config=config)
                channel.store = self.store
                if name == "feishu":
                    channel._claude_code_chat_mode = self.manager._claude_code_chat_mode
                await channel.start()
                self._channels[instance_key] = channel
                logger.info("Channel %s started (legacy, no account_id)", instance_key)
                return True
            except Exception:
                logger.exception("Failed to start channel %s", instance_key)
                return False
        except Exception:
            logger.exception("Failed to start channel %s", instance_key)
            return False

    def get_status(self) -> dict[str, Any]:
        """Return status information for all channels."""
        channels_status = {}
        for name in _CHANNEL_REGISTRY:
            config = self._config.get(name, {})
            enabled = isinstance(config, dict) and config.get("enabled", False)
            # Channel is "running" if the primary key or any per-account instance is running.
            running = (
                name in self._channels and self._channels[name].is_running
            ) or any(
                k.startswith(f"{name}:") and getattr(self._channels[k], "is_running", False)
                for k in self._channels
            )
            # Count bound instances (multi-account expansion).
            bound_running = [
                k[len(name) + 1 :]
                for k in self._channels
                if k.startswith(f"{name}:") and getattr(self._channels[k], "is_running", False)
            ]
            entry: dict[str, Any] = {"enabled": enabled, "running": running}
            if bound_running:
                entry["bound_accounts"] = sorted(bound_running)
            channels_status[name] = entry
        return {
            "service_running": self._running,
            "channels": channels_status,
        }

    async def feishu_push_markdown(self, receive_id: str, text: str, *, receive_id_type: str = "chat_id") -> None:
        """Send a proactive Feishu card message using the running Feishu channel."""
        channel = self._channels.get("feishu")
        if channel is None or not channel.is_running:
            raise RuntimeError("Feishu channel is not enabled or not running")
        send = getattr(channel, "send_proactive_markdown", None)
        if send is None:
            raise RuntimeError("Feishu channel does not support proactive push")
        await send(receive_id, text, receive_id_type=receive_id_type)


# -- singleton access -------------------------------------------------------

_channel_service: ChannelService | None = None


def get_channel_service() -> ChannelService | None:
    """Get the singleton ChannelService instance (if started)."""
    return _channel_service


async def start_channel_service() -> ChannelService:
    """Create and start the global ChannelService from app config."""
    global _channel_service
    if _channel_service is not None:
        return _channel_service
    _channel_service = ChannelService.from_app_config()
    await _channel_service.start()
    return _channel_service


async def stop_channel_service() -> None:
    """Stop the global ChannelService."""
    global _channel_service
    if _channel_service is not None:
        await _channel_service.stop()
        _channel_service = None
