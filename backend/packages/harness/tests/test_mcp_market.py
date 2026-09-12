"""Tests for MCP marketplace (Registry install resolution)."""

import asyncio

from evoflow.mcp.market import (
    _config_from_github_repo,
    _env_from_glama_schema,
    _install_cmd_to_config,
    _parse_github_repo,
    _search_registry_by_keyword,
    registry_server_to_mcp_config,
    resolve_mcp_install_config,
)


def test_install_cmd_to_config_npx():
    cfg = _install_cmd_to_config("npx -y @modelcontextprotocol/server-github", description="gh")
    assert cfg["type"] == "stdio"
    assert cfg["command"] == "npx"
    assert cfg["args"] == ["-y", "@modelcontextprotocol/server-github"]
    assert cfg["description"] == "gh"


def test_registry_npm_package_to_stdio():
    payload = {
        "server": {
            "name": "com.example/demo",
            "description": "Demo server",
            "packages": [
                {
                    "registryType": "npm",
                    "identifier": "demo-mcp-server",
                    "runtimeHint": "npx",
                    "transport": {"type": "stdio"},
                    "runtimeArguments": [{"value": "-y", "type": "positional"}],
                    "environmentVariables": [
                        {"name": "API_KEY", "isSecret": True},
                        {"name": "DEBUG", "default": "false"},
                    ],
                }
            ],
        }
    }
    cfg = registry_server_to_mcp_config(payload)
    assert cfg is not None
    assert cfg["type"] == "stdio"
    assert cfg["command"] == "npx"
    assert cfg["args"] == ["-y", "demo-mcp-server"]
    assert cfg["env"]["API_KEY"] == "$API_KEY"
    assert cfg["env"]["DEBUG"] == "false"


def test_registry_remote_to_http():
    payload = {
        "server": {
            "description": "Remote MCP",
            "remotes": [
                {
                    "type": "streamable-http",
                    "url": "https://example.com/mcp",
                    "headers": [{"name": "Authorization", "value": "Bearer {token}", "isSecret": True}],
                }
            ],
        }
    }
    cfg = registry_server_to_mcp_config(payload)
    assert cfg is not None
    assert cfg["type"] == "http"
    assert cfg["url"] == "https://example.com/mcp"
    assert cfg["headers"]["Authorization"] == "$TOKEN"


def test_resolve_hot_slug_before_registry(monkeypatch):
    async def fake_registry(*_args, **_kwargs):
        return {
            "server": {
                "name": "wrong/github-match",
                "remotes": [{"type": "streamable-http", "url": "https://example.com/mcp"}],
            }
        }

    monkeypatch.setattr("evoflow.mcp.market._search_registry_by_keyword", fake_registry)

    result = asyncio.run(resolve_mcp_install_config(slug="github"))
    assert result["name"] == "GitHub MCP Server"
    assert result["config"]["command"] == "npx"
    assert "@modelcontextprotocol/server-github" in result["config"]["args"]


def test_search_registry_does_not_return_unrelated_match_for_repo_filter(monkeypatch):
    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {
                "servers": [
                    {
                        "server": {
                            "name": "io.example/wrong",
                            "repository": {"url": "https://github.com/other/wrong-mcp"},
                        }
                    }
                ]
            }

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def get(self, *_args, **_kwargs):
            return FakeResponse()

    monkeypatch.setattr("evoflow.mcp.market.httpx.AsyncClient", lambda **_kw: FakeClient())
    entry = asyncio.run(
        _search_registry_by_keyword(
            "llm-web-mcp",
            repo_url="https://github.com/sv-kagami/llm-web-mcp",
        )
    )
    assert entry is None


def test_env_from_glama_schema():
    env = _env_from_glama_schema(
        {
            "properties": {
                "WEB_MCP_USER_AGENT": {"type": "string", "default": "LocalLLM-WebMCP/0.1"},
                "SECRET_KEY": {"type": "string", "isSecret": True},
            }
        }
    )
    assert env["WEB_MCP_USER_AGENT"] == "LocalLLM-WebMCP/0.1"
    assert env["SECRET_KEY"] == "$SECRET_KEY"


def test_parse_github_repo():
    assert _parse_github_repo("https://github.com/sv-kagami/llm-web-mcp") == ("sv-kagami", "llm-web-mcp")
    assert _parse_github_repo("https://github.com/sv-kagami/llm-web-mcp.git") == ("sv-kagami", "llm-web-mcp")


def test_config_from_github_typescript_repo(monkeypatch):
    async def fake_fetch_raw(url: str):
        if url.endswith("/tsconfig.json"):
            return "{}"
        if url.endswith("/package.json"):
            return """
            {
              "name": "web-mcp",
              "private": true,
              "bin": { "web-mcp": "dist/index.js" }
            }
            """
        return None

    monkeypatch.setattr("evoflow.mcp.market._fetch_raw_text", fake_fetch_raw)
    cfg = asyncio.run(
        _config_from_github_repo(
            "https://github.com/sv-kagami/llm-web-mcp",
            description="Web MCP",
        )
    )
    assert cfg is not None
    assert cfg["command"] == "npx"
    assert "github:sv-kagami/llm-web-mcp" in cfg["args"]
    assert "node_modules/web-mcp/src/index.ts" in cfg["args"][-1]
    assert cfg["description"] == "Web MCP"


def test_resolve_glama_github_fallback(monkeypatch):
    async def fake_glama_detail(_ns, _slug):
        return {
            "name": "web-mcp",
            "description": "Web search MCP",
            "repository": {"url": "https://github.com/sv-kagami/llm-web-mcp"},
            "environmentVariablesJsonSchema": {
                "properties": {
                    "WEB_MCP_USER_AGENT": {"default": "LocalLLM-WebMCP/0.1"},
                }
            },
        }

    async def fake_registry(*_args, **_kwargs):
        return None

    async def fake_github(repo_url, *, description=""):
        return _install_cmd_to_config("npx -y github:sv-kagami/llm-web-mcp", description=description)

    monkeypatch.setattr("evoflow.mcp.market._fetch_glama_server_detail", fake_glama_detail)
    monkeypatch.setattr("evoflow.mcp.market._search_registry_by_keyword", fake_registry)
    monkeypatch.setattr("evoflow.mcp.market._config_from_github_repo", fake_github)

    result = asyncio.run(
        resolve_mcp_install_config(
            glama_namespace="sv-kagami",
            glama_slug="llm-web-mcp",
            slug="llm-web-mcp",
            repository_url="https://github.com/sv-kagami/llm-web-mcp",
        )
    )
    assert result["name"] == "web-mcp"
    assert result["config"]["env"]["WEB_MCP_USER_AGENT"] == "LocalLLM-WebMCP/0.1"
    assert "github:sv-kagami/llm-web-mcp" in result["config"]["args"]


def test_friendly_glama_401():
    from evoflow.mcp.market import _friendly_glama_error

    msg = _friendly_glama_error(RuntimeError("Client error '401 Unauthorized' for url 'https://glama.ai/api/mcp/v1/servers?first=20'"))
    assert "API Key" in msg
    assert "401 Unauthorized" not in msg


def test_registry_list_item_shape():
    from evoflow.mcp.market import _registry_list_item

    item = _registry_list_item(
        {
            "server": {
                "name": "io.github.example/demo-mcp",
                "title": "Demo MCP",
                "description": "A demo server",
                "packages": [{"registryType": "npm", "identifier": "demo"}],
                "repository": {"url": "https://github.com/example/demo"},
            }
        }
    )
    assert item is not None
    assert item["slug"] == "demo-mcp"
    assert item["name"] == "Demo MCP"
    assert item["registry_name"] == "io.github.example/demo-mcp"
    assert item["source"] == "registry"
    assert item["author"] == "io.github.example"
    assert item["transport"] == "stdio"


def test_search_falls_back_to_registry(monkeypatch):
    from evoflow.mcp.market import search_mcp_market

    monkeypatch.delenv("EVOFLOW_GLAMA_API_KEY", raising=False)
    monkeypatch.delenv("GLAMA_API_KEY", raising=False)

    async def boom(*_a, **_k):
        raise AssertionError("Glama should be skipped without API key")

    async def fake_reg(query, cursor, limit):
        return (
            [
                {
                    "slug": "demo",
                    "name": "Demo",
                    "description": "d",
                    "author": "io.example",
                    "registry_name": "io.example/demo",
                    "source": "registry",
                    "verified": True,
                    "transport": "stdio",
                    "auth": "可选",
                }
            ],
            "next",
            True,
        )

    monkeypatch.setattr("evoflow.mcp.market._fetch_glama", boom)
    monkeypatch.setattr("evoflow.mcp.market._fetch_registry_browse", fake_reg)

    out = asyncio.run(search_mcp_market(query="", limit=10))
    assert out["source"] == "registry"
    assert out["has_more"] is True
    assert out["cursor"] == "reg:next"
    assert any(s.get("source") == "hot" for s in out["servers"])
    assert any(s.get("source") == "registry" for s in out["servers"])
    assert "Glama" in (out.get("warning") or "")
