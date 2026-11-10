"""MCP runtime status snapshot for Gateway APIs (read-only, never triggers init)."""

from __future__ import annotations

from typing import Any

from evoflow.mcp.cache import (
    get_mcp_server_load_status,
    mcp_cache_config_mtime,
    mcp_cache_initialized,
    mcp_init_error,
    mcp_unavailable_reason,
    peek_cached_mcp_tools,
)
from evoflow.mcp.tools import load_mcp_config, mcp_config_fingerprint


def _infer_mcp_transport(cfg: dict[str, Any]) -> str:
    """Resolve display transport: prefer explicit type, then URL heuristics, else stdio."""
    explicit = str(cfg.get("type") or cfg.get("transport") or "").strip().lower()
    if explicit in {"stdio", "sse", "http", "streamable_http", "streamable-http"}:
        if explicit in {"streamable_http", "streamable-http"}:
            return "http"
        return explicit
    url = str(cfg.get("url") or "").strip()
    if url:
        return "sse" if url.rstrip("/").endswith("/sse") else "http"
    return "stdio"


def mcp_config_stale() -> bool:
    """True when MCP config changed since last cache build."""
    if not mcp_cache_initialized():
        return False
    cached = mcp_cache_config_mtime()
    if not cached:
        return False
    return mcp_config_fingerprint() != cached


def build_mcp_status_snapshot(
    *,
    raw_servers: dict[str, Any] | None = None,
    server_names: list[str] | None = None,
) -> dict[str, Any]:
    """Runtime MCP status for main client + observability.

    三层数据源（2026-11-07 假阴性修复）：

    1. ``memory``      —— 本进程缓存已热：最快最准（网关主进程常态）。
    2. ``persisted``   —— 本进程未初始化但 mcp.json 同目录有存活 writer 落的
       快照（platform 工具 / CLI / LangGraph 进程常态）。
    3. ``none``        —— 都没有：enabled server 报 ``unknown``（不是 pending——
       pending 意味着「正在加载」，本进程根本无从得知；也绝不报 0 工具冒充
       「已配置但没加载」）。

    ``peek`` 语义不变：绝不触发初始化（HTTP handler 里会卡事件循环，历史 hang）。
    """
    import os as _os
    from evoflow.timeutil import utc_now_iso_z

    from evoflow.mcp.tools import _get_mcp_config_path

    config_path = _get_mcp_config_path()
    if raw_servers is None:
        raw_servers = load_mcp_config()
    if server_names is not None:
        allowed = {str(n).strip() for n in server_names if str(n).strip()}
        raw_servers = {k: v for k, v in raw_servers.items() if k in allowed}

    cache_initialized = mcp_cache_initialized()
    tools = peek_cached_mcp_tools()
    server_load_status = get_mcp_server_load_status()
    config_stale = mcp_config_stale()

    # ── 选数据源 ──
    persisted: dict[str, Any] | None = None
    snapshot_source = "memory"
    if not cache_initialized:
        from evoflow.mcp.cache import load_persisted_mcp_status_snapshot

        persisted = load_persisted_mcp_status_snapshot()
        snapshot_source = "persisted" if persisted else "none"

    if cache_initialized:
        effective_status = server_load_status
        total_tools = len(tools)
        snapshot_pid = _os.getpid()
        snapshot_at = utc_now_iso_z()
        writer_alive = True
    elif persisted:
        effective_status = {
            str(k): v for k, v in (persisted.get("server_status") or {}).items() if isinstance(v, dict)
        }
        total_tools = int(persisted.get("total_tools") or 0)
        snapshot_pid = int(persisted.get("writer_pid") or 0)
        snapshot_at = str(persisted.get("generated_at") or "")
        writer_alive = True  # load 时已做过存活过滤
    else:
        effective_status = {}
        total_tools = 0
        snapshot_pid = None
        snapshot_at = None
        writer_alive = None

    from evoflow.mcp.binding import mcp_server_from_tool_name, mcp_server_tool_id

    tools_by_server: dict[str, list[dict[str, str]]] = {}
    if cache_initialized:
        # Map tool-id (ASCII slug) → display name so UI still keys by mcp.json names.
        id_to_display = {mcp_server_tool_id(n): n for n in raw_servers.keys()}
        for tool in tools:
            full_name = str(getattr(tool, "name", "") or "").strip()
            server_id = mcp_server_from_tool_name(full_name) or "unknown"
            server_name = id_to_display.get(server_id, server_id)
            tool_name = full_name
            mcp_prefix = f"mcp__{server_id}__"
            legacy_prefix = f"{server_id}__"
            display_legacy = f"{server_name}__"
            if full_name.startswith(mcp_prefix):
                tool_name = full_name[len(mcp_prefix) :]
            elif full_name.startswith(legacy_prefix):
                tool_name = full_name[len(legacy_prefix) :]
            elif full_name.startswith(display_legacy):
                tool_name = full_name[len(display_legacy) :]

            tools_by_server.setdefault(server_name, [])
            description = ""
            if hasattr(tool, "description") and tool.description:
                description = tool.description[:200]

            tools_by_server[server_name].append(
                {
                    "name": tool_name,
                    "full_name": full_name,
                    "description": description,
                }
            )
    elif persisted:
        # 跨进程读：快照只持久化了工具名（描述不入盘），detail 相应降级。
        # Snapshot keys may be ASCII tool-ids; remap to mcp.json display names.
        id_to_display = {mcp_server_tool_id(n): n for n in raw_servers.keys()}
        for srv_name, names in (persisted.get("tools_by_server") or {}).items():
            if not isinstance(names, list):
                continue
            display = id_to_display.get(str(srv_name), str(srv_name))
            tools_by_server[display] = [
                {"name": str(n).split("__")[-1], "full_name": str(n), "description": ""}
                for n in names
                if str(n or "").strip()
            ]

    tool_counts: dict[str, int] = {name: len(items) for name, items in tools_by_server.items()}

    servers: list[dict[str, Any]] = []
    for name, cfg in raw_servers.items():
        enabled = cfg.get("enabled", True) is not False
        transport = _infer_mcp_transport(cfg)
        error: str | None = None
        unknown_reason: str | None = None
        if not enabled:
            load_status = "disabled"
        elif name in effective_status:
            st = effective_status[name]
            load_status = str(st.get("load_status") or "unknown")
            error = st.get("error")
            if load_status == "error" and not error:
                error = "Failed to connect or load tools"
        else:
            # 配置里有、但数据源里没有：memory 冷（未初始化）或快照落后于配置变更
            load_status = "unknown"
            if snapshot_source == "persisted":
                unknown_reason = "not in persisted snapshot (config changed after last gateway warmup?)"
            else:
                unknown_reason = "cache not initialized in this process and no persisted snapshot"

        server_tools = tools_by_server.get(name) or tools_by_server.get(mcp_server_tool_id(name), [])
        server_info: dict[str, Any] = {
            "name": name,
            "enabled": enabled,
            "transport": transport,
            "load_status": load_status,
            "error": error,
            "tool_count": len(server_tools) if server_tools else tool_counts.get(name, 0),
            "tools": server_tools,
        }
        if unknown_reason:
            server_info["unknown_reason"] = unknown_reason
        if transport == "stdio":
            server_info["command"] = cfg.get("command", "")
            server_info["args"] = cfg.get("args", [])
        else:
            server_info["url"] = cfg.get("url", "")
        servers.append(server_info)

    return {
        "config_path": str(config_path),
        "config_exists": bool(raw_servers) or config_path.exists(),
        "config_stale": config_stale,
        # 系统级真值：memory（本进程已初始化）或 persisted（存活 writer 落的快照）
        "cache_initialized": cache_initialized or bool(persisted),
        # 本进程视角：platform 工具 / CLI 进程恒为 False，别把它误读成「MCP 挂了」
        "initialized_in_this_process": cache_initialized,
        "snapshot_source": snapshot_source,
        "snapshot_pid": snapshot_pid,
        "snapshot_at": snapshot_at,
        "snapshot_writer_alive": writer_alive,
        "unavailable_reason": mcp_unavailable_reason(),
        "init_error": mcp_init_error(),
        "total_tools": total_tools,
        "tool_counts": tool_counts,
        "servers": servers,
    }
