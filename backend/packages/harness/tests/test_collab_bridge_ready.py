"""Collab bridge wiring for workflow dispatch."""

from __future__ import annotations

from evoflow.tools.builtins.collab_bridge import ensure_collab_bridge_ready, is_bridge_ready


def test_ensure_collab_bridge_ready_registers_task_tool() -> None:
    task_ok, follow_ok = ensure_collab_bridge_ready()
    assert task_ok is True
    assert follow_ok is True
    assert is_bridge_ready() == (True, True)
