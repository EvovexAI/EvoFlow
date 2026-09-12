"""Push task/goal completion summaries to a chosen IM channel target."""

from __future__ import annotations

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
        try:
            await service.feishu_push_markdown(tid, text, receive_id_type=receive_id_type)
        except Exception as e:
            logger.warning("push feishu failed: %s", e, exc_info=True)
            return False, str(e)[:200]
        return True, "ok"

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
    try:
        await service.bus.publish_outbound(msg)
    except Exception as e:
        logger.warning("push %s failed: %s", ch, e, exc_info=True)
        return False, str(e)[:200]
    return True, "ok"
