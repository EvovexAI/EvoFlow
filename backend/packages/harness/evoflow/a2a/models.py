"""A2A protocol data models (Pydantic v2).

Mirrors the A2A (Agent-to-Agent) Protocol v0.3 data structures so the
internal ``dispatch_task`` pipeline can be exposed with standard A2A
semantics.  No I/O here - pure data shapes.
"""

from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


# ── Task lifecycle ──────────────────────────────────────────


class TaskState(str, Enum):
    """A2A standard Task state machine."""

    SUBMITTED = "submitted"
    WORKING = "working"
    INPUT_REQUIRED = "input-required"
    COMPLETED = "completed"
    CANCELED = "canceled"
    FAILED = "failed"


class TaskStatus(BaseModel):
    state: TaskState = TaskState.SUBMITTED
    timestamp: str = ""
    message: dict[str, Any] | None = None


# ── Message & Parts ─────────────────────────────────────────


class TextPart(BaseModel):
    type: str = "text"
    text: str = ""


class DataPart(BaseModel):
    type: str = "data"
    data: dict[str, Any] = Field(default_factory=dict)


class FilePart(BaseModel):
    type: str = "file"
    uri: str = ""
    name: str = ""


class A2AMessage(BaseModel):
    role: str = "user"  # "user" | "agent"
    parts: list[dict[str, Any]] = Field(default_factory=list)
    taskId: str = ""
    messageId: str = ""


class A2AArtifact(BaseModel):
    name: str = ""
    parts: list[dict[str, Any]] = Field(default_factory=list)


class A2ATask(BaseModel):
    """A2A standard Task object."""

    id: str
    sessionId: str = ""
    status: TaskStatus = Field(default_factory=TaskStatus)
    messages: list[A2AMessage] = Field(default_factory=list)
    artifacts: list[A2AArtifact] = Field(default_factory=list)
    # EvoFlow extensions (non-standard, prefixed)
    agent_code: str = ""
    role_name: str = ""
    subscribeUrl: str = ""


# ── Agent Card ─────────────────────────────────────────────


class AgentSkill(BaseModel):
    id: str = ""
    name: str = ""
    description: str = ""
    tags: list[str] = Field(default_factory=list)
    examples: list[str] = Field(default_factory=list)


class AgentCapabilities(BaseModel):
    streaming: bool = True
    pushNotifications: bool = False
    stateTransitionHistory: bool = True


class AgentCard(BaseModel):
    """A2A standard Agent Card."""

    name: str = ""
    description: str = ""
    url: str = ""
    version: str = "1.0.0"
    capabilities: AgentCapabilities = Field(default_factory=AgentCapabilities)
    defaultInputModes: list[str] = Field(default_factory=lambda: ["text/plain"])
    defaultOutputModes: list[str] = Field(
        default_factory=lambda: ["text/plain", "application/json"]
    )
    skills: list[AgentSkill] = Field(default_factory=list)
    # EvoFlow extensions
    agent_code: str = ""
    department: str = ""
    workspace: str = ""
    model: str = ""
    tools: list[str] = Field(default_factory=list)


# ── JSON-RPC 2.0 ───────────────────────────────────────────


class JSONRPCRequest(BaseModel):
    jsonrpc: str = "2.0"
    method: str = ""
    params: dict[str, Any] = Field(default_factory=dict)
    id: str | int | None = None


class JSONRPCError(BaseModel):
    code: int
    message: str
    data: Any | None = None


class JSONRPCResponse(BaseModel):
    jsonrpc: str = "2.0"
    result: Any | None = None
    error: JSONRPCError | None = None
    id: str | int | None = None


# ── Meeting models ──────────────────────────────────────────


class MeetingParticipant(BaseModel):
    agent_code: str
    role_name: str = ""
    agent_card: dict[str, Any] | None = None


class CreateMeetingRequest(BaseModel):
    title: str = ""
    participants: list[str] = Field(default_factory=list)
    session_key: str = ""


class DiscussRequest(BaseModel):
    topic: str = ""
    speaker_order: list[str] | None = None


class MentionRequest(BaseModel):
    agent_code: str = ""
    text: str = ""
