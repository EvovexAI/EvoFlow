"""Task status vocabulary: canonical zh labels, allowed states, transition table.

Why this module exists (2026-11-18):
    ``admin.tasks._status_zh`` used to do
    ``from evoflow.tools.builtins.supervisor_tool import _STATUS_ZH_MAP``
    *per board row*. That import runs ``tools/builtins/__init__.py``, which
    eagerly imports every builtin tool → ``langchain.tools`` → ``transformers``
    → ``torch``. Result: the first ``tasks list`` of a process paid a
    ~4.7–5.5s model-import chain to render one status string (measured on this
    repo: first call 5456ms, second call 18ms with identical data).

    These are plain constants with no runtime dependencies. Keep this module
    dependency-free — anything imported here is on the task-listing hot path.

``supervisor_tool`` re-exports these names for its existing callers/tests.
``tools/builtins/supervisor/display.py`` still keeps its own map on purpose — it
renders the monitor panel where ``executing`` reads "正在处理中" (vs our "处理中")
and it covers no inbox/waiting_dispatch/awaiting_close/reviewed. Unifying the two
is a UI-wording decision, not a perf one, so it is left alone here.
"""

from __future__ import annotations

STATUS_ZH_MAP: dict[str, str] = {
    "inbox": "待办",
    "pending": "等待中",
    "planned": "已规划",
    "planning": "规划中",
    "executing": "处理中",
    "waiting_dispatch": "等待派发",
    "waiting_user": "等待用户输入",
    "awaiting_close": "待闭环",
    "reviewed": "已完成",
    "running": "处理中",
    "in_progress": "处理中",
    "completed": "已完成",
    "failed": "失败",
    "cancelled": "已取消",
    "timed_out": "超时",
}

ALLOWED_TASK_STATES = {
    "inbox",
    "pending",
    "planned",
    "planning",
    "executing",
    "waiting_dispatch",
    "waiting_user",
    "awaiting_close",
    "reviewed",
    "completed",
    "failed",
    "cancelled",
}

TASK_STATE_TRANSITIONS: dict[str, set[str]] = {
    # 随手待办：分配/升级 → pending；用户勾完成 / 取消
    "inbox": {"pending", "completed", "cancelled"},
    # pending/planned/planning 可直接结案：不必先 progress→executing（少仪式感）
    "pending": {
        "planned",
        "planning",
        "executing",
        "waiting_user",
        "awaiting_close",
        "completed",
        "failed",
        "cancelled",
    },
    "planned": {
        "planning",
        "executing",
        "awaiting_close",
        "completed",
        "failed",
        "cancelled",
    },
    "planning": {
        "executing",
        "waiting_user",
        "awaiting_close",
        "completed",
        "failed",
        "cancelled",
    },
    "executing": {
        "waiting_dispatch",
        "waiting_user",
        "awaiting_close",
        "reviewed",
        "completed",
        "failed",
        "cancelled",
    },
    # waiting_dispatch means "needs next dispatch decision", but monitoring can continue.
    "waiting_dispatch": {
        "executing",
        "waiting_user",
        "awaiting_close",
        "completed",
        "failed",
        "cancelled",
    },
    "waiting_user": {"executing", "awaiting_close", "completed", "cancelled", "failed"},
    # 本岗已交、整单未验收关闭；可验收 completed / 失败 / 返工回 executing
    "awaiting_close": {"completed", "failed", "cancelled", "executing"},
    # reviewed kept for legacy rows; treat as terminal success (maps to completed on write)
    "reviewed": set(),
    "completed": set(),
    # Align with collab ALLOWED_TRANSITIONS: failed work items / steps can be retried.
    "failed": {"pending", "executing"},
    "cancelled": set(),
}


def normalize_state(value: str | None) -> str:
    return str(value or "").strip().lower().replace("-", "_")


def status_zh(value: str | None) -> str:
    """Chinese label for a task/subtask status; ``未知`` when unrecognized."""
    return STATUS_ZH_MAP.get(normalize_state(value), "未知")


def can_transition(current: str, target: str) -> bool:
    """Whether a task may move from ``current`` to ``target`` (same state is always ok)."""
    if current == target:
        return True
    allowed = TASK_STATE_TRANSITIONS.get(current)
    if allowed is None:
        return False
    return target in allowed


def next_states(current: str) -> list[str]:
    return sorted(TASK_STATE_TRANSITIONS.get(current) or set())
