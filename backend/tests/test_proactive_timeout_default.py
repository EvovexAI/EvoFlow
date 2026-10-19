"""Legacy hire default timeout_seconds=300 must not kill employee runs at 5min."""

from __future__ import annotations

from evoflow.proactive.models import ProactiveRoleConfig


def test_from_json_migrates_legacy_hire_default_300_to_unlimited() -> None:
    cfg = ProactiveRoleConfig.from_json({"timeout_seconds": 300, "max_turns": 10})
    assert cfg.timeout_seconds == 0


def test_from_json_keeps_explicit_non_legacy_timeout() -> None:
    cfg = ProactiveRoleConfig.from_json({"timeout_seconds": 1800})
    assert cfg.timeout_seconds == 1800


def test_from_json_keeps_explicit_zero() -> None:
    cfg = ProactiveRoleConfig.from_json({"timeout_seconds": 0})
    assert cfg.timeout_seconds == 0


def test_model_default_is_unlimited() -> None:
    assert ProactiveRoleConfig().timeout_seconds == 0
