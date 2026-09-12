"""Worker validation before supervisor delegates to task_tool."""

from __future__ import annotations

from unittest.mock import patch

from evoflow.tools.builtins.supervisor.execution import _worker_delegation_error


def test_worker_delegation_error_empty_assignee():
    assert _worker_delegation_error("") is not None
    assert "No worker assigned" in _worker_delegation_error("")


@patch("evoflow.subagents.get_subagent_config", return_value=None)
@patch("evoflow.subagents.get_available_subagent_names", return_value=["general-purpose"])
def test_worker_delegation_error_unknown_custom(_names, _cfg):
    err = _worker_delegation_error("crud-api")
    assert err is not None
    assert "crud-api" in err
    assert "system_prompt" in err


@patch("evoflow.subagents.get_subagent_config", return_value=object())
def test_worker_delegation_error_known_worker(_cfg):
    assert _worker_delegation_error("general-purpose") is None


# --- system_prompt fallback (SOUL / description) coverage ---


class _FakeAgentCfg:
    def __init__(self, agent_type="custom", system_prompt="", soul=None, description=""):
        self.agent_type = agent_type
        self.agent_code = "fake-worker"
        self.system_prompt = system_prompt
        self.soul = soul
        self.description = description
        self.tools = None
        self.disallowed_tools = None
        self.model = None
        self.max_turns = 500
        self.timeout_seconds = 900


def test_resolve_system_prompt_uses_non_empty_system_prompt():
    from evoflow.subagents.registry import _resolve_subagent_system_prompt

    cfg = _FakeAgentCfg(system_prompt="  real prompt  ", description="desc", soul="soul")
    assert _resolve_subagent_system_prompt(cfg) == "real prompt"


@patch("evoflow.config.agents_config.load_agent_soul", return_value="  soul text  ")
def test_resolve_system_prompt_falls_back_to_soul_when_empty(_load):
    from evoflow.subagents.registry import _resolve_subagent_system_prompt

    cfg = _FakeAgentCfg(system_prompt="", description="desc")
    assert _resolve_subagent_system_prompt(cfg) == "soul text"


@patch("evoflow.config.agents_config.load_agent_soul", return_value=None)
def test_resolve_system_prompt_falls_back_to_description(_load):
    from evoflow.subagents.registry import _resolve_subagent_system_prompt

    cfg = _FakeAgentCfg(system_prompt="", description="  fallback desc  ")
    assert _resolve_subagent_system_prompt(cfg) == "fallback desc"


@patch("evoflow.config.agents_config.load_agent_soul", return_value=None)
def test_resolve_system_prompt_empty_when_all_sources_empty(_load):
    from evoflow.subagents.registry import _resolve_subagent_system_prompt

    cfg = _FakeAgentCfg(system_prompt="", description="")
    assert _resolve_subagent_system_prompt(cfg) == ""


@patch("evoflow.config.agents_config.load_agent_soul", return_value="  soul text  ")
def test_agent_config_to_subagent_config_schedules_custom_without_system_prompt(_load):
    """Custom agent with empty system_prompt but a SOUL must still be schedulable."""
    from evoflow.subagents.registry import _agent_config_to_subagent_config

    cfg = _FakeAgentCfg(system_prompt="", description="short desc")
    sub = _agent_config_to_subagent_config(cfg)
    assert sub is not None
    assert sub.system_prompt == "soul text"


def test_agent_config_to_subagent_config_none_when_non_custom():
    from evoflow.subagents.registry import _agent_config_to_subagent_config

    cfg = _FakeAgentCfg(agent_type="acp", system_prompt="x")
    assert _agent_config_to_subagent_config(cfg) is None
