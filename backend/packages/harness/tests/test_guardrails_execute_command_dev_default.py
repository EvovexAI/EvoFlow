"""Guardrails: dev default allows execute_command when only denied via AllowlistProvider."""

from __future__ import annotations

import pytest

from evoflow.config.guardrails_config import (
    get_guardrails_config,
    load_guardrails_config_from_dict,
    reset_guardrails_config,
)


@pytest.fixture(autouse=True)
def _reset_cfg():
    reset_guardrails_config()
    yield
    reset_guardrails_config()


def test_execute_command_removed_from_denied_tools_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("EVOFLOW_GUARDRAILS_DENY_EXECUTE_COMMAND", raising=False)
    load_guardrails_config_from_dict(
        {
            "enabled": True,
            "provider": {
                "use": "evoflow.guardrails.builtin:AllowlistProvider",
                "config": {"denied_tools": ["execute_command", "bash"]},
            },
        }
    )
    cfg = get_guardrails_config()
    assert cfg.provider is not None
    denied = list(cfg.provider.config.get("denied_tools") or [])
    assert "execute_command" not in [str(x) for x in denied]
    assert "bash" in [str(x) for x in denied]


def test_execute_command_stays_denied_when_env_lockdown(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("EVOFLOW_GUARDRAILS_DENY_EXECUTE_COMMAND", "1")
    load_guardrails_config_from_dict(
        {
            "enabled": True,
            "provider": {
                "use": "evoflow.guardrails.builtin:AllowlistProvider",
                "config": {"denied_tools": ["execute_command"]},
            },
        }
    )
    cfg = get_guardrails_config()
    assert cfg.provider is not None
    denied = [str(x) for x in (cfg.provider.config.get("denied_tools") or [])]
    assert "execute_command" in denied


def test_oap_provider_config_untouched(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("EVOFLOW_GUARDRAILS_DENY_EXECUTE_COMMAND", raising=False)
    load_guardrails_config_from_dict(
        {
            "enabled": True,
            "provider": {
                "use": "aport_guardrails.providers.generic:OAPGuardrailProvider",
                "config": {"denied_tools": ["execute_command"]},
            },
        }
    )
    cfg = get_guardrails_config()
    assert cfg.provider is not None
    denied = [str(x) for x in (cfg.provider.config.get("denied_tools") or [])]
    assert "execute_command" in denied
