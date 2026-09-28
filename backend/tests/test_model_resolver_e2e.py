"""Integration tests for the full model-resolution stack.

These tests verify that the resolver is wired correctly into:
1. ``resolve_session_model_name_from_runtime`` (subagent/worker delegation)
2. ``sync_employee_from_agent`` (employee NOT inheriting model)

``factory.create_chat_model`` is not covered end-to-end here because it
needs to instantiate a real LangChain model. That path is tested by the
unit tests (test_model_resolver.py) via a 1-line stub replacement of
``_default_resolved_model_name``.

Run: cd backend && python -m pytest tests/test_model_resolver_e2e.py -v
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

import pytest

from evoflow.config.app_config import reset_app_config
from evoflow.config.app_config import set_app_config as _set_real_app_config
from evoflow.models.resolver import (
    SOURCE_AGENT,
    SOURCE_GLOBAL_FIRST,
    SOURCE_GLOBAL_PRIMARY,
    SOURCE_RUNTIME,
)


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

class _FakeAppConfig:
    """Duck-type AppConfig carrying only what the resolution chain needs."""

    def __init__(self, models: list[str], primary: str | None = None) -> None:
        self.primary_model = primary
        self.models = [_FakeModel(n) for n in models]

    def get_model_config(self, name: str | None) -> SimpleNamespace | None:
        if not name:
            return None
        for m in self.models:
            if m.name == name:
                return m
        return None


class _FakeModel:
    """Minimal ModelConfig duck-type — only ``.name`` is read by resolver."""

    def __init__(self, name: str) -> None:
        self.name = name


def _install_fake_config(models: list[str], primary: str | None = None) -> None:
    """Install a _FakeAppConfig for the resolver to read."""
    reset_app_config()
    _set_real_app_config(_FakeAppConfig(models, primary))  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# resolver — the four-tier ladder exercised from the outside
# ---------------------------------------------------------------------------

class TestResolverLadderE2E:
    """Exercise the resolver through its public API with a fake AppConfig."""

    def test_tier1_runtime_wins(self):
        _install_fake_config(["gpt-4", "claude-3"], primary="gpt-4")
        from evoflow.models.resolver import resolve_run_model_with_source

        name, source = resolve_run_model_with_source(
            agent_code="main",
            cfg={"model_name": "claude-3"},
        )
        assert name == "claude-3"
        assert source == SOURCE_RUNTIME

    def test_tier2_agent_used_when_runtime_empty(self):
        _install_fake_config(["gpt-4", "claude-3"], primary="gpt-4")
        from evoflow.models.resolver import resolve_run_model_with_source

        with patch(
            "evoflow.config.agents_config.load_agent_config",
            return_value=SimpleNamespace(model="claude-3"),
        ):
            name, source = resolve_run_model_with_source(
                agent_code="main",
                cfg={},
            )
        assert name == "claude-3"
        assert source == SOURCE_AGENT

    def test_tier3_primary_used_when_agent_absent(self):
        _install_fake_config(["gpt-4", "claude-3"], primary="gpt-4")
        from evoflow.models.resolver import resolve_run_model_with_source

        with patch(
            "evoflow.config.agents_config.load_agent_config",
            return_value=None,
        ):
            name, source = resolve_run_model_with_source(
                agent_code="main",
                cfg={},
            )
        assert name == "gpt-4"
        assert source == SOURCE_GLOBAL_PRIMARY

    def test_tier4_first_used_when_no_primary(self):
        _install_fake_config(["claude-3", "gpt-4"], primary=None)
        from evoflow.models.resolver import resolve_run_model_with_source

        with patch(
            "evoflow.config.agents_config.load_agent_config",
            return_value=None,
        ):
            name, source = resolve_run_model_with_source(
                agent_code="main",
                cfg={},
            )
        assert name == "claude-3"
        assert source == SOURCE_GLOBAL_FIRST


# ---------------------------------------------------------------------------
# runtime_context — delegation path fallback
# ---------------------------------------------------------------------------

class TestRuntimeContextDelegation:
    """resolve_session_model_name_from_runtime returns None when nothing is set;
    the resolver final-fallback kicks in to avoid None propagation."""

    def test_nothing_set_resolver_fallback(self):
        _install_fake_config(["gpt-4"], primary="gpt-4")
        from evoflow.agents.lead_agent.runtime_context import (
            resolve_session_model_name_from_runtime,
        )

        result = resolve_session_model_name_from_runtime(runtime=None)
        assert result == "gpt-4"

    def test_nothing_set_no_primary_falls_to_first(self):
        _install_fake_config(["claude-3", "gpt-4"], primary=None)
        from evoflow.agents.lead_agent.runtime_context import (
            resolve_session_model_name_from_runtime,
        )

        result = resolve_session_model_name_from_runtime(runtime=None)
        assert result == "claude-3"


# ---------------------------------------------------------------------------
# employees — model is NOT synced from Agent on sync_employee_from_agent
# ---------------------------------------------------------------------------

class TestEmployeeModelNotSynced:
    """sync_employee_from_agent must NOT write cfg.model_name from agent_row.model.

    Employee model lives independently; it only gets written at dispatch time
    (proactive engine) or by the user on the employee detail page. The sync
    function should leave cfg.model_name untouched.
    """

    def test_sync_does_not_touch_model_name(self):
        _install_fake_config(["gpt-4"], primary="gpt-4")
        from evoflow.admin.employees import sync_employee_from_agent

        with patch(
            "evoflow.admin.employees.ProactiveRepository.get_role"
        ) as get_role, patch(
            "evoflow.admin.agents.get_agent"
        ) as get_agent, patch(
            "evoflow.admin.employees.ProactiveRepository.save_role"
        ), patch(
            "evoflow.proactive.schedule.ensure_role_schedule_fields",
            return_value=False,
        ):
            role_cfg = SimpleNamespace()
            role_cfg.skills = []
            role_cfg.soul_md = ""
            role_cfg.tool_groups = []
            role_cfg.extra_context = {}
            role_cfg.model_name = None  # pre-existing; must stay None
            get_role.return_value = SimpleNamespace(
                config=role_cfg,
                agent_code="test-emp",
                role_name="Test Emp",
            )
            get_agent.return_value = {
                "skills": ["code"],
                "soul": "test soul",
                "tools": ["shell"],
                "model": "claude-3",  # agent pinned to claude-3
            }
            result = sync_employee_from_agent("test-emp")

        assert result["synced"] is True
        # model_name must NOT have been written from agent_row
        assert getattr(role_cfg, "model_name", None) is None
