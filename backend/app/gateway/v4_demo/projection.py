"""H1 demo projection writer。

按 EvoFlow 现有会话状态 -> v4 frame 的最小投影器。

完整 spec 见 ``ZCode/packages/shared/src/zcode-protocol-v4`` 和
``EvoFlow/docs/protocol-evolution-spec.md``。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from threading import RLock
from typing import Any

from .protocol_v4_min import (
    ConversationSnapshot,
    ConversationTopicFrame,
    RowsWindow,
)


@dataclass
class _SessionState:
    session_id: str
    log_epoch: str
    seq: int = 0
    next_row_id: int = 1
    rows_by_id: dict[int, dict[str, Any]] = field(default_factory=dict)


class ConversationProjectionWriter:
    """极简版 v4 projection writer。H1 demo 用。

    每个 session 一个实例；写新 row / 改 row / 删 row 都同步更新 ``seq``，
    调用方通过 ``drain_pending(subscription_id)`` 拉取最新 frame 列表。
    """

    def __init__(self, session_id: str, *, log_epoch: str = "0"):
        self._state = _SessionState(session_id=session_id, log_epoch=log_epoch)
        # RLock: nested ``_bump_seq()`` calls inside ``with self._lock`` must not deadlock.
        self._lock = RLock()
        self._pending: dict[str, list[ConversationTopicFrame]] = {}

    @property
    def session_id(self) -> str:
        return self._state.session_id

    @property
    def log_epoch(self) -> str:
        return self._state.log_epoch

    def allocate_row_id(self) -> int:
        with self._lock:
            rid = self._state.next_row_id
            self._state.next_row_id += 1
            return rid

    def _bump_seq(self) -> int:
        with self._lock:
            self._state.seq += 1
            return self._state.seq

    # -- 写 ----------------------------------------------------------------

    def _make_payload(self, kind: str, body: dict[str, Any]) -> dict[str, Any]:
        merged = {"kind": kind, **body}
        return merged

    def snapshot(self, subscription_id: str) -> ConversationTopicFrame:
        with self._lock:
            rows = sorted(self._state.rows_by_id.values(), key=lambda r: r["rowId"])
            snap = ConversationSnapshot(
                sessionId=self._state.session_id,
                logEpoch=self._state.log_epoch,
                seq=self._state.seq,
                rows=RowsWindow(
                    window=rows,
                    firstRowId=rows[0]["rowId"] if rows else None,
                    totalCount=len(rows),
                ),
            )
            seq = self._state.seq
            payload_dict = self._make_payload("conversationSnapshot", snap.model_dump())
            return ConversationTopicFrame(
                subscriptionId=subscription_id,
                logEpoch=self._state.log_epoch,
                fromSeq=seq,
                toSeq=seq,
                payload=payload_dict,
            )

    def emit_row_appended(
        self,
        subscription_id: str,
        row: dict[str, Any],
    ) -> ConversationTopicFrame:
        with self._lock:
            rid = int(row["rowId"])
            self._state.rows_by_id[rid] = row
            from_seq = self._state.seq
            to_seq = self._bump_seq()
            payload_body = {"deltas": [{"op": "row.appended", "row": row}]}
            payload_dict = self._make_payload("conversationDeltas", payload_body)
            frame = ConversationTopicFrame(
                subscriptionId=subscription_id,
                logEpoch=self._state.log_epoch,
                fromSeq=from_seq,
                toSeq=to_seq,
                payload=payload_dict,
            )
            self._pending.setdefault(subscription_id, []).append(frame)
            return frame

    def emit_row_upserted(
        self,
        subscription_id: str,
        row: dict[str, Any],
    ) -> ConversationTopicFrame:
        """update 现有 row 的 fields（典型：streaming text 增长）。"""
        with self._lock:
            rid = int(row["rowId"])
            if rid not in self._state.rows_by_id:
                self._state.rows_by_id[rid] = row
                delta_op = "row.appended"
            else:
                self._state.rows_by_id[rid] = row
                delta_op = "row.upserted"
            from_seq = self._state.seq
            to_seq = self._bump_seq()
            payload_body = {"deltas": [{"op": delta_op, "row": row}]}
            payload_dict = self._make_payload("conversationDeltas", payload_body)
            frame = ConversationTopicFrame(
                subscriptionId=subscription_id,
                logEpoch=self._state.log_epoch,
                fromSeq=from_seq,
                toSeq=to_seq,
                payload=payload_dict,
            )
            self._pending.setdefault(subscription_id, []).append(frame)
            return frame

    def emit_row_removed(
        self,
        subscription_id: str,
        row_id: int,
    ) -> ConversationTopicFrame:
        with self._lock:
            self._state.rows_by_id.pop(int(row_id), None)
            from_seq = self._state.seq
            to_seq = self._bump_seq()
            payload_body = {"deltas": [{"op": "row.removed", "fromRowId": int(row_id)}]}
            payload_dict = self._make_payload("conversationDeltas", payload_body)
            frame = ConversationTopicFrame(
                subscriptionId=subscription_id,
                logEpoch=self._state.log_epoch,
                fromSeq=from_seq,
                toSeq=to_seq,
                payload=payload_dict,
            )
            self._pending.setdefault(subscription_id, []).append(frame)
            return frame

    # -- 订阅消费 ----------------------------------------------------------

    def drain_pending(self, subscription_id: str) -> list[ConversationTopicFrame]:
        with self._lock:
            return self._pending.pop(subscription_id, [])

    def current_seq(self) -> int:
        with self._lock:
            return self._state.seq
