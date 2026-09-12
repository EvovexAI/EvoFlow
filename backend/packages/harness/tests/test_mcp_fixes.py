"""Tests for MCP config, OAuth, client helpers, and cache peek."""

from __future__ import annotations

import asyncio
import threading
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from evoflow.config.extensions_config import ExtensionsConfig, McpOAuthConfig, McpServerConfig
from evoflow.mcp.cache import (
    get_cached_mcp_tools,
    peek_cached_mcp_tools,
    register_mcp_init_loop,
    reset_mcp_tools_cache,
)
from evoflow.mcp.client import build_server_params
from evoflow.mcp.oauth import OAuthTokenManager, build_oauth_tool_interceptor, get_initial_oauth_headers


def test_peek_cached_mcp_tools_never_triggers_lazy_init() -> None:
    reset_mcp_tools_cache()
    with patch("evoflow.mcp.cache._sync_initialize_on_loop") as mock_init:
        assert peek_cached_mcp_tools() == []
        mock_init.assert_not_called()


def test_get_cached_mcp_tools_on_loop_thread_never_blocks_loop() -> None:
    reset_mcp_tools_cache()

    async def _run() -> list:
        with patch("evoflow.mcp.cache._sync_initialize_on_loop") as mock_init:
            tools = get_cached_mcp_tools()
            mock_init.assert_not_called()
            return tools

    assert asyncio.run(_run()) == []


def test_get_cached_mcp_tools_lazy_inits_from_worker_thread() -> None:
    reset_mcp_tools_cache()
    loop = asyncio.new_event_loop()
    register_mcp_init_loop(loop)
    loop_thread = threading.Thread(target=loop.run_forever, daemon=True)
    loop_thread.start()

    try:
        with patch("evoflow.mcp.cache._sync_initialize_on_loop") as mock_sync:
            with ThreadPoolExecutor(max_workers=1) as pool:
                pool.submit(get_cached_mcp_tools).result(timeout=5)
            mock_sync.assert_called_once()
    finally:
        loop.call_soon_threadsafe(loop.stop)
        loop_thread.join(timeout=2)
        loop.close()


def test_resolve_env_braced_and_list_strings(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MCP_TOKEN", "secret")
    monkeypatch.setenv("MCP_HOST", "localhost")
    payload = {
        "mcp_servers": {
            "srv": {
                "env": {"TOKEN": "${MCP_TOKEN}", "HOST": "$MCP_HOST"},
                "args": ["--token", "$MCP_TOKEN"],
            }
        }
    }
    out = ExtensionsConfig.resolve_env_variables(payload)
    assert out["mcp_servers"]["srv"]["env"]["TOKEN"] == "secret"
    assert out["mcp_servers"]["srv"]["env"]["HOST"] == "localhost"
    assert out["mcp_servers"]["srv"]["args"] == ["--token", "secret"]


def test_build_server_params_forwards_extra_fields() -> None:
    cfg = McpServerConfig.model_validate(
        {
            "type": "http",
            "url": "https://example/mcp",
            "timeout": 30,
        }
    )
    params = build_server_params("demo", cfg)
    assert params["transport"] == "http"
    assert params["url"] == "https://example/mcp"
    assert params["timeout"] == 30


@pytest.mark.asyncio
async def test_oauth_concurrent_fetch_shares_inflight_task() -> None:
    oauth = McpOAuthConfig(
        token_url="https://auth.example/token",
        client_id="id",
        client_secret="secret",
    )
    manager = OAuthTokenManager({"srv": oauth})
    calls = 0

    async def fake_fetch(_oauth: McpOAuthConfig):
        nonlocal calls
        calls += 1
        await asyncio.sleep(0.05)
        from datetime import UTC, datetime, timedelta

        from evoflow.mcp.oauth import _OAuthToken

        return _OAuthToken(access_token="tok", token_type="Bearer", expires_at=datetime.now(UTC) + timedelta(hours=1))

    with patch.object(manager, "_fetch_token", side_effect=fake_fetch):
        headers = await asyncio.gather(
            manager.get_authorization_header("srv"),
            manager.get_authorization_header("srv"),
            manager.get_authorization_header("srv"),
        )
    assert calls == 1
    assert headers == ["Bearer tok", "Bearer tok", "Bearer tok"]


@pytest.mark.asyncio
async def test_oauth_initial_headers_and_interceptor_share_manager() -> None:
    oauth = McpOAuthConfig(
        token_url="https://auth.example/token",
        client_id="id",
        client_secret="secret",
    )
    ext = ExtensionsConfig(
        mcp_servers={
            "srv": McpServerConfig(type="http", url="https://example/mcp", oauth=oauth),
        }
    )
    manager = OAuthTokenManager.from_extensions_config(ext)

    with patch.object(manager, "get_authorization_header", new=AsyncMock(return_value="Bearer shared")) as mock_hdr:
        headers = await get_initial_oauth_headers(token_manager=manager)
        interceptor = build_oauth_tool_interceptor(token_manager=manager)
        assert interceptor is not None
        handler = AsyncMock(return_value="ok")
        req = MagicMock()
        req.server_name = "srv"
        req.headers = {}
        req.override = lambda **kwargs: req
        await interceptor(req, handler)
        assert headers["srv"] == "Bearer shared"
        assert mock_hdr.await_count == 2


def test_format_mcp_error_unwraps_exception_group() -> None:
    from evoflow.mcp.tools import _format_mcp_error, _mcp_error_hint

    inner = FileNotFoundError("python not found")
    group = ExceptionGroup("unhandled errors in a TaskGroup", [inner])
    text = _format_mcp_error(group)
    assert "python not found" in text

    hinted = _mcp_error_hint("excel", {"transport": "stdio", "command": "python"}, text)
    assert "PATH" in hinted or "可执行文件" in hinted


def test_per_server_timeout_from_raw_config(monkeypatch: pytest.MonkeyPatch) -> None:
    from evoflow.mcp.tools import _per_server_timeout_sec

    monkeypatch.delenv("EVOFLOW_MCP_SERVER_TIMEOUT_SEC", raising=False)
    assert _per_server_timeout_sec() == 45.0
    assert _per_server_timeout_sec({"timeout": 90}) == 90.0
    monkeypatch.setenv("EVOFLOW_MCP_SERVER_TIMEOUT_SEC", "30")
    assert _per_server_timeout_sec({"timeout": 60}) == 60.0


def test_looks_like_server_entry_requires_command_or_url() -> None:
    from evoflow.mcp.config_io import _looks_like_server_entry

    assert _looks_like_server_entry({"args": ["-y"]}) is False
    assert _looks_like_server_entry({"command": "npx", "args": ["-y", "pkg"]}) is True
    assert _looks_like_server_entry({"url": "https://example/mcp"}) is True


def test_normalize_rejects_stdio_without_command() -> None:
    from evoflow.mcp.tools import _normalize_mcp_server_config

    assert _normalize_mcp_server_config("empty", {"type": "stdio"}) is None
    assert _normalize_mcp_server_config("empty2", {"command": ""}) is None
    ok = _normalize_mcp_server_config("ok", {"command": "npx", "args": ["-y", "pkg"]})
    assert ok is not None
    assert ok["command"] == "npx"
    assert "timeout" not in ok


def test_status_transport_prefers_explicit_type() -> None:
    from evoflow.mcp.status import _infer_mcp_transport

    assert _infer_mcp_transport({"type": "http", "url": "https://x/mcp"}) == "http"
    assert _infer_mcp_transport({"type": "sse", "url": "https://x/mcp"}) == "sse"
    assert _infer_mcp_transport({"url": "https://x/sse"}) == "sse"
    assert _infer_mcp_transport({"url": "https://x/mcp"}) == "http"
    assert _infer_mcp_transport({"command": "npx"}) == "stdio"


def test_install_cmd_rejects_bare_npx() -> None:
    from evoflow.mcp.market import _install_cmd_to_config

    bare = _install_cmd_to_config("npx")
    assert bare.get("command") == ""
    assert bare.get("enabled") is False
    bare_y = _install_cmd_to_config("npx -y")
    assert bare_y.get("command") == ""
    ok = _install_cmd_to_config("npx -y @scope/pkg")
    assert ok["command"] == "npx"
    assert ok["args"] == ["-y", "@scope/pkg"]


def test_build_server_params_stdio_skips_timeout() -> None:
    cfg = McpServerConfig.model_validate(
        {
            "type": "stdio",
            "command": "npx",
            "args": ["-y", "pkg"],
            "timeout": 30,
            "cwd": "/tmp",
        }
    )
    params = build_server_params("demo", cfg)
    assert params["transport"] == "stdio"
    assert "timeout" not in params
    assert "cwd" not in params
