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

# Cap concurrent cold hydrates. Hover-warm + multi-click used to pile 3×
# multi-second transcript rebuilds and starve subscribe/health (2026-11-10
# 12:54: event_loop_lag 21s + subscribe 7–9s). Override with
# EVOFLOW_V4_HYDRATE_CONCURRENCY (1–4).
#
# Priority gate: user open (intent=open) jumps ahead of prefetch/hover warm
# so "two chats running → click another stuck connecting" stops being FIFO.
_hydrate_gate: _HydratePriorityGate | None = None


def _hydrate_concurrency_limit() -> int:
    # 默认 2：两路点击 hydrate 可并行（快速连点两个会话不再排队等前一路完成）。
    # 预热侧由 _pump 限制为最多 1 路并发——「parallel hover-warm contended SQLite」
    # 的教训针对的是无上限的 hover warm，不是有界的点击并发。
    raw = (os.environ.get("EVOFLOW_V4_HYDRATE_CONCURRENCY") or "2").strip()
    try:
        n = int(raw)
    except ValueError:
        n = 2
    return max(1, min(n, 4))


class _HydratePriorityGate:
    """Async hydrate slots with interactive-before-prefetch ordering."""

    def __init__(self, limit: int) -> None:
        self._limit = max(1, int(limit))
        self._active = 0
        self._hi: list[asyncio.Future[None]] = []
        self._lo: list[asyncio.Future[None]] = []

    def _pump(self) -> None:
        while self._active < self._limit:
            fut: asyncio.Future[None] | None = None
            while self._hi and fut is None:
                candidate = self._hi.pop(0)
                if not candidate.done():
                    fut = candidate
            if fut is None:
                # 预热只在「无点击等待」时启动，且 limit>1 时最多占 limit-1 个槽，
                # 永远给点击留一个空槽：旧行为会把所有槽填满 hover warm，点击 hydrate
                # 仍要等一轮预热做完，表现为「点了没反应」。预热慢一点无妨（后台）。
                # limit=1 退化为旧语义：有点击等待就不启动预热（排队次序仍点击优先）。
                if self._hi:
                    return
                if self._limit > 1 and self._active >= self._limit - 1:
                    return
                while self._lo and fut is None:
                    candidate = self._lo.pop(0)
                    if not candidate.done():
                        fut = candidate
                if fut is None:
                    return
            self._active += 1
            fut.set_result(None)

    async def acquire(self, *, high_priority: bool) -> None:
        loop = asyncio.get_running_loop()
        fut: asyncio.Future[None] = loop.create_future()
        bucket = self._hi if high_priority else self._lo
        bucket.append(fut)
        self._pump()
        try:
            await fut
        except asyncio.CancelledError:
            if fut in bucket:
                bucket.remove(fut)
            if not fut.done():
                fut.cancel()
            raise

    def release(self) -> None:
        self._active = max(0, self._active - 1)
        self._pump()


def _get_hydrate_gate() -> _HydratePriorityGate:
    global _hydrate_gate
    if _hydrate_gate is None:
        _hydrate_gate = _HydratePriorityGate(_hydrate_concurrency_limit())
    return _hydrate_gate


class _hydrate_slot:
    """Async context manager around the priority hydrate gate."""

    def __init__(self, *, high_priority: bool) -> None:
        self._high = high_priority
        self._gate = _get_hydrate_gate()

    async def __aenter__(self) -> _hydrate_slot:
        await self._gate.acquire(high_priority=self._high)
        return self

    async def __aexit__(self, exc_type: object, exc: object, tb: object) -> None:
        self._gate.release()

_PHASE_DRAFT = "draft"
_PHASE_RUNNING = "running"
_PHASE_COMPLETED = "completedSuccess"
_PHASE_ERROR = "error"
_PHASE_INTERRUPTED = "completedInterrupted"

# DB run_status（session_run_state 终态集合）→ hub phase。running/pending/未知
# 一律映射为空串 = 「不收口」（证据不足时保守维持现状）。
_RUN_STATUS_TO_PHASE: dict[str, str] = {
    "done": _PHASE_COMPLETED,
    "success": _PHASE_COMPLETED,
    "completed": _PHASE_COMPLETED,
    "idle": _PHASE_COMPLETED,
    "fail": _PHASE_ERROR,
    "error": _PHASE_ERROR,
    "cancelled": _PHASE_INTERRUPTED,
    "stopped": _PHASE_INTERRUPTED,
}


def _phase_for_run_status(status: str) -> str:
    return _RUN_STATUS_TO_PHASE.get(str(status or "").strip().lower(), "")

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


def _minimal_control(phase: str, *, run_started_at: int | None = None) -> dict[str, Any]:
    """ZCode ``sessionControlSchema`` 语义的最小实现（键级整体替换）。

    - sessionEnded 仅成功/中断终态为 True；error 可重试不算 ended
      （对齐 ZCode product-projection onTurnComplete vs onTurnError 的差异）。
    - running 时 activeWorks 携带 primaryTurn（startedAt 由调用方供给），
      fallback 快照（无 override）也能驱动前端 control-first 判定。
    """
    running = phase == _PHASE_RUNNING
    return {
        "phase": phase,
        "sessionEnded": phase in (_PHASE_COMPLETED, _PHASE_INTERRUPTED),
        "canStop": running,
        "stopState": "stoppable" if running else "idle",
        "stopTargetKind": "assistant",
        "activeWorks": (
            [{"kind": "primaryTurn", "startedAt": int(run_started_at or 0)}] if running else []
        ),
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
    """Observer catchup：上次 force-rehydrate 的 transcript 指纹（条数+尾消息）。"""
    catchup_fp: str = ""
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
    # ZCode workflowRuns 投影（EvoFlow：由 collab 任务映射；进 snapshot / journal 查询）
    workflow_runs: list[dict[str, Any]] = field(default_factory=list)
    workflow_runs_revision: int = 0
    # 会话用量（快照路径从 DB rollup 建；mirror 轮末在此基础上累加并发 usage 增量）。
    usage_state: dict[str, Any] | None = None
    # ── control 真值（ZCode 语义：snapshot 与增量同源）────────────────────────
    control_override: dict[str, Any] | None = None
    """mirror / hydrate 复原写入的权威 control（键级整体替换）。

    只发增量不落态的旧实现会在快照重建（刷新重订阅 / recovery / 溢出转
    snapshot）时被 ``_minimal_control(sess.phase)`` 重算覆盖——主聊 sess.phase
    停在 draft，快照 control 永远 draft+canStop:false。存会话态后 ``_build_snapshot``
    直接采用，任何订阅者看到的 control 与在线 delta 一致。
    patch_phase（hub 自跑 turn 接管执行权）时清空：谁拥有当前执行，谁写 control。"""
    run_started_at: int | None = None
    """当前 primaryTurn startedAt（patch_phase(running) 记录；fallback activeWorks 用）。"""
    last_author_at_ms: float = 0.0
    """最近一次本会话被写（行/增量/state patch）的墙钟。

    catchup / 终态收口用「静默期」判定当前是否仍有活写手（live 流/镜像写行很
    频繁）；没有 mirror 标志的后台写手（attach 喂流除外）也会经过 author_deltas。"""

    def control(self) -> dict[str, Any]:
        return _minimal_control(self.phase, run_started_at=self.run_started_at)

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
        # 同会话双订阅冷开曾并行 hydrate+durable（8e4715ba：3764+3745 双份尾差）。
        self._cold_hydrate_locks: dict[str, asyncio.Lock] = {}

    def _cold_hydrate_lock(self, session_id: str) -> asyncio.Lock:
        lock = self._cold_hydrate_locks.get(session_id)
        if lock is None:
            lock = asyncio.Lock()
            self._cold_hydrate_locks[session_id] = lock
        return lock

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

    def broadcast_recovery_snapshot(self, session_id: str) -> int:
        """向该 session 全部订阅者重投 recovery snapshot。返回通知的订阅数。"""
        tid = str(session_id or "").strip()
        if not tid:
            return 0
        with self._write_lock:
            sess = self._sessions.get(tid)
            if sess is None:
                return 0
            n = 0
            for sub in self._subscriptions.values():
                if sub.session_id != tid:
                    continue
                sub.logical_frame_ordinal += 1
                self._cancel_flush(sub)
                sub.pending_ops = []
                sub.pending_bytes = 0
                sub.overflowed = False
                self._enqueue_snapshot_locked(sub, sess, delivery_kind="recovery")
                n += 1
            return n

    def clear_projection_for_rehydrate(self, session_id: str) -> None:
        """清空行与 delta 日志并 bump log_epoch，供 force rehydrate。保留 seq 单调。"""
        tid = str(session_id or "").strip()
        if not tid:
            return
        with self._write_lock:
            sess = self._get_or_create_session(tid)
            sess.rows.clear()
            sess.delta_log.clear()
            sess.delta_log_floor = max(sess.delta_log_floor, sess.seq)
            sess.next_row_id = 1
            sess.catchup_fp = ""
            # 陈旧 override 一并清：wipe 后 hydrate 重新探测 run 状态，仍 running
            # 会重写（hydration._probe_running_run）；不clear 会把已终态的旧
            # override 留给快照重建，前端停止键/齿轮被死钉。
            sess.control_override = None
            sess.run_started_at = None
            try:
                sess.log_epoch = str(int(str(sess.log_epoch).strip() or "1") + 1)
            except ValueError:
                sess.log_epoch = f"{sess.log_epoch}+r"

    @staticmethod
    def _hub_tip_row_id(sess: "_SessionState") -> int | None:
        tip = 0
        for key, row in (sess.rows or {}).items():
            try:
                rid = int(row.get("rowId") if isinstance(row, dict) else key)
            except (TypeError, ValueError):
                continue
            if rid > tip:
                tip = rid
        return tip or None

    def _subscriber_count(self, session_id: str) -> int:
        tid = str(session_id or "").strip()
        if not tid:
            return 0
        return sum(1 for s in self._subscriptions.values() if s.session_id == tid)

    def _catchup_meta(self, sess: "_SessionState", **extra: Any) -> dict[str, Any]:
        """统一带 tipRowId / logEpoch / subscriberCount，方便 FE 根因对账。"""
        out = dict(extra)
        out.setdefault("rows", len(sess.rows) if sess.rows else 0)
        out.setdefault("logEpoch", sess.log_epoch)
        out.setdefault("tipRowId", self._hub_tip_row_id(sess))
        # 无论是否 broadcast：面板要能看见「hub 上这会话有没有活订阅」。
        # notified=0 + subscriberCount=0 → 根因是无订户，不是 catchup 逻辑本身。
        out.setdefault("subscriberCount", self._subscriber_count(sess.session_id))
        return out

    def catchup_from_transcript(
        self,
        session_id: str,
        *,
        prefer_settle_only: bool = False,
        client_tip_row_id: int | None = None,
        client_log_epoch: str | None = None,
    ) -> dict[str, Any]:
        """飞书/IM 旁观：用 DB transcript 强制重建投影（hydrate 仅空 session 时会跳过）。

        - 指纹未变 → no-op（避免无意义闪烁）
        - 频道 live mirror 本轮仍在写 → 禁止 wipe（否则 240 行 live 被打回 ~130 行 DB）
        - ``prefer_settle_only``：客户端已有投影（切回校准）时只 settle phase / 更新指纹，
          禁止 ``clear_projection_for_rehydrate``（对齐 ZCode：有投影继续显示）。
        - ``client_tip_row_id`` / ``client_log_epoch``：FE 本机 tip；若高于 hub tip 或
          epoch 不一致，说明客户端错过了 recovery（现场 tip=2055 vs hub=2042），
          再广播一次 recovery 让 FE 收敛，不必整页 wipe。
        """
        tid = str(session_id or "").strip()
        if not tid or tid.startswith("v4-"):
            return {"ok": False, "changed": False, "reason": "bad-session-id"}
        try:
            from app.gateway.v4.agui_mirror import mirror_thread_is_live
            from app.gateway.v4.hydration import (
                force_rehydrate_session_from_transcript,
                read_run_status_row,
                transcript_fingerprint_for_thread,
            )
        except Exception as exc:
            logger.exception("[v4.catchup] import failed session=%s", tid)
            return {"ok": False, "changed": False, "reason": str(exc)}

        sess = self._get_or_create_session(tid)
        try:
            fp = transcript_fingerprint_for_thread(tid)
        except Exception:
            logger.exception("[v4.catchup] fingerprint failed session=%s", tid)
            return {"ok": False, "changed": False, "reason": "fingerprint-failed"}

        # ── 活写手判定 + 陈旧 running / draft+inflight 收口 ──────────────
        # mirror 标志是「有活写手」的权威信号，必须先判：mirror 活着 = 本轮
        # 真有流在喂投影，phase/收口都归它管，下面一切修复都不许碰。
        mirror_live = mirror_thread_is_live(tid)

        # 员工/后台 run 无 mirror 喂流：run 终态后没有任何组件写 control/phase，
        # 投影被死钉在 running（2026-11-15 实锤：任务 12:26 已 finalize，用户
        # 13:28 还在对它点停止）。唯一可靠证据是 DB run_status；「running 且
        # 超窗疑似 zombie」在这条路径上不收口，交 zombie sweeper。
        #
        # 另：压缩/remint 后常见 phase=draft + canStop=false，但 tip 仍留
        # streaming「正在思考」/ running turnHeader（94b4bc83：DB done、面板
        # 已工作 2h+）。前端 draft 分支走行扫描 heuristic → sessionBusy 钉死，
        # 展示层 seal 永不触发。DB 终态 + 有 inflight 时也必须 settle。
        settled_phase = ""
        phase_now = str(sess.phase or "").strip()
        override_phase = str((sess.control_override or {}).get("phase") or "").strip()
        inflight_rows = bool(sess.rows) and self._rows_have_inflight(list(sess.rows.values()))
        phase_is_running = _PHASE_RUNNING in (phase_now, override_phase)
        phase_already_terminal = phase_now in (
            _PHASE_COMPLETED,
            _PHASE_ERROR,
            _PHASE_INTERRUPTED,
        ) or override_phase in (
            _PHASE_COMPLETED,
            _PHASE_ERROR,
            _PHASE_INTERRUPTED,
        )
        if not mirror_live:
            run_status = str((read_run_status_row(tid) or {}).get("status") or "").strip().lower()
            mapped = _phase_for_run_status(run_status)
            # 工具授权闸仍 pending 时 DB 常被标 done/idle；不得把投影收成 completedSuccess，
            # 否则页面像「自己停了」、待批工具卡被误当成终态。
            if mapped == _PHASE_COMPLETED:
                try:
                    from evoflow.agents.tool_approval_service import thread_has_pending_approvals

                    if thread_has_pending_approvals(tid):
                        mapped = ""
                        logger.info(
                            "[v4.catchup] skip settle: pending tool approval session=%s db_status=%s",
                            tid,
                            run_status,
                        )
                except Exception:
                    logger.debug(
                        "[v4.catchup] pending-approval check failed session=%s",
                        tid,
                        exc_info=True,
                    )
            if mapped and (
                phase_is_running
                or inflight_rows
                or not phase_already_terminal
            ):
                if not phase_already_terminal:
                    self.patch_phase(tid, mapped)
                    settled_phase = mapped
                    logger.info(
                        "[v4.catchup] stale running settled session=%s db_status=%s phase=%s "
                        "was_running=%s inflight=%s",
                        tid,
                        run_status,
                        mapped,
                        phase_is_running,
                        inflight_rows,
                    )
                # 终态 phase 仍可能残留 streaming tip（heal 旧逻辑只扫终态头下的行）。
                # DB 终态时无条件补封，避免「phase 已 completed 但面板仍正在思考」。
                try:
                    from app.gateway.v4.agui_mirror import mirror_heal_stale_inflight_rows

                    healed_n = mirror_heal_stale_inflight_rows(tid)
                    if healed_n and not settled_phase:
                        logger.info(
                            "[v4.catchup] healed stale inflight session=%s rows=%s "
                            "phase=%s inflight=%s",
                            tid,
                            healed_n,
                            phase_now or override_phase or "-",
                            inflight_rows,
                        )
                except Exception:
                    logger.debug(
                        "[v4.catchup] heal after settle failed session=%s",
                        tid,
                        exc_info=True,
                    )
            # run_status 仍 running/pending：后台 run 真在跑且无 mirror——DB
            # transcript 是唯一真源，继续放行下面的 rehydrate（否则「盯着看」
            # 也冻结）。status 空/未知：不动 control，由 shrink 守卫兜底。

        # 仅当指纹未变（本应 no-op）但 tip 已与库尾脱节时强制重灌。
        # 394bc37f：DB tip=「两条都通了」，面板 tip=旧 run cancelled bash；
        # fingerprint-unchanged + refuse-shrink 会把错误的「更胖」live tip 钉死。
        # 指纹本身在变时走原有 rehydrate / settle-only / refuse-shrink 语义，不抢道。
        tip_mismatch = bool(
            sess.rows
            and fp
            and sess.catchup_fp == fp
            and not self._projection_tip_matches_fingerprint(sess, fp)
        )
        if tip_mismatch:
            logger.warning(
                "[v4.catchup] tip mismatch vs transcript fingerprint session=%s "
                "rows=%s fp=%s — force rehydrate",
                tid,
                len(sess.rows),
                fp,
            )

        if fp and sess.catchup_fp == fp and sess.rows and not tip_mismatch:
            hub_tip = self._hub_tip_row_id(sess)
            client_tip = None
            try:
                if client_tip_row_id is not None:
                    client_tip = int(client_tip_row_id)
            except (TypeError, ValueError):
                client_tip = None
            client_epoch = str(client_log_epoch or "").strip() or None
            hub_epoch = str(sess.log_epoch or "").strip() or None
            # 本机 tip 高于 hub：错过 recovery 的幽灵膨胀（2055 vs 2042）。
            # 本机 tip 低于 hub：live mirror 已写行但 frames 没送到页面（19:11 现场：
            # AG-UI 在跑、v4行钉死 2041、streamMax=∅）——fingerprint 未变也会
            # 一直 no-op，必须再广播 recovery。
            tip_diverged = bool(
                sess.rows
                and client_tip is not None
                and hub_tip is not None
                and client_tip != hub_tip
            )
            epoch_diverged = bool(
                tip_diverged
                and client_epoch
                and hub_epoch
                and client_epoch != hub_epoch
            )
            client_ahead = bool(
                tip_diverged and client_tip is not None and hub_tip is not None and client_tip > hub_tip
            )
            client_behind = bool(
                tip_diverged and client_tip is not None and hub_tip is not None and client_tip < hub_tip
            )
            if client_ahead or client_behind or epoch_diverged:
                notified = self.broadcast_recovery_snapshot(tid)
                reason = (
                    "client-stale-resync"
                    if client_ahead or (epoch_diverged and not client_behind)
                    else "client-behind-resync"
                )
                logger.warning(
                    "[v4.catchup] %s session=%s client_tip=%s hub_tip=%s "
                    "client_epoch=%s hub_epoch=%s notified=%s",
                    reason,
                    tid,
                    client_tip,
                    hub_tip,
                    client_epoch,
                    hub_epoch,
                    notified,
                )
                return self._catchup_meta(
                    sess,
                    ok=True,
                    changed=True,
                    reason=reason,
                    notified=notified,
                    settledPhase=settled_phase or None,
                    fingerprint=fp,
                    clientTipRowId=client_tip,
                )
            return self._catchup_meta(
                sess,
                ok=True,
                changed=False,
                reason="fingerprint-unchanged",
                settledPhase=settled_phase or None,
                fingerprint=fp,
            )

        # Same msg count + id, only tail content_len grew → DB streaming catch-up.
        # Full rehydrate every ~1.5s would flicker; advance fp and leave projection.
        if fp and sess.catchup_fp and sess.rows and not tip_mismatch:
            old_p = str(sess.catchup_fp).split(":")
            new_p = str(fp).split(":")
            if (
                len(old_p) >= 3
                and len(new_p) >= 3
                and old_p[0] == new_p[0]
                and old_p[1] == new_p[1]
            ):
                sess.catchup_fp = fp
                return self._catchup_meta(
                    sess,
                    ok=True,
                    changed=False,
                    reason="tail-growing",
                    settledPhase=settled_phase or None,
                    fingerprint=fp,
                )

        # Live channel/AG-UI mirror owns the projection for this turn — wiping
        # replaces a rich live snapshot with a lagging DB hydrate (UI jitter).
        # phase==running 不再单独拒绝：后台 run 的 phase 只能由本函数收口，
        # 拿它拒客会把自己锁死（死锁闭环的另一半）。
        #
        # 例外：FE tip/行数已落后 hub（frames 丢了、双订阅错位）时仍广播 recovery，
        # 不 wipe、不碰 mirror——只把当前 hub 快照再投一次。现场 21:19：
        # hub=772 / FE=715 + WIRE_WITHOUT_V4_TIP，旧逻辑 live-mirror 直接放行走死。
        if mirror_live and sess.rows:
            hub_tip = self._hub_tip_row_id(sess)
            client_tip = None
            try:
                if client_tip_row_id is not None:
                    client_tip = int(client_tip_row_id)
            except (TypeError, ValueError):
                client_tip = None
            if (
                client_tip is not None
                and hub_tip is not None
                and client_tip < hub_tip
            ):
                notified = self.broadcast_recovery_snapshot(tid)
                logger.warning(
                    "[v4.catchup] client-behind under live-mirror session=%s "
                    "client_tip=%s hub_tip=%s rows=%s notified=%s",
                    tid,
                    client_tip,
                    hub_tip,
                    len(sess.rows),
                    notified,
                )
                return self._catchup_meta(
                    sess,
                    ok=True,
                    changed=True,
                    reason="client-behind-resync",
                    notified=notified,
                    settledPhase=settled_phase or None,
                    fingerprint=fp,
                    clientTipRowId=client_tip,
                )
            return self._catchup_meta(
                sess,
                ok=True,
                changed=False,
                reason="live-mirror",
                settledPhase=settled_phase or None,
                fingerprint=fp,
                clientTipRowId=client_tip,
            )
        # mirror 标 live 但本 hub 尚无行：放行后面 hydrate（空投影不能靠 live-mirror 挡死）。

        prev_rows = len(sess.rows)
        # Panel already subscribed **且有活写手**（hub 自跑 turn，或最近 3s 有
        # 行/增量写入）→ live 拥有更新权，catchup wipe 会与 live 对打（DB ~190
        # vs live ~350 → recovery thrash + raw JSON flash）。
        # 无活写手（后台 run 的典型态：无 mirror、无 hub turn、写手早已收工）
        # → 放行；否则「切走再切回」永远拿到冻结快照，且 run 期间行不增长。
        sub_n = sum(1 for s in self._subscriptions.values() if s.session_id == tid)
        hub_live_writing = sess.turn_running() or (
            time.time() * 1000 - sess.last_author_at_ms < 3000
        )
        if (
            prev_rows > 0
            and sub_n > 0
            and hub_live_writing
            and not settled_phase
            and not tip_mismatch
        ):
            hub_tip = self._hub_tip_row_id(sess)
            client_tip = None
            try:
                if client_tip_row_id is not None:
                    client_tip = int(client_tip_row_id)
            except (TypeError, ValueError):
                client_tip = None
            if (
                client_tip is not None
                and hub_tip is not None
                and client_tip < hub_tip
            ):
                notified = self.broadcast_recovery_snapshot(tid)
                logger.warning(
                    "[v4.catchup] client-behind under hub-subscribed session=%s "
                    "client_tip=%s hub_tip=%s rows=%s notified=%s",
                    tid,
                    client_tip,
                    hub_tip,
                    prev_rows,
                    notified,
                )
                return self._catchup_meta(
                    sess,
                    ok=True,
                    changed=True,
                    reason="client-behind-resync",
                    notified=notified,
                    settledPhase=settled_phase or None,
                    fingerprint=fp,
                    clientTipRowId=client_tip,
                )
            sess.catchup_fp = fp
            return self._catchup_meta(
                sess,
                ok=True,
                changed=False,
                reason="hub-subscribed",
                settledPhase=settled_phase or None,
                fingerprint=fp,
                clientTipRowId=client_tip,
            )

        # Probe hydrate on a throwaway hub first: never shrink a richer live/hybrid
        # projection (common: live ~300 rows → DB hydrate ~160). Advance fp so we
        # don't thrash every observer tick.
        # tip 与库尾脱节时「更胖」是假象——必须允许 shrink 回到 transcript。
        if prev_rows > 0 and not tip_mismatch:
            try:
                from app.gateway.v4.hydration import hydrate_session_from_transcript

                probe = V4ConversationHub()
                probe_loaded = hydrate_session_from_transcript(probe, tid)
            except Exception:
                logger.exception("[v4.catchup] probe hydrate failed session=%s", tid)
                probe_loaded = -1
            if (
                probe_loaded > 0
                and probe_loaded < int(prev_rows * 0.85)
            ):
                sess.catchup_fp = fp
                logger.warning(
                    "[v4.catchup] refuse shrink session=%s prev_rows=%s hydrate_rows=%s",
                    tid,
                    prev_rows,
                    probe_loaded,
                )
                return {
                    "ok": True,
                    "changed": False,
                    "reason": "refuse-shrink",
                    "rows": prev_rows,
                    "hydrateRows": probe_loaded,
                    "logEpoch": sess.log_epoch,
                    "fingerprint": fp,
                }

        # 切回校准：客户端已有投影行 → 只 settle，绝不 wipe（避免 recovery 整窗替换闪烁）。
        # tip 脱节例外：只 settle 治不好「面板 tip ≠ SQL tip」。
        if prefer_settle_only and prev_rows > 0 and not tip_mismatch:
            sess.catchup_fp = fp
            logger.info(
                "[v4.catchup] settle-only session=%s rows=%s settled=%s fp=%s",
                tid,
                prev_rows,
                settled_phase or "-",
                fp,
            )
            return {
                "ok": True,
                "changed": False,
                "reason": "settle-only",
                "rows": prev_rows,
                "settledPhase": settled_phase or None,
                "logEpoch": sess.log_epoch,
                "fingerprint": fp,
            }

        # Catchup must not mirror_reset — that clears run_started mid-IM stream and
        # lets the next tick wipe again.
        loaded = force_rehydrate_session_from_transcript(
            self, tid, fingerprint=fp, reset_mirror=False
        )
        # 重灌后再兜一次：热路径若刚 durable-replay 过，仍可能 tip 脱节。
        sess = self._get_or_create_session(tid)
        if fp and sess.rows and not self._projection_tip_matches_fingerprint(sess, fp):
            trimmed = self._trim_projection_after_fingerprint_tip(sess, fp)
            if trimmed:
                loaded = len(sess.rows)
                sess.catchup_fp = fp
                logger.warning(
                    "[v4.catchup] trimmed tip-after-transcript session=%s removed=%s "
                    "rows_now=%s",
                    tid,
                    trimmed,
                    loaded,
                )
        notified = self.broadcast_recovery_snapshot(tid)
        reason = "tip-mismatch-rehydrated" if tip_mismatch else "rehydrated"
        logger.info(
            "[v4.catchup] session=%s rows=%s notified=%s fp=%s reason=%s",
            tid,
            loaded,
            notified,
            fp,
            reason,
        )
        return self._catchup_meta(
            sess,
            ok=True,
            changed=True,
            reason=reason,
            rows=loaded,
            notified=notified,
            settledPhase=settled_phase or None,
            fingerprint=fp,
        )

    def reconcile_stale_running(self) -> dict[str, int]:
        """周期收口：陈旧 running 投影 + DB 已终态 → settle + rehydrate + 广播。

        员工/后台 run 无 mirror 喂流，run 终态后投影永远停在「进行中」；不能
        依赖前端来问（所有补拉轮询在 run 终态那一刻恰好全部退出）。这里主动扫
        hub 内 running 相位的会话，DB 终态则借 ``catchup_from_transcript`` 收口
        （settle control + 终态行 rehydrate + recovery 广播给在线订阅者）。

        只在 to_thread 里跑（SQLite 读）；候选集天然很小（正常会话不处于
        running 相位）。静默期/turn_task/mirror 三重守卫防误伤活写手。
        """
        try:
            from app.gateway.v4.agui_mirror import mirror_thread_is_live
        except Exception:
            logger.exception("[v4.settle] import failed")
            return {"candidates": 0, "settled": 0}

        now_ms = time.time() * 1000
        candidates: list[str] = []
        with self._write_lock:
            for sess in self._sessions.values():
                if sess.turn_running():
                    continue
                if not sess.rows:
                    continue
                phase_running = _PHASE_RUNNING in (
                    str(sess.phase or ""),
                    str((sess.control_override or {}).get("phase") or ""),
                )
                # draft + 僵尸 streaming/running 行也要扫（压缩后 tip「正在思考」）。
                inflight = self._rows_have_inflight(list(sess.rows.values()))
                if not phase_running and not inflight:
                    continue
                # 有活写手（最近 5s 有行/增量写入）→ 不是孤儿 run，跳过。
                if now_ms - sess.last_author_at_ms < 5000:
                    continue
                candidates.append(sess.session_id)

        settled = 0
        for tid in candidates:
            try:
                if mirror_thread_is_live(tid):
                    continue
                out = self.catchup_from_transcript(tid)
                if out.get("changed") or out.get("settledPhase"):
                    settled += 1
            except Exception:
                logger.exception("[v4.settle] reconcile failed session=%s", tid)
        if settled:
            logger.info("[v4.settle] reconciled stale running sessions=%d", settled)
        return {"candidates": len(candidates), "settled": settled}

    # -- 订阅 ---------------------------------------------------------------

    async def subscribe(
        self,
        *,
        connection_id: str,
        session_id: str,
        base: dict[str, Any] | None = None,
        client_mode: str | None = None,
        intent: str | None = None,
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
        # prefetch = hover keep-warm；open/缺省 = 用户点开（插队）。
        high_priority = str(intent or "open").strip().lower() != "prefetch"

        # Decide resume vs snapshot *before* heavy hydrate. Resume never needs DB.
        resume_ok = False
        if isinstance(base, dict):
            base_epoch = str(base.get("logEpoch") or "")
            base_seq = int(base.get("seq") or 0)
            resume_ok = (
                base_epoch == sess.log_epoch
                and sess.delta_log_floor <= base_seq <= sess.seq
                and (base_seq < sess.seq or not sess.delta_log)
            )

        # Cold hydrate OFF the event loop and OUTSIDE ``self._lock``.
        # Sync hydrate under the asyncio lock froze Gateway for multi‑second windows
        # on large transcripts (2026-11-08 formal package lockup: health/Feishu/UI
        # all stuck while one subscribe hydrated 700+ rows).
        # Hydrates run through the priority gate: clicks (intent=open) get a free
        # slot immediately and may run 2-wide; hover prefetch is capped at 1 so it
        # can never occupy both slots and make a click wait for a warm to finish
        # (the old "parallel hover-warm contended SQLite + CPU, every click dead").
        hydrate_ms: float | None = None
        hydrate_rows = 0
        prebuilt_snapshot: dict[str, Any] | None = None
        if not resume_ok and not sess.rows:
            # 同会话双订阅串行冷开；进锁后再看 rows，避免并行 durable 双份尾差。
            async with self._cold_hydrate_lock(sess.session_id):
                if sess.rows:
                    hydrate_ms = 0.0
                    hydrate_rows = len(sess.rows)
                else:
                    try:
                        from app.gateway.v4.hydration import hydrate_session_from_transcript

                        # durable 纪元接续（对齐 ZCode durable 语义）：档案里已有该会话的
                        # (epoch, seq) 血统——冷启动续接而不是归位 "1"/0，否则新事件与旧档案
                        # (sid, epoch, seq) 撞键被 INSERT OR IGNORE 静默丢弃，档案跨重启断代。
                        try:
                            from app.gateway.v4.durable_replay import read_durable_head

                            head = await asyncio.to_thread(
                                read_durable_head, self, sess.session_id
                            )
                            if head:
                                if int(head.get("seq") or 0) > sess.seq:
                                    sess.seq = int(head.get("seq") or 0)
                                if str(head.get("epoch") or "") > str(sess.log_epoch or ""):
                                    sess.log_epoch = str(head.get("epoch"))
                        except Exception:
                            logger.debug(
                                "[v4.durable-replay] head seed skipped session=%s",
                                sess.session_id,
                                exc_info=True,
                            )

                        hydrate_started = time.perf_counter()
                        async with _hydrate_slot(high_priority=high_priority):
                            loaded = await asyncio.to_thread(
                                hydrate_session_from_transcript, self, sess.session_id
                            )
                        hydrate_ms = round((time.perf_counter() - hydrate_started) * 1000, 1)
                        hydrate_rows = int(loaded or 0)
                        if loaded:
                            logger.info(
                                "[v4.hydration] resubscribe recovered history session=%s rows=%s",
                                sess.session_id,
                                loaded,
                            )
                        else:
                            logger.info(
                                "[v4.hydration] subscribe hydrate produced no rows session=%s in %.1fms",
                                sess.session_id,
                                hydrate_ms,
                            )
                        # durable 尾差补齐（对齐 ZCode durable 语义的读回侧）：水合只覆盖
                        # transcript 落库过的消息；镜像 authored 的行（空流占位修正、迟到正文、
                        # 断流瞬态、下一轮开头）从 evoflow_v4_event_log 按 seq 补放，
                        # 网关重启/清投影后显示无损。镜像活写/已有内存投影（resume/热会话）不进这里。
                        try:
                            from app.gateway.v4.durable_replay import replay_durable_tail

                            replayed = await asyncio.to_thread(
                                replay_durable_tail, self, sess.session_id
                            )
                            if replayed:
                                hydrate_rows += replayed
                                logger.info(
                                    "[v4.durable-replay] subscribe tail replayed session=%s rows=%s",
                                    sess.session_id,
                                    replayed,
                                )
                        except Exception:
                            logger.exception(
                                "[v4.durable-replay] subscribe replay failed session=%s",
                                sess.session_id,
                            )
                        # durable 尾差若把更早 live 轮追加到库尾之后（394bc37f：
                        # hydrate=630 → replay+2528 → tip=run-07cc…），按 fingerprint 裁掉。
                        try:
                            from app.gateway.v4.hydration import (
                                transcript_fingerprint_for_thread,
                            )

                            fp_now = await asyncio.to_thread(
                                transcript_fingerprint_for_thread, sess.session_id
                            )
                            if fp_now and sess.rows and not self._projection_tip_matches_fingerprint(
                                sess, fp_now
                            ):
                                trimmed = self._trim_projection_after_fingerprint_tip(
                                    sess, fp_now
                                )
                                if trimmed:
                                    hydrate_rows = len(sess.rows)
                                    sess.catchup_fp = fp_now
                                    logger.warning(
                                        "[v4.durable-replay] trimmed tip-after-transcript "
                                        "session=%s removed=%s rows_now=%s fp=%s",
                                        sess.session_id,
                                        trimmed,
                                        hydrate_rows,
                                        fp_now,
                                    )
                        except Exception:
                            logger.exception(
                                "[v4.durable-replay] tip trim failed session=%s",
                                sess.session_id,
                            )
                    except Exception:
                        logger.exception(
                            "[v4.hydration] subscribe hydration failed session=%s",
                            sess.session_id,
                        )
        elif not resume_ok:
            hydrate_ms = 0.0
            hydrate_rows = len(sess.rows)

        # Build initial snapshot off the event loop (json.dumps of the tail
        # window is multi‑100ms on fat tool rows). Hold only a short lock to enqueue.
        if not resume_ok and sess.rows:
            try:
                snap_started = time.perf_counter()
                prebuilt_snapshot = await asyncio.to_thread(self._build_snapshot, sess)
                snap_ms = round((time.perf_counter() - snap_started) * 1000, 1)
                if snap_ms >= 200:
                    logger.warning(
                        "[v4.perf] snapshot build slow session=%s snapshot_ms=%.1f rows=%s",
                        sess.session_id,
                        snap_ms,
                        len(sess.rows),
                    )
            except Exception:
                logger.exception(
                    "[v4.snapshot] off-loop build failed session=%s; falling back under lock",
                    sess.session_id,
                )
                prebuilt_snapshot = None

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
                ack_mode = "snapshot"
                # Re-read rows after off-thread hydrate (may have filled sess.rows).
                if hydrate_rows <= 0:
                    hydrate_rows = len(sess.rows)
                if prebuilt_snapshot is not None:
                    self._enqueue_prebuilt_snapshot_locked(
                        sub, sess, prebuilt_snapshot, delivery_kind="initial"
                    )
                else:
                    self._enqueue_snapshot_locked(sub, sess, delivery_kind="initial")
                if hydrate_ms is not None and hydrate_ms >= 500:
                    logger.warning(
                        "[v4.perf] subscribe hydration slow session=%s hydrate_ms=%.1f rows=%s",
                        sess.session_id,
                        hydrate_ms,
                        hydrate_rows,
                    )

        # openTiming：服务端侧分段耗时（前端 openTrace 会据此归因「慢在服务端拉库」）。
        # sessionRuntimeState 只允许 cold/warm（协议枚举）：按是否已有历史行判冷热。
        open_timing: dict[str, Any] = {
            "hydrateMs": hydrate_ms,
            "snapshotRowCount": len(sess.rows),
            "sessionRuntimeState": "warm" if sess.rows else "cold",
        }
        return {
            "ack": {
                "subscriptionId": subscription_id,
                "mode": ack_mode,
                "logEpoch": sess.log_epoch,
                "openTiming": open_timing,
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
        # poll_frames 无界等待。编码结果同时喂 durable 事件日志（一次序列化两用）。
        encoded_deltas = [json.dumps(d, ensure_ascii=False) for d in deltas]
        sizes = [len(e) for e in encoded_deltas]
        durable_items: list[tuple[int, str, str]] = []
        with self._write_lock:
            sess = self._get_or_create_session(session_id)
            sess.last_author_at_ms = time.time() * 1000
            subs = [s for s in self._subscriptions.values() if s.session_id == sess.session_id]
            for delta, encoded, size in zip(deltas, encoded_deltas, sizes):
                sess.seq += 1
                sess.delta_log.append((sess.seq, delta))
                durable_items.append(
                    (sess.seq, str(delta.get("op") or ""), encoded)
                )
                if len(sess.delta_log) > _DELTA_RETENTION_MAX:
                    evicted_seq = sess.delta_log.pop(0)[0]
                    floor = sess.delta_log[0][0] - 1 if sess.delta_log else evicted_seq
                    sess.delta_log_floor = max(sess.delta_log_floor, floor)
                if not subs:
                    continue
                for sub in subs:
                    if sub.overflowed:
                        # 已溢出：本批 delta 不再入队（recovery snapshot 会带上行），
                        # 但仍要确保 flush 已排上——否则 overflowed 一直 true，
                        # 后续直播增量全被 continue 掉，页面就「工作中但不涨字」。
                        self._schedule_flush_threadsafe(sub)
                        continue
                    sub.pending_ops.append((sess.seq, delta))
                    # BUG（并行改动回归）：曾写成 `+= encoded`（JSON 字符串）——
                    # pending_bytes 是 int 字节计数，int += str 在「有订阅者」时
                    # 第一条 delta 就 TypeError，author_deltas 整批丢失 →
                    # 客户端实时流全断（行已进 sess.rows，刷新才见）→
                    # 表现为「发送后没反应」。恢复用字节数 size。
                    sub.pending_bytes += size
                    if (
                        len(sub.pending_ops) > _SUBSCRIBER_BUFFER_MAX_OPS
                        or sub.pending_bytes > _SUBSCRIBER_BUFFER_MAX_BYTES
                    ):
                        # 溢出语义：清空缓冲置 resyncRequired，下一次 flush 发全量 snapshot。
                        sub.pending_ops = []
                        sub.pending_bytes = 0
                        sub.overflowed = True
                        self._schedule_flush_threadsafe(sub)
                        continue
                    # authoring 可能来自 feed-to-thread worker 线程——必须走线程安全调度，
                    # 裸 loop.call_later 跨线程 push TimerHandle 会与 loop._run_once 竞争。
                    self._schedule_flush_threadsafe(sub)
            logger.debug(
                "[v4.author] session=%s ops=%d seq=%d subs=%d",
                sess.session_id,
                len(deltas),
                sess.seq,
                len(subs),
            )
        # durable 事件档案（ZCode durable event 语义）：逐条权威 delta 落库（非阻塞），
        # (session_id, log_epoch, seq) 唯一——事后审计「这条流/轮发生了什么、断在哪」。
        # author_seed_rows 不入档：seed 是从 transcript 重建的历史（可再 derivation），
        # 档案的独有价值 = 实时权威 delta 流。清空投影（log_epoch bump）后旧代际档案保留。
        if durable_items:
            from app.gateway.v4.event_log_writer import enqueue_v4_event_log

            enqueue_v4_event_log(sess.session_id, sess.log_epoch, durable_items)

    def author_seed_rows(self, session_id: str, rows: list[dict[str, Any]]) -> int:
        """Cold-load history without per-row delta_log / ``_write_lock`` thrash.

        Subscribe always delivers an initial snapshot, so N×``row.appended`` is
        pure contention against live AG-UI authors on the shared write lock
        (multi-chat freeze: hydrate worker holds the lock while stream handlers
        on the event loop wait). Existing subscribers are marked overflowed so
        their next flush resyncs via snapshot.
        """
        if not rows:
            return 0
        flush_subs: list[_Subscription] = []
        with self._write_lock:
            sess = self._get_or_create_session(session_id)
            sess.last_author_at_ms = time.time() * 1000
            if sess.rows:
                return 0
            max_rid = 0
            for row in rows:
                rid = int(row["rowId"])
                sess.rows[rid] = row
                if rid > max_rid:
                    max_rid = rid
            if max_rid >= int(sess.next_row_id):
                sess.next_row_id = max_rid + 1
            for sub in self._subscriptions.values():
                if sub.session_id != sess.session_id:
                    continue
                sub.pending_ops = []
                sub.pending_bytes = 0
                sub.overflowed = True
                flush_subs.append(sub)
        for sub in flush_subs:
            self._schedule_flush_threadsafe(sub)
        return len(rows)

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
        # hub 自跑 turn 接管执行权：mirror/复原写入的 override 让位（谁拥有当前
        # 执行，谁写 control）；running 时记 startedAt 供 fallback activeWorks。
        sess.control_override = None
        sess.run_started_at = int(time.time() * 1000) if phase == _PHASE_RUNNING else None
        self.author_state_patch(
            session_id,
            {"control": _minimal_control(phase, run_started_at=sess.run_started_at)},
        )

    def set_control_override(self, session_id: str, control: dict[str, Any] | None) -> None:
        """mirror / hydrate 复原路径写入权威 control 的唯一入口。

        override 落会话态并发增量：在线订阅者收到 state.updated，快照重建
        （刷新重订阅 / recovery / 订阅者溢出转 snapshot）从 override 产出——
        两侧同源，消除 control 在快照路径被重算覆盖的不对称。
        phase 同步派生，保 inputRouting / 侧栏相位与 control 同源。
        """
        if not isinstance(control, dict) or not control:
            return
        sess = self._get_or_create_session(session_id)
        sess.control_override = dict(control)
        phase = str(control.get("phase") or "").strip()
        if phase:
            sess.phase = phase
        self.author_state_patch(session_id, {"control": dict(control)})

    def _workflow_runs_state(self, sess: _SessionState) -> dict[str, Any]:
        from app.gateway.v4.workflow_runs_projection import strip_internal_keys

        return {
            "revision": int(sess.workflow_runs_revision),
            "runs": [strip_internal_keys(r) for r in sess.workflow_runs if isinstance(r, dict)],
        }

    def _background_works_from_workflow_runs(self, sess: _SessionState) -> list[dict[str, Any]]:
        """Running collab 投影 → composer 底部「运行中工作流」图标（与对话进度卡同源）。"""
        out: list[dict[str, Any]] = []
        for run in sess.workflow_runs:
            if not isinstance(run, dict):
                continue
            status = str(run.get("status") or "").strip()
            if status not in {"pending", "running"}:
                continue
            rid = str(run.get("runId") or "").strip()
            if not rid:
                continue
            title = str(run.get("_label") or "工作流").strip() or "工作流"
            started = run.get("lastEventSequence")
            if not isinstance(started, int) or started < 0:
                started = 0
            out.append(
                {
                    "workId": rid,
                    "kind": "workflow",
                    "title": title[:160],
                    "status": "running",
                    "startedAt": started,
                    "cancellable": False,
                    "anchorRowId": None,
                }
            )
        if out:
            logger.info(
                "workflow-progress backgroundWorks n=%s works=%s",
                len(out),
                [
                    {
                        "workId": w.get("workId"),
                        "title": w.get("title"),
                        "toolCallId": next(
                            (
                                str(r.get("toolCallId") or "")
                                for r in sess.workflow_runs
                                if isinstance(r, dict)
                                and str(r.get("runId") or "") == str(w.get("workId") or "")
                            ),
                            "",
                        ),
                    }
                    for w in out
                ],
            )
        return out[:8]

    def upsert_workflow_run_from_platform(
        self,
        session_id: str,
        *,
        tool_call_id: str,
        action: str,
        content: str,
        display: dict[str, Any] | None,
    ) -> bool:
        """platform workflow.run 族结果 → 投影一条 WorkflowRunState 并 state.updated。"""
        from app.gateway.v4.workflow_runs_projection import (
            extract_workflow_progress_from_platform_result,
            load_collab_bundle,
            project_collab_to_workflow_run,
            upsert_run_list,
        )

        tip = extract_workflow_progress_from_platform_result(
            action=action, content=content, display=display
        )
        if not tip:
            logger.info(
                "workflow-progress upsert skip: no tip session=%s toolCallId=%s action=%s",
                session_id,
                tool_call_id,
                action,
            )
            return False
        main, subs = load_collab_bundle(str(tip["mainTaskId"]))
        # runId ≡ mainTaskId：右栏 collab-workflow / GET /tasks 只认主任务 id。
        # platform 另发的 runId（如 R1）若写进协议键，⤢ 会用错 id 打开「暂无子任务节点」。
        main_task_id = str(tip["mainTaskId"])
        run = project_collab_to_workflow_run(
            main_task=main
            or {
                "taskId": main_task_id,
                "name": tip.get("name") or "工作流",
                "status": "running",
            },
            subtasks=subs,
            tool_call_id=tool_call_id,
            run_id=main_task_id,
            name=str(tip.get("name") or ""),
        )
        if not run:
            logger.info(
                "workflow-progress upsert skip: project failed session=%s toolCallId=%s main=%s",
                session_id,
                tool_call_id,
                main_task_id,
            )
            return False
        with self._write_lock:
            sess = self._get_or_create_session(session_id)
            sess.workflow_runs = upsert_run_list(sess.workflow_runs, run)
            sess.workflow_runs_revision += 1
            patch = {
                "workflowRuns": self._workflow_runs_state(sess),
                "backgroundWorks": self._background_works_from_workflow_runs(sess),
            }
        logger.info(
            "workflow-progress upsert ok session=%s toolCallId=%s runId=%s status=%s "
            "actors=%s nodes=%s bg=%s",
            session_id,
            tool_call_id,
            run.get("runId"),
            run.get("status"),
            len(run.get("actors") or []),
            len(run.get("nodes") or []),
            len(patch.get("backgroundWorks") or []),
        )
        self.author_state_patch(session_id, patch)
        # 运行中：后台轻量刷新，把子任务进度推进投影
        if str(run.get("status") or "") in {"pending", "running"}:
            self._schedule_workflow_run_refresh(
                session_id,
                main_task_id=main_task_id,
                run_id=main_task_id,
                tool_call_id=tool_call_id,
                name=str(tip.get("name") or ""),
            )
        return True

    def upsert_workflow_run_from_task(
        self,
        session_id: str,
        *,
        main_task_id: str,
        name: str = "",
        tool_call_id: str = "",
        status: str = "running",
    ) -> bool:
        """childWorks / app_runner 注册工作流时写入投影（不依赖 platform 工具结果）。"""
        from app.gateway.v4.workflow_runs_projection import (
            load_collab_bundle,
            project_collab_to_workflow_run,
            upsert_run_list,
        )

        tid = str(session_id or "").strip()
        mid = str(main_task_id or "").strip()
        if not tid or not mid:
            return False
        main, subs = load_collab_bundle(mid)
        run = project_collab_to_workflow_run(
            main_task=main
            or {
                "taskId": mid,
                "name": name or "工作流",
                "status": status or "running",
            },
            subtasks=subs,
            tool_call_id=tool_call_id,
            run_id=mid,
            name=str(name or ""),
        )
        if not run:
            logger.info(
                "workflow-progress upsert_from_task skip: project failed session=%s main=%s",
                tid,
                mid,
            )
            return False
        with self._write_lock:
            sess = self._get_or_create_session(tid)
            sess.workflow_runs = upsert_run_list(sess.workflow_runs, run)
            sess.workflow_runs_revision += 1
            patch = {
                "workflowRuns": self._workflow_runs_state(sess),
                "backgroundWorks": self._background_works_from_workflow_runs(sess),
            }
        logger.info(
            "workflow-progress upsert_from_task ok session=%s runId=%s status=%s "
            "actors=%s nodes=%s toolCallId=%s",
            tid,
            run.get("runId"),
            run.get("status"),
            len(run.get("actors") or []),
            len(run.get("nodes") or []),
            tool_call_id or "",
        )
        self.author_state_patch(tid, patch)
        if str(run.get("status") or "") in {"pending", "running"}:
            self._schedule_workflow_run_refresh(
                tid,
                main_task_id=mid,
                run_id=mid,
                tool_call_id=tool_call_id,
                name=str(name or ""),
            )
        return True

    def refresh_workflow_run(
        self,
        session_id: str,
        *,
        main_task_id: str,
        run_id: str,
        tool_call_id: str = "",
        name: str = "",
    ) -> bool:
        from app.gateway.v4.workflow_runs_projection import (
            load_collab_bundle,
            project_collab_to_workflow_run,
            upsert_run_list,
        )

        main, subs = load_collab_bundle(main_task_id)
        if main is None and not subs:
            return False
        run = project_collab_to_workflow_run(
            main_task=main or {"taskId": main_task_id, "name": name or "工作流", "status": "running"},
            subtasks=subs,
            tool_call_id=tool_call_id,
            run_id=run_id or main_task_id,
            name=name,
        )
        if not run:
            return False
        with self._write_lock:
            sess = self._sessions.get(session_id)
            if sess is None:
                return False
            sess.workflow_runs = upsert_run_list(sess.workflow_runs, run)
            sess.workflow_runs_revision += 1
            patch = {
                "workflowRuns": self._workflow_runs_state(sess),
                "backgroundWorks": self._background_works_from_workflow_runs(sess),
            }
        self.author_state_patch(session_id, patch)
        return str(run.get("status") or "") in {"pending", "running"}

    def _schedule_workflow_run_refresh(
        self,
        session_id: str,
        *,
        main_task_id: str,
        run_id: str,
        tool_call_id: str,
        name: str,
    ) -> None:
        loop = self._loop
        if loop is None or loop.is_closed():
            try:
                loop = asyncio.get_running_loop()
                self._loop = loop
            except RuntimeError:
                return

        async def _poll() -> None:
            # ~2.5s × 120 ≈ 5 min；终态自动停
            for _ in range(120):
                await asyncio.sleep(2.5)
                try:
                    still = await asyncio.to_thread(
                        self.refresh_workflow_run,
                        session_id,
                        main_task_id=main_task_id,
                        run_id=run_id,
                        tool_call_id=tool_call_id,
                        name=name,
                    )
                except Exception:
                    logger.debug(
                        "workflowRuns refresh failed session=%s task=%s",
                        session_id,
                        main_task_id,
                        exc_info=True,
                    )
                    break
                if not still:
                    break

        def _start() -> None:
            try:
                loop.create_task(_poll())
            except Exception:
                logger.debug("workflowRuns poll schedule failed", exc_info=True)

        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is loop:
            _start()
        else:
            try:
                loop.call_soon_threadsafe(_start)
            except Exception:
                logger.debug("workflowRuns poll threadsafe failed", exc_info=True)

    def list_workflow_runs(self, session_id: str, *, limit: int = 8) -> dict[str, Any]:
        """``POST /api/v4/conversation/workflowRuns`` journal 面。"""
        from app.gateway.v4.workflow_runs_projection import to_journal_summary

        lim = max(1, min(int(limit or 8), 64))
        with self._write_lock:
            sess = self._sessions.get(session_id)
            runs = list(sess.workflow_runs) if sess is not None else []
        summaries = [to_journal_summary(r) for r in runs[:lim] if isinstance(r, dict)]
        return {"runs": summaries}

    # -- flush 调度 -------------------------------------------------------------

    def _schedule_flush_threadsafe(self, sub: _Subscription) -> None:
        """Hydrate / worker threads must not call ``loop.call_later`` directly."""
        loop = self._loop
        if loop is None or loop.is_closed():
            self._schedule_flush(sub)
            return
        try:
            loop.call_soon_threadsafe(self._schedule_flush, sub)
        except RuntimeError:
            self._schedule_flush(sub)

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
        # 每 flush 一行曾是 INFO：流式会话 30ms 窗连发，实测 26.5 万行/天（75MB/天），
        # 是 gateway 日志最大洪水源。降 DEBUG——排帧序对账时把 log_level 调到 debug 即可。
        # snapshot / resume replay / overflow 仍为 INFO+（低频且是异常/首帧关键证据）。
        logger.debug(
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

    def _session_goal_state(self, sess: _SessionState) -> dict[str, Any] | None:
        """当前会话目标状态（vendored goalStateSchema 形状；无目标为 None）。"""
        try:
            from app.gateway.v4.goal_engine import get_v4_goal_engine

            return get_v4_goal_engine().get_goal_state(sess.session_id)
        except Exception:
            logger.debug("[v4-conversation] goal state read failed session=%s", sess.session_id, exc_info=True)
            return None

    def _session_availability(self, sess: _SessionState) -> dict[str, Any]:
        availability = _minimal_availability()
        try:
            from app.gateway.v4.goal_engine import get_v4_goal_engine

            availability.update(get_v4_goal_engine().availability(sess.session_id))
        except Exception:
            logger.debug("[v4-conversation] availability read failed session=%s", sess.session_id, exc_info=True)
        return availability

    def _build_session_usage(self, sess: _SessionState) -> dict[str, Any]:
        """真实会话用量（快照路径）：DB 累计 rollup + 持久化 context_usage。

        ``_minimal_usage()`` 全 0 会让 composer 上下文表 / 会话总计面板永远空转。
        结果同时记到 ``sess.usage_state``，作为 mirror 轮末增量累加的基线。
        读不到（非主聊 thread / 库异常）回退全 0 形状，行为与旧版一致。
        """
        usage: dict[str, Any] = {
            "contextWindow": None,
            "cumulative": {
                "inputTokens": 0,
                "outputTokens": 0,
                "cacheReadTokens": 0,
                "cacheWriteTokens": 0,
            },
        }
        try:
            from evoflow.persistence import session_repositories as sess_repo

            sk = str(sess_repo.find_session_key_by_thread_id(sess.session_id) or "").strip()
            if sk:
                from evoflow.persistence.db import get_db

                row = get_db().execute(
                    "SELECT input_tokens, output_tokens, total_tokens, cache_read_tokens,"
                    " cache_creation_tokens, cache_miss_tokens"
                    " FROM evoflow_chat_sessions WHERE session_key = ?",
                    (sk,),
                ).fetchone()
                if row is not None:
                    keys = (
                        "input_tokens",
                        "output_tokens",
                        "total_tokens",
                        "cache_read_tokens",
                        "cache_creation_tokens",
                        "cache_miss_tokens",
                    )
                    values = dict(zip(keys, [int(v or 0) for v in tuple(row)]))
                    usage["cumulative"] = {
                        "inputTokens": values["input_tokens"],
                        "outputTokens": values["output_tokens"],
                        "cacheReadTokens": values["cache_read_tokens"],
                        "cacheWriteTokens": values["cache_creation_tokens"],
                        "totalTokens": values["total_tokens"],
                        "cacheMissTokens": values["cache_miss_tokens"],
                    }
                from evoflow.persistence.session_context_usage import load_session_context_usage

                ctx = load_session_context_usage(sk)
                # cache 字段不透传：持久化形状是 {hitRate}，与协议 strict cache schema 不符。
                if isinstance(ctx, dict) and ctx.get("window_tokens"):
                    usage["contextWindow"] = {
                        "usedTokens": max(0, int(ctx.get("used_tokens") or 0)),
                        "maxTokens": max(1, int(ctx.get("window_tokens") or 1)),
                        "autoCompactThresholdTokens": None,
                    }
        except Exception:
            logger.debug(
                "[v4-conversation] session usage build failed session=%s",
                sess.session_id,
                exc_info=True,
            )
        sess.usage_state = usage
        return usage

    def _session_turn_is_live(self, sess: _SessionState) -> bool:
        """True when a turn is still running — snapshot must keep that turn's userInput."""
        try:
            ctrl = dict(sess.control_override) if sess.control_override else sess.control()
            if bool(ctrl.get("canStop")) or str(ctrl.get("phase") or "") == "running":
                return True
        except Exception:
            pass
        if str(getattr(sess, "phase", "") or "") == "running":
            return True
        try:
            from app.gateway.v4.agui_mirror import mirror_thread_is_live

            if mirror_thread_is_live(str(sess.session_id or "")):
                return True
        except Exception:
            pass
        return False

    def _build_snapshot(self, sess: _SessionState) -> dict[str, Any]:
        # warm hub 上历史孤儿头（userInput 被挂走仍自称 origin=userInput）在出快照前降级，
        # 否则订阅/切回仍见 !NO_USER / 左栏劈开。
        try:
            from app.gateway.v4.agui_mirror import mirror_heal_orphan_user_input_headers

            mirror_heal_orphan_user_input_headers(str(sess.session_id or ""))
        except Exception:
            logger.exception(
                "[v4.snapshot] heal orphan userInput headers failed session=%s",
                sess.session_id,
            )
        try:
            from app.gateway.v4.agui_mirror import mirror_heal_stale_inflight_rows

            mirror_heal_stale_inflight_rows(str(sess.session_id or ""))
        except Exception:
            logger.exception(
                "[v4.snapshot] heal stale inflight rows failed session=%s",
                sess.session_id,
            )
        rows = sorted(sess.rows.values(), key=lambda r: r["rowId"])
        # 流式进行中：尾窗截断会把本轮 userInput 挤出；多会话切回时只剩工具/助手尾巴，
        # 用户气泡「没了」但 AI 还在回（2026-11-15 实锤）。live 时把本轮锚点钉进窗口。
        # 另：control 瞬态未标 running 但行上仍有 streaming/running 时也必须钉。
        pin_live = self._session_turn_is_live(sess) or self._rows_have_inflight(rows)
        window = self._snapshot_tail_window(rows, pin_live_turn=pin_live)
        return {
            "protocolVersion": 1,
            "sessionId": sess.session_id,
            "logEpoch": sess.log_epoch,
            "seq": sess.seq,
            "revision": sess.revision,
            "control": dict(sess.control_override) if sess.control_override else sess.control(),
            "availability": self._session_availability(sess),
            "inputRouting": sess.input_routing(),
            "meta": {
                "title": sess.title,
                "titleSource": "generated" if sess.title else "default",
            },
            "config": _minimal_config(sess.followup_mode),
            "modelTransition": None,
            "usage": self._build_session_usage(sess),
            "queue": sess.queue_state(),
            "pendingInteractions": [],
            "pendingCommands": [],
            "backgroundWorks": self._background_works_from_workflow_runs(sess),
            "goal": self._session_goal_state(sess),
            "plan": None,
            # 冷快照必须带 workflowRuns：刷新/重连后正在跑的 collab 投影不能丢
            "workflowRuns": self._workflow_runs_state(sess),
            "rows": {
                # 尾部窗口；更早行走 rows/range 游标补拉（rowsWindowSchema 截断语义）。
                "window": window,
                "totalCount": len(rows),
                "firstRowId": rows[0]["rowId"] if rows else None,
            },
        }

    @staticmethod
    def _is_snapshot_turn_boundary(row: dict[str, Any] | None) -> bool:
        """尾窗对齐只认 turnHeader——落在 userInput 会裁掉紧前 header，折叠轮界丢了。"""
        return bool(row) and str(row.get("kind") or "") == "turnHeader"

    @staticmethod
    def _include_leading_same_turn_user_input(
        rows: list[dict[str, Any]], header_idx: int
    ) -> int:
        """turnHeader 前若已有同 turnId 的 userInput（ensure/remint 颠倒行序），起点要含住它。

        否则尾窗对齐到 header 会裁掉紧前用户气泡 → 浮层只剩孤头/孤气泡错位。
        """
        if header_idx <= 0 or header_idx >= len(rows):
            return header_idx
        header = rows[header_idx]
        if str(header.get("kind") or "") != "turnHeader":
            return header_idx
        turn_id = str(header.get("turnId") or "").strip()
        if not turn_id:
            return header_idx
        i = header_idx
        while i > 0:
            prev = rows[i - 1]
            if str(prev.get("kind") or "") != "userInput":
                break
            if str(prev.get("turnId") or "").strip() != turn_id:
                break
            i -= 1
        return i

    @staticmethod
    def _align_snapshot_window_start(
        rows: list[dict[str, Any]],
        start: int,
        *,
        min_keep: int = _SNAPSHOT_MIN_TAIL_ROWS,
    ) -> int:
        """把尾窗起点对齐到 turnHeader，避免半截旧轮结论挂在窗顶。

        先向后最多 40 行找 header；找不到再向前丢弃孤儿头，直到下一轮 header。
        若 header 前有同 turn 颠倒落盘的 userInput，起点再回退把它收进来。
        """
        n = len(rows)
        if start <= 0 or start >= n:
            return max(0, min(start, n))
        back_floor = max(0, start - 40)
        i = start
        while i > back_floor:
            if V4ConversationHub._is_snapshot_turn_boundary(rows[i]):
                return V4ConversationHub._include_leading_same_turn_user_input(rows, i)
            i -= 1
        if V4ConversationHub._is_snapshot_turn_boundary(rows[start]):
            return V4ConversationHub._include_leading_same_turn_user_input(rows, start)
        i = start
        while i < n - min_keep:
            if V4ConversationHub._is_snapshot_turn_boundary(rows[i]):
                return V4ConversationHub._include_leading_same_turn_user_input(rows, i)
            i += 1
        return start

    @staticmethod
    def _trim_projection_after_fingerprint_tip(
        sess: _SessionState, fingerprint: str
    ) -> int:
        """删掉库尾 message 之后的幽灵 tip 行（durable-replay 把旧 live 轮追加到末尾）。

        返回删除行数。库尾 id 不在投影里时不裁（避免误删整窗）。
        """
        parts = str(fingerprint or "").split(":")
        if len(parts) < 2 or not sess.rows:
            return 0
        last_mid = str(parts[1] or "").strip()
        if not last_mid:
            return 0
        tip_rid = 0
        for row in sess.rows.values():
            if not isinstance(row, dict):
                continue
            ids = (
                str(row.get("entityId") or "").strip(),
                str(row.get("messageId") or "").strip(),
                str(row.get("assistantResponseId") or "").strip(),
            )
            if last_mid not in ids:
                continue
            try:
                rid = int(row.get("rowId") or 0)
            except (TypeError, ValueError):
                continue
            if rid > tip_rid:
                tip_rid = rid
        if tip_rid <= 0:
            return 0
        removed = 0
        for rid in list(sess.rows.keys()):
            try:
                irid = int(rid)
            except (TypeError, ValueError):
                continue
            if irid <= tip_rid:
                continue
            sess.rows.pop(rid, None)
            removed += 1
        if removed and sess.rows:
            sess.next_row_id = max(
                int(sess.next_row_id or 1),
                max(int(r.get("rowId") or 0) for r in sess.rows.values()) + 1,
            )
        return removed

    @staticmethod
    def _projection_tip_matches_fingerprint(sess: _SessionState, fingerprint: str) -> bool:
        """库尾 message_id 是否仍是投影 tip（其后没有别的对话轮）。

        fingerprint 形如 ``count:message_id:content_len``。hydrate 行用
        ``entityId=message_id``。若库尾 id 不在投影里，或其后又挂了另一轮的
        turnHeader/user/assistant/reasoning/tool，则视为 tip 脱节。
        """
        parts = str(fingerprint or "").split(":")
        if len(parts) < 2:
            return True
        last_mid = str(parts[1] or "").strip()
        if not last_mid or not sess.rows:
            return True
        matched_rids: list[int] = []
        matched_turns: set[str] = set()
        for row in sess.rows.values():
            if not isinstance(row, dict):
                continue
            ids = (
                str(row.get("entityId") or "").strip(),
                str(row.get("messageId") or "").strip(),
                str(row.get("assistantResponseId") or "").strip(),
            )
            if last_mid not in ids:
                continue
            try:
                rid = int(row.get("rowId") or 0)
            except (TypeError, ValueError):
                continue
            if rid <= 0:
                continue
            matched_rids.append(rid)
            turn = str(row.get("turnId") or "").strip()
            if turn:
                matched_turns.add(turn)
        if not matched_rids:
            return False
        tip_mid_rid = max(matched_rids)
        tip_kinds = {
            "turnHeader",
            "userInput",
            "assistantText",
            "reasoning",
            "toolCall",
            "subagent",
        }
        for row in sess.rows.values():
            if not isinstance(row, dict):
                continue
            try:
                rid = int(row.get("rowId") or 0)
            except (TypeError, ValueError):
                continue
            if rid <= tip_mid_rid:
                continue
            if str(row.get("kind") or "") not in tip_kinds:
                continue
            row_turn = str(row.get("turnId") or "").strip()
            if matched_turns and row_turn and row_turn not in matched_turns:
                return False
            if not row_turn:
                return False
        return True

    @staticmethod
    def _row_is_inflight(row: dict[str, Any] | None) -> bool:
        if not row:
            return False
        kind = str(row.get("kind") or "")
        if kind == "turnHeader":
            state = str(row.get("state") or "")
            return state == "running" or state.startswith("running")
        if kind in ("assistantText", "reasoning"):
            return str(row.get("state") or "") == "streaming"
        if kind == "toolCall":
            status = str(row.get("status") or "")
            return status in {
                "inputStreaming",
                "running",
                "pendingApproval",
                "awaitingInput",
                "pending",
                "executing",
            }
        if kind == "subagent":
            status = str(row.get("status") or "")
            return status in {"running", "streaming"}
        return False

    @staticmethod
    def _rows_have_inflight(rows: list[dict[str, Any]]) -> bool:
        return any(V4ConversationHub._row_is_inflight(r) for r in rows)

    @staticmethod
    def _turn_start_index(rows: list[dict[str, Any]], idx: int) -> int:
        if idx < 0 or idx >= len(rows):
            return max(0, idx)
        turn_id = str(rows[idx].get("turnId") or "").strip()
        if turn_id:
            for i, row in enumerate(rows):
                if i > idx:
                    break
                if str(row.get("turnId") or "").strip() == turn_id:
                    return i
        if idx > 0 and str(rows[idx - 1].get("kind") or "") == "turnHeader":
            return idx - 1
        if str(rows[idx].get("kind") or "") == "turnHeader":
            return idx
        return idx

    @staticmethod
    def _real_user_recency_key(row: dict[str, Any] | None) -> int:
        """对齐前端 realUserRecencyKey：createdAt 优先，其次 rowId。"""
        if not row:
            return -1
        try:
            created = int(row.get("createdAt") or 0)
        except (TypeError, ValueError):
            created = 0
        try:
            rid = int(row.get("rowId") or 0)
        except (TypeError, ValueError):
            rid = 0
        return created * 1_000_000 + (rid % 1_000_000) if created > 0 else rid

    @staticmethod
    def _rows_for_turn_id(rows: list[dict[str, Any]], turn_id: str) -> list[dict[str, Any]]:
        tid = str(turn_id or "").strip()
        if not tid:
            return []
        return [r for r in rows if str(r.get("turnId") or "").strip() == tid]

    @staticmethod
    def _resolve_live_turn_user_idx(
        rows: list[dict[str, Any]], turn_id: str, turn_start: int
    ) -> int:
        user_idx = -1
        best_user_key = -1
        for i, row in enumerate(rows):
            if str(row.get("turnId") or "").strip() != turn_id:
                continue
            if str(row.get("kind") or "") != "userInput":
                continue
            if str(row.get("origin") or "") != "realUser":
                continue
            if not str(row.get("text") or "").strip():
                continue
            key = V4ConversationHub._real_user_recency_key(row)
            if key >= best_user_key:
                best_user_key = key
                user_idx = i
        if user_idx >= 0:
            return user_idx
        user_idx = turn_start
        for i, row in enumerate(rows):
            if str(row.get("turnId") or "").strip() != turn_id:
                continue
            if str(row.get("kind") or "") == "userInput":
                return i
        return user_idx

    @staticmethod
    def _live_turn_span(rows: list[dict[str, Any]]) -> tuple[int, int] | None:
        """直播锚点 (turnStartIdx, userIdx)。

        对齐前端 ``liveTurnSpan``：
        1) 多 inflight 按 tip（最大 rowId）打分；
        2) 若最新 realUser 属于另一轮且比 inflight 轮用户更新 → demote 僵尸旧 inflight
           （现场 bash@80 永久 running 钉旧轮 → !STREAM_AHEAD_OF_WINDOW）。
        """
        inflight_by_turn: dict[str, tuple[int, int]] = {}
        latest_ui_idx: int | None = None
        latest_ui_key = -1
        for i, row in enumerate(rows):
            if V4ConversationHub._row_is_inflight(row):
                tid = str(row.get("turnId") or "").strip()
                if tid:
                    try:
                        rid = int(row.get("rowId") or 0)
                    except (TypeError, ValueError):
                        rid = 0
                    prev = inflight_by_turn.get(tid)
                    if prev is None or rid > prev[0]:
                        inflight_by_turn[tid] = (rid, i)
            if str(row.get("kind") or "") != "userInput":
                continue
            if str(row.get("origin") or "") != "realUser":
                continue
            if not str(row.get("text") or "").strip():
                continue
            key = V4ConversationHub._real_user_recency_key(row)
            if key >= latest_ui_key:
                latest_ui_key = key
                latest_ui_idx = i

        best_inflight_tid = ""
        best_inflight_score = -1.0
        best_inflight_idx = -1
        best_inflight_user_key = -1
        for tid, (max_rid, any_idx) in inflight_by_turn.items():
            user_score = -1
            for row in V4ConversationHub._rows_for_turn_id(rows, tid):
                if str(row.get("kind") or "") != "userInput":
                    continue
                if str(row.get("origin") or "") != "realUser":
                    continue
                if not str(row.get("text") or "").strip():
                    continue
                user_score = max(
                    user_score, V4ConversationHub._real_user_recency_key(row)
                )
            score = float(max_rid) * 1e15 + max(0, user_score)
            if score > best_inflight_score:
                best_inflight_score = score
                best_inflight_tid = tid
                best_inflight_idx = any_idx
                best_inflight_user_key = user_score

        if (
            best_inflight_tid
            and latest_ui_idx is not None
            and str(rows[latest_ui_idx].get("turnId") or "").strip() != best_inflight_tid
            and latest_ui_key > best_inflight_user_key
        ):
            latest_tid = str(rows[latest_ui_idx].get("turnId") or "").strip()
            latest_turn_max = 0
            for row in V4ConversationHub._rows_for_turn_id(rows, latest_tid):
                try:
                    latest_turn_max = max(latest_turn_max, int(row.get("rowId") or 0))
                except (TypeError, ValueError):
                    pass
            inflight_tip = inflight_by_turn.get(best_inflight_tid, (0, -1))[0]
            try:
                latest_created = int(rows[latest_ui_idx].get("createdAt") or 0)
            except (TypeError, ValueError):
                latest_created = 0
            # 必须有 createdAt：否则高 rowId 的「上一问晚到 append」会误 demote 直播轮。
            if latest_created > 0 and latest_turn_max > inflight_tip:
                turn_start = V4ConversationHub._turn_start_index(rows, latest_ui_idx)
                return turn_start, V4ConversationHub._resolve_live_turn_user_idx(
                    rows, latest_tid, turn_start
                )

        if best_inflight_tid and best_inflight_idx >= 0:
            turn_start = V4ConversationHub._turn_start_index(rows, best_inflight_idx)
            return turn_start, V4ConversationHub._resolve_live_turn_user_idx(
                rows, best_inflight_tid, turn_start
            )

        if latest_ui_idx is None:
            return None
        return V4ConversationHub._turn_start_index(rows, latest_ui_idx), latest_ui_idx

    @staticmethod
    def _pin_live_turn_into_window(
        rows: list[dict[str, Any]],
        window: list[dict[str, Any]],
        *,
        soft_cap: int,
    ) -> list[dict[str, Any]]:
        """软顶裁掉直播轮时：保住 turnHeader+user+in-flight+轮尾，避免已流出正文蒸发。

        只取本 turn 行（对齐前端 ``rowsForTurnId``），绝不用 ``rows[turn_start:]``——
        否则会把后写旧轮工具误收进直播段，或在旧轮仍 running 时把新 tip 挤出预算。
        in-flight 顶满时硬保最大 rowId tip（对齐 ``selectLiveTurnWithinBudget``）。
        """
        span = V4ConversationHub._live_turn_span(rows)
        if span is None:
            return window
        turn_start, user_idx = span
        live_turn_id = str(rows[turn_start].get("turnId") or "").strip()
        live_turn = (
            V4ConversationHub._rows_for_turn_id(rows, live_turn_id)
            if live_turn_id
            else rows[turn_start:]
        )
        if not live_turn:
            return window
        present = {int(r.get("rowId") or 0) for r in window}
        if all(int(r.get("rowId") or 0) in present for r in live_turn):
            return window
        cap = max(_SNAPSHOT_MIN_TAIL_ROWS, int(soft_cap))
        live_ids = {int(r.get("rowId") or 0) for r in live_turn}
        # user_idx 可能因交错行落在 turn 外；钳到本 turn 行序。
        live_user_pos = 0
        user_rid = int(rows[user_idx].get("rowId") or 0) if 0 <= user_idx < len(rows) else 0
        matched_user = False
        for i, row in enumerate(live_turn):
            if int(row.get("rowId") or 0) == user_rid:
                live_user_pos = i
                matched_user = True
                break
        if not matched_user:
            for i, row in enumerate(live_turn):
                if str(row.get("kind") or "") == "userInput":
                    live_user_pos = i
                    break
        if len(live_turn) <= cap:
            older_budget = max(0, cap - len(live_turn))
            older_start = max(0, turn_start - older_budget)
            # 对齐到 turnHeader，禁止 older 从 mid-tool 起刀（会丢上一问用户气泡）
            older_start = V4ConversationHub._align_snapshot_window_start(rows, older_start)
            if older_start > turn_start:
                older_start = turn_start
            older = [r for r in rows[older_start:] if int(r.get("rowId") or 0) not in live_ids]
            return [*older, *live_turn]
        head = live_turn[: live_user_pos + 1]
        after_user = live_turn[live_user_pos + 1 :]
        if not after_user:
            older_budget = max(0, cap - len(head))
            older_start = max(0, turn_start - older_budget)
            older_start = V4ConversationHub._align_snapshot_window_start(rows, older_start)
            if older_start > turn_start:
                older_start = turn_start
            older = [r for r in rows[older_start:] if int(r.get("rowId") or 0) not in live_ids]
            return [*older, *head]
        tip = after_user[0]
        tip_id = int(tip.get("rowId") or 0)
        for row in after_user[1:]:
            rid = int(row.get("rowId") or 0)
            if rid >= tip_id:
                tip = row
                tip_id = rid
        inflight = [r for r in after_user if V4ConversationHub._row_is_inflight(r)]
        inflight_ids = {int(r.get("rowId") or 0) for r in inflight}
        settled = [r for r in after_user if int(r.get("rowId") or 0) not in inflight_ids]
        tip_is_inflight = tip_id in inflight_ids
        after_budget = max(0, cap - len(head))
        reserved = len(inflight) + (0 if tip_is_inflight else 1)
        if reserved >= after_budget:
            # in-flight 顶满：硬保 tip + 最近一段 in-flight（可略超，优先 tip 可见）
            room = max(0, after_budget - 1)
            rest_inflight = [r for r in inflight if int(r.get("rowId") or 0) != tip_id]
            keep_ids = {int(r.get("rowId") or 0) for r in rest_inflight[-room:]}
            keep_ids.add(tip_id)
            return [*head, *[r for r in after_user if int(r.get("rowId") or 0) in keep_ids]]
        tip_slot = 0 if tip_is_inflight else 1
        tail_budget = max(0, after_budget - len(inflight) - tip_slot)
        settled_no_tip = [r for r in settled if int(r.get("rowId") or 0) != tip_id]
        tail = settled_no_tip[-tail_budget:] if tail_budget else []
        keep_ids = {
            int(r.get("rowId") or 0) for r in (*inflight, *tail)
        }
        keep_ids.add(tip_id)
        return [*head, *[r for r in after_user if int(r.get("rowId") or 0) in keep_ids]]

    @staticmethod
    def _snapshot_tail_window(
        rows: list[dict[str, Any]],
        *,
        pin_live_turn: bool = False,
    ) -> list[dict[str, Any]]:
        """快照 rows.window 截断：尾部 _SNAPSHOT_TAIL_ROWS 行，字节超限再对半收缩。

        字节只量 rows（快照壳为固定 KB 级）；预算收缩到下限后即使仍超限也照发——
        客户端 hasOlderRows/滚动补拉不依赖帧大小，单行爆帧只在日志暴露。

        截断后起点对齐 turn 边界，避免窗顶挂着上一轮半截 assistantText。

        ``pin_live_turn``：本轮仍在跑时钉住直播轮（header+user+轮尾），不能只钉
        两个锚点——否则中间已显示的 assistantText 会从 snapshot 里蒸发。
        """
        if len(rows) <= _SNAPSHOT_TAIL_ROWS:
            window = rows
        else:
            take = _SNAPSHOT_TAIL_ROWS
            while True:
                start = len(rows) - take
                start = V4ConversationHub._align_snapshot_window_start(rows, start)
                window = rows[start:]
                try:
                    window_bytes = len(
                        json.dumps(window, ensure_ascii=False, separators=(",", ":"))
                    )
                except (TypeError, ValueError):  # pragma: no cover - 行数据不可序列化
                    break
                if window_bytes <= _SNAPSHOT_MAX_BYTES or take <= _SNAPSHOT_MIN_TAIL_ROWS:
                    if take < _SNAPSHOT_TAIL_ROWS or start != len(rows) - take:
                        logger.info(
                            "[v4.snapshot] window rows=%d start=%d bytes=%.1fKB",
                            len(window),
                            start,
                            window_bytes / 1024.0,
                        )
                    break
                take = max(_SNAPSHOT_MIN_TAIL_ROWS, take // 2)

        if not pin_live_turn or not rows:
            return window

        return V4ConversationHub._pin_live_turn_into_window(
            rows, window, soft_cap=max(len(window), _SNAPSHOT_TAIL_ROWS)
        )

    def _enqueue_prebuilt_snapshot_locked(
        self,
        sub: _Subscription,
        sess: _SessionState,
        snapshot: dict[str, Any],
        *,
        delivery_kind: str,
    ) -> None:
        """Enqueue a snapshot already built off-loop. Caller holds ``_lock``."""
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
        window = (snapshot.get("rows") or {}).get("window") or []
        logger.info(
            "[v4.flush] snapshot session=%s sub=%s seq=%d rows=%d kind=%s",
            sess.session_id,
            sub.subscription_id,
            sess.seq,
            len(window),
            delivery_kind,
        )

    def _enqueue_snapshot_locked(
        self,
        sub: _Subscription,
        sess: _SessionState,
        *,
        delivery_kind: str,
    ) -> None:
        """调用方必须已持有 ``_write_lock`` / ``_lock``。"""
        snapshot = self._build_snapshot(sess)
        self._enqueue_prebuilt_snapshot_locked(
            sub, sess, snapshot, delivery_kind=delivery_kind
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
        if command_type == "sendGoalCommand":
            return self._handle_send_goal_command(sess, command_id, payload)
        if command_type == "pauseGoal":
            return self._handle_pause_goal(sess, command_id)
        if command_type == "resumeGoal":
            return self._handle_resume_goal(sess, command_id)
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
        if payload.get("planEnabled"):
            # Plan/Goal 互斥（对齐 ZCode guard.planGoalMutuallyExclusive）：
            # 活跃目标存在时不得以 Plan 意图提交。
            try:
                from app.gateway.v4.goal_engine import get_v4_goal_engine

                state = get_v4_goal_engine().get_goal_state(sess.session_id)
            except Exception:
                state = None
            if state is not None and state.get("status") in ("active", "verifying", "paused"):
                return self._reject(
                    command_id,
                    "guard.planGoalMutuallyExclusive",
                    "Plan and Goal cannot be active at the same time.",
                )

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

    # -- goal 命令组（ZCode 目标模式：sendGoalCommand / pauseGoal / resumeGoal）--

    def _handle_send_goal_command(
        self,
        sess: _SessionState,
        command_id: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        from app.gateway.v4.goal_engine import GoalRejectedError, get_v4_goal_engine

        objective = str(payload.get("text") or "").strip()
        if not objective:
            return self._reject(command_id, "emptyObjective", "Usage: /goal <objective>")
        engine = get_v4_goal_engine()
        try:
            outcome = engine.set_goal(sess.session_id, objective, intent=dict(payload))
        except GoalRejectedError as exc:
            return self._reject(command_id, exc.reason_code, exc.message)
        sess.revision += 1
        return self._accept(
            command_id,
            sess.revision,
            result={
                "type": "sendGoalCommand",
                "goal": outcome.get("goal"),
                "started": bool(outcome.get("started")),
                "input": {
                    "delivery": "startNow" if outcome.get("started") else "deferred",
                    "inputId": command_id,
                },
            },
        )

    def _handle_pause_goal(self, sess: _SessionState, command_id: str) -> dict[str, Any]:
        from app.gateway.v4.goal_engine import get_v4_goal_engine

        state = get_v4_goal_engine().pause_goal(sess.session_id)
        if state is None:
            return self._noop(command_id, "noGoalToPause")
        sess.revision += 1
        return self._accept(command_id, sess.revision, result={"type": "pauseGoal", "goal": state})

    def _handle_resume_goal(self, sess: _SessionState, command_id: str) -> dict[str, Any]:
        from app.gateway.v4.goal_engine import GoalRejectedError, get_v4_goal_engine

        engine = get_v4_goal_engine()
        try:
            state = engine.resume_goal(sess.session_id)
        except GoalRejectedError as exc:
            return self._reject(command_id, exc.reason_code, exc.message)
        if state is None:
            return self._noop(command_id, "noGoalToResume")
        sess.revision += 1
        return self._accept(command_id, sess.revision, result={"type": "resumeGoal", "goal": state})

    # -- stop / abort ----------------------------------------------------------

    def _handle_stop(self, sess: _SessionState, command_id: str) -> dict[str, Any]:
        # ZCode stopPausesActiveGoalTarget：stop 作用于前台工作时活跃目标进 paused。
        # 放在 turn_running 判定之前——镜像 run（前端直发）不走 hub turn_task，
        # 但 stop 意图同样应暂停目标。
        try:
            from app.gateway.v4.goal_engine import get_v4_goal_engine

            get_v4_goal_engine().on_stop(sess.session_id)
        except Exception:
            logger.debug("[v4-conversation] goal on_stop failed session=%s", sess.session_id, exc_info=True)
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
