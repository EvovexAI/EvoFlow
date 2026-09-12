"""Middleware that extends TodoListMiddleware with context-loss detection.

When the message history is truncated (e.g., by SummarizationMiddleware), the
original `write_todos` tool call and its ToolMessage can be scrolled out of the
active context window. This middleware detects that situation and injects a
reminder message so the model still knows about the outstanding todo list.
"""

from __future__ import annotations

import logging
from typing import Any

try:
    from typing import override
except ImportError:
    from typing import override

from langchain.agents.middleware import TodoListMiddleware
from langchain.agents.middleware.todo import PlanningState, Todo
from langchain_core.messages import AIMessage, HumanMessage
from langgraph.runtime import Runtime

logger = logging.getLogger(__name__)


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
    """Return True if any AIMessage in *messages* contains a write_todos tool call."""
    for msg in messages:
        if isinstance(msg, AIMessage) and msg.tool_calls:
            for tc in msg.tool_calls:
                if tc.get("name") == "write_todos":
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
    """Extends TodoListMiddleware with `write_todos` context-loss detection
    and independent persistence to ``evoflow_todos`` table.

    When the original `write_todos` tool call has been truncated from the message
    history (e.g., after summarization), the model loses awareness of the current
    todo list. This middleware detects that gap in `before_model` / `abefore_model`
    and injects a reminder message so the model can continue tracking progress.
    """

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
                "Call `write_todos` whenever the status of any item changes.\n"
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
        """Persist updated todos to independent table after model run."""
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
        result = await super().aafter_model(state, runtime)
        try:
            self._persist_todos(state, runtime)
        except Exception:
            pass
        return result
