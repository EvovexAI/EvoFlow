"""Role thinking/model prefs must fill interactive runs that omit them (e.g. dept group)."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

from evoflow.proactive.chat_session import (
    apply_role_model_to_run_cfg,
    apply_role_thinking_to_run_cfg,
)


def test_skips_when_session_already_pinned_enabled():
    cfg = {"thinking_enabled": True, "proactive_agent_code": "dev"}
    apply_role_thinking_to_run_cfg(cfg)
    assert cfg["thinking_enabled"] is True
    assert "thinking_type" not in cfg


def test_skips_when_thinking_type_set():
    cfg = {"thinking_type": "auto", "proactive_agent_code": "dev"}
    apply_role_thinking_to_run_cfg(cfg)
    assert "thinking_enabled" not in cfg


def test_applies_role_off_for_proactive_agent():
    role = SimpleNamespace(config=SimpleNamespace(thinking_enabled=False))
    cfg = {"proactive_agent_code": "fullstack-dev", "session_key": "proactive:fullstack-dev:chat:dept-x"}
    with patch("evoflow.proactive.repositories.ProactiveRepository.get_role", return_value=role):
        apply_role_thinking_to_run_cfg(cfg)
    assert cfg["thinking_enabled"] is False
    assert cfg["thinking_type"] == "manual"
    assert cfg["reasoning_effort"] == "minimum"


def test_applies_role_on():
    role = SimpleNamespace(config=SimpleNamespace(thinking_enabled=True))
    cfg = {"proactive_agent_code": "fullstack-dev"}
    with patch("evoflow.proactive.repositories.ProactiveRepository.get_role", return_value=role):
        apply_role_thinking_to_run_cfg(cfg)
    assert cfg["thinking_enabled"] is True
    assert cfg["thinking_type"] == "manual"
    assert cfg["reasoning_effort"] == "medium"


def test_follow_null_leaves_cfg_alone():
    role = SimpleNamespace(config=SimpleNamespace(thinking_enabled=None))
    cfg = {"proactive_agent_code": "fullstack-dev"}
    with patch("evoflow.proactive.repositories.ProactiveRepository.get_role", return_value=role):
        apply_role_thinking_to_run_cfg(cfg)
    assert "thinking_enabled" not in cfg
    assert "thinking_type" not in cfg


def test_ignores_main_agent():
    cfg = {"agent_name": "main"}
    apply_role_thinking_to_run_cfg(cfg)
    assert "thinking_enabled" not in cfg


def test_model_skips_when_session_pinned():
    cfg = {"model_name": "glm-5", "proactive_agent_code": "dev"}
    apply_role_model_to_run_cfg(cfg)
    assert cfg["model_name"] == "glm-5"


def test_model_applies_role_when_unset():
    role = SimpleNamespace(config=SimpleNamespace(model_name="kimi-k2.5"))
    cfg = {"proactive_agent_code": "fullstack-dev"}
    with patch("evoflow.proactive.repositories.ProactiveRepository.get_role", return_value=role):
        apply_role_model_to_run_cfg(cfg)
    assert cfg["model_name"] == "kimi-k2.5"


def test_model_empty_role_leaves_alone():
    role = SimpleNamespace(config=SimpleNamespace(model_name=""))
    cfg = {"proactive_agent_code": "fullstack-dev"}
    with patch("evoflow.proactive.repositories.ProactiveRepository.get_role", return_value=role):
        apply_role_model_to_run_cfg(cfg)
    assert "model_name" not in cfg


def test_model_default_sentinel_treated_as_unset():
    role = SimpleNamespace(config=SimpleNamespace(model_name="kimi-k2.5"))
    cfg = {"model_name": "default", "proactive_agent_code": "fullstack-dev"}
    with patch("evoflow.proactive.repositories.ProactiveRepository.get_role", return_value=role):
        apply_role_model_to_run_cfg(cfg)
    assert cfg["model_name"] == "kimi-k2.5"
