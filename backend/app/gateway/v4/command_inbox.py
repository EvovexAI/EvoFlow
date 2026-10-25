"""V4 command inbox — ZCode ``bootstrap/zcode-protocol-v4/command-inbox.ts`` 的 Python 语义移植。

对齐点（非逐行，语义基准为 v3.15.1 上游）：

- **三类事实严格分离**：in-flight（执行中，pinned）/ live input（已入队输入，pinned）/
  settled（已终态，LRU 512/session）。旧单表 LRU 会在 churn 时淘汰在途命令导致重放重执行，
  上游以「先 pin 再执行」修复——这里同样先 pin。
- **per-session FIFO admission**：key gate → session gate 固定锁序；session gate 持有到
  ``settle`` 才释放，同 session 不同 commandId 按 admission 实际到达顺序串行。
- **CAS guard**：``COMMANDS_REQUIRING_BASE_REVISION`` 中的命令必须携带 baseRevision，
  与当前 revision 不一致 → ``stale``；缺失 → ``rejected proto.missingBaseRevision``。
- **幂等重放**：重复 commandId 返回既有终态；``failed`` 是终态事实不得被覆盖为
  ``duplicate``，其余终态重放时标记 ``duplicate``。
- **query**：批量幂等查询（对齐 ``POST /command/query``）；查不到 → ``unknown``。

EvoFlow 简化（本阶段）：持久化事实回源（transcript/timeline/child/discarded lookup）不接——
hub 是进程内权威，进程重启即丢，与 queue「不持久化」裁决一致。
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any, Callable

logger = logging.getLogger(__name__)

# 对齐 vendored zcode-protocol-v4/command.ts COMMANDS_REQUIRING_BASE_REVISION。
COMMANDS_REQUIRING_BASE_REVISION: frozenset[str] = frozenset(
    {
        "applyFileRewind",
        "forkAssistant",
        "editUserQuery",
        "retryTurn",
        "setAssistantFeedback",
        "sendQueuedNow",
        "editQueueItem",
        "reorderQueueItem",
        "deleteQueueItem",
        "setAutoDrain",
        "switchModelConfig",
        "switchCollaborationMode",
        "setFollowupMode",
        "pauseGoal",
        "resumeGoal",
    }
)

# 对齐 vendored ROW_TARGETING_COMMANDS（本阶段 hub 无 row-targeting 实现，仅守卫用）。
ROW_TARGETING_COMMANDS: frozenset[str] = frozenset(
    {"applyFileRewind", "forkAssistant", "editUserQuery", "retryTurn", "setAssistantFeedback"}
)

SETTLED_LRU_PER_SESSION = 512

_GLOBAL_BUCKET = "@global"


def queue_item_id_for_command(command_id: str) -> str:
    return f"queue_{command_id}"


@dataclass
class _InFlightEntry:
    ack: dict[str, Any]
    final: asyncio.Future = field(default_factory=lambda: asyncio.get_event_loop().create_future())


@dataclass
class _LiveInputEntry:
    ack: dict[str, Any]


class _AsyncGateRegistry:
    """FIFO async gate（移植上游 AsyncGateRegistry：显式 release 跨过 execute）。

    ``acquire`` 等前任 tail 完成后立刻持有 gate，返回显式 ``release``——调用方必须
    在 settle 时调用，此后下一位 acquirer 才被放行。普通锁在 handle 返回时即放行，
    无法表达"admission gate 持有到 settle"。
    """

    def __init__(self) -> None:
        self._tails: dict[str, asyncio.Future] = {}

    async def acquire(self, key: str) -> Callable[[], None]:
        loop = asyncio.get_running_loop()
        previous = self._tails.get(key)
        release_event = asyncio.Event()
        tail: asyncio.Future = loop.create_future()

        async def _resolve_tail() -> None:
            if previous is not None:
                try:
                    await previous
                except Exception:  # noqa: BLE001 — 前驱异常不阻断后续 admission
                    pass
            await release_event.wait()
            if not tail.done():
                tail.set_result(None)

        loop.create_task(_resolve_tail())
        # 先存 tail 再 await previous：并发 acquire 必须链到本 tail，否则互斥失效。
        self._tails[key] = tail
        if previous is not None:
            try:
                await previous
            except Exception:  # noqa: BLE001
                pass

        def release() -> None:
            release_event.set()
            if self._tails.get(key) is tail:
                self._tails.pop(key, None)

        return release


@dataclass
class CommandInboxOutcome:
    kind: str  # "ack" | "execute"
    ack: dict[str, Any] | None = None
    envelope: dict[str, Any] | None = None
    admission_seq: int = 0
    admitted_at: int = 0
    queue_item_id: str = ""
    _settle: Callable[[dict[str, Any]], None] | None = None

    def settle(self, final_ack: dict[str, Any]) -> None:
        if self._settle is not None:
            self._settle(final_ack)


class CommandInboxHost:
    """hub 侧注入的最小查询面（对齐上游 CommandInboxHost 的必选子集）。"""

    def get_revision(self, session_id: str) -> int | None:  # pragma: no cover - 接口
        raise NotImplementedError

    def get_log_epoch(self, session_id: str) -> str | None:  # pragma: no cover - 接口
        raise NotImplementedError


class CommandInbox:
    def __init__(self, host: CommandInboxHost) -> None:
        self._host = host
        self._in_flight: dict[str, dict[str, _InFlightEntry]] = {}
        self._live_inputs: dict[str, dict[str, _LiveInputEntry]] = {}
        self._settled: dict[str, OrderedDict[str, dict[str, Any]]] = {}
        self._admission_seq: dict[str, int] = {}
        self._key_gates = _AsyncGateRegistry()
        self._session_gates = _AsyncGateRegistry()

    # -- 入口 -----------------------------------------------------------------

    async def handle(self, envelope: dict[str, Any]) -> CommandInboxOutcome:
        command_id = str(envelope.get("commandId") or "")
        command_type = str(envelope.get("type") or "")
        if not command_id or not command_type:
            return self._ack_only(
                self._reject_ack(command_id, "proto.invalidPayload", "commandId/type required")
            )
        session_id = envelope.get("sessionId")
        bucket = self._bucket(session_id)
        key = f"{bucket}\0{command_id}"

        release_key = await self._key_gates.acquire(key)
        try:
            pinned = self._in_flight.get(bucket, {}).get(command_id)
            if pinned is not None:
                return self._ack_only(self._retry_ack(await pinned.final))
            existing = self._lookup_exact(bucket, command_id)
            if existing is not None:
                return self._ack_only(self._retry_ack(existing))

            release_session = await self._session_gates.acquire(bucket)
            try:
                # 等 session gate 期间同 key 可能已被并发 admission pin。
                after_wait = self._in_flight.get(bucket, {}).get(command_id)
                if after_wait is not None:
                    release_session()
                    return self._ack_only(self._retry_ack(await after_wait.final))
                after_wait = self._lookup_exact(bucket, command_id)
                if after_wait is not None:
                    release_session()
                    return self._ack_only(self._retry_ack(after_wait))

                decision = self._decide(envelope, command_type)
                if decision["kind"] == "ack":
                    ack = decision["ack"]
                    if decision.get("remember"):
                        self._remember_settled(bucket, command_id, ack)
                    release_session()
                    return self._ack_only(ack)

                next_seq = self._admission_seq.get(bucket, 0) + 1
                self._admission_seq[bucket] = next_seq
                entry = _InFlightEntry(ack=decision["ack"])
                self._in_flight.setdefault(bucket, {})[command_id] = entry

                def settle(final_ack: dict[str, Any]) -> None:
                    merged = {**decision["ack"], **final_ack}
                    self._in_flight.get(bucket, {}).pop(command_id, None)
                    if bucket in self._live_inputs and command_id in self._live_inputs[bucket]:
                        self._live_inputs[bucket][command_id].ack = merged
                    else:
                        self._remember_settled(bucket, command_id, merged)
                    if not entry.final.done():
                        entry.final.set_result(merged)
                    release_session()

                release_key()  # 已 pin，key gate 提前释放（对齐上游）
                return CommandInboxOutcome(
                    kind="execute",
                    ack=decision["ack"],
                    envelope=envelope,
                    admission_seq=next_seq,
                    admitted_at=int(time.time() * 1000),
                    queue_item_id=queue_item_id_for_command(command_id),
                    _settle=settle,
                )
            except Exception:
                release_session()
                raise
        except Exception:  # noqa: BLE001 — admission 面故障必须收敛为 failed ack
            logger.exception("[v4.inbox] handle failed command=%s type=%s", command_id, command_type)
            return self._ack_only(
                {
                    "commandId": command_id,
                    "status": "failed",
                    "reasonCode": "fault.command.queryUnavailable",
                    "revisionAtDecision": 0,
                }
            )
        finally:
            release_key()

    async def query(self, keys: list[dict[str, Any]]) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for key in keys:
            command_id = str(key.get("commandId") or "")
            bucket = self._bucket(key.get("sessionId"))
            ack = self._lookup_exact(bucket, command_id)
            out.append({"key": key, "result": ack if ack is not None else "unknown"})
        return out

    # -- live input pin（queue/guide admission 后 pin 同一 intent 的 ack）──────

    def pin_live_input(self, session_id: str, command_id: str, ack: dict[str, Any]) -> None:
        bucket = self._bucket(session_id)
        self._live_inputs.setdefault(bucket, {})[command_id] = _LiveInputEntry(ack=ack)
        self._settled.get(bucket, OrderedDict()).pop(command_id, None)

    def release_live_input(self, session_id: str, command_id: str, final_ack: dict[str, Any] | None = None) -> None:
        bucket = self._bucket(session_id)
        bucket_map = self._live_inputs.get(bucket)
        if bucket_map is None:
            return
        entry = bucket_map.pop(command_id, None)
        ack = final_ack or (entry.ack if entry else None)
        if ack is not None:
            self._remember_settled(bucket, command_id, ack)

    # -- 内部 -----------------------------------------------------------------

    def _decide(self, envelope: dict[str, Any], command_type: str) -> dict[str, Any]:
        session_id = envelope.get("sessionId")
        revision = 0 if session_id is None else self._host.get_revision(str(session_id))
        if revision is None or (command_type != "createSession" and session_id is None):
            return {
                "kind": "ack",
                "remember": False,
                "ack": {
                    "commandId": str(envelope.get("commandId") or ""),
                    "status": "rejected",
                    "reasonCode": "proto.sessionNotFound",
                    "revisionAtDecision": 0,
                },
            }
        ack_revision = revision

        def _ack(status: str, reason: str) -> dict[str, Any]:
            return {
                "kind": "ack",
                "remember": False,
                "ack": {
                    "commandId": str(envelope.get("commandId") or ""),
                    "status": status,
                    "reasonCode": reason,
                    "revisionAtDecision": ack_revision,
                },
            }

        if command_type in COMMANDS_REQUIRING_BASE_REVISION:
            base_revision = envelope.get("baseRevision")
            if base_revision is None:
                return _ack("rejected", "proto.missingBaseRevision")
            if command_type in ROW_TARGETING_COMMANDS:
                epoch = None if session_id is None else self._host.get_log_epoch(str(session_id))
                if str(envelope.get("baseLogEpoch") or "") != (epoch or ""):
                    return _ack("stale", "proto.staleLogEpoch")
            if int(base_revision) != ack_revision:
                return _ack("stale", "proto.staleRevision")

        return {
            "kind": "execute",
            "ack": {
                "commandId": str(envelope.get("commandId") or ""),
                "status": "accepted",
                "revisionAtDecision": ack_revision,
            },
        }

    def _lookup_exact(self, bucket: str, command_id: str) -> dict[str, Any] | None:
        inflight = self._in_flight.get(bucket, {}).get(command_id)
        if inflight is not None:
            return None  # 执行中：duplicate 由 pinned 分支 await final，不在此读中间态
        live = self._live_inputs.get(bucket, {}).get(command_id)
        if live is not None:
            return live.ack
        settled = self._settled.get(bucket, OrderedDict()).get(command_id)
        if settled is not None:
            bucket_map = self._settled[bucket]
            bucket_map.move_to_end(command_id)
            return settled
        return None

    def _remember_settled(self, bucket: str, command_id: str, ack: dict[str, Any]) -> None:
        bucket_map = self._settled.setdefault(bucket, OrderedDict())
        bucket_map.pop(command_id, None)
        bucket_map[command_id] = ack
        while len(bucket_map) > SETTLED_LRU_PER_SESSION:
            bucket_map.popitem(last=False)

    @staticmethod
    def _ack_only(ack: dict[str, Any]) -> CommandInboxOutcome:
        return CommandInboxOutcome(kind="ack", ack=ack)

    def _retry_ack(self, ack: dict[str, Any]) -> dict[str, Any]:
        if ack.get("status") == "failed":
            return dict(ack)
        return {**ack, "status": "duplicate"}

    @staticmethod
    def _bucket(session_id: Any) -> str:
        return _GLOBAL_BUCKET if session_id is None or str(session_id) == "" else str(session_id)
