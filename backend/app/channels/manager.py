"""ChannelManager — consumes inbound messages and dispatches them to the EvoFlow agent via LangGraph Server."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import mimetypes
import os
import re
import sys
import time
import uuid
from collections.abc import Mapping
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from app.channels.models.goal import GoalChannelType

from langgraph_sdk.errors import ConflictError, NotFoundError

from app.channels.feishu_message_format import maybe_format_tool_message_content_for_im
from app.channels.message_bus import InboundMessage, InboundMessageType, MessageBus, OutboundMessage, ResolvedAttachment
from app.channels.store import ChannelStore
from evoflow.runtime.long_run_limits import LONG_RUN_RECURSION_LIMIT

logger = logging.getLogger(__name__)

_MGR_DIAG_PATH = Path(
    os.environ.get("EVOFLOW_MGR_DIAG_LOG", r"C:\Users\admin\.evoflow-dev\logs\manager-diag.log")
)


def _mgr_diag(event: str, **fields: Any) -> None:
    try:
        _MGR_DIAG_PATH.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps(
            {"ts": time.time(), "pid": os.getpid(), "event": event, **fields},
            ensure_ascii=False,
            default=str,
        )
        with open(_MGR_DIAG_PATH, "a", encoding="utf-8") as fp:
            fp.write(line + "\n")
        print(line, file=sys.stderr, flush=True)
    except Exception:
        pass


# Align with ``scripts/windows/backend-common.ps1``, ``langgraph_proxy``, ``automation_runner`` (127.0.0.1).
# Single-process: LangGraph is mounted at /api/langgraph inside Gateway.
DEFAULT_LANGGRAPH_URL = "http://127.0.0.1:8070/api/langgraph"
DEFAULT_GATEWAY_URL = "http://127.0.0.1:8012"
DEFAULT_ASSISTANT_ID = "lead_agent"
"""LangGraph 图 id，与 ``langgraph.json`` 中 ``claude_code_chat`` 一致（面板 / IM 直连 Claude Code）。"""
CLAUDE_CODE_CHAT_ASSISTANT_ID = "claude_code_chat"
CUSTOM_AGENT_NAME_PATTERN = re.compile(r"^[A-Za-z0-9-]+$")
_IM_CLAUDE_RESUME_SID_RE = re.compile(r"^[\w.-]{1,160}$")

DEFAULT_RUN_CONFIG: dict[str, Any] = {"recursion_limit": LONG_RUN_RECURSION_LIMIT}
# IM 默认「闪速」：关闭 thinking，避免部分网关把思考内容混进正文；与 EvoPanel session_mode=flash 对齐。
DEFAULT_RUN_CONTEXT: dict[str, Any] = {
    "session_mode": "flash",
    "thinking_enabled": False,
    "reasoning_effort": "minimum",
    "is_plan_mode": False,
    "subagent_enabled": False,
}
STREAM_UPDATE_MIN_INTERVAL_SECONDS = 0.0
# Live Feishu card patches (is_final=False) are inherently flaky: rate limits drop
# mid-stream updates and the card freezes on a half sentence. Default OFF — no
# mid-stream Feishu publishes; final goes out as plain text (and Feishu skips the
# 「正在回复」placeholder). Set EVOFLOW_FEISHU_LIVE_STREAM=1 to re-enable.
FEISHU_LIVE_STREAM_PATCHES = os.getenv("EVOFLOW_FEISHU_LIVE_STREAM", "0").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}
# Only used when live stream patches are re-enabled.
FEISHU_STREAM_UPDATE_MIN_INTERVAL_SECONDS = float(os.getenv("EVOFLOW_FEISHU_STREAM_INTERVAL", "1.0"))
FEISHU_STREAM_MIN_PUBLISH_CHARS = int(os.getenv("EVOFLOW_FEISHU_STREAM_MIN_CHARS", "40"))
THREAD_BUSY_MESSAGE = "当前会话还有请求在处理中，请稍候再发。"
_IM_SHORTCUT_HINT_META_KEY = "im_shortcut_hint_sent"


def _im_shortcut_commands_help_lines(*, include_bootstrap: bool = False) -> list[str]:
    # 当前不输出任何日常 IM 快捷指令提示；入口保留在 Web 桌面端与 /help。
    # 群聊 / 小V 已被 _im_should_omit_shortcut_hint 过滤，不会走这里。
    lines: list[str] = []
    if include_bootstrap:
        lines.append("/bootstrap <提示>   - 初始化工作区（首次配置）")
    return lines


def _im_shortcut_commands_hint_text() -> str:
    """Shortcut command list shown after ``/new`` (not appended to agent replies)."""
    return "\n".join(_im_shortcut_commands_help_lines())


def _im_agent_is_xiaomi(run_context: dict[str, Any] | None, msg: InboundMessage) -> bool:
    """小V replies should not get the system IM shortcut-command footer."""
    try:
        from evoflow.agents.xiaomi.identity import is_xiaomi_agent
    except Exception:

        def is_xiaomi_agent(agent_name: str | None) -> bool:  # type: ignore[misc]
            return str(agent_name or "").strip().lower() in {"xiaomi", "小v", "小蜜", "xiaov"}

    name = str((run_context or {}).get("agent_name") or "").strip()
    if is_xiaomi_agent(name):
        return True
    meta = msg.metadata if isinstance(msg.metadata, dict) else {}
    account_id = str(meta.get("account_id") or meta.get("agent_code") or "").strip()
    return is_xiaomi_agent(account_id)


def _im_is_group_chat(msg: InboundMessage) -> bool:
    """True for Feishu/Slack-style group chats — no shortcut-command footer there."""
    meta = msg.metadata if isinstance(msg.metadata, dict) else {}
    chat_type = str(meta.get("chat_type") or meta.get("chatType") or "").strip().lower()
    if chat_type in {"group", "topic_group", "super_group", "public", "private_group"}:
        return True
    if chat_type in {"p2p", "private", "dm", "direct"}:
        return False
    # Feishu group chat_id usually starts with oc_; keep conservative: unknown → treat as group
    # only when channel is feishu and chat_id looks like a group chat.
    if msg.channel_name == "feishu":
        cid = str(msg.chat_id or "").strip().lower()
        if cid.startswith("oc_"):
            return True
    return False


def _im_should_omit_shortcut_hint(run_context: dict[str, Any] | None, msg: InboundMessage) -> bool:
    """Skip /new /claude /help footer for 小V and for group chats."""
    return _im_agent_is_xiaomi(run_context, msg) or _im_is_group_chat(msg)


def _im_new_session_reply(
    channel_name: str,
    new_thread_id: str,
    *,
    include_shortcut_hint: bool = True,
) -> str:
    """Reply body for ``/new`` — wording matches the IM channel (Feishu / Weixin / …)."""
    label = _CHANNEL_SESSION_TITLE_LABEL.get(channel_name) or str(channel_name or "IM")
    if channel_name == "feishu":
        window_note = "飞书侧仍是同一个群窗口，新建的是**服务端 Agent 线程**，不是新开一个飞书会话。"
    elif channel_name == "weixin":
        window_note = "微信侧仍是同一个聊天窗口，新建的是**服务端 Agent 线程**，不是新开一个微信会话。"
    else:
        window_note = f"{label}侧仍是同一个聊天窗口，新建的是**服务端 Agent 线程**，不是新开一个 {label} 会话。"
    body = (
        "已为当前会话绑定 **新的** LangGraph 线程（全新上下文，机器人不再读取旧线程里的上文）。\n"
        f"- 新线程 ID：`{new_thread_id}`\n"
        f"- **{label}聊天记录不会被系统删除**；只是后续消息会走这条新线程。\n"
        f"若你感觉「像清空而不是新建」：{window_note}"
    )
    if include_shortcut_hint:
        return body + "\n\n" + _im_shortcut_commands_hint_text()
    return body


def _parse_im_claude_resume_session_id(raw: str | None) -> str | None:
    """Validate optional ``/claude <session_id>`` token for IM."""
    if raw is None:
        return None
    s = str(raw).strip()
    if not s:
        return None
    if not _IM_CLAUDE_RESUME_SID_RE.match(s):
        return None
    return s


def _extract_claude_session_id_from_graph_values(snapshot: dict[str, Any] | list | None) -> str | None:
    if not isinstance(snapshot, dict):
        return None
    sid = snapshot.get("claude_session_id")
    if isinstance(sid, str) and sid.strip():
        return sid.strip()
    return None


CHANNEL_CAPABILITIES = {
    "feishu": {"supports_streaming": True},
    "slack": {"supports_streaming": False},
    "telegram": {"supports_streaming": False},
    "weixin": {"supports_streaming": False},
    "wecom": {"supports_streaming": False},
    "dingtalk": {"supports_streaming": False},
}
IM_CHANNEL_NAMES = frozenset({"feishu", "slack", "telegram", "weixin", "wecom", "dingtalk"})
# Channels that support per-employee bot binding via channels.<name>.accounts[<agent_code>].session.
# Each employee-bound bot is routed to its own custom agent (default assistant_id = account_id)
# instead of the channel-wide default. Add new channels here once they adopt the accounts schema.
PER_EMPLOYEE_ACCOUNT_CHANNELS = frozenset({"feishu", "wecom"})

_CHANNEL_SESSION_TITLE_LABEL: dict[str, str] = {
    "feishu": "飞书",
    "weixin": "微信",
    "wecom": "企业微信",
    "dingtalk": "钉钉",
    "slack": "Slack",
    "telegram": "Telegram",
}


def _im_agent_who_label(agent_code: str) -> str:
    """岗位/主对话标签，用于侧栏与推送选择器。"""
    code = str(agent_code or "").strip()
    if not code or code in {"main", "lead_agent"}:
        return "主对话"
    try:
        from evoflow.proactive.repositories import ProactiveRepository

        role = ProactiveRepository.get_role(code)
        if role is not None:
            name = str(getattr(role, "role_name", "") or "").strip()
            if name and name != code:
                return f"{name}"
    except Exception:
        logger.debug("im agent who label: role lookup failed code=%s", code, exc_info=True)
    if code == "xiaomi":
        return "小V"
    return code


def _default_channel_session_title(msg: InboundMessage, *, agent_name: str = "") -> str:
    """Stable IM sidebar title: 渠道 · 岗位/主对话 · chat id."""
    label = _CHANNEL_SESSION_TITLE_LABEL.get(msg.channel_name) or str(msg.channel_name or "IM")
    meta = msg.metadata if isinstance(msg.metadata, dict) else {}
    code = str(agent_name or "").strip() or str(meta.get("account_id") or "").strip() or str(meta.get("agent_code") or "").strip()
    who = _im_agent_who_label(code)
    cid = str(msg.chat_id or "").strip()
    short = cid if len(cid) <= 14 else f"{cid[:12]}…"
    title = f"{label} · {who} · {short}"
    if msg.topic_id:
        tid = str(msg.topic_id).strip()
        tshort = tid if len(tid) <= 10 else f"{tid[:8]}…"
        title += f" · {tshort}"
    return title


def _agent_code_from_im_session_key(session_key: str) -> str:
    """Extract employee/agent code from ``agent:…`` or ``proactive:…:chat:…`` keys."""
    sk = str(session_key or "").strip()
    if sk.startswith("agent:"):
        parts = sk.split(":")
        return str(parts[1] or "").strip() if len(parts) >= 2 else ""
    if sk.startswith("proactive:"):
        rest = sk[len("proactive:") :]
        for marker in (":chat:", ":duty:", ":task:"):
            idx = rest.find(marker)
            if idx >= 0:
                return rest[:idx].strip()
        return rest.strip()
    return ""


def _persist_channel_session_index(
    session_key: str,
    thread_id: str,
    msg: InboundMessage,
    *,
    title: str | None = None,
    touch_only: bool = False,
) -> None:
    """Write IM thread into ``evoflow_chat_sessions`` so EvoPanel sidebar list can show it."""
    sk = str(session_key or "").strip()
    tid = str(thread_id or "").strip()
    if not sk or not tid:
        return
    try:
        from evoflow.persistence import session_repositories as sess_repo

        now_ms = int(time.time() * 1000)
        meta = msg.metadata if isinstance(msg.metadata, dict) else {}
        agent_code = _agent_code_from_im_session_key(sk)
        if not agent_code:
            agent_code = str(meta.get("account_id") or meta.get("agent_code") or "").strip()
        ctx: dict[str, Any] = {
            "channel": str(msg.channel_name or ""),
            "channel_chat_id": str(msg.chat_id or ""),
        }
        if sk.startswith("proactive:"):
            # Side-bar「智能体员工」groups by proactive key / context.source.
            ctx["source"] = "proactive"
        if agent_code:
            ctx["agent_code"] = agent_code
            ctx["agent_name"] = agent_code
        if msg.topic_id:
            ctx["topic_id"] = str(msg.topic_id)
        if msg.user_id:
            ctx["user_id"] = str(msg.user_id)
        account_id = str(meta.get("account_id") or "").strip()
        if account_id:
            ctx["account_id"] = account_id
        row_title = ""
        if not touch_only:
            row_title = title if title is not None else _default_channel_session_title(msg, agent_name=agent_code)
        sess_repo.upsert_session_row(
            sk,
            thread_id=tid,
            title=row_title,
            created_at_ms=now_ms,
            updated_at_ms=now_ms,
            context=ctx,
        )
    except Exception:
        logger.warning(
            "[Manager] persist evoflow_chat_sessions failed session_key=%s thread_id=%s",
            sk,
            tid,
            exc_info=True,
        )


def _context_files_from_inbound(files: list[Any] | None) -> list[dict[str, Any]]:
    """Normalize ``InboundMessage.files`` into desktop-compatible ``contextFiles``."""
    out: list[dict[str, Any]] = []
    for entry in list(files or [])[:16]:
        if not isinstance(entry, dict):
            continue
        path = str(entry.get("path") or "").strip()
        if not path:
            continue
        name = (
            str(entry.get("filename") or entry.get("name") or "").strip()
            or Path(path).name
            or "attachment"
        )
        mime = str(entry.get("mime") or "").strip()
        if not mime:
            guessed, _ = mimetypes.guess_type(name)
            mime = (guessed or "").split(";", 1)[0].strip()
        item: dict[str, Any] = {"path": path, "name": name}
        if mime:
            item["mime"] = mime
        kind = str(entry.get("kind") or "").strip()
        if kind:
            item["kind"] = kind
        size = entry.get("size")
        if isinstance(size, (int, float)) and size > 0:
            item["size"] = int(size)
        out.append(item)
    return out


def _v4_attachments_from_context_files(files: list[Any] | None) -> list[dict[str, Any]]:
    """Map ``contextFiles`` → V4 ``AttachmentRef`` shape for hydrate / live mirror."""
    out: list[dict[str, Any]] = []
    for entry in list(files or [])[:16]:
        if not isinstance(entry, dict):
            continue
        path = str(entry.get("path") or entry.get("ref") or "").strip()
        if not path:
            continue
        name = (
            str(entry.get("name") or entry.get("fileName") or entry.get("filename") or "").strip()
            or Path(path).name
            or "attachment"
        )
        mime = str(entry.get("mime") or "").strip()
        if not mime:
            guessed, _ = mimetypes.guess_type(name)
            mime = (guessed or "").split(";", 1)[0].strip() or "application/octet-stream"
        bytes_n = entry.get("size")
        if not isinstance(bytes_n, (int, float)) or bytes_n < 0:
            bytes_n = 0
            try:
                bytes_n = max(0, int(Path(path).stat().st_size))
            except OSError:
                bytes_n = 0
        out.append(
            {
                "ref": path,
                "fileName": name,
                "mime": mime,
                "bytes": int(bytes_n),
            }
        )
    return out


def _persist_channel_user_transcript_turn(
    session_key: str,
    thread_id: str,
    text: str,
    *,
    files: list[Any] | None = None,
) -> str:
    """Persist IM user message + mark run active (same as EvoPanel ``chatSend``).

    Uses the sync ``append_message_and_touch_session`` path. Do **not** call
    async ``persist_user_message`` without awaiting — that silently drops rows
    and leaves SessionTranscriptHydrationMiddleware on stale history.

    When the inbound carries media, store ``contextFiles`` in ``content_json``
    (desktop ``chatSend`` shape) so V4 hydration can project ``attachments``.
    Image-/file-only turns still persist even when ``text`` is empty.
    """
    sk = str(session_key or "").strip()
    tid = str(thread_id or "").strip()
    body = str(text or "").strip()
    ctx_files = _context_files_from_inbound(files)
    run_id = str(uuid.uuid4())
    if not sk or not tid:
        return run_id
    try:
        from evoflow.persistence import chat_session_service as chat_svc
        from evoflow.session_execution.lifecycle import start_session_turn

        start_session_turn(session_key=sk, thread_id=tid, run_id=run_id, source="channel")
        if body or ctx_files:
            content_json: dict[str, Any] = {"content": body}
            if ctx_files:
                content_json["contextFiles"] = ctx_files
            chat_svc.append_message_and_touch_session(
                sk,
                role="user",
                content=body,
                content_json=content_json,
                run_id=run_id,
                thread_id=tid,
            )
            # Live V4 panel (if open on this thread): seed userInput + attachments
            # before RUN_STARTED so the bubble isn't text-only / missing.
            try:
                from app.gateway.v4.agui_mirror import mirror_note_user_input

                mirror_note_user_input(
                    tid,
                    body,
                    attachments=_v4_attachments_from_context_files(ctx_files) if ctx_files else None,
                )
            except Exception:
                logger.debug(
                    "[Manager] mirror_note_user_input skipped session_key=%s",
                    sk,
                    exc_info=True,
                )
        logger.info(
            "[Manager] channel user transcript persisted session_key=%s thread_id=%s run_id=%s text_len=%d files=%d",
            sk,
            tid,
            run_id,
            len(body),
            len(ctx_files),
        )
    except Exception:
        logger.warning(
            "[Manager] channel user transcript persist failed session_key=%s thread_id=%s",
            sk,
            tid,
            exc_info=True,
        )
    return run_id


def _finalize_channel_transcript_turn(session_key: str, thread_id: str) -> None:
    sk = str(session_key or "").strip()
    tid = str(thread_id or "").strip()
    if not sk:
        return
    try:
        from evoflow.session_execution.lifecycle import force_end_session_turn

        force_end_session_turn(session_key=sk, thread_id=tid or None, source="channel_finalize")
    except Exception:
        logger.debug(
            "[Manager] channel transcript finalize failed session_key=%s thread_id=%s",
            sk,
            tid,
            exc_info=True,
        )


def _enrich_channel_run_context(
    run_context: dict[str, Any],
    session_key: str,
    msg: InboundMessage,
    run_id: str,
) -> None:
    sk = str(session_key or "").strip()
    if sk:
        run_context["session_key"] = sk
    rid = str(run_id or "").strip()
    if rid:
        run_context["evf_channel_run_id"] = rid
    # Stamp IM origin so prompt assembly can inject channel-only instructions
    # (plain text / channels.send_message) without polluting Panel chats.
    channel = str(msg.channel_name or "").strip().lower()
    if channel:
        run_context["channel"] = channel
    chat_id = str(msg.chat_id or "").strip()
    if chat_id:
        run_context["channel_chat_id"] = chat_id
    user_id = str(msg.user_id or "").strip()
    if user_id:
        run_context["channel_user_id"] = user_id
    topic_id = str(msg.topic_id or "").strip()
    if topic_id:
        run_context["topic_id"] = topic_id
    meta = msg.metadata if isinstance(msg.metadata, dict) else {}
    account_id = str(meta.get("account_id") or "").strip()
    if account_id:
        run_context["account_id"] = account_id
    body = str(msg.text or "").strip()
    if body:
        run_context.setdefault("evf_user_question", body)
        run_context.setdefault("user_message", body)


def _channel_image_entries(files: list[Any]) -> list[dict[str, Any]]:
    """Return image-like inbound file dicts (kind/mime/suffix)."""
    out: list[dict[str, Any]] = []
    for entry in files:
        if not isinstance(entry, dict):
            continue
        path = str(entry.get("path") or "").strip()
        if not path:
            continue
        kind = str(entry.get("kind") or "").strip().lower()
        mime = str(entry.get("mime") or "").strip().lower()
        suffix = Path(path).suffix.lower()
        is_image = (
            kind == "image"
            or mime.startswith("image/")
            or suffix in {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"}
        )
        if is_image:
            out.append(entry)
    return out


def _caption_channel_images_for_im(files: list[dict[str, Any]]) -> str:
    """OCR / describe IM inbound images into plain text the main agent can use.

    Native ``image_url`` injection is unreliable across providers (and agents often
    fall through to ``platform.openai.vision`` which previously defaulted to a
    rate-limited free model). Pre-caption with the configured vision model so the
    turn always carries readable content even when pixels never reach the chat model.
    """
    from evoflow.tools.builtins.vision_analysis_core import analyze_image_bytes

    blocks: list[str] = []
    prompt = (
        "请完整、逐字抄录图中全部文字（题目、选项、公式、标注、小字都要）；"
        "若几乎无字则简要描述画面要点。不要寒暄，直接输出内容。"
    )
    for entry in files[:4]:
        path = str(entry.get("path") or "").strip()
        name = str(entry.get("filename") or entry.get("name") or Path(path).name or "image")
        if not path or not Path(path).is_file():
            blocks.append(f"- {name}: （文件不存在：{path or '∅'}）")
            continue
        try:
            raw = Path(path).read_bytes()
        except OSError as exc:
            blocks.append(f"- {name}: （读取失败：{exc}）")
            continue
        mime = str(entry.get("mime") or "").strip() or "image/jpeg"
        try:
            result = analyze_image_bytes(
                raw,
                mime,
                user_prompt=prompt,
                source="channel_inbound_caption",
                image_ref=path,
            )
        except Exception as exc:
            logger.warning("[Manager] channel image caption failed path=%s: %s", path, exc)
            blocks.append(f"- {name}: （识图异常：{exc}）")
            continue
        if result.get("error"):
            blocks.append(f"- {name}: （识图失败：{result.get('error')}）")
            continue
        analysis = str(result.get("analysis") or "").strip()
        model = str(result.get("vision_model") or "").strip()
        header = f"- {name}" + (f" · model={model}" if model else "")
        blocks.append(f"{header}\n{analysis}" if analysis else f"{header}\n（无文字）")
    if not blocks:
        return ""
    return "[渠道图片识别]\n" + "\n\n".join(blocks)


def _build_human_input(
    msg: InboundMessage,
    run_context: dict[str, Any] | None = None,
    run_config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build the LangGraph ``runs.wait`` / ``runs.stream`` ``input`` dict.

    Beyond the plain-text user turn, we forward ``InboundMessage.files`` as
    ``additional_kwargs.context_files`` so ContextFilesMiddleware can pick
    them up and feed images to the multimodal LLM.  Each entry is normalized
    into the shape ContextFilesMiddleware expects (``path`` + ``name``).

    When media is attached and the session model lacks vision support, this
    function injects the best available vision model into ``run_context``
    so ContextFilesMiddleware can emit native ``image_url`` blocks for this
    turn only.

    Returns ``{"messages": [{"role": "human", "content": ..., ...}]}`` — the
    LangChain-style payload the SDK already understands.
    """
    content = msg.text or ""
    files = list(msg.files or [])
    has_context_files = False
    context_files: list[dict[str, Any]] = []
    path_lines: list[str] = []
    if files:
        for entry in files:
            if not isinstance(entry, dict):
                continue
            path = str(entry.get("path") or "").strip()
            if not path:
                continue
            name = (
                str(entry.get("filename") or "").strip()
                or Path(path).name
                or "attachment"
            )
            cf_entry: dict[str, Any] = {"path": path, "name": name}
            mime = str(entry.get("mime") or "").strip()
            if mime:
                cf_entry["mime"] = mime
            kind = str(entry.get("kind") or "").strip()
            if kind:
                cf_entry["kind"] = kind
            size = entry.get("size")
            if isinstance(size, (int, float)) and size > 0:
                cf_entry["size"] = int(size)
            url = str(entry.get("url") or "").strip()
            if url:
                cf_entry["url"] = url
            context_files.append(cf_entry)
            path_lines.append(f"- {name}\n  Path: {path}")
        if context_files:
            has_context_files = True
        # Surface durable local paths in the human turn text so the model always
        # sees where channel media lives (ContextFilesMiddleware also injects
        # <context_files>, but text paths survive even when vision/native fails).
        if path_lines:
            channel = str(msg.channel_name or "im").strip() or "im"
            footer = (
                f"\n\n[渠道附件本地路径 · {channel}]\n"
                + "\n".join(path_lines)
                + "\n这些是本机已落盘的文件地址；读写请用上述 Path。"
            )
            content = f"{content.rstrip()}{footer}" if content.strip() else footer.strip()

        # IM: pre-caption images so the lead model can act without relying on
        # native multimodal (or on platform.openai.vision hitting a free-tier 429).
        if msg.channel_name in IM_CHANNEL_NAMES:
            image_entries = _channel_image_entries(files)
            if image_entries:
                try:
                    caption = _caption_channel_images_for_im(image_entries)
                except Exception:
                    logger.warning("[Manager] channel image caption skipped", exc_info=True)
                    caption = ""
                if caption:
                    content = f"{content.rstrip()}\n\n{caption}" if content.strip() else caption
                    _mgr_diag(
                        "channel_image_caption",
                        channel=msg.channel_name,
                        images=len(image_entries),
                        caption_len=len(caption),
                    )

    message: dict[str, Any] = {"role": "human", "content": content}
    if context_files:
        message["additional_kwargs"] = {"context_files": context_files}

    # The authoritative model lives in run_config.configurable.model_name (lead_agent
    # reads it via cfg.get("model_name")). Vision fallback overrides only run_context["model_name"].
    run_configurable = (run_config or {}).get("configurable") if isinstance(run_config, dict) else {}
    if not isinstance(run_configurable, dict):
        run_configurable = {}
    run_context_dict = run_context if isinstance(run_context, dict) else {}
    configured_model = (
        str(run_configurable.get("model_name") or "").strip()
        or str(run_configurable.get("model") or "").strip()
        or None
    )
    vision_override_model = str(run_context_dict.get("model_name") or "").strip() or None
    effective_model = vision_override_model or configured_model

    _mgr_diag(
        "build_human_input",
        channel=msg.channel_name,
        files=len(files),
        has_context_files=has_context_files,
        text_preview=(msg.text or "")[:50],
        configured_model=configured_model,
        vision_override_model=vision_override_model,
        effective_model=effective_model,
        agent_name=str(run_context_dict.get("agent_name") or "").strip() or None,
        account_id=ChannelManager._inbound_account_id(msg) or None,
    )

    # Vision model fallback: if the inbound carries media but the session's
    # model does not support vision, inject the first available vision-capable
    # model so ContextFilesMiddleware can inject native image blocks.
    # This does NOT change the run_config.model (agent binding still wins);
    # it only ensures the right model is used for this one multimodal turn.
    if has_context_files and files:
        from evoflow.tools.builtins.vision_analysis_core import model_supports_vision, resolve_vision_model_name

        ctx = run_context or {}
        current_model = str(ctx.get("model_name") or "").strip()
        if not current_model or not model_supports_vision(current_model):
            vision_model = resolve_vision_model_name(source="channel_multimodal")
            if vision_model:
                _mgr_diag(
                    "vision_fallback",
                    channel=msg.channel_name,
                    current_model=current_model or "(unset)",
                    vision_model=vision_model,
                    reason="current model has no vision support",
                )
                if run_context is not None:
                    run_context["model_name"] = vision_model
                    run_context["_vision_fallback"] = True
                else:
                    run_context = {"model_name": vision_model, "_vision_fallback": True}
            else:
                _mgr_diag(
                    "vision_fallback",
                    channel=msg.channel_name,
                    current_model=current_model or "(unset)",
                    vision_model=None,
                    reason="no vision-capable model found in config",
                )

    return {"messages": [message]}


def _release_channel_owned_paths(msg: InboundMessage) -> None:
    """Hand the inbound file lifecycle back to the originating channel.

    The WeCom channel caches inbound media in temp files (for the agent to
    read via ContextFilesMiddleware).  Without this hook, the channel would
    unlink them immediately after ``publish_inbound`` returns, so we defer
    release until the manager is done — this function is called from the
    ``finally`` of ``_handle_message``.

    Channels that never cache inbound media (e.g. weixin today) are a no-op
    here; Feishu/WeCom implement ``release_owned_temp_paths``.
    """
    meta = msg.metadata if isinstance(msg.metadata, dict) else {}
    raw_paths = meta.get("_owned_temp_paths")
    if not isinstance(raw_paths, list) or not raw_paths:
        return
    paths = [str(p) for p in raw_paths if str(p or "").strip()]
    if not paths:
        return
    channel_name = str(msg.channel_name or "").strip().lower()
    channel = None
    try:
        from app.channels.service import get_channel_service

        service = get_channel_service()
    except Exception:
        service = None
    if service is not None:
        # Primary bot runs as ``service._channels[name]``.  Per-account bots
        # run under names like ``wecom:customer-service``.  The per-account
        # handle is the one that actually owns the inbound message, so it
        # wins over the primary namespace when both are registered.
        candidate_keys: list[str] = []
        meta = msg.metadata if isinstance(msg.metadata, dict) else {}
        account_id = str(meta.get("account_id") or "").strip()
        if account_id:
            candidate_keys.append(f"{channel_name}:{account_id}")
        candidate_keys.append(channel_name)
        channels_map = getattr(service, "_channels", None)
        if isinstance(channels_map, dict):
            for key in candidate_keys:
                chan = channels_map.get(key)
                if chan is not None:
                    channel = chan
                    break
    if channel is None:
        return
    releaser = getattr(channel, "release_owned_temp_paths", None)
    if callable(releaser):
        try:
            releaser(paths)
        except Exception:
            logger.debug(
                "[Manager] channel %s release_owned_temp_paths failed",
                channel_name,
                exc_info=True,
            )


class InvalidChannelSessionConfigError(ValueError):
    """Raised when IM channel session overrides contain invalid agent config."""


def _is_thread_busy_error(exc: BaseException | None) -> bool:
    if exc is None:
        return False
    if isinstance(exc, ConflictError):
        return True
    return "already running a task" in str(exc)


def _is_startup_gate_error(exc: BaseException | None) -> bool:
    """Detect transient 'Gateway starting up' errors that should be retried.
    
    These are 503 errors from StartupGateMiddleware indicating the Gateway
    or LangGraph is still initializing. They're temporary and should retry.
    """
    if exc is None:
        return False
    msg = _exception_message_text(exc).lower()
    # Match "starting_up", "warming_up", "loading_extended" error codes
    # Also match the user-facing messages from startup_gate.py
    return (
        '"error":"starting_up"' in msg
        or '"error":"warming_up"' in msg
        or '"error":"loading_extended"' in msg
        or "gateway 正在注册" in msg
        or "agent 引擎仍在加载" in msg
        or "扩展模块仍在加载" in msg
        or "正在注册 api 路由" in msg
        or "gateway starting up" in msg
        or "agent engine" in msg
        or "extension module" in msg
    )


def _is_transient_stream_error(exc: BaseException | None) -> bool:
    """Timeouts / dropped HTTP streams that often clear after a short backoff.

    Event-loop stalls (e.g. SQLite write-lock starvation from catalog scans)
    surface here as ReadTimeout / RemoteProtocolError with an empty IM reply.
    """
    if exc is None:
        return False
    if _is_startup_gate_error(exc) or _is_thread_busy_error(exc):
        return False
    name = type(exc).__name__
    if name in (
        "ReadTimeout",
        "WriteTimeout",
        "PoolTimeout",
        "ConnectTimeout",
        "TimeoutException",
        "RemoteProtocolError",
        "LocalProtocolError",
        "ReadError",
        "WriteError",
        "NetworkError",
    ):
        return True
    msg = _exception_message_text(exc).lower()
    compact = msg.replace(" ", "")
    return (
        "readtimeout" in compact
        or "writetimeout" in compact
        or "connecttimeout" in compact
        or "pooltimeout" in compact
        or "timed out" in msg
        or "read operation timed out" in msg
        or "connection reset" in msg
        or "server disconnected" in msg
        or "remoteprotocolerror" in compact
        or "incomplete chunked read" in msg
    )


def _exception_message_text(exc: BaseException) -> str:
    parts = [str(exc)]
    notes = getattr(exc, "__notes__", None)
    if notes:
        parts.extend(str(note) for note in notes)
    response = getattr(exc, "response", None)
    if response is not None:
        body = getattr(response, "text", None)
        if body:
            parts.append(str(body))
    return "\n".join(parts)


def _is_thread_or_assistant_not_found_error(exc: BaseException | None) -> bool:
    if exc is None:
        return False
    if isinstance(exc, NotFoundError):
        return True
    response = getattr(exc, "response", None)
    if response is not None and getattr(response, "status_code", None) == 404:
        body = _exception_message_text(exc).lower()
        if ("thread" in body and "not found" in body) or ("assistant" in body and "not found" in body):
            return True
    s = _exception_message_text(exc).lower()
    return ("thread" in s and "not found" in s) or ("assistant" in s and "not found" in s)


def _im_langgraph_unreachable_lines(exc: BaseException | None) -> list[str]:
    """User-facing hints when the gateway cannot open a TCP connection to LangGraph."""
    if exc is None:
        return []
    cls = type(exc)
    name = cls.__name__
    mod = getattr(cls, "__module__", "") or ""
    msg_l = str(exc).lower()
    is_connect = (
        (name == "ConnectError" and "httpx" in mod)
        or (name == "ConnectError" and "httpcore" in mod)
        or "connection attempts failed" in msg_l
        or "connecterror" in msg_l.replace(" ", "")
        or "connection refused" in msg_l
        or "name or service not known" in msg_l
        or "getaddrinfo failed" in msg_l
        or "network is unreachable" in msg_l
        or "timed out" in msg_l
        or "timeout" in msg_l
        and "connect" in msg_l
    )
    if not is_connect:
        return []
    return [
        "",
        "**无法连接 LangGraph**（网关到 LangGraph 的 HTTP 请求未建立）。请依次检查：",
        "- LangGraph Server 是否已启动；端口与下方「当前 LangGraph」一致（`restart-dev-stack` / **`dev-stack-isolated.bat`** 用 **`EVOFLOW_LANGGRAPH_PORT`** 等指定）。",
        "- **`EVOFLOW_LANGGRAPH_URL`** 与 **`EVOFLOW_CHANNELS_LANGGRAPH_URL`** 是否指向该进程（启动脚本对 Gateway 窗口会同时设置二者）；`127.0.0.1` 与 `localhost` 在部分环境下不可互换。",
        "- 若网关在 Docker / WSL / 远程机，**不要**写宿主机上的 `localhost`，应写 LangGraph 所在机器可达的主机名或内网 IP。",
    ]


def _as_dict(value: Any) -> dict[str, Any]:
    return dict(value) if isinstance(value, Mapping) else {}


def _merge_dicts(*layers: Any) -> dict[str, Any]:
    merged: dict[str, Any] = {}
    for layer in layers:
        if isinstance(layer, Mapping):
            merged.update(layer)
    return merged


def _langgraph_merge_configurable_into_context(
    run_config: dict[str, Any],
    run_context: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any]]:
    """LangGraph Agent Server rejects runs that set both ``config.configurable`` and ``context``.

    User/session fields must live in ``context`` only. Merge any ``configurable`` from
    ``run_config`` into ``run_context`` (existing context keys win on conflict), then drop
    ``configurable`` from ``run_config`` so ``recursion_limit`` / ``tags`` remain on ``config``.
    """
    rc = dict(run_config)
    user_conf = rc.pop("configurable", None)
    ctx = dict(run_context)
    if isinstance(user_conf, dict) and user_conf:
        merged = {**user_conf, **ctx}
    else:
        merged = ctx
    return rc, merged


def _normalize_custom_agent_name(raw_value: str) -> str:
    """Normalize legacy channel assistant IDs into valid custom agent names."""
    normalized = raw_value.strip().lower().replace("_", "-")
    if not normalized:
        raise InvalidChannelSessionConfigError("Channel session assistant_id is empty. Use 'lead_agent' or a valid custom agent name.")
    if not CUSTOM_AGENT_NAME_PATTERN.fullmatch(normalized):
        raise InvalidChannelSessionConfigError(f"Invalid channel session assistant_id {raw_value!r}. Use 'lead_agent' or a custom agent name containing only letters, digits, and hyphens.")
    return normalized


def _last_human_text_from_messages(messages: list[Any] | None) -> str:
    """Return trimmed plain text of the last human message in state (for stream snapshot gating)."""
    if not messages:
        return ""
    for msg in reversed(messages):
        if not isinstance(msg, dict):
            continue
        if str(msg.get("type", "") or "").lower() != "human":
            continue
        return _extract_text_content(msg.get("content")).strip()
    return ""


def _extract_response_text(result: dict | list) -> str:
    """Extract the last AI message text from a LangGraph runs.wait result.

    ``runs.wait`` returns the final state dict which contains a ``messages``
    list.  Each message is a dict with at least ``type`` and ``content``.

    Handles special cases:
    - Regular AI text responses
    - Clarification interrupts (``ask_clarification`` tool messages)
    - AI messages with tool_calls but no text content
    - ``ui_messages`` field (when ``messages`` is cleared by CheckpointTranscriptSlimMiddleware)
    """
    if isinstance(result, list):
        messages = result
    elif isinstance(result, dict):
        messages = result.get("messages", [])
    else:
        return ""

    # Walk backwards to find usable response text, but stop at the last
    # human message to avoid returning text from a previous turn.
    for msg in reversed(messages):
        if not isinstance(msg, dict):
            continue

        msg_type = msg.get("type")

        # Stop at the last human message — anything before it is a previous turn
        if msg_type == "human":
            break

        # Check for tool messages from ask_clarification (interrupt case)
        if msg_type == "tool" and msg.get("name") == "ask_clarification":
            content = msg.get("content", "")
            formatted = maybe_format_tool_message_content_for_im(str(msg.get("name")), content)
            if isinstance(formatted, str) and formatted.strip():
                return formatted
            if isinstance(content, str) and content:
                return content

        # Regular AI message with text content
        if msg_type == "ai":
            content = msg.get("content", "")
            if isinstance(content, str) and content:
                return content
            # content can be a list of content blocks
            if isinstance(content, list):
                parts = []
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "text":
                        parts.append(block.get("text", ""))
                    elif isinstance(block, str):
                        parts.append(block)
                text = "".join(parts)
                if text:
                    return text

    # Fallback: Check ui_messages (populated by UiMessagesSnapshotMiddleware and not cleared
    # by CheckpointTranscriptSlimMiddleware on the returned result).
    if isinstance(result, dict):
        ui = result.get("ui_messages", [])
        if isinstance(ui, list):
            for msg in reversed(ui):
                if not isinstance(msg, dict):
                    continue
                role = str(msg.get("role") or msg.get("type") or "").strip().lower()
                # Skip human/tool/function messages
                if role in ("human", "user", "tool", "function"):
                    break
                if role in ("ai", "assistant", ""):
                    content = msg.get("content", "")
                    if isinstance(content, str) and content.strip():
                        return content
                    if isinstance(content, list):
                        for block in content:
                            if isinstance(block, dict) and block.get("type") == "text":
                                text = block.get("text", "")
                                if isinstance(text, str) and text.strip():
                                    return text
                            elif isinstance(block, str) and block.strip():
                                return block
                    text = msg.get("text", "")
                    if isinstance(text, str) and text.strip():
                        return text

    return ""


def _extract_text_content(content: Any) -> str:
    """Extract text from a streaming payload content field."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, Mapping):
                text = block.get("text")
                if isinstance(text, str):
                    parts.append(text)
                else:
                    nested = block.get("content")
                    if isinstance(nested, str):
                        parts.append(nested)
        return "".join(parts)
    if isinstance(content, Mapping):
        for key in ("text", "content"):
            value = content.get(key)
            if isinstance(value, str):
                return value
    return ""


def _query_latest_ai_message_from_db(session_key: str, limit: int = 5) -> list[str]:
    """Query evoflow_chat_messages for the latest assistant text responses.

    This is the SSOT for AI messages (written by TranscriptMiddleware after_model).
    We scan backward from the newest rows to find recent assistant messages.
    """
    try:
        from evoflow.persistence.db import get_db

        db = get_db()
        rows = db.execute(
            """
            SELECT content_json FROM evoflow_chat_messages
            WHERE session_key = ? AND role = 'assistant'
            ORDER BY seq DESC LIMIT ?
            """,
            (str(session_key).strip(), max(1, int(limit))),
        ).fetchall()

        texts: list[str] = []
        for row in rows:
            try:
                import json

                payload = json.loads(str(row[0] or "{}"))
                # Extract text from various possible payload structures
                content = payload if isinstance(payload, str) else payload.get("content", "")
                if isinstance(content, list):
                    for block in content:
                        if isinstance(block, dict) and block.get("type") == "text":
                            text = str(block.get("text") or "").strip()
                            if text:
                                texts.append(text)
                                break
                elif isinstance(content, str) and content.strip():
                    texts.append(content.strip())
            except Exception:
                pass
        return texts
    except Exception:
        return []



def _unwrap_custom_stream_payload(data: Any) -> Any:
    """LangGraph may emit ``custom`` data as ``[namespace, chunk]``; unwrap to the chunk mapping."""
    if isinstance(data, (list, tuple)) and len(data) >= 2:
        second = data[1]
        if _to_mapping(second) is not None:
            return second
    if isinstance(data, (list, tuple)) and len(data) >= 1:
        first = data[0]
        if _to_mapping(first) is not None:
            return first
    return data


def _extract_custom_stream_text(payload: Any) -> str:
    """Extract assistant-facing text from LangGraph ``custom`` stream events.

    Accepts common delta shapes; skips tool/progress payloads whose ``content``
    would otherwise hijack the Feishu card (longer-wins race).
    """
    m = _to_mapping(payload)
    if m is None:
        return ""

    ev_type = str(m.get("type") or "").strip().lower()
    # Tool / progress / status frames are not the IM reply body.
    if ev_type and any(
        token in ev_type
        for token in (
            "progress",
            "tool_",
            "tool-call",
            "approval",
            "status",
            "usage",
            "subagent",
            "error",
            "heartbeat",
        )
    ):
        return ""

    for key in ("text", "chunk", "delta"):
        v = m.get(key)
        if isinstance(v, str) and v:
            return v

    # ``content`` only for explicit text/delta-like events (avoid dumping tool blobs).
    if (not ev_type) or ("delta" in ev_type) or ev_type in {"text", "message", "assistant", "token"}:
        v = m.get("content")
        if isinstance(v, str) and v:
            return v
    return ""


def _im_stream_type_name(payload_map: Mapping[str, Any], payload: Any) -> str:
    """Normalize LangGraph / LangChain message type for IM stream filtering."""
    raw = payload_map.get("type")
    if isinstance(raw, str) and raw.strip():
        return raw.strip()
    role = payload_map.get("role")
    if isinstance(role, str) and role.strip():
        return role.strip()
    name = getattr(payload, "__class__", type(payload)).__name__
    return str(name or "")


def _is_im_live_assistant_stream_row(payload_map: Mapping[str, Any], payload: Any = None) -> bool:
    """True only for live assistant token rows (``*Chunk``), not human/history sync.

    Mirrors ``sse_ui_normalize``: complete ``AIMessage`` rows are transcript sync and
    must not become Feishu card snapshots mid-stream.
    """
    type_name = _im_stream_type_name(payload_map, payload)
    type_l = type_name.lower()
    role = str(payload_map.get("role") or "").strip().lower()

    if role in {"user", "system", "tool"}:
        return False
    if type_l in {
        "human",
        "humanmessage",
        "humanmessagechunk",
        "user",
        "system",
        "systemmessage",
        "systemmessagechunk",
        "tool",
        "toolmessage",
        "toolmessagechunk",
    }:
        return False
    if "human" in type_l or "system" in type_l:
        return False
    if type_l.startswith("tool") or type_l.endswith("toolmessage") or type_l.endswith("toolmessagechunk"):
        return False

    # Live model output uses *Chunk; hydrated transcript uses complete messages.
    if not type_name.endswith("Chunk") and not type_l.endswith("chunk"):
        return False

    if role == "assistant":
        return True
    if type_l in {"ai", "aimessage", "aimessagechunk", "assistant", "assistantmessagechunk"}:
        return True
    if "aimessagechunk" in type_l or type_l.endswith("aimessagechunk"):
        return True
    # Generic *Chunk that is not human/tool/system — treat as assistant tokens.
    return "tool" not in type_l


def _to_mapping(value: Any) -> Mapping[str, Any] | None:
    """Best-effort convert SDK/model objects into a mapping for parsing."""
    if isinstance(value, Mapping):
        return value

    # Pydantic v2 models
    model_dump = getattr(value, "model_dump", None)
    if callable(model_dump):
        try:
            dumped = model_dump()
            if isinstance(dumped, Mapping):
                return dumped
        except Exception:
            pass

    # Pydantic v1 / dataclass-like dict()
    as_dict = getattr(value, "dict", None)
    if callable(as_dict):
        try:
            dumped = as_dict()
            if isinstance(dumped, Mapping):
                return dumped
        except Exception:
            pass

    raw_dict = getattr(value, "__dict__", None)
    if isinstance(raw_dict, Mapping):
        return raw_dict
    return None


def _merge_stream_text(existing: str, chunk: str) -> str:
    """Merge either delta text or cumulative text into a single snapshot."""
    if not chunk:
        return existing
    if not existing or chunk == existing:
        return chunk or existing
    if chunk.startswith(existing):
        return chunk
    if existing.endswith(chunk):
        return existing
    return existing + chunk


def _accumulate_evf_stream_text(state: dict[str, str], data: Any) -> str | None:
    """Extract assistant text from Gateway UI-normalized ``event: evf`` frames."""
    m = _to_mapping(data)
    if m is None:
        return None
    ev_type = str(m.get("type") or "").strip().lower()
    if ev_type == "delta":
        delta = _extract_custom_stream_text(m)
        if not delta:
            return None
        existing = state.get("text", "")
        delta_kind = str(m.get("delta_kind") or "").strip().lower()
        if delta_kind == "replace":
            state["text"] = delta
        else:
            state["text"] = _merge_stream_text(existing, delta)
        return state["text"]
    if ev_type == "run_end":
        end_text = m.get("text")
        if isinstance(end_text, str) and end_text.strip():
            state["text"] = end_text
            return end_text
        return state.get("text") or None
    return None


def _channel_stream_params(langgraph_url: str) -> dict[str, str] | None:
    """Disable Gateway UI SSE transform so IM channels receive raw LangGraph events."""
    url = (langgraph_url or "").strip().lower()
    if "/api/langgraph" in url:
        return {"ui_sse": "0"}
    return None


def _extract_stream_message_id(payload: Any, metadata: Any) -> str | None:
    """Best-effort extraction of the streamed AI message identifier."""
    candidates = [payload, metadata]
    if isinstance(payload, Mapping):
        candidates.append(payload.get("kwargs"))

    for candidate in candidates:
        mapping_candidate = _to_mapping(candidate)
        if mapping_candidate is None:
            for key in ("id", "message_id"):
                value = getattr(candidate, key, None)
                if isinstance(value, str) and value:
                    return value
            continue
        for key in ("id", "message_id"):
            value = mapping_candidate.get(key)
            if isinstance(value, str) and value:
                return value
    return None


def _accumulate_stream_text(
    buffers: dict[str, str],
    current_message_id: str | None,
    event_data: Any,
) -> tuple[str | None, str | None]:
    """Convert a ``messages-tuple`` event into the latest displayable AI text.

    Only live assistant ``*Chunk`` rows update the snapshot. Human / system / tool /
    complete history ``AIMessage`` rows are ignored so Feishu cards do not flash
    the user prompt or prior turns mid-stream.
    """
    payload = event_data
    metadata: Any = None
    if isinstance(event_data, (list, tuple)):
        if event_data:
            payload = event_data[0]
        if len(event_data) > 1:
            metadata = event_data[1]

    # Bare strings are ambiguous; only continue an already-open assistant buffer.
    if isinstance(payload, str):
        if not current_message_id or not payload:
            return None, current_message_id
        buffers[current_message_id] = _merge_stream_text(buffers.get(current_message_id, ""), payload)
        return buffers[current_message_id], current_message_id

    payload_map = _to_mapping(payload)
    if payload_map is None:
        return None, current_message_id

    if not _is_im_live_assistant_stream_row(payload_map, payload):
        return None, current_message_id

    text = _extract_text_content(payload_map.get("content"))
    kwargs_map = _to_mapping(payload_map.get("kwargs"))
    if not text and kwargs_map is not None:
        text = _extract_text_content(kwargs_map.get("content"))
    if not text:
        return None, current_message_id

    message_id = _extract_stream_message_id(payload, metadata) or current_message_id or "__default__"
    # New assistant message id: start a fresh buffer (do not append onto a prior turn).
    if current_message_id and message_id != current_message_id and message_id not in buffers:
        buffers[message_id] = text
    else:
        buffers[message_id] = _merge_stream_text(buffers.get(message_id, ""), text)
    return buffers[message_id], message_id


def _join_im_stream_buffers(buffers: dict[str, str]) -> str:
    """Join every assistant buffer in this turn for **live** IM card display.

    LangGraph emits a **new** message id after each tool call. Using only the
    latest buffer makes Feishu cards regress to「这是一」/「![」and look stuck
    while tools run. Keep prior segments visible; order follows insertion.

    Do **not** use this for the final outbound bubble — that dumps the whole
    mid-turn progress log into one Feishu message. Finals use
    :func:`_latest_im_stream_buffer`.
    """
    parts: list[str] = []
    for text in buffers.values():
        chunk = str(text or "").strip()
        if chunk:
            parts.append(chunk)
    return "\n\n".join(parts)


def _latest_im_stream_buffer(buffers: dict[str, str]) -> str:
    """Last non-empty assistant stream buffer (insertion order).

    Mid-turn status lines ("下载完成…", "等视觉理解跑完") each get their own
    message id; the final user-visible IM reply should be only the latest.
    """
    last = ""
    for text in buffers.values():
        chunk = str(text or "").strip()
        if chunk:
            last = chunk
    return last


def _should_skip_im_stream_regression(previous: str, candidate: str) -> bool:
    """True when publishing ``candidate`` would wipe a longer in-flight card.

    New assistant messages after a tool call often restart with「这是一」/「![」
    which is also a *prefix* of the previous long reply — so a naive
    ``prev.startswith(cur)`` check would wrongly allow the wipe.
    """
    prev = str(previous or "")
    cur = str(candidate or "")
    if not prev or not cur:
        return False
    if len(cur) >= len(prev):
        return False
    if prev in cur:
        return False
    # Ignore tiny shrinks (stream corrections); block large regressions.
    return len(cur) + 24 < len(prev)


# Deliverable file types from AI reply body → IM upload. Source code / binaries
# are intentionally excluded so random path cites are not exfiltrated.
_DELIVERABLE_EXTS = frozenset(
    {
        ".png",
        ".jpg",
        ".jpeg",
        ".gif",
        ".webp",
        ".bmp",
        ".svg",
        ".mp4",
        ".mov",
        ".webm",
        ".mkv",
        ".opus",
        ".mp3",
        ".wav",
        ".m4a",
        ".pdf",
        ".doc",
        ".docx",
        ".xls",
        ".xlsx",
        ".ppt",
        ".pptx",
        ".csv",
        ".txt",
        ".md",
        ".zip",
        ".json",
    }
)

_USER_DATA_VIRTUAL_PREFIX = "/mnt/user-data/"
_USER_DATA_SHORT_ROOTS = ("outputs/", "uploads/", "workspace/")


def _artifact_looks_deliverable(path: str) -> bool:
    cleaned = str(path or "").strip().rstrip(").,;\"'")
    if not cleaned or cleaned.lower().startswith(("http://", "https://", "data:")):
        return False
    # file:///C:/... or file:///home/...
    if cleaned.lower().startswith("file:"):
        cleaned = cleaned[5:].lstrip("/\\")
        if cleaned.startswith("/") and len(cleaned) > 2 and cleaned[2] == ":":
            # file:///C:/x → C:/x on Windows-style
            cleaned = cleaned.lstrip("/")
    suffix = Path(cleaned.replace("\\", "/")).suffix.lower()
    return suffix in _DELIVERABLE_EXTS


def _extract_artifacts_from_text(text: str) -> list[str]:
    """Pull local deliverable paths out of one assistant reply body."""
    import re

    if not text:
        return []

    # @@path@@ wrappers (legacy)
    at_path_re = re.compile(r"@@([^@\n]+?)@@")
    # Markdown image/link: ![x](path) or [x](path) — skip remote URLs later
    md_link_re = re.compile(r"!\[[^\]]*\]\(([^)\s]+)\)|\[[^\]]*\]\(([^)\s]+)\)")
    # Backtick / quoted paths
    tick_path_re = re.compile(r"[`'\"]([^`'\"]+)[`'\"]")
    # Absolute /mnt/user-data/... or Windows drive paths with deliverable suffix
    ext_alt = "|".join(sorted({e.lstrip(".") for e in _DELIVERABLE_EXTS}))
    abs_path_re = re.compile(
        rf"(?:/mnt/user-data/[^\s`'\"<>|\]]+\.(?:{ext_alt})"
        # Windows drive paths — reject URL schemes like https:// (would match s://)
        rf"|[A-Za-z]:(?:\\[^\s`'\"<>|\]]+|/[^/\s`'\"<>|\]][^\s`'\"<>|\]]*)\.(?:{ext_alt})"
        rf"|(?:outputs|uploads|workspace)/[^\s`'\"<>|\]]+\.(?:{ext_alt}))",
        re.IGNORECASE,
    )

    artifacts: list[str] = []
    seen: set[str] = set()

    def _add(path: str) -> None:
        cleaned = str(path or "").strip().strip("`'\"").rstrip(").,;")
        if cleaned.lower().startswith("file:"):
            cleaned = cleaned[5:]
            if cleaned.startswith("///"):
                cleaned = cleaned[3:]
            elif cleaned.startswith("//"):
                cleaned = cleaned[2:]
            elif cleaned.startswith("/"):
                cleaned = cleaned[1:]
        cleaned = cleaned.strip().replace("\\", "/")
        if not _artifact_looks_deliverable(cleaned):
            return
        key = cleaned.lower()
        if key in seen:
            return
        seen.add(key)
        artifacts.append(cleaned)

    for m in at_path_re.finditer(text):
        _add(m.group(1))
    for m in md_link_re.finditer(text):
        _add(m.group(1) or m.group(2) or "")
    for m in tick_path_re.finditer(text):
        _add(m.group(1))
    for m in abs_path_re.finditer(text):
        _add(m.group(0))
    return artifacts


def _extract_artifacts(result: dict | list, *, response_text: str = "") -> list[str]:
    """Extract deliverable file paths from the last AI response cycle.

    Reads whatever the model put in the body (markdown image/link, backticks,
    ``@@…@@``, absolute /mnt or drive paths) — not limited to ``outputs/``.
    Remote http(s) links stay in the text; only local-looking deliverables
    become upload candidates.
    """
    if isinstance(result, list):
        messages = result
    elif isinstance(result, dict):
        messages = result.get("messages", [])
    else:
        messages = []

    def _text_from_content(content) -> str:
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts: list[str] = []
            for block in content:
                if isinstance(block, str):
                    parts.append(block)
                elif isinstance(block, dict) and block.get("type") == "text":
                    parts.append(str(block.get("text") or ""))
            return "\n".join(parts)
        return str(content or "")

    chunks: list[str] = []
    for msg in reversed(messages):
        if not isinstance(msg, dict):
            continue
        if msg.get("type") == "human":
            break
        if msg.get("type") == "ai":
            chunks.append(_text_from_content(msg.get("content")))
    if response_text:
        chunks.append(str(response_text))

    artifacts: list[str] = []
    seen: set[str] = set()
    for chunk in chunks:
        for path in _extract_artifacts_from_text(chunk):
            key = path.lower()
            if key in seen:
                continue
            seen.add(key)
            artifacts.append(path)
    return artifacts


def _format_artifact_text(artifacts: list[str]) -> str:
    """Format artifact paths into a human-readable text block listing filenames."""
    import posixpath

    filenames = [posixpath.basename(p) for p in artifacts]
    if len(filenames) == 1:
        return f"Created File: 📎 {filenames[0]}"
    return "Created Files: 📎 " + "、".join(filenames)


def _normalize_user_data_virtual_path(raw: str) -> str:
    """Map short ``outputs|uploads|workspace/…`` cites onto ``/mnt/user-data/…``."""
    cleaned = str(raw or "").strip().replace("\\", "/").strip("`'\"").strip()
    if not cleaned:
        return ""
    if cleaned.startswith(_USER_DATA_VIRTUAL_PREFIX):
        if ".." in cleaned.split("/"):
            return ""
        return cleaned
    lowered = cleaned.lstrip("/")
    for root in _USER_DATA_SHORT_ROOTS:
        if lowered.lower().startswith(root):
            rel = lowered[len(root) :]
            if not rel or ".." in rel.split("/"):
                return ""
            return f"{_USER_DATA_VIRTUAL_PREFIX}{root}{rel}"
    return ""


def _attachment_allowed_roots(thread_id: str) -> list[Path]:
    """Host directories that IM outbound may read files from for this thread."""
    from evoflow.config.paths import get_paths

    paths = get_paths()
    roots: list[Path] = []
    for getter in (
        paths.sandbox_user_data_dir,
        paths.sandbox_outputs_dir,
        paths.sandbox_uploads_dir,
        paths.sandbox_work_dir,
        paths.acp_workspace_dir,
    ):
        try:
            root = getter(thread_id).resolve()
        except Exception:
            continue
        roots.append(root)
    # Deduplicate while preserving order
    out: list[Path] = []
    seen: set[str] = set()
    for root in roots:
        key = str(root).lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(root)
    return out


def _path_under_roots(actual: Path, roots: list[Path]) -> bool:
    try:
        resolved = actual.resolve()
    except OSError:
        return False
    for root in roots:
        try:
            resolved.relative_to(root)
            return True
        except ValueError:
            continue
    return False


def _is_sensitive_host_path(actual: Path) -> bool:
    """Reject obvious OS / secrets locations even for absolute body cites."""
    try:
        parts = [p.lower() for p in actual.resolve().parts]
    except OSError:
        return True
    joined = "/".join(parts).replace("\\", "/").lower()
    blocked = (
        "windows/system32",
        "windows/syswow64",
        "program files",
        "program files (x86)",
        "/etc/",
        "/usr/bin",
        "/bin/",
        "/sbin/",
        "appdata/roaming/microsoft",
        ".ssh",
        ".gnupg",
        "credentials",
        "id_rsa",
    )
    return any(b in joined for b in blocked)


def _resolve_one_attachment(thread_id: str, raw_path: str) -> ResolvedAttachment | None:
    """Resolve one body cite to a host file under the thread allowlist.

    Absolute host paths the model already cited (e.g. skill ``$PROJ`` frames
    under knowledge-library) are also accepted when they exist, are deliverable,
    and are not sensitive OS paths — otherwise IM finishes with text-only
    ``file:///…`` cards that look stuck halfway.
    """
    from evoflow.config.paths import get_paths

    cleaned = str(raw_path or "").strip().strip("`'\"").rstrip(").,;")
    if not cleaned or not _artifact_looks_deliverable(cleaned):
        return None

    paths = get_paths()
    roots = _attachment_allowed_roots(thread_id)
    candidates: list[Path] = []

    virtual = _normalize_user_data_virtual_path(cleaned)
    if virtual:
        try:
            candidates.append(paths.resolve_virtual_path(thread_id, virtual))
        except (ValueError, OSError) as exc:
            logger.debug("[Manager] virtual resolve failed %s: %s", cleaned, exc)

    # Absolute host path (Windows drive or POSIX)
    hostish = cleaned.replace("\\", "/")
    absolute_cite = bool(__import__("re").match(r"^[A-Za-z]:/", hostish)) or (
        hostish.startswith("/") and not hostish.startswith("/mnt/user-data/")
    )
    if absolute_cite:
        candidates.append(Path(cleaned))

    # Relative basename / nested → try under each thread root
    rel = hostish.lstrip("/")
    if rel and not rel.startswith("mnt/user-data/"):
        for root in roots:
            candidates.append(root / Path(rel).name)
            candidates.append(root / rel)
            for sub in ("outputs", "uploads", "workspace"):
                candidates.append(root / sub / Path(rel).name)
                candidates.append(root / sub / rel)

    seen_files: set[str] = set()
    for candidate in candidates:
        try:
            actual = candidate.resolve()
        except OSError:
            continue
        key = str(actual).lower()
        if key in seen_files:
            continue
        seen_files.add(key)
        if not actual.is_file():
            continue
        under_thread = _path_under_roots(actual, roots)
        # Absolute cites from agent skill/project dirs are outside the thread
        # sandbox — still deliver when clearly non-sensitive media/docs.
        if not under_thread:
            if not absolute_cite or _is_sensitive_host_path(actual):
                logger.warning(
                    "[Manager] rejected artifact outside thread allowlist: %s -> %s",
                    cleaned,
                    actual,
                )
                continue
            try:
                if actual.stat().st_size > 30 * 1024 * 1024:
                    logger.warning("[Manager] rejected oversized absolute artifact: %s", actual)
                    continue
            except OSError:
                continue
            logger.info(
                "[Manager] accepting absolute artifact outside thread sandbox: %s",
                actual,
            )
        mime, _ = mimetypes.guess_type(str(actual))
        mime = mime or "application/octet-stream"
        return ResolvedAttachment(
            virtual_path=virtual or cleaned,
            actual_path=actual,
            filename=actual.name,
            mime_type=mime,
            size=actual.stat().st_size,
            is_image=mime.startswith("image/"),
        )
    logger.warning("[Manager] artifact not resolvable for IM delivery: %s", cleaned)
    return None


def _resolve_attachments(thread_id: str, artifacts: list[str]) -> list[ResolvedAttachment]:
    """Resolve reply-body paths to host files under the thread allowlist.

    Accepts outputs/uploads/workspace virtual paths **and** absolute host paths
    that still live under this thread's user-data / workspace roots. Remote
    URLs are never resolved here.
    """
    attachments: list[ResolvedAttachment] = []
    seen: set[str] = set()
    for raw_path in artifacts:
        att = _resolve_one_attachment(thread_id, raw_path)
        if att is None:
            continue
        key = str(att.actual_path.resolve()).lower()
        if key in seen:
            continue
        seen.add(key)
        attachments.append(att)
    return attachments


def _prepare_artifact_delivery(
    thread_id: str,
    response_text: str,
    artifacts: list[str],
) -> tuple[str, list[ResolvedAttachment]]:
    """Resolve attachments and append filename fallbacks to the text response."""
    attachments: list[ResolvedAttachment] = []
    # Also mine the outbound text itself — streaming paths may only appear there.
    merged = list(artifacts or [])
    for path in _extract_artifacts_from_text(response_text or ""):
        if path not in merged:
            merged.append(path)
    if not merged:
        return response_text, attachments

    attachments = _resolve_attachments(thread_id, merged)
    resolved_names = {a.filename.lower() for a in attachments}
    unresolved = [
        path
        for path in merged
        if Path(str(path).replace("\\", "/")).name.lower() not in resolved_names
    ]

    if unresolved:
        artifact_text = _format_artifact_text(unresolved)
        response_text = (response_text + "\n\n" + artifact_text) if response_text else artifact_text

    # Always include resolved attachment filenames as a text fallback so files
    # remain discoverable even when the upload is skipped or fails.
    if attachments:
        resolved_text = _format_artifact_text([a.filename for a in attachments])
        response_text = (response_text + "\n\n" + resolved_text) if response_text else resolved_text

    return response_text, attachments


class ChannelManager:
    """Core dispatcher that bridges IM channels to the EvoFlow agent.

    It reads from the MessageBus inbound queue, creates/reuses threads on
    the LangGraph Server, sends messages via ``runs.wait``, and publishes
    outbound responses back through the bus.
    """

    def __init__(
        self,
        bus: MessageBus,
        store: ChannelStore,
        *,
        max_concurrency: int = 64,
        langgraph_url: str = DEFAULT_LANGGRAPH_URL,
        gateway_url: str = DEFAULT_GATEWAY_URL,
        assistant_id: str = DEFAULT_ASSISTANT_ID,
        default_session: dict[str, Any] | None = None,
        channel_sessions: dict[str, Any] | None = None,
    ) -> None:
        self.bus = bus
        self.store = store
        self._max_concurrency = max_concurrency
        self._langgraph_url = langgraph_url
        self._gateway_url = gateway_url
        self._assistant_id = assistant_id
        self._default_session = _as_dict(default_session)
        self._channel_sessions = dict(channel_sessions or {})
        self._client = None  # lazy init — langgraph_sdk async client
        self._semaphore: asyncio.Semaphore | None = None
        # IM 会话级：/claude 开启后走 ``claude_code_chat`` 图（与 EvoPanel agent:claude-code 对齐）
        self._claude_code_chat_mode: dict[str, bool] = {}
        # ``/claude <session_id>``：首条用户消息经 context 注入 ``claude_session_id``，首轮 run 后丢弃。
        self._im_claude_seed_session_id: dict[str, str] = {}
        self._running = False
        self._task: asyncio.Task | None = None
        self._chat_locks: dict[str, asyncio.Lock] = {}
        # routing_key → latest in-flight IM run preview / thread
        self._active_im_runs: dict[str, dict[str, Any]] = {}

    def _im_run_control_meta(self, msg: InboundMessage, thread_id: str) -> dict[str, Any]:
        meta = self._outbound_metadata_from_inbound(msg)
        meta["run_control"] = {
            "channel": msg.channel_name,
            "chat_id": msg.chat_id,
            "topic_id": msg.topic_id or "",
            "thread_id": thread_id,
            "account_id": ChannelManager._inbound_account_id(msg),
        }
        return meta

    async def _cancel_pending_runs_on_thread(self, client, thread_id: str) -> int:
        """Cancel pending/running LangGraph runs on ``thread_id``. Returns count."""
        tid = str(thread_id or "").strip()
        if not tid:
            return 0
        cancelled = 0
        try:
            runs = await client.runs.list(thread_id=tid, limit=20)
        except Exception:
            logger.debug("[Manager] list runs for cancel failed thread=%s", tid, exc_info=True)
            return 0
        for run in runs or []:
            run_id = str(
                (run.get("run_id") if isinstance(run, dict) else getattr(run, "run_id", None))
                or (run.get("id") if isinstance(run, dict) else getattr(run, "id", None))
                or ""
            ).strip()
            status = str(
                (run.get("status") if isinstance(run, dict) else getattr(run, "status", None))
                or ""
            ).strip().lower()
            if not run_id or status not in ("pending", "running"):
                continue
            try:
                await client.runs.cancel(thread_id=tid, run_id=run_id)
                cancelled += 1
            except Exception:
                logger.debug(
                    "[Manager] cancel im run failed thread=%s run=%s",
                    tid,
                    run_id,
                    exc_info=True,
                )
        return cancelled

    async def cancel_active_im_run(
        self,
        *,
        channel_name: str,
        chat_id: str,
        topic_id: str | None = None,
        thread_id: str | None = None,
    ) -> dict[str, Any]:
        """Cancel pending/running LangGraph runs for an IM chat thread."""
        parts = [str(channel_name), str(chat_id)]
        if topic_id:
            parts.append(str(topic_id))
        routing_key = ":".join(parts)
        tracked = self._active_im_runs.get(routing_key) or {}
        tid = str(thread_id or tracked.get("thread_id") or "").strip()
        if not tid and self.store is not None:
            tid = self.store.get_thread_id(channel_name, chat_id, topic_id=topic_id) or self.store.get_thread_id(channel_name, chat_id, topic_id=None) or ""
        preview = str(tracked.get("preview") or "")[:800]
        if not tid:
            return {"ok": False, "error": "找不到进行中的会话", "cancelled": 0, "preview": preview}

        client = self._get_client()
        try:
            cancelled = await self._cancel_pending_runs_on_thread(client, tid)
        except Exception as exc:
            logger.warning("[Manager] list/cancel im runs failed thread=%s: %s", tid, exc)
            return {"ok": False, "error": str(exc)[:120], "cancelled": 0, "preview": preview}

        tracked = dict(tracked)
        tracked["cancelled"] = True
        tracked["preview"] = preview
        self._active_im_runs[routing_key] = tracked
        logger.info(
            "[Manager] cancelled im runs=%d channel=%s chat=%s thread=%s",
            cancelled,
            channel_name,
            chat_id,
            tid,
        )
        return {"ok": True, "cancelled": cancelled, "thread_id": tid, "preview": preview}

    @staticmethod
    def _chat_lock_key(msg: InboundMessage) -> str:
        parts = [str(msg.channel_name), str(msg.chat_id)]
        if msg.topic_id:
            parts.append(str(msg.topic_id))
        return ":".join(parts)

    @staticmethod
    def _channel_supports_streaming(channel_name: str) -> bool:
        return CHANNEL_CAPABILITIES.get(channel_name, {}).get("supports_streaming", False)

    def _resolve_session_layer(self, msg: InboundMessage) -> tuple[dict[str, Any], dict[str, Any]]:
        channel_layer = _as_dict(self._channel_sessions.get(msg.channel_name))
        # Per-employee IM bot: channels.<channel>.accounts[<agent_code>].session
        # Routes that bot to the employee agent of the same code instead of the
        # channel-wide default assistant. Applies to feishu and wecom (and any
        # future channel that adopts the ``accounts[].session`` schema).
        account_id = ChannelManager._inbound_account_id(msg)
        if account_id and msg.channel_name in PER_EMPLOYEE_ACCOUNT_CHANNELS:
            acc_session = self._account_session(msg.channel_name, account_id)
            if acc_session:
                channel_layer = _merge_dicts(channel_layer, acc_session)
        users_layer = _as_dict(channel_layer.get("users"))
        user_layer = _as_dict(users_layer.get(msg.user_id))
        return channel_layer, user_layer

    @staticmethod
    def _account_session(channel_name: str, account_id: str) -> dict[str, Any]:
        """Load session overrides for an IM employee account.

        Reads from ``evoflow_bot_bindings`` (new flat table) first, then falls
        back to the legacy in-memory channel config JSON.  This keeps routing
        working even when the table has not been populated yet (fresh install).

        Returns an empty dict when the account is unknown so callers fall through
        to the channel-wide default.
        """
        cn = str(channel_name or "").strip()
        aid = str(account_id or "").strip()
        if not cn or not aid:
            return {}

        # New path: read directly from the flat table.
        try:
            from evoflow.persistence.config_repositories import get_bot_binding_by_agent

            binding = get_bot_binding_by_agent(cn, aid)
            if binding:
                session: dict[str, Any] = dict(binding.get("session_config") or {})
                if not session.get("assistant_id"):
                    session["assistant_id"] = aid
                return session
        except Exception:
            logger.debug("[Manager] _account_session(%s, %s) table lookup failed, trying legacy", cn, aid)

        # Legacy path: read from ChannelService in-memory config.
        try:
            from app.channels.service import get_channel_service

            service = get_channel_service()
            if service is None:
                return {}
            ch_cfg = service._config.get(cn) if isinstance(service._config, dict) else None
            if not isinstance(ch_cfg, dict):
                return {}
            accounts = ch_cfg.get("accounts")
            if not isinstance(accounts, dict):
                return {}
            acc = accounts.get(aid)
            if not isinstance(acc, dict):
                return {}
            session = _as_dict(acc.get("session"))
            # Default: route this bot to the employee agent of the same code.
            if not session.get("assistant_id"):
                session = {**session, "assistant_id": aid}
            return session
        except Exception:
            logger.debug("[Manager] %s account session lookup failed", cn, exc_info=True)
            return {}

    # Keep the feishu-specific name as a thin wrapper so any direct call sites
    # still work. New code should use _account_session(channel_name, account_id).
    @staticmethod
    def _feishu_account_session(account_id: str) -> dict[str, Any]:
        return ChannelManager._account_session("feishu", account_id)

    @staticmethod
    def _outbound_metadata_from_inbound(msg: InboundMessage) -> dict[str, Any]:
        # Always stamp account_id (may be "") so Feishu primary is not confused with
        # "missing" and must not fall back to another bot's chat_account mapping.
        # Prefer top-level inbound.account_id (WeCom / fixed Feishu) over metadata-only.
        return {
            "account_id": ChannelManager._inbound_account_id(msg),
        }

    @staticmethod
    def _im_routing_key(msg: InboundMessage) -> str:
        parts = [str(msg.channel_name), str(msg.chat_id)]
        account_id = ChannelManager._inbound_account_id(msg)
        if account_id:
            parts.append(f"acct:{account_id}")
            parts.append(f"acct:{account_id}")
        if msg.topic_id:
            parts.append(str(msg.topic_id))
        return ":".join(parts)

    @staticmethod
    def _inbound_account_id(msg: InboundMessage) -> str:
        # Read from top-level field first (wecom now stamps it there).
        # Fall back to metadata for feishu / legacy channel parity.
        top = getattr(msg, "account_id", None) or ""
        if str(top).strip():
            return str(top).strip()
        return str((msg.metadata or {}).get("account_id") or "").strip()

    @classmethod
    def _channel_store_topic(cls, msg: InboundMessage) -> str | None:
        """Per-bot Feishu bindings: same group must not share one LangGraph thread.

        Encoded as synthetic topic ``acct:<account_id>`` (or ``acct:<id>:<feishu_topic>``)
        so ChannelStore keys stay ``channel:chat:topic`` compatible.
        """
        topic = str(msg.topic_id or "").strip() or None
        account_id = cls._inbound_account_id(msg)
        if msg.channel_name == "feishu" and account_id:
            return f"acct:{account_id}:{topic}" if topic else f"acct:{account_id}"
        return topic

    def _lookup_bound_thread_id(self, msg: InboundMessage) -> str:
        """Resolve IM→thread mapping; Feishu employee bots are isolated by account_id."""
        store_topic = self._channel_store_topic(msg)
        tid = self.store.get_thread_id(msg.channel_name, msg.chat_id, topic_id=store_topic) or ""
        if tid:
            return tid
        # Legacy primary-bot binding (no account): allow bare chat_id lookup once.
        if msg.channel_name == "feishu" and not self._inbound_account_id(msg):
            if store_topic:
                tid = self.store.get_thread_id(msg.channel_name, msg.chat_id, topic_id=None) or ""
            if not tid:
                tid = self.store.get_thread_id(msg.channel_name, msg.chat_id, topic_id=None) or ""
        elif msg.channel_name != "feishu" and store_topic:
            tid = self.store.get_thread_id(msg.channel_name, msg.chat_id, topic_id=None) or ""
        return tid

    def _set_claude_code_im_mode(self, msg: InboundMessage, enabled: bool, *, seed_session_id: str | None = None) -> None:
        key = self._im_routing_key(msg)
        if enabled:
            self._claude_code_chat_mode[key] = True
            if seed_session_id:
                self._im_claude_seed_session_id[key] = seed_session_id
            else:
                self._im_claude_seed_session_id.pop(key, None)
        else:
            self._claude_code_chat_mode.pop(key, None)
            self._im_claude_seed_session_id.pop(key, None)

    def _resolve_run_params(self, msg: InboundMessage, thread_id: str) -> tuple[str, dict[str, Any], dict[str, Any]]:
        channel_layer, user_layer = self._resolve_session_layer(msg)

        assistant_id = user_layer.get("assistant_id") or channel_layer.get("assistant_id") or self._default_session.get("assistant_id") or self._assistant_id
        if not isinstance(assistant_id, str) or not assistant_id.strip():
            assistant_id = self._assistant_id

        run_config = _merge_dicts(
            DEFAULT_RUN_CONFIG,
            self._default_session.get("config"),
            channel_layer.get("config"),
            user_layer.get("config"),
        )

        run_context = _merge_dicts(
            DEFAULT_RUN_CONTEXT,
            self._default_session.get("context"),
            channel_layer.get("context"),
            user_layer.get("context"),
            {"thread_id": thread_id},
        )

        im_claude = self._claude_code_chat_mode.get(self._im_routing_key(msg), False)
        if im_claude:
            # 与 EvoPanel ``useClaudeCodeChat`` 的 context 收紧一致；必须用 ``claude_code_chat`` 图，不可 remap 成 lead_agent。
            assistant_id = CLAUDE_CODE_CHAT_ASSISTANT_ID
            run_context["agent_name"] = "claude-code"
            run_context["thinking_enabled"] = False
            run_context["reasoning_effort"] = "minimum"
            run_context["is_plan_mode"] = False
            run_context["subagent_enabled"] = False
            run_context["collab_phase"] = "idle"
            run_context.pop("collab_task_id", None)
            seed_sid = self._im_claude_seed_session_id.get(self._im_routing_key(msg))
            if seed_sid:
                run_context["claude_code_chat"] = True
                run_context["claude_session_id"] = seed_sid
        # Custom agents are implemented as lead_agent + agent_name context.
        # Keep backward compatibility for channel configs that set
        # assistant_id: <custom-agent-name> by routing through lead_agent.
        elif assistant_id != DEFAULT_ASSISTANT_ID:
            # Per-employee IM bot (Feishu/WeCom account_session routes the
            # inbound to a non-main custom agent). The channel-wide
            # ``session_mode=flash`` (=ask, empty bound catalog) would
            # collapse the employee's tool surface to nothing, so the
            # custom-agent branch overrides it: we fall through to the
            # agent's persisted ``session_mode`` from
            # ``evoflow_chat_sessions`` (or the agent-mode default for a
            # brand-new thread, mirroring ``buildDefaultSessionContext``
            # in evopanel/src/lib/ws-client.js which sets
            # ``session_mode: 'agent'``). The IM-friendly thinking /
            # reason budget from ``DEFAULT_RUN_CONTEXT`` is preserved so
            # chat still feels responsive.
            run_context["agent_name"] = _normalize_custom_agent_name(assistant_id)
            run_context.pop("session_mode", None)
            run_context.setdefault("session_mode", "agent")
            assistant_id = DEFAULT_ASSISTANT_ID
        else:
            # Default lead_agent — still pass agent_name so config (tools/skills) is loaded
            run_context.setdefault("agent_name", "main")

        return assistant_id, run_config, run_context

    def _channel_thread_session_key(self, msg: InboundMessage) -> str:
        """Sidebar session key for an IM thread.

        - Primary / shared bot → ``agent:{code}:{channel}:{chat_id}`` (任务 Tab)
        - Per-employee bot (account_id set) → ``proactive:{code}:chat:{channel}:{chat_id}``
          so Feishu/WeCom chats land under「智能体员工」, not the generic task list.
        """
        _, _, run_context = self._resolve_run_params(msg, "__pending__")
        agent_name = str(run_context.get("agent_name") or "main").strip() or "main"
        parts: list[str] = [str(msg.channel_name), str(msg.chat_id)]
        if msg.topic_id:
            parts.append(str(msg.topic_id))
        tail = ":".join(parts)
        account_id = self._inbound_account_id(msg)
        # Dedicated employee bots (Feishu/WeCom accounts[<agent_code>]) belong with
        # the employee. Primary slot (empty account_id) stays on the task list.
        if (
            account_id
            and account_id not in {"main", "lead_agent"}
            and msg.channel_name in PER_EMPLOYEE_ACCOUNT_CHANNELS
        ):
            code = account_id
            # Prefer resolved agent_name when it matches the account slot.
            if agent_name and agent_name not in {"main", "lead_agent"}:
                code = agent_name
            return f"proactive:{code}:chat:{tail}"
        return f"agent:{agent_name}:{tail}"

    # -- LangGraph SDK client (lazy) ----------------------------------------

    def _get_client(self):
        """Return the ``langgraph_sdk`` async client, creating it on first use."""
        if self._client is None:
            from langgraph_sdk import get_client

            self._client = get_client(url=self._langgraph_url)
        return self._client

    # -- lifecycle ---------------------------------------------------------

    async def start(self) -> None:
        """Start the dispatch loop."""
        if self._running:
            return
        self._running = True
        self._semaphore = asyncio.Semaphore(self._max_concurrency)
        self._task = asyncio.create_task(self._dispatch_loop())
        logger.info("ChannelManager started (max_concurrency=%d)", self._max_concurrency)

    async def stop(self) -> None:
        """Stop the dispatch loop."""
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        logger.info("ChannelManager stopped")

    # -- dispatch loop -----------------------------------------------------

    async def _dispatch_loop(self) -> None:
        logger.info("[Manager] dispatch loop started, waiting for inbound messages")
        while self._running:
            try:
                msg = await self.bus.get_inbound(timeout=1.0)
            except TimeoutError:
                from evoflow.observability.poll_loop_log import log_poll_tick

                log_poll_tick("channel_dispatch_idle", key="bus", interval_s=120.0)
                continue
            except asyncio.CancelledError:
                break

            logger.info(
                "[Manager] 开始处理 inbound: channel=%s, chat_id=%s, type=%s\n--- user ---\n%s\n---",
                msg.channel_name,
                msg.chat_id,
                msg.msg_type.value,
                (msg.text or "").strip() or "(empty)",
            )
            # Channel-audit: every inbound that the manager consumes from the
            # bus must leave a trail in evoflow_channel_push_log. Internal
            # EvoPanel turns do not go through this bus (they hit
            # append_message_and_touch_session directly), so this entrypoint
            # captures "external IM inbound" only. Failures must never block
            # the dispatch path.
            with contextlib.suppress(Exception):
                from evoflow.persistence.channel_push_repositories import safe_record_push

                _meta = msg.metadata if isinstance(msg.metadata, dict) else {}
                _files = list(msg.files or [])[:8]
                _summary = str(msg.text or "").strip()
                if _files:
                    _labels: list[str] = []
                    for _f in _files:
                        if isinstance(_f, dict):
                            _path = str(_f.get("path") or "").strip()
                            _n = str(_f.get("filename") or _f.get("name") or "").strip()
                            if not _n and _path:
                                _n = _path.replace("\\", "/").rsplit("/", 1)[-1]
                            if _path:
                                _labels.append(f"{_n or 'attachment'} → {_path}"[:200])
                            elif _n:
                                _labels.append(_n[:80])
                        else:
                            _s = str(_f or "").strip()
                            if _s:
                                _labels.append(_s[:120])
                    if _labels:
                        _att = "；".join(_labels[:4])
                        _summary = f"{_summary} [附件：{_att}]".strip() if _summary else f"[附件：{_att}]"
                safe_record_push(
                    direction="inbound",
                    channel=str(msg.channel_name or "").strip() or "im",
                    kind="im_message",
                    event="callback",
                    transport="im_event",
                    sender_account_id=str(msg.account_id or ""),
                    external_message_id=str(msg.thread_ts or ""),
                    receive_id=str(msg.chat_id or ""),
                    receive_id_type="chat_id",
                    title="",
                    content_summary=_summary[:800],
                    payload={
                        "user_id": str(msg.user_id or ""),
                        "msg_type": str(getattr(msg.msg_type, "value", msg.msg_type) or ""),
                        "topic_id": str(msg.topic_id or ""),
                        "files": _files,
                        "metadata": {k: _meta[k] for k in list(_meta.keys())[:12]},
                    },
                    status="ok",
                    triggered_by="user",
                )
            task = asyncio.create_task(self._handle_message(msg))
            task.add_done_callback(self._log_task_error)

    @staticmethod
    def _log_task_error(task: asyncio.Task) -> None:
        """Surface unhandled exceptions from background tasks."""
        if task.cancelled():
            return
        exc = task.exception()
        if exc:
            logger.error("[Manager] unhandled error in message task: %s", exc, exc_info=exc)

    def _resolve_stored_thread_id(self, msg: InboundMessage) -> str:
        return self._lookup_bound_thread_id(msg)

    def _im_shortcut_hint_sent(self, msg: InboundMessage) -> bool:
        if msg.channel_name not in IM_CHANNEL_NAMES:
            return True
        store_topic = self._channel_store_topic(msg)
        entry = self.store.get_entry(msg.channel_name, msg.chat_id, topic_id=store_topic)
        if not entry and msg.channel_name == "feishu" and not self._inbound_account_id(msg):
            entry = self.store.get_entry(msg.channel_name, msg.chat_id, topic_id=None)
        return bool((entry or {}).get(_IM_SHORTCUT_HINT_META_KEY))

    async def _append_im_shortcut_hint(self, msg: InboundMessage, response_text: str) -> str:
        """Append one-time shortcut hint to the same outbound bubble (avoids a 2nd Feishu card).

        Skipped for group chats and 小V — those footers clutter coworker-facing replies.
        """
        if msg.channel_name not in IM_CHANNEL_NAMES or self._im_shortcut_hint_sent(msg):
            return response_text
        if _im_is_group_chat(msg) or _im_agent_is_xiaomi(None, msg):
            return response_text
        body = (response_text or "").rstrip()
        hint = _im_shortcut_commands_hint_text()
        merged = f"{body}\n\n{hint}" if body else hint
        await self.store.merge_thread_meta(
            msg.channel_name,
            msg.chat_id,
            {_IM_SHORTCUT_HINT_META_KEY: True},
            topic_id=self._channel_store_topic(msg),
        )
        return merged

    def _record_im_channel_failure(
        self,
        msg: InboundMessage,
        *,
        exc: BaseException | None = None,
        message: str | None = None,
        user_visible: str | None = None,
    ) -> None:
        """Record IM channel failure in SQLite observability."""
        if msg.channel_name not in IM_CHANNEL_NAMES:
            return
        tid = self._resolve_stored_thread_id(msg)
        err_text = (message or (str(exc) if exc else "")).strip()
        if len(err_text) > 4000:
            err_text = err_text[:3997] + "…"
        payload = {
            "event": "im_channel_error",
            "channel": msg.channel_name,
            "chat_id": msg.chat_id,
            "topic_id": msg.topic_id,
            "inbound_msg_type": msg.msg_type.value,
            "exception_type": type(exc).__name__ if exc else None,
            "error_message": err_text,
            "user_visible_preview": (user_visible or "")[:1200],
            "langgraph_url": self._langgraph_url,
        }
        try:
            from datetime import UTC, datetime

            from evoflow.observability.recorder import get_observability_recorder

            occurred = datetime.now(UTC).isoformat().replace("+00:00", "Z")
            get_observability_recorder().record_im_channel_error(
                thread_id=tid or None,
                occurred_at=occurred,
                payload=payload,
            )
        except Exception:
            pass

    def _im_rich_error_body(self, msg: InboundMessage, exc: BaseException | None = None, *, fallback: str | None = None) -> str:
        """飞书/IM 卡片内可读的错误说明（含 LangGraph 地址，便于自查）。"""
        et = type(exc).__name__ if exc else "Error"
        em = (str(exc) if exc else (fallback or "")).strip()
        if len(em) > 480:
            em = em[:477] + "…"
        lines = ["**处理失败**", "", f"类型：`{et}`"]
        if em:
            lines.extend(["", "详情：", em])
        lines.extend(_im_langgraph_unreachable_lines(exc))
        lines.extend(
            [
                "",
                "---",
                f"LangGraph（本进程）：`{self._langgraph_url}`",
                f"Gateway（本进程 channels 回调）：`{self._gateway_url}`",
                (
                    "与仓库其它位置一致：**`EVOFLOW_LANGGRAPH_URL`**（全站默认）、"
                    "**`EVOFLOW_CHANNELS_LANGGRAPH_URL`**（IM）；**`EVOFLOW_GATEWAY_URL`** / "
                    "**`EVOFLOW_CHANNELS_GATEWAY_URL`**（Gateway 基址，对应 **`EVOFLOW_GATEWAY_PORT`** / "
                    "`dev-stack-isolated.bat`）。"
                ),
                "",
                "在 **会话调试** 中按 `thread_id` 查看 **`im_channel_errors`**（SQLite observability）。",
                "若失败发生在**创建会话之前**（尚无 thread），JSON 中含 `chat_id` 便于对照。",
            ]
        )
        low = em.lower()
        if "claude" in low or "claude_code" in low or "claude-agent-sdk" in low:
            lines.extend(
                [
                    "",
                    "与 **Claude Code** 相关时：确认 `langgraph.json` 已注册 **`claude_code_chat`**，且运行 LangGraph 的 venv 已 **`uv sync`** 安装 **`claude-agent-sdk`**。",
                ]
            )
        extra = (os.getenv("EVOFLOW_IM_ERROR_DETAIL") or "").strip().lower() in ("1", "true", "yes", "on")
        if extra and exc is not None:
            lines.extend(["", f"（调试）`{type(exc).__name__}: {exc}`"[:600]])
        return "\n".join(lines)

    async def _handle_message(self, msg: InboundMessage) -> None:
        chat_lock = self._chat_locks.setdefault(self._chat_lock_key(msg), asyncio.Lock())
        async with chat_lock:
            try:
                async with self._semaphore:
                    if msg.channel_name == "feishu" and str(msg.chat_id or "").strip():
                        try:
                            from app.channels.feishu_automation_learned_chat import remember_feishu_automation_chat_from_inbound

                            meta = msg.metadata if isinstance(msg.metadata, dict) else {}
                            remember_feishu_automation_chat_from_inbound(
                                msg.chat_id,
                                str(meta.get("account_id") or "").strip(),
                            )
                        except Exception:
                            logger.debug("[Manager] feishu automation learn chat_id skipped", exc_info=True)
                    try:
                        if msg.msg_type == InboundMessageType.COMMAND:
                            await self._handle_command(msg)
                        else:
                            await self._handle_chat(msg)
                    except InvalidChannelSessionConfigError as exc:
                        logger.warning(
                            "Invalid channel session config for %s (chat=%s): %s",
                            msg.channel_name,
                            msg.chat_id,
                            exc,
                        )
                        vis = str(exc)
                        self._record_im_channel_failure(msg, message=vis, user_visible=vis)
                        if msg.channel_name in IM_CHANNEL_NAMES:
                            await self._send_error(msg, self._im_rich_error_body(msg, fallback=vis))
                        else:
                            await self._send_error(msg, vis)
                    except Exception as exc:
                        logger.exception(
                            "Error handling message from %s (chat=%s) thread_id=%s",
                            msg.channel_name,
                            msg.chat_id,
                            self._resolve_stored_thread_id(msg) or "(none)",
                        )
                        self._record_im_channel_failure(
                            msg,
                            exc=exc,
                            user_visible=self._im_rich_error_body(msg, exc=exc) if msg.channel_name in IM_CHANNEL_NAMES else str(exc),
                        )
                        if msg.channel_name in IM_CHANNEL_NAMES:
                            await self._send_error(msg, self._im_rich_error_body(msg, exc=exc))
                        else:
                            hint = "若刚发送过 **/claude** 切换 Claude Code：请确认 LangGraph Server 已部署 ``claude_code_chat`` 图，且运行该图的 Python 环境已安装 ``claude-agent-sdk``；并查看服务端日志中本条上方的异常栈。"
                            detail = ""
                            if (os.getenv("EVOFLOW_IM_ERROR_DETAIL") or "").strip().lower() in ("1", "true", "yes", "on"):
                                detail = "\n（调试：" + f"{type(exc).__name__}: {exc}"[:400] + "）"
                            await self._send_error(msg, "处理失败，请稍后重试。\n" + hint + detail)
            finally:
                # Channel-owned temp files (WeCom caches inbound media so the
                # multimodal LLM can read it).  Releasing in ``finally`` keeps
                # cleanup deterministic even on the error paths above.
                try:
                    _release_channel_owned_paths(msg)
                except Exception:
                    logger.debug("[Manager] _release_channel_owned_paths failed", exc_info=True)

    # -- chat handling -----------------------------------------------------

    async def _resolve_session_key_for_thread(self, client, thread_id: str, msg: InboundMessage) -> str:
        expected = self._channel_thread_session_key(msg)
        try:
            thread = await client.threads.get(thread_id)
            meta = thread.get("metadata", {}) if isinstance(thread, dict) else {}
            if isinstance(meta, dict):
                sk = meta.get("session_key") or meta.get("sessionKey")
                if sk and str(sk).strip():
                    existing = str(sk).strip()
                    if existing == expected:
                        return existing
                    # Migrate legacy ``agent:{code}:feishu:…`` employee IM keys into
                    # ``proactive:{code}:chat:feishu:…`` so they leave the 任务 list.
                    if expected.startswith("proactive:") and existing.startswith("agent:"):
                        exp_code = _agent_code_from_im_session_key(expected)
                        got_code = _agent_code_from_im_session_key(existing)
                        if exp_code and got_code and exp_code == got_code:
                            logger.info(
                                "[Manager] migrate IM session_key to employee group thread=%s %s → %s",
                                thread_id,
                                existing,
                                expected,
                            )
                            with contextlib.suppress(Exception):
                                await client.threads.update(
                                    thread_id,
                                    metadata={**meta, "session_key": expected},
                                )
                            return expected
                    # Never keep another bot's session_key when this inbound is a different account.
                    exp_agent = _agent_code_from_im_session_key(expected)
                    got_agent = _agent_code_from_im_session_key(existing)
                    if exp_agent and got_agent and exp_agent != got_agent:
                        logger.info(
                            "[Manager] session_key agent mismatch (thread=%s existing=%s expected=%s); using expected",
                            thread_id,
                            existing,
                            expected,
                        )
                        return expected
                    return existing
        except Exception:
            logger.debug("[Manager] threads.get metadata failed thread_id=%s", thread_id, exc_info=True)
        return expected

    async def _touch_chat_session_index(
        self,
        client,
        thread_id: str,
        msg: InboundMessage,
        *,
        session_key: str | None = None,
    ) -> None:
        sk = (session_key or "").strip() or await self._resolve_session_key_for_thread(client, thread_id, msg)
        _persist_channel_session_index(sk, thread_id, msg, touch_only=True)

    async def _create_thread(self, client, msg: InboundMessage) -> str:
        """Create a new thread on the LangGraph Server and store the mapping."""
        session_key = self._channel_thread_session_key(msg)
        thread = await client.threads.create(metadata={"session_key": session_key})
        thread_id = thread["thread_id"]
        await self.store.set_thread_id(
            msg.channel_name,
            msg.chat_id,
            thread_id,
            topic_id=self._channel_store_topic(msg),
            user_id=msg.user_id,
        )
        _persist_channel_session_index(session_key, thread_id, msg)
        logger.info(
            "[Manager] new thread created on LangGraph Server: thread_id=%s for chat_id=%s store_topic=%s account=%s",
            thread_id,
            msg.chat_id,
            self._channel_store_topic(msg),
            self._inbound_account_id(msg) or "primary",
        )
        return thread_id

    async def _handle_chat(self, msg: InboundMessage, extra_context: dict[str, Any] | None = None) -> None:
        client = self._get_client()

        # 设置飞书流式桥接器上下文（用于子任务输出）
        if msg.channel_name == "feishu":
            try:
                from app.channels.feishu_stream_bridge import get_feishu_stream_bridge

                bridge = get_feishu_stream_bridge()
                if bridge:
                    bridge.set_context(
                        chat_id=msg.chat_id,
                        thread_ts=msg.thread_ts,
                    )
            except Exception:
                logger.debug("[Manager] failed to set feishu bridge context", exc_info=True)

        # Look up existing EvoFlow thread (Feishu: isolated per bot account_id).
        thread_id = self._lookup_bound_thread_id(msg) or None
        if thread_id:
            logger.info(
                "[Manager] reusing thread: thread_id=%s for topic_id=%s account=%s",
                thread_id,
                msg.topic_id,
                self._inbound_account_id(msg) or "primary",
            )

        if thread_id is None:
            thread_id = await self._create_thread(client, msg)
        else:
            await self._touch_chat_session_index(client, thread_id, msg)

        from app.channels.channel_io_log import log_channel_inbound_bound

        log_channel_inbound_bound(msg, thread_id)

        assistant_id, run_config, run_context = self._resolve_run_params(msg, thread_id)
        if extra_context:
            run_context.update(extra_context)
        run_config, run_context = _langgraph_merge_configurable_into_context(run_config, run_context)
        session_key = await self._resolve_session_key_for_thread(client, thread_id, msg)
        # Refresh weak legacy titles (「飞书 · oc_…」) with 岗位/主对话.
        try:
            agent_code = _agent_code_from_im_session_key(session_key)
            pretty = _default_channel_session_title(msg, agent_name=agent_code)
            from evoflow.persistence import session_repositories as sess_repo

            existing = (sess_repo.load_session_map().get(session_key) or {}) if session_key else {}
            old_title = str(existing.get("title") or "").strip()
            weak = (not old_title) or (
                old_title.startswith(("飞书 · ", "微信 · ", "Slack · ", "Telegram · ")) and ("主对话" not in old_title and "小V" not in old_title and "（" not in old_title) and len([p for p in old_title.split("·")]) <= 3
            )
            if weak and pretty and pretty != old_title:
                _persist_channel_session_index(session_key, thread_id, msg, title=pretty)
        except Exception:
            logger.debug("[Manager] refresh weak IM session title skipped", exc_info=True)
        channel_run_id = _persist_channel_user_transcript_turn(
            session_key,
            thread_id,
            msg.text or "",
            files=list(msg.files or []),
        )
        _enrich_channel_run_context(run_context, session_key, msg, channel_run_id)
        send_shortcut_hint = msg.channel_name in IM_CHANNEL_NAMES and not self._im_shortcut_hint_sent(msg) and not _im_should_omit_shortcut_hint(run_context, msg)
        if self._channel_supports_streaming(msg.channel_name):
            await self._handle_streaming_chat(
                client,
                msg,
                thread_id,
                assistant_id,
                run_config,
                run_context,
                send_shortcut_hint=send_shortcut_hint,
                session_key=session_key,
            )
            return

        logger.info(
            "[Manager] invoking runs.wait(thread_id=%s)\n--- user ---\n%s\n---",
            thread_id,
            (msg.text or "").strip() or "(empty)",
        )
        result: dict[str, Any] | list | None = None
        human_input = _build_human_input(msg, run_context, run_config)
        for attempt in range(3):
            try:
                result = await client.runs.wait(
                    thread_id,
                    assistant_id,
                    input=human_input,
                    config=run_config,
                    context=run_context,
                    multitask_strategy="reject",
                )
                break
            except Exception as exc:
                if _is_thread_or_assistant_not_found_error(exc) and attempt == 0:
                    logger.warning(
                        "[Manager] runs.wait got not-found, recreating thread and retrying once: old_thread_id=%s",
                        thread_id,
                    )
                    thread_id = await self._create_thread(client, msg)
                    assistant_id, run_config, run_context = self._resolve_run_params(msg, thread_id)
                    if extra_context:
                        run_context.update(extra_context)
                    run_config, run_context = _langgraph_merge_configurable_into_context(run_config, run_context)
                    continue
                if _is_thread_busy_error(exc) and attempt < 2:
                    n = await self._cancel_pending_runs_on_thread(client, thread_id)
                    logger.warning(
                        "[Manager] runs.wait thread busy — cancelled %d stale run(s), retrying: thread_id=%s attempt=%d",
                        n,
                        thread_id,
                        attempt + 1,
                    )
                    await asyncio.sleep(0.35)
                    continue
                raise

        print(f"[Manager] result_raw channel={msg.channel_name} chat_id={msg.chat_id} type={type(result).__name__} keys={list(result.keys()) if isinstance(result, dict) else type(result)} messages={len(result.get('messages', []))} ui_messages={len(result.get('ui_messages', []))} artifacts={len(result.get('artifacts', []))}", file=sys.stderr, flush=True)
        print(f"[Manager] RESULT: {str(result)[:2000]}", file=sys.stderr, flush=True)
        _mgr_diag("result_raw", channel=msg.channel_name, chat_id=msg.chat_id, has_result=result is not None, result_type=type(result).__name__, result_keys=list(result.keys()) if isinstance(result, dict) else (len(result) if isinstance(result, list) else "scalar"), messages_count=len(result.get("messages", []) if isinstance(result, dict) else []), ui_messages_count=len(result.get("ui_messages", []) if isinstance(result, dict) else []), artifacts_count=len(result.get("artifacts", []) if isinstance(result, dict) else []), result_summary=str(result)[:500] if result else "None")

        # Decide whether the run actually produced usable output for *this* turn.
        # Originally we only checked ``result["messages"]`` and ``result["ui_messages"]``
        # lengths, but LangGraph ``runs.wait`` in a cold-start race (or a run that returned
        # mid-tool) often yields a result dict whose ``messages`` list only carries the
        # inbound ``human`` turn — there is no assistant message yet, yet
        # ``_extract_response_text`` may still find a usable string in a tool result or a
        # custom payload attached to the state.  Trust the extractor instead of guessing.
        # If nothing renderable comes out, treat this as "no output" and let fallback 3
        # surface the warmup-race notice so the user knows to retry.
        _initial_response_text = _extract_response_text(result) if isinstance(result, (dict, list)) else ""
        _run_produced_nothing = (
            (result is None)
            or not isinstance(result, (dict, list))
            or not (str(_initial_response_text or "").strip())
        )

        # Fallback: if messages is empty, try to get the latest checkpoint state from the thread.
        # This handles the case where CheckpointTranscriptSlimMiddleware cleared messages but
        # ui_messages survived (or messages were never checkpointed for this channel).
        response_text = _extract_response_text(result)
        if not response_text and isinstance(result, dict):
            # Fallback 1: thread state (ui_messages may survive checkpoint slim).
            # NOTE: ``client.threads.get`` returns thread metadata only (thread_id,
            # created_at, …) — it has no ``values`` field.  We need
            # ``client.threads.get_state`` to read the latest checkpoint's state
            # snapshot, which is where ``ui_messages`` lives after the run completes.
            try:
                thread_state = await client.threads.get_state(thread_id)
                values = thread_state.get("values", {}) if isinstance(thread_state, dict) else {}
                ui_from_thread = values.get("ui_messages", [])
                print(f"[Manager] fallback 1: ui_messages from thread state: count={len(ui_from_thread) if isinstance(ui_from_thread, list) else 'n/a'}", file=sys.stderr, flush=True)
                if isinstance(ui_from_thread, list):
                    for m in reversed(ui_from_thread):
                        if not isinstance(m, dict):
                            continue
                        role = str(m.get("role") or m.get("type") or "").strip().lower()
                        if role in ("human", "user", "tool", "function"):
                            break
                        if role in ("ai", "assistant", ""):
                            content = m.get("content", "")
                            if isinstance(content, str) and content.strip():
                                response_text = content
                                print(f"[Manager] fallback 1 FOUND text from ui_messages: {repr(content[:100])}", file=sys.stderr, flush=True)
                                break
                            if isinstance(content, list):
                                for block in content:
                                    if isinstance(block, dict) and block.get("type") == "text":
                                        text = block.get("text", "")
                                        if isinstance(text, str) and text.strip():
                                            response_text = text
                                            print(f"[Manager] fallback 1 FOUND text from ui_messages block: {repr(text[:100])}", file=sys.stderr, flush=True)
                                            break
                                if response_text:
                                    break
            except Exception as exc:
                print(f"[Manager] fallback 1 (thread state) failed: {exc}", file=sys.stderr, flush=True)

            # Fallback 2: query DB for latest AI message (SSOT written by TranscriptMiddleware).
            # We always run this when fallback 1 produced nothing — evoflow_chat_messages
            # is the SSOT for assistant text (CheckpointTranscriptSlimMiddleware has stripped
            # ``messages`` / ``ui_messages`` from the checkpoint), so this is the most
            # reliable place to find the AI reply for *this* turn.  By design the row
            # was appended before ``runs.wait`` returned, so the newest row belongs to
            # this turn — we don't need to compare against the inbound to "guess" the
            # boundary.  The previous version guarded against stale text by skipping this
            # branch whenever the run produced nothing, but that guard was wrong: when
            # checkpoint slim cleared both ``messages`` and ``ui_messages``, fallback 2
            # was unreachable, leaving fallback 3 to send the "engine warmup" notice.
            if not response_text:
                try:
                    from evoflow.persistence import chat_session_service as chat_svc

                    sk = str(session_key or "").strip()
                    if sk:
                        # Run in thread pool to avoid blocking the async loop
                        import asyncio
                        rows = await asyncio.get_event_loop().run_in_executor(
                            None,
                            lambda: _query_latest_ai_message_from_db(sk),
                        )
                        if rows:
                            response_text = rows[0]
                            print(f"[Manager] fallback 2 FOUND text from DB: {repr(response_text[:100])}", file=sys.stderr, flush=True)
                        else:
                            print(f"[Manager] fallback 2: no AI rows in DB for session_key={sk}", file=sys.stderr, flush=True)
                except Exception as exc2:
                    print(f"[Manager] fallback 2 (DB query) failed: {exc2}", file=sys.stderr, flush=True)
            elif not response_text and _run_produced_nothing:
                # Diagnostic only — this branch should be unreachable now that fallback 2
                # always runs above.  Kept for one release so we notice if any caller
                # relies on the old skip behaviour.
                print(
                    f"[Manager] fallback 2 SKIPPED: run produced nothing this turn "
                    f"(should be unreachable after SSOT fix). channel={msg.channel_name} chat_id={msg.chat_id}",
                    file=sys.stderr, flush=True,
                )

        # ── fallback 3: engine produced nothing this turn AND DB has no
        # historical AI message for this session. Most often this is the
        # LangGraph cold-start race ("Agent 引擎仍在加载") where the run
        # returned empty. Do not silently surface stale text from a
        # different session — tell the user the truth and bail out so the
        # next message can actually be answered once the engine is warm.
        if not response_text and _run_produced_nothing and not getattr(msg, "_fallback_engine_busy_logged", False):
            # Surface the exact reason in stderr so we can distinguish
            # cold-start race vs broken extraction in production logs.
            print(
                f"[Manager] fallback 3 firing channel={msg.channel_name} chat_id={msg.chat_id} "
                f"thread_id={thread_id} | result_type={type(result).__name__} "
                f"result_keys={list(result.keys()) if isinstance(result, dict) else 'n/a'} "
                f"messages={len(result.get('messages') or []) if isinstance(result, dict) else 'n/a'} "
                f"ui_messages={len(result.get('ui_messages') or []) if isinstance(result, dict) else 'n/a'}",
                file=sys.stderr, flush=True,
            )
            logger.warning(
                "[Manager] no AI output produced channel=%s chat_id=%s thread_id=%s — "
                "likely LangGraph engine warmup race; not falling back to stale text",
                msg.channel_name, msg.chat_id, thread_id,
            )
            try:
                await self.bus.publish_outbound(OutboundMessage(
                    channel_name=msg.channel_name,
                    chat_id=msg.chat_id,
                    thread_id=thread_id or "",
                    text="⚠️ 智能体引擎还在加载中，没能产出本轮回复。请稍后再发一条消息，或在右侧对话面板里直接发一次 —— 引擎 warmup 之后会正常工作。",
                    is_final=True,
                    thread_ts=msg.thread_ts or None,
                    # Echo account_id back to the bus so the reply lands on
                    # the same channel instance that received the inbound.
                    account_id=self._inbound_account_id(msg),
                ))
                setattr(msg, "_fallback_engine_busy_logged", True)
            except Exception:
                logger.debug("[Manager] fallback 3 outbound publish failed", exc_info=True)
            # fallback 3 already published an explanatory message — do NOT
            # fall through to the generic "(No response from agent)" branch
            # below, which would send a second, confusing message to the user.
            return
        response_text = response_text or ""
        artifacts = _extract_artifacts(result, response_text=response_text or "")
        _mgr_diag("agent_response", channel=msg.channel_name, chat_id=msg.chat_id, text_len=len(response_text or ""), preview=(response_text or "")[:300])

        # Print to stderr so it shows up in the terminal even when EVOFLOW_LOGS_DIR is set
        print(
            f"[Manager] agent_response channel={msg.channel_name} chat_id={msg.chat_id} "
            f"thread_id={thread_id} text_len={len(response_text or '')} "
            f"artifacts={len(artifacts)} | text={repr((response_text or '').strip()[:200])}",
            file=sys.stderr, flush=True
        )

        response_text, attachments = _prepare_artifact_delivery(thread_id, response_text, artifacts)

        if not response_text:
            if attachments:
                response_text = _format_artifact_text([a.virtual_path for a in attachments])
            else:
                response_text = "(No response from agent)"

        if send_shortcut_hint:
            response_text = await self._append_im_shortcut_hint(msg, response_text)

        outbound = OutboundMessage(
            channel_name=msg.channel_name,
            chat_id=msg.chat_id,
            thread_id=thread_id,
            text=response_text,
            artifacts=artifacts,
            attachments=attachments,
            thread_ts=msg.thread_ts,
            topic_id=msg.topic_id,
            metadata=self._outbound_metadata_from_inbound(msg),
            # Echo account_id back to the bus so the reply lands on the
            # same channel instance that received the inbound.
            account_id=self._inbound_account_id(msg),
        )
        if self.bus is None:
            _mgr_diag("publish_skipped_no_bus", channel=msg.channel_name, chat_id=msg.chat_id)
            print(f"[Manager] ERROR self.bus is None — cannot publish outbound channel={msg.channel_name} chat_id={msg.chat_id}", file=sys.stderr, flush=True)
            return
        _mgr_diag("publish_outbound_call", channel=msg.channel_name, chat_id=msg.chat_id, text_len=len(outbound.text or ""), preview=(outbound.text or "")[:300])
        print(f"[Manager] publish_outbound channel={msg.channel_name} chat_id={msg.chat_id} text_len={len(outbound.text or '')}", file=sys.stderr, flush=True)
        try:
            await self.bus.publish_outbound(outbound)
            _mgr_diag("publish_outbound_done", channel=msg.channel_name, chat_id=msg.chat_id, ok=True)
            print(f"[Manager] publish_outbound DONE channel={msg.channel_name} chat_id={msg.chat_id}", file=sys.stderr, flush=True)
        except Exception as exc:
            _mgr_diag("publish_outbound_done", channel=msg.channel_name, chat_id=msg.chat_id, ok=False, error=str(exc))
            print(f"[Manager] publish_outbound ERROR channel={msg.channel_name} chat_id={msg.chat_id} exc={exc}", file=sys.stderr, flush=True)
            raise
        _finalize_channel_transcript_turn(session_key, thread_id)

    async def _handle_streaming_chat(
        self,
        client,
        msg: InboundMessage,
        thread_id: str,
        assistant_id: str,
        run_config: dict[str, Any],
        run_context: dict[str, Any],
        *,
        send_shortcut_hint: bool = False,
        session_key: str = "",
    ) -> None:
        active_thread_id = thread_id
        sk = str(session_key or "").strip()
        routing_key = self._im_routing_key(msg)
        self._active_im_runs[routing_key] = {
            "thread_id": active_thread_id,
            "preview": "",
            "cancelled": False,
        }
        logger.info(
            "[Manager] invoking runs.stream(thread_id=%s)\n--- user ---\n%s\n---",
            active_thread_id,
            (msg.text or "").strip() or "(empty)",
        )

        last_values: dict[str, Any] | list | None = None
        latest_text = ""
        last_published_text = ""
        last_publish_at = 0.0
        stream_error: BaseException | None = None
        stream_publish_count = 0
        stream_skip_same_count = 0
        stream_skip_throttle_count = 0
        event_counts: dict[str, int] = {}
        stream_params = _channel_stream_params(self._langgraph_url)

        # Allow more retries for startup-gate errors (max 3 attempts when startup issues detected)
        for attempt in range(3):
            streamed_buffers: dict[str, str] = {}
            current_message_id: str | None = None
            custom_text = ""
            evf_state: dict[str, str] = {}
            saw_streaming_token_source = False
            saw_messages_stream = False
            if attempt > 0:
                last_values = None
                latest_text = ""
                last_published_text = ""
                last_publish_at = 0.0
                stream_error = None
                custom_text = ""
            try:
                human_input = _build_human_input(msg, run_context, run_config)
                if human_input["messages"][0].get("additional_kwargs", {}).get("context_files"):
                    logger.info(
                        "[Manager] context_files injected into run: %s",
                        human_input["messages"][0]["additional_kwargs"]["context_files"],
                    )
                async for chunk in client.runs.stream(
                    active_thread_id,
                    assistant_id,
                    input=human_input,
                    config=run_config,
                    context=run_context,
                    stream_mode=["messages-tuple", "values", "custom"],
                    multitask_strategy="reject",
                    params=stream_params,
                ):
                    event = getattr(chunk, "event", "")
                    data = getattr(chunk, "data", None)
                    if event:
                        event_counts[event] = event_counts.get(event, 0) + 1

                    if event in ("messages-tuple", "messages"):
                        accumulated_text, current_message_id = _accumulate_stream_text(streamed_buffers, current_message_id, data)
                        if accumulated_text:
                            # IM: show the whole turn (all assistant segments), not only
                            # the newest message-id buffer — avoids card wipe after tools.
                            if msg.channel_name in IM_CHANNEL_NAMES and len(streamed_buffers) > 1:
                                latest_text = _join_im_stream_buffers(streamed_buffers) or accumulated_text
                            else:
                                latest_text = accumulated_text
                            saw_streaming_token_source = True
                            saw_messages_stream = True
                            logger.debug(
                                "[Manager] stream chunk: event=%s, text_len=%d, last_published_len=%d",
                                event,
                                len(latest_text),
                                len(last_published_text),
                            )
                    elif event == "values" and isinstance(data, (dict, list)):
                        last_values = data
                        msgs = data.get("messages", []) if isinstance(data, dict) else (data if isinstance(data, list) else [])
                        tail_human = _last_human_text_from_messages(msgs if isinstance(msgs, list) else [])
                        inbound_turn = (msg.text or "").strip()
                        snapshot_in_sync = not inbound_turn or tail_human == inbound_turn
                        # ``values`` often lags one beat: snapshot may still be the previous turn, while
                        # ``custom`` / ``messages-tuple`` already stream the current reply (Claude Code path).
                        if saw_streaming_token_source:
                            pass
                        elif snapshot_in_sync:
                            snapshot_text = _extract_response_text(data)
                            if snapshot_text:
                                latest_text = snapshot_text
                    elif event == "custom":
                        # Custom deltas help adapters without messages-tuple tokens. Once live
                        # assistant chunks exist, only accept custom text that is a compatible
                        # extension/replacement — never let unrelated longer ``content`` win.
                        delta = _extract_custom_stream_text(_unwrap_custom_stream_payload(data))
                        if delta:
                            custom_text = _merge_stream_text(custom_text, delta)
                            compatible = not latest_text or custom_text == latest_text or custom_text.startswith(latest_text) or latest_text.startswith(custom_text)
                            if not saw_messages_stream:
                                saw_streaming_token_source = True
                                latest_text = custom_text
                            elif compatible and len(custom_text) >= len(latest_text):
                                latest_text = custom_text
                    elif event == "evf":
                        accumulated = _accumulate_evf_stream_text(evf_state, data)
                        if accumulated:
                            saw_streaming_token_source = True
                            latest_text = accumulated
                            logger.debug(
                                "[Manager] evf stream chunk: text_len=%d",
                                len(latest_text),
                            )

                    if not latest_text or latest_text == last_published_text:
                        if latest_text == last_published_text and latest_text:
                            stream_skip_same_count += 1
                        continue

                    # Feishu/WeCom cards: never publish a mid-stream wipe that replaces
                    # a long reply with a brand-new short assistant message ("这是一" /
                    # "![") — keep the previous card until the new segment catches up
                    # via joined buffers or the final outbound.
                    if msg.channel_name in IM_CHANNEL_NAMES and _should_skip_im_stream_regression(
                        last_published_text, latest_text
                    ):
                        stream_skip_same_count += 1
                        continue

                    # Feishu default: no live card patches — only accumulate text for
                    # the final outbound. Avoids half-frozen「这是一张充满…」cards.
                    if msg.channel_name == "feishu" and not FEISHU_LIVE_STREAM_PATCHES:
                        tracked = self._active_im_runs.get(routing_key)
                        if isinstance(tracked, dict):
                            tracked["preview"] = latest_text[:800]
                            tracked["thread_id"] = active_thread_id
                            if tracked.get("cancelled"):
                                logger.info(
                                    "[Manager] stream stop requested mid-flight: thread_id=%s",
                                    active_thread_id,
                                )
                                break
                        continue

                    if (
                        msg.channel_name == "feishu"
                        and not last_published_text
                        and len(latest_text.strip()) < FEISHU_STREAM_MIN_PUBLISH_CHARS
                    ):
                        stream_skip_same_count += 1
                        continue

                    now = time.monotonic()
                    min_interval = FEISHU_STREAM_UPDATE_MIN_INTERVAL_SECONDS if msg.channel_name == "feishu" else STREAM_UPDATE_MIN_INTERVAL_SECONDS
                    if last_published_text and now - last_publish_at < min_interval:
                        stream_skip_throttle_count += 1
                        continue

                    logger.debug(
                        "[Manager] publishing stream update: channel=%s, thread_id=%s, text_len=%d, prev_len=%d, min_interval=%.2fs, is_final=False",
                        msg.channel_name,
                        active_thread_id,
                        len(latest_text),
                        len(last_published_text),
                        min_interval,
                    )
                    await self.bus.publish_outbound(
                        OutboundMessage(
                            channel_name=msg.channel_name,
                            chat_id=msg.chat_id,
                            thread_id=active_thread_id,
                            text=latest_text,
                            is_final=False,
                            thread_ts=msg.thread_ts,
                            topic_id=msg.topic_id,
                            metadata=self._im_run_control_meta(msg, active_thread_id),
                            account_id=self._inbound_account_id(msg),
                        )
                    )
                    last_published_text = latest_text
                    last_publish_at = now
                    stream_publish_count += 1
                    tracked = self._active_im_runs.get(routing_key)
                    if isinstance(tracked, dict):
                        tracked["preview"] = latest_text[:800]
                        tracked["thread_id"] = active_thread_id
                        if tracked.get("cancelled"):
                            logger.info(
                                "[Manager] stream stop requested mid-flight: thread_id=%s",
                                active_thread_id,
                            )
                            break
                break
            except Exception as exc:
                stream_error = exc
                if _is_thread_or_assistant_not_found_error(exc) and attempt == 0:
                    logger.warning(
                        "[Manager] stream got not-found, recreating thread and retrying once: old_thread_id=%s",
                        active_thread_id,
                    )
                    active_thread_id = await self._create_thread(client, msg)
                    continue
                # Retry transient startup-gate errors (e.g., router registration in progress)
                # with exponential backoff: 0.5s, 1.0s, 2.0s
                if _is_startup_gate_error(exc) and attempt < 2:
                    delay_sec = 0.5 * (2 ** attempt)  # 0.5s, 1.0s
                    logger.warning(
                        "[Manager] stream got startup-gate error, retrying in %.1fs: thread_id=%s attempt=%d/%d error=%s",
                        delay_sec,
                        active_thread_id,
                        attempt + 1,
                        2,
                        str(exc)[:100],
                    )
                    await asyncio.sleep(delay_sec)
                    continue
                if _is_transient_stream_error(exc) and attempt < 2:
                    delay_sec = 0.6 * (2 ** attempt)
                    logger.warning(
                        "[Manager] stream transient error, retrying in %.1fs: thread_id=%s attempt=%d/%d error=%s",
                        delay_sec,
                        active_thread_id,
                        attempt + 1,
                        2,
                        str(exc)[:160],
                    )
                    await asyncio.sleep(delay_sec)
                    continue
                if _is_thread_busy_error(exc):
                    # Stale / overlapping LangGraph run still marked running —
                    # cancel it and retry so IM users are not stuck on
                    # 「请稍候再发」 after a previous turn hung or raced.
                    if attempt < 2:
                        n = await self._cancel_pending_runs_on_thread(client, active_thread_id)
                        logger.warning(
                            "[Manager] thread busy — cancelled %d stale run(s), retrying: thread_id=%s attempt=%d",
                            n,
                            active_thread_id,
                            attempt + 1,
                        )
                        await asyncio.sleep(0.35)
                        continue
                    logger.warning(
                        "[Manager] thread busy after cancel+retry: thread_id=%s",
                        active_thread_id,
                    )
                else:
                    logger.exception("[Manager] streaming error: thread_id=%s", active_thread_id)
                break

        result = last_values if last_values is not None else {"messages": [{"type": "ai", "content": latest_text}]}
        inbound_turn = (msg.text or "").strip()
        msgs_for_sync = result.get("messages", []) if isinstance(result, dict) else (result if isinstance(result, list) else [])
        tail_human = _last_human_text_from_messages(msgs_for_sync if isinstance(msgs_for_sync, list) else [])
        values_synced = not inbound_turn or tail_human == inbound_turn

        if values_synced:
            response_text = _extract_response_text(result)
            artifacts = _extract_artifacts(result, response_text=response_text or "")
        else:
            # Rejected/failed run often leaves checkpoint on the *previous* turn —
            # never resend that AI text as the reply to the new user message.
            response_text = (latest_text or "").strip()
            artifacts = []
            logger.warning(
                "[Manager] stream values out of sync with inbound (skip stale AI): thread_id=%s inbound_len=%d tail_human_len=%d error=%s",
                active_thread_id,
                len(inbound_turn),
                len(tail_human or ""),
                stream_error,
            )
        # IM final bubble: prefer the *latest* assistant buffer only.
        # Joining every mid-tool status line produced a progress-log dump on Feishu
        # (download… / 抽帧… / 等视觉理解… glued onto the real answer).
        if msg.channel_name in IM_CHANNEL_NAMES and streamed_buffers:
            latest_buf = _latest_im_stream_buffer(streamed_buffers)
            if latest_buf and (
                not str(response_text or "").strip()
                or len(latest_buf) >= len(str(response_text or "").strip())
            ):
                response_text = latest_buf
                if not artifacts:
                    artifacts = _extract_artifacts(result, response_text=response_text)
        response_text, attachments = _prepare_artifact_delivery(active_thread_id, response_text, artifacts)

        tracked_end = self._active_im_runs.pop(routing_key, None) or {}
        was_cancelled = bool(tracked_end.get("cancelled"))

        if was_cancelled:
            preview = str(tracked_end.get("preview") or latest_text or "").strip()
            response_text = "⏹ 已停止生成"
            if preview:
                response_text += f"\n\n（已生成部分）\n{preview[:1500]}"
            attachments = []
            artifacts = []
        elif stream_error:
            if _is_thread_busy_error(stream_error):
                response_text = THREAD_BUSY_MESSAGE
            elif _is_startup_gate_error(stream_error):
                response_text = "🔄 服务正在启动，请稍后重试。"
            elif not (response_text or "").strip():
                partial = (latest_text or "").strip()
                if msg.channel_name in IM_CHANNEL_NAMES:
                    response_text = partial or self._im_rich_error_body(msg, exc=stream_error)
                else:
                    response_text = partial or "处理请求时出错，请稍后重试。"
            # Previously stream failures were swallowed with a generic Feishu line
            # and never landed in im_channel_errors — un-debuggable in Session Debug.
            self._record_im_channel_failure(
                msg,
                exc=stream_error,
                user_visible=(response_text or "")[:1200],
            )
            attachments = []
            artifacts = []
        elif not response_text:
            if attachments:
                response_text = _format_artifact_text([attachment.virtual_path for attachment in attachments])
            else:
                response_text = latest_text or "(No response from agent)"

        sid_out = _extract_claude_session_id_from_graph_values(last_values if isinstance(last_values, dict) else None)
        if assistant_id == CLAUDE_CODE_CHAT_ASSISTANT_ID:
            self._im_claude_seed_session_id.pop(self._im_routing_key(msg), None)

        if sid_out and not was_cancelled:
            prev_row = self.store.get_entry(msg.channel_name, msg.chat_id, topic_id=self._channel_store_topic(msg))
            if not prev_row and msg.channel_name == "feishu" and not self._inbound_account_id(msg):
                prev_row = self.store.get_entry(msg.channel_name, msg.chat_id, topic_id=None)
            prev_sid = (prev_row or {}).get("last_claude_session_id")
            prev_sid = prev_sid.strip() if isinstance(prev_sid, str) else None
            await self.store.merge_thread_meta(
                msg.channel_name,
                msg.chat_id,
                {"last_claude_session_id": sid_out},
                topic_id=self._channel_store_topic(msg),
            )
            if msg.channel_name == "feishu" and sid_out != prev_sid and not _im_is_group_chat(msg):
                response_text = (response_text or "") + (f"\n\n---\n**Claude 会话 ID**：`{sid_out}`\n续用请发：**`/claude {sid_out}`**（同话题续接该 Claude Code 会话）。")

        if send_shortcut_hint and stream_error is None and not was_cancelled:
            response_text = await self._append_im_shortcut_hint(msg, response_text)

        logger.info(
            "[Manager] streaming response completed: channel=%s, thread_id=%s, artifacts=%d, error=%s, cancelled=%s, publish_count=%d, skip_same=%d, skip_throttle=%d\n--- assistant ---\n%s\n---",
            msg.channel_name,
            active_thread_id,
            len(artifacts),
            stream_error,
            was_cancelled,
            stream_publish_count,
            stream_skip_same_count,
            stream_skip_throttle_count,
            (response_text or "").strip() or "(empty)",
        )
        logger.info(
            "[Manager] stream event counts: channel=%s, thread_id=%s, counts=%s",
            msg.channel_name,
            active_thread_id,
            event_counts,
        )
        await self.bus.publish_outbound(
            OutboundMessage(
                channel_name=msg.channel_name,
                chat_id=msg.chat_id,
                thread_id=active_thread_id,
                text=response_text,
                artifacts=artifacts,
                attachments=attachments,
                is_final=True,
                thread_ts=msg.thread_ts,
                topic_id=msg.topic_id,
                metadata=self._outbound_metadata_from_inbound(msg),
                account_id=self._inbound_account_id(msg),
            )
        )
        _finalize_channel_transcript_turn(sk, active_thread_id)

    # -- command handling --------------------------------------------------

    def _goal_channel_type(self, channel_name: str) -> GoalChannelType:
        from app.channels.models.goal import GoalChannelType

        mapping = {
            "feishu": GoalChannelType.FEISHU,
            "slack": GoalChannelType.SLACK,
            "telegram": GoalChannelType.TELEGRAM,
        }
        return mapping.get(str(channel_name or "").strip(), GoalChannelType.WEB)

    async def _handle_im_goal_command(self, msg: InboundMessage, parts: list[str]) -> str:
        from app.channels.models.goal import GoalConfig
        from app.channels.services.goal_service import GoalService

        goal_text = parts[1].strip() if len(parts) > 1 else ""
        if not goal_text:
            return "请提供目标内容，例如：`/goal 每小时检查服务器磁盘占用`"

        session_key = self._channel_thread_session_key(msg)
        channel_type = self._goal_channel_type(msg.channel_name)
        try:
            goal_service = GoalService.get_instance(self._get_client())
            session = await goal_service.start_goal(
                user_id=msg.user_id,
                channel_type=channel_type,
                channel_chat_id=str(msg.chat_id or session_key),
                associated_session_key=session_key,
                config=GoalConfig(prompt=goal_text),
                use_frontend_chat=False,
            )
            preview = goal_text if len(goal_text) <= 120 else f"{goal_text[:117]}…"
            return f"已启动目标任务（ID: `{session.id}`）。\n- 目标：{preview}\n- 会话：{session_key}\n后台将自动执行；发送 `/status` 可查看线程状态。"
        except RuntimeError as e:
            return str(e)
        except Exception:
            logger.exception("IM /goal start failed session_key=%s", session_key)
            return "启动目标失败，请稍后重试或查看服务端日志。"

    async def _handle_command(self, msg: InboundMessage) -> None:
        text = msg.text.strip().strip("\ufeff\u200b\u200c\u200d")
        parts = text.split(maxsplit=1)
        command = parts[0].lower().lstrip("/")

        if command == "bootstrap":
            from dataclasses import replace as _dc_replace

            chat_text = parts[1] if len(parts) > 1 else "Initialize workspace"
            chat_msg = _dc_replace(msg, text=chat_text, msg_type=InboundMessageType.CHAT)
            await self._handle_chat(chat_msg, extra_context={"is_bootstrap": True})
            return

        if command in ("claude", "claude-code"):
            tail = parts[1].strip() if len(parts) > 1 else ""
            seed: str | None = None
            if tail:
                seed = _parse_im_claude_resume_session_id(tail)
                if not seed:
                    bad = "无效的 **Claude 会话 ID**。仅允许字母、数字、下划线、连字符与英文点号，长度 1–160。\n示例：`/claude panel-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`"
                    await self.bus.publish_outbound(
                        OutboundMessage(
                            channel_name=msg.channel_name,
                            chat_id=msg.chat_id,
                            thread_id=self._lookup_bound_thread_id(msg),
                            text=bad,
                            thread_ts=msg.thread_ts,
                            topic_id=msg.topic_id,
                            metadata=self._outbound_metadata_from_inbound(msg),
                            account_id=self._inbound_account_id(msg),
                        )
                    )
                    return
            self._set_claude_code_im_mode(msg, True, seed_session_id=seed)
            resume_line = f"\n\n已指定**续用** Claude 会话：`{seed}`（下一条用户消息将用该 ID 连接）。" if seed else "\n\n首条用户消息建立连接后，会在本条回复末尾附带 **Claude 会话 ID**，也可用 **/status** 查看最近一次 ID。"
            reply = "已启用 **Claude Code** 模式，可与主智能体配合使用。\n- 发送 **/lead** 即可恢复主智能体模式\n- 发送 **/status** 可查询会话状态" + resume_line
        elif command in ("lead", "main"):
            self._set_claude_code_im_mode(msg, False)
            reply = "已恢复 **主智能体** 模式，**复用当前会话**，下一条消息起生效。"
        elif command == "new":
            # New chat session for this IM bot slot: drop mappings for this account (or whole chat
            # for primary), then bind a fresh LangGraph thread.
            client = self._get_client()
            store_topic = self._channel_store_topic(msg)
            if store_topic:
                await self.store.remove(msg.channel_name, msg.chat_id, topic_id=store_topic)
            else:
                await self.store.remove(msg.channel_name, msg.chat_id)
            session_key_base = self._channel_thread_session_key(msg)
            session_key = f"{session_key_base}:fork-{uuid.uuid4().hex[:10]}"
            thread = await client.threads.create(metadata={"session_key": session_key})
            new_thread_id = thread["thread_id"]
            await self.store.set_thread_id(
                msg.channel_name,
                msg.chat_id,
                new_thread_id,
                topic_id=store_topic,
                user_id=msg.user_id,
            )
            _persist_channel_session_index(session_key, new_thread_id, msg)
            reply = _im_new_session_reply(
                msg.channel_name,
                new_thread_id,
                include_shortcut_hint=not _im_should_omit_shortcut_hint(None, msg),
            )
        elif command == "status":
            thread_id = self._lookup_bound_thread_id(msg)
            claude_on = self._claude_code_chat_mode.get(self._im_routing_key(msg), False)
            mode_line = f"模式: {'Claude Code 直连' if claude_on else '主智能体 (lead_agent)'}"
            store_topic = self._channel_store_topic(msg)
            entry = self.store.get_entry(msg.channel_name, msg.chat_id, topic_id=store_topic)
            if not entry and msg.channel_name == "feishu" and not self._inbound_account_id(msg):
                entry = self.store.get_entry(msg.channel_name, msg.chat_id, topic_id=None)
            lsid = (entry or {}).get("last_claude_session_id")
            if isinstance(lsid, str) and lsid.strip():
                mode_line += f"\n上次 Claude 会话: `{lsid.strip()}`"

            # 检查是否有运行中的目标模式任务（侧栏 badge 由 EvoPanel 轮询 /api/goal/by-key）
            reply = f"{mode_line}\n线程: {thread_id}" if thread_id else f"{mode_line}\n尚无绑定线程。发一条消息后会自动创建。"
        elif command == "models":
            reply = await self._fetch_gateway("/api/models", "models")
        elif command == "memory":
            reply = await self._fetch_gateway("/api/memory", "memory")
        elif command in ("goal", "hosted", "hd"):
            reply = await self._handle_im_goal_command(msg, parts)
        elif command == "help":
            reply = "\n".join(_im_shortcut_commands_help_lines(include_bootstrap=True))
        else:
            reply = f"Unknown command: /{command}. Type /help for available commands."

        outbound = OutboundMessage(
            channel_name=msg.channel_name,
            chat_id=msg.chat_id,
            thread_id=self._lookup_bound_thread_id(msg),
            text=reply,
            thread_ts=msg.thread_ts,
            topic_id=msg.topic_id,
            metadata=self._outbound_metadata_from_inbound(msg),
            account_id=self._inbound_account_id(msg),
        )
        await self.bus.publish_outbound(outbound)

    async def _fetch_gateway(self, path: str, kind: str) -> str:
        """Fetch data from the Gateway API for command responses."""
        import httpx

        try:
            async with httpx.AsyncClient() as http:
                resp = await http.get(f"{self._gateway_url}{path}", timeout=10)
                resp.raise_for_status()
                data = resp.json()
        except Exception:
            logger.exception("Failed to fetch %s from gateway", kind)
            return f"Failed to fetch {kind} information."

        if kind == "models":
            names = [m["name"] for m in data.get("models", [])]
            return ("Available models:\n" + "\n".join(f"• {n}" for n in names)) if names else "No models configured."
        elif kind == "memory":
            facts = data.get("facts", [])
            return f"Memory contains {len(facts)} fact(s)."
        return str(data)

    # -- error helper ------------------------------------------------------

    async def _send_error(self, msg: InboundMessage, error_text: str) -> None:
        tid = self._lookup_bound_thread_id(msg)
        outbound = OutboundMessage(
            channel_name=msg.channel_name,
            chat_id=msg.chat_id,
            thread_id=tid or "",
            text=error_text,
            thread_ts=msg.thread_ts,
            topic_id=msg.topic_id,
            metadata=self._outbound_metadata_from_inbound(msg),
            account_id=self._inbound_account_id(msg),
        )
        await self.bus.publish_outbound(outbound)
