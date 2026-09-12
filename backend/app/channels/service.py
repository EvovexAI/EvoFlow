"""ChannelService — manages the lifecycle of all IM channels."""

from __future__ import annotations

import asyncio
import copy
import logging
import os
from typing import Any

from app.channels.manager import DEFAULT_GATEWAY_URL, DEFAULT_LANGGRAPH_URL, ChannelManager
from app.channels.message_bus import MessageBus
from app.channels.store import ChannelStore

logger = logging.getLogger(__name__)

# Channel name → import path for lazy loading
_CHANNEL_REGISTRY: dict[str, str] = {
    "feishu": "app.channels.feishu:FeishuChannel",
    "weixin": "app.channels.weixin:WeixinChannel",
    "slack": "app.channels.slack:SlackChannel",
    "telegram": "app.channels.telegram:TelegramChannel",
}

_CHANNELS_LANGGRAPH_URL_ENV = "EVOFLOW_CHANNELS_LANGGRAPH_URL"
_CHANNELS_GATEWAY_URL_ENV = "EVOFLOW_CHANNELS_GATEWAY_URL"


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
    channels_status = {
        name: {"enabled": False, "running": False}
        for name in _CHANNEL_REGISTRY
    }
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

    async def _start_channel(self, name: str, config: dict[str, Any]) -> bool:
        """Instantiate and start a single channel."""
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

        try:
            channel = channel_cls(bus=self.bus, config=config)
            channel.store = self.store
            if name == "feishu":
                channel._claude_code_chat_mode = self.manager._claude_code_chat_mode
            await channel.start()
            self._channels[name] = channel
            logger.info("Channel %s started", name)
            return True
        except Exception:
            logger.exception("Failed to start channel %s", name)
            return False

    def get_status(self) -> dict[str, Any]:
        """Return status information for all channels."""
        channels_status = {}
        for name in _CHANNEL_REGISTRY:
            config = self._config.get(name, {})
            enabled = isinstance(config, dict) and config.get("enabled", False)
            running = name in self._channels and self._channels[name].is_running
            channels_status[name] = {
                "enabled": enabled,
                "running": running,
            }
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
