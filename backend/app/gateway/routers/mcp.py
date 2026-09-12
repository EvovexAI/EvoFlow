import asyncio
import logging
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from evoflow.authz.http_guard import require_org_admin
from evoflow.config.extensions_config import reload_extensions_config

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["mcp"])


class McpOAuthConfigResponse(BaseModel):
    """OAuth configuration for an MCP server."""

    enabled: bool = Field(default=True, description="Whether OAuth token injection is enabled")
    token_url: str = Field(default="", description="OAuth token endpoint URL")
    grant_type: Literal["client_credentials", "refresh_token"] = Field(default="client_credentials", description="OAuth grant type")
    client_id: str | None = Field(default=None, description="OAuth client ID")
    client_secret: str | None = Field(default=None, description="OAuth client secret")
    refresh_token: str | None = Field(default=None, description="OAuth refresh token")
    scope: str | None = Field(default=None, description="OAuth scope")
    audience: str | None = Field(default=None, description="OAuth audience")
    token_field: str = Field(default="access_token", description="Token response field containing access token")
    token_type_field: str = Field(default="token_type", description="Token response field containing token type")
    expires_in_field: str = Field(default="expires_in", description="Token response field containing expires-in seconds")
    default_token_type: str = Field(default="Bearer", description="Default token type when response omits token_type")
    refresh_skew_seconds: int = Field(default=60, description="Refresh this many seconds before expiry")
    extra_token_params: dict[str, str] = Field(default_factory=dict, description="Additional form params sent to token endpoint")


class McpServerConfigResponse(BaseModel):
    """Response model for MCP server configuration."""

    enabled: bool = Field(default=True, description="Whether this MCP server is enabled")
    type: str = Field(default="stdio", description="Transport type: 'stdio', 'sse', or 'http'")
    command: str | None = Field(default=None, description="Command to execute to start the MCP server (for stdio type)")
    args: list[str] = Field(default_factory=list, description="Arguments to pass to the command (for stdio type)")
    env: dict[str, str] = Field(default_factory=dict, description="Environment variables for the MCP server")
    url: str | None = Field(default=None, description="URL of the MCP server (for sse or http type)")
    headers: dict[str, str] = Field(default_factory=dict, description="HTTP headers to send (for sse or http type)")
    oauth: McpOAuthConfigResponse | None = Field(default=None, description="OAuth configuration for MCP HTTP/SSE servers")
    description: str = Field(default="", description="Human-readable description of what this MCP server provides")


class McpToolInfo(BaseModel):
    name: str
    full_name: str = ""
    description: str = ""


class McpServerRuntimeStatus(BaseModel):
    """Per-server MCP load/runtime status."""

    load_status: Literal["disabled", "pending", "ready", "error"] = "pending"
    error: str | None = None
    tool_count: int = 0
    tools: list[McpToolInfo] = Field(default_factory=list)


class McpConfigResponse(BaseModel):
    """Response model for MCP configuration."""

    mcp_servers: dict[str, McpServerConfigResponse] = Field(
        default_factory=dict,
        description="Map of MCP server name to configuration",
    )
    tool_counts: dict[str, int] = Field(
        default_factory=dict,
        description="Map of MCP server name to loaded tool count",
    )
    server_status: dict[str, McpServerRuntimeStatus] = Field(
        default_factory=dict,
        description="Per-server runtime load status (green/red indicator)",
    )
    cache_initialized: bool = False
    config_stale: bool = False
    init_error: str | None = None
    total_tools: int = 0


class McpConfigUpdateRequest(BaseModel):
    """Request model for updating MCP configuration."""

    mcp_servers: dict[str, McpServerConfigResponse] = Field(
        ...,
        description="Map of MCP server name to configuration",
    )


class McpMarketServerItem(BaseModel):
    slug: str = ""
    name: str = ""
    title: str = ""
    description: str = ""
    author: str = ""
    url: str = ""
    repository_url: str = ""
    glama_namespace: str = ""
    glama_slug: str = ""
    glama_id: str = ""
    registry_name: str = ""
    source: str = "glama"
    install_cmd: str = ""
    stars: int = 0


class McpMarketSearchResponse(BaseModel):
    servers: list[McpMarketServerItem] = Field(default_factory=list)
    cursor: str | None = None
    has_more: bool = False
    source: str = "glama"
    warning: str | None = None


class McpMarketInstallResponse(BaseModel):
    name: str
    registry_name: str | None = None
    config: McpServerConfigResponse


@router.get(
    "/mcp/config",
    response_model=McpConfigResponse,
    summary="Get MCP Configuration",
    description="Retrieve the current Model Context Protocol (MCP) server configurations.",
)
async def get_mcp_configuration(request: Request) -> McpConfigResponse:
    """Get the current MCP configuration and per-server runtime status."""
    require_org_admin(request)
    from evoflow.config.extensions_config import ExtensionsConfig, reload_extensions_config
    from evoflow.mcp.status import build_mcp_status_snapshot

    try:
        # May import ~/.cursor/mcp.json into SQLite when DB is empty or corrupt
        snap = await asyncio.to_thread(build_mcp_status_snapshot)
    except Exception as exc:
        logger.warning("MCP status snapshot failed; returning degraded response: %s", exc, exc_info=True)
        snap = {
            "servers": [],
            "tool_counts": {},
            "cache_initialized": False,
            "config_stale": False,
            "init_error": f"Failed to build MCP status snapshot: {exc}",
            "total_tools": 0,
        }

    try:
        config = reload_extensions_config()
    except Exception as exc:
        logger.warning("MCP extensions reload failed; returning empty servers: %s", exc, exc_info=True)
        config = ExtensionsConfig()

    server_status = {
        s["name"]: McpServerRuntimeStatus(
            load_status=s["load_status"],
            error=s.get("error"),
            tool_count=int(s.get("tool_count") or 0),
            tools=[
                McpToolInfo(
                    name=str(t.get("name") or ""),
                    full_name=str(t.get("full_name") or ""),
                    description=str(t.get("description") or ""),
                )
                for t in (s.get("tools") or [])
            ],
        )
        for s in snap.get("servers") or []
    }

    return McpConfigResponse(
        mcp_servers={name: McpServerConfigResponse(**server.model_dump()) for name, server in config.mcp_servers.items()},
        tool_counts=snap.get("tool_counts") or {},
        server_status=server_status,
        cache_initialized=bool(snap.get("cache_initialized")),
        config_stale=bool(snap.get("config_stale")),
        init_error=snap.get("init_error"),
        total_tools=int(snap.get("total_tools") or 0),
    )


@router.put(
    "/mcp/config",
    response_model=McpConfigResponse,
    summary="Update MCP Configuration",
    description="Update Model Context Protocol (MCP) server configurations and save to file.",
)
async def update_mcp_configuration(
    http_request: Request, request: McpConfigUpdateRequest
) -> McpConfigResponse:
    """Update the MCP configuration.

    This will:
    1. Save the new configuration to the mcp_config.json file
    2. Reload the configuration cache
    3. Reset MCP tools cache to trigger reinitialization

    Args:
        request: The new MCP configuration to save.

    Returns:
        The updated MCP configuration.

    Raises:
        HTTPException: 500 if the configuration file cannot be written.

    Example Request:
        ```json
        {
            "mcp_servers": {
                "github": {
                    "enabled": true,
                    "command": "npx",
                    "args": ["-y", "@modelcontextprotocol/server-github"],
                    "env": {"GITHUB_TOKEN": "$GITHUB_TOKEN"},
                    "description": "GitHub MCP server for repository operations"
                }
            }
        }
        ```
    """
    require_org_admin(http_request)
    try:
        from evoflow.mcp.cache import reset_mcp_tools_cache
        from evoflow.mcp.config_io import unwrap_mcp_servers_dict
        from evoflow.persistence import config_repositories as cfg_repo

        raw = {name: server.model_dump() for name, server in request.mcp_servers.items()}
        # UI may paste full IDE mcp.json: {"mcpServers": {...}}
        unwrapped = unwrap_mcp_servers_dict(raw)
        if not unwrapped and raw:
            unwrapped = raw

        cfg_repo.replace_mcp_servers(unwrapped)
        logger.info("MCP configuration updated in SQLite (%d servers)", len(unwrapped))
        reset_mcp_tools_cache()
        reload_extensions_config()
        return await get_mcp_configuration(http_request)

    except Exception as e:
        logger.error(f"Failed to update MCP configuration: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to update MCP configuration: {str(e)}")


@router.get(
    "/mcp/market/search",
    response_model=McpMarketSearchResponse,
    summary="Search MCP marketplace (Glama + curated)",
    description="Search the public Glama MCP directory. Empty query returns curated hot servers plus Glama recommendations.",
)
async def search_mcp_marketplace(
    query: str = "",
    cursor: str | None = None,
    limit: int = 20,
) -> McpMarketSearchResponse:
    from evoflow.mcp.market import search_mcp_market

    try:
        data = await search_mcp_market(query=query, cursor=cursor, limit=max(1, min(limit, 50)))
        return McpMarketSearchResponse(**data)
    except Exception as e:
        logger.error("MCP market search failed: %s", e, exc_info=True)
        raise HTTPException(status_code=502, detail=f"MCP market search failed: {e}") from e


@router.get(
    "/mcp/market/install",
    response_model=McpMarketInstallResponse,
    summary="Resolve MCP install config from Registry",
    description="Resolve one-click MCP configuration from official Registry (via registry_name or Glama metadata).",
)
async def resolve_mcp_market_install(
    registry_name: str | None = None,
    glama_namespace: str | None = None,
    glama_slug: str | None = None,
    slug: str | None = None,
    repository_url: str | None = None,
) -> McpMarketInstallResponse:
    from evoflow.mcp.market import resolve_mcp_install_config

    try:
        data = await resolve_mcp_install_config(
            registry_name=registry_name,
            glama_namespace=glama_namespace,
            glama_slug=glama_slug,
            slug=slug,
            repository_url=repository_url,
        )
        return McpMarketInstallResponse(
            name=data["name"],
            registry_name=data.get("registry_name"),
            config=McpServerConfigResponse(**data["config"]),
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except Exception as e:
        logger.error("MCP market install resolve failed: %s", e, exc_info=True)
        detail = str(e).strip() or repr(e)
        raise HTTPException(status_code=502, detail=f"Failed to resolve MCP install config: {detail}") from e
