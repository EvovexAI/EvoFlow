"""Middleware that extends TodoListMiddleware with context-loss detection.

When the message history is truncated (e.g., by SummarizationMiddleware), the
original `todo_write` tool call and its ToolMessage can be scrolled out of the
active context window. This middleware detects that situation and injects a
reminder message so the model still knows about the outstanding todo list.

zcode 对齐（TodoWrite/TodoRead）：
- 工具名 todo_write（evopanel 的 isTodoPlanToolName 识别该名字，V4 时间线
  todo.tsx 渲染器可直接渲染清单卡片）。
- ToolMessage 输出结构化 {oldTodos, todos, summary}（zcode TodoWriteOutput 同款），
  替代 langchain 默认的纯文本 "Updated todo list to [...]"。
- 并行调用防护在本地实现（langchain 父类 after_model 硬编码检查 write_todos，
  改名后由本中间件接手）。
"""

from __future__ import annotations

import json
import logging
from typing import Annotated, Any

try:
    from typing import override
except ImportError:
    from typing import override

from langchain.agents.middleware import TodoListMiddleware
from langchain.agents.middleware.todo import PlanningState, Todo
from langchain.tools import tool as langchain_tool
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.tools import InjectedToolCallId
from langgraph.prebuilt import InjectedState
from langgraph.runtime import Runtime
from langgraph.types import Command

logger = logging.getLogger(__name__)

# 现役工具名（zcode TodoWrite 的小写对齐名）。
TODO_WRITE_TOOL_NAME = "todo_write"
# 历史会话 checkpoint 里可能残留旧名 write_todos，检测/防护时一并识别。
TODO_WRITE_TOOL_NAMES = frozenset({"todo_write", "write_todos"})


def _summarize_todos(todos: list[Todo]) -> dict[str, int]:
    return {
        "total": len(todos),
        "pending": sum(1 for t in todos if t.get("status") == "pending"),
        "inProgress": sum(1 for t in todos if t.get("status") == "in_progress"),
        "completed": sum(1 for t in todos if t.get("status") == "completed"),
    }


def _build_todo_write_tool(description: str) -> Any:
    """构建 zcode TodoWrite 对齐的 todo_write 工具。

    - 全量替换语义与 langchain write_todos 一致（Command 更新 PlanningState）。
    - ToolMessage 输出结构化 {oldTodos, todos, summary}，供 evopanel todo.tsx
      渲染器（readPlanCollection 识别 todos 集合）与模型后续轮次解析。
    - old_todos 通过 InjectedState 注入当前 PlanningState.todos，不出现在
      模型可见的参数 schema 里（已验证 tool_call_schema 仅暴露 todos）。
    """

    @langchain_tool(description=description)
    def todo_write(
        todos: list[Todo],
        old_todos: Annotated[list[Todo] | None, InjectedState("todos")],
        tool_call_id: Annotated[str, InjectedToolCallId],
    ) -> Command:
        """Replace the session todo list with a new one (full-list replace semantics)."""
        old = [dict(t) for t in (old_todos or [])]
        new = [dict(t) for t in todos]
        payload = {
            "oldTodos": old,
            "todos": new,
            "summary": _summarize_todos(new),
        }
        return Command(
            update={
                "todos": new,
                "messages": [
                    ToolMessage(json.dumps(payload, ensure_ascii=False), tool_call_id=tool_call_id)
                ],
            }
        )

    return todo_write


def _parallel_todo_write_errors(messages: list[Any]) -> list[ToolMessage] | None:
    """Reject parallel todo_write calls (langchain 父类只认 write_todos，这里接管)."""
    last_ai_msg = next(
        (msg for msg in reversed(messages) if isinstance(msg, AIMessage) and msg.tool_calls),
        None,
    )
    if not last_ai_msg:
        return None
    calls = [tc for tc in last_ai_msg.tool_calls if tc.get("name") in TODO_WRITE_TOOL_NAMES]
    if len(calls) <= 1:
        return None
    return [
        ToolMessage(
            content=(
                "Error: The `todo_write` tool should never be called multiple times "
                "in parallel. Please call it only once per model invocation to update "
                "the todo list."
            ),
            tool_call_id=tc["id"],
            status="error",
        )
        for tc in calls
    ]


def _thread_id_from_runtime(runtime: Runtime) -> str:
    ctx = getattr(runtime, "context", None) or {}
    if isinstance(ctx, dict):
        tid = ctx.get("thread_id")
        if tid:
            return str(tid).strip()
    try:
        from langgraph.config import get_config

        tid = str(get_config().get("configurable", {}).get("thread_id") or "").strip()
        if tid:
            return tid
    except Exception:
        pass
    return ""


def _session_key_for_thread(thread_id: str) -> str:
    if not thread_id:
        return ""
    try:
        from evoflow.persistence.session_repositories import find_session_key_by_thread_id

        return find_session_key_by_thread_id(thread_id) or ""
    except Exception:
        return ""


def _todos_in_messages(messages: list[Any]) -> bool:
    """Return True if any AIMessage in *messages* contains a todo_write tool call."""
    for msg in messages:
        if isinstance(msg, AIMessage) and msg.tool_calls:
            for tc in msg.tool_calls:
                if tc.get("name") in TODO_WRITE_TOOL_NAMES:
                    return True
    return False


def _reminder_in_messages(messages: list[Any]) -> bool:
    """Return True if a todo_reminder HumanMessage is already present in *messages*."""
    for msg in messages:
        if isinstance(msg, HumanMessage) and getattr(msg, "name", None) == "todo_reminder":
            return True
    return False


def _format_todos(todos: list[Todo]) -> str:
    """Format todos as a markdown table (status / content / result)."""
    try:
        from evoflow.collab.work_checklist import format_main_chat_todos_table

        rows = [dict(t) if isinstance(t, dict) else {"content": str(t), "status": "pending"} for t in todos]
        table = format_main_chat_todos_table(rows)
        if table:
            return table
    except Exception:
        pass
    lines: list[str] = []
    for todo in todos:
        status = todo.get("status", "pending")
        content = todo.get("content", "")
        result = ""
        if isinstance(todo, dict):
            result = str(todo.get("result") or todo.get("outcome") or "").strip()
        line = f"- [{status}] {content}"
        if result:
            line += f" | 结果: {result}"
        lines.append(line)
    return "\n".join(lines)


class TodoMiddleware(TodoListMiddleware):
    """Extends TodoListMiddleware with `todo_write` context-loss detection
    and independent persistence to ``evoflow_todos`` table.

    When the original `todo_write` tool call has been truncated from the message
    history (e.g., after summarization), the model loses awareness of the current
    todo list. This middleware detects that gap in `before_model` / `abefore_model`
    and injects a reminder message so the model can continue tracking progress.
    """

    def __init__(
        self,
        *,
        system_prompt: str = "",
        tool_description: str = "",
    ) -> None:
        super().__init__(system_prompt=system_prompt, tool_description=tool_description)
        # zcode 对齐：用结构化输出的 todo_write 替换 langchain 默认 write_todos。
        self.tools = [_build_todo_write_tool(tool_description)]

    def _persist_todos(self, state: PlanningState, runtime: Runtime) -> None:
        """Write current todos to the independent table (fire-and-forget)."""
        try:
            from evoflow.persistence.todo_repositories import save_todos

            thread_id = _thread_id_from_runtime(runtime)
            session_key = _session_key_for_thread(thread_id)
            todos = state.get("todos") or []
            if session_key and thread_id:
                save_todos(session_key, thread_id, list(todos))
        except Exception:
            logger.debug("todo persist failed", exc_info=True)

    def _load_todos(self, state: PlanningState, runtime: Runtime) -> list[Todo]:
        """Load todos from independent table when checkpoint has none."""
        try:
            from evoflow.persistence.todo_repositories import load_todos

            thread_id = _thread_id_from_runtime(runtime)
            session_key = _session_key_for_thread(thread_id)
            if session_key and thread_id:
                return load_todos(session_key, thread_id) or []
        except Exception:
            pass
        return []

    @override
    def before_model(
        self,
        state: PlanningState,
        runtime: Runtime,  # noqa: ARG002
    ) -> dict[str, Any] | None:
        """Inject a todo-list reminder when write_todos has left the context window."""
        todos: list[Todo] = state.get("todos") or []  # type: ignore[assignment]

        # Fallback: load from independent table when checkpoint has no todos.
        if not todos:
            todos = self._load_todos(state, runtime)

        if not todos:
            return None

        messages = state.get("messages") or []
        if _todos_in_messages(messages):
            return None

        if _reminder_in_messages(messages):
            return None

        formatted = _format_todos(todos)
        reminder = HumanMessage(
            name="todo_reminder",
            content=(
                "<system_reminder>\n"
                "Your todo list from earlier is no longer visible in the current context window, "
                "but it is still active. Here is the current state:\n\n"
                f"{formatted}\n\n"
                "Continue tracking and updating this todo list as you work. "
                "Call `todo_write` whenever the status of any item changes.\n"
                "</system_reminder>"
            ),
        )
        return {"messages": [reminder]}

    @override
    async def abefore_model(
        self,
        state: PlanningState,
        runtime: Runtime,
    ) -> dict[str, Any] | None:
        """Async version of before_model."""
        return self.before_model(state, runtime)

    @override
    def after_model(
        self,
        state: PlanningState,
        runtime: Runtime,
    ) -> dict[str, Any] | None:
        """Reject parallel todo_write calls, then persist todos after model run."""
        messages = state.get("messages") or []
        errors = _parallel_todo_write_errors(messages)
        if errors:
            return {"messages": errors}
        result = super().after_model(state, runtime)
        try:
            self._persist_todos(state, runtime)
        except Exception:
            pass
        return result

    @override
    async def aafter_model(
        self,
        state: PlanningState,
        runtime: Runtime,
    ) -> dict[str, Any] | None:
        """Async version of after_model."""
        messages = state.get("messages") or []
        errors = _parallel_todo_write_errors(messages)
        if errors:
            return {"messages": errors}
        result = await super().aafter_model(state, runtime)
        try:
            self._persist_todos(state, runtime)
        except Exception:
            pass
        return result
