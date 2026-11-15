"""V4 投影终态收口调度器 — 周期把「run 已终态、投影还 running」的会话 settle 掉。

员工/后台 run 无 mirror 喂流（engine ``runs.wait`` 起跑，attach 流只在有人盯时
存在且切走即断），run 终态后没有任何组件写 hub 的 control/phase，投影永远停
在「进行中」——前端所有补拉轮询又恰好在 run 终态那一刻全部退出（observer
history-watch 见 idle 即停、员工过程 pane 见完成即停），自愈闭环不可能由前端
闭合。这里从服务端周期收口（默认 10s 一拍）：

- 候选：hub 内 phase/control 处于 running、有投影行、无活写手的会话；
- 证据：DB ``run_status`` 已终态（catchup 内部判定并 settle）；
- 动作：settle control（canStop=false、sessionEnded）+ 终态行 rehydrate +
  recovery snapshot 广播给在线订阅者。

禁用：``EVOFLOW_V4_RUN_SETTLE=0``。间隔：``EVOFLOW_V4_RUN_SETTLE_INTERVAL_S``。
"""

from __future__ import annotations

import asyncio
import logging
import os

logger = logging.getLogger(__name__)

_DEFAULT_INTERVAL_S = int(os.getenv("EVOFLOW_V4_RUN_SETTLE_INTERVAL_S", "10") or "10")


def run_settle_reconciler_enabled() -> bool:
    raw = (os.getenv("EVOFLOW_V4_RUN_SETTLE") or "").strip().lower()
    return raw not in ("0", "false", "no", "off", "disabled")


async def run_v4_run_settle_scheduler(stop: asyncio.Event) -> None:
    """Periodically settle stale running projections (runs in to_thread per pass)."""
    from app.gateway.v4.conversation import V4_CONVERSATION_HUB

    interval = max(5, _DEFAULT_INTERVAL_S)
    logger.info(
        "V4 run-settle reconciler started (interval=%ss; disable with EVOFLOW_V4_RUN_SETTLE=0)",
        interval,
    )
    while not stop.is_set():
        try:
            stats = await asyncio.to_thread(V4_CONVERSATION_HUB.reconcile_stale_running)
            if stats.get("settled"):
                logger.info("v4 run-settle pass: %s", stats)
        except Exception:
            logger.exception("v4 run-settle pass failed")
        try:
            await asyncio.wait_for(stop.wait(), timeout=interval)
        except asyncio.TimeoutError:
            continue
        except Exception:
            logger.exception("v4 run-settle wait failed; backing off")
            await asyncio.sleep(interval)


__all__ = ["run_settle_reconciler_enabled", "run_v4_run_settle_scheduler"]
