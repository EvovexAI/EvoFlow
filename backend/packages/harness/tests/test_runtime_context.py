"""Lead agent LangGraph runtime context schema."""

from __future__ import annotations

from types import SimpleNamespace

from evoflow.agents.lead_agent.runtime_context import (
    LeadAgentRuntimeContext,
    runtime_context_mapping,
)


def test_runtime_context_dataclass_get() -> None:
    ctx = LeadAgentRuntimeContext(session_mode="flash", memory_enabled=False)
    assert ctx.get("session_mode") == "flash"
    assert ctx.get("memory_enabled") is False
    assert ctx.get("missing", "x") == "x"


def test_runtime_context_mapping_from_dict() -> None:
    rt = SimpleNamespace(context={"session_mode": "flash", "thread_id": "t1"})
    m = runtime_context_mapping(rt)
    assert m["session_mode"] == "flash"
    assert m["thread_id"] == "t1"


def test_runtime_context_mapping_from_dataclass() -> None:
    rt = SimpleNamespace(
        context=LeadAgentRuntimeContext(session_mode="flash", triggered_by="automation_scheduler"),
    )
    m = runtime_context_mapping(rt)
    assert m["session_mode"] == "flash"
    assert m["triggered_by"] == "automation_scheduler"


def test_runtime_context_from_mapping_ignores_unknown_keys() -> None:
    ctx = LeadAgentRuntimeContext.from_mapping(
        {
            "thread_id": "lead__sub__Subtask_1",
            "parent_thread_id": "lead-uuid",
            "collab_task_id": "task-1",
            "collab_subtask_id": "Subtask_1",
            "subtask_thread_id": "lead__sub__Subtask_1",
        },
    )
    assert ctx.thread_id == "lead__sub__Subtask_1"
    assert ctx.parent_thread_id == "lead-uuid"
    assert ctx.collab_task_id == "task-1"
    assert ctx.collab_subtask_id == "Subtask_1"
    assert not hasattr(ctx, "subtask_thread_id") or getattr(ctx, "subtask_thread_id", None) is None
