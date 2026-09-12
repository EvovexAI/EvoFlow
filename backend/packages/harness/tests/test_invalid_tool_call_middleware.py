from langchain_core.messages import AIMessage

from evoflow.agents.middlewares.invalid_tool_call_middleware import InvalidToolCallMiddleware


def test_invalid_tool_calls_materialized_as_tool_messages():
    mw = InvalidToolCallMiddleware()
    ai = AIMessage(
        content="",
        tool_calls=[],
        invalid_tool_calls=[
            {
                "id": "call_bad",
                "name": "read_file",
                "args": "{not json",
                "error": "Failed to parse tool arguments",
            }
        ],
    )
    out = mw.after_model({"messages": [ai]}, None)
    assert out is not None
    msgs = out["messages"]
    assert len(msgs) == 2
    assert getattr(msgs[0], "invalid_tool_calls", None)
    assert len(getattr(msgs[0], "invalid_tool_calls", None) or []) == 1
    assert msgs[1].type == "tool"
    assert "not executed" in str(msgs[1].content).lower()


def test_invalid_plan_tool_call_repaired_from_string_steps():
    mw = InvalidToolCallMiddleware()
    args_json = (
        '{"goal": "demo", "steps": '
        '[{"name": "script", "goal": "write script", "assigned_agent": "general-purpose"}]}'
    )
    ai = AIMessage(
        content="",
        tool_calls=[],
        invalid_tool_calls=[
            {
                "id": "call_plan_1",
                "name": "plan",
                "args": args_json,
                "error": "Input should be a valid array",
            }
        ],
    )
    out = mw.after_model({"messages": [ai]}, None)
    assert out is not None
    msgs = out["messages"]
    assert len(msgs) == 1
    repaired = msgs[0]
    assert getattr(repaired, "invalid_tool_calls", None) == []
    calls = getattr(repaired, "tool_calls", None) or []
    assert len(calls) == 1
    assert calls[0]["name"] == "plan"
    assert calls[0]["args"]["goal"] == "demo"
    assert isinstance(calls[0]["args"]["steps"], list)


def test_invalid_plan_tool_call_repaired_string_depends_on_and_tools() -> None:
    mw = InvalidToolCallMiddleware()
    args_json = (
        '{"goal": "demo", "steps": [{"name": "s1", "goal": "g1", "assigned_agent": "general-purpose", '
        '"depends_on": "1", "tools": "[\\"read_file\\"]"}]}'
    )
    ai = AIMessage(
        content="",
        tool_calls=[],
        invalid_tool_calls=[
            {
                "id": "call_plan_2",
                "name": "plan",
                "args": args_json,
                "error": "Input should be a valid array",
            }
        ],
    )
    out = mw.after_model({"messages": [ai]}, None)
    assert out is not None
    repaired = out["messages"][0]
    calls = getattr(repaired, "tool_calls", None) or []
    assert len(calls) == 1
    step = calls[0]["args"]["steps"][0]
    assert step["depends_on"] == ["1"]
    assert step["tools"] == ["read_file"]


def test_invalid_mind_map_op_as_tool_gets_misinvoked_hint():
    mw = InvalidToolCallMiddleware()
    ai = AIMessage(
        content="",
        tool_calls=[],
        invalid_tool_calls=[
            {
                "id": "call_patch",
                "name": "patch_node",
                "args": '{"id":"file:src/x.ts","append_body":"facts"}',
                "error": "Invalid tool call",
            }
        ],
    )
    out = mw.after_model({"messages": [ai]}, None)
    assert out is not None
    msgs = out["messages"]
    assert len(msgs) == 2
    content = str(msgs[1].content)
    assert "not executed" in content.lower()
    assert "NOT a standalone tool" in content or "mind_map" in content
    assert "patch_node" in content


def test_invalid_plan_tool_call_repaired_when_args_merged_with_supervisor_tail() -> None:
    mw = InvalidToolCallMiddleware()
    args_json = (
        '{"goal": "任务调度测试", "steps": [{"name": "任务1", "goal": "写 task1", "subagent_type": "general-purpose", '
        '"tools": ["read_file", "write_to_file"], "depends_on": []}]}start_execution", "task_id": "Task_x"}'
    )
    ai = AIMessage(
        content="",
        tool_calls=[],
        invalid_tool_calls=[
            {
                "id": "call_plan_merged",
                "name": "plan",
                "args": args_json,
                "error": "Invalid JSON",
            }
        ],
    )
    out = mw.after_model({"messages": [ai]}, None)
    assert out is not None
    repaired = out["messages"][0]
    calls = getattr(repaired, "tool_calls", None) or []
    assert len(calls) == 1
    assert calls[0]["args"]["goal"] == "任务调度测试"
    assert calls[0]["args"]["steps"][0]["assigned_agent"] == "general-purpose"
