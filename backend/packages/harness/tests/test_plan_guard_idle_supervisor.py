"""Tests for idle-phase supervisor gating (plan scenario must be active)."""

from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from langchain.agents.middleware.types import ModelRequest
from langchain_core.messages import AIMessage, SystemMessage, ToolMessage

from evoflow.agents.middlewares.plan_guard_middleware import PlanGuardMiddleware, _conversation_has_plan


def _tool_names(tools: list) -> list[str]:
    return [str(getattr(t, "name", "") or "").strip() for t in (tools or [])]


def _tool_call_names(ai: AIMessage) -> list[str]:
    out: list[str] = []
    for tc in getattr(ai, "tool_calls", None) or []:
        if isinstance(tc, dict):
            out.append(str(tc.get("name", "") or "").strip())
        else:
            out.append(str(getattr(tc, "name", "") or "").strip())
    return out


def _minimal_request(*, phase: str, tools: list, human_last: bool = False):
    model = MagicMock()
    runtime = MagicMock()
    runtime.context = {"collab_phase": phase, "thread_id": "test-thread"}
    msgs = []
    if human_last:
        from langchain_core.messages import HumanMessage

        msgs = [HumanMessage(content="go")]
    return ModelRequest(
        model=model,
        messages=msgs,
        system_message=SystemMessage(content="sys"),
        tool_choice=None,
        tools=tools,
        response_format=None,
        state={"messages": msgs},
        runtime=runtime,
        model_settings={},
    )


@pytest.fixture
def mw() -> PlanGuardMiddleware:
    return PlanGuardMiddleware()


def test_idle_hides_supervisor_when_plan_not_active(mw: PlanGuardMiddleware, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "evoflow.tools.builtins.scenario_activation.get_activated_scenarios",
        lambda: ["chat"],
    )
    tools = [
        SimpleNamespace(name="supervisor"),
        SimpleNamespace(name="todo"),
        SimpleNamespace(name="scenario"),
    ]

    req = _minimal_request(phase="idle", tools=tools)
    out = mw._filter_request_tools_for_phase(req)
    names = set(_tool_names(out.tools))
    assert "supervisor" not in names
    assert "todo" in names
    assert "scenario" in names


def test_idle_keeps_supervisor_when_plan_active(mw: PlanGuardMiddleware, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "evoflow.tools.builtins.scenario_activation.get_activated_scenarios",
        lambda: ["chat", "plan"],
    )
    tools = [SimpleNamespace(name="supervisor"), SimpleNamespace(name="scenario")]
    req = _minimal_request(phase="idle", tools=tools)
    out = mw._filter_request_tools_for_phase(req)
    assert "supervisor" in _tool_names(out.tools)


def test_conversation_has_plan_true_after_successful_plan_tool_message() -> None:
    body = json.dumps(
        {"success": True, "markdown": "# Plan\n\n## Goal\nx\n", "message": "ok"},
        ensure_ascii=False,
    )
    msgs = [ToolMessage(content=body, name="plan", tool_call_id="p1")]
    assert _conversation_has_plan(msgs, tail_ai_content="")


def test_conversation_has_plan_false_when_plan_tool_failed() -> None:
    body = json.dumps({"success": False, "error": "bad"}, ensure_ascii=False)
    msgs = [ToolMessage(content=body, name="plan", tool_call_id="p1")]
    assert not _conversation_has_plan(msgs, tail_ai_content="")


def test_planning_phase_keeps_plan_tool_in_request_tools(mw: PlanGuardMiddleware, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "evoflow.tools.builtins.scenario_activation.get_activated_scenarios",
        lambda: ["chat", "plan"],
    )
    tools = [
        SimpleNamespace(name="plan"),
        SimpleNamespace(name="supervisor"),
    ]
    req = _minimal_request(phase="planning", tools=tools, human_last=True)
    out = mw._filter_request_tools_for_phase(req)
    assert "plan" in _tool_names(out.tools)


def test_planning_phase_strict_plan_keeps_task_not_list_agents(mw: PlanGuardMiddleware, monkeypatch: pytest.MonkeyPatch) -> None:
    """strict plan 下 planning 保留 task/supervisor；list_agents/read_file 由主会话直接调用剔除（改走 task 子任务）。"""
    monkeypatch.setattr(
        "evoflow.tools.builtins.scenario_activation.get_activated_scenarios",
        lambda: ["chat", "plan"],
    )
    tools = [
        SimpleNamespace(name="list_agents"),
        SimpleNamespace(name="task"),
        SimpleNamespace(name="supervisor"),
        SimpleNamespace(name="read_file"),
    ]
    req = _minimal_request(phase="planning", tools=tools, human_last=True)
    out = mw._filter_request_tools_for_phase(req)
    names = set(_tool_names(out.tools))
    assert "task" in names
    assert "supervisor" in names
    assert "list_agents" not in names
    assert "read_file" not in names


def test_planning_phase_uses_planning_allowlist_includes_supervisor(mw: PlanGuardMiddleware, monkeypatch: pytest.MonkeyPatch) -> None:
    """planning 白名单含 supervisor；前置条件由 supervisor 工具返回而非 request.tools 隐藏。"""
    monkeypatch.setattr(
        "evoflow.tools.builtins.scenario_activation.get_activated_scenarios",
        lambda: ["chat"],
    )
    tools = [
        SimpleNamespace(name="supervisor"),
        SimpleNamespace(name="read_file"),
        SimpleNamespace(name="scenario"),
    ]
    req = _minimal_request(phase="planning", tools=tools, human_last=True)
    out = mw._filter_request_tools_for_phase(req)
    names = set(_tool_names(out.tools))
    assert "supervisor" in names
    assert "read_file" in names
    assert "scenario" in names


def test_idle_strip_supervisor_tool_calls_after_model(mw: PlanGuardMiddleware, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "evoflow.tools.builtins.scenario_activation.get_activated_scenarios",
        lambda: ["chat"],
    )
    runtime = MagicMock()
    runtime.context = {"collab_phase": "idle", "thread_id": "test-idle-strip-no-disk"}
    ai = AIMessage(
        content="",
        tool_calls=[{"name": "supervisor", "args": {}, "id": "call-1", "type": "tool_call"}],
    )
    state = {"messages": [ai]}
    upd = mw._filter_tool_calls_for_phase(state, runtime)
    assert upd is not None
    new_msgs = upd.get("messages") or []
    assert len(new_msgs) == 2
    assert isinstance(new_msgs[0], AIMessage)
    assert _tool_call_names(new_msgs[0]) == ["supervisor"]
    assert isinstance(new_msgs[1], ToolMessage)
    assert new_msgs[1].tool_call_id == "call-1"
    assert "supervisor" in str(new_msgs[1].content).lower()


def test_planning_passes_through_supervisor_without_plan(mw: PlanGuardMiddleware) -> None:
    """尚无 Plan 时 supervisor 不再被 middleware 剥除或注入 ask；前置条件由 supervisor 工具返回。"""
    runtime = MagicMock()
    runtime.context = {"collab_phase": "planning", "thread_id": "t-plan-need-plan-first"}
    msgs = [
        AIMessage(
            content="",
            tool_calls=[{"name": "supervisor", "args": {"action": "create_task_with_subtasks"}, "id": "c1", "type": "tool_call"}],
        ),
    ]
    state = {"messages": msgs}
    upd = mw._filter_tool_calls_for_phase(state, runtime)
    assert upd is None or "supervisor" in _tool_call_names((upd.get("messages") or [])[-1])


def test_planning_supervisor_only_after_successful_plan_tool_passes_through(mw: PlanGuardMiddleware) -> None:
    """成功 ``plan`` 工具返回后：仅 supervisor 时 middleware 不再注入执行确认 ask。"""
    runtime = MagicMock()
    runtime.context = {"collab_phase": "planning", "thread_id": "t-plan-tool-then-sup"}
    plan_ok = json.dumps({"success": True, "markdown": "# Plan\n\n## Goal\nx\n"}, ensure_ascii=False)
    msgs = [
        ToolMessage(content=plan_ok, name="plan", tool_call_id="p1"),
        AIMessage(
            content="",
            tool_calls=[{"name": "supervisor", "args": {}, "id": "call-1", "type": "tool_call"}],
        ),
    ]
    state = {"messages": msgs}
    upd = mw._filter_tool_calls_for_phase(state, runtime)
    if upd is not None:
        new_ai = (upd.get("messages") or [])[-1]
        assert "supervisor" in _tool_call_names(new_ai)


def test_planning_supervisor_only_when_prose_plan_without_plan_tool_passes_through(mw: PlanGuardMiddleware) -> None:
    """仅有正文 # Plan、尚未调用 plan 工具保存时：supervisor 调用不再被 middleware 改写。"""
    runtime = MagicMock()
    runtime.context = {"collab_phase": "planning", "thread_id": "t-plan-supervisor-only"}
    msgs = [
        AIMessage(content="# Plan\n\n## Goal\nx\n", tool_calls=[]),
        AIMessage(
            content="",
            tool_calls=[{"name": "supervisor", "args": {}, "id": "call-1", "type": "tool_call"}],
        ),
    ]
    state = {"messages": msgs}
    upd = mw._filter_tool_calls_for_phase(state, runtime)
    assert upd is None or "supervisor" in _tool_call_names((upd.get("messages") or [])[-1])


def test_planning_skips_nl_clarify_after_successful_supervisor_status_markdown(mw: PlanGuardMiddleware) -> None:
    """create_task 等 supervisor 成功后，正文含「请确认」的汇报勿再被收成 ask_clarification。"""
    runtime = MagicMock()
    runtime.context = {"collab_phase": "planning", "thread_id": "t-plan-after-sup"}
    sup_ok = json.dumps(
        {"success": True, "action": "create_task_with_subtasks", "taskId": "Task_x"},
        ensure_ascii=False,
    )
    msgs = [
        ToolMessage(content=sup_ok, name="supervisor", tool_call_id="c1"),
        AIMessage(
            content="任务已创建成功。\n\n请确认下一步是否要启动子任务？\n\n| 字段 | 值 |\n|------|-----|\n| 任务ID | Task_x |",
            tool_calls=[],
        ),
    ]
    state = {"messages": msgs}
    upd = mw._filter_tool_calls_for_phase(state, runtime)
    assert upd is None


def test_idle_skips_nl_clarify_after_successful_supervisor_status_markdown(mw: PlanGuardMiddleware) -> None:
    runtime = MagicMock()
    runtime.context = {"collab_phase": "idle", "thread_id": "t-idle-after-sup"}
    sup_ok = json.dumps({"success": True, "action": "get_status", "taskId": "T1"}, ensure_ascii=False)
    msgs = [
        ToolMessage(content=sup_ok, name="supervisor", tool_call_id="c1"),
        AIMessage(
            content="当前任务状态如下。请确认是否继续轮询？",
            tool_calls=[],
        ),
    ]
    state = {"messages": msgs}
    upd = mw._filter_tool_calls_for_phase(state, runtime)
    assert upd is None


def test_planning_skips_nl_clarify_when_previous_tool_was_successful_scenario(mw: PlanGuardMiddleware) -> None:
    runtime = MagicMock()
    runtime.context = {"collab_phase": "planning", "thread_id": "t-plan-scen"}
    scenario_json = '{"status":"success","action":"activate","scenario_key":"plan"}'
    msgs = [
        ToolMessage(content=scenario_json, name="scenario", tool_call_id="c1"),
        AIMessage(content="已切换到 plan。请问您希望我接下来做什么？", tool_calls=[]),
    ]
    state = {"messages": msgs}
    upd = mw._filter_tool_calls_for_phase(state, runtime)
    assert upd is None


def test_planning_no_exec_confirm_when_switch_plan_prose_mentions执行计划(mw: PlanGuardMiddleware) -> None:
    """口语「制定执行计划」勿误判为已产出 Plan；勿注入 call_exec_confirm ask_clarification。"""
    runtime = MagicMock()
    runtime.context = {"collab_phase": "planning", "thread_id": "t-plan-switch-execphrase"}
    scenario_json = '{"status":"success","action":"activate","scenario_key":"plan"}'
    msgs = [
        ToolMessage(content=scenario_json, name="scenario", tool_call_id="c1"),
        AIMessage(
            content="已切换到规划模式。接下来我可以帮你梳理需求并制定执行计划。",
            tool_calls=[],
        ),
    ]
    state = {"messages": msgs}
    upd = mw._filter_tool_calls_for_phase(state, runtime)
    assert upd is None


def test_idle_keeps_execute_command_when_scenario_tool_message_activated_file(mw: PlanGuardMiddleware, monkeypatch: pytest.MonkeyPatch) -> None:
    """ContextVar 可能尚未带上 file；对话内 scenario 工具已成功激活 file 时不应剥 execute_command。"""
    monkeypatch.setattr(
        "evoflow.agents.mission_state.storage.load_mission_state",
        lambda _tid: None,
    )
    monkeypatch.setattr(
        "evoflow.tools.builtins.scenario_activation.get_activated_scenarios",
        lambda: [],
    )
    scenario_ok = json.dumps(
        {"status": "success", "action": "activate", "scenario_key": "workspace", "all_active_scenarios": ["workspace"]},
        ensure_ascii=False,
    )
    runtime = MagicMock()
    runtime.context = {"collab_phase": "idle", "thread_id": "t-scenario-replay-file"}
    msgs = [
        ToolMessage(content=scenario_ok, name="scenario", tool_call_id="s1"),
        AIMessage(
            content="下一步执行命令",
            tool_calls=[{"name": "execute_command", "args": {"command": "echo ok"}, "id": "c1", "type": "tool_call"}],
        ),
    ]
    state = {"messages": msgs}
    upd = mw._filter_tool_calls_for_phase(state, runtime)
    assert upd is None


def test_idle_keeps_execute_command_tool_call_without_file(mw: PlanGuardMiddleware, monkeypatch: pytest.MonkeyPatch) -> None:
    """未激活 file 时不再剥空 tool_calls；由 wrap_tool_call 返回「工具未激活」。"""
    monkeypatch.setattr(
        "evoflow.agents.mission_state.storage.load_mission_state",
        lambda _tid: None,
    )
    monkeypatch.setattr(
        "evoflow.tools.builtins.scenario_activation.get_activated_scenarios",
        lambda: [],
    )
    runtime = MagicMock()
    runtime.context = {"collab_phase": "idle", "thread_id": "t-no-file-keep-tc"}
    msgs = [
        AIMessage(
            content="",
            tool_calls=[{"name": "execute_command", "args": {"command": "echo x"}, "id": "c1", "type": "tool_call"}],
        ),
    ]
    state = {"messages": msgs}
    upd = mw._filter_tool_calls_for_phase(state, runtime)
    assert upd is None
    assert _tool_call_names(msgs[-1]) == ["execute_command"]


def test_wrap_tool_call_returns_not_activated_for_web_search_without_workspace(mw: PlanGuardMiddleware, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "evoflow.tools.builtins.scenario_activation.get_activated_scenarios",
        lambda: [],
    )
    req = SimpleNamespace(
        tool_call={"name": "web_search", "args": {"query": "news"}, "id": "ws1"},
        state={"messages": []},
        runtime=SimpleNamespace(context={"thread_id": "t-web-gate"}),
    )

    def _handler(_r: object) -> ToolMessage:
        raise AssertionError("handler should not run when workspace scenario is inactive")

    result = mw.wrap_tool_call(req, _handler)  # type: ignore[arg-type]
    assert isinstance(result, ToolMessage)
    assert result.status == "error"
    assert "未激活" in str(result.content)
    assert "workspace" in str(result.content)


def test_wrap_tool_call_returns_not_activated_without_workspace_scenario(mw: PlanGuardMiddleware, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "evoflow.tools.builtins.scenario_activation.get_activated_scenarios",
        lambda: [],
    )
    req = SimpleNamespace(
        tool_call={"name": "search_code_index", "args": {"query": "foo"}, "id": "tc1"},
        state={"messages": []},
        runtime=SimpleNamespace(context={"thread_id": "t-gate"}),
    )

    def _handler(_r: object) -> ToolMessage:
        raise AssertionError("handler should not run when workspace scenario is inactive")

    result = mw.wrap_tool_call(req, _handler)  # type: ignore[arg-type]
    assert isinstance(result, ToolMessage)
    assert result.status == "error"
    assert "未激活" in str(result.content)
    assert "workspace" in str(result.content)


def test_wrap_tool_call_skips_scenario_gate_for_unattended_automation(
    mw: PlanGuardMiddleware, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        "evoflow.tools.builtins.scenario_activation.get_activated_scenarios",
        lambda: [],
    )
    ran = {"ok": False}
    req = SimpleNamespace(
        tool_call={"name": "web_search", "args": {"query": "news"}, "id": "ws-auto"},
        state={"messages": []},
        runtime=SimpleNamespace(
            context={"thread_id": "t-auto", "triggered_by": "automation_scheduler"},
        ),
    )

    def _handler(_r: object) -> ToolMessage:
        ran["ok"] = True
        return ToolMessage(content="ok", tool_call_id="ws-auto", name="web_search")

    result = mw.wrap_tool_call(req, _handler)  # type: ignore[arg-type]
    assert ran["ok"] is True
    assert result.content == "ok"


def test_idle_skips_nl_clarify_when_previous_tool_was_successful_scenario(mw: PlanGuardMiddleware) -> None:
    runtime = MagicMock()
    runtime.context = {"collab_phase": "idle", "thread_id": "t-scenario-nl"}
    scenario_json = '{"status":"success","action":"activate","scenario_key":"plan"}'
    msgs = [
        ToolMessage(content=scenario_json, name="scenario", tool_call_id="c1"),
        AIMessage(content="场景已激活 plan。请问接下来需要我做什么？", tool_calls=[]),
    ]
    state = {"messages": msgs}
    upd = mw._filter_tool_calls_for_phase(state, runtime)
    assert upd is None


def test_done_hides_supervisor_from_request_tools(mw: PlanGuardMiddleware, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "evoflow.tools.builtins.scenario_activation.get_activated_scenarios",
        lambda: [],
    )
    tools = [
        SimpleNamespace(name="supervisor"),
        SimpleNamespace(name="todo"),
        SimpleNamespace(name="read_file"),
    ]
    req = _minimal_request(phase="done", tools=tools)
    out = mw._filter_request_tools_for_phase(req)
    names = set(_tool_names(out.tools))
    assert "supervisor" not in names
    assert "todo" in names
    assert "read_file" in names


def test_done_empty_model_turn_injects_delivery_recovery(mw: PlanGuardMiddleware) -> None:
    runtime = MagicMock()
    runtime.context = {"collab_phase": "done", "thread_id": "t-done-empty"}
    ai = AIMessage(content="", tool_calls=[])
    state = {"messages": [ai]}
    upd = mw._filter_tool_calls_for_phase(state, runtime)
    assert upd is not None
    new_msgs = upd["messages"]
    assert len(new_msgs) == 2
    assert "交付总结" in str(getattr(new_msgs[0], "content", "") or "")


def test_done_strips_supervisor_tool_calls(mw: PlanGuardMiddleware, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "evoflow.tools.builtins.scenario_activation.get_activated_scenarios",
        lambda: [],
    )
    runtime = MagicMock()
    runtime.context = {"collab_phase": "done", "thread_id": "t-done-strip"}
    ai = AIMessage(
        content="",
        tool_calls=[{"name": "supervisor", "id": "1", "args": {"action": "get_status"}}],
    )
    state = {"messages": [ai]}
    upd = mw._filter_tool_calls_for_phase(state, runtime)
    assert upd is not None
    new_msgs = upd["messages"]
    assert len(new_msgs) == 2
    assert isinstance(new_msgs[0], AIMessage)
    assert _tool_call_names(new_msgs[0]) == ["supervisor"]
    assert isinstance(new_msgs[1], ToolMessage)
    assert new_msgs[1].tool_call_id == "1"
    assert "done" in str(new_msgs[1].content).lower() or "终态" in str(new_msgs[1].content)
