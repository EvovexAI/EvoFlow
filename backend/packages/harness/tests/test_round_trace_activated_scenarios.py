"""Round trace should record activated scenarios consistently with plan_guard (message replay)."""

from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest
from langchain.agents.middleware.types import ModelRequest
from langchain_core.messages import HumanMessage, SystemMessage, ToolMessage

from evoflow.agents.lead_agent.intent_tool_profile import ordered_scenario_keys_for_display
from evoflow.agents.middlewares.plan_guard_middleware import effective_activated_scenario_keys
from evoflow.agents.middlewares.round_trace_middleware import RoundTraceMiddleware
from evoflow.agents.mission_state.models import MissionState


def _request_with_scenario_tool_result(*, thread_id: str, tool_content: str) -> ModelRequest:
    human = HumanMessage(content="query jira")
    tm = ToolMessage(content=tool_content, name="scenario", tool_call_id="tc1")
    runtime = MagicMock()
    runtime.context = {"thread_id": thread_id}
    msgs = [human, tm]
    return ModelRequest(
        model=MagicMock(),
        messages=msgs,
        system_message=SystemMessage(content="sys"),
        tool_choice=None,
        tools=[],
        response_format=None,
        state={"messages": msgs},
        runtime=runtime,
        model_settings={},
    )


@pytest.fixture
def mw() -> RoundTraceMiddleware:
    return RoundTraceMiddleware()


def test_collect_request_context_replays_file_from_scenario_tool_when_contextvar_empty(mw: RoundTraceMiddleware) -> None:
    payload = {
        "status": "success",
        "action": "activate",
        "scenario_key": "workspace",
        "all_active_scenarios": ["workspace"],
    }
    req = _request_with_scenario_tool_result(thread_id="t1", tool_content=json.dumps(payload, ensure_ascii=False))
    with patch(
        "evoflow.tools.builtins.scenario_activation.get_activated_scenarios",
        return_value=[],
    ):
        ctx = mw._collect_request_context(req)
    assert ctx is not None
    assert ctx["activated_scenarios"] == ["workspace"]


def test_ordered_plan_before_file_for_display() -> None:
    assert ordered_scenario_keys_for_display({"workspace", "plan"}) == ["plan", "workspace"]


def test_collect_request_context_orders_plan_before_file_when_both_active(mw: RoundTraceMiddleware) -> None:
    human = HumanMessage(content="monitor tasks")
    runtime = MagicMock()
    runtime.context = {"thread_id": "t3"}
    msgs = [human]
    req = ModelRequest(
        model=MagicMock(),
        messages=msgs,
        system_message=SystemMessage(content="sys"),
        tool_choice=None,
        tools=[],
        response_format=None,
        state={"messages": msgs},
        runtime=runtime,
        model_settings={},
    )
    with patch(
        "evoflow.agents.middlewares.plan_guard_middleware.effective_activated_scenario_keys",
        return_value=frozenset({"plan", "workspace"}),
    ):
        ctx = mw._collect_request_context(req)
    assert ctx is not None
    assert ctx["activated_scenarios"] == ["plan", "workspace"]


def test_collect_request_context_falls_back_to_chat_when_no_evidence(mw: RoundTraceMiddleware) -> None:
    human = HumanMessage(content="hi")
    runtime = MagicMock()
    runtime.context = {"thread_id": "t2"}
    msgs = [human]
    req = ModelRequest(
        model=MagicMock(),
        messages=msgs,
        system_message=SystemMessage(content="sys"),
        tool_choice=None,
        tools=[],
        response_format=None,
        state={"messages": msgs},
        runtime=runtime,
        model_settings={},
    )
    with patch(
        "evoflow.tools.builtins.scenario_activation.get_activated_scenarios",
        return_value=[],
    ):
        ctx = mw._collect_request_context(req)
    assert ctx is not None
    assert ctx["activated_scenarios"] == ["chat"]


def test_effective_keys_loads_mission_when_runtime_context_missing_thread_id() -> None:
    """摘要等路径下 runtime.context 可能无 thread_id；须与 RoundTrace 一致从 get_config 取。"""
    rt = MagicMock()
    rt.context = {}
    ms = MissionState(
        thread_id="tid-fallback",
        primary_objective="x",
        activated_scenarios=["plan"],
        intent_hint="chat",
        change_type="update",
        version=1,
    )
    with patch("langgraph.config.get_config", return_value={"configurable": {"thread_id": "tid-fallback"}}):
        with patch("evoflow.agents.mission_state.storage.load_mission_state", return_value=ms):
            keys = effective_activated_scenario_keys(rt, [])
    assert "plan" in keys
