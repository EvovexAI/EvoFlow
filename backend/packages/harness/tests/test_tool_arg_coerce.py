"""Tests for LLM tool-argument coercion (JSON strings → lists)."""

from __future__ import annotations

from evoflow.tools.arg_coerce import coerce_str_list, coerce_tool_call_args, parse_loose_json_object


def test_coerce_tool_call_args_create_agent_tools():
    raw = '["read_file", "web_search"]'
    out = coerce_tool_call_args("create_agent", {"agent_code": "x", "tools": raw})
    assert out["tools"] == ["read_file", "web_search"]


def test_coerce_tool_call_args_search_code_index_queries():
    out = coerce_tool_call_args(
        "search_code_index",
        {"query": "飞书", "queries": '["feishu", "lark"]'},
    )
    assert out["queries"] == ["feishu", "lark"]


def test_coerce_tool_call_args_knowledge_paths_json_string():
    out = coerce_tool_call_args(
        "knowledge",
        {
            "action": "read",
            "paths": '["setup-im-channel.md"]',
            "vault_id": "kb_builtin_user_guide",
        },
    )
    assert out["paths"] == ["setup-im-channel.md"]
    assert out["vault_id"] == "kb_builtin_user_guide"


def test_coerce_tool_call_args_unknown_tool_unchanged():
    args = {"engines": '["bing"]'}
    assert coerce_tool_call_args("bash", args) == args


def test_coerce_str_list_pipe_and_comma():
    assert coerce_str_list("a|b") == ["a", "b"]
    assert coerce_str_list("a, b") == ["a", "b"]


def test_parse_search_path_prefix():
    from evoflow.tools.arg_coerce import parse_search_path_prefix

    assert parse_search_path_prefix("path:evopanel/src/react MessageContent") == (
        "evopanel/src/react",
        "MessageContent",
    )
    assert parse_search_path_prefix("path:backend/packages MessageRow") == (
        "backend/packages",
        "MessageRow",
    )
    assert parse_search_path_prefix("MessageRow|message-content") == (None, "MessageRow|message-content")
    assert parse_search_path_prefix("path:evopanel/src/react") == ("evopanel/src/react", "")


def test_coerce_tool_call_args_plan_string_steps():
    raw = {
        "goal": "调度测试",
        "steps": '[{"name": "任务1", "goal": "写 task1", "assigned_agent": "general-purpose"}]',
    }
    out = coerce_tool_call_args("plan", raw)
    assert out["goal"] == "调度测试"
    assert isinstance(out["steps"], list)
    assert out["steps"][0]["name"] == "任务1"
    assert out["steps"][0]["assigned_agent"] == "general-purpose"


def test_coerce_tool_call_args_plan_string_depends_on_and_tools():
    raw = {
        "goal": "demo",
        "steps": [
            {
                "name": "s1",
                "goal": "g1",
                "assigned_agent": "general-purpose",
                "depends_on": "1",
                "tools": "read_file,write_file",
            },
        ],
    }
    out = coerce_tool_call_args("plan", raw)
    assert out["steps"][0]["depends_on"] == ["1"]
    assert "read_file" in out["steps"][0]["tools"]
    assert "write_file" in out["steps"][0]["tools"]


def test_coerce_tool_call_args_plan_nested_payload_and_goal_fallback() -> None:
    raw = {
        "plan": {
            "steps": [
                {"name": "任务1", "goal": "写 task1", "subagent_type": "general-purpose"},
            ],
        },
    }
    out = coerce_tool_call_args("plan", raw)
    assert out["goal"] == "写 task1"
    assert out["steps"][0]["assigned_agent"] == "general-purpose"


def test_parse_loose_json_object_salvages_trailing_garbage() -> None:
    raw = (
        '{"goal": "调度", "steps": [{"name": "s1", "goal": "g1", "assigned_agent": "general-purpose"}]}'
        'start_execution", "task_id": "Task_x"}'
    )
    parsed = parse_loose_json_object(raw)
    assert parsed is not None
    assert parsed["goal"] == "调度"
    assert isinstance(parsed["steps"], list)
