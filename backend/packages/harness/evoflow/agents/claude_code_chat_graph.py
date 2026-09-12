"""Minimal LangGraph for EvoPanel «Claude Code» role: user input → ``claude_session`` only.

No Lead Agent, no config.yaml chat model. Streams via existing ``trae_stream_delta`` / ``trae_stream_done``
inside :mod:`evoflow.tools.builtins.claude_session_tool`.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Annotated, Any

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage
from langchain_core.runnables import RunnableConfig
from langgraph.config import get_config
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from langgraph_sdk.runtime import ServerRuntime

try:
    from typing import NotRequired
except ImportError:
    from typing import NotRequired

from langgraph.checkpoint.base import BaseCheckpointSaver
from typing_extensions import TypedDict

from evoflow.tools.builtins.claude_session_tool import claude_session_tool
from evoflow.tools.builtins.session_workspace_ops import (
    emit_session_workspace_to_client,
    format_workspace_reply,
    parse_workspace_slash_command,
    workspace_mkdir,
    workspace_query_payload,
    workspace_specify,
)

logger = logging.getLogger(__name__)


class ClaudeCodeChatState(TypedDict):
    messages: Annotated[list[BaseMessage], add_messages]
    claude_session_id: NotRequired[str | None]
    workspace_root_override: NotRequired[str | None]
    bound_project_path: NotRequired[str | None]


def _configurable() -> dict[str, Any]:
    """Per-invocation configurable (includes merged ``context`` from client)."""
    try:
        rc = get_config()
        if rc is None:
            return {}
        conf = getattr(rc, "configurable", None)
        if isinstance(conf, dict):
            return dict(conf)
    except Exception:
        pass
    return {}


def _latest_human_text(messages: list[BaseMessage]) -> str:
    for m in reversed(messages or []):
        if isinstance(m, HumanMessage):
            return _stringify_message_content(m.content).strip()
        t = getattr(m, "type", None)
        if t == "human":
            return _stringify_message_content(getattr(m, "content", "")).strip()
    return ""


def _stringify_message_content(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict):
                if block.get("type") == "text" and isinstance(block.get("text"), str):
                    parts.append(block["text"])
            else:
                txt = getattr(block, "text", None)
                if isinstance(txt, str):
                    parts.append(txt)
        return "".join(parts)
    return str(content or "")


async def _workspace_slash_dispatch(state: ClaudeCodeChatState, cfg: dict[str, Any], user_text: str) -> dict[str, Any] | None:
    """Whole-message ``/workspace …`` — does not call Claude SDK."""
    parsed = parse_workspace_slash_command(user_text)
    if not parsed:
        return None
    verb, arg = parsed
    if verb == "query":
        payload = workspace_query_payload(cfg)
        return {"messages": [AIMessage(content=format_workspace_reply(payload))]}
    if verb == "create":
        if not (arg or "").strip():
            return {
                "messages": [
                    AIMessage(
                        content="[工作空间] create 需要提供路径，例如：`/workspace create D:\\\\proj` 或 `/workspace 新增 D:\\\\proj`",
                    )
                ],
            }
        payload = workspace_mkdir(arg or "")
        return {"messages": [AIMessage(content=format_workspace_reply(payload))]}
    if verb == "set":
        if not (arg or "").strip():
            return {
                "messages": [
                    AIMessage(
                        content="[工作空间] set 需要提供路径，例如：`/workspace set D:\\\\proj` 或 `/workspace 指定 D:\\\\proj`",
                    )
                ],
            }
        payload = workspace_specify(arg or "")
        if not payload.get("ok"):
            return {"messages": [AIMessage(content=format_workspace_reply(payload))]}
        root = str(payload.get("local_workspace_root") or "").strip()
        if root:
            emit_session_workspace_to_client(root, use_virtual_paths=False)
        out: dict[str, Any] = {
            "messages": [AIMessage(content=format_workspace_reply(payload))],
            "workspace_root_override": root,
            "claude_session_id": None,
            "bound_project_path": None,
        }
        sid = str(state.get("claude_session_id") or "").strip()
        if sid:
            try:
                await claude_session_tool.ainvoke({"action": "close", "session_id": sid})
            except Exception:
                logger.exception("[claude_code_chat] workspace set: close claude session failed")
        return out
    return None


async def _claude_code_chat_node(state: ClaudeCodeChatState) -> dict[str, Any]:
    cfg = _configurable()
    thread_id = str(cfg.get("thread_id") or "").strip()

    messages = list(state.get("messages") or [])
    user_text = _latest_human_text(messages)
    if not user_text:
        return {"messages": [AIMessage(content="[Claude Code] 未收到有效用户输入（请发送文字消息）。")]}

    ws_reply = await _workspace_slash_dispatch(state, cfg, user_text)
    if ws_reply is not None:
        return ws_reply

    override = str(state.get("workspace_root_override") or "").strip()
    cfg_path = str(cfg.get("local_workspace_root") or "").strip()
    effective_base = override or cfg_path or os.getcwd()
    try:
        effective = str(Path(effective_base).expanduser().resolve())
    except OSError:
        effective = effective_base

    if not cfg_path and not override:
        logger.info("[claude_code_chat] local_workspace_root empty; using cwd=%s", effective)

    bound = str(state.get("bound_project_path") or "").strip()
    bound_resolved = ""
    if bound:
        try:
            bound_resolved = str(Path(bound).expanduser().resolve())
        except OSError:
            bound_resolved = bound

    # Checkpoint state wins; else seed from run ``context`` (e.g. IM ``/claude <session_id>``).
    sid_state = str(state.get("claude_session_id") or "").strip() or None
    sid_cfg = str(cfg.get("claude_session_id") or "").strip() or None
    sid_resolved = sid_state or sid_cfg or None

    if sid_resolved and bound_resolved and bound_resolved != effective:
        try:
            await claude_session_tool.ainvoke({"action": "close", "session_id": sid_resolved})
        except Exception:
            logger.exception("[claude_code_chat] close session on workspace path drift")
        sid_resolved = None
        sid_state = None

    session_id = sid_resolved or (f"panel-{thread_id}" if thread_id else "")
    if not session_id:
        import uuid

        session_id = f"panel-{uuid.uuid4().hex[:12]}"

    # First graph step (no checkpointed claude_session_id yet): run create to attach SDK session.
    need_create = sid_state is None
    did_create = False
    if need_create:
        did_create = True
        create_res = await claude_session_tool.ainvoke(
            {"action": "create", "session_id": session_id, "project_path": effective},
        )
        if not isinstance(create_res, dict) or not create_res.get("ok"):
            err = str((create_res or {}).get("error") or "create failed") if isinstance(create_res, dict) else "create failed"
            hint = '``claude-agent-sdk`` 已列为 harness 默认依赖：请在 ``backend`` 目录执行 ``uv sync`` 后重启 LangGraph。若仍失败，检查该 venv 的 ``python -c "import claude_agent_sdk"``；并保证对工作目录可写。'
            return {
                "claude_session_id": None,
                "messages": [AIMessage(content=f"[Claude Code] 无法启动会话: {err}\n\n{hint}")],
            }
        session_id = str(create_res.get("session_id") or session_id).strip()

    send_res = await claude_session_tool.ainvoke(
        {
            "action": "send",
            "session_id": session_id,
            "message": user_text,
            "stream_to_chat": True,
        },
    )
    if not isinstance(send_res, dict) or not send_res.get("ok"):
        err = str((send_res or {}).get("error") or "send failed") if isinstance(send_res, dict) else "send failed"
        return {
            "claude_session_id": session_id,
            "messages": [AIMessage(content=f"[Claude Code] 发送失败: {err}")],
        }
    text = str(send_res.get("accumulated_text") or "").strip()
    if not text:
        text = "（Claude Code 已处理本轮请求；若上方无流式输出，请查看会话日志或重试。）"
    out: dict[str, Any] = {"claude_session_id": session_id, "messages": [AIMessage(content=text)]}
    if did_create:
        out["bound_project_path"] = effective
    return out


def _build_claude_code_state_graph() -> StateGraph:
    graph = StateGraph(ClaudeCodeChatState)
    graph.add_node("claude_code", _claude_code_chat_node)
    graph.add_edge(START, "claude_code")
    graph.add_edge("claude_code", END)
    return graph


def compile_claude_code_chat_graph_for_tests(checkpointer: BaseCheckpointSaver):
    """Compile with an explicit checkpointer (unit tests only).

    LangGraph API 0.7+ graph factories may only take ``(config, runtime)`` — do not add a third
    parameter to :func:`make_claude_code_chat_graph`.
    """
    return _build_claude_code_state_graph().compile(checkpointer=checkpointer)


def make_claude_code_chat_graph(config: RunnableConfig, runtime: ServerRuntime | None = None):
    """LangGraph Server entry: **exactly two** parameters (``config``, ``runtime``), same as ``make_lead_agent``."""
    logger.debug(
        "make_claude_code_chat_graph: has_runtime=%s configurable_keys=%s",
        runtime is not None,
        sorted((config.get("configurable") or {}).keys()) if isinstance(config, dict) else [],
    )

    return _build_claude_code_state_graph().compile()
