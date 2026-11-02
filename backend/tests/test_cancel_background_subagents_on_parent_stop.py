"""Main-chat stop must cooperatively cancel in-flight background subagents.

conftest mocks ``evoflow.subagents.executor`` to break a circular import, so this
test loads the real executor module under an alternate name.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

from evoflow.cancellation import clear_all_cancellations, is_task_cancelled, mark_task_cancelled, unmark_task_cancelled


def _load_real_executor():
    path = Path(__file__).resolve().parents[1] / "packages" / "harness" / "evoflow" / "subagents" / "executor.py"
    name = "evoflow.subagents._executor_real_for_cancel_test"
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture()
def ex():
    return _load_real_executor()


def _put(ex, task_id: str, *, parent: str | None, thread: str | None = None, status=None) -> None:
    status = status or ex.SubagentStatus.RUNNING
    with ex._background_tasks_lock:
        ex._background_tasks[task_id] = ex.SubagentResult(
            task_id=task_id,
            trace_id="t",
            status=status,
            thread_id=thread,
            parent_thread_id=parent,
        )


def _clear(ex, task_ids: list[str], parent: str) -> None:
    for tid in task_ids:
        try:
            ex.cleanup_background_task(tid)
        except Exception:
            pass
        unmark_task_cancelled(tid)
    unmark_task_cancelled(parent)
    clear_all_cancellations()


def test_cancel_background_tasks_for_parent_thread_marks_children(ex):
    parent = "thread-parent-stop-1"
    child_a = "bg-child-a"
    child_b = "bg-child-b"
    other = "bg-other"
    _put(ex, child_a, parent=parent, thread=parent)
    _put(ex, child_b, parent=parent, thread="exec-b")
    _put(ex, other, parent="other-parent", thread="other-parent")
    try:
        cancelled = ex.cancel_background_tasks_for_parent_thread(parent, reason="user_stop")
        assert child_a in cancelled
        assert child_b in cancelled
        assert other not in cancelled
        assert is_task_cancelled(parent)
        assert is_task_cancelled(child_a)
        assert is_task_cancelled(child_b)
        assert not is_task_cancelled(other)
        with ex._background_tasks_lock:
            assert ex._background_tasks[child_a].status == ex.SubagentStatus.CANCELLED
            assert ex._background_tasks[child_b].status == ex.SubagentStatus.CANCELLED
            assert ex._background_tasks[other].status == ex.SubagentStatus.RUNNING
    finally:
        _clear(ex, [child_a, child_b, other], parent)


def test_subagent_should_stop_on_parent_flag(ex):
    parent = "thread-parent-stop-2"
    child = "bg-child-parent-flag"
    try:
        clear_all_cancellations()
        ent = ex.SubagentResult(
            task_id=child,
            trace_id="t",
            status=ex.SubagentStatus.RUNNING,
            parent_thread_id=parent,
        )
        assert not ex._subagent_should_stop(ent)
        mark_task_cancelled(parent, "user", "user_stop")
        assert ex._subagent_should_stop(ent)
    finally:
        unmark_task_cancelled(parent)
        unmark_task_cancelled(child)
        clear_all_cancellations()


def test_match_by_reused_thread_id_without_parent_field(ex):
    parent = "thread-parent-stop-3"
    child = "bg-reuse-thread"
    with ex._background_tasks_lock:
        ex._background_tasks[child] = ex.SubagentResult(
            task_id=child,
            trace_id="t",
            status=ex.SubagentStatus.RUNNING,
            thread_id=parent,
            parent_thread_id=None,
        )
    try:
        cancelled = ex.cancel_background_tasks_for_parent_thread(parent)
        assert cancelled == [child]
        assert is_task_cancelled(child)
    finally:
        _clear(ex, [child], parent)
