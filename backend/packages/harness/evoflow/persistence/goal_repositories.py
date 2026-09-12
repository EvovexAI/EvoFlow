"""Repository for EvoPanel goal mode sessions (SQLite).

Table: ``evoflow_goal_sessions`` (one row per chat ``session_key``).

Planner-visible chat history lives in ``evoflow_chat_messages``; this table stores
Goal config, runtime state, and planner-private context only.
"""

from __future__ import annotations

import logging
from typing import Any

from evoflow.persistence.db import get_db
from evoflow.persistence.timestamps import now_iso_z

logger = logging.getLogger(__name__)

_SELECT_COLS = """
    SELECT
        session_key, user_id, goal_session_id,
        prompt, max_steps, step_delay_ms, retry_limit, auto_stop_minutes,
        persona_style, initiative, emotional_intelligence, feishu_push_on_complete,
        push_channel, push_target_id,
        continuous_learning, use_evolution_skill,
        goal_status, goal_revision, continuation_suppressed,
        status, step_count, enabled,
        last_run_at, last_run_id, last_error,
        pending_feedback, feedback_prompt, error_count, ended_at,
        start_time, locked_chat_model, channel_type,
        system_prompt, compaction_summary,
        goal_summary, completion_outcome,
        interpreter_fallback_streak,
        created_at, updated_at
"""


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _safe_str(value: Any, default: str = "") -> str:
    if value is None:
        return default
    return str(value)


def _bool_int(value: Any, default: bool = False) -> int:
    if value is None:
        return 1 if default else 0
    return 1 if bool(value) else 0


def _row_to_dict(row: Any) -> dict[str, Any]:
    return {
        "session_key": _safe_str(row[0]),
        "user_id": _safe_str(row[1]),
        "goal_session_id": _safe_str(row[2]),
        "prompt": _safe_str(row[3]),
        "max_steps": _safe_int(row[4], 8),
        "step_delay_ms": _safe_int(row[5], 1200),
        "retry_limit": _safe_int(row[6], 2),
        "auto_stop_minutes": _safe_int(row[7], 0),
        "persona_style": _safe_str(row[8], "professional"),
        "initiative": _safe_int(row[9], 70),
        "emotional_intelligence": bool(row[10]),
        "feishu_push_on_complete": bool(row[11]),
        "push_channel": _safe_str(row[12]),
        "push_target_id": _safe_str(row[13]),
        "continuous_learning": bool(row[14]),
        "use_evolution_skill": bool(row[15]),
        "goal_status": _safe_str(row[16], "active"),
        "goal_revision": _safe_int(row[17], 1),
        "continuation_suppressed": bool(row[18]),
        "status": _safe_str(row[19], "idle"),
        "step_count": _safe_int(row[20], 0),
        "enabled": bool(row[21]),
        "last_run_at": _safe_int(row[22], 0),
        "last_run_id": _safe_str(row[23]),
        "last_error": _safe_str(row[24]),
        "pending_feedback": bool(row[25]),
        "feedback_prompt": _safe_str(row[26]),
        "error_count": _safe_int(row[27], 0),
        "ended_at": _safe_int(row[28], 0),
        "start_time": _safe_int(row[29], 0),
        "locked_chat_model": _safe_str(row[30]),
        "channel_type": _safe_str(row[31], "web"),
        "system_prompt": _safe_str(row[32]),
        "compaction_summary": _safe_str(row[33]),
        "goal_summary": _safe_str(row[34]),
        "completion_outcome": _safe_str(row[35]),
        "interpreter_fallback_streak": _safe_int(row[36], 0),
        "created_at": _safe_str(row[37]),
        "updated_at": _safe_str(row[38]),
    }


def row_to_frontend_settings(row: dict[str, Any]) -> dict[str, Any]:
    """Shape for EvoPanel ``GoalSessionConfig`` + runtime block."""
    gs = str(row.get("goal_status") or "").strip().lower()
    goal_active = gs in {"active", "paused"}
    runtime_status = str(row.get("status") or "idle").strip().lower()
    if not goal_active and runtime_status in {"running", "waiting"}:
        runtime_status = "idle"
    return {
        "sessionKey": row.get("session_key") or "",
        "goalSessionId": row.get("goal_session_id") or "" if goal_active else "",
        "config": {
            "enabled": goal_active,
            "prompt": row.get("prompt") or "",
            "maxSteps": int(row.get("max_steps") or 8),
            "stepDelayMs": int(row.get("step_delay_ms") or 1200),
            "retryLimit": int(row.get("retry_limit") or 2),
            "autoStopMinutes": int(row.get("auto_stop_minutes") or 0),
            "personaStyle": row.get("persona_style") or "professional",
            "initiative": int(row.get("initiative") or 70),
            "emotionalIntelligence": bool(row.get("emotional_intelligence", True)),
            "continuousLearning": bool(row.get("continuous_learning")),
            "useEvolutionSkill": bool(row.get("use_evolution_skill")),
            "feishuPushOnComplete": bool(row.get("feishu_push_on_complete", True)),
            "pushChannel": str(row.get("push_channel") or ""),
            "pushTargetId": str(row.get("push_target_id") or ""),
        },
        "goalStatus": row.get("goal_status") or ("active" if goal_active else "cleared"),
        "goalRevision": int(row.get("goal_revision") or 1),
        "continuationSuppressed": bool(row.get("continuation_suppressed")),
        "goalSummary": str(row.get("goal_summary") or ""),
        "completionOutcome": str(row.get("completion_outcome") or ""),
        "runtime": {
            "status": runtime_status,
            "stepCount": int(row.get("step_count") or 0),
            "lastRunAt": int(row.get("last_run_at") or 0),
            "lastRunId": row.get("last_run_id") or "",
            "lastError": row.get("last_error") or "",
            "pending": bool(row.get("pending_feedback")),
            "errorCount": int(row.get("error_count") or 0),
            "endedAt": int(row.get("ended_at") or 0),
            "goalSummary": str(row.get("goal_summary") or ""),
            "completionOutcome": str(row.get("completion_outcome") or ""),
        },
    }


def upsert_goal_session(
    session_key: str,
    *,
    user_id: str | None = None,
    goal_session_id: str | None = None,
    prompt: str | None = None,
    max_steps: int | None = None,
    step_delay_ms: int | None = None,
    retry_limit: int | None = None,
    auto_stop_minutes: int | None = None,
    persona_style: str | None = None,
    initiative: int | None = None,
    emotional_intelligence: bool | None = None,
    feishu_push_on_complete: bool | None = None,
    push_channel: str | None = None,
    push_target_id: str | None = None,
    continuous_learning: bool | None = None,
    use_evolution_skill: bool | None = None,
    goal_status: str | None = None,
    goal_revision: int | None = None,
    continuation_suppressed: bool | None = None,
    status: str | None = None,
    step_count: int | None = None,
    enabled: bool | None = None,
    last_run_at: int | None = None,
    last_run_id: str | None = None,
    last_error: str | None = None,
    pending_feedback: bool | None = None,
    feedback_prompt: str | None = None,
    error_count: int | None = None,
    ended_at: int | None = None,
    start_time: int | None = None,
    locked_chat_model: str | None = None,
    channel_type: str | None = None,
    system_prompt: str | None = None,
    compaction_summary: str | None = None,
    goal_summary: str | None = None,
    completion_outcome: str | None = None,
    interpreter_fallback_streak: int | None = None,
) -> None:
    """Insert or replace a goal session row (normalized columns)."""
    sk = (session_key or "").strip()
    if not sk:
        raise ValueError("session_key required")

    existing = load_goal_session(sk) or {}
    now = now_iso_z()

    def _pick(name: str, value: Any, default: Any = "") -> Any:
        if value is not None:
            return value
        return existing.get(name, default)

    row = {
        "user_id": (user_id if user_id is not None else _pick("user_id", None, "")).strip(),
        "goal_session_id": _pick("goal_session_id", goal_session_id, ""),
        "prompt": _pick("prompt", prompt, ""),
        "max_steps": _safe_int(_pick("max_steps", max_steps, 8), 8),
        "step_delay_ms": _safe_int(_pick("step_delay_ms", step_delay_ms, 1200), 1200),
        "retry_limit": _safe_int(_pick("retry_limit", retry_limit, 2), 2),
        "auto_stop_minutes": _safe_int(_pick("auto_stop_minutes", auto_stop_minutes, 0), 0),
        "persona_style": _pick("persona_style", persona_style, "professional"),
        "initiative": _safe_int(_pick("initiative", initiative, 70), 70),
        "emotional_intelligence": _bool_int(
            _pick("emotional_intelligence", emotional_intelligence, True), True
        ),
        "feishu_push_on_complete": _bool_int(
            _pick("feishu_push_on_complete", feishu_push_on_complete, True), True
        ),
        "push_channel": _pick("push_channel", push_channel, ""),
        "push_target_id": _pick("push_target_id", push_target_id, ""),
        "continuous_learning": _bool_int(_pick("continuous_learning", continuous_learning, False)),
        "use_evolution_skill": _bool_int(_pick("use_evolution_skill", use_evolution_skill, False)),
        "goal_status": _pick("goal_status", goal_status, "active"),
        "goal_revision": _safe_int(_pick("goal_revision", goal_revision, 1), 1),
        "continuation_suppressed": _bool_int(
            _pick("continuation_suppressed", continuation_suppressed, False)
        ),
        "status": _pick("status", status, "idle"),
        "step_count": _safe_int(_pick("step_count", step_count, 0), 0),
        "enabled": _bool_int(_pick("enabled", enabled, False)),
        "last_run_at": _safe_int(_pick("last_run_at", last_run_at, 0), 0),
        "last_run_id": _pick("last_run_id", last_run_id, ""),
        "last_error": _pick("last_error", last_error, ""),
        "pending_feedback": _bool_int(_pick("pending_feedback", pending_feedback, False)),
        "feedback_prompt": _pick("feedback_prompt", feedback_prompt, ""),
        "error_count": _safe_int(_pick("error_count", error_count, 0), 0),
        "ended_at": _safe_int(_pick("ended_at", ended_at, 0), 0),
        "start_time": _safe_int(_pick("start_time", start_time, 0), 0),
        "locked_chat_model": _pick("locked_chat_model", locked_chat_model, ""),
        "channel_type": _pick("channel_type", channel_type, "web"),
        "system_prompt": _pick("system_prompt", system_prompt, ""),
        "compaction_summary": _pick("compaction_summary", compaction_summary, ""),
        "goal_summary": _pick("goal_summary", goal_summary, ""),
        "completion_outcome": _pick("completion_outcome", completion_outcome, ""),
        "interpreter_fallback_streak": _safe_int(
            _pick("interpreter_fallback_streak", interpreter_fallback_streak, 0), 0
        ),
        "created_at": existing.get("created_at") or now,
        "updated_at": now,
    }

    get_db().execute(
        """
        INSERT INTO evoflow_goal_sessions (
            session_key, user_id, goal_session_id,
            prompt, max_steps, step_delay_ms, retry_limit, auto_stop_minutes,
            persona_style, initiative, emotional_intelligence, feishu_push_on_complete,
            push_channel, push_target_id,
            continuous_learning, use_evolution_skill,
            goal_status, goal_revision, continuation_suppressed,
            status, step_count, enabled,
            last_run_at, last_run_id, last_error,
            pending_feedback, feedback_prompt, error_count, ended_at,
            start_time, locked_chat_model, channel_type,
            system_prompt, compaction_summary,
            goal_summary, completion_outcome,
            interpreter_fallback_streak,
            created_at, updated_at
        ) VALUES (
            ?, ?, ?,
            ?, ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?,
            ?, ?,
            ?, ?, ?,
            ?, ?, ?,
            ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?,
            ?, ?,
            ?, ?,
            ?,
            ?, ?
        )
        ON CONFLICT(session_key) DO UPDATE SET
            user_id = excluded.user_id,
            goal_session_id = excluded.goal_session_id,
            prompt = excluded.prompt,
            max_steps = excluded.max_steps,
            step_delay_ms = excluded.step_delay_ms,
            retry_limit = excluded.retry_limit,
            auto_stop_minutes = excluded.auto_stop_minutes,
            persona_style = excluded.persona_style,
            initiative = excluded.initiative,
            emotional_intelligence = excluded.emotional_intelligence,
            feishu_push_on_complete = excluded.feishu_push_on_complete,
            push_channel = excluded.push_channel,
            push_target_id = excluded.push_target_id,
            continuous_learning = excluded.continuous_learning,
            use_evolution_skill = excluded.use_evolution_skill,
            goal_status = excluded.goal_status,
            goal_revision = excluded.goal_revision,
            continuation_suppressed = excluded.continuation_suppressed,
            status = excluded.status,
            enabled = excluded.enabled,
            last_run_at = excluded.last_run_at,
            last_run_id = excluded.last_run_id,
            last_error = excluded.last_error,
            pending_feedback = excluded.pending_feedback,
            feedback_prompt = excluded.feedback_prompt,
            error_count = excluded.error_count,
            ended_at = excluded.ended_at,
            start_time = excluded.start_time,
            locked_chat_model = excluded.locked_chat_model,
            channel_type = excluded.channel_type,
            system_prompt = excluded.system_prompt,
            compaction_summary = excluded.compaction_summary,
            goal_summary = CASE
                WHEN length(trim(excluded.goal_summary)) > 0 THEN excluded.goal_summary
                ELSE evoflow_goal_sessions.goal_summary
            END,
            completion_outcome = CASE
                WHEN length(trim(excluded.completion_outcome)) > 0 THEN excluded.completion_outcome
                ELSE evoflow_goal_sessions.completion_outcome
            END,
            step_count = CASE
                WHEN trim(COALESCE(excluded.goal_session_id, '')) != trim(COALESCE(evoflow_goal_sessions.goal_session_id, ''))
                    THEN excluded.step_count
                ELSE MAX(evoflow_goal_sessions.step_count, excluded.step_count)
            END,
            interpreter_fallback_streak = excluded.interpreter_fallback_streak,
            updated_at = excluded.updated_at
        """,
        (
            sk,
            row["user_id"],
            str(row["goal_session_id"] or "").strip(),
            str(row["prompt"] or ""),
            row["max_steps"],
            row["step_delay_ms"],
            row["retry_limit"],
            row["auto_stop_minutes"],
            str(row["persona_style"] or "professional"),
            row["initiative"],
            row["emotional_intelligence"],
            row["feishu_push_on_complete"],
            str(row["push_channel"] or ""),
            str(row["push_target_id"] or ""),
            row["continuous_learning"],
            row["use_evolution_skill"],
            str(row["goal_status"] or "active"),
            row["goal_revision"],
            row["continuation_suppressed"],
            str(row["status"] or "idle"),
            row["step_count"],
            row["enabled"],
            row["last_run_at"],
            str(row["last_run_id"] or ""),
            str(row["last_error"] or ""),
            row["pending_feedback"],
            str(row["feedback_prompt"] or ""),
            row["error_count"],
            row["ended_at"],
            row["start_time"],
            str(row["locked_chat_model"] or ""),
            str(row["channel_type"] or "web"),
            str(row["system_prompt"] or ""),
            str(row["compaction_summary"] or ""),
            str(row["goal_summary"] or ""),
            str(row["completion_outcome"] or ""),
            row["interpreter_fallback_streak"],
            row["created_at"],
            row["updated_at"],
        ),
    )
    get_db().commit()


def patch_goal_runtime_atomic(
    session_key: str,
    *,
    fields: dict[str, Any],
    where_goal_active: bool = True,
) -> int:
    """Atomic conditional UPDATE on ``evoflow_goal_sessions`` runtime fields.

    Unlike ``upsert_goal_session`` (read-modify-write under a separate lock
    acquisition), this performs a single ``UPDATE ... WHERE`` that is atomic
    under SQLite WAL + the process-wide ``RLock``. Use this for hot-path
    runtime patches from middleware / goal_report / controller to avoid
    lost-update races when multiple writers hit the same row concurrently.

    Args:
        session_key: Primary key of the goal session row.
        fields: ``{column_name: value}`` to SET (only known runtime columns).
        where_goal_active: When True, append ``AND goal_status IN ('active','paused')``
            so the UPDATE is a no-op if another writer already moved the goal
            to a terminal state (completed/cleared). This is the race guard.

    Returns:
        Number of rows affected (0 means the guard prevented the write).
    """
    sk = (session_key or "").strip()
    if not sk or not fields:
        return 0
    allowed = {
        "goal_status", "goal_revision", "continuation_suppressed",
        "status", "step_count", "enabled",
        "last_run_at", "last_run_id", "last_error",
        "pending_feedback", "feedback_prompt", "error_count",
        "ended_at", "start_time", "locked_chat_model",
        "goal_summary", "completion_outcome",
        "interpreter_fallback_streak",
        "system_prompt", "compaction_summary",
    }
    sets: list[str] = []
    params: list[Any] = []
    for key, value in fields.items():
        if key not in allowed:
            continue
        if key == "last_error" and value is None:
            value = ""
        if key == "last_run_at":
            value = _safe_int(value, 0)
        if key in ("step_count", "error_count", "ended_at", "start_time",
                     "goal_revision", "interpreter_fallback_streak"):
            value = _safe_int(value, 0)
        if key in ("pending_feedback", "continuation_suppressed", "enabled"):
            value = _bool_int(value)
        sets.append(f"{key} = ?")
        params.append(value)
    if not sets:
        return 0
    sets.append("updated_at = ?")
    params.append(now_iso_z())
    sql = f"UPDATE evoflow_goal_sessions SET {', '.join(sets)} WHERE session_key = ?"
    if where_goal_active:
        sql += " AND goal_status IN ('active', 'paused')"
    params.append(sk)
    from evoflow.persistence.db import run_db_transaction

    def _do(db: Any) -> int:
        cur = db.execute(sql, tuple(params))
        db.commit()
        return int(cur.rowcount or 0)

    return run_db_transaction(_do)


def patch_goal_session_state(
    session_key: str,
    *,
    state: dict[str, Any] | None = None,
    enabled: bool | None = None,
    system_prompt: str | None = None,
    compaction_summary: str | None = None,
    locked_chat_model: str | None = None,
    start_time: int | None = None,
    goal_status: str | None = None,
    goal_revision: int | None = None,
    continuation_suppressed: bool | None = None,
    goal_summary: str | None = None,
    completion_outcome: str | None = None,
    interpreter_fallback_streak: int | None = None,
) -> bool:
    """Update runtime fields. ``state`` dict kept for legacy callers (mapped to columns)."""
    sk = (session_key or "").strip()
    if not sk:
        return False
    state_doc = state or {}
    kwargs: dict[str, Any] = {}
    if "status" in state_doc:
        kwargs["status"] = str(state_doc.get("status") or "idle")
    if "stepCount" in state_doc or "step_count" in state_doc:
        kwargs["step_count"] = _safe_int(state_doc.get("stepCount") or state_doc.get("step_count") or 0)
    if "lastRunAt" in state_doc or "last_run_at" in state_doc:
        kwargs["last_run_at"] = _safe_int(state_doc.get("lastRunAt") or state_doc.get("last_run_at") or 0)
    if "lastRunId" in state_doc or "last_run_id" in state_doc:
        kwargs["last_run_id"] = str(state_doc.get("lastRunId") or state_doc.get("last_run_id") or "")
    if "lastError" in state_doc or "last_error" in state_doc:
        kwargs["last_error"] = str(state_doc.get("lastError") or state_doc.get("last_error") or "")
    if "pending" in state_doc or "pending_feedback" in state_doc:
        kwargs["pending_feedback"] = bool(state_doc.get("pending") or state_doc.get("pending_feedback"))
    if "errorCount" in state_doc or "error_count" in state_doc:
        kwargs["error_count"] = _safe_int(state_doc.get("errorCount") or state_doc.get("error_count") or 0)
    if "endedAt" in state_doc or "ended_at" in state_doc:
        kwargs["ended_at"] = _safe_int(state_doc.get("endedAt") or state_doc.get("ended_at") or 0)
    if enabled is not None:
        kwargs["enabled"] = enabled
    if system_prompt is not None:
        kwargs["system_prompt"] = system_prompt
    if compaction_summary is not None:
        kwargs["compaction_summary"] = compaction_summary
    if locked_chat_model is not None:
        kwargs["locked_chat_model"] = locked_chat_model.strip()
    if start_time is not None:
        kwargs["start_time"] = _safe_int(start_time)
    if goal_status is not None:
        kwargs["goal_status"] = goal_status
    if goal_revision is not None:
        kwargs["goal_revision"] = goal_revision
    if continuation_suppressed is not None:
        kwargs["continuation_suppressed"] = continuation_suppressed
    if goal_summary is not None:
        kwargs["goal_summary"] = goal_summary
    if completion_outcome is not None:
        kwargs["completion_outcome"] = completion_outcome
    if interpreter_fallback_streak is not None:
        kwargs["interpreter_fallback_streak"] = interpreter_fallback_streak
    if not kwargs:
        return False
    upsert_goal_session(sk, **kwargs)
    return True


def patch_goal_report_fields(
    session_key: str,
    *,
    goal_summary: str | None = None,
    completion_outcome: str | None = None,
) -> bool:
    """Directly write goal report columns (allows clearing ``goal_summary`` with empty string)."""
    sk = (session_key or "").strip()
    if not sk:
        return False
    sets: list[str] = []
    params: list[Any] = []
    if goal_summary is not None:
        sets.append("goal_summary = ?")
        params.append(str(goal_summary))
    if completion_outcome is not None:
        sets.append("completion_outcome = ?")
        params.append(str(completion_outcome))
    if not sets:
        return False
    sets.append("updated_at = ?")
    params.append(now_iso_z())
    params.append(sk)
    get_db().execute(
        f"UPDATE evoflow_goal_sessions SET {', '.join(sets)} WHERE session_key = ?",
        tuple(params),
    )
    return True


def load_goal_session(session_key: str) -> dict[str, Any] | None:
    sk = (session_key or "").strip()
    if not sk:
        return None
    row = get_db().execute(_SELECT_COLS + " FROM evoflow_goal_sessions WHERE session_key = ? LIMIT 1", (sk,)).fetchone()
    if not row:
        return None
    return _row_to_dict(row)


def list_goal_sessions(
    *,
    user_id: str | None = None,
    enabled_only: bool = False,
    goal_active_only: bool = False,
    limit: int = 100,
) -> list[dict[str, Any]]:
    where: list[str] = []
    params: list[Any] = []
    if user_id is not None:
        where.append("user_id = ?")
        params.append(user_id.strip())
    if enabled_only:
        where.append("enabled = 1")
    if goal_active_only:
        where.append("goal_status IN ('active', 'paused')")
    sql = _SELECT_COLS + " FROM evoflow_goal_sessions"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY updated_at DESC LIMIT ?"
    params.append(max(1, min(int(limit or 100), 1000)))
    rows = get_db().execute(sql, params).fetchall()
    return [_row_to_dict(r) for r in rows]


def delete_goal_session(session_key: str) -> int:
    sk = (session_key or "").strip()
    if not sk:
        return 0
    cur = get_db().execute("DELETE FROM evoflow_goal_sessions WHERE session_key = ?", (sk,))
    get_db().commit()
    return cur.rowcount
