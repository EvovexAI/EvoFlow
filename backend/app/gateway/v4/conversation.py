"""V4 conversation hub — ZCode v4 wire 协议的 EvoFlow 服务端实现。

对齐 ``evopanel/src/zcode-shared/zcode-protocol-v4/`` 的 zod schema：

- subscribe/unsubscribe：ACK-only；initial snapshot 作为后续 SSE 帧下发；
  携有效 base 时走 ``mode: "resume"``（保留窗内 delta 重放）。
- frames：SSE 下发 ``ConversationTopicWireCandidate``（wireVersion=3, kind=complete）。
- command：``CommandEnvelope`` -> ``CommandAck``；createSession / sendText 走
  echo 或 OpenAI 兼容真实 LLM 流（``EVOFLOW_V4_LLM=1``）。
- 生产镜像：``agui_mirror.py`` 把 AG-UI 事件流翻译成 ZCode 协议 delta 写进本 hub
  （``mirror_feed_agui_wire``），主聊天流式走本条链路。

丝滑管线（对齐 ZCode v4 gateway 的参数表，``shared/zcode-protocol-v4/core.ts``）：
1. **authoring**：生产者每次调用 ``author_deltas`` 逐条分配 seq，写入权威
   delta 日志（保留窗 2000 条）并追加进每个订阅者的待发缓冲。
2. **flush 窗**：每个订阅者一个定时器——首个 pending op 到达后排
   ``flushWindowMs``（continuous 30ms / replayable 150ms）一次性打帧；
   帧内先过 ``coalesce_conversation_deltas`` 语义保持合并。
3. **水位**：订阅者缓冲上限 500 ops / 1MiB，溢出清空缓冲并置
   ``resyncRequired``——下一次 flush 直接发全量 snapshot（deliveryKind=recovery），
   永不为慢订阅者无界积压。
4. **区间记账**：delta 帧 fromSeq = 上次 flush 的 toSeq（快照后 = snapshot toSeq），
   客户端 ``frame.fromSeq === state.seq`` 才 apply；被合并/淘汰的 seq 不产出，
   区间仍然连续（快照帧 fromSeq 固定 0）。

对齐日志（前后端逐帧对齐用）：
- 服务端 ``v4.flush``：topic / fromSeq→toSeq / coalesce 前后 op 数 / 字节；
- 服务端 ``v4.author``：每次 authoring 的 op 数与 seq 水位。
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from app.gateway.v4.coalesce import coalesce_conversation_deltas
from app.gateway.v4.command_inbox import CommandInbox

logger = logging.getLogger(__name__)

V4_WIRE_PROTOCOL_VERSION = 3

_PHASE_DRAFT = "draft"
_PHASE_RUNNING = "running"
_PHASE_COMPLETED = "completedSuccess"
_PHASE_ERROR = "error"
_PHASE_INTERRUPTED = "completedInterrupted"

# ZCode PROTOCOL_V4_LIMITS（shared/zcode-protocol-v4/core.ts）对齐项。
_DELTA_RETENTION_MAX = 2000
_SUBSCRIBER_BUFFER_MAX_OPS = 500
_SUBSCRIBER_BUFFER_MAX_BYTES = 1024 * 1024
_FLUSH_WINDOW_MS = {"continuous": 30, "replayable": 150}
_DEFAULT_PROFILE = "continuous"

# 快照尾部窗口：对齐 shared/zcode-protocol-v4/core.ts
# PROTOCOL_V4_LIMITS.snapshotTailWindowRows（前端 loadOlder 游标补拉更早行，
# rowsWindowSchema 的 window/totalCount/firstRowId 均按截断语义设计）。
_SNAPSHOT_TAIL_ROWS = max(20, int(os.getenv("EVOFLOW_V4_SNAPSHOT_TAIL_ROWS", "60") or "60"))
# 快照帧字节预算：rows 序列化超限则对半收缩窗口——防单行超大 display（长工具
# 输出 / structuredPatch）在 60 行窗口内仍爆帧。下限保证至少 20 行可上屏。
_SNAPSHOT_MIN_TAIL_ROWS = 20
_SNAPSHOT_MAX_BYTES = max(64 * 1024, int(os.getenv("EVOFLOW_V4_SNAPSHOT_MAX_KB", "256") or "256") * 1024)


def _resolve_profile(client_mode: str | None) -> str:
    mode = str(client_mode or "").strip()
    return "continuous" if mode == "desktop-continuous" else "replayable" if mode else _DEFAULT_PROFILE


# ── 契约模板（zod 生成；键级整体替换，禁止深合并）───────────────────────────


def _minimal_control(phase: str) -> dict[str, Any]:
    return {
        "phase": phase,
        "sessionEnded": False,
        "canStop": phase == _PHASE_RUNNING,
        "stopState": "stoppable" if phase == _PHASE_RUNNING else "idle",
        "stopTargetKind": "assistant",
        "activeWorks": [],
        "lastError": None,
        "apiRetry": None,
    }


def _minimal_availability() -> dict[str, Any]:
    return {
        "fork": {"allowed": True},
        "compact": {"allowed": True},
        "switchModelConfig": {"allowed": True},
        "setFollowupMode": {"allowed": True},
        "queueEdit": {"allowed": True},
        "sendQueuedNow": {"allowed": True},
        "pauseGoal": {"allowed": True},
        "resumeGoal": {"allowed": True},
    }


def _minimal_usage() -> dict[str, Any]:
    return {
        "contextWindow": {
            "usedTokens": 0,
            "maxTokens": 200000,
            "autoCompactThresholdTokens": 160000,
        },
        "cumulative": {
            "inputTokens": 0,
            "outputTokens": 0,
            "cacheReadTokens": 0,
            "cacheWriteTokens": 0,
        },
    }


def _minimal_config(followup_mode: str = "queue") -> dict[str, Any]:
    return {
        "provider": "evoflow",
        "model": os.getenv("EVOFLOW_LLM_MODEL", "evoflow-default"),
        "thought": "",
        "followupMode": followup_mode,
    }


# ── 会话态 ──────────────────────────────────────────────────────────────────


@dataclass
class _SessionState:
    session_id: str
    log_epoch: str = "1"
    seq: int = 0
    revision: int = 0
    next_row_id: int = 1
    phase: str = _PHASE_DRAFT
    title: str = ""
    rows: dict[int, dict[str, Any]] = field(default_factory=dict)
    turn_task: asyncio.Task | None = None
    """当前 turn 的流式 task（防并发 turn）。"""
    # 权威 delta 日志：(seq, delta) 升序；保留窗淘汰后 floor = 淘汰段的最大 seq。
    delta_log: list[tuple[int, dict[str, Any]]] = field(default_factory=list)
    delta_log_floor: int = 0
    # ── queue / 输入路由（对齐 ZCode v3.15.1 queue 命令组语义）────────────────
    queue_items: list[dict[str, Any]] = field(default_factory=list)
    """QueueItem intent 列表（vendored queueItemSchema 形状；FIFO 序即列表序）。"""
    auto_drain: bool = True
    """stop 后 = False（暂停队列）；setAutoDrain 恢复（对齐 queueStateSchema 注释）。"""
    pause_reason: str | None = None
    """stopped / manual / error；None = 未暂停。"""
    followup_mode: str = "queue"
    """turn running 时新输入的默认路由（queue=入队；guide 同入队但标记 guide）。"""
    feedbacks: dict[str, str] = field(default_factory=dict)
    """assistant 反馈（rowId/messageId → like|dislike）；v1 shell 只记录不持久化。"""
    _queue_admission_seq: int = 0
    """queue 项 admissionSeq 计数（与 command inbox 的 admission 序独立递增）。"""

    def control(self) -> dict[str, Any]:
        return _minimal_control(self.phase)

    def turn_running(self) -> bool:
        return self.turn_task is not None and not self.turn_task.done()

    def queue_state(self) -> dict[str, Any]:
        """协议形状 = vendored ``queueStateSchema``（items/autoDrain/pauseReason）。"""
        items: list[dict[str, Any]] = []
        for pos, item in enumerate(self.queue_items):
            entry = dict(item)
            entry["order"] = {**entry.get("order", {}), "queuePosition": pos}
            entry["dispatch"] = {"state": "queued"}
            items.append(entry)
        state: dict[str, Any] = {"items": items, "autoDrain": self.auto_drain}
        if self.pause_reason is not None:
            state["pauseReason"] = self.pause_reason
        return state

    def input_routing(self) -> dict[str, Any]:
        """对齐 ``inputRoutingSchema``：running 且 followup=queue → enqueue；其余 startNow。"""
        if self.turn_running() and self.followup_mode == "queue":
            return {"mode": "enqueue"}
        return {"mode": "startNow"}


@dataclass
class _Subscription:
    subscription_id: str
    session_id: str
    connection_id: str
    topic: str
    profile: str = _DEFAULT_PROFILE
    queue: list[dict[str, Any]] = field(default_factory=list)
    logical_frame_ordinal: int = 0
    delivered_seq: int = -1
    """本订阅已投递到的 seq（快照/resync 后同步；delta flush 推进）。"""
    last_flushed_seq: int = -1
    """下一帧 delta 的 fromSeq（区间记账起点）；快照/resume 后对齐客户端水位。"""
    # 待发 delta 缓冲：(seq, delta) 权威序；flush 时 coalesce 成一帧。
    pending_ops: list[tuple[int, dict[str, Any]]] = field(default_factory=list)
    pending_bytes: int = 0
    overflowed: bool = False
    flush_handle: Any = None
    """loop.call_later 句柄；None = 无在途 flush。"""

    def next_ordinal(self) -> int:
        self.logical_frame_ordinal += 1
        return self.logical_frame_ordinal

    def flush_window_s(self) -> float:
        return _FLUSH_WINDOW_MS.get(self.profile, _FLUSH_WINDOW_MS[_DEFAULT_PROFILE]) / 1000.0


class V4ConversationHub:
    """进程内单例：session 状态 + 订阅 + wire 帧队列。

    frames SSE 端点按 connectionId 长轮询所有订阅的队列；帧一旦入队即保序。
    authoring 可能来自事件循环线程，也可能来自流式热路径的 worker 线程
    （post_stream_ui_normalize 的大帧 feed-to-thread），因此写路径用
    ``threading.RLock`` 串行化，flush 调度经 ``loop.call_soon_threadsafe``。
    """

    def __init__(self) -> None:
        self._sessions: dict[str, _SessionState] = {}
        self._subscriptions: dict[str, _Subscription] = {}
        self._inbox = CommandInbox(host=self)  # type: ignore[arg-type]
        self._lock = asyncio.Lock()
        self._write_lock = threading.RLock()
        self._loop: asyncio.AbstractEventLoop | None = None

    # -- 查询 ---------------------------------------------------------------

    def get_session(self, session_id: str) -> _SessionState | None:
        return self._sessions.get(session_id)

    def _get_or_create_session(self, session_id: str | None = None) -> _SessionState:
        sid = session_id or f"v4-{uuid.uuid4().hex[:12]}"
        sess = self._sessions.get(sid)
        if sess is None:
            sess = _SessionState(session_id=sid)
            self._sessions[sid] = sess
        return sess

    def _capture_loop(self) -> None:
        if self._loop is None:
            try:
                self._loop = asyncio.get_running_loop()
            except RuntimeError:
                self._loop = None

    # -- 只读查询 -------------------------------------------------------------

    def rows_range(
        self,
        session_id: str,
        *,
        before_row_id: int | None,
        limit: int,
    ) -> dict[str, Any]:
        """rows/range 行分页：取 rowId < before_row_id 的尾部窗口（升序返回）。"""
        sess = self._sessions.get(session_id)
        if sess is None:
            raise KeyError(session_id)
        limit = max(1, min(int(limit), 200))
        with self._write_lock:
            row_ids = sorted(sess.rows.keys())
            if before_row_id is not None:
                eligible = [rid for rid in row_ids if rid < int(before_row_id)]
            else:
                eligible = row_ids
            window_ids = eligible[-limit:]
            rows = [sess.rows[rid] for rid in window_ids]
        return {
            "rows": rows,
            "atSeq": sess.seq,
            "atRevision": sess.revision,
            "atLogEpoch": sess.log_epoch,
            "hasMore": len(eligible) > len(window_ids),
        }

    def file_changes(self, session_id: str, row_id: int) -> dict[str, Any]:
        """turn 级文件审查：按 turnHeader rowId 聚合该轮写类工具的 file_diff display。

        对齐 ZCode ``v4/conversation/fileChanges``（V4ConversationFileChangesResult）：
        items 按 path 聚合 additions/deletions/writeCount/toolNames/patches，
        patches 直接复用各工具行 output.display.structuredPatch 的 hunk。
        """
        sess = self._sessions.get(session_id)
        if sess is None:
            raise KeyError(session_id)
        header = sess.rows.get(int(row_id))
        if header is None or header.get("kind") != "turnHeader":
            raise KeyError(row_id)
        turn_id = str(header.get("turnId") or "")
        per_path: dict[str, dict[str, Any]] = {}

        def _absorb_display(display: dict[str, Any], tool_name: str) -> None:
            if display.get("kind") != "file_diff":
                return
            path = str(display.get("filePath") or "").strip()
            if not path:
                return
            entry = per_path.setdefault(
                path,
                {
                    "path": path,
                    "additions": 0,
                    "deletions": 0,
                    "writeCount": 0,
                    "toolNames": [],
                    "patches": [],
                },
            )
            entry["additions"] += int(display.get("additions") or 0)
            entry["deletions"] += int(display.get("deletions") or 0)
            entry["writeCount"] += 1
            name = str(tool_name or "").strip()
            if name and name not in entry["toolNames"]:
                entry["toolNames"].append(name)
            for hunk in display.get("structuredPatch") or []:
                if not isinstance(hunk, dict):
                    continue
                entry["patches"].append(
                    {
                        "oldStart": int(hunk.get("oldStart") or 1),
                        "oldLines": int(hunk.get("oldLines") or 0),
                        "newStart": int(hunk.get("newStart") or 1),
                        "newLines": int(hunk.get("newLines") or 0),
                        "lines": [str(line) for line in hunk.get("lines") or []],
                    }
                )

        from app.gateway.v4.agui_mirror import (
            _WRITE_TOOL_NAMES,
            _extract_diff_texts_from_args,
            build_file_diff_display,
        )

        for row in sess.rows.values():
            if row.get("kind") != "toolCall" or str(row.get("turnId") or "") != turn_id:
                continue
            tool_name = str(row.get("toolName") or "")
            output = row.get("output") if isinstance(row.get("output"), dict) else {}
            display = output.get("display") if isinstance(output, dict) else None
            if isinstance(display, dict) and display.get("kind") == "file_diff":
                _absorb_display(display, tool_name)
                continue
            # display 丢失时：从写类工具 inputText 现场重建（避免摘要有数、展开无列表）
            if tool_name.lower() not in _WRITE_TOOL_NAMES:
                continue
            extracted = _extract_diff_texts_from_args(str(row.get("inputText") or ""))
            if extracted is None:
                continue
            rebuilt = build_file_diff_display(*extracted)
            if rebuilt is not None:
                _absorb_display(rebuilt, tool_name)

        items = sorted(per_path.values(), key=lambda e: e["path"])
        return {
            "files": len(items),
            "additions": sum(e["additions"] for e in items),
            "deletions": sum(e["deletions"] for e in items),
            "state": str((header.get("fileChanges") or {}).get("state") or "active"),
            "items": items,
        }

    async def resync(
        self,
        *,
        subscription_id: str,
        base: dict[str, Any] | None,
    ) -> dict[str, Any]:
        """同订阅恢复：重新投递完整 snapshot（deliveryKind=recovery，权威替换旧 assembly）。"""
        async with self._lock:
            sub = self._subscriptions.get(subscription_id)
        if sub is None:
            raise KeyError(subscription_id)
        sess = self._sessions.get(sub.session_id)
        if sess is None:
            raise KeyError(sub.session_id)
        with self._write_lock:
            sub.logical_frame_ordinal += 1
            self._cancel_flush(sub)
            sub.pending_ops = []
            sub.pending_bytes = 0
            sub.overflowed = False
            self._enqueue_snapshot_locked(sub, sess, delivery_kind="recovery")
        return {
            "ack": {
                "subscriptionId": sub.subscription_id,
                "mode": "snapshot",
                "logEpoch": sess.log_epoch,
            }
        }

    # -- 订阅 ---------------------------------------------------------------

    async def subscribe(
        self,
        *,
        connection_id: str,
        session_id: str,
        base: dict[str, Any] | None = None,
        client_mode: str | None = None,
    ) -> dict[str, Any]:
        self._capture_loop()
        sess = self._get_or_create_session(session_id)
        subscription_id = f"sub-{uuid.uuid4().hex[:10]}"
        topic = f"conversation/{sess.session_id}"
        sub = _Subscription(
            subscription_id=subscription_id,
            session_id=sess.session_id,
            connection_id=connection_id,
            topic=topic,
            profile=_resolve_profile(client_mode),
        )
        async with self._lock:
            # 重订阅替换（对齐 zcode subscribeParams 注释：按 (connectionId, topic) 判定）。
            # 草稿预热 → pane 接管会对同一 (conn, topic) 二次订阅；旧订阅继续广播
            # 会在客户端产生"非本订阅所有权"的帧流，触发 fail-close 重连横幅。
            for existing_id, existing in list(self._subscriptions.items()):
                if (
                    existing.connection_id == connection_id
                    and existing.topic == topic
                    and existing_id != subscription_id
                ):
                    self._cancel_flush(existing)
                    del self._subscriptions[existing_id]
            self._subscriptions[subscription_id] = sub

            resume_ok = False
            if isinstance(base, dict):
                base_epoch = str(base.get("logEpoch") or "")
                base_seq = int(base.get("seq") or 0)
                # 水位不变量：base 在保留窗内才可 resume；否则全量 snapshot。
                resume_ok = (
                    base_epoch == sess.log_epoch
                    and sess.delta_log_floor <= base_seq <= sess.seq
                    and (base_seq < sess.seq or not sess.delta_log)
                )
            if resume_ok:
                base_seq = int(base.get("seq") or 0)  # type: ignore[union-attr]
                replay = [d for (seq, d) in sess.delta_log if seq > base_seq]
                ack_mode = "resume"
                sub.last_flushed_seq = base_seq
                if replay:
                    coalesced = coalesce_conversation_deltas(replay)
                    frame = {
                        "topic": topic,
                        "subscriptionId": subscription_id,
                        "fromSeq": base_seq,
                        "toSeq": sess.seq,
                        "sentAt": int(time.time() * 1000),
                        "payload": {"kind": "deltas", "deltas": coalesced},
                    }
                    sub.queue.append(self._wrap_wire(sub, frame, "online"))
                    sub.delivered_seq = sess.seq
                    sub.last_flushed_seq = sess.seq
                    logger.info(
                        "[v4.flush] resume replay session=%s sub=%s %d->%d ops=%d (raw=%d)",
                        sess.session_id,
                        subscription_id,
                        base_seq,
                        sess.seq,
                        len(coalesced),
                        len(replay),
                    )
            else:
                # 冷会话先 hydrate 历史（旧 transcript → v4 行），快照才不是空面板。
                # 失败静默：缺历史只影响显示，不阻断订阅。
                #
                # 空会话必须允许「再次订阅时重试」：协作子任务面板常在步骤还在跑时
                # 就订阅（transcript 尚未落库 → hydrate 拿到 0 行），若此后不再尝试，
                # 面板会永久空白。hydrate 内部按 rows 判重，这里只需在仍为空时重试。
                if not sess.rows:
                    try:
                        from app.gateway.v4.hydration import hydrate_session_from_transcript

                        loaded = hydrate_session_from_transcript(self, sess.session_id)
                        if loaded:
                            logger.info(
                                "[v4.hydration] resubscribe recovered history session=%s rows=%s",
                                sess.session_id,
                                loaded,
                            )
                    except Exception:
                        logger.exception(
                            "[v4.hydration] subscribe hydration failed session=%s",
                            sess.session_id,
                        )
                ack_mode = "snapshot"
                self._enqueue_snapshot_locked(sub, sess, delivery_kind="initial")
        return {
            "ack": {
                "subscriptionId": subscription_id,
                "mode": ack_mode,
                "logEpoch": sess.log_epoch,
            }
        }

    async def unsubscribe(self, *, subscription_id: str) -> None:
        async with self._lock:
            sub = self._subscriptions.pop(subscription_id, None)
        if sub is not None:
            self._cancel_flush(sub)

    def poll_frames(self, connection_id: str) -> list[dict[str, Any]]:
        """取走该连接所有订阅的待发帧（FIFO 保序）。"""
        out: list[dict[str, Any]] = []
        for sub in list(self._subscriptions.values()):
            if sub.connection_id != connection_id:
                continue
            out.extend(sub.queue)
            sub.queue.clear()
        return out

    # -- 生产者面（authoring）-------------------------------------------------
    # 行存储更新与 delta 日志在同一把写锁内完成，保证快照与增量不出现中间态。

    def author_deltas(self, session_id: str, deltas: list[dict[str, Any]]) -> None:
        """把一批协议 delta 写入权威日志并广播到订阅者缓冲（每条 delta 一个 seq）。"""
        if not deltas:
            return
        # JSON 尺寸编码在锁外完成：持锁逐条 json.dumps 是流式 worker 长时间
        # 占住 _write_lock 的主要来源，会让 loop 线程上的 rows_range /
        # poll_frames 无界等待。
        sizes = [len(json.dumps(d, ensure_ascii=False)) for d in deltas]
        with self._write_lock:
            sess = self._get_or_create_session(session_id)
            subs = [s for s in self._subscriptions.values() if s.session_id == sess.session_id]
            for delta, encoded in zip(deltas, sizes):
                sess.seq += 1
                sess.delta_log.append((sess.seq, delta))
                if len(sess.delta_log) > _DELTA_RETENTION_MAX:
                    evicted_seq = sess.delta_log.pop(0)[0]
                    floor = sess.delta_log[0][0] - 1 if sess.delta_log else evicted_seq
                    sess.delta_log_floor = max(sess.delta_log_floor, floor)
                if not subs:
                    continue
                for sub in subs:
                    if sub.overflowed:
                        continue
                    sub.pending_ops.append((sess.seq, delta))
                    sub.pending_bytes += encoded
                    if (
                        len(sub.pending_ops) > _SUBSCRIBER_BUFFER_MAX_OPS
                        or sub.pending_bytes > _SUBSCRIBER_BUFFER_MAX_BYTES
                    ):
                        # 溢出语义：清空缓冲置 resyncRequired，下一次 flush 发全量 snapshot。
                        sub.pending_ops = []
                        sub.pending_bytes = 0
                        sub.overflowed = True
                        continue
                    self._schedule_flush(sub)
            logger.debug(
                "[v4.author] session=%s ops=%d seq=%d subs=%d",
                sess.session_id,
                len(deltas),
                sess.seq,
                len(subs),
            )

    def author_append_row(self, session_id: str, row: dict[str, Any]) -> None:
        with self._write_lock:
            sess = self._get_or_create_session(session_id)
            sess.rows[int(row["rowId"])] = row
        self.author_deltas(session_id, [{"op": "row.appended", "row": row}])

    def author_upsert_row(self, session_id: str, row: dict[str, Any]) -> None:
        with self._write_lock:
            sess = self._get_or_create_session(session_id)
            if int(row["rowId"]) not in sess.rows:
                sess.rows[int(row["rowId"])] = row
                op: dict[str, Any] = {"op": "row.appended", "row": row}
            else:
                sess.rows[int(row["rowId"])] = row
                op = {"op": "row.upserted", "row": row}
        self.author_deltas(session_id, [op])

    def author_row_delta(self, session_id: str, row_id: int, path: str, append: str) -> None:
        if not append:
            return
        self.author_deltas(
            session_id,
            [{"op": "row.delta", "rowId": int(row_id), "path": path, "append": append}],
        )

    def author_state_patch(self, session_id: str, patch: dict[str, Any]) -> None:
        self.author_deltas(session_id, [{"op": "state.updated", "patch": patch}])

    def patch_phase(self, session_id: str, phase: str) -> None:
        sess = self._get_or_create_session(session_id)
        sess.phase = phase
        self.author_state_patch(session_id, {"control": _minimal_control(phase)})

    # -- flush 调度 -------------------------------------------------------------

    def _schedule_flush(self, sub: _Subscription) -> None:
        """首个 pending op 到达后定时一窗（对齐 ZCode scheduleFlush：单 timer）。"""
        if sub.flush_handle is not None:
            return
        loop = self._loop
        if loop is None or loop.is_closed():
            # 无事件循环可调度（测试/非 async 上下文）：同步 flush，保序不丢。
            self._flush_subscription(sub)
            return
        try:
            sub.flush_handle = loop.call_later(sub.flush_window_s(), self._flush_subscription, sub)
        except RuntimeError:
            self._flush_subscription(sub)

    def _cancel_flush(self, sub: _Subscription) -> None:
        if sub.flush_handle is not None:
            try:
                sub.flush_handle.cancel()
            except Exception:
                pass
            sub.flush_handle = None

    def _flush_subscription(self, sub: _Subscription) -> None:
        sub.flush_handle = None
        with self._write_lock:
            sess = self._sessions.get(sub.session_id)
            if sess is None:
                return
            if sub.overflowed:
                sub.overflowed = False
                sub.pending_ops = []
                sub.pending_bytes = 0
                self._enqueue_snapshot_locked(sub, sess, delivery_kind="recovery")
                logger.warning(
                    "[v4.flush] subscriber overflow -> recovery snapshot session=%s sub=%s seq=%d",
                    sess.session_id,
                    sub.subscription_id,
                    sess.seq,
                )
                return
            if not sub.pending_ops:
                return
            from_seq = sub.last_flushed_seq
            to_seq = sub.pending_ops[-1][0]
            raw_ops = len(sub.pending_ops)
            raw_bytes = sub.pending_bytes
            coalesced = coalesce_conversation_deltas([d for (_, d) in sub.pending_ops])
            sub.pending_ops = []
            sub.pending_bytes = 0
            sub.last_flushed_seq = to_seq
            frame = {
                "topic": sub.topic,
                "subscriptionId": sub.subscription_id,
                "fromSeq": from_seq,
                "toSeq": to_seq,
                "sentAt": int(time.time() * 1000),
                "payload": {"kind": "deltas", "deltas": coalesced},
            }
            sub.queue.append(self._wrap_wire(sub, frame, "online"))
            sub.delivered_seq = to_seq
        logger.info(
            "[v4.flush] session=%s sub=%s %d->%d ops=%d (raw=%d, %.1fKB) profile=%s",
            sess.session_id,
            sub.subscription_id,
            from_seq,
            to_seq,
            len(coalesced),
            raw_ops,
            raw_bytes / 1024.0,
            sub.profile,
        )

    # -- 帧构造 ---------------------------------------------------------------

    def _build_snapshot(self, sess: _SessionState) -> dict[str, Any]:
        rows = sorted(sess.rows.values(), key=lambda r: r["rowId"])
        window = self._snapshot_tail_window(rows)
        return {
            "protocolVersion": 1,
            "sessionId": sess.session_id,
            "logEpoch": sess.log_epoch,
            "seq": sess.seq,
            "revision": sess.revision,
            "control": sess.control(),
            "availability": _minimal_availability(),
            "inputRouting": sess.input_routing(),
            "meta": {
                "title": sess.title,
                "titleSource": "generated" if sess.title else "default",
            },
            "config": _minimal_config(sess.followup_mode),
            "modelTransition": None,
            "usage": _minimal_usage(),
            "queue": sess.queue_state(),
            "pendingInteractions": [],
            "pendingCommands": [],
            "backgroundWorks": [],
            "goal": None,
            "plan": None,
            "rows": {
                # 尾部窗口；更早行走 rows/range 游标补拉（rowsWindowSchema 截断语义）。
                "window": window,
                "totalCount": len(rows),
                "firstRowId": rows[0]["rowId"] if rows else None,
            },
        }

    @staticmethod
    def _snapshot_tail_window(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """快照 rows.window 截断：尾部 _SNAPSHOT_TAIL_ROWS 行，字节超限再对半收缩。

        字节只量 rows（快照壳为固定 KB 级）；预算收缩到下限后即使仍超限也照发——
        客户端 hasOlderRows/滚动补拉不依赖帧大小，单行爆帧只在日志暴露。
        """
        if len(rows) <= _SNAPSHOT_TAIL_ROWS:
            return rows
        take = _SNAPSHOT_TAIL_ROWS
        while True:
            window = rows[-take:]
            try:
                window_bytes = len(
                    json.dumps(window, ensure_ascii=False, separators=(",", ":"))
                )
            except (TypeError, ValueError):  # pragma: no cover - 行数据不可序列化
                return window
            if window_bytes <= _SNAPSHOT_MAX_BYTES or take <= _SNAPSHOT_MIN_TAIL_ROWS:
                if take < _SNAPSHOT_TAIL_ROWS:
                    logger.info(
                        "[v4.snapshot] byte-budget shrink window=%d rows=%.1fKB",
                        take,
                        window_bytes / 1024.0,
                    )
                return window
            take = max(_SNAPSHOT_MIN_TAIL_ROWS, take // 2)

    def _enqueue_snapshot_locked(
        self,
        sub: _Subscription,
        sess: _SessionState,
        *,
        delivery_kind: str,
    ) -> None:
        """调用方必须已持有 ``_write_lock``。"""
        snapshot = self._build_snapshot(sess)
        frame = {
            "topic": sub.topic,
            "subscriptionId": sub.subscription_id,
            "fromSeq": 0,
            "toSeq": sess.seq,
            "sentAt": int(time.time() * 1000),
            "payload": {"kind": "snapshot", "snapshot": snapshot},
        }
        sub.queue.append(self._wrap_wire(sub, frame, delivery_kind))
        sub.delivered_seq = sess.seq
        sub.last_flushed_seq = sess.seq
        logger.info(
            "[v4.flush] snapshot session=%s sub=%s seq=%d rows=%d kind=%s",
            sess.session_id,
            sub.subscription_id,
            sess.seq,
            len(snapshot["rows"]["window"]),
            delivery_kind,
        )

    def _wrap_wire(
        self,
        sub: _Subscription,
        frame: dict[str, Any],
        delivery_kind: str,
    ) -> dict[str, Any]:
        """包一层 ``ConversationTopicWireCandidate``。

        ``deliveryKind`` 必须是 ``initial``/``online``/``recovery`` 之一——
        assembler 的 parseDeliveryKind 对缺失/未知值直接打
        ``proto.frameAssemblyMetadataMismatch`` fault。
        """
        # 死订阅者保护：SSE 断开期间帧只进不出，队列无界增长会拖垮内存。
        # 超限丢弃全部积压帧、改发 recovery snapshot（对齐 ZCode「重放缓冲有界，
        # 越界主动断开走语义层恢复」的语义）。当前帧一并丢弃是安全的：
        # 快照的 seq 覆盖它携带的全部 delta。
        if len(sub.queue) >= 500:
            sub.queue.clear()
            sess = self._sessions.get(sub.session_id)
            if sess is not None:
                sub.logical_frame_ordinal += 1
                self._enqueue_snapshot_locked(sub, sess, delivery_kind="recovery")
                return sub.queue[-1]
        return {
            "wireVersion": V4_WIRE_PROTOCOL_VERSION,
            "kind": "complete",
            "deliveryKind": delivery_kind,
            "logicalFrameId": f"lf-{uuid.uuid4().hex[:12]}",
            "logicalFrameOrdinal": sub.next_ordinal(),
            "topic": sub.topic,
            "subscriptionId": sub.subscription_id,
            "frame": frame,
        }

    # -- 命令 -----------------------------------------------------------------
    # 对齐 ZCode v3.15.1 原生命令层（bootstrap/zcode-protocol-v4/command-inbox.ts +
    # commands/）：admission（幂等/CAS/串行）在 CommandInbox，决策在 handler 直驱
    # 会话态。语义基准见 docs/contribute/v3.15.1-port-plan.md §1。

    async def send_command(self, envelope: dict[str, Any]) -> dict[str, Any]:
        """``CommandEnvelope`` -> ``CommandAck``（含幂等重放/stale/noop 裁决）。"""
        self._capture_loop()
        outcome = await self._inbox.handle(envelope)
        if outcome.kind == "ack":
            assert outcome.ack is not None
            return outcome.ack
        env = outcome.envelope or {}
        ack = await self._execute_command(env, outcome)
        outcome.settle(ack)
        return ack

    async def _execute_command(
        self,
        env: dict[str, Any],
        outcome: Any,
    ) -> dict[str, Any]:
        # 让刚 create_task 的 turn task 先跑完 prologue（patch running + rows）：
        # 否则紧随其后的 stop 会取消一个从未启动的 task——协程体不执行，
        # interrupted 终态帧永远不会写（cancel-before-start 竞态）。
        await asyncio.sleep(0)
        command_id = str(env.get("commandId") or "")
        command_type = str(env.get("type") or "")
        session_id = str(env.get("sessionId") or "")
        payload = env.get("payload") or {}

        if command_type == "createSession":
            return self._handle_create_session(command_id, payload)

        sess = self._sessions.get(session_id)
        if sess is None:
            return self._reject(command_id, "sessionNotFound", f"unknown session {session_id}")

        if command_type in ("sendText",):
            return self._handle_send_text(sess, command_id, payload)
        if command_type in ("stop", "abort"):
            return self._handle_stop(sess, command_id)
        if command_type == "sendQueuedNow":
            return self._handle_send_queued_now(sess, command_id, payload)
        if command_type == "deleteQueueItem":
            return self._handle_delete_queue_item(sess, command_id, payload)
        if command_type == "editQueueItem":
            return self._handle_edit_queue_item(sess, command_id, payload)
        if command_type == "reorderQueueItem":
            return self._handle_reorder_queue_item(sess, command_id, payload)
        if command_type == "setAutoDrain":
            return self._handle_set_auto_drain(sess, command_id, payload)
        if command_type == "setFollowupMode":
            return self._handle_set_followup_mode(sess, command_id, payload)
        if command_type == "setAssistantFeedback":
            return self._handle_set_assistant_feedback(sess, command_id, payload)

        # 其余命令（fork/editUserQuery/retryTurn/compact/...）需 transcript 权威与
        # workspace rewind，单独批次实施；先显式拒绝（计划文档 §6）。
        return self._reject(command_id, "unsupportedCommand", f"{command_type} not implemented yet")

    # -- inbox host 面（CommandInboxHost）--------------------------------------

    def get_revision(self, session_id: str) -> int | None:
        sess = self._sessions.get(session_id)
        return None if sess is None else sess.revision

    def get_log_epoch(self, session_id: str) -> str | None:
        sess = self._sessions.get(session_id)
        return None if sess is None else sess.log_epoch

    # -- ack 工具 --------------------------------------------------------------

    def _accept(
        self,
        command_id: str,
        revision: int,
        result: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        ack: dict[str, Any] = {
            "commandId": command_id,
            "status": "accepted",
            "revisionAtDecision": revision,
        }
        if result is not None:
            ack["result"] = result
        return ack

    def _noop(self, command_id: str, reason: str) -> dict[str, Any]:
        return {
            "commandId": command_id,
            "status": "noop",
            "reasonCode": reason,
            "revisionAtDecision": 0,
        }

    def _reject(self, command_id: str, reason_code: str, message: str) -> dict[str, Any]:
        return {
            "commandId": command_id,
            "status": "rejected",
            "reasonCode": reason_code,
            "message": message,
            "revisionAtDecision": 0,
        }

    # -- sendText（requestedDelivery 路由：startNow / queue / guide）-----------

    def _handle_send_text(
        self,
        sess: _SessionState,
        command_id: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        text = str(payload.get("text") or "")
        if not text.strip():
            return self._reject(command_id, "emptyInput", "text is empty")
        requested = str(payload.get("requestedDelivery") or "").strip()

        if sess.turn_running():
            # running：requested 缺省按 followupMode 路由（queue=入队）；startNow 不抢占。
            route = requested or ("queue" if sess.followup_mode == "queue" else "startNow")
            if route == "startNow":
                return self._reject(command_id, "busy", "a turn is already running")
            item = self._build_queue_item(sess, command_id, text, route)
            sess.queue_items.append(item)
            sess.revision += 1
            ack = self._accept(
                command_id,
                sess.revision,
                result={
                    "type": "sendText",
                    "input": {"delivery": "queue", "inputId": item["queueItemId"]},
                },
            )
            self._inbox.pin_live_input(sess.session_id, command_id, ack)
            self._emit_queue_patch(sess)
            return ack

        # 空闲：queue/guide 空队列无入队意义，直接开 turn（对齐 CLI：空队列提升为立即执行）。
        if not sess.title:
            sess.title = text[:24]
        sess.revision += 1
        self._start_turn(sess, text)
        return self._accept(
            command_id,
            sess.revision,
            result={"type": "sendText", "input": {"delivery": "startNow", "inputId": command_id}},
        )

    def _build_queue_item(
        self,
        sess: _SessionState,
        command_id: str,
        text: str,
        requested: str,
    ) -> dict[str, Any]:
        """QueueItem intent（形状 = vendored ``queueItemSchema``，strict）。"""
        sess._queue_admission_seq += 1
        return {
            "sourceCommandId": command_id,
            "queueItemId": f"queue_{command_id}",
            "clientId": "evoflow-shell",
            "kind": "sendText",
            "text": text,
            "attachments": [],
            "delivery": {"requested": requested, "admitted": "queue"},
            "order": {
                "admissionSeq": sess._queue_admission_seq,
                "queuePosition": len(sess.queue_items),
            },
            "steer": {"state": "notRequested"},
            "dispatch": {"state": "queued"},
            "admittedAt": int(time.time() * 1000),
        }

    def _emit_queue_patch(self, sess: _SessionState) -> None:
        self.author_state_patch(sess.session_id, {"queue": sess.queue_state()})

    # -- stop / abort ----------------------------------------------------------

    def _handle_stop(self, sess: _SessionState, command_id: str) -> dict[str, Any]:
        if not sess.turn_running():
            return self._noop(command_id, "noRunningTurn")
        # 对齐 queueStateSchema 注释：stop 后 autoDrain=False（暂停队列），setAutoDrain 恢复。
        sess.auto_drain = False
        sess.pause_reason = "stopped"
        task = sess.turn_task
        assert task is not None
        task.cancel()
        sess.revision += 1
        return self._accept(command_id, sess.revision)

    # -- queue 命令组（对齐 commands/handlers/queue.ts 语义）--------------------

    def _find_queue_item(self, sess: _SessionState, queue_item_id: str) -> dict[str, Any] | None:
        return next(
            (i for i in sess.queue_items if i["queueItemId"] == queue_item_id), None
        )

    def _handle_send_queued_now(
        self,
        sess: _SessionState,
        command_id: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        # idle 才提升（对齐 guard.queuePromotionBusy：running 时拒绝，避免抢占竞态）。
        if sess.turn_running():
            return self._reject(
                command_id, "guard.queuePromotionBusy", "a turn is already running"
            )
        queue_item_id = str(payload.get("queueItemId") or "")
        item = self._find_queue_item(sess, queue_item_id)
        if item is None:
            return self._reject(command_id, "queue.itemMissing", f"unknown queue item {queue_item_id}")
        if item.get("kind") == "compact":
            return self._reject(command_id, "guard.queueItemNotEditable", "compact item not supported yet")
        sess.queue_items.remove(item)
        sess.revision += 1
        self._inbox.release_live_input(sess.session_id, str(item["sourceCommandId"]))
        if not sess.title:
            sess.title = item["text"][:24]
        self._start_turn(sess, str(item["text"]))
        self._emit_queue_patch(sess)
        return self._accept(command_id, sess.revision)

    def _handle_delete_queue_item(
        self,
        sess: _SessionState,
        command_id: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        queue_item_id = str(payload.get("queueItemId") or "")
        item = self._find_queue_item(sess, queue_item_id)
        if item is None:
            # 未命中（并发 drain/重复删除竞态）= noop，不算失败（对齐 V4CommandNoopError）。
            return self._noop(command_id, "queue.itemMissing")
        sess.queue_items.remove(item)
        sess.revision += 1
        self._inbox.release_live_input(sess.session_id, str(item["sourceCommandId"]))
        self._emit_queue_patch(sess)
        return self._accept(command_id, sess.revision)

    def _handle_edit_queue_item(
        self,
        sess: _SessionState,
        command_id: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        queue_item_id = str(payload.get("queueItemId") or "")
        item = self._find_queue_item(sess, queue_item_id)
        if item is None:
            return self._noop(command_id, "queue.itemMissing")
        if item.get("kind") == "compact":
            # compact 是 typed maintenance intent；允许改文本会把它伪装成普通输入。
            return self._reject(
                command_id, "guard.queueItemNotEditable", f"queue item not editable: {queue_item_id}"
            )
        new_text = str(payload.get("newText") or "")
        if not new_text.strip():
            return self._reject(command_id, "emptyInput", "newText is empty")
        item["text"] = new_text
        sess.revision += 1
        self._emit_queue_patch(sess)
        return self._accept(command_id, sess.revision)

    def _handle_reorder_queue_item(
        self,
        sess: _SessionState,
        command_id: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        queue_item_id = str(payload.get("queueItemId") or "")
        before_id = payload.get("beforeQueueItemId")
        item = self._find_queue_item(sess, queue_item_id)
        if item is None:
            return self._noop(command_id, "queue.itemMissing")
        sess.queue_items.remove(item)
        if before_id is None:
            sess.queue_items.append(item)  # null → 移到队尾（协议与上游同形）
        else:
            before = self._find_queue_item(sess, str(before_id))
            index = sess.queue_items.index(before) if before is not None else len(sess.queue_items)
            sess.queue_items.insert(index, item)
        sess.revision += 1
        self._emit_queue_patch(sess)
        return self._accept(command_id, sess.revision)

    def _handle_set_auto_drain(
        self,
        sess: _SessionState,
        command_id: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        sess.auto_drain = bool(payload.get("autoDrain"))
        sess.pause_reason = None if sess.auto_drain else sess.pause_reason or "manual"
        sess.revision += 1
        self._emit_queue_patch(sess)
        # 不能只翻授权位：idle 暂停队列没有 active turn 可替它启动队首（对齐上游注释）。
        self._maybe_auto_drain(sess, force=True)
        return self._accept(command_id, sess.revision)

    def _handle_set_followup_mode(
        self,
        sess: _SessionState,
        command_id: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        mode = str(payload.get("mode") or "").strip()
        if mode:
            sess.followup_mode = mode
            sess.revision += 1
            self.author_state_patch(sess.session_id, {"config": _minimal_config(mode)})
        return self._accept(command_id, sess.revision)

    def _handle_set_assistant_feedback(
        self,
        sess: _SessionState,
        command_id: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        target = payload.get("target") if isinstance(payload.get("target"), dict) else {}
        entity_id = str(target.get("rowId") or target.get("messageId") or "")
        feedback = payload.get("feedback")
        if feedback is None:
            sess.feedbacks.pop(entity_id, None)
        else:
            sess.feedbacks[entity_id] = str(feedback)
        sess.revision += 1
        # 持久化 transcript metadata 属批次二（计划文档 §1）；v1 shell 内存记录。
        return self._accept(command_id, sess.revision)

    # -- 自动 drain（对齐 queue-auto-drain：idle 且授权时提升队首）--------------

    def _maybe_auto_drain(self, sess: _SessionState, *, force: bool = False) -> None:
        if not sess.auto_drain or not sess.queue_items:
            return
        if sess.turn_running():
            return
        # 失败/interrupted 后不自动续跑：避免错误循环；用户 setAutoDrain/发送恢复。
        # force=True（显式 setAutoDrain）绕过该防护——用户主动恢复即意图明确。
        if not force and sess.phase in (_PHASE_ERROR, _PHASE_INTERRUPTED):
            return
        item = sess.queue_items.pop(0)
        self._inbox.release_live_input(sess.session_id, str(item["sourceCommandId"]))
        if not sess.title:
            sess.title = str(item["text"])[:24]
        self._emit_queue_patch(sess)
        self._start_turn(sess, str(item["text"]))

    def _handle_create_session(self, command_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        sess = self._get_or_create_session()
        first_input = payload.get("firstInput") or {}
        text = str(first_input.get("text", ""))
        if text and not sess.title:
            sess.title = text[:24]
        sess.revision += 1
        revision = sess.revision
        if text:
            self._start_turn(sess, text)
        ack: dict[str, Any] = {
            "commandId": command_id,
            "status": "accepted",
            "revisionAtDecision": revision,
            "result": {
                "type": "createSession",
                "sessionId": sess.session_id,
                "input": (
                    {
                        "delivery": "startNow",
                        "inputId": f"input-{uuid.uuid4().hex[:8]}",
                    }
                    if text
                    else None
                ),
            },
        }
        return ack

    def _reject(self, command_id: str, reason_code: str, message: str) -> dict[str, Any]:
        return {
            "commandId": command_id,
            "status": "rejected",
            "reasonCode": reason_code,
            "message": message,
            "revisionAtDecision": 0,
        }

    # -- 回合执行（echo / 真实 LLM，复用 H1 demo 语义；走 authoring API）-----------

    def _start_turn(self, sess: _SessionState, text: str) -> None:
        self._capture_loop()
        sess.turn_task = asyncio.create_task(self._run_turn(sess, text))

    def _append_row(self, sess: _SessionState, row: dict[str, Any]) -> None:
        self.author_append_row(sess.session_id, row)

    def _append_text_delta(self, sess: _SessionState, row_id: int, path: str, chunk: str) -> None:
        if not chunk:
            return
        # 权威行文本同步维护：快照/interrupted 终态帧携带完整已流式文本，
        # 否则 row.upserted（整行替换）会用过期 text 抹掉投影里的流式内容。
        if path == "text":
            with self._write_lock:
                row = sess.rows.get(int(row_id))
                if row is not None:
                    row["text"] = str(row.get("text") or "") + chunk
        self.author_row_delta(sess.session_id, row_id, path, chunk)

    def _upsert_row(self, sess: _SessionState, row: dict[str, Any]) -> None:
        self.author_upsert_row(sess.session_id, row)

    def _patch_phase(self, sess: _SessionState, phase: str) -> None:
        self.patch_phase(sess.session_id, phase)

    async def _run_turn(self, sess: _SessionState, text: str) -> None:
        now_ms = int(time.time() * 1000)
        turn_id = f"turn-{uuid.uuid4().hex[:10]}"
        header_rid = sess.next_row_id
        sess.next_row_id += 1
        user_rid = sess.next_row_id
        sess.next_row_id += 1
        assistant_rid = sess.next_row_id
        sess.next_row_id += 1

        try:
            self._patch_phase(sess, _PHASE_RUNNING)
            self._append_row(
                sess,
                {
                    "kind": "turnHeader",
                    "rowId": header_rid,
                    "turnId": turn_id,
                    "createdAt": now_ms,
                    "createdAtSeq": sess.seq,
                    "origin": "userInput",
                    "state": "running",
                    "startedAt": now_ms,
                },
            )
            self._append_row(
                sess,
                {
                    "kind": "userInput",
                    "rowId": user_rid,
                    "turnId": turn_id,
                    "createdAt": now_ms,
                    "createdAtSeq": sess.seq,
                    "text": text,
                    "origin": "realUser",
                },
            )
            self._append_row(
                sess,
                {
                    "kind": "assistantText",
                    "rowId": assistant_rid,
                    "turnId": turn_id,
                    "createdAt": now_ms,
                    "createdAtSeq": sess.seq,
                    "text": "",
                    "state": "streaming",
                },
            )

            final_text = await self._generate(sess, text, assistant_rid)

            self._upsert_row(
                sess,
                {
                    "kind": "assistantText",
                    "rowId": assistant_rid,
                    "turnId": turn_id,
                    "createdAt": now_ms,
                    "createdAtSeq": sess.seq,
                    "text": final_text,
                    "state": "complete",
                },
            )
            self._upsert_row(
                sess,
                {
                    "kind": "turnHeader",
                    "rowId": header_rid,
                    "turnId": turn_id,
                    "createdAt": now_ms,
                    "createdAtSeq": sess.seq,
                    "origin": "userInput",
                    "state": "completedSuccess",
                    "startedAt": now_ms,
                    "endedAt": int(time.time() * 1000),
                },
            )
            self._patch_phase(sess, _PHASE_COMPLETED)
        except asyncio.CancelledError:
            # stop/abort：收敛为 interrupted 终态帧（对齐 T2 契约：turnHeader
            # completedInterrupted + assistantText interrupted + phase 同步）。
            # 吞掉取消让 task 正常收尾；auto-drain 由 finally 按 auto_drain=False 跳过。
            ended_ms = int(time.time() * 1000)
            streamed_text = str(sess.rows.get(assistant_rid, {}).get("text") or "")
            self._upsert_row(
                sess,
                {
                    "kind": "assistantText",
                    "rowId": assistant_rid,
                    "turnId": turn_id,
                    "createdAt": now_ms,
                    "createdAtSeq": sess.seq,
                    "text": streamed_text,
                    "state": "interrupted",
                },
            )
            self._upsert_row(
                sess,
                {
                    "kind": "turnHeader",
                    "rowId": header_rid,
                    "turnId": turn_id,
                    "createdAt": now_ms,
                    "createdAtSeq": sess.seq,
                    "origin": "userInput",
                    "state": _PHASE_INTERRUPTED,
                    "startedAt": now_ms,
                    "endedAt": ended_ms,
                },
            )
            self._patch_phase(sess, _PHASE_INTERRUPTED)
        except Exception as exc:  # noqa: BLE001 — 回合失败必须收敛为终态帧
            logger.exception("[v4-conversation] turn failed session=%s", sess.session_id)
            self._patch_phase(sess, _PHASE_ERROR)
            self._upsert_row(
                sess,
                {
                    "kind": "assistantText",
                    "rowId": assistant_rid,
                    "turnId": turn_id,
                    "createdAt": now_ms,
                    "createdAtSeq": sess.seq,
                    "text": f"(turn failed: {exc})",
                    "state": "interrupted",
                },
            )
        finally:
            # 归还 turn 所有权：finally 执行时 task 尚未标记 done，turn_running()
            # 会把自己误判为运行中，导致 auto-drain 永远不触发。
            if sess.turn_task is asyncio.current_task():
                sess.turn_task = None
            # 自然完成且 auto_drain 授权时提升队首（对齐 queue-auto-drain 语义；
            # stop/失败/interrupted 路径由各自的状态守卫跳过）。
            self._maybe_auto_drain(sess)

    async def _generate(self, sess: _SessionState, text: str, assistant_rid: int) -> str:
        """echo 或真实 LLM（``EVOFLOW_V4_LLM=1`` + ``EVOFLOW_LLM_BASE_URL``）。"""
        if os.getenv("EVOFLOW_V4_LLM", "").strip() not in ("1", "true", "yes"):
            target = (
                f"Echo from EvoFlow v4 shell: 我收到了「{text}」。"
                "这是 EvoFlow v4 协议链路（wire v3 → topicWireDecoder → projection store）。"
            )
            # chunk 64 字符 / 8ms = ~8KB/s，肉眼跟得上但不耗 CPU。
            for i in range(0, len(target), 64):
                self._append_text_delta(sess, assistant_rid, "text", target[i : i + 64])
                await asyncio.sleep(0.02)
            return target

        import httpx  # 局部 import 避免硬依赖

        base_url = os.getenv("EVOFLOW_LLM_BASE_URL", "").rstrip("/")
        if not base_url:
            return "EVOFLOW_V4_LLM=1 但 EVOFLOW_LLM_BASE_URL 未设置 — 退回 echo。"
        headers: dict[str, str] = {"Content-Type": "application/json"}
        api_key = os.getenv("EVOFLOW_LLM_API_KEY", "").strip()
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        payload = {
            "model": os.getenv("EVOFLOW_LLM_MODEL", "echo-model"),
            "messages": [{"role": "user", "content": text}],
            "stream": True,
            "temperature": 0.7,
        }
        buf = ""
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(120.0)) as client:
                async with client.stream(
                    "POST", f"{base_url}/chat/completions", json=payload, headers=headers
                ) as resp:
                    resp.raise_for_status()
                    async for line in resp.aiter_lines():
                        if not line or not line.startswith("data:"):
                            continue
                        data = line[5:].strip()
                        if data == "[DONE]":
                            break
                        try:
                            obj = json.loads(data)
                        except Exception:
                            continue
                        delta = (
                            obj.get("choices", [{}])[0].get("delta", {}).get("content") or ""
                        )
                        if delta:
                            buf += delta
                            self._append_text_delta(sess, assistant_rid, "text", delta)
        except Exception as exc:  # noqa: BLE001
            logger.warning("[v4-conversation] LLM failed, fallback echo: %s", exc)
            return f"⚠️ LLM 不可达，退回 echo：{text}"
        return buf or "(no content)"


# 单例
HUB = V4ConversationHub()
