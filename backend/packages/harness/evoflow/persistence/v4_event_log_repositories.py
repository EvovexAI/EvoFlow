"""evoflow_v4_event_log — v4 权威 delta 日志持久化（ZCode durable event 语义）。

为什么存在：v4 hub 的 delta_log 只在内存（保留窗 + 重启即丢），AG-UI SSE 流结束后
「这一轮到底发生了什么、断在哪一帧」无从查证。这里把 hub `author_deltas` 写出的
**每一条权威 delta**（seq 有序、(session_id, log_epoch, seq) 唯一）落库成事件档案：

- 发送/停止/流式的完整事件序列可按 session + epoch + seq 区间回放；
- turnHeader 终态 upsert（completedSuccess / completedInterrupted / error）就是
  「正常回复 / 被停止 / 失败」的档案标记；
- 404 remint / catchup wipe 会 bump log_epoch——旧 epoch 的档案保留可查，语义代际隔离。

与 transcript（evoflow_chat_messages）的关系：transcript 是**语义内容**的持久层
（按 run_id 分轮，图退出/中断时落库）；event log 是**过程事实**的持久层（逐条 delta，
实时落库）。两者以 thread_id + run_id（=turnId）关联。

保留：``EVOFLOW_V4_EVENT_LOG_DAYS``（默认 14 天），由写入器周期清理。
"""

from __future__ import annotations

import json
import logging
from typing import Any

logger = logging.getLogger(__name__)


def append_v4_event_log_rows(
    rows: list[tuple[str, str, int, str, str, str]],
) -> int:
    """批量写入事件行 ``(session_id, log_epoch, seq, op, payload_json, created_at)``。

    INSERT OR IGNORE：(session_id, log_epoch, seq) 唯一——重复投递（写线程重试等）
    幂等。返回实际插入行数。
    """
    if not rows:
        return 0
    from evoflow.persistence.db import run_db_transaction

    def _tx(db: Any) -> int:
        inserted = 0
        for session_id, log_epoch, seq, op, payload, created_at in rows:
            cur = db.execute(
                """
                INSERT OR IGNORE INTO evoflow_v4_event_log
                    (session_id, log_epoch, seq, op, payload, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (session_id, log_epoch, seq, op, payload, created_at),
            )
            inserted += int(cur.rowcount or 0)
        return inserted

    try:
        return int(run_db_transaction(_tx) or 0)
    except Exception:
        logger.warning("[v4-event-log] append failed rows=%s", len(rows), exc_info=True)
        return 0


def list_v4_event_log(
    session_id: str,
    *,
    log_epoch: str | None = None,
    after_seq: int = 0,
    limit: int = 500,
) -> list[dict[str, Any]]:
    """按 (log_epoch, seq) 升序回放事件；log_epoch 缺省=各 epoch 最新拼接（审计用）。"""
    sid = str(session_id or "").strip()
    if not sid:
        return []
    from evoflow.persistence.db import run_db_read

    def _query(conn: Any) -> list[dict[str, Any]]:
        if log_epoch:
            rows = conn.execute(
                """
                SELECT log_epoch, seq, op, payload, created_at
                FROM evoflow_v4_event_log
                WHERE session_id = ? AND log_epoch = ? AND seq > ?
                ORDER BY seq ASC LIMIT ?
                """,
                (sid, log_epoch, max(0, int(after_seq)), max(1, min(int(limit), 5000))),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT log_epoch, seq, op, payload, created_at
                FROM evoflow_v4_event_log
                WHERE session_id = ? AND seq > ?
                ORDER BY created_at ASC, seq ASC LIMIT ?
                """,
                (sid, max(0, int(after_seq)), max(1, min(int(limit), 5000))),
            ).fetchall()
        out: list[dict[str, Any]] = []
        for r in rows:
            payload_raw = str(r[3] or "")
            try:
                payload = json.loads(payload_raw) if payload_raw else None
            except Exception:
                payload = payload_raw
            out.append(
                {
                    "logEpoch": str(r[0] or ""),
                    "seq": int(r[1] or 0),
                    "op": str(r[2] or ""),
                    "payload": payload,
                    "createdAt": str(r[4] or ""),
                }
            )
        return out

    try:
        return run_db_read(_query) or []
    except Exception:
        logger.warning("[v4-event-log] list failed session=%s", sid, exc_info=True)
        return []


def latest_v4_event_log_seq(session_id: str, log_epoch: str | None = None) -> int:
    """该会话（可选限定 epoch）已落库的最大 seq；无行返回 0。"""
    sid = str(session_id or "").strip()
    if not sid:
        return 0
    from evoflow.persistence.db import run_db_read

    def _query(conn: Any) -> int:
        if log_epoch:
            row = conn.execute(
                "SELECT MAX(seq) FROM evoflow_v4_event_log WHERE session_id = ? AND log_epoch = ?",
                (sid, log_epoch),
            ).fetchone()
        else:
            row = conn.execute(
                "SELECT MAX(seq) FROM evoflow_v4_event_log WHERE session_id = ?",
                (sid,),
            ).fetchone()
        return int(row[0] or 0) if row else 0

    try:
        return int(run_db_read(_query) or 0)
    except Exception:
        return 0


def prune_v4_event_log(days: int) -> int:
    """删除 created_at 早于 ``days`` 天的事件行，返回删除数（保留策略由写入器周期调用）。"""
    keep_days = max(1, int(days))
    from evoflow.persistence.db import run_db_transaction

    def _tx(db: Any) -> int:
        cur = db.execute(
            """
            DELETE FROM evoflow_v4_event_log
            WHERE created_at < datetime('now', ?)
            """,
            (f"-{keep_days} days",),
        )
        return int(cur.rowcount or 0)

    try:
        return int(run_db_transaction(_tx) or 0)
    except Exception:
        logger.debug("[v4-event-log] prune failed days=%s", keep_days, exc_info=True)
        return 0
