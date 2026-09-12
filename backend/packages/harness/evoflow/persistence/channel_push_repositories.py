"""SQLite audit log for channel push / callback leave-a-trail.

Failures must never break the push path — callers should use ``safe_record_push``.
"""

from __future__ import annotations

import json
import logging
import uuid
from typing import Any

from evoflow.persistence.db import get_db
from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)

_PAYLOAD_MAX = 4000
_SUMMARY_MAX = 800
_TITLE_MAX = 240


def new_push_id() -> str:
    return f"push_{uuid.uuid4().hex[:16]}"


def _clip(text: str, limit: int) -> str:
    s = str(text or "").strip()
    if len(s) <= limit:
        return s
    return s[: max(0, limit - 1)].rstrip() + "…"


def _payload_to_json(payload: Any) -> str:
    if payload is None:
        return ""
    if isinstance(payload, str):
        return _clip(payload, _PAYLOAD_MAX)
    try:
        raw = json.dumps(payload, ensure_ascii=False, default=str)
    except Exception:
        raw = str(payload)
    return _clip(raw, _PAYLOAD_MAX)


def record_push(
    *,
    direction: str,
    channel: str = "feishu",
    kind: str = "",
    event: str = "",
    transport: str = "",
    approval_id: str = "",
    task_id: str = "",
    initiative_id: str = "",
    role_agent_code: str = "",
    receive_id: str = "",
    receive_id_type: str = "",
    sender_account_id: str = "",
    external_message_id: str = "",
    title: str = "",
    content_summary: str = "",
    payload: Any = None,
    status: str = "ok",
    error: str = "",
    triggered_by: str = "system",
    push_id: str = "",
    created_at: str = "",
) -> str:
    """Insert one push-log row. Returns the row id."""
    pid = str(push_id or "").strip() or new_push_id()
    now = str(created_at or "").strip() or utc_now_iso_z()
    get_db().execute(
        """
        INSERT INTO evoflow_channel_push_log (
            id, direction, channel, kind, event, transport,
            approval_id, task_id, initiative_id, role_agent_code,
            receive_id, receive_id_type, sender_account_id, external_message_id,
            title, content_summary, payload_json, status, error, triggered_by, created_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """,
        (
            pid,
            str(direction or "").strip() or "outbound",
            str(channel or "").strip() or "feishu",
            str(kind or "").strip(),
            str(event or "").strip(),
            str(transport or "").strip(),
            str(approval_id or "").strip(),
            str(task_id or "").strip(),
            str(initiative_id or "").strip(),
            str(role_agent_code or "").strip(),
            str(receive_id or "").strip(),
            str(receive_id_type or "").strip(),
            str(sender_account_id or "").strip(),
            str(external_message_id or "").strip(),
            _clip(title, _TITLE_MAX),
            _clip(content_summary, _SUMMARY_MAX),
            _payload_to_json(payload),
            str(status or "ok").strip() or "ok",
            _clip(error, _SUMMARY_MAX),
            str(triggered_by or "system").strip() or "system",
            now,
        ),
    )
    get_db().commit()
    return pid


def safe_record_push(**kwargs: Any) -> str | None:
    """Best-effort ``record_push`` — never raises.

    Also mirrors the interaction into chat transcripts (same idea as normal
    channel user/assistant turns) so Panel trail / IM session can show it.
    """
    try:
        pid = record_push(**kwargs)
    except Exception:
        logger.debug("channel_push_log: record failed", exc_info=True)
        return None
    try:
        mirror_channel_push_to_chat(push_id=pid, **kwargs)
    except Exception:
        logger.debug("channel_push_log: transcript mirror failed", exc_info=True)
    return pid


_KIND_LABEL_ZH = {
    "approval_card": "审批卡",
    "approval_file": "审批附件",
    "approval_decision": "审批回执",
    "review_card": "交工验收卡",
    "wrap_digest": "工作汇报",
    "running_work": "处理中",
    "escalation": "催办",
}


def _resolve_role_agent_code(role_agent_code: str, approval_id: str) -> str:
    code = str(role_agent_code or "").strip()
    if code:
        return code
    aid = str(approval_id or "").strip()
    if not aid:
        return ""
    try:
        from evoflow.proactive.repositories import ProactiveRepository

        ap = ProactiveRepository.get_approval(aid)
        return str(getattr(ap, "role_agent_code", "") or "").strip() if ap else ""
    except Exception:
        return ""


def _lookup_outbound_route(approval_id: str) -> tuple[str, str, str]:
    """Return (receive_id, receive_id_type, sender_account_id) from prior outbound."""
    aid = str(approval_id or "").strip()
    if not aid:
        return "", "", ""
    try:
        row = get_db().execute(
            """
            SELECT receive_id, receive_id_type, sender_account_id
            FROM evoflow_channel_push_log
            WHERE approval_id = ? AND direction = 'outbound' AND receive_id != ''
            ORDER BY created_at DESC
            LIMIT 1
            """,
            (aid,),
        ).fetchone()
        if not row:
            return "", "", ""
        return (
            str(row["receive_id"] or ""),
            str(row["receive_id_type"] or ""),
            str(row["sender_account_id"] or ""),
        )
    except Exception:
        return "", "", ""


def _format_chat_content(
    *,
    direction: str,
    channel: str,
    kind: str,
    event: str,
    title: str,
    content_summary: str,
    status: str,
    error: str,
    payload: Any,
) -> str:
    label = _KIND_LABEL_ZH.get(kind, kind or "通道消息")
    ch = str(channel or "feishu").strip() or "feishu"
    head = f"[{ch}·{label}]"
    if event == "send_failed" or status == "error":
        head += "（失败）"
    lines = [head]
    t = str(title or "").strip()
    if t:
        lines.append(t)
    body = str(content_summary or "").strip()
    if body and body != t:
        lines.append(body)
    if direction == "inbound" and isinstance(payload, dict):
        decision = str(payload.get("decision") or "").strip()
        if decision and decision not in body:
            lines.append(f"决定：{decision}")
    err = str(error or "").strip()
    if err and err not in body:
        lines.append(f"错误：{err}")
    return "\n".join(lines).strip()


def _session_keys_for_push(
    *,
    direction: str,
    channel: str,
    role_agent_code: str,
    receive_id: str,
    sender_account_id: str,
    approval_id: str,
) -> list[str]:
    keys: list[str] = []
    role = _resolve_role_agent_code(role_agent_code, approval_id)
    if role:
        keys.append(f"proactive:{role}")

    rid = str(receive_id or "").strip()
    sender = str(sender_account_id or "").strip()
    ch = str(channel or "").strip().lower() or "feishu"

    if not rid and approval_id and ch == "feishu":
        rid, _, sender_prev = _lookup_outbound_route(approval_id)
        if not sender:
            sender = sender_prev

    if rid and ch in {"feishu", "wecom", "dingtalk", "telegram"}:
        bot = sender or role or "main"
        keys.append(f"agent:{bot}:{ch}:{rid}")

    # Desktop decisions still belong on the employee trail (already added).
    # Dedup while preserving order.
    seen: set[str] = set()
    out: list[str] = []
    for k in keys:
        if k and k not in seen:
            seen.add(k)
            out.append(k)
    return out


def _ensure_transcript_session(session_key: str, *, role_agent_code: str = "") -> str | None:
    """Ensure sidebar session exists; return thread_id if known."""
    import time

    from evoflow.persistence import session_repositories as sess_repo

    sk = str(session_key or "").strip()
    if not sk:
        return None
    existing = sess_repo.load_session_map().get(sk) or {}
    thread_id = str(existing.get("threadId") or existing.get("thread_id") or "").strip() or None
    now_ms = int(time.time() * 1000)
    created_ms = int(existing.get("createdAt") or 0) or now_ms
    if sk.startswith("proactive:"):
        code = sk.split(":", 1)[-1]
        title = f"智能体员工·{role_agent_code or code}"
        ctx = {
            "source": "proactive",
            "proactive_agent_code": code,
            "agent_id": code,
            "session_mode": "agent",
            "channel_push_mirror": True,
        }
    else:
        title = str(existing.get("title") or "").strip() or f"通道会话·{sk}"
        ctx = {
            "source": "channel_push",
            "channel_push_mirror": True,
            "session_mode": "agent",
        }
        if role_agent_code:
            ctx["proactive_agent_code"] = role_agent_code
    try:
        kwargs: dict[str, Any] = {
            "thread_id": thread_id,
            "created_at_ms": created_ms,
            "updated_at_ms": now_ms,
            "context": ctx,
            "session_status": sess_repo.SESSION_STATUS_ACTIVE,
        }
        if not str(existing.get("title") or "").strip():
            kwargs["title"] = title
        sess_repo.upsert_session_row(sk, **kwargs)
    except Exception:
        logger.debug("channel_push_log: upsert session failed sk=%s", sk, exc_info=True)
    return thread_id


def mirror_channel_push_to_chat(*, push_id: str = "", **kwargs: Any) -> None:
    """Mirror a channel push/callback into ``evoflow_chat_messages``.

    - outbound → role=assistant (bot push)
    - inbound  → role=user (human receipt)
    Writes into ``proactive:{role}`` and, when a Feishu chat target is known,
    also ``agent:{bot}:feishu:{receive_id}`` so the IM session trail matches
    ordinary user/model dialogue storage.
    """
    direction = str(kwargs.get("direction") or "outbound").strip().lower() or "outbound"
    event = str(kwargs.get("event") or "").strip().lower()
    # Skip noisy non-interaction rows
    if event and event not in {"sent", "send_failed", "callback", "card_patched"}:
        return

    channel = str(kwargs.get("channel") or "feishu").strip() or "feishu"
    kind = str(kwargs.get("kind") or "").strip()
    role_code = str(kwargs.get("role_agent_code") or "").strip()
    approval_id = str(kwargs.get("approval_id") or "").strip()
    receive_id = str(kwargs.get("receive_id") or "").strip()
    sender = str(kwargs.get("sender_account_id") or "").strip()
    task_id = str(kwargs.get("task_id") or "").strip()
    external_mid = str(kwargs.get("external_message_id") or "").strip()
    title = str(kwargs.get("title") or "").strip()
    summary = str(kwargs.get("content_summary") or "").strip()
    status = str(kwargs.get("status") or "ok").strip() or "ok"
    error = str(kwargs.get("error") or "").strip()
    payload = kwargs.get("payload")

    role_code = _resolve_role_agent_code(role_code, approval_id)
    content = _format_chat_content(
        direction=direction,
        channel=channel,
        kind=kind,
        event=event,
        title=title,
        content_summary=summary,
        status=status,
        error=error,
        payload=payload,
    )
    if not content:
        return

    chat_role = "user" if direction == "inbound" else "assistant"
    # Inbound must not reuse the outbound Feishu message_id (dedupe would drop the receipt).
    if direction == "inbound":
        msg_id = f"channel-callback:{push_id or external_mid or uuid.uuid4().hex[:12]}"
    else:
        msg_id = external_mid or (f"channel-push:{push_id}" if push_id else "")
    tool_name = f"channel:{kind or 'push'}"

    from evoflow.persistence import chat_session_service as chat_svc
    from evoflow.persistence.chat_message_repositories import message_id_exists

    for sk in _session_keys_for_push(
        direction=direction,
        channel=channel,
        role_agent_code=role_code,
        receive_id=receive_id,
        sender_account_id=sender,
        approval_id=approval_id,
    ):
        try:
            if msg_id and message_id_exists(sk, msg_id):
                continue
            thread_id = _ensure_transcript_session(sk, role_agent_code=role_code)
            chat_svc.append_message_and_touch_session(
                sk,
                role=chat_role,
                content=content,
                thread_id=thread_id,
                message_id=msg_id or None,
                tool_name=tool_name,
                round_id=task_id or None,
            )
        except Exception:
            logger.debug(
                "channel_push_log: append chat failed session=%s kind=%s",
                sk,
                kind,
                exc_info=True,
            )


def _row_to_dict(row: Any) -> dict[str, Any]:
    payload_raw = str(row["payload_json"] or "")
    payload: Any = payload_raw
    if payload_raw:
        try:
            payload = json.loads(payload_raw)
        except Exception:
            payload = payload_raw
    return {
        "id": str(row["id"] or ""),
        "direction": str(row["direction"] or ""),
        "channel": str(row["channel"] or ""),
        "kind": str(row["kind"] or ""),
        "event": str(row["event"] or ""),
        "transport": str(row["transport"] or ""),
        "approval_id": str(row["approval_id"] or ""),
        "task_id": str(row["task_id"] or ""),
        "initiative_id": str(row["initiative_id"] or ""),
        "role_agent_code": str(row["role_agent_code"] or ""),
        "receive_id": str(row["receive_id"] or ""),
        "receive_id_type": str(row["receive_id_type"] or ""),
        "sender_account_id": str(row["sender_account_id"] or ""),
        "external_message_id": str(row["external_message_id"] or ""),
        "title": str(row["title"] or ""),
        "content_summary": str(row["content_summary"] or ""),
        "payload": payload,
        "status": str(row["status"] or ""),
        "error": str(row["error"] or ""),
        "triggered_by": str(row["triggered_by"] or ""),
        "created_at": str(row["created_at"] or ""),
    }


_SELECT = """
    SELECT id, direction, channel, kind, event, transport,
           approval_id, task_id, initiative_id, role_agent_code,
           receive_id, receive_id_type, sender_account_id, external_message_id,
           title, content_summary, payload_json, status, error, triggered_by, created_at
    FROM evoflow_channel_push_log
"""


def list_by_approval(approval_id: str, *, limit: int = 50) -> list[dict[str, Any]]:
    aid = str(approval_id or "").strip()
    if not aid:
        return []
    cap = max(1, min(int(limit or 50), 200))
    rows = (
        get_db()
        .execute(
            _SELECT + " WHERE approval_id = ? ORDER BY created_at DESC LIMIT ?",
            (aid, cap),
        )
        .fetchall()
    )
    return [_row_to_dict(r) for r in rows]


def list_recent(
    *,
    limit: int = 50,
    channel: str | None = None,
    task_id: str = "",
    direction: str = "",
) -> list[dict[str, Any]]:
    cap = max(1, min(int(limit or 50), 200))
    clauses: list[str] = []
    args: list[Any] = []
    ch = str(channel or "").strip()
    if ch:
        clauses.append("channel = ?")
        args.append(ch)
    tid = str(task_id or "").strip()
    if tid:
        clauses.append("task_id = ?")
        args.append(tid)
    d = str(direction or "").strip()
    if d:
        clauses.append("direction = ?")
        args.append(d)
    where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
    args.append(cap)
    rows = (
        get_db()
        .execute(
            _SELECT + where + " ORDER BY created_at DESC LIMIT ?",
            tuple(args),
        )
        .fetchall()
    )
    return [_row_to_dict(r) for r in rows]
