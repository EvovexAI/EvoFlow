"""
Feishu/Lark channel — connects to Feishu via WebSocket (no public IP needed).

⚠️ COMPLIANCE NOTICE
This integration uses the official Feishu Open Platform API (lark-oapi SDK).
Use only with authorized Feishu app credentials and in compliance with the
Feishu Developer Agreement (https://open.feishu.cn/). Not for unauthorized
data collection or bulk messaging without user consent.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import os
import re
import threading
import time
import types
from concurrent.futures import TimeoutError as FuturesTimeoutError
from dataclasses import replace
from datetime import datetime
from typing import Any
from urllib.parse import parse_qs, urlparse

from app.channels.base import Channel
from app.channels.feishu_message_format import feishu_outbound_text
from app.channels.message_bus import InboundMessageType, MessageBus, OutboundMessage, ResolvedAttachment

logger = logging.getLogger(__name__)

_STREAM_STATE_TTL_SECONDS = 3600.0
_STREAM_STATE_MAX_ENTRIES = 10_000
_FINAL_FINGERPRINT_TTL_SECONDS = 8.0
_INBOUND_DEDUP_TTL_SECONDS = 120.0
_INBOUND_CONTENT_DEDUP_TTL_SECONDS = 20.0


class _FeishuInboundDeduper:
    """Drop Feishu WS redeliveries / reconnect replays of the same inbound."""

    def __init__(self, *, id_ttl: float = _INBOUND_DEDUP_TTL_SECONDS, content_ttl: float = _INBOUND_CONTENT_DEDUP_TTL_SECONDS):
        self._id_ttl = id_ttl
        self._content_ttl = content_ttl
        self._by_msg_id: dict[str, float] = {}
        self._by_content: dict[str, float] = {}

    def _cleanup(self, store: dict[str, float], now: float, ttl: float) -> None:
        cutoff = now - ttl
        for key in [k for k, ts in store.items() if ts < cutoff]:
            store.pop(key, None)

    def is_duplicate(self, *, account_id: str, msg_id: str, chat_id: str, text: str) -> bool:
        now = time.time()
        self._cleanup(self._by_msg_id, now, self._id_ttl)
        self._cleanup(self._by_content, now, self._content_ttl)
        aid = str(account_id or "").strip() or "primary"
        mid = str(msg_id or "").strip()
        if mid:
            id_key = f"{aid}:{mid}"
            if id_key in self._by_msg_id:
                return True
            self._by_msg_id[id_key] = now
        # Same bot + chat + normalized body within a short window — covers rare
        # redeliveries that arrive with a new message_id after the first reply.
        body = re.sub(r"\s+", " ", str(text or "").strip())
        body = re.sub(r"@_user_\d+\s*", "", body).strip()
        if body:
            content_key = f"{aid}:{chat_id}:{hashlib.sha1(body.encode('utf-8')).hexdigest()[:16]}"
            if content_key in self._by_content:
                return True
            self._by_content[content_key] = now
        return False


def _feishu_sender_is_bot(event: Any) -> bool:
    """True when the inbound sender is an app/bot (ignore echo / other bots)."""
    try:
        sender = event.event.sender
    except Exception:
        return False
    sender_type = str(getattr(sender, "sender_type", None) or "").strip().lower()
    if sender_type in {"app", "bot", "application"}:
        return True
    return False


def _feishu_mention_open_ids(message: Any) -> set[str]:
    """Collect open_ids from Feishu message.mentions (SDK object or dict)."""
    out: set[str] = set()
    mentions = getattr(message, "mentions", None)
    if mentions is None and isinstance(message, dict):
        mentions = message.get("mentions")
    if not mentions:
        return out
    for item in mentions:
        if item is None:
            continue
        mid = getattr(item, "id", None)
        if mid is None and isinstance(item, dict):
            mid = item.get("id")
        if mid is None:
            continue
        for attr in ("open_id", "user_id", "union_id"):
            val = getattr(mid, attr, None) if not isinstance(mid, dict) else mid.get(attr)
            if val:
                out.add(str(val).strip())
        if isinstance(mid, str) and mid.strip():
            out.add(mid.strip())
    return out


def _feishu_account_open_id(config: dict[str, Any], account_id: str) -> str:
    """Resolve this bot's open_id from primary config or accounts[account_id]."""
    aid = str(account_id or "").strip()
    if aid:
        accounts = config.get("accounts")
        if isinstance(accounts, dict):
            acc = accounts.get(aid)
            if isinstance(acc, dict):
                oid = str(acc.get("open_id") or "").strip()
                if oid:
                    return oid
    return str(config.get("open_id") or "").strip()


def _feishu_group_requires_self_mention(
    *,
    chat_type: str,
    chat_id: str,
    channel_name_hint: str = "feishu",
) -> bool:
    ct = str(chat_type or "").strip().lower()
    if ct in {"p2p", "private", "dm", "direct"}:
        return False
    if ct in {"group", "topic_group", "super_group", "public", "private_group"}:
        return True
    # Feishu group chat_id usually starts with oc_
    if channel_name_hint == "feishu" and str(chat_id or "").strip().lower().startswith("oc_"):
        return True
    return False


def _feishu_should_skip_unmentioned_group(
    *,
    chat_type: str,
    chat_id: str,
    bot_open_id: str,
    mention_open_ids: set[str],
    account_id: str = "",
) -> bool:
    """In groups, ignore messages clearly aimed at another bot.

    Dedicated employee WS (``account_id`` set) already receives only that app's
    events from Feishu — never drop those on open_id mismatch (stored open_id and
    mention id fields often differ). Only unlabeled primary applies the gate.
    """
    if str(account_id or "").strip():
        return False
    if not _feishu_group_requires_self_mention(chat_type=chat_type, chat_id=chat_id):
        return False
    oid = str(bot_open_id or "").strip()
    if not oid or not mention_open_ids:
        return False
    return oid not in mention_open_ids

_RISK_LABEL_ZH = {
    "low": "低风险",
    "medium": "中风险",
    "high": "高风险",
    "critical": "极高风险",
}
_ACTION_TYPE_LABEL_ZH = {
    "code_change": "代码变更",
    "analysis": "分析",
    "report": "报告",
    "task_delegation": "任务委派",
    "alert": "告警",
    "optimization": "优化",
}


def resolve_proactive_panel_url(
    *,
    approval_id: str = "",
    initiative_id: str = "",
    agent_code: str = "",
    task_id: str = "",
) -> str | None:
    """Build an absolute Panel deep link for Feishu open-url buttons.

    Prefers ``EVOFLOW_PANEL_URL`` / ``EVOFLOW_WEBUI_PUBLIC_URL``, then
    ``EVOFLOW_GATEWAY_URL``. Returns ``None`` when no base URL is configured
    (button omitted — in-card approve/reject still works).
    """
    base = (
        os.getenv("EVOFLOW_PANEL_URL")
        or os.getenv("EVOFLOW_WEBUI_PUBLIC_URL")
        or os.getenv("EVOFLOW_GATEWAY_URL")
        or ""
    ).strip().rstrip("/")
    if not base:
        return None
    code = str(agent_code or "").strip()
    tid = str(task_id or "").strip()
    if code and tid:
        return f"{base}/#/proactive/{code}/work/{tid}"
    if code:
        return f"{base}/#/proactive/{code}"
    parts = ["tab=approvals"]
    aid = str(approval_id or "").strip()
    iid = str(initiative_id or "").strip()
    if aid:
        parts.append(f"highlight={aid}")
    elif iid:
        parts.append(f"highlight_init={iid}")
    return f"{base}/#/proactive?{'&'.join(parts)}"


def build_proactive_approval_card(
    *,
    approval_id: str,
    initiative_id: str,
    role_name: str,
    department: str,
    title: str,
    description: str,
    risk_level: str,
    action_type: str,
    rationale: str = "",
    expected_outcome: str = "",
    agent_code: str = "",
    timeout_minutes: int | None = None,
    panel_url: str | None = None,
    summary: str = "",
    outputs: list[dict[str, Any]] | None = None,
    card_kind: str = "approval",
    next_handlers: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Interactive Feishu card: approve / reject (+ optional Panel deep link).

    ``outputs`` should already be filtered (docs/media; no source code).
    ``card_kind``: ``approval`` | ``handoff``.
    Handoff cards stay short: review gist + who does what next (no Task IDs).
    """
    risk_emoji = {"low": "🟢", "medium": "🟡", "high": "🟠", "critical": "🔴"}
    emoji = risk_emoji.get(risk_level, "⚪")
    risk_zh = _RISK_LABEL_ZH.get(risk_level, risk_level)
    action_zh = _ACTION_TYPE_LABEL_ZH.get(action_type, action_type)
    is_handoff = str(card_kind or "").strip().lower() == "handoff"

    def _scrub(text: str, *, limit: int = 800) -> str:
        raw = str(text or "").strip()
        if not raw:
            return ""
        cleaned = re.sub(r"`?Task_\d{6,}_\d+`?", "", raw)
        cleaned = re.sub(r"[ \t]+\n", "\n", cleaned)
        cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).strip()
        if len(cleaned) > limit:
            return cleaned[: limit - 1].rstrip() + "…"
        return cleaned

    if is_handoff:
        review = _scrub(summary or description, limit=900)
        md_lines = [
            f"**审核人**：{role_name}" + (f"（{department}）" if department else ""),
            f"**风险**：{emoji} {risk_zh}",
        ]
        if review:
            md_lines.extend(["", "**审核内容**：", review])
        handlers = [h for h in (next_handlers or []) if isinstance(h, dict)]
        if handlers:
            md_lines.extend(["", "**下一步（同意后派发）**："])
            for h in handlers[:6]:
                who = (
                    str(h.get("role") or h.get("role_name") or "").strip()
                    or str(h.get("agent_code") or "").strip()
                    or "下游同事"
                )
                what = _scrub(str(h.get("content") or "").strip(), limit=220)
                md_lines.append(f"- **{who}**：{what or '按上游交付继续执行'}")
        else:
            md_lines.append("\n**下一步**：同意后派下游；当前未指定处理人。")
        md_lines.append("\n同意后下一岗开工；驳回则不派发。")
    else:
        description_truncated = _scrub(description, limit=2000)
        role_line = f"**角色**：{role_name}"
        if department:
            role_line += f"（{department}）"
        md_lines = [
            role_line,
            f"**倡议**：{_scrub(title, limit=160) or '（无标题）'}",
            f"**风险等级**：{emoji} {risk_zh}",
            f"**类型**：{action_zh}",
        ]
        if agent_code:
            md_lines.append(f"**员工**：`{agent_code}`")
        if timeout_minutes and timeout_minutes > 0:
            md_lines.append(f"**审批时限**：{int(timeout_minutes)} 分钟（超时将自动拒绝）")
        if description_truncated:
            md_lines.extend(["", f"**描述**：\n{description_truncated}"])
        summary_s = _scrub(summary, limit=1200)
        if summary_s and summary_s not in description_truncated:
            md_lines.append(f"\n**交付摘要**：\n{summary_s}")
        if rationale:
            md_lines.append(f"\n**分析依据**：\n{_scrub(rationale, limit=800)}")
        if expected_outcome:
            md_lines.append(f"\n**预期效果**：\n{_scrub(expected_outcome, limit=600)}")
        shareable = list(outputs or [])
        if shareable:
            md_lines.append("\n**产出**：")
            for item in shareable[:8]:
                label = str(item.get("label") or item.get("key") or "产物").strip() or "产物"
                typ = str(item.get("type") or "file").strip() or "file"
                value = str(item.get("value") or "").strip()
                if typ == "url" and value:
                    md_lines.append(f"- [{label}]({value})")
                elif typ == "text":
                    md_lines.append(f"- {label}：{_scrub(value, limit=160)}")
                else:
                    leaf = value.replace("\\", "/").rstrip("/").split("/")[-1] or value
                    md_lines.append(f"- {label}：`{leaf}`")

    actions: list[dict[str, Any]] = [
        {
            "tag": "button",
            "text": {"tag": "plain_text", "content": "✅ 同意" if not is_handoff else "✅ 同意派发"},
            "type": "primary",
            "value": {
                "kind": "approval",
                "approval_id": approval_id,
                "action": "approved",
                "decision": "approved",
                "initiative_id": initiative_id,
            },
        },
        {
            "tag": "button",
            "text": {"tag": "plain_text", "content": "❌ 拒绝"},
            "type": "danger",
            "value": {
                "kind": "approval",
                "approval_id": approval_id,
                "action": "rejected",
                "decision": "rejected",
                "initiative_id": initiative_id,
            },
        },
    ]
    if panel_url:
        actions.append(
            {
                "tag": "button",
                "text": {"tag": "plain_text", "content": "📂 在面板查看"},
                "type": "default",
                "url": panel_url,
            }
        )

    header_title = (
        f"🔔 转交任务汇报 · {role_name}" if is_handoff else f"🔔 审批请求 · {role_name}"
    )
    return {
        "config": {"wide_screen_mode": True, "update_multi": True},
        "header": {
            "title": {"tag": "plain_text", "content": header_title},
            "template": "blue" if risk_level in ("low", "medium") else "red",
        },
        "elements": [
            {"tag": "markdown", "content": "\n".join(md_lines)},
            {"tag": "action", "actions": actions},
        ],
    }

def build_proactive_decided_card(*, approved: bool, title: str = "") -> dict[str, Any]:
    """Card body after approve/reject — removes buttons."""
    status_text = "✅ 已同意" if approved else "❌ 已拒绝"
    template = "green" if approved else "grey"
    now = datetime.now().strftime("%H:%M")
    body = f"**{status_text}**\n\n该审批请求已在 {now} 处理完毕。"
    if title:
        body = f"**{status_text}** · {title}\n\n该审批请求已在 {now} 处理完毕。"
    return {
        "config": {"wide_screen_mode": True, "update_multi": True},
        "header": {
            "title": {"tag": "plain_text", "content": status_text},
            "template": template,
        },
        "elements": [{"tag": "markdown", "content": body}],
    }


def build_review_card(
    *,
    task_id: str,
    role_name: str,
    department: str = "",
    agent_code: str = "",
    title: str = "",
    summary: str = "",
    panel_url: str | None = None,
) -> dict[str, Any]:
    """Interactive card: accept / rework / fail a reviewed work item."""
    role_line = f"**角色**：{role_name}"
    if department:
        role_line += f"（{department}）"
    if agent_code:
        role_line += f" · `{agent_code}`"
    md = [
        role_line,
        f"**工作项**：{title or task_id}",
        f"**任务 ID**：`{task_id}`",
        "",
        "岗位已交工，请验收。",
    ]
    summary_s = (summary or "").strip()
    if summary_s:
        md.append(f"\n**交付摘要**：\n{summary_s[:1500]}")
        if len(summary_s) > 1500:
            md.append("\n…（已截断）")

    actions: list[dict[str, Any]] = [
        {
            "tag": "button",
            "text": {"tag": "plain_text", "content": "✅ 验收通过"},
            "type": "primary",
            "value": {
                "kind": "review",
                "action": "completed",
                "task_id": task_id,
                "agent_code": agent_code,
            },
        },
        {
            "tag": "button",
            "text": {"tag": "plain_text", "content": "↺ 打回重做"},
            "type": "default",
            "value": {
                "kind": "review",
                "action": "executing",
                "task_id": task_id,
                "agent_code": agent_code,
            },
        },
        {
            "tag": "button",
            "text": {"tag": "plain_text", "content": "❌ 标记失败"},
            "type": "danger",
            "value": {
                "kind": "review",
                "action": "failed",
                "task_id": task_id,
                "agent_code": agent_code,
            },
        },
    ]
    if panel_url:
        actions.append(
            {
                "tag": "button",
                "text": {"tag": "plain_text", "content": "📂 在面板查看"},
                "type": "default",
                "url": panel_url,
            }
        )
    return {
        "config": {"wide_screen_mode": True, "update_multi": True},
        "header": {
            "title": {"tag": "plain_text", "content": f"📋 交工待验收 · {role_name}"},
            "template": "orange",
        },
        "elements": [
            {"tag": "markdown", "content": "\n".join(md)},
            {"tag": "action", "actions": actions},
        ],
    }


def build_review_decided_card(*, action: str, title: str = "") -> dict[str, Any]:
    labels = {
        "completed": ("✅ 已验收通过", "green"),
        "executing": ("↺ 已打回重做", "orange"),
        "failed": ("❌ 已标记失败", "red"),
    }
    status_text, template = labels.get(action, ("已处理", "grey"))
    now = datetime.now().strftime("%H:%M")
    body = f"**{status_text}**"
    if title:
        body += f" · {title}"
    body += f"\n\n已在 {now} 处理完毕。"
    return {
        "config": {"wide_screen_mode": True, "update_multi": True},
        "header": {
            "title": {"tag": "plain_text", "content": status_text},
            "template": template,
        },
        "elements": [{"tag": "markdown", "content": body}],
    }


_WRAP_ITEM_STATUS_LABEL = {
    "pending_approval": "待批",
    "completed": "完成",
    "failed": "失败",
    "executing": "执行中",
    "proposed": "提议",
    "other": "其他",
}


def _format_wrap_next_duty(raw: str) -> str:
    """Shorten ISO next-duty stamps for Feishu cards (drop us / keep offset)."""
    s = str(raw or "").strip()
    if not s:
        return ""
    # 2026-08-15T13:38:34.377047+08:00 → 2026-08-15 13:38 (+08:00)
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        tz = dt.strftime("%z")
        tz_disp = f"{tz[:3]}:{tz[3:]}" if len(tz) == 5 else tz
        return f"{dt.strftime('%Y-%m-%d %H:%M')} ({tz_disp})" if tz_disp else dt.strftime("%Y-%m-%d %H:%M")
    except Exception:
        return s[:32]


def _wrap_item_lines(items: list[dict[str, Any]] | None, *, limit: int = 6) -> list[str]:
    """Human lines for duty-round work items (skip empty journals when possible)."""
    lines: list[str] = []
    for raw in items or []:
        if not isinstance(raw, dict):
            continue
        if raw.get("is_journal"):
            continue
        title = str(raw.get("title") or "").strip()
        preview = str(raw.get("preview") or raw.get("outcome") or raw.get("goal") or "").strip()
        if not title and not preview:
            continue
        st = str(raw.get("status") or "").strip().lower()
        label = _WRAP_ITEM_STATUS_LABEL.get(st, st or "事项")
        head = title or preview[:60]
        line = f"- 【{label}】{head}"
        if title and preview and preview != title:
            line += f"\n  {preview[:160]}"
        lines.append(line)
        if len(lines) >= limit:
            break
    return lines


def build_wrap_digest_card(
    *,
    role_name: str,
    department: str = "",
    agent_code: str = "",
    think_summary: str = "",
    counts: dict[str, Any] | None = None,
    created_task_ids: list[str] | None = None,
    items: list[dict[str, Any]] | None = None,
    next_heartbeat_at: str = "",
    panel_url: str | None = None,
) -> dict[str, Any]:
    """Duty-round digest with open-panel / start-now actions."""
    counts = counts or {}
    role_line = f"**角色**：{role_name}"
    if department:
        role_line += f"（{department}）"
    if agent_code:
        role_line += f" · `{agent_code}`"
    md = [role_line, "", "**本轮概况**"]
    md.append(
        f"- 待批 {int(counts.get('pending_approval') or 0)}"
        f" · 完成 {int(counts.get('completed') or 0)}"
        f" · 失败 {int(counts.get('failed') or 0)}"
        f" · 执行中 {int(counts.get('executing') or 0)}"
    )
    created = [str(x) for x in (created_task_ids or []) if x][:6]
    if created:
        md.append("- 新建工作项：`" + "`, `".join(created) + "`")
    next_disp = _format_wrap_next_duty(next_heartbeat_at)
    if next_disp:
        md.append(f"- 下次上岗：{next_disp}")

    item_lines = _wrap_item_lines(items)
    if item_lines:
        md.append("\n**本轮事项**")
        md.extend(item_lines)

    summary = (think_summary or "").strip()
    if summary:
        md.append(f"\n**本轮小结**：\n{summary[:1200]}")
        if len(summary) > 1200:
            md.append("\n…（已截断）")
    elif not item_lines:
        md.append(
            "\n**本轮小结**：本轮没有写出文字小结（可能仍在执行中或未完整收尾）。"
            "点「打开员工页」看工作过程与看板。"
        )

    actions: list[dict[str, Any]] = [
        {
            "tag": "button",
            "text": {"tag": "plain_text", "content": "👍 已知晓"},
            "type": "default",
            "value": {
                "kind": "wrap",
                "action": "ack",
                "agent_code": agent_code,
            },
        },
        {
            "tag": "button",
            "text": {"tag": "plain_text", "content": "⚡ 立即开工"},
            "type": "primary",
            "value": {
                "kind": "wrap",
                "action": "heartbeat",
                "agent_code": agent_code,
            },
        },
    ]
    if panel_url:
        actions.append(
            {
                "tag": "button",
                "text": {"tag": "plain_text", "content": "📂 打开员工页"},
                "type": "default",
                "url": panel_url,
            }
        )
    return {
        "config": {"wide_screen_mode": True, "update_multi": True},
        "header": {
            "title": {"tag": "plain_text", "content": f"📝 工作汇报 · {role_name}"},
            "template": "turquoise",
        },
        "elements": [
            {"tag": "markdown", "content": "\n".join(md)},
            {"tag": "action", "actions": actions},
        ],
    }


def build_wrap_acked_card(*, started: bool = False, role_name: str = "") -> dict[str, Any]:
    now = datetime.now().strftime("%H:%M")
    if started:
        title = "⚡ 已触发立即开工"
        body = f"**已触发立即开工**"
        if role_name:
            body += f" · {role_name}"
        body += f"\n\n{now} 已安排本轮上班。"
        template = "blue"
    else:
        title = "👍 已阅"
        body = f"**已阅工作汇报**"
        if role_name:
            body += f" · {role_name}"
        body += f"\n\n{now} 确认完毕。"
        template = "grey"
    return {
        "config": {"wide_screen_mode": True, "update_multi": True},
        "header": {
            "title": {"tag": "plain_text", "content": title},
            "template": template,
        },
        "elements": [{"tag": "markdown", "content": body}],
    }


def build_running_work_card(
    *,
    task_id: str,
    role_name: str,
    department: str = "",
    agent_code: str = "",
    title: str = "",
    panel_url: str | None = None,
) -> dict[str, Any]:
    """In-progress work card with stop / cancel actions."""
    role_line = f"**角色**：{role_name}"
    if department:
        role_line += f"（{department}）"
    if agent_code:
        role_line += f" · `{agent_code}`"
    md = [
        role_line,
        f"**工作项**：{title or task_id}",
        f"**任务 ID**：`{task_id}`",
        "",
        "正在处理中。可随时停止本岗当前执行，或取消该任务。",
    ]
    actions: list[dict[str, Any]] = [
        {
            "tag": "button",
            "text": {"tag": "plain_text", "content": "⏹ 停止执行"},
            "type": "danger",
            "value": {
                "kind": "control",
                "action": "stop",
                "task_id": task_id,
                "agent_code": agent_code,
            },
        },
        {
            "tag": "button",
            "text": {"tag": "plain_text", "content": "❌ 取消任务"},
            "type": "default",
            "value": {
                "kind": "control",
                "action": "cancel",
                "task_id": task_id,
                "agent_code": agent_code,
            },
        },
    ]
    if panel_url:
        actions.append(
            {
                "tag": "button",
                "text": {"tag": "plain_text", "content": "📂 在面板查看"},
                "type": "default",
                "url": panel_url,
            }
        )
    return {
        "config": {"wide_screen_mode": True, "update_multi": True},
        "header": {
            "title": {"tag": "plain_text", "content": f"⏳ 处理中 · {role_name}"},
            "template": "blue",
        },
        "elements": [
            {"tag": "markdown", "content": "\n".join(md)},
            {"tag": "action", "actions": actions},
        ],
    }


def build_control_decided_card(*, action: str, title: str = "") -> dict[str, Any]:
    labels = {
        "stop": ("⏹ 已停止执行", "orange"),
        "cancel": ("❌ 已取消任务", "grey"),
    }
    status_text, template = labels.get(action, ("已处理", "grey"))
    now = datetime.now().strftime("%H:%M")
    body = f"**{status_text}**"
    if title:
        body += f" · {title}"
    body += f"\n\n已在 {now} 处理完毕。"
    return {
        "config": {"wide_screen_mode": True, "update_multi": True},
        "header": {
            "title": {"tag": "plain_text", "content": status_text},
            "template": template,
        },
        "elements": [{"tag": "markdown", "content": body}],
    }


def build_run_stopped_card(*, title: str = "") -> dict[str, Any]:
    now = datetime.now().strftime("%H:%M")
    body = f"**⏹ 已停止生成**"
    if title:
        body += f"\n\n{title[:1500]}"
    body += f"\n\n{now} 已取消本轮回复。"
    return {
        "config": {"wide_screen_mode": True, "update_multi": True},
        "header": {
            "title": {"tag": "plain_text", "content": "⏹ 已停止"},
            "template": "grey",
        },
        "elements": [{"tag": "markdown", "content": body}],
    }


class FeishuChannel(Channel):
    """Feishu/Lark IM channel using the ``lark-oapi`` WebSocket client.

    Configuration keys (in ``config.yaml`` under ``channels.feishu``):
        - ``app_id``: Feishu app ID.
        - ``app_secret``: Feishu app secret.
        - ``verification_token``: (optional) Event verification token.

    The channel uses WebSocket long-connection mode so no public IP is required.

    Message flow:
        1. User sends a message → bot adds "OK" emoji reaction
        2. Bot replies (in-thread or in main chat — see ``reply_in_thread`` config)
        3. Agent processes the message and returns a result
        4. Bot updates / finalizes the reply card
        5. Bot adds "DONE" emoji reaction to the original message

    Config:
        ``reply_in_thread`` (bool, default ``False``): Lark ``message.reply`` flag.
        ``False`` = main group chat + one agent thread per ``chat_id``; ``True`` = 话题楼中楼.
    """

    def __init__(self, bus: MessageBus, config: dict[str, Any]) -> None:
        super().__init__(name="feishu", bus=bus, config=config)
        rit = config.get("reply_in_thread", False)
        if isinstance(rit, str):
            self._reply_in_thread = rit.strip().lower() in ("1", "true", "yes", "on")
        else:
            self._reply_in_thread = bool(rit)
        self._thread: threading.Thread | None = None
        self._account_threads: list[threading.Thread] = []
        self._main_loop: asyncio.AbstractEventLoop | None = None
        self._api_client = None
        # account_id → lark.Client ("" = primary Settings bot)
        self._account_clients: dict[str, Any] = {}
        # chat_id → account_id for outbound routing when metadata is missing
        self._chat_account: dict[str, str] = {}
        self._CreateMessageReactionRequest = None
        self._CreateMessageReactionRequestBody = None
        self._Emoji = None
        self._PatchMessageRequest = None
        self._PatchMessageRequestBody = None
        self._background_tasks: set[asyncio.Task] = set()
        self._running_card_ids: dict[str, str] = {}
        self._running_card_tasks: dict[str, asyncio.Task] = {}
        # reply-anchor message_id → chat_id / account_id (for 230002 create fallback)
        self._running_card_chat_ids: dict[str, str] = {}
        self._running_card_account_ids: dict[str, str] = {}
        self._send_card_locks: dict[str, asyncio.Lock] = {}
        self._recent_final_fingerprint: dict[str, tuple[str, float]] = {}
        self._inbound_dedup = _FeishuInboundDeduper()
        self._stream_state_ts: dict[str, float] = {}
        self._pending_stream_updates: dict[str, OutboundMessage] = {}
        self._stream_flush_tasks: dict[str, asyncio.Task] = {}
        self._last_stream_patch_text: dict[str, str] = {}
        self._stream_stop_ctx: dict[str, dict[str, Any]] = {}
        self._claude_code_chat_mode: dict[str, bool] = {}
        self._intro_sent_keys: set[str] = set()
        self.store = None
        self._CreateFileRequest = None
        self._CreateFileRequestBody = None
        self._CreateImageRequest = None
        self._CreateImageRequestBody = None

    @staticmethod
    def _stop_ctx_from_outbound(msg: OutboundMessage) -> dict[str, Any] | None:
        """Build run-control button context for in-progress stream cards."""
        if msg.is_final:
            return None
        meta = msg.metadata if isinstance(msg.metadata, dict) else {}
        rc = meta.get("run_control")
        if isinstance(rc, dict) and str(rc.get("thread_id") or "").strip():
            out = {k: str(rc.get(k) or "").strip() for k in ("channel", "chat_id", "topic_id", "thread_id", "account_id")}
            out["channel"] = out["channel"] or str(msg.channel_name or "feishu")
            out["chat_id"] = out["chat_id"] or str(msg.chat_id or "")
            return out
        thread_id = str(msg.thread_id or "").strip()
        if not thread_id:
            return None
        return {
            "channel": str(msg.channel_name or "feishu"),
            "chat_id": str(msg.chat_id or ""),
            "topic_id": str(msg.topic_id or ""),
            "thread_id": thread_id,
            "account_id": str(meta.get("account_id") or "").strip(),
        }

    async def start(self) -> None:
        if self._running:
            return

        try:
            import lark_oapi as lark
            from lark_oapi.api.im.v1 import (
                CreateFileRequest,
                CreateFileRequestBody,
                CreateImageRequest,
                CreateImageRequestBody,
                CreateMessageReactionRequest,
                CreateMessageReactionRequestBody,
                CreateMessageRequest,
                CreateMessageRequestBody,
                Emoji,
                PatchMessageRequest,
                PatchMessageRequestBody,
                ReplyMessageRequest,
                ReplyMessageRequestBody,
            )
        except ImportError:
            logger.error("lark-oapi is not installed. Install it with: uv add lark-oapi")
            return

        self._lark = lark
        self._CreateMessageRequest = CreateMessageRequest
        self._CreateMessageRequestBody = CreateMessageRequestBody
        self._ReplyMessageRequest = ReplyMessageRequest
        self._ReplyMessageRequestBody = ReplyMessageRequestBody
        self._CreateMessageReactionRequest = CreateMessageReactionRequest
        self._CreateMessageReactionRequestBody = CreateMessageReactionRequestBody
        self._Emoji = Emoji
        self._PatchMessageRequest = PatchMessageRequest
        self._PatchMessageRequestBody = PatchMessageRequestBody
        self._CreateFileRequest = CreateFileRequest
        self._CreateFileRequestBody = CreateFileRequestBody
        self._CreateImageRequest = CreateImageRequest
        self._CreateImageRequestBody = CreateImageRequestBody

        app_id = self.config.get("app_id", "")
        app_secret = self.config.get("app_secret", "")
        accounts = self._normalized_accounts()
        primary_from_config = bool(str(app_id or "").strip() and str(app_secret or "").strip())
        # When only employee accounts exist, REST/WS still need a credential pair.
        # Tag that WS with the account_id so inbound routes to the employee agent.
        bootstrap_account_id = ""
        if not primary_from_config and accounts:
            bootstrap_account_id = next(iter(accounts.keys()))
            first = accounts[bootstrap_account_id]
            app_id = str(first.get("app_id") or "")
            app_secret = str(first.get("app_secret") or "")

        if not app_id or not app_secret:
            logger.error("Feishu channel requires app_id and app_secret (or at least one accounts entry)")
            return

        ws_enabled = self.config.get("websocket_enabled", True)
        if isinstance(ws_enabled, str):
            ws_enabled = ws_enabled.strip().lower() in ("1", "true", "yes", "on")
        else:
            ws_enabled = bool(ws_enabled)

        self._api_client = lark.Client.builder().app_id(app_id).app_secret(app_secret).build()
        self._account_clients[""] = self._api_client
        if bootstrap_account_id:
            self._account_clients[bootstrap_account_id] = self._api_client
        for account_id, acc in accounts.items():
            aid = str(acc.get("app_id") or "").strip()
            secret = str(acc.get("app_secret") or "").strip()
            if not aid or not secret:
                continue
            # Skip duplicate of primary credentials (same bot).
            if aid == str(app_id) and secret == str(app_secret):
                self._account_clients[account_id] = self._api_client
                continue
            self._account_clients[account_id] = lark.Client.builder().app_id(aid).app_secret(secret).build()

        self._main_loop = asyncio.get_event_loop()

        self._running = True
        self.bus.subscribe_outbound(self._on_outbound, channel_name=self.name)

        if ws_enabled:
            # Dedicated thread: WS connect/retry must not block gateway lifespan.
            self._thread = threading.Thread(
                target=self._run_ws,
                args=(app_id, app_secret, bootstrap_account_id),
                daemon=True,
                name="feishu-ws-primary",
            )
            self._thread.start()
            for account_id, acc in accounts.items():
                aid = str(acc.get("app_id") or "").strip()
                secret = str(acc.get("app_secret") or "").strip()
                if not aid or not secret:
                    continue
                if account_id == bootstrap_account_id:
                    continue
                if aid == str(app_id) and secret == str(app_secret):
                    # Same bot as primary WS — already listening; routing via account map only
                    # works when primary WS is tagged (bootstrap) or Settings bot is separate.
                    continue
                t = threading.Thread(
                    target=self._run_ws,
                    args=(aid, secret, account_id),
                    daemon=True,
                    name=f"feishu-ws-{account_id[:24]}",
                )
                self._account_threads.append(t)
                t.start()
            dedicated_ws = sum(
                1
                for account_id, acc in accounts.items()
                if account_id != bootstrap_account_id
                and str(acc.get("app_id") or "").strip()
                and str(acc.get("app_secret") or "").strip()
                and not (
                    str(acc.get("app_id") or "").strip() == str(app_id)
                    and str(acc.get("app_secret") or "").strip() == str(app_secret)
                )
            )
            if bootstrap_account_id:
                logger.info(
                    "Feishu channel started (REST ready; WS in background; "
                    "primary_from_config=%s bootstrap_account_id=%s dedicated_ws=%d accounts=%d) "
                    "— primary WS is tagged as employee account (not unlabeled global primary)",
                    primary_from_config,
                    bootstrap_account_id,
                    dedicated_ws,
                    len(accounts),
                )
            else:
                logger.info(
                    "Feishu channel started (REST ready; WS in background; "
                    "primary_from_config=%s dedicated_ws=%d accounts=%d)",
                    primary_from_config,
                    dedicated_ws,
                    len(accounts),
                )
        else:
            self._thread = None
            logger.info(
                "Feishu channel started (websocket_enabled=false; inbound IM via WebSocket disabled)",
            )

    def _normalized_accounts(self) -> dict[str, dict[str, Any]]:
        raw = self.config.get("accounts")
        if not isinstance(raw, dict):
            return {}
        out: dict[str, dict[str, Any]] = {}
        for key, val in raw.items():
            account_id = str(key or "").strip()
            if not account_id or not isinstance(val, dict):
                continue
            enabled = val.get("enabled", True)
            if isinstance(enabled, str):
                enabled = enabled.strip().lower() in ("1", "true", "yes", "on")
            if not enabled:
                continue
            out[account_id] = val
        return out

    def _api_client_for(self, account_id: str | None = None) -> Any:
        """Resolve lark Client for an account.

        Prefer the stable ``_account_clients`` map — never the temporarily swapped
        ``self._api_client`` during ``send()`` — so card patch uses the same bot
        that created the running card.
        """
        aid = str(account_id or "").strip()
        if aid and aid in self._account_clients:
            return self._account_clients[aid]
        primary = self._account_clients.get("")
        if primary is not None:
            return primary
        return self._api_client

    def _resolve_outbound_account_id(self, msg: OutboundMessage) -> str:
        """Pick which Feishu app credentials send this outbound.

        When inbound stamped ``metadata.account_id`` (including empty primary), trust it.
        Never fall back to ``_chat_account`` in that case — a prior @小V in the same
        group would otherwise steal EvoFlow助手 replies.
        """
        meta = msg.metadata if isinstance(msg.metadata, dict) else {}
        if "account_id" in meta:
            return str(meta.get("account_id") or "").strip()
        # Legacy proactive cards with no account stamp: last inbound bot for this chat.
        return str(self._chat_account.get(str(msg.chat_id or ""), "") or "").strip()

    @staticmethod
    def _prefer_account_id(*candidates: Any) -> str:
        """First non-None candidate; empty string means primary and must be kept."""
        for c in candidates:
            if c is None:
                continue
            return str(c).strip()
        return ""

    @staticmethod
    async def _lark_ws_connect_exclusive(client: Any) -> None:
        """``lark.ws.Client._connect`` without spawning a second background receive task.

        The stock SDK does ``loop.create_task(self._receive_message_loop())`` inside
        ``_connect``. Awaiting ``_receive_message_loop`` again causes
        ``websockets.exceptions.ConcurrencyError`` (two coroutines calling ``recv``).
        """
        from lark_oapi.core.log import logger as lark_logger
        from lark_oapi.ws.client import _parse_ws_conn_exception
        from lark_oapi.ws.const import DEVICE_ID, SERVICE_ID

        await client._lock.acquire()
        if client._conn is not None:
            client._lock.release()
            return
        try:
            conn_url = client._get_conn_url()
            u = urlparse(conn_url)
            q = parse_qs(u.query)
            conn_id = q[DEVICE_ID][0]
            service_id = q[SERVICE_ID][0]

            import websockets

            try:
                conn = await websockets.connect(conn_url)
            except websockets.InvalidStatusCode as exc:
                _parse_ws_conn_exception(exc)
                raise
            client._conn = conn
            client._conn_url = conn_url
            client._conn_id = conn_id
            client._service_id = service_id
            lark_logger.info(client._fmt_log("connected to {}", conn_url))
        finally:
            client._lock.release()

    async def _feishu_ws_connect_loop(
        self,
        app_id: str,
        app_secret: str,
        event_handler: Any,
        loop: asyncio.AbstractEventLoop,
    ) -> None:
        """Connect/receive loop with backoff. Never blocks gateway startup.

        We intentionally avoid ``lark.ws.Client.start()``: on handshake failure it
        enters the SDK's infinite ``_reconnect()`` loop and spams ERROR logs while
        holding the thread. EvoFlow treats Feishu IM as optional at boot.
        """
        import lark_oapi as lark

        delay_sec = 5.0
        max_delay = 120.0
        while self._running:
            client: Any = None
            ping_task: asyncio.Task | None = None
            try:
                client = lark.ws.Client(
                    app_id=app_id,
                    app_secret=app_secret,
                    event_handler=event_handler,
                    log_level=lark.LogLevel.WARNING,
                    auto_reconnect=False,
                )
                client._connect = types.MethodType(self._lark_ws_connect_exclusive, client)
                await client._connect()
                logger.info("Feishu WebSocket connected")
                delay_sec = 5.0
                ping_task = loop.create_task(client._ping_loop())
                await client._receive_message_loop()
            except asyncio.CancelledError:
                break
            except Exception as exc:
                if not self._running:
                    break
                logger.warning(
                    "Feishu WebSocket unavailable (%s); gateway and EvoPanel continue. Retrying in %.0fs.",
                    exc,
                    delay_sec,
                )
            finally:
                if ping_task is not None:
                    ping_task.cancel()
                    with contextlib.suppress(asyncio.CancelledError, Exception):
                        await ping_task
                if client is not None:
                    with contextlib.suppress(Exception):
                        await client._disconnect()
            if not self._running:
                break
            await asyncio.sleep(delay_sec)
            delay_sec = min(delay_sec * 2, max_delay)

    def _run_ws(self, app_id: str, app_secret: str, account_id: str = "") -> None:
        """Run the lark WS client in a dedicated thread (non-blocking for gateway boot)."""
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        aid = str(account_id or "").strip()
        try:
            import lark_oapi as lark
            import lark_oapi.ws.client as _ws_client_mod

            _ws_client_mod.loop = loop

            on_message = (lambda event, _aid=aid: self._on_message(event, account_id=_aid)) if aid else self._on_message

            handler_builder = (
                lark.EventDispatcherHandler.builder("", "")
                .register_p2_im_message_receive_v1(on_message)
                .register_p2_im_message_reaction_created_v1(self._on_im_reaction_event)
                .register_p2_im_message_reaction_deleted_v1(self._on_im_reaction_event)
            )
            # Silence "processor not found" when bots are added to a chat (no business logic).
            for _reg_name in (
                "register_p2_im_chat_member_bot_added_v1",
                "register_p2_im_chat_member_bot_deleted_v1",
            ):
                _reg = getattr(handler_builder, _reg_name, None)
                if callable(_reg):
                    handler_builder = _reg(self._on_im_chat_member_bot_event)
            # lark-oapi renamed register_p2_card_action_trigger_v1 → register_p2_card_action_trigger
            register_card = getattr(handler_builder, "register_p2_card_action_trigger", None) or getattr(
                handler_builder, "register_p2_card_action_trigger_v1", None
            )
            if register_card is None:
                raise AttributeError("lark EventDispatcherHandler has no card action register method")
            event_handler = register_card(self._on_card_action).build()
            loop.run_until_complete(
                self._feishu_ws_connect_loop(app_id, app_secret, event_handler, loop),
            )
        except Exception:
            if self._running:
                logger.exception(
                    "Feishu WebSocket background thread exited (account=%s)",
                    aid or "primary",
                )

    async def stop(self) -> None:
        self._running = False
        self.bus.unsubscribe_outbound(channel_name=self.name)
        for key in list(self._stream_state_ts):
            self._clear_stream_state(key)
        for task in list(self._background_tasks):
            task.cancel()
        self._background_tasks.clear()
        for task in list(self._running_card_tasks.values()):
            task.cancel()
        self._running_card_tasks.clear()
        if self._thread:
            self._thread.join(timeout=5)
            self._thread = None
        for t in list(self._account_threads):
            t.join(timeout=5)
        self._account_threads.clear()
        self._account_clients.clear()
        self._chat_account.clear()
        self._running_card_chat_ids.clear()
        self._running_card_account_ids.clear()
        logger.info("Feishu channel stopped")

    async def send(self, msg: OutboundMessage, *, _max_retries: int = 3) -> None:
        account_id = self._resolve_outbound_account_id(msg)
        api_client = self._api_client_for(account_id)
        if not api_client:
            logger.warning("[Feishu] send called but no api_client available")
            return
        # Temporarily bind for nested helpers that still read self._api_client
        prev_client = self._api_client
        self._api_client = api_client
        try:
            logger.info(
                "[Feishu] sending reply: chat_id=%s, account=%s, thread_ts=%s, is_final=%s, text_len=%d",
                msg.chat_id,
                account_id or "primary",
                msg.thread_ts,
                msg.is_final,
                len(msg.text or ""),
            )
            if msg.is_final:
                logger.info(
                    "[Feishu] final reply text:\n--- assistant ---\n%s\n---",
                    (msg.text or "").strip() or "(empty)",
                )
            else:
                logger.debug("[Feishu] stream patch chat_id=%s text_len=%d", msg.chat_id, len(msg.text or ""))

            msg_for_send = replace(msg, text=feishu_outbound_text(msg.text))

            lock_key = self._stream_lock_key(msg_for_send)

            if not msg.is_final:
                self._enqueue_stream_update(lock_key, msg_for_send)
                return

            await self._drain_stream_flush(lock_key)

            retries = _max_retries
            last_exc: Exception | None = None
            for attempt in range(retries):
                try:
                    await self._send_card_message(msg_for_send)
                    return
                except Exception as exc:
                    last_exc = exc
                    logger.warning(
                        "[Feishu] send attempt failed: thread_ts=%s, is_final=%s, attempt=%d/%d, err=%s",
                        msg.thread_ts,
                        msg.is_final,
                        attempt + 1,
                        retries,
                        exc,
                    )
                    if attempt < retries - 1:
                        delay = 2**attempt
                        logger.warning(
                            "[Feishu] send failed (attempt %d/%d), retrying in %ds: %s",
                            attempt + 1,
                            retries,
                            delay,
                            exc,
                        )
                        await asyncio.sleep(delay)

            logger.error("[Feishu] send failed after %d attempts: %s", retries, last_exc)
            raise last_exc  # type: ignore[misc]
        finally:
            self._api_client = prev_client

    @staticmethod
    def _stream_lock_key(msg: OutboundMessage) -> str:
        return (msg.thread_ts or msg.chat_id or "").strip() or str(msg.chat_id or "")

    def _enqueue_stream_update(self, lock_key: str, msg: OutboundMessage) -> None:
        """Coalesce bursty stream deltas into one in-flight Feishu patch at a time."""
        self._pending_stream_updates[lock_key] = msg
        task = self._stream_flush_tasks.get(lock_key)
        if task is not None and not task.done():
            return
        flush_task = asyncio.create_task(self._flush_stream_updates(lock_key))
        self._stream_flush_tasks[lock_key] = flush_task
        self._track_background_task(flush_task, name="flush_stream_updates", msg_id=lock_key)

    async def _drain_stream_flush(self, lock_key: str) -> None:
        task = self._stream_flush_tasks.get(lock_key)
        if task is not None and not task.done():
            await task

    async def _flush_stream_updates(self, lock_key: str) -> None:
        me = asyncio.current_task()
        try:
            while lock_key in self._pending_stream_updates:
                msg = self._pending_stream_updates.pop(lock_key)
                try:
                    await self._send_card_message(msg)
                except Exception:
                    logger.warning(
                        "[Feishu] stream delta patch failed (ignored): thread_ts=%s, text_len=%d",
                        msg.thread_ts,
                        len(msg.text or ""),
                        exc_info=True,
                    )
        finally:
            if self._stream_flush_tasks.get(lock_key) is me:
                self._stream_flush_tasks.pop(lock_key, None)

    async def send_file(self, msg: OutboundMessage, attachment: ResolvedAttachment) -> bool:
        if not self._api_client:
            return False

        # Check size limits (image: 10MB, file: 30MB)
        if attachment.is_image and attachment.size > 10 * 1024 * 1024:
            logger.warning("[Feishu] image too large (%d bytes), skipping: %s", attachment.size, attachment.filename)
            return False
        if not attachment.is_image and attachment.size > 30 * 1024 * 1024:
            logger.warning("[Feishu] file too large (%d bytes), skipping: %s", attachment.size, attachment.filename)
            return False

        # FIX: Use the correct account's client for upload AND send.
        # The file must be uploaded by the same bot that sends it, otherwise
        # Feishu returns "code=230017 Bot is NOT the owner of the resource".
        account_id = self._resolve_outbound_account_id(msg)
        client = self._api_client_for(account_id)
        if client is None:
            client = self._api_client

        try:
            if attachment.is_image:
                file_key = await self._upload_image(attachment.actual_path, client=client)
                msg_type = "image"
                content = json.dumps({"image_key": file_key})
            else:
                file_key = await self._upload_file(attachment.actual_path, attachment.filename, client=client)
                msg_type = "file"
                content = json.dumps({"file_key": file_key})

            if msg.thread_ts:
                request = self._ReplyMessageRequest.builder().message_id(msg.thread_ts).request_body(self._ReplyMessageRequestBody.builder().msg_type(msg_type).content(content).reply_in_thread(self._reply_in_thread).build()).build()
                await asyncio.to_thread(client.im.v1.message.reply, request)
            else:
                request = self._CreateMessageRequest.builder().receive_id_type("chat_id").request_body(self._CreateMessageRequestBody.builder().receive_id(msg.chat_id).msg_type(msg_type).content(content).build()).build()
                await asyncio.to_thread(client.im.v1.message.create, request)

            logger.info("[Feishu] file sent: %s (type=%s, account=%s)", attachment.filename, msg_type, account_id or "default")
            return True
        except Exception:
            logger.exception("[Feishu] failed to upload/send file: %s", attachment.filename)
            return False

    async def _upload_image(self, path, *, client=None) -> str:
        """Upload an image to Feishu and return the image_key.

        FIX: Accept an explicit ``client`` so the upload is performed by the
        same bot account that will send the message (avoids 230017 ownership error).
        """
        api_client = client or self._api_client
        with open(str(path), "rb") as f:
            request = self._CreateImageRequest.builder().request_body(self._CreateImageRequestBody.builder().image_type("message").image(f).build()).build()
            response = await asyncio.to_thread(api_client.im.v1.image.create, request)
        if not response.success():
            raise RuntimeError(f"Feishu image upload failed: code={response.code}, msg={response.msg}")
        return response.data.image_key

    async def _upload_file(self, path, filename: str, *, client=None) -> str:
        """Upload a file to Feishu and return the file_key.

        FIX: Accept an explicit ``client`` so the upload is performed by the
        same bot account that will send the message (avoids 230017 ownership error).
        """
        api_client = client or self._api_client
        suffix = path.suffix.lower() if hasattr(path, "suffix") else ""
        if suffix in (".xls", ".xlsx", ".csv"):
            file_type = "xls"
        elif suffix in (".ppt", ".pptx"):
            file_type = "ppt"
        elif suffix == ".pdf":
            file_type = "pdf"
        elif suffix in (".doc", ".docx"):
            file_type = "doc"
        else:
            file_type = "stream"

        with open(str(path), "rb") as f:
            request = self._CreateFileRequest.builder().request_body(self._CreateFileRequestBody.builder().file_type(file_type).file_name(filename).file(f).build()).build()
            response = await asyncio.to_thread(api_client.im.v1.file.create, request)
        if not response.success():
            raise RuntimeError(f"Feishu file upload failed: code={response.code}, msg={response.msg}")
        return response.data.file_key

    # -- message formatting ------------------------------------------------

    @staticmethod
    def _build_card_content(text: str, *, stop_ctx: dict[str, Any] | None = None) -> str:
        """Build a Feishu interactive card with markdown content.

        Feishu's interactive card format natively renders markdown, including
        headers, bold/italic, code blocks, lists, and links.

        When ``stop_ctx`` is set (streaming reply in progress), append a 停止 button.
        """
        # 单元素 markdown 过长会导致 reply/patch 失败且无明确提示
        max_md = 11000
        suffix = "\n\n…（内容过长，已在卡片内截断）"
        t = text or ""
        if len(t) > max_md:
            cut_at = max_md - len(suffix)
            window_start = max(0, cut_at - 80)
            segment = t[window_start:cut_at]
            break_idx = segment.rfind("\n\n")
            if break_idx < 0:
                break_idx = segment.rfind("\n")
            if break_idx >= 0:
                cut_at = window_start + break_idx
            t = t[:cut_at] + suffix
        elements: list[dict[str, Any]] = [{"tag": "markdown", "content": t}]
        if stop_ctx:
            value = {"kind": "run_control", "action": "stop"}
            for key in ("channel", "chat_id", "topic_id", "thread_id", "account_id"):
                raw = stop_ctx.get(key)
                if raw is not None and str(raw).strip():
                    value[key] = str(raw).strip()
            elements.append(
                {
                    "tag": "action",
                    "actions": [
                        {
                            "tag": "button",
                            "text": {"tag": "plain_text", "content": "⏹ 停止"},
                            "type": "danger",
                            "value": value,
                        }
                    ],
                }
            )
        card = {
            "config": {"wide_screen_mode": True, "update_multi": True},
            "elements": elements,
        }
        return json.dumps(card)

    @staticmethod
    def _lark_call_succeeded(response: Any) -> tuple[bool, str]:
        """Best-effort: lark-oapi responses expose ``success()`` or ``success`` bool."""
        if response is None:
            return False, "null response"
        if not hasattr(response, "success"):
            return True, ""
        suc = getattr(response, "success", None)
        try:
            if callable(suc):
                ok = bool(suc())
            else:
                ok = bool(suc) if suc is not None else False
        except TypeError:
            ok = bool(getattr(response, "success", False))
        if ok:
            return True, ""
        code = getattr(response, "code", None)
        msg = getattr(response, "msg", None)
        ext = getattr(response, "error", None) or getattr(response, "ext", None)
        if ext and str(ext).strip() and str(ext) not in str(msg or ""):
            return False, f"code={code}, msg={msg}, ext={ext}"
        return False, f"code={code}, msg={msg}"

    @staticmethod
    def _is_out_of_chat_error(err: str | BaseException) -> bool:
        """Feishu 230002: bot not in chat / cannot reply in that context."""
        text = str(err or "")
        low = text.lower()
        return "230002" in text or "out of the chat" in low or "outside the group" in low

    @staticmethod
    def _is_not_message_sender_error(err: str | BaseException) -> bool:
        """Feishu 230001 ext: patch/update requires the same bot that sent the message."""
        text = str(err or "")
        low = text.lower()
        return "not the message" in low and "sender" in low

    # -- reaction helpers --------------------------------------------------

    async def _add_reaction(self, message_id: str, emoji_type: str = "THUMBSUP") -> None:
        """Add an emoji reaction to a message."""
        if not self._api_client or not self._CreateMessageReactionRequest:
            return
        try:
            request = self._CreateMessageReactionRequest.builder().message_id(message_id).request_body(self._CreateMessageReactionRequestBody.builder().reaction_type(self._Emoji.builder().emoji_type(emoji_type).build()).build()).build()
            await asyncio.to_thread(self._api_client.im.v1.message_reaction.create, request)
            logger.info("[Feishu] reaction '%s' added to message %s", emoji_type, message_id)
        except Exception:
            logger.exception("[Feishu] failed to add reaction '%s' to message %s", emoji_type, message_id)

    async def _reply_card(
        self,
        message_id: str,
        text: str,
        *,
        stop_ctx: dict[str, Any] | None = None,
        chat_id: str = "",
        account_id: str = "",
    ) -> str | None:
        """Reply with an interactive card and return the created card message ID.

        On Feishu 230002 (bot cannot reply in that context), fall back to
        ``message.create`` in ``chat_id`` so the user still gets a card.
        """
        aid = str(account_id or self._running_card_account_ids.get(message_id, "") or "").strip()
        cid = str(chat_id or self._running_card_chat_ids.get(message_id, "") or "").strip()
        api_client = self._api_client_for(aid) or self._api_client
        if not api_client:
            return None

        content = self._build_card_content(text, stop_ctx=stop_ctx)
        request = (
            self._ReplyMessageRequest.builder()
            .message_id(message_id)
            .request_body(
                self._ReplyMessageRequestBody.builder()
                .msg_type("interactive")
                .content(content)
                .reply_in_thread(self._reply_in_thread)
                .build()
            )
            .build()
        )
        response = await asyncio.to_thread(api_client.im.v1.message.reply, request)
        ok, err = self._lark_call_succeeded(response)
        if ok:
            response_data = getattr(response, "data", None)
            return getattr(response_data, "message_id", None)

        logger.error("[Feishu] message.reply failed: root=%s %s", message_id, err)
        if cid and self._is_out_of_chat_error(err):
            logger.warning(
                "[Feishu] reply 230002 — fallback message.create in chat_id=%s account=%s",
                cid,
                aid or "primary",
            )
            return await self._create_card(cid, text, receive_id_type="chat_id", account_id=aid)
        raise RuntimeError(f"Feishu message.reply failed: {err}")

    async def _create_card(
        self,
        receive_id: str,
        text: str,
        *,
        receive_id_type: str = "chat_id",
        account_id: str = "",
    ) -> str | None:
        """Create a new card message in the target chat or conversation."""
        api_client = self._api_client_for(account_id)
        if not api_client:
            return None

        content = self._build_card_content(text)
        request = self._CreateMessageRequest.builder().receive_id_type(receive_id_type).request_body(
            self._CreateMessageRequestBody.builder().receive_id(receive_id).msg_type("interactive").content(content).build()
        ).build()
        response = await asyncio.to_thread(api_client.im.v1.message.create, request)
        suc = getattr(response, "success", None)
        try:
            if callable(suc):
                ok = bool(suc())
            else:
                ok = bool(suc) if suc is not None else False
        except TypeError:
            ok = bool(getattr(response, "success", False))
        if not ok:
            code = getattr(response, "code", None)
            msg = getattr(response, "msg", None)
            raise RuntimeError(f"Feishu message.create failed: code={code}, msg={msg}")
        resp_data = getattr(response, "data", None)
        mid = getattr(resp_data, "message_id", None) if resp_data else None
        logger.info("[Feishu] card message.create ok: receive_id_type=%s message_id=%s", receive_id_type, mid)
        return str(mid) if mid else None

    async def _create_interactive_message(
        self,
        receive_id: str,
        card: dict[str, Any],
        *,
        receive_id_type: str = "chat_id",
        account_id: str = "",
    ) -> str | None:
        api_client = self._api_client_for(account_id)
        if not api_client or not self._CreateMessageRequest:
            return None
        content = json.dumps(card, ensure_ascii=False)
        request = self._CreateMessageRequest.builder().receive_id_type(receive_id_type).request_body(
            self._CreateMessageRequestBody.builder().receive_id(receive_id).msg_type("interactive").content(content).build()
        ).build()
        response = await asyncio.to_thread(api_client.im.v1.message.create, request)
        ok, err = self._lark_call_succeeded(response)
        if not ok:
            logger.error("[Feishu] interactive create failed: account=%s %s", account_id or "primary", err)
            return None
        resp_data = getattr(response, "data", None)
        return getattr(resp_data, "message_id", None) if resp_data else None

    async def send_proactive_markdown(
        self,
        receive_id: str,
        text: str,
        *,
        receive_id_type: str = "chat_id",
        account_id: str = "",
    ) -> None:
        """Send an interactive markdown card without an inbound user message (e.g. cron digest)."""
        api_client = self._api_client_for(account_id)
        if not self._running or not api_client:
            raise RuntimeError("Feishu channel is not running or has no API client")
        if not (receive_id or "").strip() or not (text or "").strip():
            raise ValueError("receive_id and text must be non-empty")
        await self._create_card(
            receive_id.strip(),
            text,
            receive_id_type=receive_id_type,
            account_id=account_id,
        )

    async def send_proactive_approval_card(
        self,
        receive_id: str,
        *,
        approval_id: str,
        initiative_id: str,
        role_name: str,
        department: str,
        title: str,
        description: str,
        risk_level: str,
        action_type: str,
        rationale: str = "",
        expected_outcome: str = "",
        agent_code: str = "",
        timeout_minutes: int | None = None,
        receive_id_type: str = "chat_id",
        account_id: str = "",
        summary: str = "",
        outputs: list[dict] | None = None,
        card_kind: str = "approval",
        next_handlers: list[dict] | None = None,
    ) -> str | None:
        """Send an interactive Feishu card with [同意] [拒绝] (+ optional Panel link)."""
        # account_id="" means primary bot. Do NOT fall back to agent_code — that
        # field is for card copy / panel deep-links only. Falling back reintroduces
        # Feishu 230002 when the employee PersonalAgent is not in the operator chat.
        aid = str(account_id or "").strip()
        api_client = self._api_client_for(aid)
        if not self._running or not api_client:
            raise RuntimeError("Feishu channel is not running or has no API client")
        if not (receive_id or "").strip():
            raise ValueError("receive_id must be non-empty")

        panel_url = resolve_proactive_panel_url(
            approval_id=approval_id,
            initiative_id=initiative_id,
            agent_code=agent_code,
        )
        card = build_proactive_approval_card(
            approval_id=approval_id,
            initiative_id=initiative_id,
            role_name=role_name,
            department=department,
            title=title,
            description=description,
            risk_level=risk_level,
            action_type=action_type,
            rationale=rationale,
            expected_outcome=expected_outcome,
            agent_code=agent_code,
            timeout_minutes=timeout_minutes,
            panel_url=panel_url,
            summary=summary,
            outputs=outputs,
            card_kind=card_kind,
            next_handlers=next_handlers,
        )
        mid = await self._create_interactive_message(
            receive_id,
            card,
            receive_id_type=receive_id_type,
            account_id=aid,
        )
        if mid:
            logger.info(
                "[Feishu] approval card sent: approval=%s initiative=%s msg_id=%s account=%s",
                approval_id,
                initiative_id,
                mid,
                aid or "primary",
            )
        return mid

    async def send_proactive_approval_output_files(
        self,
        receive_id: str,
        *,
        outputs: list[dict],
        workspace_path: str = "",
        receive_id_type: str = "chat_id",
        account_id: str = "",
        max_files: int = 5,
    ) -> list[dict[str, Any]]:
        """Upload shareable non-code file outputs after an approval card.

        Skips urls/text and any code-like paths. Returns per-file results:
        ``{ok, filename, path, message_id, error}``.
        """
        from pathlib import Path

        from evoflow.collab.task_outputs import is_code_output_path, shareable_approval_outputs

        aid = str(account_id or "").strip()
        api_client = self._api_client_for(aid)
        results: list[dict[str, Any]] = []
        if not self._running or not api_client:
            return results
        rid = str(receive_id or "").strip()
        if not rid:
            return results

        roots: list[Path] = []
        wp = str(workspace_path or "").strip()
        if wp:
            roots.append(Path(wp))
        try:
            cwd = Path.cwd()
            roots.append(cwd)
            # Common monorepo layout: backend cwd → parent is repo root
            if cwd.name in {"backend", "app"} and cwd.parent.is_dir():
                roots.append(cwd.parent)
        except Exception:
            pass

        for item in shareable_approval_outputs(outputs, max_items=max_files):
            if str(item.get("type") or "").strip().lower() != "file":
                continue
            value = str(item.get("value") or "").strip().replace("\\", "/")
            if not value or is_code_output_path(value):
                continue
            if value.startswith(("http://", "https://")):
                continue
            path: Path | None = None
            candidate = Path(value)
            if candidate.is_file():
                path = candidate
            else:
                for root in roots:
                    try:
                        p = (root / value).resolve()
                        if p.is_file():
                            path = p
                            break
                    except Exception:
                        continue
            if path is None or not path.is_file():
                logger.debug("[Feishu] approval output file not found: %s", value)
                results.append(
                    {
                        "ok": False,
                        "filename": Path(value).name,
                        "path": value,
                        "message_id": "",
                        "error": "file_not_found",
                    }
                )
                continue
            try:
                if path.stat().st_size > 30 * 1024 * 1024:
                    logger.warning("[Feishu] approval output too large, skip: %s", path)
                    results.append(
                        {
                            "ok": False,
                            "filename": path.name,
                            "path": str(path),
                            "message_id": "",
                            "error": "file_too_large",
                        }
                    )
                    continue
                # FIX: Pass client=api_client so upload uses the same bot that sends.
                # Otherwise Feishu returns "code=230017 Bot is NOT the owner of the resource".
                file_key = await self._upload_file(path, path.name, client=api_client)
                content = json.dumps({"file_key": file_key})
                request = (
                    self._CreateMessageRequest.builder()
                    .receive_id_type(receive_id_type)
                    .request_body(
                        self._CreateMessageRequestBody.builder()
                        .receive_id(rid)
                        .msg_type("file")
                        .content(content)
                        .build()
                    )
                    .build()
                )
                response = await asyncio.to_thread(api_client.im.v1.message.create, request)
                mid = ""
                try:
                    mid = str(getattr(getattr(response, "data", None), "message_id", "") or "")
                except Exception:
                    mid = ""
                if getattr(response, "success", None) and not response.success():
                    err = f"code={getattr(response, 'code', '')} msg={getattr(response, 'msg', '')}"
                    results.append(
                        {
                            "ok": False,
                            "filename": path.name,
                            "path": str(path),
                            "message_id": mid,
                            "error": err,
                        }
                    )
                    continue
                results.append(
                    {
                        "ok": True,
                        "filename": path.name,
                        "path": str(path),
                        "message_id": mid,
                        "error": "",
                    }
                )
                logger.info("[Feishu] approval output file sent: %s", path.name)
            except Exception as exc:
                logger.exception("[Feishu] failed to send approval output: %s", value)
                results.append(
                    {
                        "ok": False,
                        "filename": path.name if path else Path(value).name,
                        "path": str(path or value),
                        "message_id": "",
                        "error": str(exc)[:200],
                    }
                )
        return results

    async def send_proactive_review_card(
        self,
        receive_id: str,
        *,
        task_id: str,
        role_name: str,
        department: str = "",
        agent_code: str = "",
        title: str = "",
        summary: str = "",
        receive_id_type: str = "chat_id",
        account_id: str = "",
    ) -> str | None:
        aid = str(account_id or "").strip()
        api_client = self._api_client_for(aid)
        if not self._running or not api_client:
            raise RuntimeError("Feishu channel is not running or has no API client")
        if not (receive_id or "").strip() or not (task_id or "").strip():
            raise ValueError("receive_id and task_id must be non-empty")
        panel_url = resolve_proactive_panel_url(agent_code=agent_code, task_id=task_id)
        card = build_review_card(
            task_id=task_id,
            role_name=role_name,
            department=department,
            agent_code=agent_code,
            title=title,
            summary=summary,
            panel_url=panel_url,
        )
        mid = await self._create_interactive_message(
            receive_id,
            card,
            receive_id_type=receive_id_type,
            account_id=aid,
        )
        if mid:
            logger.info("[Feishu] review card sent: task=%s agent=%s msg_id=%s", task_id, agent_code, mid)
        return mid

    async def send_proactive_wrap_card(
        self,
        receive_id: str,
        *,
        role_name: str,
        department: str = "",
        agent_code: str = "",
        think_summary: str = "",
        counts: dict[str, Any] | None = None,
        created_task_ids: list[str] | None = None,
        items: list[dict[str, Any]] | None = None,
        next_heartbeat_at: str = "",
        receive_id_type: str = "chat_id",
        account_id: str = "",
    ) -> str | None:
        aid = str(account_id or "").strip()
        api_client = self._api_client_for(aid)
        if not self._running or not api_client:
            raise RuntimeError("Feishu channel is not running or has no API client")
        if not (receive_id or "").strip():
            raise ValueError("receive_id must be non-empty")
        panel_url = resolve_proactive_panel_url(agent_code=agent_code)
        card = build_wrap_digest_card(
            role_name=role_name,
            department=department,
            agent_code=agent_code,
            think_summary=think_summary,
            counts=counts,
            created_task_ids=created_task_ids,
            items=items,
            next_heartbeat_at=next_heartbeat_at,
            panel_url=panel_url,
        )
        mid = await self._create_interactive_message(
            receive_id,
            card,
            receive_id_type=receive_id_type,
            account_id=aid,
        )
        if mid:
            logger.info("[Feishu] wrap card sent: agent=%s msg_id=%s", agent_code, mid)
        return mid

    async def send_proactive_running_card(
        self,
        receive_id: str,
        *,
        task_id: str,
        role_name: str,
        department: str = "",
        agent_code: str = "",
        title: str = "",
        receive_id_type: str = "chat_id",
        account_id: str = "",
    ) -> str | None:
        aid = str(account_id or "").strip()
        api_client = self._api_client_for(aid)
        if not self._running or not api_client:
            raise RuntimeError("Feishu channel is not running or has no API client")
        if not (receive_id or "").strip() or not (task_id or "").strip():
            raise ValueError("receive_id and task_id must be non-empty")
        panel_url = resolve_proactive_panel_url(agent_code=agent_code, task_id=task_id)
        card = build_running_work_card(
            task_id=task_id,
            role_name=role_name,
            department=department,
            agent_code=agent_code,
            title=title,
            panel_url=panel_url,
        )
        mid = await self._create_interactive_message(
            receive_id,
            card,
            receive_id_type=receive_id_type,
            account_id=aid,
        )
        if mid:
            logger.info("[Feishu] running card sent: task=%s agent=%s msg_id=%s", task_id, agent_code, mid)
        return mid

    async def _update_card_to_decided(
        self,
        message_id: str,
        *,
        approved: bool,
        title: str = "",
        account_id: str = "",
    ) -> None:
        """Update an approval card to show the decision result."""
        api_client = self._api_client_for(account_id)
        if not api_client or not self._PatchMessageRequest:
            return
        card = build_proactive_decided_card(approved=approved, title=title)
        content = json.dumps(card, ensure_ascii=False)
        request = self._PatchMessageRequest.builder().message_id(message_id).request_body(
            self._PatchMessageRequestBody.builder().content(content).build()
        ).build()
        response = await asyncio.to_thread(api_client.im.v1.message.patch, request)
        ok, err = self._lark_call_succeeded(response)
        if not ok:
            logger.warning("[Feishu] update approval card to decided failed: msg=%s %s", message_id, err)

    async def _patch_card_raw(
        self,
        message_id: str,
        card: dict[str, Any],
        *,
        account_id: str = "",
    ) -> None:
        api_client = self._api_client_for(account_id)
        if not api_client or not self._PatchMessageRequest or not message_id:
            return
        content = json.dumps(card, ensure_ascii=False)
        request = self._PatchMessageRequest.builder().message_id(message_id).request_body(
            self._PatchMessageRequestBody.builder().content(content).build()
        ).build()
        try:
            await asyncio.to_thread(api_client.im.v1.message.patch, request)
        except Exception:
            logger.debug("[Feishu] patch card failed msg=%s", message_id, exc_info=True)

    def _on_card_action(self, data: Any) -> Any:
        """Handle Feishu interactive card button clicks (WS ``card.action.trigger``).

        Must return quickly (Feishu ~3s limit). Schedules DecisionGate work on the
        gateway event loop and returns toast + updated card when possible.
        """
        from lark_oapi.event.callback.model.p2_card_action_trigger import (
            P2CardActionTriggerResponse,
        )

        def _resp(*, toast_type: str, content: str, card: dict[str, Any] | None = None) -> Any:
            # lark-oapi init() only accepts plain dicts for nested toast/card —
            # passing CallBackToast instances raises UnmarshalException.
            body: dict[str, Any] = {"toast": {"type": toast_type, "content": content}}
            if card is not None:
                body["card"] = {"type": "raw", "data": card}
            return P2CardActionTriggerResponse(body)

        try:
            event = getattr(data, "event", None)
            action = getattr(event, "action", None) if event else None
            raw_value = getattr(action, "value", None) if action else None
            if isinstance(raw_value, str):
                try:
                    value = json.loads(raw_value)
                except json.JSONDecodeError:
                    value = {}
            elif isinstance(raw_value, dict):
                value = raw_value
            else:
                value = {}

            kind = str(value.get("kind") or "").strip().lower()
            initiative_id = str(value.get("initiative_id") or "").strip()
            approval_id = str(value.get("approval_id") or "").strip()
            decision = str(value.get("action") or value.get("decision") or "").strip()
            task_id = str(value.get("task_id") or "").strip()
            agent_code = str(value.get("agent_code") or "").strip()

            # Backward compatible: old approval cards had no kind
            if not kind and decision in ("approved", "rejected") and initiative_id:
                kind = "approval"

            context = getattr(event, "context", None) if event else None
            message_id = str(getattr(context, "open_message_id", None) or "").strip()

            if not (self._main_loop and self._main_loop.is_running() and not self._main_loop.is_closed()):
                logger.warning("[Feishu] card action: main loop not running")
                return _resp(toast_type="error", content="服务暂不可用，请稍后重试或打开面板")

            if kind == "approval":
                if decision not in ("approved", "rejected") or not initiative_id:
                    return _resp(toast_type="info", content="未识别的审批操作")
                fut = asyncio.run_coroutine_threadsafe(
                    self._process_proactive_card_decision(
                        initiative_id=initiative_id,
                        decision=decision,
                        approval_id=approval_id,
                        message_id=message_id,
                        account_id=agent_code,
                    ),
                    self._main_loop,
                )
                try:
                    result = fut.result(timeout=2.5)
                except FuturesTimeoutError:
                    return _resp(toast_type="info", content="正在处理审批…")
                if not result.get("ok"):
                    return _resp(toast_type="error", content=str(result.get("error") or "审批失败")[:80])
                approved = decision == "approved"
                if approved and result.get("handoff"):
                    toast = "已同意，已派下游执行"
                elif approved:
                    toast = "已同意，开始执行"
                else:
                    toast = "已拒绝"
                return _resp(
                    toast_type="success" if approved else "info",
                    content=toast,
                    card=build_proactive_decided_card(
                        approved=approved,
                        title=str(result.get("title") or ""),
                    ),
                )

            if kind == "review":
                if decision not in ("completed", "executing", "failed") or not task_id:
                    return _resp(toast_type="info", content="未识别的验收操作")
                fut = asyncio.run_coroutine_threadsafe(
                    self._process_review_card_decision(
                        task_id=task_id,
                        action=decision,
                        message_id=message_id,
                        account_id=agent_code,
                    ),
                    self._main_loop,
                )
                try:
                    result = fut.result(timeout=2.5)
                except FuturesTimeoutError:
                    return _resp(toast_type="info", content="正在处理验收…")
                if not result.get("ok"):
                    return _resp(toast_type="error", content=str(result.get("error") or "验收失败")[:80])
                toast_map = {
                    "completed": "已验收通过",
                    "executing": "已打回重做",
                    "failed": "已标记失败",
                }
                return _resp(
                    toast_type="success",
                    content=toast_map.get(decision, "已处理"),
                    card=build_review_decided_card(
                        action=decision,
                        title=str(result.get("title") or ""),
                    ),
                )

            if kind == "wrap":
                if decision not in ("ack", "heartbeat") or not agent_code:
                    return _resp(toast_type="info", content="未识别的工作汇报操作")
                fut = asyncio.run_coroutine_threadsafe(
                    self._process_wrap_card_action(
                        agent_code=agent_code,
                        action=decision,
                        message_id=message_id,
                    ),
                    self._main_loop,
                )
                try:
                    result = fut.result(timeout=2.5)
                except FuturesTimeoutError:
                    return _resp(
                        toast_type="info",
                        content="正在触发开工…" if decision == "heartbeat" else "处理中…",
                    )
                if not result.get("ok"):
                    return _resp(toast_type="error", content=str(result.get("error") or "操作失败")[:80])
                started = decision == "heartbeat"
                return _resp(
                    toast_type="success",
                    content="已触发立即开工" if started else "已阅",
                    card=build_wrap_acked_card(
                        started=started,
                        role_name=str(result.get("role_name") or agent_code),
                    ),
                )

            if kind == "control":
                if decision not in ("stop", "cancel") or not (task_id or agent_code):
                    return _resp(toast_type="info", content="未识别的控制操作")
                fut = asyncio.run_coroutine_threadsafe(
                    self._process_control_card_action(
                        action=decision,
                        task_id=task_id,
                        agent_code=agent_code,
                        message_id=message_id,
                    ),
                    self._main_loop,
                )
                try:
                    result = fut.result(timeout=3.0)
                except FuturesTimeoutError:
                    return _resp(toast_type="info", content="正在停止…")
                if not result.get("ok"):
                    return _resp(toast_type="error", content=str(result.get("error") or "停止失败")[:80])
                return _resp(
                    toast_type="success",
                    content="已停止执行" if decision == "stop" else "已取消任务",
                    card=build_control_decided_card(
                        action=decision,
                        title=str(result.get("title") or ""),
                    ),
                )

            if kind == "run_control":
                if decision != "stop":
                    return _resp(toast_type="info", content="未识别的停止操作")
                chat_id = str(value.get("chat_id") or "").strip()
                topic_id = str(value.get("topic_id") or "").strip()
                thread_id = str(value.get("thread_id") or "").strip()
                channel_name = str(value.get("channel") or "feishu").strip() or "feishu"
                account_id = str(value.get("account_id") or agent_code or "").strip()
                fut = asyncio.run_coroutine_threadsafe(
                    self._process_run_control_action(
                        channel_name=channel_name,
                        chat_id=chat_id,
                        topic_id=topic_id,
                        thread_id=thread_id,
                        message_id=message_id,
                        account_id=account_id,
                    ),
                    self._main_loop,
                )
                try:
                    result = fut.result(timeout=3.0)
                except FuturesTimeoutError:
                    return _resp(toast_type="info", content="正在停止生成…")
                if not result.get("ok"):
                    return _resp(toast_type="error", content=str(result.get("error") or "停止失败")[:80])
                preview = str(result.get("preview") or "")
                return _resp(
                    toast_type="success",
                    content="已停止生成",
                    card=build_run_stopped_card(title=preview),
                )

            logger.info(
                "[Feishu] card action ignored: kind=%s keys=%s",
                kind,
                list(value.keys()) if isinstance(value, dict) else type(value),
            )
            return _resp(toast_type="info", content="未识别的卡片操作")
        except Exception:
            logger.exception("[Feishu] card action handler error")
            return _resp(toast_type="error", content="处理异常，请打开面板重试")

    async def _process_proactive_card_decision(
        self,
        *,
        initiative_id: str,
        decision: str,
        approval_id: str = "",
        message_id: str = "",
        account_id: str = "",
    ) -> dict[str, Any]:
        """Apply Feishu card approve/reject via the same path as the HTTP API."""
        from fastapi import HTTPException

        from evoflow.proactive.router import ApprovalDecisionRequest, process_approval

        title = ""
        try:
            from evoflow.proactive.repositories import ProactiveRepository

            init = ProactiveRepository.get_initiative(initiative_id)
            if init:
                title = str(init.title or "")
        except Exception:
            logger.debug("[Feishu] preload initiative title failed", exc_info=True)

        try:
            result = await process_approval(
                initiative_id,
                ApprovalDecisionRequest(
                    decision=decision,
                    decided_by="feishu",
                    rejection_reason="飞书驳回（未填写原因）" if decision == "rejected" else "",
                ),
            )
        except HTTPException as exc:
            detail = exc.detail
            if not isinstance(detail, str):
                detail = str(detail)
            logger.warning(
                "[Feishu] card decision rejected by API: initiative=%s status=%s detail=%s",
                initiative_id,
                exc.status_code,
                detail,
            )
            # Already decided: still try to collapse the card UI
            if exc.status_code == 400 and message_id and "not pending" in detail.lower():
                with contextlib.suppress(Exception):
                    await self._update_card_to_decided(
                        message_id,
                        approved=(decision == "approved"),
                        title=title,
                        account_id=account_id,
                    )
            with contextlib.suppress(Exception):
                from evoflow.persistence.channel_push_repositories import safe_record_push

                safe_record_push(
                    direction="inbound",
                    channel="feishu",
                    kind="approval_decision",
                    event="callback",
                    transport="interactive_card",
                    approval_id=str(approval_id or ""),
                    initiative_id=str(initiative_id or ""),
                    external_message_id=str(message_id or ""),
                    sender_account_id=str(account_id or ""),
                    title=str(decision),
                    content_summary=detail[:400],
                    payload={
                        "decision": decision,
                        "http_status": exc.status_code,
                        "error": detail[:300],
                    },
                    status="error",
                    error=detail[:200],
                    triggered_by="user_callback",
                )
            return {"ok": False, "error": detail, "title": title}
        except Exception as exc:
            logger.exception("[Feishu] card decision failed: initiative=%s", initiative_id)
            with contextlib.suppress(Exception):
                from evoflow.persistence.channel_push_repositories import safe_record_push

                safe_record_push(
                    direction="inbound",
                    channel="feishu",
                    kind="approval_decision",
                    event="callback",
                    transport="interactive_card",
                    approval_id=str(approval_id or ""),
                    initiative_id=str(initiative_id or ""),
                    external_message_id=str(message_id or ""),
                    sender_account_id=str(account_id or ""),
                    title=str(decision),
                    content_summary=str(exc)[:400],
                    status="error",
                    error=str(exc)[:200],
                    triggered_by="user_callback",
                )
            return {"ok": False, "error": str(exc)[:120], "title": title}

        # Prefer message_id from event; fall back to stored feishu_message_id
        mid = message_id
        if not mid and approval_id:
            try:
                from evoflow.proactive.repositories import ProactiveRepository

                appr = ProactiveRepository.get_approval(approval_id)
                mid = str(getattr(appr, "feishu_message_id", None) or "") if appr else ""
            except Exception:
                mid = ""
        if mid:
            # Response card may already update UI; patch is a reliable fallback.
            with contextlib.suppress(Exception):
                await self._update_card_to_decided(
                    mid,
                    approved=(decision == "approved"),
                    title=title,
                    account_id=account_id,
                )

        logger.info(
            "[Feishu] card decision applied: initiative=%s decision=%s approval=%s",
            initiative_id,
            decision,
            approval_id or result.get("initiative_id"),
        )
        try:
            from evoflow.persistence.channel_push_repositories import safe_record_push

            aid = str(approval_id or result.get("approval_id") or "").strip()
            role_code = ""
            if not aid:
                try:
                    from evoflow.proactive.repositories import ProactiveRepository

                    tid = str(result.get("task_id") or "").strip()
                    if tid:
                        ap = ProactiveRepository.get_approval_by_task(tid)
                        aid = str(getattr(ap, "id", "") or "") if ap else ""
                        role_code = str(getattr(ap, "role_agent_code", "") or "") if ap else ""
                    if not aid:
                        init_ref = str(initiative_id or "").strip()
                        ap = ProactiveRepository.get_approval_by_initiative(init_ref)
                        if ap is None and not init_ref.startswith("task:"):
                            ap = ProactiveRepository.get_approval_by_initiative(
                                f"task:{init_ref}"
                            )
                        aid = str(getattr(ap, "id", "") or "") if ap else ""
                        if ap and not role_code:
                            role_code = str(getattr(ap, "role_agent_code", "") or "")
                except Exception:
                    aid = ""
            elif not role_code:
                try:
                    from evoflow.proactive.repositories import ProactiveRepository

                    ap = ProactiveRepository.get_approval(aid)
                    role_code = str(getattr(ap, "role_agent_code", "") or "") if ap else ""
                except Exception:
                    role_code = ""
            safe_record_push(
                direction="inbound",
                channel="feishu",
                kind="approval_decision",
                event="callback",
                transport="interactive_card",
                approval_id=aid,
                task_id=str(result.get("task_id") or ""),
                initiative_id=str(initiative_id or result.get("initiative_id") or ""),
                role_agent_code=role_code,
                external_message_id=str(message_id or ""),
                sender_account_id=str(account_id or ""),
                title=str(decision),
                content_summary=f"feishu card {decision}" + (f" · {title}" if title else ""),
                payload={
                    "decision": decision,
                    "approval_id": aid,
                    "initiative_id": initiative_id,
                    "message_id": message_id,
                    "handoff": bool(result.get("handoff")),
                    "new_status": result.get("new_status"),
                },
                status="ok",
                triggered_by="user_callback",
            )
        except Exception:
            logger.debug("[Feishu] push_log inbound failed", exc_info=True)
        return {
            "ok": True,
            "title": title,
            "result": result,
            "handoff": bool(result.get("handoff")),
            "new_status": result.get("new_status"),
        }

    async def _process_review_card_decision(
        self,
        *,
        task_id: str,
        action: str,
        message_id: str = "",
        account_id: str = "",
    ) -> dict[str, Any]:
        """Accept / rework / fail a reviewed work item from Feishu card."""
        from evoflow.admin.errors import NotFoundError, ValidationError
        from evoflow.admin.tasks import get_task, set_task_state

        title = ""
        try:
            task = get_task(task_id)
            if isinstance(task, dict):
                title = str(task.get("name") or task.get("title") or "")
        except Exception:
            logger.debug("[Feishu] preload task title failed", exc_info=True)

        try:
            result = await asyncio.to_thread(
                set_task_state,
                task_id,
                action,
                summary=f"飞书验收：{action}",
            )
        except (ValidationError, NotFoundError) as exc:
            return {"ok": False, "error": str(exc), "title": title}
        except Exception as exc:
            logger.exception("[Feishu] review card failed task=%s action=%s", task_id, action)
            return {"ok": False, "error": str(exc)[:120], "title": title}

        if message_id:
            with contextlib.suppress(Exception):
                await self._patch_card_raw(
                    message_id,
                    build_review_decided_card(action=action, title=title),
                    account_id=account_id,
                )
        logger.info("[Feishu] review card applied: task=%s action=%s", task_id, action)
        return {"ok": True, "title": title, "result": result}

    async def _process_wrap_card_action(
        self,
        *,
        agent_code: str,
        action: str,
        message_id: str = "",
    ) -> dict[str, Any]:
        """Ack wrap digest or trigger an immediate heartbeat."""
        from evoflow.proactive.repositories import ProactiveRepository

        role = ProactiveRepository.get_role(agent_code)
        role_name = str(getattr(role, "role_name", "") or agent_code) if role else agent_code
        if action == "ack":
            if message_id:
                with contextlib.suppress(Exception):
                    await self._patch_card_raw(
                        message_id,
                        build_wrap_acked_card(started=False, role_name=role_name),
                        account_id=agent_code,
                    )
            return {"ok": True, "role_name": role_name}

        if action == "heartbeat":
            if role is None:
                return {"ok": False, "error": f"员工 {agent_code} 不存在", "role_name": role_name}
            try:
                from evoflow.proactive.runner import get_proactive_runner

                runner = get_proactive_runner()
                asyncio.create_task(runner.trigger_heartbeat(agent_code))
            except Exception as exc:
                logger.exception("[Feishu] wrap heartbeat failed agent=%s", agent_code)
                return {"ok": False, "error": str(exc)[:120], "role_name": role_name}
            if message_id:
                with contextlib.suppress(Exception):
                    await self._patch_card_raw(
                        message_id,
                        build_wrap_acked_card(started=True, role_name=role_name),
                        account_id=agent_code,
                    )
            return {"ok": True, "role_name": role_name}

        return {"ok": False, "error": "未知操作", "role_name": role_name}

    async def _process_control_card_action(
        self,
        *,
        action: str,
        task_id: str = "",
        agent_code: str = "",
        message_id: str = "",
    ) -> dict[str, Any]:
        """Stop in-flight role execution and/or cancel the work item."""
        from evoflow.admin.errors import NotFoundError, ValidationError
        from evoflow.admin.tasks import get_task, set_task_state
        from evoflow.proactive.runner import get_proactive_runner

        tid = str(task_id or "").strip()
        code = str(agent_code or "").strip()
        title = ""
        if tid:
            try:
                task = get_task(tid)
                if isinstance(task, dict):
                    title = str(task.get("name") or task.get("title") or "")
                    if not code:
                        code = str(task.get("assigned_to") or "").strip()
            except Exception:
                logger.debug("[Feishu] preload task for control failed", exc_info=True)

        if code:
            try:
                runner = get_proactive_runner()
                await runner.cancel_role(code)
            except Exception as exc:
                logger.warning("[Feishu] control cancel_role failed agent=%s: %s", code, exc)

        if tid:
            try:
                await asyncio.to_thread(
                    set_task_state,
                    tid,
                    "cancelled",
                    summary="飞书停止" if action == "stop" else "飞书取消任务",
                )
            except (ValidationError, NotFoundError) as exc:
                # Already terminal is OK for stop
                if action == "cancel":
                    return {"ok": False, "error": str(exc), "title": title}
                logger.info("[Feishu] control set_task_state skipped task=%s: %s", tid, exc)
            except Exception as exc:
                logger.exception("[Feishu] control set_task_state failed task=%s", tid)
                return {"ok": False, "error": str(exc)[:120], "title": title}

        if message_id:
            with contextlib.suppress(Exception):
                await self._patch_card_raw(
                    message_id,
                    build_control_decided_card(action=action, title=title),
                    account_id=code,
                )
        logger.info(
            "[Feishu] control card applied: action=%s task=%s agent=%s",
            action,
            tid,
            code,
        )
        return {"ok": True, "title": title, "agent_code": code}

    async def _process_run_control_action(
        self,
        *,
        channel_name: str,
        chat_id: str,
        topic_id: str = "",
        thread_id: str = "",
        message_id: str = "",
        account_id: str = "",
    ) -> dict[str, Any]:
        """Cancel the active IM LangGraph run for this chat/thread."""
        from app.channels.service import get_channel_service

        service = get_channel_service()
        if service is None or service.manager is None:
            return {"ok": False, "error": "渠道服务未就绪"}
        try:
            result = await service.manager.cancel_active_im_run(
                channel_name=channel_name or "feishu",
                chat_id=chat_id,
                topic_id=topic_id or None,
                thread_id=thread_id or None,
            )
        except Exception as exc:
            logger.exception("[Feishu] run_control cancel failed chat=%s", chat_id)
            return {"ok": False, "error": str(exc)[:120]}

        preview = str(result.get("preview") or "")
        if message_id:
            with contextlib.suppress(Exception):
                await self._patch_card_raw(
                    message_id,
                    build_run_stopped_card(title=preview),
                    account_id=account_id,
                )
        return {"ok": True, "preview": preview, **result}

    async def _update_card(
        self,
        message_id: str,
        text: str,
        *,
        stop_ctx: dict[str, Any] | None = None,
        account_id: str = "",
    ) -> None:
        """Patch an existing card message in place (must use the sending bot)."""
        # Empty string = primary. Callers must pass the card creator; do not `or`-chain
        # through falsy "" into another bot's credentials.
        aid = str(account_id).strip()
        api_client = self._api_client_for(aid)
        if not api_client or not self._PatchMessageRequest:
            return

        content = self._build_card_content(text, stop_ctx=stop_ctx)
        request = (
            self._PatchMessageRequest.builder()
            .message_id(message_id)
            .request_body(self._PatchMessageRequestBody.builder().content(content).build())
            .build()
        )
        response = await asyncio.to_thread(api_client.im.v1.message.patch, request)
        ok, err = self._lark_call_succeeded(response)
        if not ok:
            logger.error(
                "[Feishu] message.patch failed: card=%s account=%s %s",
                message_id,
                aid or "primary",
                err,
            )
            raise RuntimeError(f"Feishu message.patch failed: {err}")

    def _track_background_task(self, task: asyncio.Task, *, name: str, msg_id: str) -> None:
        """Keep a strong reference to fire-and-forget tasks and surface errors."""
        self._background_tasks.add(task)
        task.add_done_callback(lambda done_task, task_name=name, mid=msg_id: self._finalize_background_task(done_task, task_name, mid))

    def _finalize_background_task(self, task: asyncio.Task, name: str, msg_id: str) -> None:
        self._background_tasks.discard(task)
        self._log_task_error(task, name, msg_id)

    def _clear_stream_state(self, source_message_id: str) -> None:
        self._last_stream_patch_text.pop(source_message_id, None)
        self._running_card_ids.pop(source_message_id, None)
        self._running_card_chat_ids.pop(source_message_id, None)
        self._running_card_account_ids.pop(source_message_id, None)
        self._stream_stop_ctx.pop(source_message_id, None)
        self._stream_state_ts.pop(source_message_id, None)
        task = self._running_card_tasks.pop(source_message_id, None)
        if task is not None and not task.done():
            task.cancel()

    def _remember_reply_route(
        self,
        source_message_id: str,
        *,
        chat_id: str = "",
        account_id: str = "",
        overwrite_account: bool = False,
    ) -> None:
        cid = str(chat_id or "").strip()
        aid = str(account_id or "").strip()
        if cid:
            self._running_card_chat_ids[source_message_id] = cid
        if overwrite_account or source_message_id not in self._running_card_account_ids:
            # Persist creator/outbound bot id ("" = primary). Do not clobber an
            # existing creator when outbound routing later resolves a different account.
            self._running_card_account_ids[source_message_id] = aid
        if cid:
            # Always refresh last-bot hint for this chat ("" clears a prior employee bot).
            self._chat_account[cid] = aid

    def _bind_card_sender(self, *, source_message_id: str, card_id: str, account_id: str) -> None:
        """Record which bot owns a running card so patch uses the same credentials."""
        aid = str(account_id or "").strip()
        self._running_card_account_ids[source_message_id] = aid
        if card_id:
            self._running_card_account_ids[card_id] = aid

    async def _create_running_card(
        self,
        source_message_id: str,
        text: str,
        *,
        stop_ctx: dict[str, Any] | None = None,
        chat_id: str = "",
        account_id: str = "",
    ) -> str | None:
        """Create the running card and cache its message ID when available."""
        aid = str(account_id or "").strip()
        self._remember_reply_route(
            source_message_id,
            chat_id=chat_id,
            account_id=aid,
            overwrite_account=True,
        )
        ctx = stop_ctx if stop_ctx is not None else self._stream_stop_ctx.get(source_message_id)
        running_card_id = await self._reply_card(
            source_message_id,
            text,
            stop_ctx=ctx,
            chat_id=chat_id,
            account_id=aid,
        )
        if running_card_id:
            self._running_card_ids[source_message_id] = running_card_id
            self._bind_card_sender(
                source_message_id=source_message_id,
                card_id=running_card_id,
                account_id=aid,
            )
            logger.info(
                "[Feishu] running card created: source=%s card=%s account=%s",
                source_message_id,
                running_card_id,
                aid or "primary",
            )
        else:
            logger.warning(
                "[Feishu] running card creation returned no message_id for source=%s, subsequent updates will fall back to new replies",
                source_message_id,
            )
        return running_card_id

    def _ensure_running_card_started(
        self,
        source_message_id: str,
        text: str = "Working on it...",
        *,
        stop_ctx: dict[str, Any] | None = None,
        chat_id: str = "",
        account_id: str = "",
    ) -> asyncio.Task | None:
        """Start running-card creation once per source message."""
        self._remember_reply_route(
            source_message_id,
            chat_id=chat_id,
            account_id=account_id,
            overwrite_account=True,
        )
        running_card_id = self._running_card_ids.get(source_message_id)
        if running_card_id:
            return None

        if stop_ctx:
            self._stream_stop_ctx[source_message_id] = stop_ctx

        running_card_task = self._running_card_tasks.get(source_message_id)
        if running_card_task:
            return running_card_task

        running_card_task = asyncio.create_task(
            self._create_running_card(
                source_message_id,
                text,
                stop_ctx=stop_ctx,
                chat_id=chat_id,
                account_id=account_id,
            )
        )
        self._running_card_tasks[source_message_id] = running_card_task
        running_card_task.add_done_callback(
            lambda done_task, mid=source_message_id: self._finalize_running_card_task(mid, done_task)
        )
        return running_card_task

    def _finalize_running_card_task(self, source_message_id: str, task: asyncio.Task) -> None:
        if self._running_card_tasks.get(source_message_id) is task:
            self._running_card_tasks.pop(source_message_id, None)
        self._log_task_error(task, "create_running_card", source_message_id)

    async def _ensure_running_card(
        self,
        source_message_id: str,
        text: str = "Working on it...",
        *,
        stop_ctx: dict[str, Any] | None = None,
        chat_id: str = "",
        account_id: str = "",
    ) -> str | None:
        """Ensure the in-thread running card exists and track its message ID."""
        running_card_id = self._running_card_ids.get(source_message_id)
        if running_card_id:
            return running_card_id

        running_card_task = self._ensure_running_card_started(
            source_message_id,
            text,
            stop_ctx=stop_ctx,
            chat_id=chat_id,
            account_id=account_id,
        )
        if running_card_task is None:
            return self._running_card_ids.get(source_message_id)
        try:
            return await running_card_task
        except Exception as exc:
            logger.warning(
                "[Feishu] running card ensure failed for %s (will fall back later): %s",
                source_message_id,
                exc,
            )
            return None

    async def _send_running_reply(self, message_id: str) -> None:
        """Reply to a message in-thread with a running card."""
        try:
            await self._ensure_running_card(message_id)
        except Exception:
            logger.exception("[Feishu] failed to send running reply for message %s", message_id)

    async def _send_card_message(self, msg: OutboundMessage) -> None:
        """Send or update the Feishu card tied to the current request."""
        source_message_id = msg.thread_ts
        lock_key = source_message_id or msg.chat_id
        lock = self._send_card_locks.setdefault(lock_key, asyncio.Lock())
        async with lock:
            await self._send_card_message_locked(msg, source_message_id)

    def _touch_stream_state(self, source_message_id: str) -> None:
        self._stream_state_ts[source_message_id] = time.monotonic()
        self._prune_stream_state()

    def _prune_final_fingerprints(self, now: float | None = None) -> None:
        now = now if now is not None else time.monotonic()
        cutoff = now - _FINAL_FINGERPRINT_TTL_SECONDS
        stale = [key for key, (_, ts) in self._recent_final_fingerprint.items() if ts < cutoff]
        for key in stale:
            self._recent_final_fingerprint.pop(key, None)

    def _prune_stream_state(self, now: float | None = None) -> None:
        now = now if now is not None else time.monotonic()
        cutoff = now - _STREAM_STATE_TTL_SECONDS
        stale = [key for key, ts in self._stream_state_ts.items() if ts < cutoff]
        for key in stale:
            self._clear_stream_state(key)
        if len(self._stream_state_ts) <= _STREAM_STATE_MAX_ENTRIES:
            return
        overflow = len(self._stream_state_ts) - _STREAM_STATE_MAX_ENTRIES
        oldest = sorted(self._stream_state_ts, key=self._stream_state_ts.get)[:overflow]
        for key in oldest:
            self._clear_stream_state(key)

    async def _send_card_message_locked(self, msg: OutboundMessage, source_message_id: str | None) -> None:
        meta = msg.metadata if isinstance(msg.metadata, dict) else {}
        is_subtask = bool(meta.get("is_subtask"))
        if source_message_id:
            self._touch_stream_state(source_message_id)
        if source_message_id and msg.is_final and not is_subtask:
            now = time.monotonic()
            text_hash = hashlib.sha256((msg.text or "").encode()).hexdigest()[:16]
            # Include reply anchor so identical text on a *new* user message still updates the card.
            dedup_key = f"{msg.thread_id}:{source_message_id}:{text_hash}"
            self._prune_final_fingerprints(now)
            last = self._recent_final_fingerprint.get(dedup_key)
            if last is not None:
                logger.info(
                    "[Feishu] skip duplicate is_final outbound: thread_id=%s source=%s",
                    msg.thread_id,
                    source_message_id,
                )
                # Still clear stream state so the next turn is not stuck on a stale card map.
                self._clear_stream_state(source_message_id)
                with contextlib.suppress(Exception):
                    await self._add_reaction(source_message_id, "DONE")
                return
            self._recent_final_fingerprint[dedup_key] = (text_hash, now)

        # Append session id to the end of the message (only for Claude mode)
        if msg.thread_id and msg.text:
            routing_key = f"{msg.channel_name}:{msg.chat_id}" + (f":{msg.topic_id}" if msg.topic_id else "")
            claude_on = self._claude_code_chat_mode.get(routing_key, False)
            if claude_on and self.store is not None:
                entry = self.store.get_entry(msg.channel_name, msg.chat_id, topic_id=msg.topic_id) or self.store.get_entry(msg.channel_name, msg.chat_id, topic_id=None)
                claude_sid = (entry or {}).get("last_claude_session_id")
                if isinstance(claude_sid, str) and claude_sid.strip():
                    session_suffix = f"\n\n---\nClaude 会话 ID: `{claude_sid.strip()}`"
                    msg.text += session_suffix
        if source_message_id:
            stop_ctx = self._stop_ctx_from_outbound(msg)
            if stop_ctx:
                self._stream_stop_ctx[source_message_id] = stop_ctx
            elif msg.is_final:
                self._stream_stop_ctx.pop(source_message_id, None)

            running_card_id = self._running_card_ids.get(source_message_id)
            awaited_running_card_task = False

            if not running_card_id:
                running_card_task = self._running_card_tasks.get(source_message_id)
                if running_card_task:
                    awaited_running_card_task = True
                    try:
                        running_card_id = await running_card_task
                    except Exception as exc:
                        logger.warning(
                            "[Feishu] running card task failed for %s, continue without it: %s",
                            source_message_id,
                            exc,
                        )
                        running_card_id = None

            account_id = self._resolve_outbound_account_id(msg)
            # Keep chat_id for 230002 fallback; do not overwrite the card creator bot.
            # "" (primary) is a real creator — use `in` / prefer_account_id, never `or`.
            if source_message_id in self._running_card_account_ids:
                creator_aid = str(self._running_card_account_ids[source_message_id] or "").strip()
            else:
                creator_aid = account_id
            self._remember_reply_route(
                source_message_id,
                chat_id=str(msg.chat_id or ""),
                account_id=creator_aid,
                overwrite_account=False,
            )
            patch_aid = self._prefer_account_id(
                self._running_card_account_ids[running_card_id]
                if running_card_id and running_card_id in self._running_card_account_ids
                else None,
                self._running_card_account_ids[source_message_id]
                if source_message_id in self._running_card_account_ids
                else None,
                creator_aid,
                account_id,
            )

            if running_card_id:
                patch_text = msg.text or ""
                if not msg.is_final and self._last_stream_patch_text.get(source_message_id) == patch_text:
                    return
                try:
                    logger.debug(
                        "[Feishu] patch running card: source=%s, card=%s, text_len=%d, is_final=%s",
                        source_message_id,
                        running_card_id,
                        len(patch_text),
                        msg.is_final,
                    )
                    await self._update_card(
                        running_card_id,
                        patch_text,
                        stop_ctx=None if msg.is_final else stop_ctx,
                        account_id=patch_aid,
                    )
                    if not msg.is_final:
                        self._last_stream_patch_text[source_message_id] = patch_text
                except Exception as exc:
                    not_sender = self._is_not_message_sender_error(exc)
                    if not msg.is_final and not not_sender:
                        logger.warning(
                            "[Feishu] patch running card failed (non-final): source=%s, card=%s",
                            source_message_id,
                            running_card_id,
                            exc_info=True,
                        )
                        raise
                    logger.warning(
                        "[Feishu] patch running card failed (%s), recreating card: source=%s card=%s err=%s",
                        "not-sender" if not_sender else "final-fallback",
                        source_message_id,
                        running_card_id,
                        exc,
                    )
                    # Drop stale card (wrong bot / invalid) and publish a fresh one.
                    self._running_card_ids.pop(source_message_id, None)
                    self._running_card_account_ids.pop(running_card_id, None)
                    new_card = await self._reply_card(
                        source_message_id,
                        msg.text,
                        stop_ctx=None if msg.is_final else stop_ctx,
                        chat_id=str(msg.chat_id or ""),
                        account_id=patch_aid,
                    )
                    if new_card:
                        self._running_card_ids[source_message_id] = new_card
                        self._bind_card_sender(
                            source_message_id=source_message_id,
                            card_id=new_card,
                            account_id=patch_aid,
                        )
                        if not msg.is_final:
                            self._last_stream_patch_text[source_message_id] = patch_text
                else:
                    logger.info("[Feishu] running card updated: source=%s card=%s", source_message_id, running_card_id)
            elif msg.is_final:
                logger.info("[Feishu] no running card id, sending final reply card: source=%s", source_message_id)
                await self._reply_card(
                    source_message_id,
                    msg.text,
                    chat_id=str(msg.chat_id or ""),
                    account_id=account_id,
                )
            elif awaited_running_card_task:
                logger.warning(
                    "[Feishu] running card task finished without message_id for source=%s, skipping duplicate non-final creation",
                    source_message_id,
                )
            else:
                logger.info("[Feishu] creating running card for non-final stream: source=%s", source_message_id)
                await self._ensure_running_card(
                    source_message_id,
                    msg.text,
                    stop_ctx=stop_ctx,
                    chat_id=str(msg.chat_id or ""),
                    account_id=account_id,
                )

            if msg.is_final and not is_subtask:
                # Subtask bridge (FeishuStreamBridge) also uses the same reply anchor thread_ts.
                # Its is_final=True must not clear the main stream's running-card mapping, or the next
                # main delta recreates a new card in a loop.
                self._clear_stream_state(source_message_id)
                await self._add_reaction(source_message_id, "DONE")
            return

        await self._create_card(
            msg.chat_id,
            msg.text,
            receive_id_type="chat_id",
            account_id=self._resolve_outbound_account_id(msg),
        )

    # -- internal ----------------------------------------------------------

    @staticmethod
    def _log_future_error(fut, name: str, msg_id: str) -> None:
        """Callback for run_coroutine_threadsafe futures to surface errors."""
        try:
            exc = fut.exception()
            if exc:
                logger.error("[Feishu] %s failed for msg_id=%s: %s", name, msg_id, exc)
        except Exception:
            pass

    @staticmethod
    def _log_task_error(task: asyncio.Task, name: str, msg_id: str) -> None:
        """Callback for background asyncio tasks to surface errors."""
        try:
            exc = task.exception()
            if exc:
                logger.error("[Feishu] %s failed for msg_id=%s: %s", name, msg_id, exc)
        except asyncio.CancelledError:
            logger.info("[Feishu] %s cancelled for msg_id=%s", name, msg_id)
        except Exception:
            pass

    async def _prepare_inbound(self, msg_id: str, inbound) -> None:
        """Kick off Feishu side effects without delaying inbound dispatch."""
        meta = inbound.metadata if isinstance(inbound.metadata, dict) else {}
        account_id = str(meta.get("account_id") or "").strip()
        chat_id = str(inbound.chat_id or "").strip()
        reaction_task = asyncio.create_task(self._add_reaction(msg_id, "OK"))
        self._track_background_task(reaction_task, name="add_reaction", msg_id=msg_id)
        # Running card / outbound replies must anchor to the same message_id passed to
        # im.v1.message.reply — in topic threads that is the thread root, not each reply.
        anchor = (inbound.thread_ts or msg_id) or msg_id
        self._ensure_running_card_started(
            anchor,
            chat_id=chat_id,
            account_id=account_id,
        )
        # First-@ self-introduction for a dedicated employee bot (account_id set),
        # once per chat. Primary personal-assistant bot is excluded on purpose.
        if account_id:
            self._maybe_send_first_mention_intro(account_id=account_id, chat_id=chat_id)
        await self.bus.publish_inbound(inbound)

    def _maybe_send_first_mention_intro(self, *, account_id: str, chat_id: str) -> None:
        """Fire-and-forget self-intro for a freshly bound employee bot's first @."""
        key = f"{account_id}::{chat_id}"
        if key in self._intro_sent_keys or not chat_id:
            return
        self._intro_sent_keys.add(key)
        try:
            from evoflow.proactive.self_intro import (
                build_employee_self_intro,
                has_intro_been_sent,
                mark_intro_sent,
            )

            # Durable skip across Gateway restarts (memory set alone is not enough).
            if has_intro_been_sent(account_id, receive_id=chat_id, receive_id_type="chat_id"):
                return
            text = build_employee_self_intro(account_id)
            if not text:
                return
        except Exception:
            logger.debug("feishu: self-intro text build failed account=%s", account_id, exc_info=True)
            return

        async def _send() -> None:
            try:
                await self.send_proactive_markdown(chat_id, text, receive_id_type="chat_id", account_id=account_id)
                mark_intro_sent(account_id, receive_id=chat_id, receive_id_type="chat_id")
            except Exception:
                logger.debug("feishu: first-@ self-intro send failed account=%s", account_id, exc_info=True)

        task = asyncio.create_task(_send())
        self._track_background_task(task, name="first_mention_intro", msg_id="")

    def _on_im_reaction_event(self, _event) -> None:
        """Ack IM reaction lifecycle events (including our own OK/DONE); no business logic."""

    def _on_im_chat_member_bot_event(self, _event) -> None:
        """Ack bot added/removed from a chat; no business logic (avoids Lark SDK error spam)."""

    def _on_message(self, event, *, account_id: str = "") -> None:
        """Called by lark-oapi when a message is received (runs in lark thread)."""
        try:
            logger.info(
                "[Feishu] raw event received: type=%s account=%s",
                type(event).__name__,
                account_id or "primary",
            )
            if _feishu_sender_is_bot(event):
                logger.info("[Feishu] ignore bot/app sender (account=%s)", account_id or "primary")
                return

            message = event.event.message
            chat_id = message.chat_id
            msg_id = message.message_id
            sender_id = event.event.sender.sender_id.open_id
            account_id = str(account_id or "").strip()
            if chat_id:
                # Always refresh ("" = primary) so a prior @小V does not stick on this chat.
                self._chat_account[str(chat_id)] = account_id

            chat_type = str(getattr(message, "chat_type", None) or "").strip().lower()
            mention_ids = _feishu_mention_open_ids(message)
            bot_open_id = _feishu_account_open_id(self.config if isinstance(self.config, dict) else {}, account_id)
            if _feishu_should_skip_unmentioned_group(
                chat_type=chat_type,
                chat_id=str(chat_id or ""),
                bot_open_id=bot_open_id,
                mention_open_ids=mention_ids,
                account_id=account_id,
            ):
                logger.info(
                    "[Feishu] skip group message not mentioning this bot: account=%s chat=%s msg=%s bot_open_id=%s mentions=%s",
                    account_id or "primary",
                    chat_id,
                    msg_id,
                    bot_open_id or "-",
                    sorted(mention_ids)[:8],
                )
                return

            # root_id identifies a Feishu message thread (楼中楼). When it equals this
            # message's id or is absent, the message is top-level in the chat — use
            # topic_id=None so ChannelStore key is feishu:<chat_id> and the same LangGraph
            # thread is reused for the whole conversation. When root_id differs from msg_id,
            # this message belongs to that thread — use root_id so that Feishu thread maps
            # to one agent thread.
            root_id = getattr(message, "root_id", None) or None

            # Parse message content
            content = json.loads(message.content)

            if "text" in content:
                # Handle plain text messages
                text = content["text"]
            elif "content" in content and isinstance(content["content"], list):
                # Handle rich-text messages with a top-level "content" list (e.g., topic groups/posts)
                text_paragraphs: list[str] = []
                for paragraph in content["content"]:
                    if isinstance(paragraph, list):
                        paragraph_text_parts: list[str] = []
                        for element in paragraph:
                            if isinstance(element, dict):
                                # Include both normal text and @ mentions
                                if element.get("tag") in ("text", "at"):
                                    text_value = element.get("text", "")
                                    if text_value:
                                        paragraph_text_parts.append(text_value)
                        if paragraph_text_parts:
                            # Join text segments within a paragraph with spaces to avoid "helloworld"
                            text_paragraphs.append(" ".join(paragraph_text_parts))

                # Join paragraphs with blank lines to preserve paragraph boundaries
                text = "\n\n".join(text_paragraphs)
            else:
                text = ""
            raw = text.strip().strip("\ufeff\u200b\u200c\u200d")

            if not raw:
                logger.info("[Feishu] empty text, ignoring message")
                return

            if self._inbound_dedup.is_duplicate(
                account_id=account_id,
                msg_id=str(msg_id or ""),
                chat_id=str(chat_id or ""),
                text=raw,
            ):
                logger.info(
                    "[Feishu] skip duplicate inbound: account=%s msg_id=%s chat_id=%s text_len=%d",
                    account_id or "primary",
                    msg_id,
                    chat_id,
                    len(raw),
                )
                return

            # Commands: first line must start with / (Feishu may add BOM or @ 前缀); merge
            # following lines into one line so /bootstrap … works across line breaks.
            lines = [ln.strip() for ln in raw.splitlines() if ln.strip()]
            if lines and lines[0].startswith("/"):
                msg_type = InboundMessageType.COMMAND
                text = lines[0] if len(lines) == 1 else f"{lines[0]} {' '.join(lines[1:]).strip()}"
            else:
                msg_type = InboundMessageType.CHAT
                text = raw

            if root_id and str(root_id) != str(msg_id):
                topic_id = str(root_id)
            else:
                topic_id = None

            # Flat main-chat mode: one agent thread per chat (ignore Feishu topic roots).
            if not self._reply_in_thread:
                topic_id = None

            # im.v1.message.reply must use the **topic root** message_id when the user spoke
            # inside a Feishu thread (楼中楼). Replying to a leaf id often returns 230002.
            if root_id and str(root_id) != str(msg_id):
                reply_anchor_message_id = str(root_id)
            else:
                reply_anchor_message_id = str(msg_id)

            logger.info(
                "[Feishu] parsed message: chat_id=%s, msg_id=%s, root_id=%s, reply_anchor=%s, sender=%s, chat_type=%s, text_len=%d",
                chat_id,
                msg_id,
                root_id,
                reply_anchor_message_id,
                sender_id,
                chat_type or "?",
                len(raw) if raw else 0,
            )

            inbound = self._make_inbound(
                chat_id=chat_id,
                user_id=sender_id,
                text=text,
                msg_type=msg_type,
                thread_ts=reply_anchor_message_id,
                metadata={
                    "message_id": msg_id,
                    "root_id": root_id,
                    "reply_anchor_message_id": reply_anchor_message_id,
                    **({"chat_type": chat_type} if chat_type else {}),
                    **({"account_id": account_id} if account_id else {}),
                },
            )
            inbound.topic_id = topic_id

            # Schedule on the async event loop
            if self._main_loop and self._main_loop.is_running() and not self._main_loop.is_closed():
                logger.info("[Feishu] publishing inbound message to bus (type=%s, msg_id=%s)", msg_type.value, msg_id)
                fut = asyncio.run_coroutine_threadsafe(self._prepare_inbound(msg_id, inbound), self._main_loop)
                fut.add_done_callback(lambda f, mid=msg_id: self._log_future_error(f, "prepare_inbound", mid))
            else:
                logger.warning("[Feishu] main loop not running, cannot publish inbound message")
        except Exception:
            logger.exception("[Feishu] error processing message")
