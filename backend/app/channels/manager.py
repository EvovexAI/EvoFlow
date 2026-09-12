"""ChannelManager — consumes inbound messages and dispatches them to the EvoFlow agent via LangGraph Server."""

from __future__ import annotations

import asyncio
import logging
import mimetypes
import os
import re
import time
import uuid
from collections.abc import Mapping
from typing import Any

from langgraph_sdk.errors import ConflictError, NotFoundError

from app.channels.feishu_message_format import maybe_format_tool_message_content_for_im
from app.channels.message_bus import InboundMessage, InboundMessageType, MessageBus, OutboundMessage, ResolvedAttachment

from app.channels.store import ChannelStore
from evoflow.runtime.long_run_limits import LONG_RUN_RECURSION_LIMIT

logger = logging.getLogger(__name__)

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
FEISHU_STREAM_UPDATE_MIN_INTERVAL_SECONDS = float(os.getenv("EVOFLOW_FEISHU_STREAM_INTERVAL", "0.2"))
THREAD_BUSY_MESSAGE = "当前会话还有请求在处理中，请稍候再发。"
_IM_SHORTCUT_HINT_META_KEY = "im_shortcut_hint_sent"


def _im_shortcut_commands_help_lines(*, include_bootstrap: bool = False) -> list[str]:
    lines = [
        "快捷指令",
        "/new   - 开启全新对话（清空上下文）",
        "/claude   - Claude Code 直连",
        "/lead   - 切回主智能体",
        "/goal <目标>   - 直接启动当前会话的目标任务",
        "/status   - 查看当前模式与会话线程",
        "/models   - 查看可用模型",
        "/help   - 查看本说明",
    ]
    if include_bootstrap:
        lines.insert(1, "/bootstrap <提示>   - 初始化工作区（首次配置）")
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
}
IM_CHANNEL_NAMES = frozenset({"feishu", "slack", "telegram", "weixin"})

_CHANNEL_SESSION_TITLE_LABEL: dict[str, str] = {
    "feishu": "飞书",
    "weixin": "微信",
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
    code = (
        str(agent_name or "").strip()
        or str(meta.get("account_id") or "").strip()
        or str(meta.get("agent_code") or "").strip()
    )
    who = _im_agent_who_label(code)
    cid = str(msg.chat_id or "").strip()
    short = cid if len(cid) <= 14 else f"{cid[:12]}…"
    title = f"{label} · {who} · {short}"
    if msg.topic_id:
        tid = str(msg.topic_id).strip()
        tshort = tid if len(tid) <= 10 else f"{tid[:8]}…"
        title += f" · {tshort}"
    return title


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
        agent_code = ""
        if sk.startswith("agent:"):
            parts = sk.split(":")
            if len(parts) >= 2:
                agent_code = str(parts[1] or "").strip()
        if not agent_code:
            agent_code = str(meta.get("account_id") or meta.get("agent_code") or "").strip()
        ctx: dict[str, Any] = {
            "channel": str(msg.channel_name or ""),
            "channel_chat_id": str(msg.chat_id or ""),
        }
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


def _persist_channel_user_transcript_turn(
    session_key: str,
    thread_id: str,
    text: str,
) -> str:
    """Persist IM user message + mark run active (same as EvoPanel ``chatSend``).

    Uses the sync ``append_message_and_touch_session`` path. Do **not** call
    async ``persist_user_message`` without awaiting — that silently drops rows
    and leaves SessionTranscriptHydrationMiddleware on stale history.
    """
    sk = str(session_key or "").strip()
    tid = str(thread_id or "").strip()
    body = str(text or "").strip()
    run_id = str(uuid.uuid4())
    if not sk or not tid:
        return run_id
    try:
        from evoflow.persistence import chat_session_service as chat_svc
        from evoflow.session_execution.lifecycle import start_session_turn

        start_session_turn(session_key=sk, thread_id=tid, run_id=run_id, source="channel")
        if body:
            chat_svc.append_message_and_touch_session(
                sk,
                role="user",
                content=body,
                run_id=run_id,
                thread_id=tid,
            )
        logger.info(
            "[Manager] channel user transcript persisted session_key=%s thread_id=%s run_id=%s text_len=%d",
            sk,
            tid,
            run_id,
            len(body),
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
    body = str(msg.text or "").strip()
    if body:
        run_context.setdefault("evf_user_question", body)
        run_context.setdefault("user_message", body)


class InvalidChannelSessionConfigError(ValueError):
    """Raised when IM channel session overrides contain invalid agent config."""


def _is_thread_busy_error(exc: BaseException | None) -> bool:
    if exc is None:
        return False
    if isinstance(exc, ConflictError):
        return True
    return "already running a task" in str(exc)


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


def _extract_artifacts(result: dict | list) -> list[str]:
    """Extract artifact paths from the last AI response cycle only.

    Collects ``@@outputs/…@@`` / ``@@uploads/…@@`` paths cited in AI reply text
    after the last human message (replaces removed ``present_files`` tool).
    """
    import re

    if isinstance(result, list):
        messages = result
    elif isinstance(result, dict):
        messages = result.get("messages", [])
    else:
        return []

    at_path_re = re.compile(r"@@((?:outputs|uploads)/[^@\n]+?)@@", re.IGNORECASE)

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

    artifacts: list[str] = []
    seen: set[str] = set()
    for msg in reversed(messages):
        if not isinstance(msg, dict):
            continue
        if msg.get("type") == "human":
            break
        if msg.get("type") == "ai":
            text = _text_from_content(msg.get("content"))
            for m in at_path_re.finditer(text):
                path = str(m.group(1) or "").strip().replace("\\", "/")
                if path and path not in seen:
                    seen.add(path)
                    artifacts.append(path)
    return artifacts


def _format_artifact_text(artifacts: list[str]) -> str:
    """Format artifact paths into a human-readable text block listing filenames."""
    import posixpath

    filenames = [posixpath.basename(p) for p in artifacts]
    if len(filenames) == 1:
        return f"Created File: 📎 {filenames[0]}"
    return "Created Files: 📎 " + "、".join(filenames)


_OUTPUTS_VIRTUAL_PREFIX = "/mnt/user-data/outputs/"


def _resolve_attachments(thread_id: str, artifacts: list[str]) -> list[ResolvedAttachment]:
    """Resolve virtual artifact paths to host filesystem paths with metadata.

    Only paths under ``/mnt/user-data/outputs/`` are accepted; any other
    virtual path is rejected with a warning to prevent exfiltrating uploads
    or workspace files via IM channels.

    Skips artifacts that cannot be resolved (missing files, invalid paths)
    and logs warnings for them.
    """
    from evoflow.config.paths import get_paths

    attachments: list[ResolvedAttachment] = []
    paths = get_paths()
    outputs_dir = paths.sandbox_outputs_dir(thread_id).resolve()
    for virtual_path in artifacts:
        # Security: only allow files from the agent outputs directory
        if not virtual_path.startswith(_OUTPUTS_VIRTUAL_PREFIX):
            logger.warning("[Manager] rejected non-outputs artifact path: %s", virtual_path)
            continue
        try:
            actual = paths.resolve_virtual_path(thread_id, virtual_path)
            # Verify the resolved path is actually under the outputs directory
            # (guards against path-traversal even after prefix check)
            try:
                actual.resolve().relative_to(outputs_dir)
            except ValueError:
                logger.warning("[Manager] artifact path escapes outputs dir: %s -> %s", virtual_path, actual)
                continue
            if not actual.is_file():
                logger.warning("[Manager] artifact not found on disk: %s -> %s", virtual_path, actual)
                continue
            mime, _ = mimetypes.guess_type(str(actual))
            mime = mime or "application/octet-stream"
            attachments.append(
                ResolvedAttachment(
                    virtual_path=virtual_path,
                    actual_path=actual,
                    filename=actual.name,
                    mime_type=mime,
                    size=actual.stat().st_size,
                    is_image=mime.startswith("image/"),
                )
            )
        except (ValueError, OSError) as exc:
            logger.warning("[Manager] failed to resolve artifact %s: %s", virtual_path, exc)
    return attachments


def _prepare_artifact_delivery(
    thread_id: str,
    response_text: str,
    artifacts: list[str],
) -> tuple[str, list[ResolvedAttachment]]:
    """Resolve attachments and append filename fallbacks to the text response."""
    attachments: list[ResolvedAttachment] = []
    if not artifacts:
        return response_text, attachments

    attachments = _resolve_attachments(thread_id, artifacts)
    resolved_virtuals = {attachment.virtual_path for attachment in attachments}
    unresolved = [path for path in artifacts if path not in resolved_virtuals]

    if unresolved:
        artifact_text = _format_artifact_text(unresolved)
        response_text = (response_text + "\n\n" + artifact_text) if response_text else artifact_text

    # Always include resolved attachment filenames as a text fallback so files
    # remain discoverable even when the upload is skipped or fails.
    if attachments:
        resolved_text = _format_artifact_text([attachment.virtual_path for attachment in attachments])
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
        max_concurrency: int = 5,
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
            "account_id": str((msg.metadata or {}).get("account_id") or ""),
        }
        return meta

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
            tid = (
                self.store.get_thread_id(channel_name, chat_id, topic_id=topic_id)
                or self.store.get_thread_id(channel_name, chat_id, topic_id=None)
                or ""
            )
        preview = str(tracked.get("preview") or "")[:800]
        if not tid:
            return {"ok": False, "error": "找不到进行中的会话", "cancelled": 0, "preview": preview}

        client = self._get_client()
        cancelled = 0
        try:
            runs = await client.runs.list(thread_id=tid, limit=20)
            for run in runs or []:
                run_id = str(
                    (run.get("run_id") if isinstance(run, dict) else getattr(run, "run_id", None))
                    or (run.get("id") if isinstance(run, dict) else getattr(run, "id", None))
                    or ""
                ).strip()
                status = str(
                    (run.get("status") if isinstance(run, dict) else getattr(run, "status", None)) or ""
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
        except Exception as exc:
            logger.warning("[Manager] list/cancel im runs failed thread=%s: %s", tid, exc)
            return {"ok": False, "error": str(exc)[:120], "cancelled": cancelled, "preview": preview}

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
        # Per-employee Feishu bot: channels.feishu.accounts[<agent_code>].session
        account_id = str((msg.metadata or {}).get("account_id") or "").strip()
        if account_id and msg.channel_name == "feishu":
            acc_session = self._feishu_account_session(account_id)
            if acc_session:
                channel_layer = _merge_dicts(channel_layer, acc_session)
        users_layer = _as_dict(channel_layer.get("users"))
        user_layer = _as_dict(users_layer.get(msg.user_id))
        return channel_layer, user_layer

    @staticmethod
    def _feishu_account_session(account_id: str) -> dict[str, Any]:
        """Load session overrides for a Feishu employee account (assistant_id = agent_code)."""
        try:
            from app.channels.service import get_channel_service

            service = get_channel_service()
            if service is None:
                return {}
            feishu = service._config.get("feishu") if isinstance(service._config, dict) else None
            if not isinstance(feishu, dict):
                return {}
            accounts = feishu.get("accounts")
            if not isinstance(accounts, dict):
                return {}
            acc = accounts.get(account_id)
            if not isinstance(acc, dict):
                return {}
            session = _as_dict(acc.get("session"))
            # Default: route this bot to the employee agent of the same code.
            if not session.get("assistant_id"):
                session = {**session, "assistant_id": account_id}
            return session
        except Exception:
            logger.debug("[Manager] feishu account session lookup failed", exc_info=True)
            return {}

    @staticmethod
    def _outbound_metadata_from_inbound(msg: InboundMessage) -> dict[str, Any]:
        meta = dict(msg.metadata or {}) if isinstance(msg.metadata, dict) else {}
        # Always stamp account_id (may be "") so Feishu primary is not confused with
        # "missing" and must not fall back to another bot's chat_account mapping.
        out: dict[str, Any] = {
            "account_id": str(meta.get("account_id") or "").strip(),
        }
        return out

    @staticmethod
    def _im_routing_key(msg: InboundMessage) -> str:
        parts = [str(msg.channel_name), str(msg.chat_id)]
        account_id = str((msg.metadata or {}).get("account_id") or "").strip()
        if account_id:
            parts.append(f"acct:{account_id}")
        if msg.topic_id:
            parts.append(str(msg.topic_id))
        return ":".join(parts)

    @staticmethod
    def _inbound_account_id(msg: InboundMessage) -> str:
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
                run_context["claude_session_id"] = seed_sid
        # Custom agents are implemented as lead_agent + agent_name context.
        # Keep backward compatibility for channel configs that set
        # assistant_id: <custom-agent-name> by routing through lead_agent.
        elif assistant_id != DEFAULT_ASSISTANT_ID:
            run_context.setdefault("agent_name", _normalize_custom_agent_name(assistant_id))
            assistant_id = DEFAULT_ASSISTANT_ID
        else:
            # Default lead_agent — still pass agent_name so config (tools/skills) is loaded
            run_context.setdefault("agent_name", "main")

        return assistant_id, run_config, run_context

    def _channel_thread_session_key(self, msg: InboundMessage) -> str:
        """EvoPanel 侧栏/底部「智能体」依赖 `agent:{code}:{…}`；与 threads.create(metadata) 对齐，避免仅能用 `thread:{uuid}` 占位。"""
        _, _, run_context = self._resolve_run_params(msg, "__pending__")
        agent_name = str(run_context.get("agent_name") or "main").strip() or "main"
        parts: list[str] = [str(msg.channel_name), str(msg.chat_id)]
        if msg.topic_id:
            parts.append(str(msg.topic_id))
        tail = ":".join(parts)
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
                    # Never keep another bot's session_key when this inbound is a different account.
                    exp_agent = expected.split(":")[1] if expected.startswith("agent:") else ""
                    got_agent = existing.split(":")[1] if existing.startswith("agent:") else ""
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
            agent_code = ""
            if session_key.startswith("agent:"):
                parts = session_key.split(":")
                if len(parts) >= 2:
                    agent_code = str(parts[1] or "").strip()
            pretty = _default_channel_session_title(msg, agent_name=agent_code)
            from evoflow.persistence import session_repositories as sess_repo

            existing = (sess_repo.load_session_map().get(session_key) or {}) if session_key else {}
            old_title = str(existing.get("title") or "").strip()
            weak = (not old_title) or (
                old_title.startswith(("飞书 · ", "微信 · ", "Slack · ", "Telegram · "))
                and ("主对话" not in old_title and "小V" not in old_title and "（" not in old_title)
                and len([p for p in old_title.split("·")]) <= 3
            )
            if weak and pretty and pretty != old_title:
                _persist_channel_session_index(session_key, thread_id, msg, title=pretty)
        except Exception:
            logger.debug("[Manager] refresh weak IM session title skipped", exc_info=True)
        channel_run_id = _persist_channel_user_transcript_turn(session_key, thread_id, msg.text or "")
        _enrich_channel_run_context(run_context, session_key, msg, channel_run_id)
        send_shortcut_hint = (
            msg.channel_name in IM_CHANNEL_NAMES
            and not self._im_shortcut_hint_sent(msg)
            and not _im_should_omit_shortcut_hint(run_context, msg)
        )
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
        for attempt in range(2):
            try:
                result = await client.runs.wait(
                    thread_id,
                    assistant_id,
                    input={"messages": [{"role": "human", "content": msg.text}]},
                    config=run_config,
                    context=run_context,
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
                raise

        response_text = _extract_response_text(result)
        artifacts = _extract_artifacts(result)

        logger.info(
            "[Manager] agent response received: thread_id=%s, artifacts=%d\n--- assistant ---\n%s\n---",
            thread_id,
            len(artifacts),
            (response_text or "").strip() or "(empty)",
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
        )
        logger.info("[Manager] publishing outbound message to bus: channel=%s, chat_id=%s", msg.channel_name, msg.chat_id)
        await self.bus.publish_outbound(outbound)
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

        for attempt in range(2):
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
                async for chunk in client.runs.stream(
                    active_thread_id,
                    assistant_id,
                    input={"messages": [{"role": "human", "content": msg.text}]},
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
                            compatible = (
                                not latest_text
                                or custom_text == latest_text
                                or custom_text.startswith(latest_text)
                                or latest_text.startswith(custom_text)
                            )
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
                if _is_thread_busy_error(exc):
                    logger.warning("[Manager] thread busy (concurrent run rejected): thread_id=%s", active_thread_id)
                else:
                    logger.exception("[Manager] streaming error: thread_id=%s", active_thread_id)
                break

        result = last_values if last_values is not None else {"messages": [{"type": "ai", "content": latest_text}]}
        inbound_turn = (msg.text or "").strip()
        msgs_for_sync = (
            result.get("messages", [])
            if isinstance(result, dict)
            else (result if isinstance(result, list) else [])
        )
        tail_human = _last_human_text_from_messages(msgs_for_sync if isinstance(msgs_for_sync, list) else [])
        values_synced = not inbound_turn or tail_human == inbound_turn

        if values_synced:
            response_text = _extract_response_text(result)
            artifacts = _extract_artifacts(result)
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
            elif not (response_text or "").strip():
                response_text = (latest_text or "").strip() or "处理请求时出错，请稍后重试。"
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
            )
        )
        _finalize_channel_transcript_turn(sk, active_thread_id)

    # -- command handling --------------------------------------------------

    def _goal_channel_type(self, channel_name: str) -> "GoalChannelType":
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
            return (
                f"已启动目标任务（ID: `{session.id}`）。\n"
                f"- 目标：{preview}\n"
                f"- 会话：{session_key}\n"
                "后台将自动执行；发送 `/status` 可查看线程状态。"
            )
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
        )
        await self.bus.publish_outbound(outbound)
