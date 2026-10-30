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
    # Dedup guard: when both a channel adapter (e.g. feishu._on_message) and
    # the central bus/manager mirror hook try to record the same interaction
    # in the same process, skip the second one. Match on
    # (channel, direction, external_message_id, receive_id) when the upstream
    # caller already stamped a message id, otherwise fall back to
    # (channel, direction, receive_id, created_at second-precision). Best-
    # effort: failures here just return the original id so the audit path
    # stays available.
    try:
        ch = str(kwargs.get("channel") or "").strip().lower()
        dr = str(kwargs.get("direction") or "").strip().lower()
        ext = str(kwargs.get("external_message_id") or "").strip()
        rid = str(kwargs.get("receive_id") or "").strip()
        if ch and dr and rid:
            if push_dedup_exists(
                channel=ch, direction=dr,
                external_message_id=ext, receive_id=rid,
            ):
                return None
    except Exception:
        logger.debug("channel_push_log: dedup probe failed", exc_info=True)
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
    "im_message": "即时消息",
    "self_intro": "自我介绍",
    "approval_card": "审批卡",
    "approval_file": "审批附件",
    "approval_decision": "审批回执",
    "review_card": "交工验收卡",
    "wrap_digest": "工作汇报",
    "running_work": "处理中",
    "escalation": "催办",
    "tree_receipt": "协作待闭环",
}

_MSG_TYPE_LABEL_ZH = {
    "text": "文本",
    "chat": "文本",
    "command": "指令",
    "image": "图片",
    "file": "文件",
    "audio": "语音",
    "video": "视频",
    "sticker": "表情",
    "post": "富文本",
    "interactive": "交互卡片",
    "share_chat": "分享会话",
    "share_user": "分享用户",
    "attachment": "附件",
    "media": "媒体",
    "text+image": "文本+图片",
    "text+file": "文本+文件",
}

_CHANNEL_LABEL_ZH = {
    "feishu": "飞书",
    "lark": "飞书",
    "wecom": "企业微信",
    "weixin": "微信",
    "dingtalk": "钉钉",
    "telegram": "Telegram",
    "slack": "Slack",
    "im": "即时消息",
}

_TRIGGERED_BY_LABEL_ZH = {
    "user": "用户",
    "agent": "智能体",
    "system": "系统",
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
        row = (
            get_db()
            .execute(
                """
            SELECT receive_id, receive_id_type, sender_account_id
            FROM evoflow_channel_push_log
            WHERE approval_id = ? AND direction = 'outbound' AND receive_id != ''
            ORDER BY created_at DESC
            LIMIT 1
            """,
                (aid,),
            )
            .fetchone()
        )
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

    Stream patches (``card_patched`` / partial ``im_message``) stay audit-only in
    ``evoflow_channel_push_log``. Mirroring them produced a second Panel bubble
    like ``[feishu·im_message]\\n我是`` before the real ChannelManager final reply.
    """
    direction = str(kwargs.get("direction") or "outbound").strip().lower() or "outbound"
    event = str(kwargs.get("event") or "").strip().lower()
    # Skip noisy non-interaction rows. card_patched is audited via record_push but
    # must not become a chat bubble (partial stream text).
    if event == "card_patched":
        return
    if event and event not in {"sent", "send_failed", "callback"}:
        return

    channel = str(kwargs.get("channel") or "feishu").strip() or "feishu"
    kind = str(kwargs.get("kind") or "").strip()
    # Normal IM turns are already written by ChannelManager transcript hooks.
    # Mirroring final stream cards again duplicates the assistant reply under a
    # ``[feishu·im_message]`` / ``[feishu·stream_card]`` wrapper.
    if direction == "outbound" and kind in {"im_message", "stream_card", "stream_empty"}:
        return
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


def _display_status(*, direction: str, status: str, event: str) -> str:
    """Human-readable Chinese status for ops UI."""
    st = str(status or "").strip().lower()
    d = str(direction or "").strip().lower()
    ev = str(event or "").strip().lower()
    if st in ("error", "failed"):
        if d == "outbound" or ev in ("send_failed", "dropped"):
            return "发送失败"
        return "失败"
    if st in ("pending", "sending"):
        return "发送中"
    if d == "inbound":
        return "已接收"
    if d == "outbound":
        if ev in ("card_patched", "patched"):
            return "已更新"
        return "已回复"
    return st or "未知"


def _attachment_items(payload: Any) -> list[dict[str, str]]:
    """Normalize inbound/outbound file descriptors for ops UI + model audit.

    Prefer durable local ``path`` so ops can preview/open and agents see where
    the file lives (``{EVOFLOW_HOME}/channel-messages/...``).
    """
    if not isinstance(payload, dict):
        return []
    raw_items: list[Any] = []
    for key in ("files", "attachments", "artifacts"):
        block = payload.get(key)
        if isinstance(block, list):
            raw_items.extend(block)
    out: list[dict[str, str]] = []
    for it in raw_items[:16]:
        if isinstance(it, str) and it.strip():
            s = it.strip()
            out.append(
                {
                    "filename": s.replace("\\", "/").rsplit("/", 1)[-1][:120],
                    "path": s[:500],
                    "mime": "",
                }
            )
            continue
        if not isinstance(it, dict):
            continue
        path = str(it.get("path") or it.get("virtual_path") or it.get("url") or "").strip()
        filename = (
            str(it.get("filename") or it.get("name") or "").strip()
            or (path.replace("\\", "/").rsplit("/", 1)[-1] if path else "")
            or "attachment"
        )
        mime = str(it.get("mime") or it.get("content_type") or "").strip()
        # Always keep a display string; path preferred for open/preview.
        if not path and not filename:
            continue
        out.append(
            {
                "filename": filename[:160],
                "path": (path or filename)[:500],
                "mime": mime[:80],
            }
        )
    return out


def _attachment_info(payload: Any) -> tuple[int, list[str]]:
    """Return (count, preview labels) — prefer local paths over bare filenames."""
    items = _attachment_items(payload)
    previews = [str(it.get("path") or it.get("filename") or "").strip()[:240] for it in items[:8]]
    previews = [p for p in previews if p]
    return len(items), previews


def _row_to_dict(row: Any, *, enrich: bool = False) -> dict[str, Any]:
    payload_raw = str(row["payload_json"] or "")
    payload: Any = payload_raw
    if payload_raw:
        try:
            payload = json.loads(payload_raw)
        except Exception:
            payload = payload_raw
    out: dict[str, Any] = {
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
    if enrich:
        msg_type_raw = ""
        thread_id = ""
        if isinstance(payload, dict):
            msg_type_raw = str(payload.get("msg_type") or "").strip()
            thread_id = str(payload.get("thread_id") or "").strip()
        att_items = _attachment_items(payload)
        att_count, att_preview = _attachment_info(payload)
        kind = out["kind"]
        kind_label = _KIND_LABEL_ZH.get(kind, kind or "通道消息")
        if not msg_type_raw:
            if att_count > 0:
                msg_type_raw = "attachment"
            elif kind and kind != "im_message":
                # Non-IM kinds (approval_decision, self_intro, …) → use kind as type.
                msg_type_raw = kind
            else:
                msg_type_raw = "text"
        # Always surface Chinese in the ops UI "消息类型" column.
        msg_type_zh = _MSG_TYPE_LABEL_ZH.get(msg_type_raw.lower(), "") or _KIND_LABEL_ZH.get(
            msg_type_raw, ""
        )
        if not msg_type_zh:
            msg_type_zh = kind_label if kind and kind != "im_message" else (msg_type_raw or "文本")
        out["msg_type"] = msg_type_zh
        out["msg_type_raw"] = msg_type_raw
        out["thread_id"] = thread_id
        out["attachment_count"] = att_count
        out["attachments"] = att_preview
        out["attachment_items"] = att_items
        out["display_status"] = _display_status(
            direction=out["direction"],
            status=out["status"],
            event=out["event"],
        )
        out["kind_label"] = kind_label
        ch_raw = str(out.get("channel") or "").strip()
        out["channel_raw"] = ch_raw
        out["channel_label"] = _CHANNEL_LABEL_ZH.get(ch_raw.lower(), ch_raw or "—")
        trig_raw = str(out.get("triggered_by") or "").strip()
        out["triggered_by_raw"] = trig_raw
        out["triggered_by_label"] = _TRIGGERED_BY_LABEL_ZH.get(trig_raw.lower(), trig_raw or "—")
        # Actor placeholders — filled by ``_attach_actor_labels`` for list pages.
        out["agent_code"] = str(out.get("role_agent_code") or out.get("sender_account_id") or "").strip()
        out["employee_name"] = ""
        out["bot_id"] = ""
        out["peer_user_id"] = ""
        if isinstance(payload, dict):
            out["peer_user_id"] = str(payload.get("user_id") or "").strip()
    return out


def _looks_like_chinese(text: str) -> bool:
    return any("\u4e00" <= ch <= "\u9fff" for ch in str(text or ""))


def _looks_like_im_user_id(text: str) -> bool:
    """True for Feishu peer / app ids that must never be treated as agent codes."""
    t = str(text or "").strip().lower()
    if not t:
        return False
    return t.startswith(("ou_", "on_", "od_", "oc_", "om_", "cli_"))


def _actor_code_from_item(it: dict[str, Any]) -> str:
    """Prefer role/agent slot; never promote peer open_id into employee code."""
    for key in ("role_agent_code", "sender_account_id", "agent_code"):
        c = str(it.get(key) or "").strip()
        if not c or _looks_like_im_user_id(c):
            continue
        return c
    # Legacy bad rows: sender was human open_id — fall back to payload.account_id.
    payload = it.get("payload")
    if isinstance(payload, dict):
        for key in ("account_id", "bot_account_id", "agent_code"):
            c = str(payload.get(key) or "").strip()
            if c and not _looks_like_im_user_id(c):
                return c
    return ""


def _resolve_employee_zh_name(code: str, role: Any | None) -> str:
    """Best-effort Chinese display name; never return bare English wire code when avoidable."""
    c = str(code or "").strip()
    if not c or _looks_like_im_user_id(c):
        return "主机器人"

    candidates: list[str] = []
    # 1) agents table agent_name
    try:
        from evoflow.admin.agents import get_agent

        row = get_agent(c) or {}
        n = str((row or {}).get("agent_name") or "").strip()
        if n and n != c:
            candidates.append(n)
    except Exception:
        pass
    # 2) agents_config agent_name
    try:
        from evoflow.config.agents_config import load_agent_config

        cfg = load_agent_config(c)
        n = str(getattr(cfg, "agent_name", "") or "").strip() if cfg else ""
        if n and n != c:
            candidates.append(n)
    except Exception:
        pass
    # 3) proactive role job title
    if role is not None:
        n = str(getattr(role, "role_name", "") or "").strip()
        if n and n != c:
            candidates.append(n)

    for n in candidates:
        if _looks_like_chinese(n):
            return n
    for n in candidates:
        if n:
            return n
    # Last resort: keep code but UI should treat it as weak fallback.
    return c


def _attach_actor_labels(items: list[dict[str, Any]]) -> None:
    """Fill employee_name / bot_id from proactive roles + agent display names."""
    if not items:
        return
    codes: set[str] = set()
    for it in items:
        c = _actor_code_from_item(it)
        if c:
            codes.add(c)
        # Heal peer_user_id from legacy rows that stuffed open_id into sender.
        if not str(it.get("peer_user_id") or "").strip():
            raw = str(it.get("sender_account_id") or "").strip()
            if raw.startswith(("ou_", "on_", "od_")):
                it["peer_user_id"] = raw

    name_by_code: dict[str, str] = {}
    bot_by_code: dict[str, dict[str, str]] = {}
    try:
        from evoflow.proactive.repositories import ProactiveRepository

        for code in codes:
            role = None
            try:
                role = ProactiveRepository.get_role(code)
            except Exception:
                role = None
            name_by_code[code] = _resolve_employee_zh_name(code, role)
            cfg = getattr(role, "config", None) if role else None
            bot_by_code[code] = {
                "feishu": str(getattr(cfg, "feishu_app_id", "") or "").strip() if cfg else "",
                "wecom": str(getattr(cfg, "wecom_bot_id", "") or "").strip() if cfg else "",
                "weixin": "",
                "dingtalk": "",
            }
    except Exception:
        logger.debug("channel_push_log: actor label resolve failed", exc_info=True)
        for code in codes:
            name_by_code.setdefault(code, code)

    for it in items:
        code = _actor_code_from_item(it)
        it["agent_code"] = code
        if not code:
            it["employee_name"] = "主机器人"
            it["bot_id"] = ""
            continue
        it["employee_name"] = name_by_code.get(code, "") or code
        ch = str(it.get("channel_raw") or it.get("channel") or "").strip().lower()
        bots = bot_by_code.get(code) or {}
        bot_id = str(bots.get(ch) or "").strip()
        if not bot_id:
            for v in bots.values():
                if str(v or "").strip():
                    bot_id = str(v).strip()
                    break
        it["bot_id"] = bot_id


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


def tree_receipt_external_id(task_id: str) -> str:
    """Stable Feishu/audit id for one-shot「协作待闭环」per root task."""
    tid = str(task_id or "").strip()
    return f"tree_receipt:{tid}" if tid else ""


def tree_receipt_outbound_exists(
    task_id: str,
    *,
    statuses: tuple[str, ...] = ("ok", "pending", "sending"),
) -> bool:
    """True when a tree_receipt row for this root already claims the slot."""
    tid = str(task_id or "").strip()
    if not tid:
        return False
    ext = tree_receipt_external_id(tid)
    want = tuple(str(s).strip().lower() for s in statuses if str(s).strip())
    if not want:
        return False
    placeholders = ",".join("?" for _ in want)
    try:

        def _probe(db: Any) -> bool:
            row = db.execute(
                f"""
                SELECT 1 FROM evoflow_channel_push_log
                WHERE kind = 'tree_receipt'
                  AND direction = 'outbound'
                  AND status IN ({placeholders})
                  AND (task_id = ? OR external_message_id = ?)
                LIMIT 1
                """,
                (*want, tid, ext),
            ).fetchone()
            return row is not None

        from evoflow.persistence.db import run_db_with_retry

        return bool(run_db_with_retry(lambda: _probe(get_db())))
    except Exception:
        logger.debug("channel_push_log: tree_receipt exists probe failed task=%s", tid, exc_info=True)
        return False


def try_claim_tree_receipt(
    task_id: str,
    *,
    role_agent_code: str = "xiaomi",
    title: str = "协作待闭环",
) -> str | None:
    """Atomically insert a pending tree_receipt row. None = already claimed/sent.

    Uses ``BEGIN IMMEDIATE`` so parallel sibling completions cannot both send.
    """
    tid = str(task_id or "").strip()
    if not tid:
        return None
    ext = tree_receipt_external_id(tid)
    now = utc_now_iso_z()
    pid = new_push_id()

    def _claim(db: Any) -> str | None:
        row = db.execute(
            """
            SELECT id FROM evoflow_channel_push_log
            WHERE kind = 'tree_receipt'
              AND direction = 'outbound'
              AND status IN ('ok', 'pending', 'sending')
              AND (task_id = ? OR external_message_id = ?)
            LIMIT 1
            """,
            (tid, ext),
        ).fetchone()
        if row is not None:
            return None
        db.execute(
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
                "outbound",
                "feishu",
                "tree_receipt",
                "claim",
                "markdown",
                "",
                tid,
                "",
                str(role_agent_code or "xiaomi").strip() or "xiaomi",
                "",
                "",
                "",
                ext,
                _clip(title, _TITLE_MAX),
                "claim pending send",
                _payload_to_json({"transport": "markdown", "phase": "claim"}),
                "pending",
                "",
                "system",
                now,
            ),
        )
        return pid

    try:
        from evoflow.persistence.db import run_db_transaction

        return run_db_transaction(_claim)
    except Exception:
        logger.debug("channel_push_log: tree_receipt claim failed task=%s", tid, exc_info=True)
        return None


def finalize_tree_receipt_claim(
    push_id: str,
    *,
    ok: bool,
    receive_id: str = "",
    receive_id_type: str = "",
    sender_account_id: str = "",
    role_agent_code: str = "",
    content_summary: str = "",
    error: str = "",
    payload: Any = None,
) -> None:
    """Mark a pending tree_receipt claim as sent or failed.

    Also stamps the real notify role onto ``role_agent_code`` (claim inserts
    default to ``xiaomi`` before routing is resolved).
    """
    pid = str(push_id or "").strip()
    if not pid:
        return
    status = "ok" if ok else "error"
    event = "sent" if ok else "send_failed"
    role_code = str(role_agent_code or "").strip()

    def _finalize(db: Any) -> None:
        if role_code:
            db.execute(
                """
                UPDATE evoflow_channel_push_log
                SET event = ?,
                    receive_id = ?,
                    receive_id_type = ?,
                    sender_account_id = ?,
                    role_agent_code = ?,
                    content_summary = ?,
                    payload_json = ?,
                    status = ?,
                    error = ?
                WHERE id = ? AND kind = 'tree_receipt'
                """,
                (
                    event,
                    str(receive_id or "").strip(),
                    str(receive_id_type or "").strip(),
                    str(sender_account_id or "").strip(),
                    role_code,
                    _clip(content_summary, _SUMMARY_MAX),
                    _payload_to_json(
                        payload if payload is not None else {"transport": "markdown"}
                    ),
                    status,
                    _clip(error, _SUMMARY_MAX),
                    pid,
                ),
            )
        else:
            db.execute(
                """
                UPDATE evoflow_channel_push_log
                SET event = ?,
                    receive_id = ?,
                    receive_id_type = ?,
                    sender_account_id = ?,
                    content_summary = ?,
                    payload_json = ?,
                    status = ?,
                    error = ?
                WHERE id = ? AND kind = 'tree_receipt'
                """,
                (
                    event,
                    str(receive_id or "").strip(),
                    str(receive_id_type or "").strip(),
                    str(sender_account_id or "").strip(),
                    _clip(content_summary, _SUMMARY_MAX),
                    _payload_to_json(
                        payload if payload is not None else {"transport": "markdown"}
                    ),
                    status,
                    _clip(error, _SUMMARY_MAX),
                    pid,
                ),
            )

    try:
        from evoflow.persistence.db import run_db_transaction

        run_db_transaction(_finalize)
    except Exception:
        logger.debug("channel_push_log: tree_receipt finalize failed id=%s", pid, exc_info=True)


def release_tree_receipt_claim(push_id: str, *, error: str = "send_failed_released") -> None:
    """Drop a failed pending claim so a later retry can send once."""
    pid = str(push_id or "").strip()
    if not pid:
        return

    def _release(db: Any) -> None:
        db.execute(
            """
            UPDATE evoflow_channel_push_log
            SET status = 'error', event = 'claim_released', error = ?
            WHERE id = ? AND kind = 'tree_receipt' AND status IN ('pending', 'sending')
            """,
            (_clip(error, _SUMMARY_MAX), pid),
        )

    try:
        from evoflow.persistence.db import run_db_transaction

        run_db_transaction(_release)
    except Exception:
        logger.debug("channel_push_log: tree_receipt release failed id=%s", pid, exc_info=True)


def push_dedup_exists(
    *,
    channel: str,
    direction: str,
    external_message_id: str = "",
    receive_id: str = "",
) -> bool:
    """Return True if a push-log row with this identity already exists.

    The identity is ``(channel, direction, receive_id)`` plus, when the
    caller has one, ``external_message_id``. Used by ``safe_record_push`` to
    avoid double-recording when both the channel adapter and the central
    bus/manager mirror fire on the same interaction.
    """
    ch = str(channel or "").strip().lower()
    dr = str(direction or "").strip().lower()
    rid = str(receive_id or "").strip()
    if not ch or not dr or not rid:
        return False
    ext = str(external_message_id or "").strip()
    try:
        if ext:
            row = (
                get_db()
                .execute(
                    """
                    SELECT 1 FROM evoflow_channel_push_log
                    WHERE channel = ? AND direction = ?
                      AND receive_id = ? AND external_message_id = ?
                    ORDER BY created_at DESC LIMIT 1
                    """,
                    (ch, dr, rid, ext),
                )
                .fetchone()
            )
            return row is not None
        row = (
            get_db()
            .execute(
                """
                SELECT 1 FROM evoflow_channel_push_log
                WHERE channel = ? AND direction = ? AND receive_id = ?
                ORDER BY created_at DESC LIMIT 1
                """,
                (ch, dr, rid),
            )
            .fetchone()
        )
        return row is not None
    except Exception:
        return False


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


def list_paginated(
    *,
    page: int = 1,
    page_size: int = 50,
    channel: str | None = None,
    direction: str | None = None,
    status: str | None = None,
    kind: str | None = None,
    task_id: str | None = None,
    since_hours: float | None = None,
    q: str | None = None,
) -> dict[str, Any]:
    """Paginated channel message audit for ops UI.

    Returns ``{ items, total, page, page_size, pages }`` with enriched display fields.
    """
    page_n = max(1, int(page or 1))
    size = max(1, min(int(page_size or 50), 200))
    offset = (page_n - 1) * size

    clauses: list[str] = [
        # Hide stream-patch noise (historical card_patched / one-char「已更新」).
        "(event IS NULL OR LOWER(event) NOT IN ('card_patched', 'patched'))",
    ]
    args: list[Any] = []

    ch = str(channel or "").strip()
    if ch:
        clauses.append("channel = ?")
        args.append(ch)
    d = str(direction or "").strip()
    if d:
        clauses.append("direction = ?")
        args.append(d)
    st = str(status or "").strip()
    if st:
        # Accept display aliases from the UI.
        alias = {
            "received": "ok",
            "replied": "ok",
            "failed": "error",
            "error": "error",
            "pending": "pending",
            "sending": "sending",
            "ok": "ok",
        }.get(st.lower(), st)
        if st.lower() in ("received",):
            clauses.append("direction = 'inbound'")
            clauses.append("status = ?")
            args.append("ok")
        elif st.lower() in ("replied", "sent"):
            clauses.append("direction = 'outbound'")
            clauses.append("status = ?")
            args.append("ok")
        else:
            clauses.append("status = ?")
            args.append(alias)
    kd = str(kind or "").strip()
    if kd:
        clauses.append("kind = ?")
        args.append(kd)
    tid = str(task_id or "").strip()
    if tid:
        clauses.append("task_id = ?")
        args.append(tid)
    if since_hours is not None:
        try:
            hours = float(since_hours)
        except (TypeError, ValueError):
            hours = 0.0
        if hours > 0:
            from datetime import datetime, timedelta, timezone

            cutoff = (datetime.now(timezone.utc) - timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%SZ")
            clauses.append("created_at >= ?")
            args.append(cutoff)
    query = str(q or "").strip()
    if query:
        like = f"%{query}%"
        clauses.append(
            "(content_summary LIKE ? OR title LIKE ? OR receive_id LIKE ? OR external_message_id LIKE ?"
            " OR channel LIKE ? OR role_agent_code LIKE ? OR sender_account_id LIKE ?)"
        )
        args.extend([like, like, like, like, like, like, like])

    where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
    db = get_db()
    try:
        total = int(db.execute(f"SELECT COUNT(1) FROM evoflow_channel_push_log{where}", tuple(args)).fetchone()[0] or 0)
    except Exception:
        logger.debug("channel_push_log: count failed", exc_info=True)
        total = 0

    rows: list[Any] = []
    try:
        rows = db.execute(
            _SELECT + where + " ORDER BY created_at DESC LIMIT ? OFFSET ?",
            tuple([*args, size, offset]),
        ).fetchall()
    except Exception:
        logger.debug("channel_push_log: list_paginated failed", exc_info=True)

    items = [_row_to_dict(r, enrich=True) for r in rows]
    _attach_actor_labels(items)
    pages = (total + size - 1) // size if size else 0
    return {
        "items": items,
        "total": total,
        "page": page_n,
        "page_size": size,
        "pages": pages,
    }


def list_channel_bindings(
    *,
    channel: str | None = None,
    q: str | None = None,
) -> dict[str, Any]:
    """Ops list: how/when/who bound which IM bot to which employee."""
    items: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()  # (platform, bot_id)

    def _append(
        *,
        platform: str,
        bot_id: str,
        agent_code: str,
        employee_name: str,
        bound_at: str,
        enabled: bool,
        bind_method: str,
        peer_open_id: str = "",
        source: str,
    ) -> None:
        plat = str(platform or "").strip().lower()
        bid = str(bot_id or "").strip()
        if not plat or not bid:
            return
        key = (plat, bid)
        if key in seen:
            return
        seen.add(key)
        method = str(bind_method or "config").strip().lower() or "config"
        method_label = {
            "qr": "扫码绑定",
            "config": "配置同步",
            "manual": "手动配置",
        }.get(method, method)
        status = "bound" if enabled else "disabled"
        items.append(
            {
                "id": f"{plat}:{bid}",
                "channel": plat,
                "channel_label": _CHANNEL_LABEL_ZH.get(plat, plat or "—"),
                "bot_id": bid,
                "agent_code": str(agent_code or "").strip(),
                "employee_name": str(employee_name or "").strip() or str(agent_code or "").strip() or "—",
                "status": status,
                "status_label": "已绑定" if enabled else "已停用",
                "bind_method": method,
                "bind_method_label": method_label,
                "bound_at": str(bound_at or "").strip(),
                "peer_open_id": str(peer_open_id or "").strip(),
                "enabled": bool(enabled),
                "source": source,
            }
        )

    try:
        from evoflow.proactive.repositories import ProactiveRepository

        for role in ProactiveRepository.list_roles():
            code = str(getattr(role, "agent_code", "") or "").strip()
            if not code:
                continue
            cfg = getattr(role, "config", None)
            name = _resolve_employee_zh_name(code, role)
            if cfg is None:
                continue
            feishu_app = str(getattr(cfg, "feishu_app_id", "") or "").strip()
            feishu_secret = str(getattr(cfg, "feishu_app_secret", "") or "").strip()
            feishu_bound = str(getattr(cfg, "feishu_bound_at", "") or "").strip()
            if feishu_app and feishu_secret:
                _append(
                    platform="feishu",
                    bot_id=feishu_app,
                    agent_code=code,
                    employee_name=name,
                    bound_at=feishu_bound,
                    enabled=True,
                    bind_method="qr" if feishu_bound else "config",
                    peer_open_id=str(getattr(cfg, "feishu_open_id", "") or "").strip(),
                    source="role",
                )
            wecom_bot = str(getattr(cfg, "wecom_bot_id", "") or "").strip()
            wecom_secret = str(getattr(cfg, "wecom_secret", "") or "").strip()
            wecom_bound = str(getattr(cfg, "wecom_bound_at", "") or "").strip()
            if wecom_bot and wecom_secret:
                _append(
                    platform="wecom",
                    bot_id=wecom_bot,
                    agent_code=code,
                    employee_name=name,
                    bound_at=wecom_bound,
                    enabled=True,
                    bind_method="qr" if wecom_bound else "config",
                    source="role",
                )
    except Exception:
        logger.debug("channel_bindings: role scan failed", exc_info=True)

    try:
        from evoflow.persistence.config_repositories import list_all_bot_bindings

        for row in list_all_bot_bindings(enabled_only=False):
            plat = str(row.get("platform") or "").strip().lower()
            bid = str(row.get("bot_id") or "").strip()
            code = str(row.get("agent_code") or "").strip()
            name = _resolve_employee_zh_name(code, None) if code else "—"
            try:
                from evoflow.proactive.repositories import ProactiveRepository

                role = ProactiveRepository.get_role(code) if code else None
                if role is not None:
                    name = _resolve_employee_zh_name(code, role)
            except Exception:
                pass
            _append(
                platform=plat,
                bot_id=bid,
                agent_code=code,
                employee_name=name,
                bound_at=str(row.get("bound_at") or "").strip(),
                enabled=bool(row.get("enabled", True)),
                bind_method="config",
                source="bot_bindings",
            )
    except Exception:
        logger.debug("channel_bindings: table scan failed", exc_info=True)

    ch = str(channel or "").strip().lower()
    if ch and ch != "all":
        items = [it for it in items if str(it.get("channel") or "").lower() == ch]
    query = str(q or "").strip().lower()
    if query:
        items = [
            it
            for it in items
            if query in str(it.get("bot_id") or "").lower()
            or query in str(it.get("agent_code") or "").lower()
            or query in str(it.get("employee_name") or "").lower()
            or query in str(it.get("channel") or "").lower()
            or query in str(it.get("channel_label") or "").lower()
        ]

    items.sort(key=lambda it: str(it.get("bound_at") or ""), reverse=True)
    return {"items": items, "total": len(items)}
