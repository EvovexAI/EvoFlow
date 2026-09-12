"""Lightweight todo tool for task tracking within a single conversation.

This is a conversation-scoped checklist — not the Task Center ledger.
Todos are stored in memory and do NOT persist across conversations, and never
appear in 任务中心. For user memos / assignable work use Task Center inbox
(``POST /api/tasks`` with ``lifecycle=inbox``) or the ``tasks`` tool; for
cross-agent orchestration with dependencies use ``supervisor``.
"""

from dataclasses import dataclass, field
from datetime import datetime

try:
    from enum import StrEnum
except ImportError:
    from enum import Enum

    class StrEnum(str, Enum):
        pass


from langchain.tools import tool

from evoflow.collab.id_format import make_todo_id

# ─── Data structures ──────────────────────────────────────────────


class TodoStatus(StrEnum):
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    CANCELLED = "cancelled"


@dataclass
class TodoItem:
    id: str = field(default_factory=make_todo_id)
    content: str = ""
    status: TodoStatus = TodoStatus.PENDING
    created_at: str = field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))
    updated_at: str = field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))


# ─── In-memory store (conversation-scoped) ───────────────────────

_todo_store: dict[str, list[TodoItem]] = {}  # key: thread_id → list of items


def _get_todos(thread_id: str) -> list[TodoItem]:
    return _todo_store.setdefault(thread_id, [])


def _set_todos(thread_id: str, todos: list[TodoItem]) -> None:
    _todo_store[thread_id] = todos


def _format_status(status: TodoStatus) -> str:
    icons = {
        TodoStatus.PENDING: "[pending]",
        TodoStatus.IN_PROGRESS: "[in_progress]",
        TodoStatus.COMPLETED: "[completed]",
        TodoStatus.CANCELLED: "[cancelled]",
    }
    status_icons = {
        TodoStatus.PENDING: "[  ]",
        TodoStatus.IN_PROGRESS: "[->]",
        TodoStatus.COMPLETED: "[OK]",
        TodoStatus.CANCELLED: "[XX]",
    }
    return f"{status_icons[status]} {icons[status]}"


# ─── Tool function ────────────────────────────────────────────────


@tool("todo", parse_docstring=False)
def todo_tool(
    action: str,
    *,
    content: str | None = None,
    id: str | None = None,
    status: str | None = None,
) -> str:
    """Manage todo items for task tracking within a conversation.

    Conversation-scoped checklist only (in-memory). Does NOT write to 任务中心.
    For persistent / assignable work use Task Center inbox or the `tasks` tool;
    for cross-agent orchestration use `supervisor`.

    Args:
        action: One of 'list', 'add', 'update', 'clear'
        content: Todo description text (required for add)
        id: Todo ID string (required for update)
        status: New status value: pending/in_progress/completed/cancelled (optional for update)

    Examples:
        action='add', content='Implement delete_file tool'  -> adds new todo
        action='update', id='abc123', status='in_progress'   -> changes status
        action='list'                                       -> shows all todos
        action='clear'                                      -> removes completed items
    """
    # Use a fixed thread ID for now (can be replaced with actual thread ID later)
    thread_id = "__default__"
    todos = _get_todos(thread_id)

    if action == "list":
        if not todos:
            return "No todos yet. Use action='add', content='your task' to create one."

        lines = [f"## Todos ({len(todos)} items)", ""]
        for i, t in enumerate(todos, 1):
            lines.append(f"{_format_status(t.status)} #{i}  {t.content}\n      id={t.id} | created={t.created_at}")
        return "\n".join(lines)

    elif action == "add":
        if not content or not content.strip():
            return "Error: 'content' is required when adding a todo item."

        item = TodoItem(content=content.strip())
        todos.append(item)
        _set_todos(thread_id, todos)

        pending_count = sum(1 for t in todos if t.status != TodoStatus.COMPLETED and t.status != TodoStatus.CANCELLED)
        return f"OK: Added todo #{len(todos)}: '{item.content}' (id={item.id})\nTotal: {len(todos)} items ({pending_count} active)"

    elif action == "update":
        if not id:
            return "Error: 'id' is required when updating a todo. Use 'list' action to see all ids."

        target = next((t for t in todos if t.id == id), None)
        if not target:
            return f"Error: No todo found with id='{id}'. Available ids: {[t.id for t in todos]}"

        old_status = target.status

        if status:
            try:
                new_status = TodoStatus(status.lower())
            except ValueError:
                valid = [s.value for s in TodoStatus]
                return f"Error: Invalid status '{status}'. Valid values: {valid}"

            target.status = new_status
            target.updated_at = datetime.now().isoformat(timespec="seconds")
            _set_todos(thread_id, todos)

            return f"OK: Updated todo '{target.content}' (id={id}): {old_status.value} -> {new_status.value}"
        else:
            # Just show current state
            return f"Todo #{todos.index(target) + 1}: '{target.content}' | status={target.status.value} | id={id}"

    elif action == "clear":
        len(todos)
        cleared = sum(1 for t in todos if t.status in (TodoStatus.COMPLETED, TodoStatus.CANCELLED))
        remaining = [t for t in todos if t.status not in (TodoStatus.COMPLETED, TodoStatus.CANCELLED)]
        _set_todos(thread_id, remaining)

        return f"OK: Cleared {cleared} completed/cancelled todos. {len(remaining)} items remain."

    else:
        valid_actions = ["list", "add", "update", "clear"]
        return f"Error: Unknown action '{action}'. Valid actions: {valid_actions}"
