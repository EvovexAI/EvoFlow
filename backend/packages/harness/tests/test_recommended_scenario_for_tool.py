from evoflow.agents.lead_agent.intent_tool_profile import recommended_scenario_for_tool


def test_read_file_recommends_workspace_not_plan():
    primary = recommended_scenario_for_tool("read_file", ["plan", "workspace"])
    assert primary == "workspace"


def test_plan_tool_recommends_plan():
    primary = recommended_scenario_for_tool("plan", ["plan", "workspace"])
    assert primary == "plan"


def test_web_search_recommends_workspace():
    primary = recommended_scenario_for_tool("web_search", ["plan", "workspace"])
    assert primary == "workspace"
