from __future__ import annotations

import json
import threading
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import ToolCallRequest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.types import Command

from evoflow.collab.models import CollabPhase, ThreadCollabState
from evoflow.collab.thread_collab import load_thread_collab_state
from evoflow.config.paths import get_paths
from evoflow.debug.trace_sink import debug_file_path

_VALID_PHASES = frozenset(p.value for p in CollabPhase)


def _log_paths() -> list[Path]:
    return [debug_file_path("collab_lifecycle_stage_cn.log")]


def _text(content: Any, max_len: int = 800) -> str:
    if isinstance(content, str):
        s = content
    elif isinstance(content, list):
        parts: list[str] = []
        for x in content:
            if isinstance(x, str):
                parts.append(x)
            elif isinstance(x, dict) and isinstance(x.get("text"), str):
                parts.append(x["text"])
        s = "".join(parts)
    else:
        s = str(content or "")
    s = s.strip()
    if len(s) > max_len:
        return s[: max_len - 3] + "..."
    return s


def _tool_name(tc: Any) -> str:
    if isinstance(tc, dict):
        return str(tc.get("name") or "").strip()
    return str(getattr(tc, "name", "") or "").strip()


def _tool_args(tc: Any) -> dict[str, Any]:
    raw = tc.get("args") if isinstance(tc, dict) else getattr(tc, "args", {})
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
            return parsed if isinstance(parsed, dict) else {}
        except Exception:
            return {}
    return {}


def _json_from_tool_result(result: ToolMessage | Command | Any) -> dict[str, Any]:
    try:
        if isinstance(result, ToolMessage):
            parsed = json.loads(str(result.content or ""))
            return parsed if isinstance(parsed, dict) else {}
    except Exception:
        return {}
    return {}


def write_stage_event(stage: str, payload: dict[str, Any]) -> None:
    row = {
        "时间": datetime.now(UTC).isoformat(),
        "阶段": stage,
        **payload,
    }
    line = json.dumps(row, ensure_ascii=False) + "\n"
    for p in _log_paths():
        try:
            p.parent.mkdir(parents=True, exist_ok=True)
            with p.open("a", encoding="utf-8") as f:
                f.write(line)
        except Exception:
            continue


class CollabLifecycleStageMiddleware(AgentMiddleware[AgentState]):
    """Stage-level lifecycle Chinese logs (milestones only)."""

    _lock = threading.Lock()
    _state_by_thread: dict[str, dict[str, Any]] = {}

    def _write(self, stage: str, payload: dict[str, Any]) -> None:
        write_stage_event(stage, payload)

    def _thread(self, runtime_or_request: Any) -> str:
        ctx = getattr(runtime_or_request, "context", None)
        if not isinstance(ctx, dict):
            runtime = getattr(runtime_or_request, "runtime", None)
            ctx = getattr(runtime, "context", None) if runtime is not None else {}
        if not isinstance(ctx, dict):
            return ""
        return str(ctx.get("thread_id") or "").strip()

    def _phase(self, runtime_or_request: Any) -> str:
        ctx = getattr(runtime_or_request, "context", None)
        if not isinstance(ctx, dict):
            runtime = getattr(runtime_or_request, "runtime", None)
            ctx = getattr(runtime, "context", None) if runtime is not None else {}
        if not isinstance(ctx, dict):
            return ""
        phase = str(ctx.get("collab_phase") or "").strip().lower()
        tid = str(ctx.get("thread_id") or "").strip()
        if not tid:
            return phase
        try:
            disk: ThreadCollabState = load_thread_collab_state(get_paths(), tid)
            p = disk.collab_phase.value if isinstance(disk.collab_phase, CollabPhase) else str(disk.collab_phase or "")
            disk_phase = str(p or "").strip().lower()
            if disk_phase and disk_phase not in _VALID_PHASES:
                disk_phase = ""
            planning_like = {"planning", "plan_ready", "awaiting_exec"}
            if phase in planning_like and disk_phase and disk_phase not in planning_like:
                return disk_phase
            if not phase or phase == CollabPhase.IDLE.value:
                return str(disk_phase or phase).strip().lower()
            return phase
        except Exception:
            return phase

    def _get_state(self, tid: str) -> dict[str, Any]:
        with self._lock:
            st = self._state_by_thread.get(tid)
            if st is None:
                st = {"asked_clarify": False, "plan_done": False, "exec_started": False, "ended": False}
                self._state_by_thread[tid] = st
            return st

    def before_model(self, state: AgentState, runtime) -> dict[str, Any] | None:
        tid = self._thread(runtime)
        if not tid:
            return None
        msgs = state.get("messages") or []
        if not msgs:
            return None
        msgs[-1]
        phase = self._phase(runtime)
        st = self._get_state(tid)
        # CollabPhaseMiddleware injects a SystemMessage hint at the end of the message list.
        # For user lifecycle logs we should always look back to the latest HumanMessage.
        latest_human: HumanMessage | None = None
        for m in reversed(msgs):
            if isinstance(m, HumanMessage):
                latest_human = m
                break
        if latest_human is not None:
            txt = _text(latest_human.content)
            if phase in {"planning", "plan_ready", "awaiting_exec"} and not st.get("plan_started"):
                st["plan_started"] = True
                self._write("开始计划", {"线程ID": tid, "协作阶段": phase, "用户诉求": txt})
            if st.get("asked_clarify"):
                self._write("用户澄清回复", {"线程ID": tid, "协作阶段": phase, "回复内容": txt})
                st["asked_clarify"] = False
            elif txt.startswith("__EVF_CLARIFY_ANS_V1__:"):
                self._write("用户澄清回复", {"线程ID": tid, "协作阶段": phase, "回复内容": txt})
        return None

    async def abefore_model(self, state: AgentState, runtime) -> dict[str, Any] | None:
        return self.before_model(state, runtime)

    def after_model(self, state: AgentState, runtime) -> dict[str, Any] | None:
        tid = self._thread(runtime)
        if not tid:
            return None
        msgs = state.get("messages") or []
        if not msgs or not isinstance(msgs[-1], AIMessage):
            return None
        phase = self._phase(runtime)
        last: AIMessage = msgs[-1]
        st = self._get_state(tid)
        tcalls = list(last.tool_calls or [])
        content_txt = _text(last.content, max_len=1200)

        for tc in tcalls:
            if _tool_name(tc) == "ask_clarification":
                args = _tool_args(tc)
                q = str(args.get("question") or args.get("prompt") or args.get("content") or "")[:800]
                self._write("计划阶段询问用户", {"线程ID": tid, "协作阶段": phase, "询问内容": q or "(结构化澄清问题)"})
                st["asked_clarify"] = True

        if phase in {"planning", "plan_ready", "awaiting_exec"} and content_txt.startswith("# Plan") and not st.get("plan_done"):
            st["plan_done"] = True
            self._write("计划完成", {"线程ID": tid, "协作阶段": phase, "计划内容": content_txt})

        if phase in {"executing", "done"} and content_txt and not tcalls:
            self._write("主任务回复总结", {"线程ID": tid, "协作阶段": phase, "总结内容": content_txt})
        return None

    async def aafter_model(self, state: AgentState, runtime) -> dict[str, Any] | None:
        return self.after_model(state, runtime)

    def wrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], ToolMessage | Command],
    ) -> ToolMessage | Command:
        tid = self._thread(request)
        phase = self._phase(request)
        tc = request.tool_call or {}
        name = str(tc.get("name") or "")
        args = tc.get("args") if isinstance(tc.get("args"), dict) else {}
        st = self._get_state(tid) if tid else {}

        result = handler(request)
        data = _json_from_tool_result(result)

        if tid and name == "supervisor":
            action = str(args.get("action") or data.get("action") or "").strip()
            if action == "start_execution" and not st.get("exec_started"):
                st["exec_started"] = True
                self._write(
                    "开始执行",
                    {
                        "线程ID": tid,
                        "协作阶段": phase,
                        "主任务ID": str(data.get("taskId") or args.get("task_id") or ""),
                        "说明": str(data.get("message") or ""),
                    },
                )
            elif action in {"create_task_with_subtasks", "create_subtasks", "monitor_execution_step", "get_status", "list_subtasks"}:
                self._write(
                    "子任务处理进展",
                    {
                        "线程ID": tid,
                        "协作阶段": phase,
                        "动作": action,
                        "关键信息": str(data.get("message") or data.get("status") or data.get("statusZh") or "")[:500],
                    },
                )
            if action == "monitor_execution_step" and bool(data.get("terminal")) and not st.get("ended"):
                st["ended"] = True
                self._write(
                    "任务结束",
                    {
                        "线程ID": tid,
                        "协作阶段": "done",
                        "结果状态": str(data.get("status") or data.get("statusZh") or "completed"),
                    },
                )
        return result

    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Command]],
    ) -> ToolMessage | Command:
        tid = self._thread(request)
        phase = self._phase(request)
        tc = request.tool_call or {}
        name = str(tc.get("name") or "")
        args = tc.get("args") if isinstance(tc.get("args"), dict) else {}
        st = self._get_state(tid) if tid else {}

        result = await handler(request)
        data = _json_from_tool_result(result)
        if tid and name == "supervisor":
            action = str(args.get("action") or data.get("action") or "").strip()
            if action == "start_execution" and not st.get("exec_started"):
                st["exec_started"] = True
                self._write(
                    "开始执行",
                    {"线程ID": tid, "协作阶段": phase, "主任务ID": str(data.get("taskId") or args.get("task_id") or ""), "说明": str(data.get("message") or "")},
                )
            elif action in {"create_task_with_subtasks", "create_subtasks", "monitor_execution_step", "get_status", "list_subtasks"}:
                self._write(
                    "子任务处理进展",
                    {"线程ID": tid, "协作阶段": phase, "动作": action, "关键信息": str(data.get("message") or data.get("status") or data.get("statusZh") or "")[:500]},
                )
            if action == "monitor_execution_step" and bool(data.get("terminal")) and not st.get("ended"):
                st["ended"] = True
                self._write("任务结束", {"线程ID": tid, "协作阶段": "done", "结果状态": str(data.get("status") or data.get("statusZh") or "completed")})
        return result
