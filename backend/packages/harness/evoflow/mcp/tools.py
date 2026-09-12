"""Load MCP tools using langchain-mcp-adapters."""

import asyncio
import atexit
import concurrent.futures
import hashlib
import json
import logging
import os
from collections.abc import Callable
from pathlib import Path
from typing import Any

from langchain_core.tools import BaseTool

from evoflow.config.data_paths import resolve_data_base_dir

logger = logging.getLogger(__name__)

# MCP 配置文件路径（用户数据目录下的 mcp.json，和数据库等文件同级）
# 默认 ~/.evoflow/mcp.json，可通过 EVOFLOW_HOME 环境变量覆盖
def _get_mcp_config_path() -> Path:
    from evoflow.mcp.config_io import resolve_mcp_json_paths

    for path in resolve_mcp_json_paths():
        if path.is_file():
            return path
    return resolve_data_base_dir() / "mcp.json"


def load_mcp_config() -> dict[str, Any]:
    """Load MCP servers: SQLite (UI edits), with Cursor ``mcp.json`` import fallback."""
    from evoflow.mcp.config_io import (
        is_bogus_mcp_server_map,
        load_mcp_json_from_files,
        sync_mcp_servers_to_sqlite,
        unwrap_mcp_servers_dict,
    )

    sqlite_servers: dict[str, Any] = {}
    try:
        from evoflow.persistence import config_repositories as cfg_repo

        sqlite_servers = unwrap_mcp_servers_dict(cfg_repo.list_mcp_servers())
        if sqlite_servers:
            logger.info("Loaded %d MCP server(s) from SQLite", len(sqlite_servers))
    except Exception as e:
        logger.warning("Failed to load MCP config from SQLite: %s", e)

    if sqlite_servers and not is_bogus_mcp_server_map(sqlite_servers):
        return sqlite_servers

    if is_bogus_mcp_server_map(sqlite_servers):
        logger.warning(
            "SQLite MCP config looks like a raw mcp.json wrapper (key 'mcpServers'); "
            "re-importing from mcp.json files"
        )

    file_servers, file_path = load_mcp_json_from_files()
    if file_servers:
        try:
            sync_mcp_servers_to_sqlite(file_servers)
            logger.info("Synced MCP config from %s into SQLite", file_path)
        except Exception as e:
            logger.warning("Could not sync MCP file into SQLite: %s", e)
        return file_servers

    return sqlite_servers


def mcp_config_fingerprint() -> str:
    """Stable hash of current MCP server config."""
    servers = load_mcp_config()
    payload = json.dumps(servers, sort_keys=True, default=str)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _normalize_mcp_server_config(server_name: str, config: dict[str, Any]) -> dict[str, Any] | None:
    """将 mcp.json 中的服务器配置转换为 langchain-mcp-adapters 所需的格式。

    支持的配置格式：
    - stdio: {"command": "...", "args": [...], "env": {...}, "cwd": "..."}
    - sse/http: {"url": "...", "headers": {...}}

    Returns ``None`` for disabled servers or invalid stdio configs (missing command).
    """
    if config.get("enabled") is False:
        return None

    # Resolve $VAR / ${VAR} in env / headers / args before connecting.
    try:
        from evoflow.config.extensions_config import ExtensionsConfig

        config = ExtensionsConfig.resolve_env_variables(dict(config))
    except Exception:
        config = dict(config)

    normalized: dict[str, Any] = {}

    explicit_type = str(config.get("type") or config.get("transport") or "").strip().lower()
    url = str(config.get("url") or "").strip()

    if url or explicit_type in {"sse", "http", "streamable_http", "streamable-http"}:
        # SSE/HTTP 传输模式
        if explicit_type in {"http", "streamable_http", "streamable-http"}:
            transport = "http"
        elif explicit_type == "sse":
            transport = "sse"
        else:
            transport = "sse" if url.rstrip("/").endswith("/sse") else "http"
        if not url:
            logger.warning("MCP server %r (%s) missing url — skipped", server_name, transport)
            return None
        normalized["transport"] = transport
        normalized["url"] = url
        if config.get("headers"):
            normalized["headers"] = config["headers"]
        # timeout is meaningful for HTTP/SSE transports
        if config.get("timeout") is not None:
            normalized["timeout"] = config["timeout"]
    else:
        # stdio 传输模式
        command = str(config.get("command") or "").strip()
        if not command:
            logger.warning("MCP server %r (stdio) missing command — skipped", server_name)
            return None
        normalized["transport"] = "stdio"
        normalized["command"] = command
        normalized["args"] = config.get("args", [])
        if config.get("env"):
            normalized["env"] = config["env"]
        if config.get("cwd"):
            normalized["cwd"] = config["cwd"]
        # langchain-mcp-adapters stdio session does not accept ``timeout`` on all versions
        # (passing it causes: _create_stdio_session() got an unexpected keyword argument 'timeout')

    return normalized

# Global thread pool for sync tool invocation in async environments
_SYNC_TOOL_EXECUTOR = concurrent.futures.ThreadPoolExecutor(max_workers=10, thread_name_prefix="mcp-sync-tool")

# Register shutdown hook for the global executor
atexit.register(lambda: _SYNC_TOOL_EXECUTOR.shutdown(wait=False))


def _make_sync_tool_wrapper(coro: Callable[..., Any], tool_name: str) -> Callable[..., Any]:
    """Build a synchronous wrapper for an asynchronous tool coroutine.

    Args:
        coro: The tool's asynchronous coroutine.
        tool_name: Name of the tool (for logging).

    Returns:
        A synchronous function that correctly handles nested event loops.
    """

    def _run_coro_on_fresh_loop(awaitable: Any) -> Any:
        """Never call ``asyncio.run`` on the LangGraph loop — use an isolated loop per invoke."""
        loop = asyncio.new_event_loop()
        try:
            return loop.run_until_complete(awaitable)
        finally:
            try:
                loop.run_until_complete(loop.shutdown_asyncgens())
            except Exception:
                pass
            loop.close()

    def sync_wrapper(*args: Any, **kwargs: Any) -> Any:
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None

        try:
            if loop is not None and loop.is_running():
                future = _SYNC_TOOL_EXECUTOR.submit(
                    _run_coro_on_fresh_loop,
                    coro(*args, **kwargs),
                )
                return future.result()
            return _run_coro_on_fresh_loop(coro(*args, **kwargs))
        except Exception as e:
            logger.error(f"Error invoking MCP tool '{tool_name}' via sync wrapper: {e}", exc_info=True)
            raise

    return sync_wrapper


def _per_server_timeout_sec(raw_cfg: dict[str, Any] | None = None) -> float:
    default = 45.0
    raw = os.environ.get("EVOFLOW_MCP_SERVER_TIMEOUT_SEC", "").strip()
    if raw:
        try:
            default = max(5.0, float(raw))
        except ValueError:
            pass
    if raw_cfg:
        t = raw_cfg.get("timeout")
        if t is not None:
            try:
                return max(default, float(t))
            except (TypeError, ValueError):
                pass
    return default


def _format_mcp_error(exc: BaseException) -> str:
    """Flatten TaskGroup / ExceptionGroup into a readable message."""
    parts: list[str] = []

    def walk(err: BaseException) -> None:
        subgroups = getattr(err, "exceptions", None)
        if subgroups:
            for sub in subgroups:
                if isinstance(sub, BaseException):
                    walk(sub)
            return
        msg = str(err).strip()
        if msg and msg not in parts:
            parts.append(msg)
        elif not msg and type(err).__name__ not in parts:
            parts.append(type(err).__name__)

    walk(exc)
    if not parts:
        return type(exc).__name__
    text = "; ".join(parts)
    return text[:500]


def _mcp_error_hint(server_name: str, cfg: dict[str, Any], err_text: str) -> str:
    """Append actionable hint for common MCP load failures."""
    hints: list[str] = []
    lower = err_text.lower()
    transport = cfg.get("transport", "stdio")

    if "timed out" in lower:
        hints.append("启动超时：可增大环境变量 EVOFLOW_MCP_SERVER_TIMEOUT_SEC 或配置里的 timeout（秒）")
    if transport == "stdio":
        if "not found" in lower or "winerror 2" in lower or "no such file" in lower:
            hints.append("找不到可执行文件：检查 command 是否在 PATH 中，Windows 上 npx/python 建议写全路径")
        if cfg.get("command") in ("python", "uvx", "npx"):
            hints.append(f"确认已安装 {cfg.get('command')} 且子进程能正常启动")
    if transport in ("http", "sse", "streamable_http", "streamable-http"):
        if "401" in lower or "403" in lower or "unauthorized" in lower:
            hints.append("远程 MCP 需要 OAuth/Token：在 headers 或 env 中配置认证信息")
        if "notion" in server_name.lower() or "notion" in (cfg.get("url") or "").lower():
            hints.append("Notion 官方 MCP 需在外部 Agent/浏览器完成 OAuth，裸 URL 通常无法直连")
    if "taskgroup" in lower and len(err_text) < 80:
        hints.append("详见展开后的子错误（多为进程启动失败或网络认证失败）")
    if "browser-tools" in server_name.lower() or "browser-tools" in " ".join(str(a) for a in (cfg.get("args") or [])):
        hints.append(
            "browser-tools 启动时会向 stdout 打印 Checking localhost:302x（污染 JSON-RPC，日志里会有 parse 报错但通常仍能加载）；"
            "实际使用需另开 terminal 运行 npx @agentdeskai/browser-tools-server@1.2.0 + 安装 Chrome 扩展"
        )

    if not hints:
        return err_text
    return f"{err_text} — {'; '.join(hints)}"


def _normalize_mcp_tool_names(tools: list[BaseTool], servers_config: dict[str, Any]) -> None:
    from evoflow.mcp.binding import qualified_mcp_tool_name

    for tool in tools:
        original_name = tool.name
        for server_name in servers_config.keys():
            prefix_us = f"{server_name}_"
            prefix_ds = f"{server_name}__"
            mcp_prefix = f"mcp__{server_name}__"
            if original_name.startswith(mcp_prefix):
                break
            if original_name.startswith(prefix_ds):
                tool.name = qualified_mcp_tool_name(server_name, original_name[len(prefix_ds) :])
                logger.debug("Normalized MCP tool name: %s -> %s", original_name, tool.name)
                break
            if original_name.startswith(prefix_us):
                tool.name = qualified_mcp_tool_name(server_name, original_name[len(prefix_us) :])
                logger.debug("Normalized MCP tool name: %s -> %s", original_name, tool.name)
                break
        else:
            if len(servers_config) == 1 and original_name and not str(original_name).startswith("mcp__"):
                server_name = next(iter(servers_config))
                tool.name = qualified_mcp_tool_name(server_name, original_name)
                logger.debug("Normalized MCP tool name: %s -> %s", original_name, tool.name)


async def _load_tools_from_server(
    name: str,
    cfg: dict[str, Any],
    *,
    raw_cfg: dict[str, Any] | None = None,
) -> tuple[list[BaseTool], str | None]:
    """Load tools from a single MCP server. Returns ``(tools, error_message)``."""
    from langchain_mcp_adapters.client import MultiServerMCPClient

    timeout_sec = _per_server_timeout_sec(raw_cfg)
    try:
        client = MultiServerMCPClient({name: cfg}, tool_name_prefix=True)
        tools = await asyncio.wait_for(client.get_tools(), timeout=timeout_sec)
        _normalize_mcp_tool_names(tools, {name: cfg})
        for tool in tools:
            if getattr(tool, "func", None) is None and getattr(tool, "coroutine", None) is not None:
                tool.func = _make_sync_tool_wrapper(tool.coroutine, tool.name)
        return tools, None
    except TimeoutError:
        err = f"Timed out after {timeout_sec:.0f}s connecting to MCP server"
        return [], _mcp_error_hint(name, cfg, err)
    except Exception as exc:
        err = _format_mcp_error(exc)
        return [], _mcp_error_hint(name, cfg, err)


async def get_mcp_tools() -> list[BaseTool]:
    """Get all tools from enabled MCP servers.

    Returns:
        List of LangChain tools from all enabled MCP servers.
    """
    try:
        from langchain_mcp_adapters.client import MultiServerMCPClient  # noqa: F401
    except ImportError:
        logger.warning("langchain-mcp-adapters not installed. Install it to enable MCP tools: pip install langchain-mcp-adapters")
        return []

    # Load MCP config from mcp.json file (no database)
    raw_servers = load_mcp_config()
    if not raw_servers:
        logger.info("No enabled MCP servers configured in mcp.json")
        return []

    # Normalize config for langchain-mcp-adapters
    servers_config = {}
    for name, cfg in raw_servers.items():
        normalized = _normalize_mcp_server_config(name, cfg)
        if normalized is not None:
            servers_config[name] = normalized

    if not servers_config:
        logger.info("No valid MCP servers after normalization")
        return []

    from evoflow.mcp.cache import set_mcp_server_load_status

    all_tools: list[BaseTool] = []
    status_map: dict[str, dict[str, Any]] = {}

    for name, cfg in servers_config.items():
        logger.info("Loading MCP server %r (%s)", name, cfg.get("transport", "stdio"))
        raw_cfg = raw_servers.get(name) if isinstance(raw_servers.get(name), dict) else None
        tools, err = await _load_tools_from_server(name, cfg, raw_cfg=raw_cfg)
        all_tools.extend(tools)
        if err:
            logger.error("MCP server %r failed: %s", name, err)
            if cfg.get("transport") == "stdio":
                logger.error(
                    "MCP stdio server %r: command=%r args=%r — missing executable / not on PATH?",
                    name,
                    cfg.get("command"),
                    cfg.get("args"),
                )
            status_map[name] = {"load_status": "error", "tool_count": 0, "error": err}
        else:
            logger.info("MCP server %r loaded %d tool(s)", name, len(tools))
            status_map[name] = {"load_status": "ready", "tool_count": len(tools), "error": None}

    set_mcp_server_load_status(status_map)
    logger.info("Loaded %d total MCP tool(s) from %d server(s)", len(all_tools), len(servers_config))
    return all_tools
