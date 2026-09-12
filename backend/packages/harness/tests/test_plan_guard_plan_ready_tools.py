"""plan_ready / awaiting_exec 阶段不向模型暴露 ask_clarification（执行确认走 UI）。"""

from evoflow.agents.middlewares.plan_guard_middleware import (
    AWAITING_EXEC_ALLOWED_TOOL_NAMES,
    PLAN_READY_ALLOWED_TOOL_NAMES,
    PLANNING_ALLOWED_TOOL_NAMES,
    _allowed_tool_names_for_guard,
    _allowed_tool_names_for_phase,
)
from evoflow.collab.models import CollabPhase


def test_plan_ready_phase_excludes_ask_clarification() -> None:
    allowed = _allowed_tool_names_for_phase(CollabPhase.PLAN_READY.value)
    assert allowed == PLAN_READY_ALLOWED_TOOL_NAMES
    assert "ask_clarification" not in allowed
    assert "plan" in allowed
    assert "supervisor" in allowed


def test_awaiting_exec_phase_excludes_ask_clarification() -> None:
    assert "ask_clarification" not in AWAITING_EXEC_ALLOWED_TOOL_NAMES
    assert "ask_clarification" in PLANNING_ALLOWED_TOOL_NAMES


def test_planning_after_plan_tool_hides_ask_clarification() -> None:
    from langchain_core.messages import AIMessage, ToolMessage

    msgs = [
        AIMessage(content="", tool_calls=[{"id": "p1", "name": "plan", "args": {}}]),
        ToolMessage(content='{"success": true}', tool_call_id="p1", name="plan"),
    ]
    allowed = _allowed_tool_names_for_guard(CollabPhase.PLANNING.value, msgs)
    assert "ask_clarification" not in allowed
    assert "plan" in allowed


def test_plan_ready_empty_model_turn_injects_recovery() -> None:
    """plan 已落库后模型空回复：注入用户可见兜底 + 模型 nudge ToolMessage。"""
    from unittest.mock import MagicMock

    from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

    from evoflow.agents.middlewares.plan_guard_middleware import (
        EMPTY_TURN_NUDGE_TOOL_CALL_ID,
        PlanGuardMiddleware,
    )

    mw = PlanGuardMiddleware()
    runtime = MagicMock()
    runtime.context = {"collab_phase": "plan_ready", "thread_id": "t-plan-ready-empty"}
    msgs = [
        HumanMessage(content="再帮我加一步验收"),
        ToolMessage(content='{"success": true}', tool_call_id="p1", name="plan"),
        AIMessage(content="", tool_calls=[]),
    ]
    upd = mw._filter_tool_calls_for_phase({"messages": msgs}, runtime)
    assert upd is not None
    new_msgs = upd.get("messages") or []
    assert len(new_msgs) == 2
    ai = new_msgs[0]
    assert isinstance(ai, AIMessage)
    assert "计划已落库" in str(getattr(ai, "content", "") or "")
    assert new_msgs[1].tool_call_id == EMPTY_TURN_NUDGE_TOOL_CALL_ID


def test_idle_disk_plan_without_active_scenario_promotes_plan_ready(monkeypatch) -> None:
    """plan 场景已关闭但磁盘仍有 plan 时，虚拟阶段应提升到 plan_ready。"""
    from unittest.mock import MagicMock

    from langchain_core.messages import AIMessage, HumanMessage

    from evoflow.agents.middlewares.plan_guard_middleware import PlanGuardMiddleware

    monkeypatch.setattr(
        "evoflow.agents.middlewares.plan_guard_middleware.effective_activated_scenario_keys",
        lambda _runtime, _msgs: set(),
    )
    monkeypatch.setattr(
        "evoflow.agents.middlewares.plan_guard_middleware._persistence_indicates_committed_plan",
        lambda tid, _db: tid == "t-idle-disk",
    )
    monkeypatch.setattr(
        "evoflow.agents.middlewares.plan_guard_middleware._has_open_committed_plan_on_disk",
        lambda tid, _db: tid == "t-idle-disk",
    )
    monkeypatch.setattr(
        "evoflow.agents.middlewares.plan_guard_middleware._persistence_indicates_execution_authorized",
        lambda _tid, _db: False,
    )
    monkeypatch.setattr(
        "evoflow.agents.middlewares.plan_guard_middleware.is_subagent_focus_mode",
        lambda **_kwargs: False,
    )

    mw = PlanGuardMiddleware()
    runtime = MagicMock()
    runtime.context = {"collab_phase": "idle", "thread_id": "t-idle-disk"}
    msgs = [HumanMessage(content="继续"), AIMessage(content="", tool_calls=[])]
    phase = mw._effective_collab_phase_for_guard(runtime, msgs)
    assert phase == "plan_ready"
    upd = mw._filter_tool_calls_for_phase({"messages": msgs}, runtime)
    assert upd is not None
    assert "计划已落库" in str(getattr((upd.get("messages") or [])[0], "content", "") or "")


def test_before_model_syncs_virtual_phase_to_runtime(monkeypatch) -> None:
    from unittest.mock import MagicMock

    from langchain_core.messages import HumanMessage

    from evoflow.agents.middlewares.plan_guard_middleware import PlanGuardMiddleware

    monkeypatch.setattr(
        "evoflow.agents.middlewares.plan_guard_middleware._persistence_indicates_committed_plan",
        lambda _tid, _db: True,
    )
    monkeypatch.setattr(
        "evoflow.agents.middlewares.plan_guard_middleware._has_open_committed_plan_on_disk",
        lambda _tid, _db: True,
    )
    monkeypatch.setattr(
        "evoflow.agents.middlewares.plan_guard_middleware._persistence_indicates_execution_authorized",
        lambda _tid, _db: False,
    )
    monkeypatch.setattr(
        "evoflow.agents.middlewares.plan_guard_middleware.is_subagent_focus_mode",
        lambda **_kwargs: False,
    )
    monkeypatch.setattr(
        "evoflow.tools.builtins.scenario_activation.sync_plan_scenario_with_session_policy",
        lambda **_kwargs: ["plan"],
    )

    mw = PlanGuardMiddleware()
    runtime = MagicMock()
    runtime.context = {"collab_phase": "idle", "thread_id": "t-sync"}
    state = {"messages": [HumanMessage(content="继续")]}
    mw.before_model(state, runtime)
    assert runtime.context["collab_phase"] == "plan_ready"


def test_before_model_syncs_virtual_phase_with_dataclass_context(monkeypatch) -> None:
    from types import SimpleNamespace

    from langchain_core.messages import HumanMessage

    from evoflow.agents.lead_agent.runtime_context import LeadAgentRuntimeContext
    from evoflow.agents.middlewares.plan_guard_middleware import PlanGuardMiddleware

    monkeypatch.setattr(
        "evoflow.agents.middlewares.plan_guard_middleware._persistence_indicates_committed_plan",
        lambda _tid, _db: True,
    )
    monkeypatch.setattr(
        "evoflow.agents.middlewares.plan_guard_middleware._has_open_committed_plan_on_disk",
        lambda _tid, _db: True,
    )
    monkeypatch.setattr(
        "evoflow.agents.middlewares.plan_guard_middleware._persistence_indicates_execution_authorized",
        lambda _tid, _db: False,
    )
    monkeypatch.setattr(
        "evoflow.agents.middlewares.plan_guard_middleware.is_subagent_focus_mode",
        lambda **_kwargs: False,
    )
    monkeypatch.setattr(
        "evoflow.tools.builtins.scenario_activation.sync_plan_scenario_with_session_policy",
        lambda **_kwargs: ["plan"],
    )

    mw = PlanGuardMiddleware()
    runtime = SimpleNamespace(
        context=LeadAgentRuntimeContext(collab_phase="idle", thread_id="t-sync-dc"),
    )
    state = {"messages": [HumanMessage(content="继续")]}
    mw.before_model(state, runtime)
    assert runtime.context.collab_phase == "plan_ready"


def test_fresh_plan_request_after_workspace_stays_idle(monkeypatch) -> None:
    from unittest.mock import MagicMock

    from langchain_core.messages import HumanMessage

    from evoflow.agents.middlewares.plan_guard_middleware import PlanGuardMiddleware

    monkeypatch.setattr(
        "evoflow.agents.middlewares.plan_guard_middleware.effective_activated_scenario_keys",
        lambda _runtime, _msgs: set(),
    )
    monkeypatch.setattr(
        "evoflow.agents.middlewares.plan_guard_middleware._persistence_indicates_committed_plan",
        lambda _tid, _db: True,
    )
    monkeypatch.setattr(
        "evoflow.agents.middlewares.plan_guard_middleware._has_open_committed_plan_on_disk",
        lambda _tid, _db: False,
    )
    monkeypatch.setattr(
        "evoflow.agents.middlewares.plan_guard_middleware.is_subagent_focus_mode",
        lambda **_kwargs: True,
    )

    mw = PlanGuardMiddleware()
    runtime = MagicMock()
    runtime.context = {"collab_phase": "idle", "thread_id": "t-fresh"}
    msgs = [HumanMessage(content="做一个新的计划")]
    phase = mw._effective_collab_phase_for_guard(runtime, msgs)
    assert phase == "idle"


def test_terminal_disk_plan_does_not_force_plan_ready(monkeypatch) -> None:
    from unittest.mock import MagicMock

    from langchain_core.messages import HumanMessage

    from evoflow.agents.middlewares.plan_guard_middleware import PlanGuardMiddleware

    monkeypatch.setattr(
        "evoflow.agents.middlewares.plan_guard_middleware._persistence_indicates_committed_plan",
        lambda _tid, _db: True,
    )
    monkeypatch.setattr(
        "evoflow.agents.middlewares.plan_guard_middleware._has_open_committed_plan_on_disk",
        lambda _tid, _db: False,
    )
    monkeypatch.setattr(
        "evoflow.agents.middlewares.plan_guard_middleware.is_subagent_focus_mode",
        lambda **_kwargs: True,
    )

    mw = PlanGuardMiddleware()
    runtime = MagicMock()
    runtime.context = {"collab_phase": "idle", "thread_id": "t-done"}
    phase = mw._effective_collab_phase_for_guard(runtime, [HumanMessage(content="你好")])
    assert phase == "idle"


def test_wrap_model_call_does_not_patch_empty_model_response() -> None:
    from unittest.mock import MagicMock

    from langchain.agents.middleware.types import ModelResponse
    from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

    from evoflow.agents.middlewares.plan_guard_middleware import PlanGuardMiddleware

    mw = PlanGuardMiddleware()
    runtime = MagicMock()
    runtime.context = {"collab_phase": "plan_ready", "thread_id": "t-wrap-empty"}
    request = MagicMock()
    request.runtime = runtime
    request.messages = [
        HumanMessage(content="继续"),
        ToolMessage(content='{"success": true}', tool_call_id="p1", name="plan"),
    ]
    request.state = {"messages": list(request.messages)}
    empty = ModelResponse(result=[AIMessage(content="", tool_calls=[])])
    out = mw._postprocess_model_call_result(request, empty)
    ai = out.result[-1]
    assert str(getattr(ai, "content", "") or "") == ""


def test_idle_agent_postprocess_keeps_workspace_tool_calls() -> None:
    from unittest.mock import MagicMock, patch

    from langchain.agents.middleware.types import ModelResponse
    from langchain_core.messages import AIMessage, HumanMessage

    from evoflow.agents.middlewares.plan_guard_middleware import PlanGuardMiddleware

    mw = PlanGuardMiddleware()
    runtime = MagicMock()
    runtime.context = {"collab_phase": "idle", "thread_id": "t-agent-idle"}
    request = MagicMock()
    request.runtime = runtime
    request.messages = [HumanMessage(content="继续")]
    request.state = {"messages": list(request.messages)}
    ai = AIMessage(
        content="好的",
        tool_calls=[{"id": "tc1", "name": "execute_command", "args": {"command": "ls"}}],
    )
    with patch.object(
        mw,
        "_effective_collab_phase_for_guard",
        return_value="idle",
    ):
        out = mw._postprocess_model_call_result(request, ModelResponse(result=[ai]))
    got = out.result[-1]
    assert got.tool_calls
    assert got.tool_calls[0]["name"] == "execute_command"
