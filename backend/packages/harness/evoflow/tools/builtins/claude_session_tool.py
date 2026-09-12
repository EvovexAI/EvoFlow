"""Interactive Claude Agent SDK session tool for Lead Agent.

This exposes a multi-turn session interface:
- create: start a persistent Claude SDK session
- send: send a user message (multi-turn)
- read: read recent output chunks (since last read)
- close: disconnect and cleanup

JSONL debug logs (one file per session_id) are written under
``claude_session_logs_dir()`` — see ``EVOFLOW_CLAUDE_SESSION_LOG_DIR`` or
``{EVOFLOW_HOME or ~/.evoflow}/logs/claude``. Each ``send`` appends
``user_input`` / ``assistant_output`` / ``stream_stop`` lines; use the
``log_path`` field in the tool return from ``create`` to locate the file.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import time
import uuid
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from langchain.tools import tool
from langgraph.config import get_stream_writer

logger = logging.getLogger(__name__)

# Set only while a collab ``task(..., subagent_type=claude-code, ...)`` subagent runs,
# so ``create`` can reuse the same Claude transport as ``supervisor`` / ``start_execution``.
_COLLAB_SESSION_EXTRA_CTX: ContextVar[dict[str, Any] | None] = ContextVar("_COLLAB_SESSION_EXTRA_CTX", default=None)

# When ``claude_session`` runs inside ``task`` → ``SubagentExecutor`` (thread pool + new event
# loop), ``get_stream_writer()`` is empty. ``task_tool`` sets this so ``send`` still emits
# ``trae_stream_delta`` to the lead-agent UI (same as direct ``claude_session`` calls).
_PARENT_CHAT_STREAM_WRITER: ContextVar[Callable[..., Any] | None] = ContextVar("_PARENT_CHAT_STREAM_WRITER", default=None)


@contextmanager
def parent_chat_stream_writer_ctx(writer: Callable[..., Any] | None) -> Iterator[None]:
    if writer is None:
        yield
        return
    tok = _PARENT_CHAT_STREAM_WRITER.set(writer)
    try:
        yield
    finally:
        _PARENT_CHAT_STREAM_WRITER.reset(tok)


@contextmanager
def use_claude_session_collab_context(extra: dict[str, Any] | None) -> Iterator[None]:
    """Bind optional collab keys for the duration of one subagent run."""
    if not extra:
        yield
        return
    tok = _COLLAB_SESSION_EXTRA_CTX.set(extra)
    try:
        yield
    finally:
        _COLLAB_SESSION_EXTRA_CTX.reset(tok)


def _collab_session_extra() -> dict[str, Any] | None:
    v = _COLLAB_SESSION_EXTRA_CTX.get()
    return v if isinstance(v, dict) else None


def _ts() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def claude_session_logs_dir() -> Path:
    """Directory for per-session JSONL logs.

    Priority:
    1. ``EVOFLOW_CLAUDE_SESSION_LOG_DIR`` — absolute or user-expandable path.
    2. ``Paths.claude_session_logs_dir`` (typically ``{EVOFLOW_HOME}/logs/claude``).
    """
    raw = os.getenv("EVOFLOW_CLAUDE_SESSION_LOG_DIR", "").strip()
    if raw:
        return Path(raw).expanduser().resolve()
    try:
        from evoflow.config.paths import get_paths

        return get_paths().claude_session_logs_dir
    except Exception:
        return (Path.cwd() / "logs" / "claude").resolve()


def _log_path(session_id: str) -> Path:
    return claude_session_logs_dir() / f"claude_session_{session_id}.jsonl"


def _append_jsonl(path: Path, obj: dict[str, Any]) -> None:
    obj.setdefault("ts", _ts())
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(obj, ensure_ascii=False) + "\n")


@dataclass
class _SdkSession:
    session_id: str
    project_path: str
    client: Any
    sdk_session_id: str
    output_buffer: list[str] = field(default_factory=list)
    read_cursor: int = 0
    last_activity_monotonic: float = field(default_factory=time.monotonic)


_SESSIONS: dict[str, _SdkSession] = {}
_SESSIONS_LOCK = asyncio.Lock()
_REAPER_TASK: asyncio.Task | None = None

# Default: 10 minutes idle closes the session (can be overridden for testing).
_IDLE_TIMEOUT_S = max(60, int(os.getenv("CLAUDE_SESSION_IDLE_TIMEOUT_S", "600")))
_REAPER_TICK_S = max(10, int(os.getenv("CLAUDE_SESSION_REAPER_TICK_S", "60")))

# Streaming receive tuning (avoid cutting off long generations).
# Defaults tuned for real-world stalls: models may pause during tool use / internal thinking.
_STREAM_TOTAL_TIMEOUT_S = max(30, int(os.getenv("CLAUDE_SESSION_STREAM_TOTAL_TIMEOUT_S", "600")))
_STREAM_FIRST_EVENT_TIMEOUT_S = max(5, int(os.getenv("CLAUDE_SESSION_STREAM_FIRST_EVENT_TIMEOUT_S", "60")))
_STREAM_IDLE_TIMEOUT_AFTER_STREAM_S = max(2, int(os.getenv("CLAUDE_SESSION_STREAM_IDLE_TIMEOUT_AFTER_STREAM_S", "300")))


def _normalize_windows_path(p: str | None) -> str | None:
    if not p:
        return None
    s = str(p).strip()
    return s or None


def _touch(session: _SdkSession) -> None:
    session.last_activity_monotonic = time.monotonic()


async def _ensure_reaper_started() -> None:
    """Start a background reaper that closes idle sessions."""
    global _REAPER_TASK
    if _REAPER_TASK is not None and not _REAPER_TASK.done():
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return

    async def _reap_loop() -> None:
        while True:
            await asyncio.sleep(_REAPER_TICK_S)
            now = time.monotonic()
            to_close: list[_SdkSession] = []
            async with _SESSIONS_LOCK:
                for sess in list(_SESSIONS.values()):
                    if now - sess.last_activity_monotonic >= _IDLE_TIMEOUT_S:
                        to_close.append(sess)
                        _SESSIONS.pop(sess.session_id, None)

            for sess in to_close:
                try:
                    await sess.client.disconnect()
                except Exception:
                    pass
                try:
                    p = _log_path(sess.session_id)
                    _append_jsonl(
                        p,
                        {
                            "type": "closed",
                            "reason": "idle_timeout",
                            "idle_timeout_s": _IDLE_TIMEOUT_S,
                        },
                    )
                except Exception:
                    pass

    _REAPER_TASK = loop.create_task(_reap_loop())


def _load_project_path_from_log(session_id: str) -> str | None:
    """Best-effort: recover project_path for a session from its JSONL log."""
    try:
        path = _log_path(session_id)
        if not path.exists():
            return None
        with path.open("r", encoding="utf-8") as f:
            for _ in range(50):  # meta should be near the top
                line = f.readline()
                if not line:
                    break
                try:
                    obj = json.loads(line)
                except Exception:
                    continue
                if isinstance(obj, dict) and obj.get("type") == "meta":
                    pp = obj.get("project_path")
                    if isinstance(pp, str) and pp.strip():
                        return pp.strip()
        return None
    except Exception:
        return None


def _load_sdk_session_id_from_log(session_id: str) -> str | None:
    """Recover sdk_session_id mapping from JSONL log."""
    try:
        path = _log_path(session_id)
        if not path.exists():
            return None
        with path.open("r", encoding="utf-8") as f:
            for _ in range(80):
                line = f.readline()
                if not line:
                    break
                try:
                    obj = json.loads(line)
                except Exception:
                    continue
                if not isinstance(obj, dict):
                    continue
                if obj.get("type") in {"created", "meta"}:
                    sid = obj.get("sdk_session_id")
                    if isinstance(sid, str) and sid.strip():
                        return sid.strip()
        return None
    except Exception:
        return None


async def _connect_or_resume_client(
    *,
    ClaudeAgentOptions,
    ClaudeSDKClient,
    sdk_session_id: str,
    project_path: str,
    resume: bool,
) -> Any:
    """Create+connect an SDK client; optionally resume an existing session."""
    # NOTE: SDK v0.1.65 supports: continue_conversation, resume, session_id, cwd, add_dirs.
    opts_kwargs: dict[str, Any] = {
        "include_partial_messages": True,
        "cwd": project_path,
        "add_dirs": [project_path],
    }
    if resume:
        opts_kwargs["continue_conversation"] = True
        opts_kwargs["resume"] = sdk_session_id
    else:
        opts_kwargs["session_id"] = sdk_session_id
        opts_kwargs["continue_conversation"] = False

    options = ClaudeAgentOptions(**opts_kwargs)
    client = ClaudeSDKClient(options=options)
    await client.connect()
    return client


async def _ensure_session(
    *,
    ClaudeAgentOptions,
    ClaudeSDKClient,
    session_id: str,
) -> tuple[_SdkSession | None, str | None, str]:
    """Ensure we have a connected session in memory. Auto-resume across requests."""
    async with _SESSIONS_LOCK:
        existing = _SESSIONS.get(session_id)
    if existing is not None:
        _touch(existing)
        return existing, None, "memory"

    project_path = _load_project_path_from_log(session_id)
    if not project_path:
        return None, "session not found in memory and cannot infer project_path from log; please call create again", "missing"

    sdk_session_id = _load_sdk_session_id_from_log(session_id)
    if not sdk_session_id:
        return None, "session not found in memory and cannot infer sdk_session_id from log; please call create again", "missing"

    try:
        client = await _connect_or_resume_client(
            ClaudeAgentOptions=ClaudeAgentOptions,
            ClaudeSDKClient=ClaudeSDKClient,
            sdk_session_id=sdk_session_id,
            project_path=project_path,
            resume=True,
        )
    except Exception as e:
        return None, f"failed to resume session: {e}", "resume_failed"

    sess = _SdkSession(
        session_id=session_id,
        project_path=project_path,
        client=client,
        sdk_session_id=sdk_session_id,
    )
    async with _SESSIONS_LOCK:
        _SESSIONS[session_id] = sess
    return sess, None, "resume"


def _extract_assistant_text(message: Any) -> list[str]:
    parts: list[str] = []
    for block in getattr(message, "content", []) or []:
        text = getattr(block, "text", None)
        if isinstance(text, str) and text.strip():
            parts.append(text)
    return parts


def _extract_stream_text(message: Any) -> str | None:
    event = getattr(message, "event", None)
    if not isinstance(event, dict):
        return None
    if event.get("type") != "content_block_delta":
        return None
    delta = event.get("delta", {})
    if not isinstance(delta, dict):
        return None
    if delta.get("type") != "text_delta":
        return None
    text = delta.get("text")
    if isinstance(text, str) and text:
        return text
    return None


async def _send_and_stream(
    session: _SdkSession,
    user_message: str,
    *,
    emit_chat_stream: bool = True,
    stream_to_subtask_id: str | None = None,
    stream_to_main_task_id: str | None = None,
) -> tuple[bool, int, str | None]:
    """Send one message and stream response deltas to UI."""
    writer = None
    try:
        writer = get_stream_writer()
    except Exception:
        writer = None
    if writer is None:
        writer = _PARENT_CHAT_STREAM_WRITER.get()
    # 子代理线程内 LLM 常不传 stream_to_subtask_id；用 ContextVar 绑到 background task_id，
    # 否则 Claude Code 正文只进 tool return，主对话弹窗/transcript 对不上流式 task_id。
    if not str(stream_to_subtask_id or "").strip():
        try:
            from evoflow.scheduler.subagent_stream import get_subagent_stream_task_id

            stream_to_subtask_id = get_subagent_stream_task_id()
        except Exception:
            pass
    subtask_id = str(stream_to_subtask_id or "").strip() or None
    main_task_id = str(stream_to_main_task_id or "").strip() or None

    streamed_count = 0
    error_text: str | None = None
    assistant_blocks: list[str] = []
    progressive = ""

    total_timeout_s = float(_STREAM_TOTAL_TIMEOUT_S)
    idle_timeout_after_stream_s = float(_STREAM_IDLE_TIMEOUT_AFTER_STREAM_S)
    first_event_timeout_s = float(_STREAM_FIRST_EVENT_TIMEOUT_S)

    stop_reason: str | None = None
    try:
        _touch(session)
        await session.client.query(user_message)
        started_at = time.monotonic()
        stream_iter = session.client.receive_response().__aiter__()

        while True:
            now = time.monotonic()
            elapsed = now - started_at
            if elapsed >= total_timeout_s:
                if streamed_count > 0:
                    stop_reason = "total_timeout_after_some_output"
                    break
                error_text = f"receive_response timed out after {int(total_timeout_s)}s"
                stop_reason = "total_timeout_no_output"
                break

            # Before first output, wait longer; after streaming starts, return quickly on idle.
            per_event_timeout = first_event_timeout_s if streamed_count == 0 and not assistant_blocks else idle_timeout_after_stream_s
            remaining_total = total_timeout_s - elapsed
            wait_s = min(per_event_timeout, max(0.2, remaining_total))

            try:
                msg = await asyncio.wait_for(anext(stream_iter), timeout=wait_s)
            except StopAsyncIteration:
                stop_reason = "stream_eof"
                break
            except TimeoutError:
                if streamed_count > 0 or assistant_blocks:
                    # No new chunks for a while: treat this turn as complete.
                    stop_reason = f"idle_timeout_{int(wait_s)}s"
                    break
                continue

            chunk = _extract_stream_text(msg)
            if chunk is not None:
                _touch(session)
                session.output_buffer.append(chunk)
                streamed_count += 1
                if writer is not None and emit_chat_stream:
                    try:
                        # Reuse existing UI stream event contract handled by evopanel.
                        writer({"type": "trae_stream_delta", "text": chunk})
                    except Exception:
                        pass
                # 流式只推本段 delta；完整正文仅在 output_buffer 与 task_completed 时拼接，避免双通道/前端把
                # 多条「整段 progressive」叠成重复前缀。
                progressive += chunk
                if writer is not None and subtask_id is not None:
                    try:
                        writer(
                            {
                                "type": "task_running",
                                "task_id": subtask_id,
                                "collab_subtask_id": subtask_id,
                                "subagent_type": "claude-code",
                                "message": {"type": "ai", "content": chunk},
                            }
                        )
                    except Exception:
                        pass
                if main_task_id and subtask_id:
                    try:
                        from evoflow.collab.sse_notify import schedule_collab_subtask_stream

                        schedule_collab_subtask_stream(
                            main_task_id,
                            "task:running",
                            subtask_id=subtask_id,
                            subagent_type="claude-code",
                            message={"type": "ai", "content": chunk},
                        )
                    except Exception:
                        pass
                continue

            parts = _extract_assistant_text(msg)
            if parts:
                _touch(session)
                assistant_blocks.extend(parts)
            # ResultMessage means this turn is complete.
            if msg.__class__.__name__ == "ResultMessage":
                stop_reason = "result_message"
                break
    except Exception as e:
        error_text = str(e)
        stop_reason = "exception"
    finally:
        # This doesn't change tool return, but helps debug "reply stopped halfway".
        try:
            p = _log_path(session.session_id)
            _append_jsonl(
                p,
                {
                    "type": "stream_stop",
                    "reason": stop_reason,
                    "streamed_count": streamed_count,
                    "assistant_blocks": len(assistant_blocks),
                    "error": error_text,
                },
            )
        except Exception:
            pass

    # If we got absolutely nothing back, treat as failure so caller can retry/resume.
    if error_text is None and streamed_count == 0 and not assistant_blocks:
        error_text = "no response received (empty stream)"

    if streamed_count == 0 and assistant_blocks:
        # 与 content_block_delta 一致：多块为同一轮输出的连续片段，勿人为插 \n。
        merged = "".join(p.strip() for p in assistant_blocks if p.strip()).strip()
        if merged:
            session.output_buffer.append(merged)
            streamed_count = 1
            if writer is not None and emit_chat_stream:
                try:
                    writer({"type": "trae_stream_delta", "text": merged})
                except Exception:
                    pass
            if writer is not None and subtask_id is not None:
                try:
                    progressive = merged
                    writer(
                        {
                            "type": "task_running",
                            "task_id": subtask_id,
                            "collab_subtask_id": subtask_id,
                            "subagent_type": "claude-code",
                            "message": {"type": "ai", "content": progressive},
                        }
                    )
                except Exception:
                    pass
            if main_task_id and subtask_id:
                try:
                    from evoflow.collab.sse_notify import schedule_collab_subtask_stream

                    schedule_collab_subtask_stream(
                        main_task_id,
                        "task:running",
                        subtask_id=subtask_id,
                        subagent_type="claude-code",
                        message={"type": "ai", "content": merged},
                    )
                except Exception:
                    pass

    if writer is not None and emit_chat_stream:
        try:
            writer({"type": "trae_stream_done"})
        except Exception:
            pass
    if writer is not None and subtask_id is not None:
        try:
            final_text = "".join(str(x or "") for x in session.output_buffer).strip()
            writer(
                {
                    "type": "task_completed",
                    "task_id": subtask_id,
                    "collab_subtask_id": subtask_id,
                    "subagent_type": "claude-code",
                    "result": final_text,
                }
            )
        except Exception:
            pass
    if main_task_id and subtask_id:
        try:
            from evoflow.collab.sse_notify import schedule_collab_subtask_stream

            final_text = "".join(str(x or "") for x in session.output_buffer).strip()
            schedule_collab_subtask_stream(
                main_task_id,
                "task:completed",
                subtask_id=subtask_id,
                subagent_type="claude-code",
                result=final_text,
            )
        except Exception:
            pass
    return error_text is None, streamed_count, error_text


@tool("claude-code", parse_docstring=True)
async def claude_session_tool(
    action: Literal["create", "send", "read", "close"],
    session_id: str | None = None,
    project_path: str | None = None,
    message: str | None = None,
    lines: int = 50,
    stream_to_chat: bool = True,
    stream_to_subtask_id: str | None = None,
    stream_to_main_task_id: str | None = None,
) -> dict[str, Any]:
    """Interactive multi-turn Claude Agent SDK session.

    Args:
        action: One of "create" | "send" | "read" | "close".
        session_id: Session identifier. Required for send/read/close. Optional for create.
        project_path: Working directory. Required for create.
        message: User message content. Required for send.
        lines: Number of recent output lines to return for read.
        stream_to_chat: Whether send emits main chat stream deltas.
        stream_to_subtask_id: If set, send emits subtask stream events (task_running/task_completed) to this id.
        stream_to_main_task_id: Main task id for detached task SSE broadcast routing.

    Returns:
        A dict result. For create returns ``session_id``, ``log_path`` (absolute JSONL path — same file records assistant output from ``send``).
        For read returns ``{"ok": true, "lines": [...] }``.
    """
    try:
        from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient
    except Exception as e:
        exe = str(getattr(sys, "executable", "") or "").strip()
        suffix = f" (当前解释器: {exe})" if exe else ""
        return {
            "ok": False,
            "error": (
                f"claude-agent-sdk import failed: {e}. Please install `claude-agent-sdk` in **this** Python env{suffix}. "
                "角色管理里的检测在 Gateway 进程；本错误来自 **LangGraph** 进程，请在运行 ``langgraph dev`` 的 backend venv "
                "执行 ``uv sync --extra claude-code`` 或 ``uv pip install claude-agent-sdk``。"
            ),
        }

    if action == "create":
        ctx = _collab_session_extra()
        reuse_sid = str(ctx.get("claude_session_reuse_session_id") or "").strip() if ctx else ""
        if reuse_sid:
            await _ensure_reaper_started()
            session, ensure_err, session_source = await _ensure_session(
                ClaudeAgentOptions=ClaudeAgentOptions,
                ClaudeSDKClient=ClaudeSDKClient,
                session_id=reuse_sid,
            )
            if session is not None:
                p = _log_path(reuse_sid)
                logger.info(
                    "claude_session JSONL log (user_input / assistant_output / …): %s",
                    p.resolve(),
                )
                return {
                    "ok": True,
                    "session_id": reuse_sid,
                    "log_path": str(p),
                    "session_source": session_source or "reuse_collab_subtask",
                }
            logger.info(
                "claude_session create: reuse_session_id=%r unavailable (%s); creating new session",
                reuse_sid,
                ensure_err,
            )

        if not project_path:
            return {"ok": False, "error": "project_path is required for create"}

        await _ensure_reaper_started()
        sid = session_id or f"claude-code-{uuid.uuid4().hex[:10]}"
        async with _SESSIONS_LOCK:
            if sid in _SESSIONS:
                return {"ok": False, "error": f"session already exists: {sid}"}

        project_path = _normalize_windows_path(project_path) or project_path
        sdk_session_id = str(uuid.uuid4())
        client = await _connect_or_resume_client(
            ClaudeAgentOptions=ClaudeAgentOptions,
            ClaudeSDKClient=ClaudeSDKClient,
            sdk_session_id=sdk_session_id,
            project_path=project_path,
            resume=False,
        )
        sess = _SdkSession(
            session_id=sid,
            project_path=project_path,
            client=client,
            sdk_session_id=sdk_session_id,
        )
        async with _SESSIONS_LOCK:
            _SESSIONS[sid] = sess

        p = _log_path(sid)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("", encoding="utf-8")
        _append_jsonl(
            p,
            {
                "type": "meta",
                "session_id": sid,
                "project_path": project_path,
                "sdk_session_id": sdk_session_id,
            },
        )
        _append_jsonl(p, {"type": "created", "driver": "claude-agent-sdk", "sdk_session_id": sdk_session_id})

        logger.info(
            "claude_session JSONL log (session I/O and streamed assistant chunks): %s",
            p.resolve(),
        )

        ctx = _collab_session_extra()
        if ctx:
            mt = str(ctx.get("collab_task_id") or "").strip()
            st = str(ctx.get("collab_subtask_id") or "").strip()
            if mt and st:
                try:
                    from evoflow.collab.storage import get_project_storage
                    from evoflow.tools.builtins.supervisor.execution import _persist_subtask_session_id

                    _persist_subtask_session_id(get_project_storage(), mt, st, sid)
                except Exception:
                    logger.debug("persist claude_session_id after task_tool create failed", exc_info=True)

        return {"ok": True, "session_id": sid, "log_path": str(p), "session_source": "create"}

    if not session_id:
        return {"ok": False, "error": "session_id is required"}

    session, ensure_err, session_source = await _ensure_session(
        ClaudeAgentOptions=ClaudeAgentOptions,
        ClaudeSDKClient=ClaudeSDKClient,
        session_id=session_id,
    )
    if session is None:
        return {"ok": False, "error": ensure_err or "session not found"}

    p = _log_path(session_id)

    if action == "send":
        if not message:
            return {"ok": False, "error": "message is required for send"}

        _append_jsonl(p, {"type": "user_input", "content": message})
        ok, streamed_count, err = await _send_and_stream(
            session,
            message,
            emit_chat_stream=bool(stream_to_chat),
            stream_to_subtask_id=stream_to_subtask_id,
            stream_to_main_task_id=stream_to_main_task_id,
        )
        # If the in-memory client died between requests, try one-shot resume then re-send.
        if (not ok) and err and (("connection" in err.lower()) or ("transport" in err.lower()) or ("disconnect" in err.lower()) or ("empty stream" in err.lower())):
            try:
                await session.client.disconnect()
            except Exception:
                pass
            try:
                session.client = await _connect_or_resume_client(
                    ClaudeAgentOptions=ClaudeAgentOptions,
                    ClaudeSDKClient=ClaudeSDKClient,
                    sdk_session_id=session.sdk_session_id,
                    project_path=session.project_path,
                    resume=True,
                )
                ok, streamed_count, err = await _send_and_stream(
                    session,
                    message,
                    emit_chat_stream=bool(stream_to_chat),
                    stream_to_subtask_id=stream_to_subtask_id,
                    stream_to_main_task_id=stream_to_main_task_id,
                )
            except Exception as e:
                ok, streamed_count, err = False, 0, f"resume+retry failed: {e}"
        _append_jsonl(
            p,
            {
                "type": "send_result",
                "ok": ok,
                "streamed_count": streamed_count,
                "error": err,
                "session_source": session_source,
            },
        )
        if not ok:
            return {"ok": False, "error": err or "send failed"}
        if streamed_count > 0:
            for line in session.output_buffer[-streamed_count:]:
                _append_jsonl(p, {"type": "assistant_output", "content": line})
        # 供 start_execution 等落库：与 read 游标无关，避免并行/重复 read 把游标推到末尾后此处读到空串。
        accumulated_text = "".join(str(x or "") for x in session.output_buffer).strip()
        return {
            "ok": True,
            "session_id": session_id,
            "streamed_lines": streamed_count,
            "session_source": session_source,
            "accumulated_text": accumulated_text,
        }

    if action == "read":
        _touch(session)
        out_all = session.output_buffer
        delta = out_all[session.read_cursor :]
        session.read_cursor = len(out_all)
        out = delta[-lines:] if lines > 0 else delta
        # Also log a snapshot read for debugging.
        _append_jsonl(p, {"type": "read", "lines": lines, "count": len(out)})
        return {"ok": True, "session_id": session_id, "lines": out, "session_source": session_source}

    if action == "close":
        try:
            await session.client.disconnect()
        finally:
            async with _SESSIONS_LOCK:
                _SESSIONS.pop(session_id, None)
        _append_jsonl(p, {"type": "closed"})
        return {"ok": True, "session_id": session_id, "session_source": session_source}

    return {"ok": False, "error": f"unknown action: {action}"}
