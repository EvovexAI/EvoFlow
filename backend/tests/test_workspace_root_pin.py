"""Workflow subtasks must honour the run-level project_path as their cwd.

Regression guard for: every step of one workflow run resolving ``outputs/...``
against a different base directory, because the delegated subagent inherited
whatever cwd the host process happened to have. The run-level ``project_path``
was resolved, persisted, and read by artifact verification, but never reached
the layer that actually spawns the worker.
"""

from __future__ import annotations

import inspect

from evoflow.tools.builtins.collab_bridge import delegate_via_task_tool
from evoflow.tools.builtins.task_tool import task_tool


def _coroutine():
    return getattr(task_tool, "coroutine", task_tool)


def test_task_tool_accepts_workspace_root():
    assert "workspace_root" in inspect.signature(_coroutine()).parameters


def test_bridge_forwards_workspace_root():
    assert "workspace_root" in inspect.signature(delegate_via_task_tool).parameters


def test_acp_delegation_helpers_removed():
    """ACP is retired; the inert helpers must not come back."""
    from evoflow.tools.builtins.supervisor import execution

    assert not hasattr(execution, "_is_acp_worker")
    assert not hasattr(execution, "_delegate_via_acp_tool")


def test_workspace_root_pin_overrides_inherited_root():
    """A caller-supplied workspace_root wins over the inherited context root."""
    from evoflow.tools.builtins.supervisor import execution

    src = inspect.getsource(execution)
    assert "workspace_root=worker_workspace_root" in src


def test_pin_precedence_in_task_tool_source():
    """The pin must be applied *after* the context lookup, not instead of it."""
    src = inspect.getsource(_coroutine())
    ctx_pos = src.find('parent_local_workspace_root = str(ctx_map.get("local_workspace_root")')
    pin_pos = src.find("pinned_root = str(workspace_root")
    assert ctx_pos != -1 and pin_pos != -1
    assert pin_pos > ctx_pos, "workspace_root must override the context-derived root"
    # The pinned value has to feed the variable handed to the subagent session.
    tail = src[pin_pos:]
    assert "parent_local_workspace_root = pinned_root" in tail
    assert "project_workspace_path = parent_local_workspace_root" in tail
