"""v4 权威事件日志写入器（ZCode durable event 语义的落库侧）。

写入契约（对齐 `conversation.py.author_deltas` 的调用方约束）：
- 调用方在热路径（30ms 打帧、feed-to-thread worker）上，**绝不阻塞**：
  入队 = ``queue.put_nowait``，队列满则丢弃该批并打 warning（丢弃本身会在
  (session, epoch) 的 seq 序列上留洞——审计时按 seq gap 识别，比拖死网关好）。
- 落库在守护线程批量进行：攒 ≤400 行 / ≤400ms 一次事务；进程退出尽力冲一次。
- 保留：``EVOFLOW_V4_EVENT_LOG_DAYS``（默认 14 天），writer 每 ~60s 顺带 prune。
"""

from __future__ import annotations

import logging
import os
import queue
import threading
import time
from datetime import datetime, timezone
from typing import Any

logger = logging.getLogger(__name__)

_QUEUE_MAX = 50_000
_FLUSH_MAX_ROWS = 400
_FLUSH_WINDOW_S = 0.4
_PRUNE_INTERVAL_S = 60.0

_FALSE_ENV = {"0", "false", "no", "off"}


def _env_flag(name: str, default: bool) -> bool:
    raw = (os.getenv(name) or "").strip().lower()
    if not raw:
        return default
    return raw not in _FALSE_ENV


def event_log_writes_enabled() -> bool:
    """默认开（档案是本特性主体）；显式关才停——与 stream mirror 的默认相反。"""
    return _env_flag("EVOFLOW_V4_EVENT_LOG", default=True)


def _event_log_days() -> int:
    raw = (os.getenv("EVOFLOW_V4_EVENT_LOG_DAYS") or "").strip()
    try:
        return max(1, int(raw)) if raw else 14
    except ValueError:
        return 14


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="milliseconds")


class _V4EventLogWriter:
    """后台批量写入线程。行格式 (session_id, log_epoch, seq, op, payload_json)。"""

    def __init__(self) -> None:
        self._queue: "queue.Queue[tuple[str, str, int, str, str, str]]" = queue.Queue(
            maxsize=_QUEUE_MAX
        )
        self._dropped_batches = 0
        self._last_prune_at = 0.0
        self._started = False
        self._start_lock = threading.Lock()

    def enqueue(
        self,
        session_id: str,
        log_epoch: str,
        items: list[tuple[int, str, str]],
    ) -> None:
        """items = [(seq, op, payload_json)]；created_at 在入队时刻生成（真实顺序）。"""
        if not items:
            return
        now = _now_iso()
        rows: list[tuple[str, str, int, str, str, str]] = [
            (session_id, log_epoch, seq, op, payload, now) for seq, op, payload in items
        ]
        try:
            for row in rows:
                self._queue.put_nowait(row)
        except queue.Full:
            self._dropped_batches += 1
            if self._dropped_batches % 20 == 1:
                logger.warning(
                    "[v4-event-log] queue full; dropped batch rows=%s total_drops=%s",
                    len(rows),
                    self._dropped_batches,
                )

    def _ensure_started(self) -> None:
        if self._started:
            return
        with self._start_lock:
            if self._started:
                return
            t = threading.Thread(target=self._run, name="v4-event-log-writer", daemon=True)
            t.start()
            self._started = True

    def _run(self) -> None:
        from evoflow.persistence.v4_event_log_repositories import (
            append_v4_event_log_rows,
            prune_v4_event_log,
        )

        pending: list[tuple[str, str, int, str, str, str]] = []
        deadline = time.monotonic() + _FLUSH_WINDOW_S
        while True:
            try:
                row = self._queue.get(timeout=_FLUSH_WINDOW_S)
                pending.append(row)
            except queue.Empty:
                pass
            except Exception:
                logger.debug("[v4-event-log] get failed", exc_info=True)
            drain_until = time.monotonic() + 0.02
            while len(pending) < _FLUSH_MAX_ROWS:
                try:
                    pending.append(self._queue.get_nowait())
                except queue.Empty:
                    break
                except Exception:
                    break
                if time.monotonic() > drain_until:
                    break
            now_mono = time.monotonic()
            if pending and (len(pending) >= _FLUSH_MAX_ROWS or now_mono >= deadline):
                try:
                    inserted = append_v4_event_log_rows(pending)
                    if inserted < len(pending):
                        logger.debug(
                            "[v4-event-log] flush inserted=%s/%s (dup ignored)",
                            inserted,
                            len(pending),
                        )
                except Exception:
                    logger.warning("[v4-event-log] flush failed rows=%s", len(pending), exc_info=True)
                pending = []
                deadline = time.monotonic() + _FLUSH_WINDOW_S
            if not pending and now_mono >= deadline:
                deadline = time.monotonic() + _FLUSH_WINDOW_S
            # 周期清理（低频；无行时也执行以便空库滚保留窗）
            if now_mono - self._last_prune_at >= _PRUNE_INTERVAL_S:
                self._last_prune_at = now_mono
                try:
                    removed = prune_v4_event_log(_event_log_days())
                    if removed:
                        logger.info("[v4-event-log] pruned %s rows (>%sd)", removed, _event_log_days())
                except Exception:
                    logger.debug("[v4-event-log] prune failed", exc_info=True)

    def flush_for_tests(self, timeout_s: float = 3.0) -> int:
        """测试/退出用：同步冲干队列，返回冲掉的行数。"""
        drained: list[tuple[str, str, int, str, str, str]] = []
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            try:
                drained.append(self._queue.get_nowait())
            except queue.Empty:
                break
            except Exception:
                break
        if not drained:
            return 0
        from evoflow.persistence.v4_event_log_repositories import append_v4_event_log_rows

        return append_v4_event_log_rows(drained)


_writer = _V4EventLogWriter()


def enqueue_v4_event_log(
    session_id: str,
    log_epoch: str,
    items: list[tuple[int, str, str]],
) -> None:
    """author_deltas 的落库入口（非阻塞）。禁用开关时直接返回。"""
    if not event_log_writes_enabled():
        return
    if not items:
        return
    _writer.enqueue(session_id, log_epoch, items)
    _writer._ensure_started()


def flush_v4_event_log_for_tests(timeout_s: float = 3.0) -> int:
    if not event_log_writes_enabled():
        return 0
    return _writer.flush_for_tests(timeout_s=timeout_s)
