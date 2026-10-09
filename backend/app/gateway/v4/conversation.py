"""V4 conversation hub — ZCode v4 wire 协议的 EvoFlow 服务端实现。

对齐 ``evopanel/src/zcode-shared/zcode-protocol-v4/`` 的 zod schema（契约模板由
``evopanel/tests/tmp-gen-minimal-snapshot.test.ts`` zod 驱动生成并验证）：

- subscribe/unsubscribe：ACK-only；initial snapshot 作为后续 SSE 帧下发。
- frames：SSE 下发 ``ConversationTopicWireCandidate``（wireVersion=3, kind=complete）。
- command：``CommandEnvelope`` -> ``CommandAck``；createSession / sendText 走
  echo 或 OpenAI 兼容真实 LLM 流（``EVOFLOW_V4_LLM=1``）。

不变量（docs/protocol-evolution-spec.md §0.2）：
1. snapshot 整体替换，绝不 merge；
2. delta 帧 ``fromSeq === state.seq`` 才 apply（这里 seq 由 hub 单调分配保证）；
3. base 与状态同生共死——subscribe 后首帧必为完整 snapshot。
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)

V4_WIRE_PROTOCOL_VERSION = 3

_PHASE_DRAFT = "draft"
_PHASE_RUNNING = "running"
_PHASE_COMPLETED = "completedSuccess"
_PHASE_ERROR = "error"

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


def _minimal_queue() -> dict[str, Any]:
    return {"items": [], "autoDrain": True}


def _minimal_config() -> dict[str, Any]:
    return {
        "provider": "evoflow",
        "model": os.getenv("EVOFLOW_LLM_MODEL", "evoflow-default"),
        "thought": "",
        "followupMode": "queue",
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

    def control(self) -> dict[str, Any]:
        return _minimal_control(self.phase)


@dataclass
class _Subscription:
    subscription_id: str
    session_id: str
    connection_id: str
    topic: str
    queue: list[dict[str, Any]] = field(default_factory=list)
    logical_frame_ordinal: int = 0
    delivered_seq: int = -1
    """本订阅已投递到的 seq（去重用）。"""

    def next_ordinal(self) -> int:
        self.logical_frame_ordinal += 1
        return self.logical_frame_ordinal


class V4ConversationHub:
    """进程内单例：session 状态 + 订阅 + wire 帧队列。

    frames SSE 端点按 connectionId 长轮询所有订阅的队列；帧一旦入队即保序。
    """

    def __init__(self) -> None:
        self._sessions: dict[str, _SessionState] = {}
        self._subscriptions: dict[str, _Subscription] = {}
        self._lock = asyncio.Lock()

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
        sub.logical_frame_ordinal += 1
        snapshot = self._build_snapshot(sess)
        frame = {
            "topic": sub.topic,
            "subscriptionId": sub.subscription_id,
            "fromSeq": 0,
            "toSeq": sess.seq,
            "sentAt": int(time.time() * 1000),
            "payload": {"kind": "snapshot", "snapshot": snapshot},
        }
        sub.queue.append(self._wrap_wire(sub, frame, "recovery"))
        sub.delivered_seq = sess.seq
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
    ) -> dict[str, Any]:
        sess = self._get_or_create_session(session_id)
        subscription_id = f"sub-{uuid.uuid4().hex[:10]}"
        topic = f"conversation/{sess.session_id}"
        sub = _Subscription(
            subscription_id=subscription_id,
            session_id=sess.session_id,
            connection_id=connection_id,
            topic=topic,
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
                    del self._subscriptions[existing_id]
            self._subscriptions[subscription_id] = sub
        # 不变量 3：subscribe 后首帧必为完整 snapshot（base/resume 暂不支持，恒 snapshot）。
        self._enqueue_snapshot(sub, sess)
        return {
            "ack": {
                "subscriptionId": subscription_id,
                "mode": "snapshot",
                "logEpoch": sess.log_epoch,
            }
        }

    async def unsubscribe(self, *, subscription_id: str) -> None:
        async with self._lock:
            self._subscriptions.pop(subscription_id, None)

    def poll_frames(self, connection_id: str) -> list[dict[str, Any]]:
        """取走该连接所有订阅的待发帧（FIFO 保序）。"""
        out: list[dict[str, Any]] = []
        for sub in list(self._subscriptions.values()):
            if sub.connection_id != connection_id:
                continue
            out.extend(sub.queue)
            sub.queue.clear()
        return out

    # -- 帧构造 ---------------------------------------------------------------

    def _build_snapshot(self, sess: _SessionState) -> dict[str, Any]:
        rows = sorted(sess.rows.values(), key=lambda r: r["rowId"])
        return {
            "protocolVersion": 1,
            "sessionId": sess.session_id,
            "logEpoch": sess.log_epoch,
            "seq": sess.seq,
            "revision": sess.revision,
            "control": sess.control(),
            "availability": _minimal_availability(),
            "inputRouting": {"mode": "startNow"},
            "meta": {
                "title": sess.title,
                "titleSource": "generated" if sess.title else "default",
            },
            "config": _minimal_config(),
            "modelTransition": None,
            "usage": _minimal_usage(),
            "queue": _minimal_queue(),
            "pendingInteractions": [],
            "pendingCommands": [],
            "backgroundWorks": [],
            "goal": None,
            "plan": None,
            "rows": {
                "window": rows,
                "totalCount": len(rows),
                "firstRowId": rows[0]["rowId"] if rows else 0,
            },
        }

    def _enqueue_snapshot(self, sub: _Subscription, sess: _SessionState) -> None:
        snapshot = self._build_snapshot(sess)
        frame = {
            "topic": sub.topic,
            "subscriptionId": sub.subscription_id,
            "fromSeq": 0,
            "toSeq": sess.seq,
            "sentAt": int(time.time() * 1000),
            "payload": {"kind": "snapshot", "snapshot": snapshot},
        }
        sub.queue.append(self._wrap_wire(sub, frame, "initial"))
        sub.delivered_seq = sess.seq

    def _enqueue_deltas(
        self,
        sess: _SessionState,
        deltas: list[dict[str, Any]],
    ) -> None:
        """把一批 delta 广播到该 session 的全部活跃订阅。"""
        if not deltas:
            return
        from_seq = sess.seq
        sess.seq += 1
        to_seq = sess.seq
        subs = [s for s in self._subscriptions.values() if s.session_id == sess.session_id]
        if not subs:
            return
        frame = {
            "topic": subs[0].topic,
            "subscriptionId": "",  # 逐订阅填充
            "fromSeq": from_seq,
            "toSeq": to_seq,
            "sentAt": int(time.time() * 1000),
            "payload": {"kind": "deltas", "deltas": deltas},
        }
        for sub in subs:
            per_sub = dict(frame)
            per_sub["subscriptionId"] = sub.subscription_id
            sub.queue.append(self._wrap_wire(sub, per_sub, "online"))
            sub.delivered_seq = to_seq

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

    async def send_command(self, envelope: dict[str, Any]) -> dict[str, Any]:
        command_type = str(envelope.get("type", ""))
        command_id = str(envelope.get("commandId", ""))
        payload = envelope.get("payload") or {}

        if command_type == "createSession":
            return self._handle_create_session(command_id, payload)

        if command_type == "sendText":
            session_id = str(envelope.get("sessionId") or "")
            sess = self._sessions.get(session_id)
            if sess is None:
                return self._reject(command_id, "sessionNotFound", f"unknown session {session_id}")
            text = str(payload.get("text", ""))
            if not text.strip():
                return self._reject(command_id, "emptyInput", "text is empty")
            if sess.turn_task is not None and not sess.turn_task.done():
                return self._reject(command_id, "busy", "a turn is already running")
            if not sess.title:
                sess.title = text[:24]
            sess.revision += 1
            revision = sess.revision
            self._start_turn(sess, text)
            return {
                "commandId": command_id,
                "status": "accepted",
                "revisionAtDecision": revision,
            }

        # 其余命令（abort/fork/steer/...）H3-C 逐步补齐；先显式拒绝。
        return self._reject(command_id, "unsupportedCommand", f"{command_type} not implemented yet")

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

    # -- 回合执行（echo / 真实 LLM，复用 H1 demo 语义）-------------------------

    def _start_turn(self, sess: _SessionState, text: str) -> None:
        sess.turn_task = asyncio.create_task(self._run_turn(sess, text))

    def _append_row(self, sess: _SessionState, row: dict[str, Any]) -> None:
        sess.rows[int(row["rowId"])] = row
        self._enqueue_deltas(sess, [{"op": "row.appended", "row": row}])

    def _append_text_delta(self, sess: _SessionState, row_id: int, path: str, chunk: str) -> None:
        self._enqueue_deltas(sess, [{"op": "row.delta", "rowId": row_id, "path": path, "append": chunk}])

    def _upsert_row(self, sess: _SessionState, row: dict[str, Any]) -> None:
        sess.rows[int(row["rowId"])] = row
        self._enqueue_deltas(sess, [{"op": "row.upserted", "row": row}])

    def _patch_phase(self, sess: _SessionState, phase: str) -> None:
        sess.phase = phase
        self._enqueue_deltas(
            sess,
            [{"op": "state.updated", "patch": {"control": _minimal_control(phase)}}],
        )

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
            raise
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

    async def _generate(self, sess: _SessionState, text: str, assistant_rid: int) -> str:
        """echo 或真实 LLM（``EVOFLOW_V4_LLM=1`` + ``EVOFLOW_LLM_BASE_URL``）。"""
        if os.getenv("EVOFLOW_V4_LLM", "").strip() not in ("1", "true", "yes"):
            target = (
                f"Echo from EvoFlow v4 shell: 我收到了「{text}」。"
                "这是 ZCode v4 协议链路（wire v3 → topicWireDecoder → projection store）。"
            )
            # chunk 64 字符 / 8ms = ~8KB/s，肉眼跟得上但不耗 CPU。
            for i in range(0, len(target), 64):
                self._append_text_delta(sess, assistant_rid, "text", target[i : i + 64])
                await asyncio.sleep(0.008)
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
