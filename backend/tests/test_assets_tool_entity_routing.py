"""assets tool is registered and routes employee notes by runtime identity."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

import importlib

from evoflow.assets.paths import EntityRef
from evoflow.tools.tools import get_builtin_tools

_assets = importlib.import_module("evoflow.tools.builtins.assets_tool")
_resolve_entity = _assets._resolve_entity


def test_assets_in_builtin_catalog() -> None:
    get_builtin_tools.cache_clear()
    names = {getattr(t, "name", "") for t in get_builtin_tools()}
    assert "assets" in names


def test_employee_note_uses_employee_tree_even_with_principal() -> None:
    """Authenticated caller + employee agent → employee bucket, not users/<pid>."""
    runtime = SimpleNamespace(
        context={
            "agent_name": "douyin-analyst",
            "principal_id": "user-yin-tai",
        },
        config={},
    )
    # Patch employee detection so we don't need SQLite role rows.
    import evoflow.tools.builtins.assets_tool as mod

    real_is_emp = None
    try:
        from evoflow.assets import guidance

        real_is_emp = guidance.is_employee_agent_name
        guidance.is_employee_agent_name = lambda name: str(name or "").lower() == "douyin-analyst"
        ent = _resolve_entity(runtime, action="note")
        assert ent == EntityRef("employee", "douyin-analyst").normalized()
    finally:
        if real_is_emp is not None:
            from evoflow.assets import guidance

            guidance.is_employee_agent_name = real_is_emp


def test_runtime_context_dataclass_agent_name() -> None:
    from evoflow.agents.lead_agent.runtime_context import LeadAgentRuntimeContext

    runtime = SimpleNamespace(
        context=LeadAgentRuntimeContext(agent_name="douyin-analyst", principal_id="p1"),
        config={},
    )
    from evoflow.assets import guidance

    real = guidance.is_employee_agent_name
    try:
        guidance.is_employee_agent_name = lambda name: str(name or "").lower() == "douyin-analyst"
        ent = _resolve_entity(runtime, action="note")
        assert ent.entity_type == "employee"
        assert ent.entity_id == "douyin-analyst"
    finally:
        guidance.is_employee_agent_name = real
