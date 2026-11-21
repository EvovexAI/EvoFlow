"""Background zombie-run sweeper — periodically cancels stale active runs.

Similar to Apache Airflow's ``find_and_kill_zombies``: scans sessions marked
running/pending in SQLite, and if the run has been active longer than the
staleness threshold (``EVOFLOW_STARTUP_STALE_RUN_MAX_AGE_S``, default 180s),
cancels the underlying LangGraph run and marks the session idle.

Disable with ``EVOFLOW_ZOMBIE_SWEEPER=0``.
"""

from __future__ import annotations

import asyncio
import logging
import os

logger = logging.getLogger(__name__)

_DEFAULT_INTERVAL_S = int(os.getenv("EVOFLOW_ZOMBIE_SWEEP_INTERVAL_S", "120") or "120")
_ZOMBIE_SWEEP_BATCH_SIZE = int(os.getenv("EVOFLOW_ZOMBIE_SWEEP_BATCH", "100") or "100")

# 【self-evolution-bot · 2026-11-20 · 第99轮 · 模型:deepseek-v4.1-flash-1017】
# 改了什么：周期 sweep live 快照用的心跳过期阈值，单独一个环境变量，
# 默认沿用启动侧同一个 180s（EVOFLOW_STARTUP_STALE_RUN_MAX_AGE_S）。
# 为什么：周期任务与启动任务共用阈值会让「调启动档」误伤周期档；显式声明后
# 两处行为一致且可分别覆盖。<=0 关闭（sweep 函数自身已按此语义实现）。
_ZOMBIE_LIVE_SNAPSHOT_MAX_AGE_S = float(
    os.getenv(
        "EVOFLOW_ZOMBIE_LIVE_SNAPSHOT_MAX_AGE_S",
        os.getenv("EVOFLOW_STARTUP_STALE_RUN_MAX_AGE_S", "180"),
    )
    or "180"
)

# 【self-evolution-bot · 2026-11-21 · 第103轮 · 模型:deepseek-v4.1-flash-1017】
# 改了什么：新增低频心跳（首轮必打，之后每 N 轮一条 INFO），带 passes/scanned/swept=0。
# 为什么：原实现只在「真的扫到东西」时打日志，于是 **`swept=0` 与「sweeper 线程已经死了」
# 在日志里完全同形**。今天重启后首轮（08:21:40）已过，日志里一行都没有，我为了证明它
# 到底跑了没有，多花了 3 次工具调用仍拿不到正面证据——按本岗判据，让我多绕一步的就是缺陷。
# 噪声代价：interval=600s、每 6 轮一条 → 约 24 行/天，可忽略。
_ZOMBIE_HEARTBEAT_EVERY = max(1, int(os.getenv("EVOFLOW_ZOMBIE_HEARTBEAT_EVERY", "6") or "6"))


def zombie_sweeper_enabled() -> bool:
    """Return True unless explicitly disabled via env var."""
    raw = (os.getenv("EVOFLOW_ZOMBIE_SWEEPER") or "").strip().lower()
    if raw in ("0", "false", "no", "off", "disabled"):
        return False
    return True


async def run_zombie_sweeper_scheduler(stop: asyncio.Event) -> None:
    """Periodically scan for and cancel stale active runs.

    Runs every ``EVOFLOW_ZOMBIE_SWEEP_INTERVAL_S`` seconds (default 120).
    Reuses ``reconcile_stale_session_runs`` from run_status_reconcile so the
    sweep logic (stale detection, LangGraph cancel, DB idle mark) stays in
    one place.

    One pass per interval (up to ``EVOFLOW_ZOMBIE_SWEEP_BATCH`` sessions). A
    previous multi-batch loop re-queried the same top-N rows with no offset and
    could tight-loop every 0.5s when ≥ batch sticky running sessions existed.
    Remaining rows are picked up on the next interval.
    """
    interval = max(10, _DEFAULT_INTERVAL_S)
    batch_size = max(10, _ZOMBIE_SWEEP_BATCH_SIZE)
    logger.info(
        "Zombie run sweeper started (interval=%ss, batch=%d; disable with EVOFLOW_ZOMBIE_SWEEPER=0)",
        interval,
        batch_size,
    )
    passes = 0
    while not stop.is_set():
        passes += 1
        cancelled = 0
        cleared = 0
        try:
            from app.gateway.run_status_reconcile import reconcile_stale_session_runs

            stats = await reconcile_stale_session_runs(wait_for_langgraph=False, max_sessions=batch_size)
            cancelled = stats.get("cancelled", 0)
            cleared = stats.get("cleared", 0)
            if cancelled or cleared:
                logger.info(
                    "zombie sweeper pass: cancelled=%d cleared=%d kept=%d healed=%d scanned=%d",
                    cancelled,
                    cleared,
                    stats.get("kept", 0),
                    stats.get("healed", 0),
                    stats.get("scanned", 0),
                )

            # 【self-evolution-bot · 2026-11-20 · 第99轮 · 模型:deepseek-v4.1-flash-1017】
            # 改了什么：周期性跑一次 live 快照 sweep（原来只在启动跑一次）。
            # 为什么（现网取证）：启动 sweep 在 23:21:04 只扫到 1 条并标终态，但前端
            # 重启后仍每 ~5s PUT 心跳，会话收尾前那几条 running 快照的心跳是**当秒**的，
            # 启动那一轮之后再也抓不到；只按心跳判的 sweep 于是永远清不掉它们。
            # 现在 sweep 里加了「会话已终态 ⇒ 孤儿」判据，但会话必须先被收尾成终态，
            # 而那要等 reconcile 跑完——放在 reconcile 之后、每轮都跑，才能把这类收干净。
            try:
                from evoflow.persistence.live_run_repositories import sweep_stale_running_snapshots

                swept = await asyncio.to_thread(
                    sweep_stale_running_snapshots,
                    max_age_s=_ZOMBIE_LIVE_SNAPSHOT_MAX_AGE_S,
                )
                # 【self-evolution-bot · 2026-11-21 · 第103轮】心跳：首轮必打，之后每
                # _ZOMBIE_HEARTBEAT_EVERY 轮一条。作用是把「swept=0（真没东西可清）」与
                # 「这个协程根本没在跑/已崩」区分开——此前两者日志同为 0 行。
                if passes == 1 or passes % _ZOMBIE_HEARTBEAT_EVERY == 0:
                    logger.info(
                        "zombie sweeper heartbeat: pass=%d interval=%ss scanned=%d swept=%d "
                        "cancelled=%d cleared=%d",
                        passes,
                        interval,
                        int(swept.get("scanned") or 0),
                        int(swept.get("swept") or 0),
                        int(cancelled),
                        int(cleared),
                    )
                if swept.get("swept"):
                    logger.info(
                        "zombie sweeper pass: swept %d stale live-run snapshot(s) (scanned=%d)",
                        swept["swept"],
                        swept["scanned"],
                    )
            except Exception:
                logger.debug("zombie sweeper live-run sweep failed", exc_info=True)
        except Exception:
            logger.debug("zombie sweeper pass failed", exc_info=True)

        try:
            await asyncio.wait_for(stop.wait(), timeout=interval)
        except TimeoutError:
            continue
    logger.info("Zombie run sweeper stopped")
