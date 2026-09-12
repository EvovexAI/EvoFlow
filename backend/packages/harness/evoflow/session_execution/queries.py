"""Session execution read model - ``evoflow_chat_sessions`` only."""

from __future__ import annotations

import logging
import os
from datetime import UTC, datetime
from typing import Any

from evoflow.persistence import session_repositories as sess_repo
from evoflow.persistence.db import get_db, resolve_evolflow_db_path
from evoflow.persistence.session_run_state import (
    derive_execution_phase,
    is_run_status_active,
)

logger = logging.getLogger(__name__)

EXECUTION_STATE_SCHEMA_VERSION = 4

_RECENTLY_COMPLETED_WINDOW_S = int(os.getenv("EVOFLOW_RECENTLY_COMPLETED_WINDOW_S", "60") or "60")


def derive_executing(*, run_status: str) -> bool:
    """True when ``evoflow_chat_sessions.run_status`` is running or pending."""
    return is_run_status_active(run_status)


def _read_chat_session_run_row(session_key: str) -> dict[str, str | None] | None:
    """Single-table read: thread/run status + current-turn wall-clock bounds."""
    sk = str(session_key or "").strip()
    if not sk:
        return None
    row = (
        get_db()
        .execute(
            """
            SELECT thread_id, run_status, current_run_id,
                   current_turn_started_at, current_turn_ended_at
            FROM evoflow_chat_sessions
            WHERE session_key = ? AND is_deleted = 0
            """,
            (sk,),
        )
        .fetchone()
    )
    if not row:
        return None
    return {
        "thread_id": str(row[0] or "").strip() or None,
        "run_status": str(row[1] or "").strip().lower(),
        "current_run_id": str(row[2] or "").strip() or None,
        "current_turn_started_at": str(row[3] or "").strip() or None,
        "current_turn_ended_at": str(row[4] or "").strip() or None,
    }


def _check_recently_completed(
    *,
    run_status: str,
    run_id: str | None,
    turn_ended: str | None,
) -> dict[str, Any]:
    """Detect a run that completed within the recently-completed window.

    Uses ``current_turn_ended_at`` from ``evoflow_chat_sessions`` as the
    primary signal.  Completion status is derived from ``run_status`` so no
    extra DB query is needed.

    Returns dict with ``recently_completed``, ``recently_completed_run_id``,
    ``recently_completed_status``.
    """
    empty: dict[str, Any] = {
        "recently_completed": False,
        "recently_completed_run_id": None,
        "recently_completed_status": None,
    }
    if not turn_ended:
        return empty

    try:
        end_dt = datetime.fromisoformat(turn_ended.replace("Z", "+00:00"))
        if end_dt.tzinfo is None:
            end_dt = end_dt.replace(tzinfo=UTC)
        age_s = (datetime.now(UTC) - end_dt).total_seconds()
    except Exception:
        logger.debug("recently_completed: failed to parse turn_ended=%s", turn_ended, exc_info=True)
        return empty

    if not (0 <= age_s <= _RECENTLY_COMPLETED_WINDOW_S):
        return empty

    st = str(run_status or "").strip().lower()
    if st in ("fail", "error"):
        completion_status = "error"
    elif st in ("cancelled", "stopped"):
        completion_status = "cancelled"
    else:
        completion_status = "success"

    return {
        "recently_completed": True,
        "recently_completed_run_id": run_id,
        "recently_completed_status": completion_status,
    }


async def build_session_execution_state(session_key: str) -> dict[str, Any]:
    """Return session run fields from ``evoflow_chat_sessions`` only (no probes, no normalize)."""
    key = str(session_key or "").strip()
    if not key:
        raise ValueError("session_key required")
    if sess_repo.is_session_deleted(key):
        raise ValueError("session not found")

    db_row = _read_chat_session_run_row(key)
    if not db_row:
        raise ValueError("session not found")

    thread_id = db_row["thread_id"]
    run_status_raw = db_row["run_status"] or ""
    run_id = db_row["current_run_id"]
    turn_started = db_row["current_turn_started_at"]
    turn_ended = db_row["current_turn_ended_at"]
    executing = derive_executing(run_status=run_status_raw)
    phase = derive_execution_phase(run_status_raw)

    # Detect recently-completed runs so the frontend can refresh messages
    # instead of attempting a stream-resume on a dead run.
    if executing:
        rc: dict[str, Any] = {
            "recently_completed": False,
            "recently_completed_run_id": None,
            "recently_completed_status": None,
        }
    else:
        rc = _check_recently_completed(
            run_status=run_status_raw,
            run_id=run_id,
            turn_ended=turn_ended,
        )

    try:
        db_path = str(resolve_evolflow_db_path().resolve())
    except Exception:
        db_path = ""

    return {
        "ok": True,
        "schemaVersion": EXECUTION_STATE_SCHEMA_VERSION,
        "dbPath": db_path,
        "sessionKey": key,
        "threadId": thread_id,
        "runId": run_id,
        "runStatus": run_status_raw,
        "runStatusRaw": run_status_raw,
        "currentTurnStartedAt": turn_started,
        "currentTurnEndedAt": turn_ended,
        "phase": phase,
        "executing": executing,
        "stopAllowed": executing,
        "attachRecommended": bool(thread_id and executing),
        "streamResumeRecommended": False,
        "goalActive": False,
        "awaitingToolApproval": False,
        "langgraphActive": executing,
        "gatewayStreamActive": False,
        "snapshotAvailable": False,
        "latestPartialText": "",
        "latestToolSummary": "",
        "lastEventAtMs": 0,
        "recently_completed": rc["recently_completed"],
        "recently_completed_run_id": rc["recently_completed_run_id"],
        "recently_completed_status": rc["recently_completed_status"],
    }
