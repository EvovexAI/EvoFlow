"""Lead-agent graph boot warm-up — 消灭「每次应用启动后首轮语音 10-20s 装配」。

实测（2026-11-04 生产日志）：LangGraph sidecar 冷启动后，第一轮对话的
「run 受理 → LLM 首 token」要 12-21s，其中大头是图工厂首次执行（挂载 80 个
MCP 工具 + 插件扫描 + 提示词装配）。用户开口前的这段延迟，本可以在启动时
后台预热掉。

预热只触发图工厂（不调模型 API，零 token 成本）；若预热用的 cache key 与
首个真实 run 的 key 不完全一致（如语音轮强制关思考），MCP/imports 等进程级
缓存仍然已热，真实首轮的重建会显著加快（见 agent.py「Rebuild when MCP cache
warms」注释）。
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any

logger = logging.getLogger("evoflow.lead_agent.warm")



def warm_lead_agent_graph(source: str = "boot") -> dict[str, Any]:
    """同步执行一次图工厂（make_lead_agent），触发装配 + MCP 挂载。可重入。"""
    t0 = time.perf_counter()
    try:
        # Split LangGraph: MCP cache lives in this process. Warm tools first so
        # make_lead_agent does not compile a 0-mcp graph (Issue #106).
        try:
            from evoflow.mcp.cache import get_cached_mcp_tools, mcp_cache_initialized

            if not mcp_cache_initialized():
                tools = get_cached_mcp_tools()
                logger.info(
                    "lead_agent warm MCP ready source=%s tools=%d",
                    source,
                    len(tools or []),
                )
        except Exception:
            logger.debug("lead_agent warm MCP preload skipped", exc_info=True)

        from evoflow.agents.lead_agent.agent import make_lead_agent

        graph = make_lead_agent({"configurable": {}})
        ms = (time.perf_counter() - t0) * 1000.0
        logger.info("lead_agent warm OK source=%s build_ms=%.0f", source, ms)
        return {"ok": True, "build_ms": round(ms), "graph_type": type(graph).__name__}
    except Exception as e:  # noqa: BLE001 — 预热绝不影响启动
        logger.warning("lead_agent warm failed source=%s: %s", source, e)
        return {"ok": False, "error": str(e), "build_ms": round((time.perf_counter() - t0) * 1000.0)}


def warm_lead_agent_graph_once(source: str = "boot", *, delay_s: float = 0.0) -> threading.Thread:
    """后台线程预热（delay_s 用于等 sidecar 的 pool/store 就绪）。重复调用幂等：
    图工厂本身带缓存 + MCP/imports 进程级只热一次。"""

    def _run() -> None:
        if delay_s > 0:
            time.sleep(delay_s)
        warm_lead_agent_graph(source)

    t = threading.Thread(target=_run, name="lead-agent-warm", daemon=True)
    # Once 语义在函数内部由调用方保证（这里简单用 daemon thread + 幂等的工厂缓存）
    t.start()
    return t


def warm_when_port_ready(port: int, *, timeout_s: float = 90.0, source: str = "sidecar") -> threading.Thread:
    """sidecar 模式：等自身 HTTP /ok 就绪后再预热（pool/store 先于图装配就绪）。"""
    import urllib.request

    def _run() -> None:
        url = f"http://127.0.0.1:{port}/ok"
        deadline = time.monotonic() + timeout_s
        ready = False
        while time.monotonic() < deadline:
            try:
                with urllib.request.urlopen(url, timeout=2.0) as resp:
                    if resp.status == 200:
                        ready = True
                        break
            except Exception:
                time.sleep(1.0)
        if not ready:
            logger.warning("lead_agent warm skipped: server /ok not ready in %.0fs", timeout_s)
            return
        warm_lead_agent_graph(source)

    t = threading.Thread(target=_run, name="lead-agent-warm-sidecar", daemon=True)
    t.start()
    return t
