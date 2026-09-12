"""Scenario policy excerpt builder and intra-turn vs full prompt assembly."""

from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest
from langchain.agents.middleware.types import ModelRequest
from langchain_core.messages import HumanMessage, SystemMessage, ToolMessage

from evoflow.agents.lead_agent.scenario_policy_excerpt import build_scenario_policy_excerpt
from evoflow.agents.middlewares.dynamic_system_prompt_middleware import (
    DynamicSystemPromptOnScenarioMiddleware,
    _is_intra_turn_scenario_only_change,
)
from evoflow.agents.middlewares.scenario_runtime_hint_middleware import (
    ScenarioRuntimeHintMiddleware,
    _policy_excerpt_patch,
)
from evoflow.tools.builtins.scenario_activation import scenario


def test_build_scenario_policy_excerpt_plan_uses_skill_not_inline_block() -> None:
    text = build_scenario_policy_excerpt(["plan"], prompt_language="zh")
    assert "<collaboration_policy>" not in text
    assert "<decision_policy>" not in text
    assert text.strip() == ""


def test_build_scenario_policy_excerpt_agent_has_no_web_citation_block() -> None:
    text = build_scenario_policy_excerpt(["agent"], prompt_language="zh")
    assert "<web_citation_policy>" not in text
    assert text.strip() == ""


def test_is_intra_turn_scenario_only_change() -> None:
    base = "t::chat::a|b::rd::cr::st0::human1::ms0"
    changed = "t::plan::a|b::rd::cr::st1::human1::ms0"
    assert _is_intra_turn_scenario_only_change(base, changed)
    new_human = "t::plan::a|b::rd::cr::st1::human2::ms0"
    assert not _is_intra_turn_scenario_only_change(base, new_human)


def test_scenario_activate_does_not_return_policy_excerpt_in_tool_payload() -> None:
    with patch(
        "evoflow.agents.middlewares.plan_guard_middleware.strict_plan_lock_blocks_scenario_activate",
        return_value=(False, ""),
    ):
        out = json.loads(scenario.invoke({"action": "activate", "scenario_key": "plan", "reason": "test"}))
    assert out["status"] == "success"
    assert "policy_excerpt" not in out
    assert "prompt_assembly" not in out
    assert "prompt_note" not in out
    assert out.get("activated_tools")


def test_dynamic_middleware_rebuilds_on_intra_turn_scenario_change(monkeypatch: pytest.MonkeyPatch) -> None:
    """Same user turn: scenario(activate) must refresh system prompt (Active scenarios line)."""
    mw = DynamicSystemPromptOnScenarioMiddleware()
    DynamicSystemPromptOnScenarioMiddleware._last_sig_by_thread.clear()

    human = HumanMessage(content="do plan")
    rt = MagicMock()
    rt.context = {
        "thread_id": "t-intra",
        "evf_dynamic_prompt_meta": {
            "all_tool_names": ["scenario", "plan"],
            "subagent_enabled": True,
            "max_concurrent_subagents": 3,
            "agent_name": "main",
        },
    }
    req_chat = ModelRequest(
        model=MagicMock(),
        messages=[human],
        tools=[],
        state={"messages": [human]},
        system_message=SystemMessage("COMPILE_TIME"),
        runtime=rt,
    )

    collab_patch = patch(
        "evoflow.agents.lead_agent.prompt.collab_runtime_state_fingerprint",
        return_value="",
    )
    with (
        collab_patch,
        patch(
            "evoflow.agents.middlewares.plan_guard_middleware.effective_activated_scenario_keys",
            return_value=frozenset({"ask"}),
        ),
    ):
        with patch(
            "evoflow.agents.lead_agent.prompt.apply_prompt_template",
            return_value="FULL",
        ) as ap0:
            mw.wrap_model_call(req_chat, lambda r: MagicMock())
            ap0.assert_called_once()

    tool_payload = {
        "status": "success",
        "action": "activate",
        "scenario_key": "plan",
        "all_active_scenarios": ["plan"],
        "policy_excerpt": "<decision_policy>x</decision_policy>",
    }
    tool_msg = ToolMessage(content=json.dumps(tool_payload, ensure_ascii=False), tool_call_id="tc1", name="scenario")
    from langchain_core.messages import AIMessage

    ai = AIMessage(
        content="",
        tool_calls=[{"id": "tc1", "name": "scenario", "args": {"action": "activate", "scenario_key": "plan"}}],
    )
    req_plan = ModelRequest(
        model=MagicMock(),
        messages=[human, ai, tool_msg],
        tools=[],
        state={"messages": [human, ai, tool_msg]},
        system_message=SystemMessage("FULL"),
        runtime=rt,
    )

    def handler(r: ModelRequest):
        assert (r.system_message.text if r.system_message else "") == "FULL_AGAIN"
        return MagicMock()

    with (
        collab_patch,
        patch(
            "evoflow.agents.middlewares.plan_guard_middleware.effective_activated_scenario_keys",
            return_value=frozenset({"plan"}),
        ),
    ):
        with patch(
            "evoflow.agents.lead_agent.prompt.apply_prompt_template",
            return_value="FULL_AGAIN",
        ) as ap1:
            mw.wrap_model_call(req_plan, handler)
            ap1.assert_called_once()


def test_runtime_hint_injects_policy_excerpt_from_tool_payload() -> None:
    payload = {
        "status": "success",
        "action": "activate",
        "scenario_key": "plan",
        "policy_excerpt": "POLICY_BODY",
        "activated_tools": ["plan", "scenario"],
    }
    patch = _policy_excerpt_patch(payload, ["plan"], prompt_language="zh")
    assert "<scenario_policy_excerpt>" in patch
    assert "POLICY_BODY" in patch

    mw = ScenarioRuntimeHintMiddleware()
    human = HumanMessage(content="hi")
    from langchain_core.messages import AIMessage

    ai = AIMessage(
        content="",
        tool_calls=[{"id": "tc1", "name": "scenario", "args": {"action": "activate", "scenario_key": "plan"}}],
    )
    tool_msg = ToolMessage(
        content=json.dumps(payload, ensure_ascii=False),
        tool_call_id="tc1",
        name="scenario",
    )
    req = ModelRequest(
        model=MagicMock(),
        messages=[human, ai, tool_msg],
        tools=[],
        state={"messages": [human, ai, tool_msg]},
        system_message=SystemMessage("BASE"),
        runtime=MagicMock(context={}),
    )

    captured: list[ModelRequest] = []

    def handler(r: ModelRequest):
        captured.append(r)
        return MagicMock()

    mw.wrap_model_call(req, handler)
    assert captured
    content = str(captured[0].system_message.content or "")
    assert "<scenario_policy_excerpt>" in content
    assert "POLICY_BODY" in content
