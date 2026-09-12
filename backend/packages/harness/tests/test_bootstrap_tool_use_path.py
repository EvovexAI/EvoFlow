"""Builtin tool DB sync must store importable module paths, not ``builtin:<name>``."""

from __future__ import annotations

from evoflow.persistence.bootstrap import _builtin_tools_need_resync, _tool_use_path
from evoflow.tools.builtins.plan_tool import plan_tool


def test_tool_use_path_resolves_module_variable() -> None:
    path = _tool_use_path(plan_tool)
    assert path == "evoflow.tools.builtins.plan_tool:plan_tool"


def test_resync_when_legacy_builtin_prefix() -> None:
    existing = [{"name": "plan", "use": "builtin:plan"}]
    new = [{"name": "plan", "use": "evoflow.tools.builtins.plan_tool:plan_tool"}]
    assert _builtin_tools_need_resync(existing, new) is True
