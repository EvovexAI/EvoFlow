import json

from evoflow.agents.middlewares.plan_guard_middleware import _build_scenario_not_activated_tool_message


def test_scenario_not_activated_recommends_agent_for_read():
    msg = _build_scenario_not_activated_tool_message(
        "read",
        tool_call_id="tc1",
        candidate_scenarios=["plan", "agent"],
    )
    body = json.loads(msg.content)
    assert body["required_scenario"] == "agent"
    assert body["candidate_scenarios"][0] == "agent"
    assert "推荐 'agent'" in body["_evoflow_tool"]["message"]
    assert "scenario(action='activate'" in body["_evoflow_tool"]["message"]
    assert "content" not in body
