"""``todo_write`` 工具：首轮注入不缺键、模型 schema 不泄漏注入参数。

#102 回归：``todo_write`` 100% 报 ``KeyError: 'todos'``（1.1.5 → 1.3.6）。

根因：langgraph 1.0.x 的 ToolNode 对 ``InjectedState("todos")`` 做**无条件**
``state[field]`` 取值（不存在 ``_optional_state_args`` 可选注入机制），而首轮
todo_write 时 state 还没有 ``todos`` 键（PlanningState.todos 是 NotRequired），
于是必抛 ``KeyError(state_field)``。

一次误判修正：早期修复以为「给注入参数加默认值 ``= None`` 就会跳过注入」，
在当前锁定版本（langgraph 1.0.6–1.0.9）上无效——异常发生在取值那一刻，
不会回落到默认值。现改为经 ``ToolRuntime`` 读 state（缺键安全）。

三条测试各自守住：注入参数不泄漏进 schema、首轮不炸、二轮回读 oldTodos。
"""

from __future__ import annotations

import json
from types import SimpleNamespace

from langchain.agents.middleware.todo import PlanningState
from langchain_core.messages import AIMessage
from langgraph.graph import StateGraph
from langgraph.prebuilt import ToolNode

from evoflow.agents.middlewares.todo_middleware import (
    TODO_WRITE_DEFAULT_TOOL_DESCRIPTION,
    _build_todo_write_tool,
    _old_todos_from_runtime,
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


class _FakeRuntime:
    """伪造 ToolRuntime：helper 只读它的 .state。"""

    def __init__(self, state: object) -> None:
        self.state = state


def test_old_todos_from_runtime_degrades_on_every_state_shape() -> None:
    """缺键 / 非列表 / 非 dict state 一律退化空列表，绝不抛。"""
    fake = _FakeRuntime
    assert _old_todos_from_runtime(fake({})) == []
    assert _old_todos_from_runtime(fake({"todos": None})) == []
    assert _old_todos_from_runtime(fake({"todos": "oops"})) == []
    assert _old_todos_from_runtime(fake([{"content": "x"}])) == []
    assert _old_todos_from_runtime(fake(None)) == []
    # 属性形态的 state（pydantic/BaseModel）走 getattr 分支
    attr_form = [{"content": "attr"}]
    assert _old_todos_from_runtime(fake(SimpleNamespace(todos=attr_form))) == attr_form
    hit = [{"content": "hit", "status": "pending"}]
    assert _old_todos_from_runtime(fake({"todos": hit})) == hit
