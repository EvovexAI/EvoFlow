"""MCP 配置接口 500：响应模型的取值域比生产侧窄。

【self-evolution-bot · 2026-11-19 · 第69轮 · 模型:deepseek-v4.1-flash-1017】

现网实证：2026-11-19 19:56:52 与 20:22:08，`GET /api/mcp/config` 各返回一次 500，
`error_type=ValidationError`。两次都紧跟在 19:36 重启之后的**内存预热窗口**内。

根因：`evoflow.mcp.status.build_mcp_status_snapshot` 在
「配置里有这个 server、但数据源里没有」时（memory 冷 / 快照落后于配置变更）
会产出 `load_status="unknown"`（status.py:171，且 docstring 第 53-55 行明确
规定要用 unknown 而不是 pending —— pending 意味着「正在加载」，这里本进程
根本无从得知），而响应模型 `McpServerRuntimeStatus.load_status` 的 Literal
只允许 disabled/pending/ready/error —— 对不上就抛 ValidationError。

要紧的是这个缺陷**只在冷启动窗口出现**：预热完成后 9 台都是 ready，
接口一路 200，所以靠「现在 curl 一下没问题」永远证明不了它修好了。
判据必须是「模型能接受生产侧所有可能取值」。
"""

from __future__ import annotations

import pytest


def test_model_accepts_unknown_load_status() -> None:
    """`unknown` 是生产侧真实会产出的值，模型必须吃下，否则接口 500。"""
    from app.gateway.routers.mcp import McpServerRuntimeStatus

    st = McpServerRuntimeStatus(load_status="unknown", error=None, tool_count=0, tools=[])
    assert st.load_status == "unknown"


@pytest.mark.parametrize("value", ["disabled", "pending", "ready", "error", "unknown"])
def test_all_producible_statuses_accepted(value: str) -> None:
    """status.py 会产出的每个取值都必须被响应模型接受。

    少 `unknown` 这一条就是现网那个 500。
    """
    from app.gateway.routers.mcp import McpServerRuntimeStatus

    assert McpServerRuntimeStatus(load_status=value, tool_count=0, tools=[]).load_status == value


def test_snapshot_cold_start_emits_unknown_and_model_accepts(monkeypatch: pytest.MonkeyPatch) -> None:
    """跑真实快照构造函数，制造「冷启动且无持久化快照」场景。

    这是唯一会在生产上产出 unknown 的路径，也是那两次 500 的现场。
    必须端到端走一遍：快照产出 unknown → 响应模型构造成功。
    """
    from evoflow.mcp import status as st_mod

    # 内存未热 + 无持久化快照 → snapshot_source == "none" → 每个 enabled server 报 unknown
    monkeypatch.setattr(st_mod, "mcp_cache_initialized", lambda: False, raising=False)
    monkeypatch.setattr(
        st_mod, "peek_cached_mcp_tools", lambda: [], raising=False
    )
    monkeypatch.setattr(st_mod, "get_mcp_server_load_status", lambda: {}, raising=False)
    monkeypatch.setattr(st_mod, "mcp_config_stale", lambda: False, raising=False)
    monkeypatch.setattr(
        st_mod, "load_mcp_config", lambda: {}, raising=False
    )

    import evoflow.mcp.cache as cache_mod

    monkeypatch.setattr(
        cache_mod, "load_persisted_mcp_status_snapshot", lambda: None, raising=False
    )

    snap = st_mod.build_mcp_status_snapshot(
        raw_servers={"__probe_unknown__": {"enabled": True, "type": "stdio", "command": "x"}}
    )
    statuses = {str(s.get("load_status")) for s in snap.get("servers") or []}
    assert statuses == {"unknown"}, f"冷启动没产出 unknown，测试前提失效: {statuses}"

    from app.gateway.routers.mcp import McpServerRuntimeStatus

    for s in snap.get("servers") or []:
        # 修之前这里抛 ValidationError，就是现网那个 500
        McpServerRuntimeStatus(
            load_status=s["load_status"],
            error=s.get("error"),
            tool_count=int(s.get("tool_count") or 0),
            tools=[],
        )
