"""MCP per-server timeout（Zcode ``timeoutMs``）与 oauth 配置块对齐测试.

覆盖对齐清单 #5 与 #4：

1. ``server_timeout_sec_from_config``：``timeoutMs``（毫秒）/``timeout``（秒）
   双格式解析、timeoutMs 优先、非法值回退；
2. 建连超时地板语义（``_per_server_timeout_sec``）与调用超时覆盖语义
   （per-server 显式配置覆盖池全局默认，经常驻池端到端验证）；
3. HTTP 传输 ``timeoutMs`` → 适配器 ``timeout``（秒）换算；
4. Zcode 风格 oauth 块（type/clientId/clientSecret/tokenUrl/scopes）在
   ``McpServerConfig`` 上的别名归一与降级策略。
"""

from __future__ import annotations

import sys
import textwrap

import pytest

from evoflow.config.extensions_config import McpServerConfig
from evoflow.mcp.pool import McpConnectionPool, server_timeout_sec_from_config
from evoflow.mcp.tools import _normalize_mcp_server_config, _per_server_timeout_sec

# ── #5：per-server 超时解析 ────────────────────────────────────────────


def test_server_timeout_none_when_unconfigured():
    assert server_timeout_sec_from_config(None) is None
    assert server_timeout_sec_from_config({}) is None
    assert server_timeout_sec_from_config({"command": "npx"}) is None


def test_server_timeout_accepts_timeout_ms():
    assert server_timeout_sec_from_config({"timeoutMs": 30000}) == 30.0
    assert server_timeout_sec_from_config({"timeoutMs": 500}) == pytest.approx(0.5)


def test_server_timeout_accepts_legacy_seconds():
    assert server_timeout_sec_from_config({"timeout": 15}) == 15.0


def test_server_timeout_ms_wins_over_legacy():
    assert server_timeout_sec_from_config({"timeoutMs": 30000, "timeout": 5}) == 30.0


def test_server_timeout_invalid_values_fall_through():
    assert server_timeout_sec_from_config({"timeoutMs": "abc"}) is None
    assert server_timeout_sec_from_config({"timeout": "abc"}) is None
    assert server_timeout_sec_from_config({"timeoutMs": -1}) is None
    # 非法 timeoutMs 回落到合法 timeout
    assert server_timeout_sec_from_config({"timeoutMs": 0, "timeout": 10}) == 10.0


def test_connect_timeout_floor_semantics(monkeypatch):
    # 无配置 → 默认 45s
    assert _per_server_timeout_sec(None) == 45.0
    # per-server 小于默认 → 地板（只增不减，保持既有行为）
    assert _per_server_timeout_sec({"timeoutMs": 10000}) == 45.0
    assert _per_server_timeout_sec({"timeout": 10}) == 45.0
    # per-server 大于默认 → 生效
    assert _per_server_timeout_sec({"timeoutMs": 90000}) == 90.0
    # env 调默认值
    monkeypatch.setenv("EVOFLOW_MCP_SERVER_TIMEOUT_SEC", "60")
    assert _per_server_timeout_sec(None) == 60.0
    assert _per_server_timeout_sec({"timeoutMs": 30000}) == 60.0


def test_http_config_timeout_ms_converted_to_seconds():
    cfg = _normalize_mcp_server_config("t", {"url": "https://x/mcp", "timeoutMs": 25000})
    assert cfg is not None and cfg["timeout"] == 25.0

    cfg = _normalize_mcp_server_config("t", {"url": "https://x/mcp", "timeout": 12})
    assert cfg is not None and cfg["timeout"] == 12

    # timeoutMs 优先于旧字段
    cfg = _normalize_mcp_server_config("t", {"url": "https://x/mcp", "timeoutMs": 25000, "timeout": 12})
    assert cfg is not None and cfg["timeout"] == 25.0


def test_stdio_config_strips_timeout_fields():
    # stdio session 不接受 timeout kwarg：归一化后不应带出
    cfg = _normalize_mcp_server_config("t", {"command": "npx", "args": ["-y", "x"], "timeoutMs": 30000, "timeout": 30})
    assert cfg is not None and "timeout" not in cfg
    assert "timeoutMs" not in cfg


# ── #5：调用超时 per-server 覆盖（常驻池端到端）────────────────────────


@pytest.fixture()
def sleep_server_script(tmp_path):
    script = tmp_path / "sleep_server.py"
    script.write_text(
        textwrap.dedent(
            """
            from mcp.server.fastmcp import FastMCP
            import time

            mcp = FastMCP("sleepy")

            @mcp.tool()
            def nap(seconds: float) -> str:
                \"\"\"Sleep then return.\"\"\"
                time.sleep(seconds)
                return f"slept {seconds}"

            if __name__ == "__main__":
                mcp.run(transport="stdio")
            """
        ),
        encoding="utf-8",
    )
    return str(script)


@pytest.mark.asyncio
async def test_per_server_call_timeout_overrides_global(sleep_server_script, monkeypatch):
    # 全局默认调大到 30s；per-server timeoutMs=1s 必须覆盖它
    monkeypatch.setenv("EVOFLOW_MCP_CALL_TIMEOUT_SEC", "30")
    pool = McpConnectionPool()
    config = {
        "command": sys.executable,
        "args": [sleep_server_script],
        "transport": "stdio",
    }

    tools = await pool.ensure_server_tools(
        "sleepy", config, timeout_sec=30, call_timeout_sec=1.0
    )
    entry = pool._entries.get("sleepy")
    assert entry is not None and entry.call_timeout_sec == 1.0

    nap = {tool.name: tool for tool in tools}["sleepy_nap"]
    # 1s 超时 < 3s nap → 必须按 per-server 超时失败（而非 30s 全局）
    with pytest.raises(RuntimeError, match="timed out after 1s"):
        await nap.coroutine(seconds=3)

    await pool.run_on_pool_loop(pool._shutdown_async())


@pytest.mark.asyncio
async def test_no_per_server_call_timeout_uses_global(sleep_server_script, monkeypatch):
    monkeypatch.setenv("EVOFLOW_MCP_CALL_TIMEOUT_SEC", "2")
    pool = McpConnectionPool()
    config = {"command": sys.executable, "args": [sleep_server_script], "transport": "stdio"}

    tools = await pool.ensure_server_tools("sleepy2", config, timeout_sec=30)
    entry = pool._entries.get("sleepy2")
    assert entry is not None and entry.call_timeout_sec is None

    nap = {tool.name: tool for tool in tools}["sleepy2_nap"]
    with pytest.raises(RuntimeError, match="timed out after 2s"):
        await nap.coroutine(seconds=4)

    await pool.run_on_pool_loop(pool._shutdown_async())


# ── #4：Zcode 风格 oauth 块归一 ────────────────────────────────────────


def test_oauth_zcode_aliases_normalized():
    cfg = McpServerConfig.model_validate(
        {
            "url": "https://x/mcp",
            "type": "http",
            "oauth": {
                "type": "client_credentials",
                "clientId": "cid",
                "clientSecret": "sec",
                "tokenUrl": "https://idp/token",
            },
        }
    )
    assert cfg.oauth is not None
    assert cfg.oauth.grant_type == "client_credentials"
    assert cfg.oauth.client_id == "cid"
    assert cfg.oauth.client_secret == "sec"
    assert cfg.oauth.token_url == "https://idp/token"


def test_oauth_scopes_list_joined():
    cfg = McpServerConfig.model_validate(
        {
            "url": "https://x/mcp",
            "oauth": {
                "grant_type": "client_credentials",
                "token_url": "https://idp/token",
                "scopes": ["read", "write"],
            },
        }
    )
    assert cfg.oauth is not None and cfg.oauth.scope == "read write"


def test_oauth_canonical_config_unaffected():
    cfg = McpServerConfig.model_validate(
        {
            "url": "https://x/mcp",
            "oauth": {
                "grant_type": "client_credentials",
                "client_id": "cid",
                "client_secret": "sec",
                "token_url": "https://idp/token",
            },
        }
    )
    assert cfg.oauth is not None and cfg.oauth.client_id == "cid"


def test_oauth_authorization_code_downgrades_with_refresh_token():
    cfg = McpServerConfig.model_validate(
        {
            "url": "https://x/mcp",
            "oauth": {
                "type": "authorization_code",
                "clientId": "cid",
                "tokenUrl": "https://idp/token",
                "refreshToken": "rtok",
            },
        }
    )
    assert cfg.oauth is not None
    assert cfg.oauth.grant_type == "refresh_token"
    assert cfg.oauth.refresh_token == "rtok"


def test_oauth_authorization_code_without_refresh_token_dropped():
    # 无交互浏览器授权能力：丢弃 oauth 块但 server 本身照常加载
    cfg = McpServerConfig.model_validate(
        {
            "url": "https://x/mcp",
            "oauth": {"type": "authorization_code", "clientId": "cid", "tokenUrl": "https://idp/token"},
        }
    )
    assert cfg.oauth is None


def test_oauth_missing_token_url_dropped():
    # Zcode 靠 discovery 拿 token endpoint；EvoFlow 无 discovery → 丢弃而非拒载
    cfg = McpServerConfig.model_validate(
        {
            "url": "https://x/mcp",
            "oauth": {"type": "client_credentials", "clientId": "cid", "clientSecret": "sec"},
        }
    )
    assert cfg.oauth is None


def test_oauth_alias_does_not_override_canonical():
    cfg = McpServerConfig.model_validate(
        {
            "url": "https://x/mcp",
            "oauth": {
                "grant_type": "refresh_token",
                "type": "client_credentials",  # 别名不应覆盖显式 grant_type
                "token_url": "https://idp/token",
                "refresh_token": "rtok",
            },
        }
    )
    assert cfg.oauth is not None and cfg.oauth.grant_type == "refresh_token"
