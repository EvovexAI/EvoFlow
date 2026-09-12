"""Build the self-introduction text for a freshly Feishu-bound employee bot.

A newly hired/bound employee has no chat context yet, so we compose a short
standard intro from what we already know: the role/agent identity, its duties,
its tool allowlist, and a few example commands. Used by:

* ``apply_registration_to_role`` — proactive push to the scanner's private chat
  right after a successful QR binding.
* ``FeishuChannel._on_message`` — first-``@`` fallback inside a group/p2p chat.
"""

from __future__ import annotations

import asyncio
import logging

from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)


def intro_sent_key(*, receive_id: str, receive_id_type: str = "chat_id") -> str:
    """Stable DB key for an intro destination (survives Gateway restarts)."""
    rid = str(receive_id or "").strip()
    rtype = str(receive_id_type or "chat_id").strip().lower() or "chat_id"
    if not rid:
        return ""
    return f"{rtype}:{rid}"


def has_intro_been_sent(agent_code: str, *, receive_id: str, receive_id_type: str = "chat_id") -> bool:
    """True when this role already pushed an intro to this destination."""
    code = str(agent_code or "").strip()
    key = intro_sent_key(receive_id=receive_id, receive_id_type=receive_id_type)
    if not code or not key:
        return False
    try:
        from evoflow.proactive.repositories import ProactiveRepository

        role = ProactiveRepository.get_role(code)
        if role is None:
            return False
        cfg = role.config
        sent = getattr(cfg, "feishu_intro_sent", None) or {}
        if isinstance(sent, dict) and str(sent.get(key) or "").strip():
            return True
        # Legacy single-field marker (private-chat / open_id only) when map empty.
        rtype = str(receive_id_type or "chat_id").strip().lower() or "chat_id"
        if (
            rtype == "open_id"
            and not (isinstance(sent, dict) and sent)
            and str(getattr(cfg, "feishu_intro_sent_at", "") or "").strip()
        ):
            return True
        return False
    except Exception:
        logger.debug("self_intro: has_intro_been_sent failed code=%s", code, exc_info=True)
        return False


def mark_intro_sent(agent_code: str, *, receive_id: str, receive_id_type: str = "chat_id") -> None:
    """Persist intro delivery marker on the role config (idempotent)."""
    code = str(agent_code or "").strip()
    key = intro_sent_key(receive_id=receive_id, receive_id_type=receive_id_type)
    if not code or not key:
        return
    try:
        from evoflow.proactive.repositories import ProactiveRepository

        role = ProactiveRepository.get_role(code)
        if role is None:
            return
        cfg = role.config
        now = utc_now_iso_z()
        sent = dict(getattr(cfg, "feishu_intro_sent", None) or {})
        if not str(sent.get(key) or "").strip():
            sent[key] = now
            # Cap growth if many groups somehow get intros
            if len(sent) > 200:
                # Drop oldest by timestamp string sort (ISO-Z sorts lexicographically).
                for old_key, _ in sorted(sent.items(), key=lambda kv: kv[1])[: len(sent) - 200]:
                    sent.pop(old_key, None)
            cfg.feishu_intro_sent = sent
        rtype = str(receive_id_type or "chat_id").strip().lower() or "chat_id"
        if rtype == "open_id" and not str(getattr(cfg, "feishu_intro_sent_at", "") or "").strip():
            cfg.feishu_intro_sent_at = now
        role.config = cfg
        ProactiveRepository.save_role(role)
    except Exception:
        logger.debug("self_intro: mark_intro_sent failed code=%s", code, exc_info=True)

# Wire name → short Chinese label for the capability list. Unknown tools fall
# back to their wire name (still readable).
_TOOL_LABEL_ZH = {
    "read": "读取文件",
    "read_file": "读取文件",
    "write": "写入文件",
    "write_file": "写入文件",
    "replace": "编辑文件",
    "delete": "删除文件",
    "find": "查找文件",
    "rg": "内容搜索",
    "search_code_index": "工作区搜索",
    "read_lints": "代码诊断",
    "terminal": "终端命令",
    "process": "进程管理",
    "tasks": "任务看板",
    "platform": "平台管理",
    "knowledge": "知识库",
    "web_search": "网络搜索",
    "fetch_url": "网页抓取",
    "web_extract": "网页提取",
    "view_image": "查看图片",
    "mind_map": "思维导图",
    "ask_clarification": "向你确认",
    "subagent": "委派子智能体",
    "plan": "制定计划",
    "todo": "会话清单",
    "tool_search": "查找工具",
    "mode_set": "模式切换",
    "send_message": "发送消息",
}

_MAX_DUTIES = 4
_MAX_TOOLS = 12


def _tool_labels(agent_code: str) -> list[str]:
    try:
        from evoflow.session_tool_binding.agent_tools import resolve_agent_tool_names_for_agent

        names = resolve_agent_tool_names_for_agent(agent_code)
    except Exception:
        logger.debug("self_intro: resolve tool names failed code=%s", agent_code, exc_info=True)
        return []
    labels: list[str] = []
    seen: set[str] = set()
    for raw in sorted(names):
        n = str(raw or "").strip().lower()
        if not n or n in seen:
            continue
        seen.add(n)
        labels.append(_TOOL_LABEL_ZH.get(n, n))
    return labels


def _agent_display_name(agent_code: str, fallback: str) -> str:
    try:
        from evoflow.config.agents_config import load_agent_config

        cfg = load_agent_config(agent_code)
        name = str(getattr(cfg, "agent_name", "") or "").strip() if cfg else ""
        if name:
            return name
    except Exception:
        logger.debug("self_intro: load agent name failed code=%s", agent_code, exc_info=True)
    return fallback


def build_employee_self_intro(agent_code: str) -> str:
    """Compose the standard self-introduction for ``agent_code`` (Markdown)."""
    code = str(agent_code or "").strip()
    if not code:
        return ""

    try:
        from evoflow.proactive.repositories import ProactiveRepository

        role = ProactiveRepository.get_role(code)
    except Exception:
        role = None

    role_name = str((role.role_name if role else "") or "").strip() or code
    display_name = _agent_display_name(code, role_name)

    # Duties: role responsibilities first, then agent description.
    duties: list[str] = []
    if role is not None:
        for r in (getattr(role.config, "responsibilities", None) or []):
            s = str(r or "").strip()
            if s and s not in duties:
                duties.append(s)
    if not duties:
        try:
            from evoflow.config.agents_config import load_agent_config

            cfg = load_agent_config(code)
            desc = str(getattr(cfg, "description", "") or "").strip() if cfg else ""
            if desc:
                duties.append(desc)
        except Exception:
            logger.debug("self_intro: load agent description failed code=%s", code, exc_info=True)

    labels = _tool_labels(code)

    lines: list[str] = [f"👋 你好，我是 **{display_name}**。"]
    if duties:
        joined = "；".join(duties[:_MAX_DUTIES])
        lines.append(f"**职责**：{joined}。")
    if labels:
        lines.append("**我能做的事**：" + "、".join(labels[:_MAX_TOOLS]) + "。")
    lines.append("")
    lines.append("你可以这样使唤我：")
    lines.append(f"1. 在群里 @{role_name} 直接说需求，例如「@{role_name} 帮我查一下这个报错」。")
    lines.append("2. 也可以私聊我，或在 EvoPanel 里直接给我派任务。")
    return "\n".join(lines)


async def push_employee_self_intro(
    agent_code: str,
    *,
    receive_id: str,
    receive_id_type: str = "chat_id",
    attempts: int = 3,
    delay: float = 1.5,
    force: bool = False,
) -> bool:
    """Best-effort proactive push of the employee self-intro via its own bot.

    Skips when a persisted intro marker already exists for this destination
    (unless ``force=True``). On success, marks the destination in role config
    so Gateway restarts cannot re-spam the same chat.
    """
    code = str(agent_code or "").strip()
    rid = str(receive_id or "").strip()
    if not code or not rid:
        return False
    if not force and has_intro_been_sent(code, receive_id=rid, receive_id_type=receive_id_type):
        logger.info("self_intro: skip already-sent agent=%s receive=%s", code, rid[:16])
        return False
    text = build_employee_self_intro(code)
    if not text:
        return False

    from app.channels.service import get_channel_service

    for attempt in range(max(1, int(attempts))):
        try:
            service = get_channel_service()
            channel = service._channels.get("feishu") if service is not None else None
            if channel is not None and getattr(channel, "is_running", False):
                send = getattr(channel, "send_proactive_markdown", None)
                if callable(send):
                    await send(rid, text, receive_id_type=receive_id_type, account_id=code)
                    mark_intro_sent(code, receive_id=rid, receive_id_type=receive_id_type)
                    logger.info("self_intro: pushed for agent=%s receive=%s", code, rid[:16])
                    return True
        except Exception:
            logger.debug("self_intro: push attempt %d failed agent=%s", attempt + 1, code, exc_info=True)
        if attempt < int(attempts) - 1:
            await asyncio.sleep(float(delay))
    return False
