"""ACP session domain models for supervisor orchestration."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any


def _utc_now() -> str:
    return datetime.now(UTC).isoformat()


class AcpSessionStatus(StrEnum):
    STARTING = "starting"
    RUNNING = "running"
    STREAMING = "streaming"
    WAITING_INPUT = "waiting_input"
    COMPLETED = "completed"
    FAILED = "failed"
    CLOSED = "closed"


@dataclass
class AcpSessionRecord:
    """In-memory ACP session record bound to supervisor/subtask context."""

    supervisor_session_id: str
    provider: str
    acp_session_id: str | None = None
    thread_id: str | None = None
    task_id: str | None = None
    subtask_id: str | None = None
    status: AcpSessionStatus = AcpSessionStatus.STARTING
    turn_index: int = 0
    created_at: str = field(default_factory=_utc_now)
    updated_at: str = field(default_factory=_utc_now)
    last_chunk_at: str | None = None
    last_completed_at: str | None = None
    last_error: str | None = None
    meta: dict[str, Any] = field(default_factory=dict)

    def touch(self) -> None:
        self.updated_at = _utc_now()
