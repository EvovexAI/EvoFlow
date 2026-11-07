"""``todo_write`` 工具：首轮注入不缺键、模型 schema 不泄漏 old_todos。

#102 回归：``todo_write`` 100% 报 ``KeyError: 'todos'``（1.1.5 → 1.3.6）。

根因：langgraph 的 ToolNode 注入 ``InjectedState("todos")`` 时，只有当该参数
**不是必填**（``_optional_state_args``）才允许 state 里缺这个 key；否则直接
``raise KeyError(state_field)``。首轮 todo_write 时 state 还没有 ``todos``
键（PlanningState.todos 是 NotRequired），必填注入必炸。

修复：``old_todos`` 改为带默认值 ``None`` 的可选注入参数 —— 缺键时跳过注入，
工具用默认 None 继续跑（oldTodos 退化为空列表）。
"""

from __future__ import annotations

import json

from langchain.agents.middleware.todo import PlanningState
from langchain_core.messages import AIMessage
from langgraph.graph import StateGraph
from langgraph.prebuilt import ToolNode

from evoflow.agents.middlewares.todo_middleware import (
    TODO_WRITE_DEFAULT_TOOL_DESCRIPTION,
    _build_todo_write_tool,
)


def _build_app():
    """搭一个只含 todo_write 的最小图（复刻 ToolNode 注入路径）。"""
    tool = _build_todo_write_tool(TODO_WRITE_DEFAULT_TOOL_DESCRIPTION)
    node = ToolNode([tool])
    graph = StateGraph(PlanningState)
    graph.add_node("tools", node)
    graph.set_entry_point("tools")
    graph.set_finish_point("tools")
    return graph.compile(), tool


def _tool_call(todos: list[dict], call_id: str = "c1") -> dict:
    return {
        "name": "todo_write",
        "args": {"todos": todos},
        "id": call_id,
        "type": "tool_call",
    }


def test_model_visible_schema_only_exposes_todos() -> None:
    """old_todos 是注入参数，不能出现在模型可见的 schema 里。"""
    _, tool = _build_app()
    props = list(tool.tool_call_schema.model_json_schema().get("properties", {}))
    assert props == ["todos"]


def test_todo_write_succeeds_without_existing_todos_state() -> None:
    """首轮调用（state 无 todos 键）不得抛 KeyError。"""
    app, _ = _build_app()
    out = app.invoke(
        {
            "messages": [
                AIMessage("", tool_calls=[_tool_call([{"content": "check structure", "status": "in_progress"}])])
            ]
        }
    )
    assert out.get("todos") == [{"content": "check structure", "status": "in_progress"}]
    payload = json.loads(out["messages"][-1].content)
    assert payload["todos"] == [{"content": "check structure", "status": "in_progress"}]
    # 首次没有旧清单
    assert payload["oldTodos"] == []


def test_todo_write_replaces_full_list_and_reports_old_todos() -> None:
    """全量替换语义：第二次调用带回上一次的 oldTodos。"""
    app, _ = _build_app()
    out = app.invoke(
        {
            "messages": [
                AIMessage("", tool_calls=[_tool_call([{"content": "b", "status": "completed"}], call_id="c2")])
            ],
            "todos": [{"content": "a", "status": "pending"}],
        }
    )
    payload = json.loads(out["messages"][-1].content)
    assert payload["oldTodos"] == [{"content": "a", "status": "pending"}]
    assert payload["todos"] == [{"content": "b", "status": "completed"}]
    assert payload["summary"]["completed"] == 1
