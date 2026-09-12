"""OAuth token support for MCP HTTP/SSE servers."""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from evoflow.config.extensions_config import ExtensionsConfig, McpOAuthConfig

logger = logging.getLogger(__name__)


@dataclass
class _OAuthToken:
    """Cached OAuth token."""

    access_token: str
    token_type: str
    expires_at: datetime
    refresh_token: str | None = None


class OAuthTokenManager:
    """Acquire/cache/refresh OAuth tokens for MCP servers."""

    def __init__(self, oauth_by_server: dict[str, McpOAuthConfig]):
        self._oauth_by_server = oauth_by_server
        self._tokens: dict[str, _OAuthToken] = {}
        self._locks: dict[str, asyncio.Lock] = {name: asyncio.Lock() for name in oauth_by_server}
        self._inflight: dict[str, asyncio.Task[_OAuthToken]] = {}

    @classmethod
    def from_extensions_config(cls, extensions_config: ExtensionsConfig) -> OAuthTokenManager:
        oauth_by_server: dict[str, McpOAuthConfig] = {}
        for server_name, server_config in extensions_config.get_enabled_mcp_servers().items():
            if server_config.oauth and server_config.oauth.enabled:
                oauth_by_server[server_name] = server_config.oauth
        return cls(oauth_by_server)

    def has_oauth_servers(self) -> bool:
        return bool(self._oauth_by_server)

    def oauth_server_names(self) -> list[str]:
        return list(self._oauth_by_server.keys())

    @staticmethod
    def _format_header(token: _OAuthToken) -> str:
        return f"{token.token_type} {token.access_token}"

    async def get_authorization_header(self, server_name: str) -> str | None:
        oauth = self._oauth_by_server.get(server_name)
        if not oauth:
            return None

        token = self._tokens.get(server_name)
        if token and not self._is_expiring(token, oauth):
            return self._format_header(token)

        lock = self._locks[server_name]
        async with lock:
            token = self._tokens.get(server_name)
            if token and not self._is_expiring(token, oauth):
                return self._format_header(token)

            inflight = self._inflight.get(server_name)
            if inflight is None:
                inflight = asyncio.create_task(self._fetch_token(oauth))
                self._inflight[server_name] = inflight

        try:
            fresh = await inflight
        except Exception:
            async with lock:
                if self._inflight.get(server_name) is inflight:
                    self._inflight.pop(server_name, None)
            raise

        async with lock:
            if self._inflight.get(server_name) is inflight:
                self._inflight.pop(server_name, None)
            self._tokens[server_name] = fresh
            if fresh.refresh_token and oauth.grant_type == "refresh_token":
                oauth.refresh_token = fresh.refresh_token
                self._persist_rotated_refresh_token(server_name, fresh.refresh_token)
            logger.info("Refreshed OAuth access token for MCP server: %s", server_name)

        return self._format_header(fresh)

    def _persist_rotated_refresh_token(self, server_name: str, refresh_token: str) -> None:
        """Best-effort persist rotated refresh_token into MCP server config."""
        try:
            from evoflow.config.extensions_config import (
                get_extensions_config,
                reload_extensions_config,
                save_extensions_to_db,
            )

            ext = get_extensions_config()
            srv = ext.mcp_servers.get(server_name)
            if srv is None or srv.oauth is None:
                return
            srv.oauth.refresh_token = refresh_token
            save_extensions_to_db(ext)
            reload_extensions_config()
            # Keep in-memory manager map aligned with reloaded config.
            reloaded = get_extensions_config().mcp_servers.get(server_name)
            if reloaded and reloaded.oauth:
                self._oauth_by_server[server_name] = reloaded.oauth
        except Exception:
            logger.warning(
                "Failed to persist rotated OAuth refresh_token for MCP server %s",
                server_name,
                exc_info=True,
            )

    @staticmethod
    def _is_expiring(token: _OAuthToken, oauth: McpOAuthConfig) -> bool:
        now = datetime.now(UTC)
        return token.expires_at <= now + timedelta(seconds=max(oauth.refresh_skew_seconds, 0))

    async def _fetch_token(self, oauth: McpOAuthConfig) -> _OAuthToken:
        import httpx  # pyright: ignore[reportMissingImports]

        data: dict[str, str] = {
            "grant_type": oauth.grant_type,
            **oauth.extra_token_params,
        }

        if oauth.scope:
            data["scope"] = oauth.scope
        if oauth.audience:
            data["audience"] = oauth.audience

        if oauth.grant_type == "client_credentials":
            if not oauth.client_id or not oauth.client_secret:
                raise ValueError("OAuth client_credentials requires client_id and client_secret")
            data["client_id"] = oauth.client_id
            data["client_secret"] = oauth.client_secret
        elif oauth.grant_type == "refresh_token":
            if not oauth.refresh_token:
                raise ValueError("OAuth refresh_token grant requires refresh_token")
            data["refresh_token"] = oauth.refresh_token
            if oauth.client_id:
                data["client_id"] = oauth.client_id
            if oauth.client_secret:
                data["client_secret"] = oauth.client_secret
        else:
            raise ValueError(f"Unsupported OAuth grant type: {oauth.grant_type}")

        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.post(oauth.token_url, data=data)
            response.raise_for_status()
            payload = response.json()

        access_token = payload.get(oauth.token_field)
        if not access_token:
            raise ValueError(f"OAuth token response missing '{oauth.token_field}'")

        token_type = str(payload.get(oauth.token_type_field, oauth.default_token_type) or oauth.default_token_type)

        expires_in_raw = payload.get(oauth.expires_in_field, 3600)
        try:
            expires_in = int(expires_in_raw)
        except (TypeError, ValueError):
            expires_in = 3600

        expires_at = datetime.now(UTC) + timedelta(seconds=max(expires_in, 1))
        new_refresh = payload.get("refresh_token")
        rotated = str(new_refresh).strip() if new_refresh else None
        return _OAuthToken(
            access_token=access_token,
            token_type=token_type,
            expires_at=expires_at,
            refresh_token=rotated or None,
        )


def build_oauth_tool_interceptor(
    extensions_config: ExtensionsConfig | None = None,
    *,
    token_manager: OAuthTokenManager | None = None,
) -> Any | None:
    """Build a tool interceptor that injects OAuth Authorization headers."""
    manager = token_manager or (
        OAuthTokenManager.from_extensions_config(extensions_config) if extensions_config is not None else None
    )
    if manager is None or not manager.has_oauth_servers():
        return None

    async def oauth_interceptor(request: Any, handler: Any) -> Any:
        header = await manager.get_authorization_header(request.server_name)
        if not header:
            return await handler(request)

        updated_headers = dict(request.headers or {})
        updated_headers["Authorization"] = header
        return await handler(request.override(headers=updated_headers))

    return oauth_interceptor


async def get_initial_oauth_headers(
    extensions_config: ExtensionsConfig | None = None,
    *,
    token_manager: OAuthTokenManager | None = None,
) -> dict[str, str]:
    """Get initial OAuth Authorization headers for MCP server connections."""
    manager = token_manager or (
        OAuthTokenManager.from_extensions_config(extensions_config) if extensions_config is not None else None
    )
    if manager is None or not manager.has_oauth_servers():
        return {}

    headers: dict[str, str] = {}
    for server_name in manager.oauth_server_names():
        headers[server_name] = await manager.get_authorization_header(server_name) or ""

    return {name: value for name, value in headers.items() if value}
