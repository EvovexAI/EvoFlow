"""Unified collab stream writer attaches gateway SSE to lead ToolRuntime."""

from __future__ import annotations

from types import SimpleNamespace

from evoflow.collab.unified_stream import (
    attach_gateway_writer_to_runtime,
    resolve_collab_parent_stream_writer,
)


def test_attach_gateway_writer_chains_with_existing() -> None:
    calls: list[dict] = []
    runtime = SimpleNamespace(stream_writer=lambda msg: calls.append({"prev": msg}))
    attach_gateway_writer_to_runtime(runtime, "Task_main_unified")
    assert callable(runtime.stream_writer)
    runtime.stream_writer({"type": "task_running", "task_id": "Subtask_x"})
    assert len(calls) == 1


def test_resolve_collab_parent_stream_writer_includes_runtime_writer() -> None:
    seen: list[str] = []
    runtime = SimpleNamespace(stream_writer=lambda _m: seen.append("rt"))
    writer = resolve_collab_parent_stream_writer(runtime=runtime, main_task_id="Task_main_unified")
    assert writer is not None
    writer({"type": "task_started"})
    assert seen == ["rt"]
