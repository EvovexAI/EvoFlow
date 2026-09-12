"""Proactive employee chat sessions — workspace (role) + many conversations.

Employee = workspace (role config, memory, tools). Conversations are separate
``evoflow_chat_sessions`` rows:

- legacy contact: ``proactive:{code}`` (archived / UI entry; new duty/task/chat
  no longer append here)
- duty round: ``proactive:{code}:duty:{stamp}``
- task: ``proactive:{code}:task:{task_id}`` (optional resume bucket for a
  primary task id; a conversation may still associate many board tasks via
  ``source_ref`` / tool create — not a hard 1:1 lock)
- chat: ``proactive:{code}:chat:{stamp}``

Mirrors ``app.gateway.automation_chat_session`` prepare/finalize so transcript
and ``run_status`` stay scoped to the conversation session.
"""

from __future__ import annotations

import logging
import re
import time
from typing import Any, Literal

logger = logging.getLogger(__name__)

DUTY_BRIEF_TOOL_NAME = "proactive_duty_brief"
DUTY_BEAT_TOOL_NAME = "proactive_duty_beat"

ProactiveSessionKind = Literal["legacy", "duty", "task", "chat"]
_KIND_MARKERS = ("duty", "task", "chat")

# Panel SSE key: frontend keeps a long-lived subscribe so sidebar can refresh
# when background duty/dispatch creates a new conversation session.
SHELL_PANEL_THREAD_ID = "__evopanel_shell__"


def _notify_shell_session_upserted(
    *,
    session_key: str,
    thread_id: str = "",
    workspace_kind: str = "",
    agent_code: str = "",
) -> None:
    """Best-effort panel SSE so EvoPanel sidebar reloads employee conversations."""
    sk = str(session_key or "").strip()
    if not sk:
        return
    try:
        import asyncio

        from app.gateway.routers.events import broadcaster

        data: dict[str, Any] = {
            "session_key": sk,
            "thread_id": str(thread_id or "").strip() or None,
            "workspace_kind": str(workspace_kind or "").strip() or None,
            "agent_code": str(agent_code or "").strip() or None,
        }

        async def _send() -> None:
            await broadcaster.broadcast(
                SHELL_PANEL_THREAD_ID,
                "panel:session_upserted",
                data,
            )

        try:
            loop = asyncio.get_running_loop()
            loop.create_task(_send())
        except RuntimeError:
            asyncio.run(_send())
    except Exception:
        logger.debug(
            "proactive_chat_session: shell notify failed session_key=%s",
            sk,
            exc_info=True,
        )


def proactive_session_key(agent_code: str) -> str:
    """Legacy contact key ``proactive:{code}`` (workspace entry / back-compat)."""
    code = str(agent_code or "").strip()
    return f"proactive:{code}" if code else ""


def _sanitize_session_suffix(raw: str) -> str:
    """Keep session_key path-safe; preserve readability."""
    s = str(raw or "").strip()
    if not s:
        return ""
    # ISO stamps use ':' — replace so key parsing stays unambiguous.
    s = s.replace(":", "-").replace("/", "-").replace("\\", "-")
    s = re.sub(r"\s+", "_", s)
    return s[:180]


def proactive_duty_session_key(agent_code: str, stamp: str | None = None) -> str:
    code = str(agent_code or "").strip()
    if not code:
        return ""
    from evoflow.timeutil import utc_now_iso_z

    suf = _sanitize_session_suffix(stamp or utc_now_iso_z())
    return f"proactive:{code}:duty:{suf}"


def proactive_task_session_key(agent_code: str, task_id: str) -> str:
    code = str(agent_code or "").strip()
    tid = str(task_id or "").strip()
    if not code or not tid:
        return ""
    return f"proactive:{code}:task:{_sanitize_session_suffix(tid)}"


def proactive_chat_session_key(agent_code: str, stamp: str | None = None) -> str:
    code = str(agent_code or "").strip()
    if not code:
        return ""
    from evoflow.timeutil import utc_now_iso_z

    suf = _sanitize_session_suffix(stamp or utc_now_iso_z())
    return f"proactive:{code}:chat:{suf}"


def parse_proactive_session_key(session_key: str) -> dict[str, Any]:
    """Parse workspace conversation keys.

    Returns keys: ``agent_code``, ``kind`` (legacy|duty|task|chat), ``suffix``,
    ``legacy`` (bool), ``session_key``.
    """
    sk = str(session_key or "").strip()
    empty = {
        "agent_code": "",
        "kind": "legacy",
        "suffix": "",
        "legacy": True,
        "session_key": sk,
        "task_id": "",
    }
    if not sk.startswith("proactive:"):
        return empty
    rest = sk[len("proactive:") :]
    for kind in _KIND_MARKERS:
        marker = f":{kind}:"
        idx = rest.find(marker)
        if idx >= 0:
            code = rest[:idx].strip()
            suffix = rest[idx + len(marker) :].strip()
            return {
                "agent_code": code,
                "kind": kind,
                "suffix": suffix,
                "legacy": False,
                "session_key": sk,
                "task_id": suffix if kind == "task" else "",
            }
    return {
        "agent_code": rest.strip(),
        "kind": "legacy",
        "suffix": "",
        "legacy": True,
        "session_key": sk,
        "task_id": "",
    }


def proactive_agent_code_from_session_key(session_key: str) -> str:
    return str(parse_proactive_session_key(session_key).get("agent_code") or "").strip()


def is_proactive_session_key(session_key: str | None) -> bool:
    return str(session_key or "").strip().startswith("proactive:")


def resolve_work_session_key(
    *,
    agent_code: str,
    kind: str = "duty",
    round_id: str | None = None,
    task_id: str | None = None,
    stamp: str | None = None,
) -> str:
    """Pick the conversation session_key for a duty/task/chat run."""
    code = str(agent_code or "").strip()
    k = str(kind or "duty").strip().lower()
    if k in {"think", "execute", "patrol", "heartbeat"}:
        k = "duty"
    if k == "task" or str(task_id or "").strip():
        tid = str(task_id or "").strip()
        if tid:
            return proactive_task_session_key(code, tid)
        # dispatch/round without task_id → still a fresh duty-like bucket
        rid = str(round_id or stamp or "").strip()
        return proactive_duty_session_key(code, rid or None)
    if k == "chat":
        return proactive_chat_session_key(code, stamp or round_id)
    # duty default: one session per round stamp
    rid = str(round_id or stamp or "").strip()
    return proactive_duty_session_key(code, rid or None)


def resolve_transcript_round_id(session_key: str, round_id: str | None) -> str | None:
    """Map Panel trail filters onto the chat ``round_id`` that actually has rows.

    Human dispatch used to stamp Tasks/initiatives as ``dispatch:TS`` while the
    agent loop wrote messages as ``round:TS'`` a few ms later — opening「工作轨迹」
    with the dispatch id returned an empty transcript. Prefer an exact match;
    otherwise pick the earliest ``round:`` in a short window after dispatch.
    """
    sk = str(session_key or "").strip()
    rid = str(round_id or "").strip()
    if not sk or not rid:
        return rid or None
    try:
        from evoflow.persistence.db import get_db
        from evoflow.timeutil import parse_iso_to_ms

        db = get_db()
        exact = db.execute(
            """
            SELECT 1 AS ok FROM evoflow_chat_messages
            WHERE session_key = ? AND round_id = ?
            LIMIT 1
            """,
            (sk, rid),
        ).fetchone()
        if exact:
            return rid

        if not rid.startswith("dispatch:"):
            return rid

        ts_raw = rid[len("dispatch:") :].strip()
        start_ms = parse_iso_to_ms(ts_raw)
        if start_ms <= 0:
            return rid
        end_ms = start_ms + 120_000
        from evoflow.timeutil import instant_to_beijing_iso

        start_iso = instant_to_beijing_iso(start_ms)
        end_iso = instant_to_beijing_iso(end_ms)
        if not start_iso or not end_iso:
            return rid

        row = db.execute(
            """
            SELECT round_id, MIN(created_at) AS first_at
            FROM evoflow_chat_messages
            WHERE session_key = ?
              AND round_id LIKE 'round:%'
              AND created_at >= ?
              AND created_at < ?
            GROUP BY round_id
            ORDER BY first_at ASC
            LIMIT 1
            """,
            (sk, start_iso, end_iso),
        ).fetchone()
        sibling = str((row["round_id"] if row else "") or "").strip()
        if sibling:
            logger.info(
                "proactive_chat_session: resolved trail filter %s → %s session=%s",
                rid,
                sibling,
                sk,
            )
            return sibling
    except Exception:
        logger.debug(
            "proactive_chat_session: resolve_transcript_round_id failed session=%s rid=%s",
            sk,
            rid,
            exc_info=True,
        )
    return rid


_BOARD_TASK_LINE = re.compile(
    r"^-\s+`[^`]+`\s+\[(?P<status>[^\]]+)\]\s+\d+%\s+·\s+(?P<title>.+?)(?:\s+·\s+.+)?\s*$"
)


def build_duty_beat_text(*, role_name: str, prompt: str, kind: str = "think") -> str:
    """Short human-facing duty open line for the work-process timeline."""
    name = str(role_name or "").strip() or "智能体员工"
    body = str(prompt or "")
    head = f"本轮值班开始 · {name}"

    if "### 用户派发任务" in body or "用户派发目标" in body:
        goal = ""
        for raw in body.splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or line.startswith("###"):
                continue
            if line.startswith("-") or line.startswith("`"):
                continue
            if "派发" in line and len(line) < 12:
                continue
            goal = line
            break
        if goal:
            if len(goal) > 72:
                goal = goal[:71] + "…"
            return f"{head}\n推进用户派发：{goal}"
        return f"{head}\n按用户派发目标推进并结案。"

    open_titles: list[str] = []
    for raw in body.splitlines():
        m = _BOARD_TASK_LINE.match(raw.strip())
        if not m:
            continue
        status = str(m.group("status") or "").strip().lower()
        if status in {"completed", "reviewed", "cancelled", "canceled"}:
            continue
        title = str(m.group("title") or "").strip()
        if title:
            open_titles.append(title)

    if open_titles:
        count = len(open_titles)
        shown = "、".join(open_titles[:2])
        if len(shown) > 64:
            shown = shown[:63] + "…"
        more = f"（等 {count} 项）" if count > 2 else ""
        return f"{head}\n看板有 {count} 项未结：{shown}{more}。推进并结案。"

    if "本岗看板暂无未结" in body or "暂无未结 Task" in body:
        return f"{head}\n看板暂无未结，本轮无事可做。"

    if str(kind or "").strip().lower() == "execute":
        return f"{head}\n按已批计划执行并结案。"

    return f"{head}\n对照职责巡检，有待办则推进并结案。"


def _session_title(
    *,
    role_name: str,
    agent_code: str,
    workspace_kind: str,
    task_id: str | None = None,
    task_title: str | None = None,
    round_id: str | None = None,
) -> str:
    name = str(role_name or agent_code).strip() or agent_code
    wk = str(workspace_kind or "duty").strip().lower()
    if wk == "task":
        # Sidebar: task conversation title = task name (not「岗位 · id」).
        label = str(task_title or "").strip() or str(task_id or "").strip() or "任务"
        if len(label) > 40:
            label = label[:39] + "…"
        return label
    if wk == "chat":
        return f"{name} · 对话"
    # duty
    stamp = str(round_id or "").strip()
    short = stamp.split("T")[-1][:8] if "T" in stamp else stamp[-8:]
    return f"{name} · 值班{(' · ' + short) if short else ''}"


def prepare_proactive_chat_session(
    *,
    agent_code: str,
    role_name: str,
    thread_id: str,
    prompt: str,
    round_id: str | None = None,
    initiative_id: str | None = None,
    kind: str = "think",
    session_key: str | None = None,
    task_id: str | None = None,
    task_title: str | None = None,
    workspace_kind: str | None = None,
    workspace_root: str | None = None,
) -> str | None:
    """Before a LangGraph run: upsert conversation session + seed brief/beat."""
    code = str(agent_code).strip()
    tid = str(thread_id or "").strip()
    body = str(prompt or "").strip()
    if not code or not tid or not body:
        return None

    wk = str(workspace_kind or "").strip().lower()
    if not wk:
        k = str(kind or "think").strip().lower()
        if str(task_id or "").strip():
            wk = "task"
        elif k in {"chat"}:
            wk = "chat"
        else:
            wk = "duty"

    sk = str(session_key or "").strip() or resolve_work_session_key(
        agent_code=code,
        kind=wk,
        round_id=round_id,
        task_id=task_id,
    )
    if not sk:
        return None

    try:
        from evoflow.persistence import chat_session_service as chat_svc
        from evoflow.persistence import session_repositories as sess_repo

        now_ms = int(time.time() * 1000)
        existing = sess_repo.load_session_map().get(sk) or {}
        created_ms = int(existing.get("createdAt") or 0) or now_ms

        rid = str(round_id or "").strip() or None
        related_task = str(task_id or "").strip() or None
        title = _session_title(
            role_name=role_name,
            agent_code=code,
            workspace_kind=wk,
            task_id=related_task,
            task_title=task_title,
            round_id=rid,
        )
        ctx: dict[str, Any] = {
            "source": "proactive",
            "proactive_agent_code": code,
            "agent_id": code,
            "proactive_kind": str(kind or "think"),
            "workspace_kind": wk,
            "session_mode": "agent",
        }
        if rid:
            ctx["proactive_round_id"] = rid
        if initiative_id:
            ctx["proactive_initiative_id"] = str(initiative_id)
        if related_task:
            ctx["related_task_id"] = related_task

        # 员工绑定工作空间优先：会话 context 写入 role.config.workspace_path，
        # 前端会话显示层即可优先取员工绑定的 workspace（而非默认/上次选择）。
        bound_ws = str(workspace_root or "").strip()
        if bound_ws:
            ctx["local_workspace_root"] = bound_ws
            ctx["use_virtual_paths"] = False

        # Merge context so UI prefs (employee_talk_mode) survive re-prepare on resume.
        prev_ctx = existing.get("context") if isinstance(existing.get("context"), dict) else {}
        if isinstance(prev_ctx, dict):
            merged = dict(prev_ctx)
            merged.update(ctx)
            ctx = merged

        is_new = not bool(existing)
        sess_repo.upsert_session_row(
            sk,
            thread_id=tid,
            title=title,
            created_at_ms=created_ms,
            updated_at_ms=now_ms,
            context=ctx,
            session_status=sess_repo.SESSION_STATUS_ACTIVE,
        )
        identity: dict = {}
        try:
            from evoflow.authz.runtime_identity import (
                resolve_identity_from_agent,
                stamp_session_from_identity,
            )

            identity = resolve_identity_from_agent(code)
            stamp_session_from_identity(sk, identity)
        except Exception:
            logger.debug(
                "proactive_chat_session: ownership stamp failed session_key=%s",
                sk,
                exc_info=True,
            )
        # Duty/patrol runs stay out of the main sidebar until the user opens them to continue.
        if is_new and wk == "duty":
            sess_repo.set_session_hidden_from_list(sk, hidden=True)
        try:
            from evoflow.persistence.chat_message_repositories import transcript_duplicate_exists

            if transcript_duplicate_exists(sk, role="user", content_text=body):
                logger.info(
                    "proactive_chat_session: skip duplicate seed session_key=%s round_id=%s",
                    sk,
                    rid or "-",
                )
                return sk
        except Exception:
            logger.debug("proactive_chat_session: dedupe check failed", exc_info=True)

        identity_pid = str(identity.get("principal_id") or "").strip() or None
        chat_svc.append_message_and_touch_session(
            sk,
            role="user",
            content=body,
            thread_id=tid,
            round_id=rid,
            tool_name=DUTY_BRIEF_TOOL_NAME,
            principal_id=identity_pid,
        )

        beat = build_duty_beat_text(role_name=role_name, prompt=body, kind=kind)
        try:
            from evoflow.persistence.chat_message_repositories import transcript_duplicate_exists

            beat_dup = transcript_duplicate_exists(sk, role="user", content_text=beat)
        except Exception:
            beat_dup = False
        if not beat_dup:
            chat_svc.append_message_and_touch_session(
                sk,
                role="user",
                content=beat,
                thread_id=tid,
                round_id=rid,
                tool_name=DUTY_BEAT_TOOL_NAME,
                principal_id=identity_pid,
            )

        logger.info(
            "proactive_chat_session: prepared session_key=%s thread_id=%s kind=%s wk=%s round_id=%s",
            sk,
            tid,
            kind,
            wk,
            rid or "-",
        )
        _notify_shell_session_upserted(
            session_key=sk,
            thread_id=tid,
            workspace_kind=wk,
            agent_code=code,
        )
        return sk
    except Exception:
        logger.warning(
            "proactive_chat_session: prepare failed session_key=%s thread_id=%s",
            sk,
            tid,
            exc_info=True,
        )
        return None


def finalize_proactive_chat_session(
    *,
    session_key: str,
    thread_id: str | None = None,
    reason: str = "proactive_completed",
) -> dict[str, Any]:
    """Mark conversation ``run_status`` terminal (duty/task finally safety net)."""
    sk = str(session_key or "").strip()
    tid = str(thread_id or "").strip() or None
    if not sk:
        return {"ok": True, "skipped": True, "reason": "no_session"}
    try:
        from evoflow.session_execution.lifecycle import force_end_session_turn

        force_end_session_turn(
            session_key=sk,
            thread_id=tid,
            source="proactive_finalize",
            reason=reason,
        )
        logger.info(
            "proactive_chat_session: finalized session_key=%s thread_id=%s reason=%s",
            sk,
            tid or "-",
            reason,
        )
        return {"ok": True, "sessionKey": sk, "threadId": tid}
    except Exception:
        logger.warning(
            "proactive_chat_session: finalize failed session_key=%s thread_id=%s",
            sk,
            tid,
            exc_info=True,
        )
        return {"ok": False, "sessionKey": sk, "threadId": tid}


def list_employee_conversation_sessions(
    agent_code: str,
    *,
    limit: int = 50,
    kinds: list[str] | None = None,
) -> list[dict[str, Any]]:
    """List conversation sessions under one employee workspace."""
    code = str(agent_code or "").strip()
    if not code:
        return []
    lim = max(1, min(int(limit), 200))
    prefix = f"proactive:{code}"
    kind_filter = {str(k).strip().lower() for k in (kinds or []) if str(k).strip()}
    try:
        from evoflow.persistence.db import get_db

        rows = (
            get_db()
            .execute(
                """
                SELECT session_key, thread_id, title, updated_at, created_at,
                       run_status, current_run_id, context_json, message_count
                FROM evoflow_chat_sessions
                WHERE is_deleted = 0
                  AND (session_key = ? OR session_key LIKE ?)
                ORDER BY updated_at DESC
                LIMIT ?
                """,
                (prefix, f"{prefix}:%", lim * 3),
            )
            .fetchall()
        )
    except Exception:
        logger.debug("list_employee_conversation_sessions failed code=%s", code, exc_info=True)
        return []

    out: list[dict[str, Any]] = []
    for row in rows:
        sk = str(row["session_key"] or "").strip()
        parsed = parse_proactive_session_key(sk)
        if parsed.get("agent_code") != code:
            continue
        kind = str(parsed.get("kind") or "legacy")
        if kind_filter and kind not in kind_filter:
            continue
        import json

        raw_ctx = row["context_json"] if "context_json" in row.keys() else "{}"
        try:
            ctx = json.loads(raw_ctx or "{}")
            if not isinstance(ctx, dict):
                ctx = {}
        except Exception:
            ctx = {}
        out.append(
            {
                "session_key": sk,
                "thread_id": str(row["thread_id"] or "").strip() or None,
                "title": str(row["title"] or "").strip(),
                "kind": kind,
                "task_id": parsed.get("task_id")
                or str(ctx.get("related_task_id") or "").strip()
                or None,
                "run_status": str(row["run_status"] or "").strip() or "done",
                "updated_at": str(row["updated_at"] or ""),
                "created_at": str(row["created_at"] or ""),
                "message_count": int(row["message_count"] or 0),
                "legacy": bool(parsed.get("legacy")),
            }
        )
        if len(out) >= lim:
            break
    return out
