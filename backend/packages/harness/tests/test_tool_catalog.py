"""Tool tier catalog for builtin tools."""

from __future__ import annotations

import tempfile

import pytest

from evoflow.tools.tool_catalog import (
    TOOL_TIER_LABELS_ZH,
    enrich_tool_catalog_fields,
    resolve_tool_tier,
    tier_sort_key,
)


@pytest.fixture
def sqlite_tmp(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        from evoflow.persistence.db import get_db, reset_db_for_tests

        reset_db_for_tests()
        get_db()
        yield
        reset_db_for_tests()


def test_runtime_tools() -> None:
    assert resolve_tool_tier("tool_search") == "runtime"
    assert resolve_tool_tier("mode_set") == "runtime"
    assert resolve_tool_tier("scenario") == "runtime"
    assert resolve_tool_tier("scenario_activation") == "runtime"
    assert resolve_tool_tier("ask_clarification") == "runtime"


def test_workspace_tools() -> None:
    assert resolve_tool_tier("read") == "workspace"
    assert resolve_tool_tier("terminal") == "workspace"
    assert resolve_tool_tier("subagent") == "workspace"
    assert resolve_tool_tier("todo") == "workspace"
    assert resolve_tool_tier("mind_map") == "workspace"
    assert resolve_tool_tier("web_search") == "workspace"
    assert resolve_tool_tier("write") == "workspace"
    assert resolve_tool_tier("process") == "workspace"


def test_plan_tools() -> None:
    assert resolve_tool_tier("plan") == "plan"
    assert resolve_tool_tier("supervisor") == "plan"


def test_goal_mode_tools() -> None:
    assert resolve_tool_tier("propose_goal") == "goal"
    # goal_report retired — completion detection is model-side only
    assert resolve_tool_tier("goal_report") != "goal"


def test_optional_tools() -> None:
    assert resolve_tool_tier("invoke_acp_agent") == "optional"


def test_session_search_is_retired_cli() -> None:
    assert resolve_tool_tier("session_search") == "retired"


def test_retired_tools() -> None:
    assert resolve_tool_tier("create_agent") == "retired"
    assert resolve_tool_tier("vision_analyze") == "retired"
    assert resolve_tool_tier("skill_manager") == "retired"
    assert resolve_tool_tier("image_search") == "retired"
    assert resolve_tool_tier("web_fetch") == "retired"
    assert resolve_tool_tier("search_tool_trace") == "retired"
    assert resolve_tool_tier("process_start") == "retired"
    assert resolve_tool_tier("process_log") == "retired"
    assert resolve_tool_tier("process_wait") == "retired"
    assert resolve_tool_tier("process_kill") == "retired"
    assert resolve_tool_tier("read_file") == "retired"
    assert resolve_tool_tier("write_to_file") == "retired"
    assert resolve_tool_tier("find_file") == "retired"


def test_enrich_tool_catalog_fields() -> None:
    doc = enrich_tool_catalog_fields({"name": "web_search", "description": "x"})
    assert doc["tool_type"] == "workspace"
    assert doc["tool_type_label"] == TOOL_TIER_LABELS_ZH["workspace"]


def test_tier_sort_key_orders_runtime_before_core() -> None:
    assert tier_sort_key("runtime") < tier_sort_key("core")
    assert tier_sort_key("core") < tier_sort_key("workspace")


def test_role_editor_configurable_tools() -> None:
    from evoflow.tools.tool_catalog import (
        is_role_editor_configurable_tool,
        is_session_system_tool,
        normalize_agent_tools_whitelist,
    )

    assert is_session_system_tool("tool_search")
    assert is_session_system_tool("mode_set")
    assert is_session_system_tool("scenario")
    assert is_session_system_tool("scenario_activation")
    assert is_session_system_tool("ask_clarification")
    assert not is_role_editor_configurable_tool("tool_search")
    assert not is_role_editor_configurable_tool("scenario")
    assert not is_role_editor_configurable_tool("scenario_activation")
    assert not is_role_editor_configurable_tool("ask_clarification")
    assert not is_role_editor_configurable_tool("plan")
    assert not is_role_editor_configurable_tool("supervisor")
    assert not is_role_editor_configurable_tool("collab_peer_send")
    assert not is_role_editor_configurable_tool("propose_goal")
    # goal_report retired — completion detection is model-side only
    assert not is_role_editor_configurable_tool("panel_set")
    assert not is_role_editor_configurable_tool("platform")
    assert is_role_editor_configurable_tool("read")
    assert is_role_editor_configurable_tool("web_search")
    assert is_role_editor_configurable_tool("invoke_acp_agent")

    mixed = [
        "tool_search",
        "mode_set",
        "scenario",
        "ask_clarification",
        "plan",
        "propose_goal",
        "panel_set",
        "platform",
        "read",
        "web_search",
    ]
    assert normalize_agent_tools_whitelist(mixed) == ["read", "web_search"]
    assert normalize_agent_tools_whitelist(None) is None


def test_role_editor_tier_labels() -> None:
    from evoflow.tools.tool_catalog import role_editor_tier_label_zh

    assert role_editor_tier_label_zh("workspace") == "Agent"
    assert role_editor_tier_label_zh("optional") == "扩展可选"
    assert role_editor_tier_label_zh("plan") == "规划协作"


def test_sync_builtin_tools_persists_tool_type(sqlite_tmp) -> None:
    from evoflow.persistence import config_repositories as cfg_repo
    from evoflow.persistence.bootstrap import sync_builtin_tools_to_db
    from evoflow.persistence.db import get_db, reset_db_for_tests

    del sqlite_tmp
    reset_db_for_tests()
    get_db()
    n = sync_builtin_tools_to_db()
    assert n > 0
    rows = cfg_repo.list_tools()
    by_name = {str(r.get("name") or ""): r for r in rows}
    assert by_name["ask_clarification"]["tool_type"] == "runtime"
    assert by_name["read"]["tool_type"] == "workspace"
    assert by_name["mind_map"]["tool_type"] == "workspace"
    assert by_name["plan"]["tool_type"] == "plan"
