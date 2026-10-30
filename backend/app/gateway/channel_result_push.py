"""Push task/goal completion summaries to a chosen IM channel target."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

logger = logging.getLogger(__name__)

PUSH_CHANNELS = frozenset({"feishu", "weixin", "slack", "telegram"})
_CHANNEL_LABELS = {
    "feishu": "飞书",
    "weixin": "微信",
    "slack": "Slack",
    "telegram": "Telegram",
}
_MAX_MARKDOWN = 7800


def _channel_label(name: str) -> str:
    return _CHANNEL_LABELS.get(str(name or "").strip(), str(name or "渠道"))


def _parse_context_json(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if not raw:
        return {}
    try:
        import json

        parsed = json.loads(str(raw))
        return parsed if isinstance(parsed, dict) else {}
    except Exception:
        return {}


def _short_id(raw: str, *, keep: int = 14) -> str:
    s = str(raw or "").strip()
    if not s:
        return ""
    if len(s) <= keep:
        return s
    return f"{s[: max(8, keep - 2)]}…"


def _agent_code_from_session_key(session_key: str) -> str:
    sk = str(session_key or "").strip()
    if not sk.startswith("agent:"):
        return ""
    parts = sk.split(":")
    if len(parts) < 2:
        return ""
    return str(parts[1] or "").strip()


def _role_name_lookup() -> dict[str, str]:
    """agent_code → role_name (best-effort)."""
    try:
        from evoflow.proactive.repositories import ProactiveRepository

        out: dict[str, str] = {}
        for role in ProactiveRepository.list_roles() or []:
            code = str(getattr(role, "agent_code", "") or "").strip()
            if not code:
                continue
            name = str(getattr(role, "role_name", "") or "").strip()
            out[code] = name or code
        return out
    except Exception:
        logger.debug("list_push_targets: role name lookup failed", exc_info=True)
        return {}


def _who_label(agent_code: str, *, role_names: dict[str, str] | None = None) -> str:
    code = str(agent_code or "").strip()
    if not code or code in {"main", "lead_agent"}:
        return "主对话"
    names = role_names if role_names is not None else {}
    role_name = str(names.get(code) or "").strip()
    if role_name and role_name != code:
        return f"{role_name}（{code}）"
    if code == "xiaomi":
        return "小V（xiaomi）"
    return f"智能体 {code}"


def format_im_push_target_label(
    *,
    channel: str,
    target_id: str,
    session_key: str = "",
    title: str = "",
    source: str = "",
    agent_code: str = "",
    role_names: dict[str, str] | None = None,
) -> str:
    """Human-readable selector label: 渠道 · 岗位/主对话 · id."""
    ch = _channel_label(channel)
    tid = str(target_id or "").strip()
    short = _short_id(tid)
    code = str(agent_code or "").strip() or _agent_code_from_session_key(session_key)
    who = _who_label(code, role_names=role_names)

    if source == "feishu_default":
        return f"{ch} · 默认推送（主机器人） · {short}" if short else f"{ch} · 默认推送（主机器人）"
    if source == "role_binding":
        return f"{ch} · {who} · 私聊绑定" + (f" · {short}" if short else "")

    bits = [ch, who]
    # Keep a distinct human title only when it adds info beyond channel/id
    t = str(title or "").strip()
    if t:
        weak_prefix = f"{ch} · "
        if t.startswith(weak_prefix):
            rest = t[len(weak_prefix) :].strip()
            # Old auto titles are just the chat id — skip
            if rest and rest != short and not rest.startswith(tid[:8]):
                if who not in rest and rest not in who:
                    bits.append(rest)
        elif who not in t and ch not in t:
            bits.append(t)
    if short:
        bits.append(short)
    return " · ".join(bits)


def list_push_targets(*, limit: int = 200) -> list[dict[str, Any]]:
    """List selectable IM push destinations (bound sessions + Feishu default)."""
    from evoflow.persistence.db import get_db

    targets: list[dict[str, Any]] = []
    seen: set[str] = set()
    role_names = _role_name_lookup()

    def _add(
        *,
        channel: str,
        target_id: str,
        label: str = "",
        source: str,
        session_key: str = "",
        agent_code: str = "",
        title: str = "",
    ) -> None:
        ch = str(channel or "").strip().lower()
        tid = str(target_id or "").strip()
        if not ch or not tid or ch not in PUSH_CHANNELS:
            return
        key = f"{ch}:{tid}"
        pretty = label or format_im_push_target_label(
            channel=ch,
            target_id=tid,
            session_key=session_key,
            title=title,
            source=source,
            agent_code=agent_code,
            role_names=role_names,
        )
        if key in seen:
            # Prefer a richer label when the same chat_id appears from multiple sessions
            for item in targets:
                if item.get("id") == key and len(pretty) > len(str(item.get("label") or "")):
                    item["label"] = pretty
                    if session_key and not item.get("sessionKey"):
                        item["sessionKey"] = session_key
                    if agent_code and not item.get("agentCode"):
                        item["agentCode"] = agent_code
            return
        seen.add(key)
        code = str(agent_code or "").strip() or _agent_code_from_session_key(session_key)
        targets.append(
            {
                "id": key,
                "channel": ch,
                "targetId": tid,
                "label": pretty,
                "source": source,
                "sessionKey": session_key or "",
                "agentCode": code,
            }
        )

    try:
        from app.gateway.routers.channels import get_feishu_automation_default_chat_id

        feishu_default = str(get_feishu_automation_default_chat_id() or "").strip()
        if feishu_default:
            _add(
                channel="feishu",
                target_id=feishu_default,
                source="feishu_default",
                agent_code="main",
            )
    except Exception:
        logger.debug("list_push_targets: feishu default unavailable", exc_info=True)

    # Employee Feishu open_id bindings (DM) — shown separately when present
    try:
        from evoflow.proactive.repositories import ProactiveRepository

        for role in ProactiveRepository.list_roles() or []:
            cfg = getattr(role, "config", None)
            open_id = str(getattr(cfg, "feishu_open_id", "") or "").strip()
            code = str(getattr(role, "agent_code", "") or "").strip()
            if not open_id or not code:
                continue
            _add(
                channel="feishu",
                target_id=open_id,
                source="role_binding",
                agent_code=code,
                session_key=f"agent:{code}:feishu-binding",
            )
    except Exception:
        logger.debug("list_push_targets: role binding scan failed", exc_info=True)

    lim = max(1, min(int(limit), 500))
    try:
        rows = (
            get_db()
            .execute(
                """
                SELECT session_key, title, context_json
                FROM evoflow_chat_sessions
                WHERE is_deleted = 0
                  AND COALESCE(session_status, 'active') != 'prewarmed'
                ORDER BY updated_at DESC
                LIMIT ?
                """,
                (lim,),
            )
            .fetchall()
        )
        for row in rows:
            d = {k: row[k] for k in row.keys()}
            ctx = _parse_context_json(d.get("context_json"))
            ch = str(ctx.get("channel") or "").strip().lower()
            tid = str(ctx.get("channel_chat_id") or "").strip()
            if not ch or not tid:
                continue
            title = str(d.get("title") or "").strip()
            sk = str(d.get("session_key") or "").strip()
            agent = str(ctx.get("agent_code") or ctx.get("agent_name") or "").strip() or _agent_code_from_session_key(sk)
            _add(
                channel=ch,
                target_id=tid,
                source="session",
                session_key=sk,
                agent_code=agent,
                title=title,
            )
    except Exception:
        logger.warning("list_push_targets: session scan failed", exc_info=True)

    return targets


def push_targets_configured() -> bool:
    return bool(list_push_targets(limit=50))


def resolve_push_target(
    *,
    push_enabled: bool,
    push_channel: str | None = None,
    push_target_id: str | None = None,
) -> tuple[str, str] | None:
    """Return (channel, target_id) when push is enabled, else None."""
    if not push_enabled:
        return None
    ch = str(push_channel or "").strip().lower()
    tid = str(push_target_id or "").strip()
    if ch and tid:
        return ch, tid
    if ch == "feishu" or not ch:
        try:
            from app.gateway.routers.channels import get_feishu_automation_default_chat_id

            fallback = str(get_feishu_automation_default_chat_id() or "").strip()
            if fallback:
                return "feishu", fallback
        except Exception:
            logger.debug("resolve_push_target: feishu fallback failed", exc_info=True)
    return None


_PUSH_RETRY_DELAYS_S = (2.0, 6.0)
"""P0-2: transient IM failures must not sink the result — retry twice with backoff."""


async def _push_with_retry(label: str, send) -> tuple[bool, str]:
    last_err = "unknown"
    for attempt in range(len(_PUSH_RETRY_DELAYS_S) + 1):
        if attempt:
            await asyncio.sleep(_PUSH_RETRY_DELAYS_S[attempt - 1])
        try:
            return await send()
        except Exception as e:
            last_err = str(e)[:200]
            logger.warning("push %s attempt %d failed: %s", label, attempt + 1, e, exc_info=True)
    return False, last_err


def resolve_inbound_origin_from_session(session_key: str) -> dict[str, Any] | None:
    """Load IM origin (channel/chat/account/topic) stamped when the user messaged in.

    Returns ``None`` when this is not an IM-backed session (no channel routing).
    """
    sk = str(session_key or "").strip()
    if not sk:
        return None
    try:
        from evoflow.persistence.session_repositories import (
            get_session_context_for_run_config,
            get_session_row_for_ui,
        )
    except Exception:
        logger.debug("resolve_inbound_origin: session repos unavailable", exc_info=True)
        return None

    ctx = get_session_context_for_run_config(sk) or {}
    if not isinstance(ctx, dict):
        ctx = {}
    channel = str(ctx.get("channel") or "").strip().lower()
    chat_id = str(ctx.get("channel_chat_id") or "").strip()
    if not channel or not chat_id:
        return None
    row = get_session_row_for_ui(sk) or {}
    thread_id = str(row.get("threadId") or row.get("thread_id") or "").strip()
    return {
        "session_key": sk,
        "channel": channel,
        "chat_id": chat_id,
        "account_id": str(ctx.get("account_id") or "").strip(),
        "topic_id": str(ctx.get("topic_id") or "").strip() or None,
        "user_id": str(ctx.get("user_id") or "").strip(),
        "thread_id": thread_id,
        "agent_code": str(ctx.get("agent_code") or ctx.get("agent_name") or "").strip(),
    }


async def push_to_inbound_origin(
    *,
    session_key: str,
    text: str = "",
    paths: list[str] | None = None,
    title: str = "",
) -> dict[str, Any]:
    """Push text/files back to the same IM chat+bot that originated this session.

    Does **not** accept a channel/account picker — routing is taken from the
    session index written by ChannelManager on inbound.
    """
    origin = resolve_inbound_origin_from_session(session_key)
    if origin is None:
        return {
            "ok": False,
            "error": "not_im_session",
            "hint": "当前会话没有 IM 来源（channel/channel_chat_id）。只在飞书/企微等通道会话里用 channels.send_message。",
        }

    body = str(text or "").strip()
    title_s = str(title or "").strip()
    if title_s and body:
        body = f"**{title_s}**\n\n{body}"
    elif title_s:
        body = f"**{title_s}**"
    if len(body) > _MAX_MARKDOWN:
        body = body[: _MAX_MARKDOWN - 20] + "\n\n…（已截断）"

    path_list = [str(p).strip() for p in (paths or []) if str(p or "").strip()]
    if not body and not path_list:
        return {"ok": False, "error": "empty_payload", "hint": "请提供 text 和/或 paths（文件路径）"}

    channel = str(origin["channel"])
    chat_id = str(origin["chat_id"])
    account_id = str(origin.get("account_id") or "")
    topic_id = origin.get("topic_id")
    thread_id = str(origin.get("thread_id") or "")

    from app.channels.message_bus import OutboundMessage
    from app.channels.service import get_channel_service

    service = get_channel_service()
    if service is None or service.bus is None:
        return {"ok": False, "error": "channel_service_unavailable"}

    status = service.get_status()
    ch_status = (status.get("channels") or {}).get(channel) or {}
    if not ch_status.get("running"):
        return {"ok": False, "error": f"{channel}_not_running", "channel": channel}

    attachments = []
    unresolved: list[str] = []
    if path_list:
        try:
            from app.channels.manager import _resolve_attachments

            attachments = _resolve_attachments(thread_id, path_list) if thread_id else []
            resolved_names = {a.filename.lower() for a in attachments}
            for p in path_list:
                from pathlib import Path as _P

                if _P(str(p).replace("\\", "/")).name.lower() not in resolved_names:
                    # Absolute path fallback without thread sandbox when thread_id missing
                    att = None
                    if not thread_id:
                        from app.channels.manager import _resolve_one_attachment

                        att = _resolve_one_attachment("", p)
                    if att is not None:
                        attachments.append(att)
                    else:
                        unresolved.append(p)
        except Exception as exc:
            logger.warning("push_to_inbound_origin: resolve attachments failed: %s", exc, exc_info=True)
            unresolved = list(path_list)

    if not body and attachments:
        body = "📎 " + "、".join(a.filename for a in attachments)

    msg = OutboundMessage(
        channel_name=channel,
        chat_id=chat_id,
        thread_id=thread_id,
        text=body or "",
        artifacts=[str(a.virtual_path or a.actual_path) for a in attachments],
        attachments=list(attachments),
        is_final=True,
        topic_id=str(topic_id) if topic_id else None,
        metadata={
            "kind": "platform_channel_send",
            "triggered_by": "platform",
            "account_id": account_id,
        },
        account_id=account_id,
    )

    async def _send() -> tuple[bool, str]:
        await service.bus.publish_outbound(msg)
        return True, "ok"

    ok, err = await _push_with_retry(f"{channel}/{account_id or 'primary'}", _send)
    out: dict[str, Any] = {
        "ok": bool(ok),
        "channel": channel,
        "chat_id": chat_id,
        "account_id": account_id or "",
        "topic_id": topic_id,
        "text_len": len(body or ""),
        "attachments": [a.filename for a in attachments],
        "unresolved_paths": unresolved,
    }
    if not ok:
        out["error"] = err
    return out


async def push_markdown_result(
    *,
    channel: str,
    target_id: str,
    title: str,
    markdown_body: str,
) -> tuple[bool, str]:
    ch = str(channel or "").strip().lower()
    tid = str(target_id or "").strip()
    body = (markdown_body or "").strip()
    if not ch or not tid or not body:
        return False, "missing_channel_target_or_body"
    t = (title or "任务结果").strip() or "任务结果"
    text = (f"**{t}**\n\n{body}").strip()[:_MAX_MARKDOWN]

    if ch == "feishu":
        from app.channels.service import get_channel_service

        service = get_channel_service()
        if service is None:
            return False, "channel_service_unavailable"
        receive_id_type = "chat_id"
        if tid.startswith("ou_"):
            receive_id_type = "open_id"
        elif tid.startswith("on_"):
            receive_id_type = "union_id"

        async def _send_feishu() -> tuple[bool, str]:
            await service.feishu_push_markdown(tid, text, receive_id_type=receive_id_type)
            return True, "ok"

        return await _push_with_retry("feishu", _send_feishu)

    from app.channels.message_bus import OutboundMessage
    from app.channels.service import get_channel_service

    service = get_channel_service()
    if service is None or service.bus is None:
        return False, "channel_service_unavailable"
    status = service.get_status()
    ch_status = (status.get("channels") or {}).get(ch) or {}
    if not ch_status.get("running"):
        return False, f"{ch}_not_running"

    msg = OutboundMessage(
        channel_name=ch,
        chat_id=tid,
        thread_id="",
        text=text,
        is_final=True,
    )

    async def _send_bus() -> tuple[bool, str]:
        await service.bus.publish_outbound(msg)
        return True, "ok"

    return await _push_with_retry(ch, _send_bus)


async def push_automation_run_terminal(task: dict[str, Any] | None) -> tuple[bool, str]:
    """P0-2: fan a workflow terminal state out to the automation's IM push target.

    ``task`` is the main-task row at terminal time; the automation binding
    (``automation_id``) and push config live on the automation record. No-op
    unless the automation exists and has push enabled — panel-triggered runs
    are watched live and must not spam IM channels.
    """
    import asyncio as _asyncio

    from evoflow.persistence import automation_repositories as auto_repo

    t = task if isinstance(task, dict) else {}
    automation_id = str(t.get("automation_id") or "").strip()
    if not automation_id:
        return False, "no_automation_binding"
    try:
        automation = await _asyncio.to_thread(auto_repo.load_automation, automation_id)
    except Exception as e:
        logger.warning("terminal push: load automation %s failed: %s", automation_id, e)
        return False, "automation_load_failed"
    if not isinstance(automation, dict) or not bool(automation.get("feishu_push_enabled")):
        return False, "push_disabled"
    target = resolve_push_target(
        push_enabled=True,
        push_channel=str(automation.get("push_channel") or ""),
        push_target_id=str(automation.get("push_target_id") or ""),
    )
    if not target:
        return False, "no_push_target"
    channel, target_id = target
    st = str(t.get("status") or "").strip().lower()
    if st in {"completed", "done", "success"}:
        outcome = "成功"
    elif st in {"failed", "error"}:
        outcome = "失败"
    else:
        outcome = st or "已结束"
    name = str(t.get("automation_name") or automation.get("name") or "自动化")
    summary = str(t.get("result_summary") or t.get("error_text") or "").strip()[:800]
    body = f"工作流{outcome}\n- 任务：{name}\n- 运行 ID：`{str(t.get('source_run_id') or '—')}`"
    if summary:
        body += f"\n\n{summary}"
    return await push_markdown_result(
        channel=channel,
        target_id=target_id,
        title=f"{name}｜{outcome}",
        markdown_body=body,
    )
