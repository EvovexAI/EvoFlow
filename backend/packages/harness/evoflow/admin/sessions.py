"""Past chat session search (evoflow.db) — replaces built-in ``session_search`` tool."""

from __future__ import annotations

import time
from typing import Any

from evoflow.admin.errors import NotFoundError, ValidationError
from evoflow.persistence.timestamps import iso_z_to_ms, ms_to_iso_z

_DEFAULT_MAX_AGE_DAYS = 90
_MAX_ROWS_SCAN = 5000


def _cutoff_iso(max_age_days: int) -> str:
    cutoff_ms = int((time.time() - max_age_days * 86400) * 1000)
    return ms_to_iso_z(cutoff_ms)


def _get_db():
    try:
        from evoflow.persistence import get_db

        return get_db()
    except Exception:
        return None


def _search_messages(
    db,
    query: str,
    max_results: int,
    max_age_days: int,
) -> list[dict[str, Any]]:
    import sqlite3

    like_pattern = f"%{query}%"
    cutoff_iso = _cutoff_iso(max_age_days)

    try:
        rows = db.execute(
            """
            SELECT
                m.session_key,
                COALESCE(s.title, ''),
                m.seq,
                m.role,
                COALESCE(m.content_json, ''),
                COALESCE(m.tool_name, ''),
                COALESCE(m.model_name, ''),
                COALESCE(s.created_at, '') AS session_created
            FROM evoflow_chat_messages m
            LEFT JOIN evoflow_chat_sessions s ON m.session_key = s.session_key
            WHERE m.created_at >= ?
              AND (m.content_json LIKE ? OR m.tool_name LIKE ?)
            ORDER BY m.created_at DESC
            LIMIT ?
            """,
            (cutoff_iso, like_pattern, like_pattern, _MAX_ROWS_SCAN),
        ).fetchall()
    except sqlite3.OperationalError:
        return []

    sessions: dict[str, dict[str, Any]] = {}
    for row in rows:
        sk = row[0] or ""
        if not sk:
            continue
        if sk not in sessions:
            sessions[sk] = {
                "session_key": sk,
                "title": row[1] or "",
                "session_created": iso_z_to_ms(str(row[7] or "")),
                "matches": [],
            }
        if len(sessions[sk]["matches"]) >= 3:
            continue
        sessions[sk]["matches"].append(
            {
                "seq": row[2],
                "role": row[3],
                "snippet": (row[4] or "")[:500],
                "tool": row[5],
                "model": row[6],
            }
        )

    result = sorted(sessions.values(), key=lambda s: s.get("session_created", 0), reverse=True)
    for s in result:
        s["match_count"] = len(s["matches"])
    return result[:max_results]


def _search_sessions(
    db,
    query: str,
    max_results: int,
    max_age_days: int,
) -> list[dict[str, Any]]:
    import sqlite3

    like_pattern = f"%{query}%"
    cutoff_iso = _cutoff_iso(max_age_days)

    try:
        rows = db.execute(
            """
            SELECT session_key, title, message_count, created_at
            FROM evoflow_chat_sessions
            WHERE created_at >= ?
              AND title LIKE ?
              AND is_deleted = 0
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (cutoff_iso, like_pattern, max_results),
        ).fetchall()
    except sqlite3.OperationalError:
        return []

    return [
        {
            "session_key": r[0],
            "title": r[1] or "",
            "message_count": r[2] or 0,
            "created_at": iso_z_to_ms(str(r[3] or "")),
        }
        for r in rows
    ]


def search_sessions(
    query: str,
    *,
    search_titles: bool = False,
    max_results: int = 5,
    max_age_days: int = _DEFAULT_MAX_AGE_DAYS,
) -> dict[str, Any]:
    """Search past conversations by keyword (same semantics as retired ``session_search`` tool)."""
    q = str(query or "").strip()
    if not q:
        raise ValidationError("query is required")

    db = _get_db()
    if db is None:
        return {"results": [], "note": "Database not available."}

    effective_max_age = max_age_days if max_age_days > 0 else 3650

    results = _search_messages(db, q, max_results, effective_max_age)
    if search_titles and not results:
        results = _search_sessions(db, q, max_results, effective_max_age)

    if not results:
        return {
            "query": q,
            "total_results": 0,
            "max_age_days": effective_max_age,
            "note": f"No matching sessions found in the last {effective_max_age} days.",
        }

    return {
        "query": q,
        "total_results": len(results),
        "max_age_days": effective_max_age,
        "sessions": results,
    }


def resolve_session_key(
    *,
    session_key: str = "",
    thread_id: str = "",
) -> str:
    """Resolve session_key from explicit key or thread_id."""
    sk = str(session_key or "").strip()
    if sk:
        return sk
    tid = str(thread_id or "").strip()
    if not tid:
        return ""
    try:
        from evoflow.persistence.session_repositories import find_session_key_by_thread_id

        return str(find_session_key_by_thread_id(tid) or "").strip()
    except Exception:
        return ""


def get_session_status(
    *,
    session_key: str = "",
    thread_id: str = "",
) -> dict[str, Any]:
    """Current conversation status: run state + context usage + compaction marker."""
    from evoflow.persistence.session_context_usage import load_session_context_usage
    from evoflow.persistence.session_repositories import get_session_row_for_ui
    from evoflow.persistence.session_run_state import is_run_status_active

    sk = resolve_session_key(session_key=session_key, thread_id=thread_id)
    if not sk:
        raise ValidationError("session_key 或 thread_id 必填（当前对话会自动注入）")

    row = get_session_row_for_ui(sk)
    if not row:
        raise NotFoundError(f"session not found: {sk}")

    usage = load_session_context_usage(sk) or {}
    run_status = str(row.get("runStatus") or "idle")
    running = is_run_status_active(run_status)

    compaction_seq = None
    try:
        from evoflow.persistence.chat_message_repositories import find_latest_compaction_seq

        compaction_seq = find_latest_compaction_seq(sk)
    except Exception:
        compaction_seq = None

    used = int(usage.get("used_tokens") or 0)
    window = int(usage.get("window_tokens") or 0)
    pct = usage.get("pct")
    if pct is None and window > 0:
        pct = round(used / window * 100.0, 1)

    status = {
        "session_key": sk,
        "thread_id": row.get("threadId"),
        "title": row.get("title") or "",
        "message_count": int(row.get("messageCount") or 0),
        "run_status": run_status,
        "running": running,
        "current_run_id": row.get("currentRunId"),
        "model_name": row.get("modelName") or row.get("primaryModelName"),
        "collab_phase": row.get("collabPhase"),
        "context_usage": {
            "used_tokens": used,
            "window_tokens": window,
            "pct": pct,
            "message_count": int(usage.get("message_count") or row.get("messageCount") or 0),
            "compacted": bool(usage.get("compacted")),
            "api_active_tokens": int(usage.get("api_active_tokens") or 0) or None,
            "updated_at_ms": usage.get("updated_at_ms"),
            "note": usage.get("note") or "",
        },
        "compaction": {
            "has_summary": compaction_seq is not None,
            "latest_seq": compaction_seq,
        },
        "tokens": {
            "input": int(row.get("inputTokens") or 0),
            "output": int(row.get("outputTokens") or 0),
            "total": int(row.get("totalTokens") or 0),
        },
    }

    lines = [
        "## 当前对话状态",
        f"- 会话：`{(row.get('title') or sk)[:48]}`",
        f"- session_key：`{sk[:64]}`",
        f"- 运行状态：`{run_status}`" + ("（进行中）" if running else ""),
        f"- 消息数：`{status['message_count']}`",
    ]
    if window > 0:
        lines.append(f"- 上下文占用：`{used}/{window}` tokens（约 {pct}%）")
    elif used > 0:
        lines.append(f"- 上下文占用：`{used}` tokens（窗口未知）")
    else:
        lines.append("- 上下文占用：暂无快照（尚未完成带用量统计的模型回合）")
    if compaction_seq is not None:
        lines.append(f"- 已压缩：有摘要标记（seq `{compaction_seq}`）")
    else:
        lines.append("- 已压缩：尚无持久化摘要")
    if status.get("model_name"):
        lines.append(f"- 模型：`{status['model_name']}`")
    status["markdown"] = "\n".join(lines)
    return status


def prepare_session_compact(
    *,
    session_key: str = "",
    thread_id: str = "",
) -> dict[str, Any]:
    """Resolve session + run-state for manual compaction (async work in handler)."""
    from evoflow.persistence.session_repositories import get_session_row_for_ui
    from evoflow.persistence.session_run_state import is_run_status_active

    sk = resolve_session_key(session_key=session_key, thread_id=thread_id)
    if not sk:
        raise ValidationError("session_key 或 thread_id 必填（当前对话会自动注入）")

    row = get_session_row_for_ui(sk)
    if not row:
        raise NotFoundError(f"session not found: {sk}")

    run_status = str(row.get("runStatus") or "idle")
    return {
        "session_key": sk,
        "session_row": row,
        "running": is_run_status_active(run_status),
        "run_status": run_status,
        "title": row.get("title") or "",
        "message_count": int(row.get("messageCount") or 0),
    }


def format_compact_result(
    *,
    session_key: str,
    running: bool,
    result: Any,
) -> dict[str, Any]:
    """Map ``ManualCompactionResult`` to a platform-friendly payload."""
    before_t = int(getattr(result, "before_gate_tokens", 0) or 0)
    after_t = int(getattr(result, "after_gate_tokens", 0) or 0)
    before_m = int(getattr(result, "before_message_count", 0) or 0)
    after_m = int(getattr(result, "after_message_count", 0) or 0)
    changed = bool(getattr(result, "changed", False))
    reason = str(getattr(result, "reason", "") or "")
    usage = getattr(result, "context_usage", None)
    if not isinstance(usage, dict):
        usage = {}

    lines = [
        "## 上下文压缩结果",
        f"- 会话：`{session_key[:64]}`",
        f"- 结果：{'已压缩' if changed else '未变化'}（`{reason or 'manual_compact'}`）",
        f"- Token：`{before_t}` → `{after_t}`（节省 `{max(0, before_t - after_t)}`）",
        f"- 消息：`{before_m}` → `{after_m}`",
    ]
    if running:
        lines.append("- 提示：当前回合仍在进行；压缩对**后续轮次**生效（本轮已加载的上下文不变）")
    if getattr(result, "persisted_summary", False):
        lines.append("- 已写入持久化摘要标记")

    return {
        "ok": True,
        "session_key": session_key,
        "changed": changed,
        "reason": reason,
        "before_gate_tokens": before_t,
        "after_gate_tokens": after_t,
        "before_message_count": before_m,
        "after_message_count": after_m,
        "persisted_summary": bool(getattr(result, "persisted_summary", False)),
        "context_usage": usage,
        "running_during_compact": running,
        "markdown": "\n".join(lines),
        "hint": (
            "压缩已完成；后续对话将使用压缩后的上下文。"
            if changed
            else "无需压缩或压缩未减少占用；可用 sessions.status 查看当前占用。"
        ),
    }
