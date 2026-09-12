"""Task tool for delegating work to subagents."""

import asyncio
import inspect
import json
import logging
import os
import sys
import threading
import time
from dataclasses import replace
from typing import Annotated, Any

from langchain.tools import InjectedToolCallId, ToolRuntime, tool
from langgraph.config import get_stream_writer
from langgraph.typing import ContextT
from pydantic import ValidationError

# Import cancellation support for checking if task is cancelled
from evoflow.agents.lead_agent.prompt import format_runtime_now_for_prompt, get_skills_prompt_section
from evoflow.agents.lead_agent.prompt_language import resolve_prompt_language
from evoflow.agents.lead_agent.runtime_context import runtime_context_mapping
from evoflow.agents.thread_state import ThreadState
from evoflow.claude_subagent_type import (
    collab_executor_allows_auto_outcome_without_report,
    effective_subagent_type as _resolve_effective_subagent_type,
    is_claude_code_subagent_type,
)
from evoflow.tools.builtins.subagent_tool_description import SUBAGENT_TOOL_DESCRIPTION
from evoflow.collab.id_format import make_trace_id
from evoflow.collab.models import CollabPhase, WorkerProfile
from evoflow.collab.storage import (
    collab_execution_gate_error,
    find_main_task,
    find_subtask_by_ids,
    get_project_storage,
    get_task_memory_storage,
    patch_collab_subtask_in_project_storage,
    persist_subtask_runtime_snapshot,
    persist_task_memory_after_subagent_run,
    rollup_root_task_progress_from_subtasks,
)
from evoflow.collab.thread_collab import load_thread_collab_state
from evoflow.config.agents_config import load_agent_config
from evoflow.config.paths import get_paths
from evoflow.sandbox.security import LOCAL_BASH_SUBAGENT_DISABLED_MESSAGE, is_host_bash_allowed
from evoflow.subagents import SubagentExecutor, get_available_subagent_names, get_subagent_config
from evoflow.subagents.executor import SubagentResult, SubagentStatus, cleanup_background_task, get_background_task_result

logger = logging.getLogger(__name__)

_SUBAGENT_PROMPT_MAX_CHARS = 12_000


def _trim_subagent_prompt(prompt: str) -> str:
    text = str(prompt or "").strip()
    if len(text) <= _SUBAGENT_PROMPT_MAX_CHARS:
        return text
    return (
        text[:_SUBAGENT_PROMPT_MAX_CHARS]
        + "\n\n… [context trimmed for subagent — focus on the task goal above]"
    )


# 子智能体不得切换父会话场景/协作（会误激活 plan 并进入 planning）
_SUBAGENT_FORBIDDEN_TOOLS = frozenset({"scenario", "plan", "supervisor", "ask_clarification"})

# Subtask lifecycle tools always merged onto an explicit worker tool allowlist.
# When worker_profile.tools is unset, resolve via assignee AgentConfig / parent session agent
# (see ``evoflow.collab.worker_tool_allowlist``) — never the raw global catalog.
_COLLAB_SUBTASK_MANDATORY_TOOLS = (
    "subtask_work_checklist",
    "subtask_progress_report",
    "subtask_outcome_report",
    "collab_peer_send",
    "collab_peer_read",
    "collab_peer_reply",
)


def _merge_collab_subtask_tool_allowlist(
    *,
    overrides_tools: list[str] | None,
    final_tools: list[str] | None,
    allowed_tool_names: set[str],
) -> list[str] | None:
    """Append mandatory collab tools to an explicit allowlist.

    ``None`` base means the caller has not resolved tools yet (should not happen after
    ``resolve_worker_tool_allowlist``); keep returning None for unit-test compatibility.
    """
    base = overrides_tools if overrides_tools is not None else final_tools
    if base is None:
        return None
    merged = list(base)
    for tool_name in _COLLAB_SUBTASK_MANDATORY_TOOLS:
        if tool_name in allowed_tool_names and tool_name not in merged:
            merged.append(tool_name)
    return merged


# Last successful ``claude_session`` session_id per lead/subtask thread (non-collab continuity).
_LAST_CLAUDE_SESSION_BY_THREAD: dict[str, str] = {}
_LAST_CLAUDE_SESSION_LOCK = threading.Lock()


def _thread_key_for_claude_cache(thread_id: str | None) -> str | None:
    s = str(thread_id or "").strip()
    return s or None


def _remember_claude_session_for_thread(thread_id: str | None, session_id: str | None) -> None:
    sid = str(session_id or "").strip()
    key = _thread_key_for_claude_cache(thread_id)
    if not key or not sid:
        return
    with _LAST_CLAUDE_SESSION_LOCK:
        _LAST_CLAUDE_SESSION_BY_THREAD[key] = sid


def _default_claude_session_id_for_thread(thread_id: str | None) -> str | None:
    key = _thread_key_for_claude_cache(thread_id)
    if not key:
        return None
    with _LAST_CLAUDE_SESSION_LOCK:
        return _LAST_CLAUDE_SESSION_BY_THREAD.get(key)


def _resolve_effective_root(project_workspace_path: str | None = None) -> str:
    """Resolve effective root path for uploads/workspace/outputs directories.

    Priority:
    1. Project runtime workspace (project_workspace_path)
    2. EVOFLOW_HOME environment variable (set by Tauri launcher)
    3. Paths.base_dir (global workspace, handles config.yaml, cwd, $HOME fallback)
    """
    # 详细日志：记录工作空间解析过程
    log_lines = []
    log_lines.append("【工作空间根目录解析】")
    log_lines.append(f"  输入的项目运行工作空间: {project_workspace_path!r}")

    if project_workspace_path and project_workspace_path.strip():
        log_lines.append("  ✓ 使用优先级 1: 项目运行工作空间")
        log_lines.append(f"  解析结果: {project_workspace_path.strip()}")
        result = project_workspace_path.strip()
    elif evoflow_home := os.getenv("EVOFLOW_HOME"):
        stripped = evoflow_home.strip()
        if stripped:
            log_lines.append("  ✓ 使用优先级 2: EVOFLOW_HOME 环境变量")
            log_lines.append(f"  解析结果: {stripped}")
            result = stripped
        else:
            log_lines.append("  ✗ EVOFLOW_HOME 为空，回退到优先级 3: 全局工作空间")
            result = str(get_paths().base_dir)
            log_lines.append("  ✓ 使用优先级 3: 全局工作空间 (Paths.base_dir)")
            log_lines.append(f"  解析结果: {result}")
    else:
        log_lines.append("  ✗ EVOFLOW_HOME 未设置，回退到优先级 3: 全局工作空间")
        result = str(get_paths().base_dir)
        log_lines.append("  ✓ 使用优先级 3: 全局工作空间 (Paths.base_dir)")
        log_lines.append(f"  解析结果: {result}")

    return result


def _build_subagent_workspace_section(thread_data: dict, project_workspace_path: str | None = None) -> str:
    """Build workspace info section for subagent system prompt.

    Args:
        thread_data: Thread data (not used for workspace path in LOCAL_HOST mode).
        project_workspace_path: Project runtime workspace path (from session context).

    Returns:
        Formatted workspace section string.
    """
    # 使用项目运行工作空间路径
    effective_root = _resolve_effective_root(project_workspace_path)
    # 用户工作目录 = 项目绑定根；uploads/outputs 为其直接子目录（与 prompt / Evopanel 一致）
    workspace_path = effective_root
    uploads_path = f"{effective_root}/uploads"
    outputs_path = f"{effective_root}/outputs"

    # 详细日志：记录工作空间目录信息
    log_lines = []
    log_lines.append("【子智能体工作空间区域构建】")
    log_lines.append(f"  输入的 thread_data: {'存在' if thread_data else '无/空'}")
    log_lines.append(f"  输入的项目运行工作空间: {project_workspace_path!r}")
    log_lines.append(f"  解析的根目录: {effective_root}")
    log_lines.append(f"  uploads 路径: {uploads_path}")
    log_lines.append(f"  workspace 路径: {workspace_path}")
    log_lines.append(f"  outputs 路径: {outputs_path}")

    # 检查目录是否存在
    import os as _os

    log_lines.append(f"  根目录是否存在: {_os.path.exists(effective_root)}")
    log_lines.append(f"  uploads 是否存在: {_os.path.exists(uploads_path)}")
    log_lines.append(f"  workspace 是否存在: {_os.path.exists(workspace_path)}")
    log_lines.append(f"  outputs 是否存在: {_os.path.exists(outputs_path)}")

    # 日志：记录工作空间目录路径
    logger.info(f"[Subagent Workspace] effective_root={effective_root}, uploads={uploads_path}, workspace={workspace_path}, outputs={outputs_path}")

    # Detect OS
    if sys.platform == "win32":
        os_label = "Windows (win32)"
        shell_label = "PowerShell / cmd"
    elif sys.platform == "darwin":
        os_label = "macOS (darwin)"
        shell_label = "bash / zsh"
    else:
        os_label = f"Linux/Unix ({sys.platform})"
        shell_label = "bash / zsh"

    now_str = format_runtime_now_for_prompt()

    return f"""<workspace>
你与主智能体共享同一个工作空间，以下是当前会话的工作目录信息：

| 项目路径/环境 | 值 |
|---|---|
| **用户工作目录** | `{workspace_path}` |
| **操作系统** | `{os_label}` |
| **Shell** | `{shell_label}` |
| **当前系统时间** | `{now_str}` |
</workspace>"""


def _collect_tool_names_from_stream_message(message: object) -> list[str]:
    """Best-effort extraction of tool names from stream message payload."""
    out: list[str] = []
    seen: set[str] = set()

    def _push(v: object) -> None:
        name = str(v or "").strip()
        if not name or name in seen:
            return
        seen.add(name)
        out.append(name)

    try:
        if isinstance(message, dict):
            # Common schema: {"tool_calls":[{"name":"web_search", ...}]}
            tcs = message.get("tool_calls")
            if isinstance(tcs, list):
                for tc in tcs:
                    if isinstance(tc, dict):
                        _push(tc.get("name") or tc.get("tool_name"))

            # LangChain content blocks may also include tool metadata
            content = message.get("content")
            if isinstance(content, list):
                for block in content:
                    if not isinstance(block, dict):
                        continue
                    if str(block.get("type") or "").lower() in {"tool_call", "tool_use"}:
                        _push(block.get("name") or block.get("tool_name"))
        # Non-dict messages are ignored.
    except Exception:
        return out
    return out


def _normalize_tool_output_content(v: object) -> str:
    if v is None:
        return ""
    if isinstance(v, str):
        return v
    try:
        return json.dumps(v, ensure_ascii=False)
    except Exception:
        return str(v)


def _claude_session_meta_from_subagent_stream(stream_messages: list[Any] | None) -> tuple[str | None, str | None]:
    """Parse ``claude_session`` ToolMessage payloads for ``session_id`` and ``log_path`` (last wins)."""
    last_sid: str | None = None
    last_log: str | None = None
    for msg in stream_messages or []:
        if not isinstance(msg, dict):
            continue
        m_type = str(msg.get("type") or msg.get("role") or "").strip().lower()
        if m_type != "tool":
            continue
        name = str(msg.get("name") or msg.get("tool_name") or "").strip()
        if name != "claude-code":
            continue
        raw = msg.get("content")
        data: Any = None
        if isinstance(raw, dict):
            data = raw
        elif isinstance(raw, str):
            s = raw.strip()
            if s.startswith("{"):
                try:
                    data = json.loads(s)
                except Exception:
                    continue
        if not isinstance(data, dict):
            continue
        sid = str(data.get("session_id") or "").strip()
        if sid:
            last_sid = sid
        lp = data.get("log_path")
        if isinstance(lp, str) and lp.strip():
            last_log = lp.strip()
    return last_sid, last_log


def _extract_tool_events_from_stream_message(message: object) -> list[dict[str, Any]]:
    """Extract realtime tool call/result events with input/output."""
    out: list[dict[str, Any]] = []
    if not isinstance(message, dict):
        return out
    try:
        tcs = message.get("tool_calls")
        if isinstance(tcs, list):
            for tc in tcs:
                if not isinstance(tc, dict):
                    continue
                name = str(tc.get("name") or tc.get("tool_name") or "").strip()
                if not name:
                    continue
                tool_call_id = str(tc.get("id") or tc.get("tool_call_id") or "").strip()
                args = tc.get("args")
                if args is None:
                    fn = tc.get("function")
                    if isinstance(fn, dict):
                        raw = fn.get("arguments")
                        if isinstance(raw, str):
                            try:
                                args = json.loads(raw)
                            except Exception:
                                args = {"raw": raw}
                        elif isinstance(raw, dict):
                            args = raw
                if not isinstance(args, dict):
                    args = {}
                out.append(
                    {
                        "phase": "call",
                        "name": name,
                        "toolCallId": tool_call_id,
                        "input": args,
                    }
                )

        m_type = str(message.get("type") or message.get("role") or "").strip().lower()
        if m_type == "tool":
            name = str(message.get("name") or message.get("tool_name") or "").strip()
            if name:
                out.append(
                    {
                        "phase": "result",
                        "name": name,
                        "toolCallId": str(message.get("tool_call_id") or message.get("id") or "").strip(),
                        "output": _normalize_tool_output_content(message.get("content")),
                    }
                )
    except Exception:
        return out
    return out


def _extract_stream_text_preview(message: object, max_len: int = 600) -> str:
    """Best-effort compact text preview from a stream message."""
    if message is None:
        return ""
    if isinstance(message, str):
        return message.strip()[:max_len]
    if not isinstance(message, dict):
        return str(message).strip()[:max_len]
    try:
        m = message
        m_type = str(m.get("type") or m.get("role") or "").strip().lower()
        # Tool result: keep a compact one-line marker + output preview.
        if m_type == "tool":
            name = str(m.get("name") or m.get("tool_name") or "tool").strip() or "tool"
            out = _normalize_tool_output_content(m.get("content")).replace("\n", " ").strip()
            if not out:
                return f"[tool] {name}"[:max_len]
            return f"[tool] {name}: {out}"[:max_len]

        content = m.get("content")
        if isinstance(content, str):
            return content.strip()[:max_len]
        if isinstance(content, list):
            parts: list[str] = []
            for block in content:
                if isinstance(block, str):
                    s = block.strip()
                    if s:
                        parts.append(s)
                    continue
                if isinstance(block, dict):
                    b_type = str(block.get("type") or "").strip().lower()
                    if b_type == "text":
                        t = block.get("text")
                        if isinstance(t, str) and t.strip():
                            parts.append(t.strip())
            merged = " ".join(parts).strip()
            if merged:
                return merged[:max_len]
    except Exception:
        return ""
    return ""


def _append_subtask_conversation_replica(
    main_task_id: str,
    subtask_id: str,
    message: object,
    message_index: int,
    *,
    parent_thread_id: str | None = None,
    run_id: str | None = None,
    default_model_name: str | None = None,
) -> None:
    """Persist subtask stream on the main task (same store as main chat transcript)."""
    from evoflow.collab.conversation_persist import append_collab_subtask_stream_message

    append_collab_subtask_stream_message(
        main_task_id,
        subtask_id,
        message,
        message_index,
        parent_thread_id=parent_thread_id,
        run_id=run_id,
        default_model_name=default_model_name,
    )


def _schedule_collab_followup_wave(runtime: ToolRuntime[ContextT, dict] | None, main_task_id: str) -> None:
    """Start DAG follow-up delegation without blocking the task_tool poll loop."""
    from evoflow.collab.dag_trace import dag_info
    from evoflow.tools.builtins.collab_bridge import schedule_followup_wave_needed

    mid = str(main_task_id or "").strip()
    if not mid:
        return
    dag_info("task_tool_schedule_followup main=%s caller_runtime=%s", mid, runtime is not None)
    schedule_followup_wave_needed(runtime, mid)


async def _finalize_collab_subtask_terminal(
    *,
    executor_outcome: str,
    result: SubagentResult,
    resolved_collab: str,
    resolved_subtask: str,
    stream_task_id: str,
    writer: Any,
    ws: Any,
    runtime: ToolRuntime[ContextT, dict] | None = None,
    executor_subagent_type: str | None = None,
) -> tuple[str, str]:
    """Return (terminal_kind, message_for_task_tool_caller). Uses worker report when present."""
    from evoflow.collab.peer.wake_context import pop_peer_wake_context
    from evoflow.collab.subtask_outcome import apply_subtask_system_outcome, is_subtask_outcome_reported

    storage = get_project_storage()

    def _collab_background_run_superseded() -> bool:
        """Skip terminal persistence when lead interrupt/steer replaced this background run."""
        st_live = find_subtask_by_ids(storage, resolved_collab, resolved_subtask) or {}
        cur_bg = str(st_live.get("background_task_id") or "").strip()
        run_bg = str(stream_task_id or "").strip()
        if not run_bg:
            return False
        if not cur_bg:
            return True
        if cur_bg != run_bg:
            return True
        superseded = str(st_live.get("superseded_background_task_id") or "").strip()
        return bool(superseded and superseded == run_bg)

    if _collab_background_run_superseded():
        logger.info(
            "collab subtask finalize skipped (superseded run) main=%s sub=%s bg=%s",
            resolved_collab,
            resolved_subtask,
            stream_task_id,
        )
        return "superseded", "Background run superseded by lead interrupt/steer."

    wake_ctx = pop_peer_wake_context(resolved_collab, resolved_subtask)
    if wake_ctx is not None:
        try:
            from evoflow.collab.peer.scheduler import drain_peer_wake_queue

            drain_peer_wake_queue(storage, resolved_collab, resolved_subtask)
        except Exception:
            pass
        return "peer_round", "Peer collaboration round finished."

    st = find_subtask_by_ids(storage, resolved_collab, resolved_subtask) or {}
    from evoflow.collab.subtask_outcome import get_subtask_task_report

    body = get_subtask_task_report(st) or str(result.result or result.error or "").strip()

    if is_subtask_outcome_reported(st):
        st = find_subtask_by_ids(storage, resolved_collab, resolved_subtask) or st
        status = str(st.get("status") or "").strip().lower()
        err = str(st.get("error") or "").strip()
        if status in {"completed", "done"}:
            if writer:
                writer(
                    ws(
                        {
                            "type": "task_completed",
                            "task_id": stream_task_id,
                            "collab_subtask_id": resolved_subtask,
                            "result": body[:12000],
                        }
                    )
                )
            # Follow-up already scheduled when subtask_outcome_report succeeded; do not wait for post-report chat.
            return "completed", f"Task Succeeded (subtask_outcome_report). Result: {body[:4000]}"
        if status == "timed_out":
            if writer:
                writer(ws({"type": "task_timed_out", "task_id": stream_task_id, "error": err or body}))
            return "timed_out", f"Task timed out. {err or body}"
        if status == "cancelled":
            if writer:
                writer(ws({"type": "task_cancelled", "task_id": stream_task_id, "error": err or body}))
            return "cancelled", f"Task cancelled. {err or body}"
        if writer:
            writer(ws({"type": "task_failed", "task_id": stream_task_id, "error": err or body}))
        return "failed", f"Task failed. {err or body}"

    ex = str(executor_outcome or "").strip().lower()
    draft = str(result.result or "").strip()
    err = str(result.error or "").strip()

    if ex == "completed":

        st_row = find_subtask_by_ids(storage, resolved_collab, resolved_subtask) or {}
        assigned = str(st_row.get("assigned_to") or "").strip()
        profile_base = ""
        wp = st_row.get("worker_profile")
        if isinstance(wp, dict):
            profile_base = str(wp.get("base_subagent") or "").strip()
        can_auto = collab_executor_allows_auto_outcome_without_report(
            executor_subagent_type,
            assigned,
            profile_base,
        )

        if can_auto and (draft or body):
            summary = (draft or body)[:8000]
            await apply_subtask_system_outcome(
                main_task_id=resolved_collab,
                subtask_id=resolved_subtask,
                outcome="completed",
                summary=summary,
            )
            if writer:
                writer(
                    ws(
                        {
                            "type": "task_completed",
                            "task_id": stream_task_id,
                            "collab_subtask_id": resolved_subtask,
                            "result": summary[:12000],
                        }
                    )
                )
            _schedule_collab_followup_wave(runtime, resolved_collab)
            return "completed", f"Task Succeeded (auto). Result: {summary[:4000]}"

        await apply_subtask_system_outcome(
            main_task_id=resolved_collab,
            subtask_id=resolved_subtask,
            outcome="failed",
            summary=draft or "子智能体回合结束",
            error="未调用 subtask_outcome_report；模型返回结束不能视为子任务完成。",
        )
        if writer:
            writer(
                ws(
                    {
                        "type": "task_failed",
                        "task_id": stream_task_id,
                        "collab_subtask_id": resolved_subtask,
                        "error": "未调用 subtask_outcome_report",
                    }
                )
            )
        return (
            "failed",
            "Task failed. Subagent finished its turn without calling subtask_outcome_report. You must call subtask_outcome_report(completed|failed, summary=...) before ending.",
        )

    sys_outcome = ex if ex in {"failed", "timed_out", "cancelled", "blocked"} else "failed"
    await apply_subtask_system_outcome(
        main_task_id=resolved_collab,
        subtask_id=resolved_subtask,
        outcome=sys_outcome,
        summary=draft or err or f"子智能体异常结束 ({sys_outcome})",
        error=err or None,
    )
    if sys_outcome == "timed_out":
        if writer:
            writer(ws({"type": "task_timed_out", "task_id": stream_task_id, "error": err}))
        return "timed_out", f"Task timed out. Error: {err}"
    if sys_outcome == "cancelled":
        if writer:
            writer(ws({"type": "task_cancelled", "task_id": stream_task_id, "error": err}))
        return "cancelled", f"Task cancelled. {err or ''}"
    if writer:
        writer(ws({"type": "task_failed", "task_id": stream_task_id, "error": err or draft}))
    return "failed", f"Task failed. Error: {err or draft}"


@tool("subagent", description=SUBAGENT_TOOL_DESCRIPTION, parse_docstring=False)
async def task_tool(
    runtime: ToolRuntime[ContextT, ThreadState],
    description: str,
    prompt: str,
    subagent_type: str,
    tool_call_id: Annotated[str, InjectedToolCallId],
    max_turns: int | None = None,
    collab_task_id: str | None = None,
    collab_subtask_id: str | None = None,
    detach: bool = False,
    new_claude_session: bool = False,
    stream: bool = True,
) -> str:
    """Delegate work to a specialized subagent (policy in tool description)."""
    available_subagent_names = get_available_subagent_names()

    thread_id = None
    if runtime is not None:
        thread_id = runtime.context.get("thread_id") if runtime.context else None
        if thread_id is None:
            thread_id = runtime.config.get("configurable", {}).get("thread_id")

    resolved_collab = (collab_task_id or "").strip() or None
    if not resolved_collab and runtime is not None and runtime.context:
        ctx_ct = runtime.context.get("collab_task_id")
        if ctx_ct:
            resolved_collab = str(ctx_ct).strip() or None

    # Same-run stale context: authorize/start_execution writes bound_task_id to collab_state.json only.
    if not resolved_collab and thread_id:
        try:
            disk = load_thread_collab_state(get_paths(), str(thread_id))
            if disk.collab_phase == CollabPhase.EXECUTING:
                bt = str(disk.bound_task_id or "").strip()
                if bt:
                    resolved_collab = bt
        except Exception:
            pass

    resolved_subtask = (collab_subtask_id or "").strip() or None
    if not resolved_subtask and runtime is not None and runtime.context:
        ctx_st = runtime.context.get("collab_subtask_id")
        if ctx_st:
            resolved_subtask = str(ctx_st).strip() or None

    if resolved_subtask and not resolved_collab:
        return "Error: collab_subtask_id requires collab_task_id (or runtime context collab_task_id)."

    if resolved_collab:
        gate = collab_execution_gate_error(resolved_collab, thread_id)
        if gate:
            return gate

    collab_project_id: str | None = None
    collab_agent_for_memory = ""
    collab_memory_task_id: str | None = None
    profile_model: WorkerProfile | None = None
    execution_thread_id = thread_id
    collab_sub_row: dict | None = None
    collab_lead_thread_id: str | None = None
    collab_main_task_row: dict[str, Any] | None = None
    if resolved_collab:
        collab_storage = get_project_storage()
        cm = find_main_task(collab_storage, resolved_collab)
        if cm:
            proj, main_task = cm
            collab_main_task_row = main_task if isinstance(main_task, dict) else None
            collab_project_id = proj["id"]
            if resolved_subtask:
                sub_row = find_subtask_by_ids(collab_storage, resolved_collab, resolved_subtask)
                if not sub_row:
                    return f"Error: subtask {resolved_subtask!r} not found under collaborative task {resolved_collab!r}."
                collab_sub_row = sub_row
                collab_memory_task_id = resolved_subtask
                collab_agent_for_memory = (sub_row.get("assigned_to") or main_task.get("assigned_to") or "") or ""
                from evoflow.collab.thread_ids import (
                    collab_subtask_executor_thread_id,
                    normalize_collab_executor_thread_id,
                    normalize_lead_thread_id,
                    resolve_subtask_executor_thread_id,
                )

                lead_thread = normalize_lead_thread_id(main_task.get("thread_id")) or normalize_lead_thread_id(thread_id) or ""
                collab_lead_thread_id = lead_thread or None
                stored_sub_tid = str(sub_row.get("subtask_thread_id") or "").strip()
                subtask_thread_id = resolve_subtask_executor_thread_id(
                    lead_thread,
                    resolved_subtask,
                    stored_subtask_thread_id=stored_sub_tid or None,
                )
                if not subtask_thread_id:
                    subtask_thread_id = collab_subtask_executor_thread_id(lead_thread, resolved_subtask)
                normalized = normalize_collab_executor_thread_id(subtask_thread_id)
                if normalized != subtask_thread_id:
                    subtask_thread_id = normalized
                if subtask_thread_id != stored_sub_tid:
                    patch_collab_subtask_in_project_storage(
                        collab_storage,
                        resolved_collab,
                        resolved_subtask,
                        {"subtask_thread_id": subtask_thread_id},
                    )
                elif not stored_sub_tid and subtask_thread_id:
                    patch_collab_subtask_in_project_storage(
                        collab_storage,
                        resolved_collab,
                        resolved_subtask,
                        {"subtask_thread_id": subtask_thread_id},
                    )
                execution_thread_id = subtask_thread_id
                wp = sub_row.get("worker_profile")
                if wp:
                    try:
                        if isinstance(wp, dict) and "base_subagent" not in wp:
                            wp = {**wp, "base_subagent": subagent_type}
                        profile_model = WorkerProfile.model_validate(wp)
                    except ValidationError as e:
                        return f"Error: invalid worker_profile in storage for subtask {resolved_subtask!r}: {e}"
            else:
                collab_memory_task_id = resolved_collab
                collab_agent_for_memory = (main_task.get("assigned_to") or "") or ""

    # Plain subagent (and collab without subtask_id): isolate checkpoint + transcript on
    # ``{lead}__sub__{tool_call_id}`` instead of reusing the lead LangGraph thread.
    if not (resolved_collab and resolved_subtask):
        from evoflow.collab.thread_ids import (
            collab_subtask_executor_thread_id,
            normalize_lead_thread_id,
        )

        lead_for_exec = (
            collab_lead_thread_id
            or normalize_lead_thread_id(thread_id)
            or str(thread_id or "").strip()
        )
        tc = str(tool_call_id or "").strip()
        if tc:
            execution_thread_id = collab_subtask_executor_thread_id(lead_for_exec, tc)

    from evoflow.agents.lead_agent.runtime_context import (
        resolve_session_model_name_from_runtime,
        runtime_context_mapping,
    )
    from evoflow.collab.thread_ids import normalize_lead_thread_id as _normalize_lead_tid

    _ctx_for_model = runtime_context_mapping(runtime) if runtime is not None else {}
    parent_model = resolve_session_model_name_from_runtime(
        runtime,
        lead_thread_id=collab_lead_thread_id or _normalize_lead_tid(thread_id),
        session_key=str(_ctx_for_model.get("session_key") or "").strip() or None,
        pinned_model_name=str((collab_main_task_row or {}).get("session_model_name") or "").strip() or None,
    )
    if parent_model:
        logger.info(
            "task_tool subagent model=%r collab=%s sub=%s lead_thread=%s",
            parent_model,
            resolved_collab or "-",
            resolved_subtask or "-",
            collab_lead_thread_id or _normalize_lead_tid(thread_id) or "-",
        )

    _collab_stream_scope: dict[str, str] = {}
    if resolved_collab and resolved_subtask:
        _collab_stream_scope = {
            "collab_task_id": resolved_collab,
            "collab_subtask_id": resolved_subtask,
        }

    def _ws(ev: dict) -> dict:
        return {**ev, **_collab_stream_scope} if _collab_stream_scope else ev

    async def _persist_collab_task_memory(outcome: str, r: SubagentResult) -> None:
        if collab_project_id is None or not collab_memory_task_id:
            return
        from evoflow.collab.sse_notify import broadcast_collab_task_event

        mem_store = get_task_memory_storage()
        if outcome == "completed":
            ok, facts_count = persist_task_memory_after_subagent_run(
                mem_store,
                collab_project_id,
                collab_agent_for_memory,
                collab_memory_task_id,
                outcome="completed",
                output_summary=(r.result or ""),
                current_step="Subagent completed",
                progress=100,
                source_ref=tool_call_id,
            )
            prog, step = 100, "Subagent completed"
        elif outcome == "failed":
            ok, facts_count = persist_task_memory_after_subagent_run(
                mem_store,
                collab_project_id,
                collab_agent_for_memory,
                collab_memory_task_id,
                outcome="failed",
                output_summary=(r.error or ""),
                current_step="Subagent failed",
                progress=0,
                source_ref=tool_call_id,
            )
            prog, step = 0, "Subagent failed"
        elif outcome == "cancelled":
            ok, facts_count = persist_task_memory_after_subagent_run(
                mem_store,
                collab_project_id,
                collab_agent_for_memory,
                collab_memory_task_id,
                outcome="cancelled",
                output_summary=(r.error or ""),
                current_step="Subagent cancelled",
                progress=0,
                source_ref=tool_call_id,
            )
            prog, step = 0, "Subagent cancelled"
        else:
            ok, facts_count = persist_task_memory_after_subagent_run(
                mem_store,
                collab_project_id,
                collab_agent_for_memory,
                collab_memory_task_id,
                outcome="timed_out",
                output_summary=(r.error or ""),
                current_step="Subagent timed out",
                progress=0,
                source_ref=tool_call_id,
            )
            prog, step = 0, "Subagent timed out"

        # 同步项目 JSON 中的子任务行（任务侧栏 / GET /api/tasks 读的是这里，不仅 task_memory）
        if resolved_subtask and resolved_collab:
            try:
                pst = get_project_storage()
                mem_store2 = get_task_memory_storage()
                if outcome == "completed":
                    persist_subtask_runtime_snapshot(
                        pst,
                        mem_store2,
                        resolved_collab,
                        resolved_subtask,
                        status="completed",
                        progress=100,
                    )
                elif outcome == "failed":
                    persist_subtask_runtime_snapshot(
                        pst,
                        mem_store2,
                        resolved_collab,
                        resolved_subtask,
                        status="failed",
                        progress=0,
                        error=(r.error or "")[:2000],
                    )
                elif outcome == "cancelled":
                    persist_subtask_runtime_snapshot(
                        pst,
                        mem_store2,
                        resolved_collab,
                        resolved_subtask,
                        status="cancelled",
                        progress=0,
                        error=(r.error or "")[:2000],
                    )
                elif outcome == "timed_out":
                    persist_subtask_runtime_snapshot(
                        pst,
                        mem_store2,
                        resolved_collab,
                        resolved_subtask,
                        status="timed_out",
                        progress=0,
                        error=(r.error or "")[:2000],
                    )
                else:
                    persist_subtask_runtime_snapshot(
                        pst,
                        mem_store2,
                        resolved_collab,
                        resolved_subtask,
                        status="failed",
                        progress=0,
                        error=f"unknown outcome: {outcome}",
                    )
                # depends_on 链：上游子任务已落库终态后，由后端自动启动下一波可运行子任务
                _schedule_collab_followup_wave(runtime, resolved_collab)
            except Exception:
                logger.exception(
                    "sync collab subtask row after subagent outcome=%s main=%s sub=%s",
                    outcome,
                    resolved_collab,
                    resolved_subtask,
                )

        if not ok or not resolved_collab:
            return
        tid = collab_memory_task_id
        await broadcast_collab_task_event(resolved_collab, "task:progress", {"task_id": tid, "progress": prog, "current_step": step})
        await broadcast_collab_task_event(resolved_collab, "task_detail:updated", {"task_id": tid, "facts_count": facts_count})
        if outcome == "completed":
            await broadcast_collab_task_event(resolved_collab, "task:completed", {"task_id": tid, "result": (r.result or "")[:4000]})
        elif outcome == "failed":
            await broadcast_collab_task_event(resolved_collab, "task:failed", {"task_id": tid, "error": (r.error or "")[:4000]})
        elif outcome == "timed_out":
            await broadcast_collab_task_event(resolved_collab, "task:timed_out", {"task_id": tid, "error": (r.error or "")[:4000]})
        elif outcome == "cancelled":
            await broadcast_collab_task_event(resolved_collab, "task:cancelled", {"task_id": tid, "error": (r.error or "")[:4000]})

    effective_subagent_type = _resolve_effective_subagent_type(subagent_type)
    if profile_model and profile_model.base_subagent:
        effective_subagent_type = _resolve_effective_subagent_type(str(profile_model.base_subagent).strip())
    if is_claude_code_subagent_type(effective_subagent_type):
        try:
            from evoflow.platform.asyncio_windows import claude_session_subprocess_supported

            if not claude_session_subprocess_supported():
                logger.info(
                    "task_tool: claude-code unavailable on Selector loop; using general-purpose subagent"
                )
                effective_subagent_type = "general-purpose"
        except Exception:
            logger.debug("task_tool: claude subprocess capability check failed", exc_info=True)

    config = get_subagent_config(effective_subagent_type)
    if config is None:
        available = ", ".join(available_subagent_names)
        return f"Error: Unknown subagent type '{effective_subagent_type}'. Available: {available}"
    if effective_subagent_type == "bash" and not is_host_bash_allowed():
        return f"Error: {LOCAL_BASH_SUBAGENT_DISABLED_MESSAGE}"

    # Extract parent context from runtime
    sandbox_state = None
    thread_data = None
    parent_model = None
    trace_id = None
    project_workspace_path = None
    parent_local_workspace_root: str | None = None

    if runtime is not None:
        sandbox_state = runtime.state.get("sandbox")
        thread_data = runtime.state.get("thread_data")
        if thread_id is None:
            thread_id = runtime.context.get("thread_id") if runtime.context else None
            if thread_id is None:
                thread_id = runtime.config.get("configurable", {}).get("thread_id")

        metadata = runtime.config.get("metadata", {})
        trace_id = metadata.get("trace_id") or make_trace_id()

        # 获取项目运行工作空间路径（与主模型 search_code_index 使用同一索引根）
        configurable = runtime.config.get("configurable", {})
        ctx_map = runtime_context_mapping(runtime)
        parent_local_workspace_root = str(ctx_map.get("local_workspace_root") or "").strip() or str(configurable.get("local_workspace_root") or "").strip() or None
        if not parent_local_workspace_root and thread_id:
            from evoflow.tools.host_direct.workspace_context import load_local_workspace_root_for_thread

            parent_local_workspace_root = load_local_workspace_root_for_thread(thread_id) or None
        project_workspace_path = parent_local_workspace_root

        # 日志：记录从 runtime 获取工作空间路径的过程
        log_lines = []
        log_lines.append("【Task Tool - 工作空间路径提取】")
        log_lines.append(f"  线程 ID: {thread_id!r}")
        log_lines.append(f"  Runtime state 键列表: {list(runtime.state.keys()) if runtime.state else '无'}")
        log_lines.append(f"  Runtime context 键列表: {list(ctx_map.keys()) if ctx_map else '无'}")
        log_lines.append(f"  Configurable 键列表: {list(configurable.keys()) if configurable else '无'}")
        log_lines.append(f"  父会话 local_workspace_root: {parent_local_workspace_root!r}")
        log_lines.append("  注: 子智能体工具上下文将继承该根目录，避免仅按 SubThread 沙箱建索引导致搜不到")

    from evoflow.collab.worker_tool_allowlist import (
        resolve_worker_tool_allowlist,
        session_tool_context_from_runtime,
    )
    from evoflow.tools import get_available_tools

    tools = get_available_tools(model_name=parent_model, subagent_enabled=False)
    tools = [t for t in tools if str(getattr(t, "name", "") or "").strip().lower() not in _SUBAGENT_FORBIDDEN_TOOLS]
    allowed_tool_names: set[str] = set()
    for t in tools:
        if isinstance(t, str):
            allowed_tool_names.add(t)
        else:
            n = getattr(t, "name", None)
            if n is not None:
                allowed_tool_names.add(str(n))

    overrides: dict = {}
    parent_session_key, parent_session_mode = session_tool_context_from_runtime(runtime)
    assignee_for_tools = str(collab_agent_for_memory or "").strip() or None
    profile_tools = list(profile_model.tools) if profile_model is not None and profile_model.tools is not None else None
    if profile_tools is not None and not profile_tools:
        return (
            "Error: worker_profile.tools is empty after parsing. "
            f"Provide valid tool names from: {sorted(allowed_tool_names)!r}"
        )

    final_tools = resolve_worker_tool_allowlist(
        profile_tools=profile_tools,
        assignee_agent_code=assignee_for_tools,
        base_subagent=effective_subagent_type,
        subagent_config_tools=list(config.tools) if config.tools is not None else None,
        catalog_names=allowed_tool_names,
        session_key=parent_session_key,
        session_mode=parent_session_mode,
    )
    if profile_tools is not None and not final_tools:
        return (
            f"Error: worker_profile.tools has no valid tool names after validation. "
            f"Requested: {profile_tools!r}; available: {sorted(allowed_tool_names)!r}"
        )
    if not final_tools:
        return (
            "Error: could not resolve a tool allowlist for this subagent "
            f"(assignee={assignee_for_tools!r}, base={effective_subagent_type!r})."
        )
    overrides["tools"] = final_tools

    # 子智能体：WorkerProfile 显式传 skills 时优先；否则从 assigned_to / base AgentConfig 读取
    skills_from_profile = profile_model is not None and profile_model.skills is not None
    skills_kw: set[str] = set()
    if skills_from_profile:
        skills_kw = {str(s).strip() for s in (profile_model.skills or []) if str(s).strip()}

    final_skills: set[str] = set(skills_kw)

    if profile_model is not None and profile_model.model is not None:
        parent_model = profile_model.model
        logger.info(f"Overriding model to {profile_model.model} from WorkerProfile")

    if not skills_from_profile:
        skills_agent_code = assignee_for_tools or effective_subagent_type
        try:
            ac = load_agent_config(skills_agent_code)
        except (FileNotFoundError, ValueError):
            ac = None
        if ac is not None and ac.skills is not None:
            try:
                from evoflow.skills import load_skills as _load_skills_enabled

                enabled_names = {s.name for s in _load_skills_enabled(enabled_only=True)}
            except Exception:
                logger.warning("load_skills failed for subagent yaml skill overlay", exc_info=True)
                enabled_names = set()
            final_skills = {str(x).strip() for x in ac.skills if str(x).strip() and str(x).strip() in enabled_names}
            if final_skills:
                logger.info(
                    "Loaded skills from AgentConfig for %s: %s",
                    skills_agent_code,
                    sorted(final_skills),
                )
    if not final_skills:
        logger.info("Subagent '%s' using no skills (default)", effective_subagent_type)

    if resolved_collab and resolved_subtask:
        merged = _merge_collab_subtask_tool_allowlist(
            overrides_tools=overrides.get("tools"),
            final_tools=final_tools,
            allowed_tool_names=allowed_tool_names,
        )
        if merged is not None:
            overrides["tools"] = merged
    if max_turns is not None:
        try:
            mt = int(max_turns)
            if mt > 0:
                overrides["max_turns"] = mt
        except (TypeError, ValueError):
            logger.warning("Invalid max_turns=%r ignored in task_tool", max_turns)

    # 构建 system_prompt（只构建一次，避免重复）
    system_prompt = config.system_prompt

    _pl: str | None = None
    if runtime is not None and runtime.context:
        meta = runtime.context.get("evf_dynamic_prompt_meta")
        if isinstance(meta, dict):
            _pl = meta.get("prompt_language")
        if not _pl:
            _pl = runtime.context.get("prompt_language")
    _pl = resolve_prompt_language(_pl)

    # 1. 添加 skills 部分
    if final_skills is not None:
        skills_section = get_skills_prompt_section(final_skills, prompt_language=_pl)
        if skills_section:
            system_prompt = system_prompt + "\n\n" + skills_section

    # 2. 添加 WorkerProfile 的 instruction
    if profile_model and profile_model.instruction:
        system_prompt = system_prompt + "\n\n" + profile_model.instruction

    # 3. 添加工作空间信息（必须始终包含）
    if thread_data or project_workspace_path:
        workspace_section = _build_subagent_workspace_section(thread_data, project_workspace_path)
        if workspace_section:
            system_prompt = system_prompt + "\n\n" + workspace_section

    if resolved_collab and resolved_subtask:
        try:
            from evoflow.collab.subtask_outcome import format_subtask_outcome_mandate_block
            from evoflow.collab.task_progress import format_subtask_progress_mandate_block

            system_prompt = system_prompt + "\n\n" + format_subtask_progress_mandate_block()
            system_prompt = system_prompt + "\n\n" + format_subtask_outcome_mandate_block()
        except Exception:
            logger.debug("task_tool: collab mandate blocks skipped", exc_info=True)
        system_prompt = (
            system_prompt
            + f"\n\n<collab_scope>\nmain_task_id: {resolved_collab}\nsubtask_id: {resolved_subtask}\n"
            + "调用 `subtask_progress_report` / `subtask_outcome_report` / `subtask_work_checklist` 时通常无需再传 ID（运行时已注入）；若仍报错请显式传入上述 ID。\n"
            + "</collab_scope>"
        )

    overrides["system_prompt"] = system_prompt
    # Re-apply merged overrides after AgentConfig fallback resolution.
    # Without this second replace(), final_tools/final_skills updates stay in `overrides`
    # but never reach the executor config.
    if overrides:
        config = replace(config, **overrides)

    subagent_extra_context: dict[str, Any] | None = None
    from evoflow.collab.thread_ids import normalize_lead_thread_id

    parent_tid_for_subagent = (
        collab_lead_thread_id
        or normalize_lead_thread_id(thread_id)
        or str(thread_id or "").strip()
    )
    if parent_tid_for_subagent:
        subagent_extra_context = dict(subagent_extra_context or {})
        subagent_extra_context["parent_thread_id"] = parent_tid_for_subagent
    if resolved_collab and resolved_subtask:
        subagent_extra_context = dict(subagent_extra_context or {})
        subagent_extra_context.update(
            {
                "collab_task_id": resolved_collab,
                "collab_subtask_id": resolved_subtask,
            },
        )
        if collab_lead_thread_id:
            subagent_extra_context["parent_thread_id"] = collab_lead_thread_id
    if is_claude_code_subagent_type(effective_subagent_type):
        ctx_extra: dict[str, Any] = dict(subagent_extra_context or {})
        if collab_sub_row is not None and resolved_collab and resolved_subtask:
            if not new_claude_session:
                rsid_row = str(collab_sub_row.get("claude_session_id") or collab_sub_row.get("external_session_id") or "").strip()
                if rsid_row:
                    ctx_extra["claude_session_reuse_session_id"] = rsid_row
        if not new_claude_session and "claude_session_reuse_session_id" not in ctx_extra:
            cached = _default_claude_session_id_for_thread(execution_thread_id)
            if cached:
                ctx_extra["claude_session_reuse_session_id"] = cached
        if ctx_extra:
            subagent_extra_context = ctx_extra

    # Lead-graph stream writer: same ``task_*`` custom events as main chat (LangGraph + gateway SSE).
    parent_chat_writer = None
    if resolved_collab:
        from evoflow.collab.unified_stream import resolve_collab_parent_stream_writer

        parent_chat_writer = resolve_collab_parent_stream_writer(
            runtime=runtime,
            main_task_id=resolved_collab,
            thread_id=execution_thread_id or thread_id,
        )
        if resolved_subtask:
            try:
                from evoflow.collab.subtask_stream_trace import stream_info

                stream_info(
                    "task_tool_collab_start main=%s sub=%s exec_thread=%s lead=%s bg_task=%s writer=%s stream_flag=%s",
                    resolved_collab,
                    resolved_subtask,
                    execution_thread_id or "-",
                    collab_lead_thread_id or "-",
                    tool_call_id,
                    bool(parent_chat_writer),
                    stream is not False,
                )
            except Exception:
                pass
    else:
        try:
            parent_chat_writer = get_stream_writer()
        except Exception:
            parent_chat_writer = None
        if parent_chat_writer is None and runtime is not None:
            sw = getattr(runtime, "stream_writer", None)
            if callable(sw):
                parent_chat_writer = sw

    # 普通 subagent 委派（非协作子任务）：确保父会话未误留 plan / planning
    if not resolved_collab:
        try:
            from evoflow.agents.middlewares.plan_guard_middleware import session_should_sync_plan_scenario_active
            from evoflow.tools.builtins.scenario_activation import sync_plan_scenario_with_session_policy

            policy_ctx: dict[str, Any] = {}
            if runtime is not None:
                policy_ctx = dict(runtime_context_mapping(runtime))
                conf = runtime.config.get("configurable") or {}
                if isinstance(conf, dict):
                    policy_ctx = {**conf, **policy_ctx}
            if not session_should_sync_plan_scenario_active(configurable=policy_ctx or None):
                sync_plan_scenario_with_session_policy(
                    session_mode=str(policy_ctx.get("session_mode") or "") or None,
                    collab_phase=str(policy_ctx.get("collab_phase") or "") or None,
                )
        except Exception:
            logger.debug("subagent: sync_plan_scenario_with_session_policy skipped", exc_info=True)

    from evoflow.subagents.executor import _get_model_name as _resolve_subagent_persist_model

    subtask_persist_model = _resolve_subagent_persist_model(config, parent_model)

    # 子代理继承工作区场景（ContextVar 不跨线程传播，需显式传递）
    try:
        from evoflow.tools.builtins.scenario_activation import get_activated_scenarios

        parent_scenarios = get_activated_scenarios()
        # 子代理不应继承 plan（独占场景）；默认 workspace
        subagent_scenarios = [s for s in parent_scenarios if s != "plan"]
        if not subagent_scenarios:
            subagent_scenarios = ["workspace"]
    except Exception:
        subagent_scenarios = ["workspace"]
    subagent_extra_context = dict(subagent_extra_context or {})
    subagent_extra_context["inherited_scenarios"] = subagent_scenarios

    # Create executor
    executor = SubagentExecutor(
        config=config,
        tools=tools,
        parent_model=parent_model,
        sandbox_state=sandbox_state,
        thread_data=thread_data,
        thread_id=execution_thread_id,
        local_workspace_root=parent_local_workspace_root,
        trace_id=trace_id,
        extra_context=subagent_extra_context,
        parent_chat_stream_writer=parent_chat_writer,
    )

    if resolved_collab and resolved_subtask:
        try:
            persist_subtask_runtime_snapshot(
                get_project_storage(),
                get_task_memory_storage(),
                resolved_collab,
                resolved_subtask,
                status="in_progress",
                progress=max(5, min(95, int((collab_sub_row or {}).get("progress") or 0) or 10)),
                current_step="Subagent executing (await subtask_outcome_report)",
            )
        except Exception:
            logger.debug("task_tool: mark subtask in_progress failed", exc_info=True)

    # Start background execution (always async to prevent blocking)
    # Use tool_call_id as task_id for better traceability
    task_id = executor.execute_async(_trim_subagent_prompt(prompt), task_id=tool_call_id)

    collab_lease_seconds = 180.0
    if resolved_collab and resolved_subtask:
        from evoflow.subagents.runtime_guard import collab_subtask_lease_seconds

        collab_lease_seconds = collab_subtask_lease_seconds(config.timeout_seconds)

    # Poll for task completion in backend (removes need for LLM to poll)
    poll_count = 0
    last_status = None
    last_message_count = 0  # Track how many AI messages we've already sent
    stream_summary_buf = ""
    # Polling cap: (execution timeout + 60s buffer) of wall-clock at _TASK_TOOL_POLL_INTERVAL_SEC steps.
    _TASK_TOOL_POLL_INTERVAL_SEC = 5
    max_poll_count = max(1, (int(config.timeout_seconds) + 60) // _TASK_TOOL_POLL_INTERVAL_SEC)

    logger.info(f"[trace={trace_id}] Started background task {task_id} (subagent={effective_subagent_type}, timeout={config.timeout_seconds}s, polling_limit={max_poll_count} polls)")

    # Same writer as passed into SubagentExecutor for claude-code stream bridging
    original_writer = parent_chat_writer

    # 不再为 subagent task tool 做持久化写盘，避免非法 task_id（如 functions.task:10）
    # 触发 thread_id 校验异常，也减少实时流路径上的 IO。
    stream_events_enabled = stream is not False

    def writer(message: dict[str, Any]) -> None:
        event_type = str(message.get("type") or "unknown")
        if not stream_events_enabled and event_type == "task_running":
            if resolved_collab and resolved_subtask:
                try:
                    from evoflow.collab.subtask_stream_trace import stream_warn

                    stream_warn(
                        "task_running_suppressed stream=false main=%s sub=%s bg_task=%s",
                        resolved_collab,
                        resolved_subtask,
                        task_id,
                    )
                except Exception:
                    pass
            return
        event_task_id = str(message.get("task_id") or task_id)
        if resolved_collab and resolved_subtask:
            try:
                from evoflow.collab.subtask_stream_trace import stream_debug, stream_info, stream_warn

                if not original_writer and event_type.startswith("task_"):
                    stream_warn(
                        "writer_missing type=%s main=%s sub=%s bg_task=%s",
                        event_type,
                        resolved_collab,
                        resolved_subtask,
                        event_task_id,
                    )
                if event_type in ("task_started", "task_completed", "task_failed", "task_timed_out"):
                    stream_info(
                        "task_tool_emit type=%s main=%s sub=%s bg_task=%s has_writer=%s",
                        event_type,
                        resolved_collab,
                        resolved_subtask,
                        event_task_id,
                        original_writer is not None,
                    )
                elif event_type == "task_running":
                    mi = message.get("message_index")
                    if mi in (1, 2, 3) or (isinstance(mi, int) and mi > 0 and mi % 10 == 0):
                        stream_debug(
                            "task_tool_emit type=task_running main=%s sub=%s bg_task=%s idx=%s total=%s has_writer=%s",
                            resolved_collab,
                            resolved_subtask,
                            event_task_id,
                            mi,
                            message.get("total_messages"),
                            original_writer is not None,
                        )
            except Exception:
                pass
        logger.info(
            "[SubtaskStream] task_tool_emit: task_id=%s, event_type=%s",
            event_task_id,
            event_type,
        )
        if original_writer:
            original_writer(message)

        # 桥接到飞书：将子任务流式输出推送到飞书MessageBus
        try:
            from app.channels.feishu_stream_bridge import get_feishu_stream_bridge

            feishu_bridge = get_feishu_stream_bridge()
            if feishu_bridge:
                logger.info(
                    "[SubtaskStream] bridge_forward: task_id=%s, event_type=%s",
                    event_task_id,
                    event_type,
                )
                # Fire-and-forget on the running loop. Use loop.create_task (not asyncio.create_task) so tests that
                # monkeypatch only asyncio.create_task still schedule this coroutine correctly.
                _coro = feishu_bridge.on_subtask_event(message)
                if inspect.isawaitable(_coro):
                    try:
                        asyncio.get_running_loop().create_task(_coro, name=f"feishu_bridge_{task_id}")
                    except RuntimeError:
                        _coro.close()
        except Exception:
            logger.debug("[task_tool] feishu bridge error", exc_info=True)

    # Send Task Started message (unified writer → LangGraph custom + gateway SSE, same as main chat).
    writer(
        _ws(
            {
                "type": "task_started",
                "task_id": task_id,
                "description": description,
                "subagent_type": effective_subagent_type,
            }
        )
    )

    if resolved_collab and resolved_subtask:
        try:
            pst = get_project_storage()
            st0 = find_subtask_by_ids(pst, resolved_collab, resolved_subtask)
            prev_p = 0
            if isinstance(st0, dict):
                try:
                    prev_p = max(0, min(100, int(st0.get("progress") or 0)))
                except (TypeError, ValueError):
                    prev_p = 0
                # If a subtask is already terminal (e.g., manually completed via supervisor),
                # never downgrade it back to executing due to late task start / retry races.
                st0_status = str(st0.get("status") or "").strip().lower()
                if st0_status in {"completed", "failed", "cancelled", "timed_out"}:
                    st0 = None
            patch_collab_subtask_in_project_storage(
                pst,
                resolved_collab,
                resolved_subtask,
                {
                    "status": "executing",
                    "progress": prev_p,
                    "background_task_id": task_id,
                    # Heartbeat lease: backend watchdog will mark timed_out if this stops updating.
                    "last_heartbeat_ts": float(time.time()),
                    "lease_until_ts": float(time.time()) + collab_lease_seconds,
                },
            )
            rollup_root_task_progress_from_subtasks(pst, resolved_collab)
        except Exception:
            logger.exception(
                "mark collab subtask executing failed main=%s sub=%s",
                resolved_collab,
                resolved_subtask,
            )

    detach_effective = bool(detach) and bool(resolved_collab) and bool(resolved_subtask)
    if detach and not detach_effective:
        logger.warning("task_tool: detach=True ignored (requires collab_task_id and collab_subtask_id)")

    def _patch_collab_subtask_heartbeat() -> None:
        if not (resolved_collab and resolved_subtask):
            return
        try:
            pst = get_project_storage()
            st = find_subtask_by_ids(pst, resolved_collab, resolved_subtask) or {}
            cur_status = str(st.get("status") or "").strip().lower()
            if cur_status in {"completed", "failed", "cancelled", "timed_out"}:
                return
            now_ts = float(time.time())
            patch_collab_subtask_in_project_storage(
                pst,
                resolved_collab,
                resolved_subtask,
                {
                    "last_heartbeat_ts": now_ts,
                    "lease_until_ts": now_ts + collab_lease_seconds,
                },
            )
        except Exception:
            logger.debug("task_tool: heartbeat patch failed", exc_info=True)

    async def _poll_subagent_to_completion() -> str:
        nonlocal poll_count, last_status, last_message_count, stream_summary_buf
        _patch_collab_subtask_heartbeat()
        from evoflow.observability.poll_loop_log import log_poll_loop_end, log_poll_loop_start, log_poll_tick

        log_poll_loop_start("task_tool_subagent_poll", task_id=task_id, trace_id=trace_id)
        try:
            while True:
                log_poll_tick("task_tool_subagent_poll", key=task_id, interval_s=30.0, polls=poll_count)
                result = get_background_task_result(task_id)

                if result is None:
                    logger.error(f"[trace={trace_id}] Task {task_id} not found in background tasks")
                    writer(_ws({"type": "task_failed", "task_id": task_id, "error": "Task disappeared from background tasks"}))
                    cleanup_background_task(task_id)
                    return f"Error: Task {task_id} disappeared from background tasks"

                # Log status changes for debugging
                if result.status != last_status:
                    logger.info(f"[trace={trace_id}] Task {task_id} status: {result.status.value}")
                    last_status = result.status

                # 新消息：优先 stream_messages（含 AIMessage + ToolMessage），否则仅 ai_messages
                stream_list = getattr(result, "stream_messages", None) or []
                legacy_list = getattr(result, "ai_messages", None) or []
                use_stream = len(stream_list) > 0
                current_message_count = len(stream_list) if use_stream else len(legacy_list)
                if current_message_count > last_message_count:
                    for i in range(last_message_count, current_message_count):
                        message = stream_list[i] if use_stream else legacy_list[i]
                        writer(
                            _ws(
                                {
                                    "type": "task_running",
                                    "task_id": task_id,
                                    "message": message,
                                    "message_index": i + 1,  # 1-based index for display
                                    "total_messages": current_message_count,
                                    "subagent_type": effective_subagent_type,
                                }
                            )
                        )
                        if resolved_subtask and resolved_collab:
                            try:
                                _append_subtask_conversation_replica(
                                    resolved_collab,
                                    resolved_subtask,
                                    message,
                                    i + 1,
                                    parent_thread_id=collab_lead_thread_id,
                                    run_id=task_id,
                                    default_model_name=subtask_persist_model,
                                )
                            except Exception:
                                logger.debug("task_tool: persist subtask conversation replica failed", exc_info=True)
                        logger.info(f"[trace={trace_id}] Task {task_id} sent message #{i + 1}/{current_message_count}")
                    last_message_count = current_message_count
                # Check if task completed, failed, timed out, or cancelled
                if result.status in {
                    SubagentStatus.COMPLETED,
                    SubagentStatus.FAILED,
                    SubagentStatus.TIMED_OUT,
                    SubagentStatus.CANCELLED,
                }:
                    ex_map = {
                        SubagentStatus.COMPLETED: "completed",
                        SubagentStatus.FAILED: "failed",
                        SubagentStatus.TIMED_OUT: "timed_out",
                        SubagentStatus.CANCELLED: "cancelled",
                    }
                    ex_name = ex_map.get(result.status, "failed")
                    logger.info(f"[trace={trace_id}] Task {task_id} executor terminal={ex_name} after {poll_count} polls")
                    if resolved_collab and resolved_subtask:
                        try:
                            from evoflow.collab.conversation_persist import flush_collab_subtask_stream_messages

                            stream_for_flush = getattr(result, "stream_messages", None) or []
                            flushed = flush_collab_subtask_stream_messages(
                                resolved_collab,
                                resolved_subtask,
                                stream_for_flush,
                                parent_thread_id=collab_lead_thread_id,
                                run_id=task_id,
                                default_model_name=subtask_persist_model,
                            )
                            if flushed:
                                logger.info(
                                    "[trace=%s] flushed %s subtask stream rows main=%s sub=%s",
                                    trace_id,
                                    flushed,
                                    resolved_collab,
                                    resolved_subtask,
                                )
                        except Exception:
                            logger.debug("task_tool: terminal flush subtask stream failed", exc_info=True)
                        _kind, msg = await _finalize_collab_subtask_terminal(
                            executor_outcome=ex_name,
                            result=result,
                            resolved_collab=resolved_collab,
                            resolved_subtask=resolved_subtask,
                            stream_task_id=task_id,
                            writer=writer,
                            ws=_ws,
                            runtime=runtime,
                            executor_subagent_type=effective_subagent_type,
                        )
                        if is_claude_code_subagent_type(effective_subagent_type) and ex_name == "completed":
                            sid, _logp = _claude_session_meta_from_subagent_stream(getattr(result, "stream_messages", None))
                            if sid:
                                _remember_claude_session_for_thread(execution_thread_id, sid)
                        cleanup_background_task(task_id)
                        _pw = locals().get("persistent_writer")
                        if _pw is not None and hasattr(_pw, "close"):
                            _pw.close()
                        return msg
                        try:
                            await _persist_collab_task_memory(ex_name, result)
                        except Exception:
                            logger.warning(
                                "persist collab task memory failed main=%s sub=%s",
                                resolved_collab,
                                resolved_subtask,
                                exc_info=True,
                            )
                    if result.status == SubagentStatus.COMPLETED:
                        out_text = str(result.result or "")
                        writer(_ws({"type": "task_completed", "task_id": task_id, "result": out_text}))
                        cleanup_background_task(task_id)
                        _pw = locals().get("persistent_writer")
                        if _pw is not None and hasattr(_pw, "close"):
                            _pw.close()
                        return f"Task Succeeded. Result: {out_text}"
                    if result.status == SubagentStatus.FAILED:
                        writer(_ws({"type": "task_failed", "task_id": task_id, "error": result.error}))
                        cleanup_background_task(task_id)
                        _pw = locals().get("persistent_writer")
                        if _pw is not None and hasattr(_pw, "close"):
                            _pw.close()
                        return f"Task failed. Error: {result.error}"
                    if result.status == SubagentStatus.TIMED_OUT:
                        writer(_ws({"type": "task_timed_out", "task_id": task_id, "error": result.error}))
                        cleanup_background_task(task_id)
                        _pw = locals().get("persistent_writer")
                        if _pw is not None and hasattr(_pw, "close"):
                            _pw.close()
                        return f"Task timed out. Error: {result.error}"
                    writer(
                        _ws(
                            {
                                "type": "task_cancelled",
                                "task_id": task_id,
                                "error": result.error or "Task was cancelled",
                            }
                        )
                    )
                    cleanup_background_task(task_id)
                    _pw = locals().get("persistent_writer")
                    if _pw is not None and hasattr(_pw, "close"):
                        _pw.close()
                    return f"Task cancelled. {result.error or ''}"

                # Still running, wait before next poll
                # Heartbeat: refresh lease so backend watchdog won't expire active work.
                _patch_collab_subtask_heartbeat()
                await asyncio.sleep(_TASK_TOOL_POLL_INTERVAL_SEC)
                poll_count += 1
                if poll_count >= max_poll_count:
                    # Subagent may still be RUNNING; do not cleanup_background_task (race with executor).
                    err_msg = "Polling safety limit exceeded (subagent still running)."
                    logger.warning(
                        "[trace=%s] %s task_id=%s polls=%s/%s",
                        trace_id,
                        err_msg,
                        task_id,
                        poll_count,
                        max_poll_count,
                    )
                    writer(_ws({"type": "task_timed_out", "task_id": task_id, "error": err_msg}))
                    wall_secs = poll_count * _TASK_TOOL_POLL_INTERVAL_SEC
                    minutes = wall_secs // 60
                    return f"Task polling timed out after {minutes} minutes"
        except asyncio.CancelledError:

            async def cleanup_when_done() -> None:
                max_cleanup_polls = max_poll_count
                cleanup_poll_count = 0

                while True:
                    result = get_background_task_result(task_id)
                    if result is None:
                        return

                    cancelled_status = getattr(SubagentStatus, "CANCELLED", None)
                    terminal_set = {SubagentStatus.COMPLETED, SubagentStatus.FAILED, SubagentStatus.TIMED_OUT}
                    if cancelled_status is not None:
                        terminal_set.add(cancelled_status)
                    if result.status in terminal_set or getattr(result, "completed_at", None) is not None:
                        cleanup_background_task(task_id)
                        return

                    if cleanup_poll_count > max_cleanup_polls:
                        logger.warning(f"[trace={trace_id}] Deferred cleanup for task {task_id} timed out after {cleanup_poll_count} polls")
                        return

                    await asyncio.sleep(5)
                    cleanup_poll_count += 1

            logger.debug(f"[trace={trace_id}] Scheduling deferred cleanup for cancelled task {task_id}")
            from evoflow.subagents.detached_poll_scheduler import schedule_detached_poll

            schedule_detached_poll(
                cleanup_when_done(),
                name=f"task-tool-cleanup-{str(task_id)[:24]}",
            )
            raise
        finally:
            log_poll_loop_end("task_tool_subagent_poll", task_id=task_id)

    if detach_effective:

        async def _detached_poll_runner() -> None:
            try:
                await _poll_subagent_to_completion()
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.exception(
                    "detached task_tool poll failed task_id=%s collab=%s sub=%s",
                    task_id,
                    resolved_collab,
                    resolved_subtask,
                )
                try:
                    writer(_ws({"type": "task_failed", "task_id": task_id, "error": f"Detached poll failed: {type(e).__name__}: {str(e)[:500]}"}))
                except Exception:
                    pass

        from evoflow.subagents.detached_poll_scheduler import schedule_detached_poll

        schedule_detached_poll(
            _detached_poll_runner(),
            name=f"task_tool-detached-{str(task_id)[:24]}",
        )
        try:
            from evoflow.debug.task_lifecycle_trace import write_task_lifecycle_trace

            write_task_lifecycle_trace(
                thread_id=str(thread_id or "").strip() or None,
                event="task_tool_collab_detached",
                main_task_id=str(resolved_collab).strip(),
                subtask_id=str(resolved_subtask).strip(),
                status="executing",
                detail={
                    "background_task_id": str(task_id),
                    "subagent_type": effective_subagent_type,
                },
            )
        except Exception:
            pass
        return "Task Detached. Background execution started for collab subtask."

    return await _poll_subagent_to_completion()


# ── Register task_tool delegate on collab_bridge at import time ─────────
# This allows supervisor/execution.py to delegate subtasks via this tool
# without directly importing task_tool (breaks circular dependency).
try:
    from evoflow.tools.builtins.collab_bridge import register_task_tool_delegate

    _coro_ref = getattr(task_tool, "coroutine", None)
    if _coro_ref is not None:
        register_task_tool_delegate(_coro_ref)
except Exception:
    logger.debug("collab_bridge: failed to register task_tool delegate", exc_info=True)
