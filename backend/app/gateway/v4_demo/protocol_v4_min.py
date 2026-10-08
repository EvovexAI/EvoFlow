"""H1 demo: 极简 v4 conversation topic frame schemas。

仅覆盖 ``H1 端到端一个 session 一条消息`` demo 必需字段：
- ``subscriptionId``、``logEpoch``、``fromSeq``、``toSeq``、``payload``
- ``ConversationSnapshot`` 最低限度（rows.window, seq, logEpoch, sessionId）
- ``ConversationRow`` 最低支持：``turnHeader`` / ``userInput`` / ``assistantText`` /
  ``reasoning`` / ``toolCall``
- ``ConversationDelta``: ``row.appended`` / ``row.upserted`` / ``row.removed``

完整 v4 schema 见 ``ZCode/packages/shared/src/zcode-protocol-v4/``。

H1 简化：frame.payload 直接是 ``dict[str, Any]``，由 dispatcher（前后端都从
``payload[kind]`` 自查）分发到对应 row 类型。落地到 EvoFlow 时再升级为 zod/pydantic
discriminator。
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


# -- 行级 -----------------------------------------------------------------


class _RowBase(BaseModel):
    model_config = ConfigDict(extra="allow")
    rowId: int
    turnId: str
    createdAt: int
    createdAtSeq: int


class TurnHeaderRow(_RowBase):
    kind: Literal["turnHeader"] = "turnHeader"
    origin: Literal["userInput"] = "userInput"
    state: Literal["running", "completedSuccess", "completedInterrupted", "failed"] = "running"
    startedAt: int
    endedAt: int | None = None


class UserInputRow(_RowBase):
    kind: Literal["userInput"] = "userInput"
    text: str
    origin: Literal["realUser"] = "realUser"


class AssistantTextRow(_RowBase):
    kind: Literal["assistantText"] = "assistantText"
    state: Literal["streaming", "complete", "interrupted", "failed"] = "streaming"
    text: str


class ReasoningRow(_RowBase):
    kind: Literal["reasoning"] = "reasoning"
    state: Literal["streaming", "complete", "interrupted"] = "streaming"
    text: str


class ToolCallRow(_RowBase):
    kind: Literal["toolCall"] = "toolCall"
    toolName: str
    status: Literal["inputStreaming", "pendingApproval", "running", "success", "error", "cancelled"] = "running"
    inputText: str = ""


# -- Snapshot payload -----------------------------------------------------


class RowsWindow(BaseModel):
    model_config = ConfigDict(extra="allow")
    window: list[dict[str, Any]] = Field(default_factory=list)
    firstRowId: int | None = None
    totalCount: int = 0


class ConversationSnapshot(BaseModel):
    """整块替换的 projection。客户端整对象替换，绝不 merge 局部字段。"""
    sessionId: str
    logEpoch: str
    seq: int
    rows: RowsWindow
    kind: Literal["conversationSnapshot"] = "conversationSnapshot"


class ConversationDeltas(BaseModel):
    """增量 row 集合。``deltas[i].op`` 决定是 append/upsert/remove。"""
    deltas: list[dict[str, Any]] = Field(default_factory=list)
    kind: Literal["conversationDeltas"] = "conversationDeltas"


# -- Wire frame ------------------------------------------------------------


class ConversationTopicFrame(BaseModel):
    """v4 wire frame。H1 demo: payload 是 dict, dispatcher 自查 ``payload["kind"]``。"""
    model_config = ConfigDict(extra="allow")
    subscriptionId: str
    logEpoch: str
    fromSeq: int
    toSeq: int
    payload: dict[str, Any]


class V4ConversationSubscribeAck(BaseModel):
    subscriptionId: str
    mode: Literal["snapshot", "resume"]
    logEpoch: str
