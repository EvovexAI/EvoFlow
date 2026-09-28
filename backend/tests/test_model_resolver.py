"""Unit tests for ``evoflow.models.resolver``.

The resolver is the single source of truth for model-name resolution; every
caller is supposed to consult it instead of inlining its own ladder. These
tests pin the resolution order so future refactors cannot silently regress
the priority chain.

Run: cd backend && python -m pytest tests/test_model_resolver.py -v
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from evoflow.config.app_config import reset_app_config, set_app_config
from evoflow.models import resolver
from evoflow.models.resolver import (
    NoChatModelConfiguredError,
    SOURCE_AGENT,
    SOURCE_GLOBAL_FIRST,
    SOURCE_GLOBAL_PRIMARY,
    SOURCE_RUNTIME,
    resolve_run_model,
    resolve_run_model_with_source,
)


# ---------------------------------------------------------------------------
# fixtures
# ---------------------------------------------------------------------------


def _model(name: str, vendor: str = "test") -> SimpleNamespace:
    """``ModelConfig`` duck-type; resolver only reads ``.name``."""
    return SimpleNamespace(name=name, vendor=vendor)


def _cfg_with_models(model_names: list[str], primary_model: str | None = None) -> SimpleNamespace:
    """Fake ``AppConfig`` carrying just what the resolver needs."""
    return SimpleNamespace(
        models=[_model(n) for n in model_names],
        primary_model=primary_model,
    )


@pytest.fixture
def fake_app_config():
    """Install a fake ``AppConfig`` for the duration of one test."""
    holder: dict[str, object] = {}

    def install(model_names: list[str], primary_model: str | None = None) -> SimpleNamespace:
        cfg = _cfg_with_models(model_names, primary_model)
        set_app_config(cfg)  # type: ignore[arg-type]
        holder["cfg"] = cfg
        return cfg

    yield install

    reset_app_config()
    holder.clear()


def _stub_agent_model(model_name: str | None):
    """Make ``load_agent_config`` return ``model_name`` for any agent."""
    patched = patch(
        "evoflow.config.agents_config.load_agent_config",
        return_value=SimpleNamespace(model=model_name) if model_name else None,
    )
    handle = patched.start()
    yield handle
    patched.stop()


# ---------------------------------------------------------------------------
# Resolution order
# ---------------------------------------------------------------------------


class TestResolutionOrder:
    """Highest-priority tier wins; lower tiers only fill in above-tier gaps."""

    def test_runtime_overrides_agent(self, fake_app_config):
        fake_app_config(["gpt-4", "claude-3"], primary_model="gpt-4")
        with patch("evoflow.config.agents_config.load_agent_config") as load_agent:
            load_agent.return_value = SimpleNamespace(model="claude-3")
            name, source = resolve_run_model_with_source(
                agent_code="main",
                cfg={"model_name": "gpt-4"},
            )
        assert name == "gpt-4"
        assert source == SOURCE_RUNTIME

    def test_agent_layer_used_when_runtime_unset(self, fake_app_config):
        fake_app_config(["gpt-4", "claude-3"], primary_model="gpt-4")
        with patch("evoflow.config.agents_config.load_agent_config") as load_agent:
            load_agent.return_value = SimpleNamespace(model="claude-3")
            name, source = resolve_run_model_with_source(
                agent_code="main",
                cfg={},
            )
        assert name == "claude-3"
        assert source == SOURCE_AGENT

    def test_global_primary_used_when_no_agent_or_runtime(self, fake_app_config):
        fake_app_config(["gpt-4", "claude-3"], primary_model="gpt-4")
        # No agent_config mock — code path falls through without an Agent layer.
        # Patch load_agent_config to return None so we exercise the no-agent path.
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

    def test_first_model_used_when_no_primary(self, fake_app_config):
        fake_app_config(["claude-3", "gpt-4"], primary_model=None)
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
# Behavior nuances (proves the spec edge cases)
# ---------------------------------------------------------------------------


class TestBehavior:
    def test_runtime_overrides_employee_model_in_cfg(self, fake_app_config):
        """Employee model flows in through ``cfg.model_name`` so this IS the
        employee tier. If the front-end / desktop later passes a different
        runtime name, that newer value wins.
        """
        fake_app_config(["claude-3", "kimi-k2.5"], primary_model="claude-3")
        # cfg carries employee's model_name, but user just clicked a switch in UI.
        name = resolve_run_model(
            agent_code="main",
            cfg={"model_name": "kimi-k2.5"},  # written by employee dispatch
        )
        assert name == "kimi-k2.5"
        assert name in {"claude-3", "kimi-k2.5"}

    def test_stale_runtime_name_falls_through(self, fake_app_config):
        """If cfg says "stale-model" but AppConfig no longer has it, do not
        crash — fall through to the next tier."""
        fake_app_config(["gpt-4", "claude-3"], primary_model="gpt-4")
        with patch("evoflow.config.agents_config.load_agent_config") as load_agent:
            load_agent.return_value = SimpleNamespace(model="claude-3")
            name, source = resolve_run_model_with_source(
                agent_code="main",
                cfg={"model_name": "stale-model"},
            )
        assert name == "claude-3"
        assert source == SOURCE_AGENT

    def test_legacy_model_key_alias(self, fake_app_config):
        """``cfg['model']`` (LangChain convention) is accepted as runtime."""
        fake_app_config(["gpt-4", "claude-3"], primary_model="gpt-4")
        name = resolve_run_model(
            agent_code="main",
            cfg={"model": "claude-3"},
        )
        assert name == "claude-3"

    def test_default_sentinel_is_unset(self, fake_app_config):
        """``model_name='default'`` means «follow defaults», not «use a model
        literally called "default"``."""
        fake_app_config(["gpt-4", "claude-3"], primary_model="claude-3")
        with patch(
            "evoflow.config.agents_config.load_agent_config",
            return_value=None,
        ):
            name, source = resolve_run_model_with_source(
                agent_code="main",
                cfg={"model_name": "default"},
            )
        assert name == "claude-3"
        assert source == SOURCE_GLOBAL_PRIMARY

    def test_empty_strings_fall_through(self, fake_app_config):
        fake_app_config(["gpt-4"], primary_model="gpt-4")
        with patch(
            "evoflow.config.agents_config.load_agent_config",
            return_value=None,
        ):
            name = resolve_run_model(
                agent_code="main",
                cfg={"model_name": "", "model": "   "},
            )
        assert name == "gpt-4"

    def test_agent_layer_returned_even_when_unconfigured_in_app(self, fake_app_config):
        """An Agent's ``model`` field is honored when present even if the
        simulated primary is something else — agents are allowed to pin their
        own model. (This matches the existing production semantics.)"""
        fake_app_config(["claude-3", "kimi-k2.5"], primary_model="claude-3")
        with patch("evoflow.config.agents_config.load_agent_config") as load_agent:
            load_agent.return_value = SimpleNamespace(model="kimi-k2.5")
            name = resolve_run_model(agent_code="main", cfg={})
        assert name == "kimi-k2.5"

    def test_agent_layer_with_stale_model_falls_through(self, fake_app_config):
        """An Agent whose ``model`` field references a removed model must not
        break the chat pipeline — fall through to global."""
        fake_app_config(["claude-3"], primary_model="claude-3")
        with patch("evoflow.config.agents_config.load_agent_config") as load_agent:
            load_agent.return_value = SimpleNamespace(model="deleted-model")
            name = resolve_run_model(agent_code="main", cfg={})
        assert name == "claude-3"


# ---------------------------------------------------------------------------
# Failure modes
# ---------------------------------------------------------------------------


class TestFailure:
    def test_no_models_raises(self, fake_app_config):
        fake_app_config([], primary_model=None)
        with patch(
            "evoflow.config.agents_config.load_agent_config",
            return_value=None,
        ):
            with pytest.raises(NoChatModelConfiguredError):
                resolve_run_model(agent_code="main", cfg={})

    def test_require_configured_false_returns_empty(self, fake_app_config):
        fake_app_config([], primary_model=None)
        with patch(
            "evoflow.config.agents_config.load_agent_config",
            return_value=None,
        ):
            assert resolve_run_model(
                agent_code="main", cfg={}, require_configured=False
            ) == ""

    def test_runtime_override_unknown_falls_back_to_global(self, fake_app_config):
        """Stale ``cfg.model_name`` that no longer exists in AppConfig falls
        through to the next tier instead of raising. The chat pipeline must
        survive a removed-model cache; end-to-end validation is
        ``create_chat_model``'s job in a downstream layer.
        """
        fake_app_config(["gpt-4"], primary_model="gpt-4")
        with patch(
            "evoflow.config.agents_config.load_agent_config",
            return_value=None,
        ):
            name = resolve_run_model(
                agent_code="main", cfg={"model_name": "external-vendor/x"}
            )
        # We deliberately fall through — verify we did NOT return the bogus name.
        assert name == "gpt-4"


# ---------------------------------------------------------------------------
# Tier 1 source attribution (smoke-level)
# ---------------------------------------------------------------------------


def test_source_labels_are_stable_constants():
    """Source indices are part of the public-ish surface used in logs.

    Pin them so renumbering doesn't silently break observability dashboards.
    """
    assert SOURCE_RUNTIME == 0
    assert SOURCE_AGENT == 1
    assert SOURCE_GLOBAL_PRIMARY == 2
    assert SOURCE_GLOBAL_FIRST == 3


def test_helper_noop_when_get_app_config_fails():
    """``_global_default_model`` must not raise when the config layer is
    broken; it must return ``""`` so the next tier still has a chance."""
    with patch.object(resolver, "get_app_config_safe", return_value=None):
        assert resolver._global_default_model() == ""  # noqa: SLF001


def test_agent_layer_swallows_load_errors(fake_app_config):
    fake_app_config(["gpt-4"], primary_model="gpt-4")

    # load_agent_config blows up — resolver must not crash the chat.
    def boom(*_args, **_kwargs):
        raise OSError("disk gone")

    with patch("evoflow.config.agents_config.load_agent_config", side_effect=boom):
        name = resolve_run_model(agent_code="main", cfg={})
    assert name == "gpt-4"


# ---------------------------------------------------------------------------
# Module surface
# ---------------------------------------------------------------------------


def test_module_does_not_circularly_import_at_load():
    """The resolver is imported widely (factory, lead_agent, proactive) and
    must not pull in anything that requires a fully-built app to exist.
    """
    # If we got here, the import at the top of the file succeeded.
    assert callable(resolve_run_model)
    assert callable(resolve_run_model_with_source)
    assert MagicMock  # noqa: B018 — keep MagicMock import warm; used by other tests
