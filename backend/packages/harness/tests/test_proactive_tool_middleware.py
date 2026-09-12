"""Unit tests for proactive employee tool binding (strip + allowlist; no submit inject)."""

from __future__ import annotations

from types import SimpleNamespace

from evoflow.agents.middlewares.proactive_tool_middleware import (
    _LEGACY_DUTY_TOOL_NAMES,
    patch_proactive_tools,
)


def _tool(name: str):
    return SimpleNamespace(name=name)


def test_patch_strips_mode_set_without_injecting_submit():
    """mode_set stripped; submit_tool kwargs ignored — never appended."""
    submit = _tool("proactive_submit_work")
    before = [_tool("shell"), _tool("mode_set"), _tool("web_search")]
    after = patch_proactive_tools(before, submit_tool=submit)
    names = {t.name for t in after}
    assert "mode_set" not in names
    assert "scenario" not in names
    assert "proactive_submit_work" not in names
    assert "shell" in names
    assert "web_search" in names


def test_patch_strips_scenario_aliases_and_legacy_duty_tools():
    submit = _tool("proactive_submit_work")
    before = [
        _tool("shell"),
        _tool("scenario"),
        _tool("scenario_activation"),
        _tool("tool_search"),
        _tool("proactive_submit_work"),
        _tool("proactive_history"),
    ]
    after = patch_proactive_tools(before, submit_tool=submit)
    names = {t.name for t in after}
    assert names == {"shell"}
    assert "tool_search" not in names
    assert names.isdisjoint(_LEGACY_DUTY_TOOL_NAMES)


def test_patch_ignores_submit_even_when_already_present():
    """Legacy submit in the input list is stripped, not kept."""
    submit = _tool("proactive_submit_work")
    before = [_tool("proactive_submit_work"), _tool("shell")]
    after = patch_proactive_tools(before, submit_tool=submit)
    assert sum(1 for t in after if t.name == "proactive_submit_work") == 0
    assert {t.name for t in after} == {"shell"}


def test_patch_without_submit_tool_still_strips_mode_set():
    before = [_tool("mode_set"), _tool("shell")]
    after = patch_proactive_tools(before, submit_tool=None)
    names = {t.name for t in after}
    assert names == {"shell"}


def test_patch_clamps_to_session_allowlist_without_adding_submit():
    submit = _tool("proactive_submit_work")
    history = _tool("proactive_history")
    before = [
        _tool("read"),
        _tool("write"),
        _tool("web_search"),
        _tool("browser"),
        _tool("mode_set"),
        _tool("plan"),
        _tool("ask_clarification"),
        _tool("subtask_progress_report"),
        _tool("tool_search"),
        _tool("collab_peer_send"),
    ]
    after = patch_proactive_tools(
        before,
        submit_tool=submit,
        history_tool=history,
        allow_names={"read", "write", "terminal", "rg"},
    )
    names = {t.name for t in after}
    assert names == {"read", "write", "tasks"}
    assert "plan" not in names
    assert "tool_search" not in names
    assert "ask_clarification" not in names
    assert "proactive_submit_work" not in names
    assert "proactive_history" not in names


def test_analyze_duty_state_tracks_phases_and_tools_since_report():
    from langchain_core.messages import AIMessage, ToolMessage

    from evoflow.agents.middlewares.proactive_tool_middleware import analyze_proactive_duty_state

    msgs = [
        AIMessage(
            content="",
            tool_calls=[
                {
                    "id": "1",
                    "name": "proactive_submit_work",
                    "args": {"phase": "check_in", "goal": "巡检"},
                    "type": "tool_call",
                }
            ],
        ),
        ToolMessage(
            content='{"ok": true, "phase": "check_in"}',
            tool_call_id="1",
            name="proactive_submit_work",
        ),
        ToolMessage(content="ls", tool_call_id="2", name="read"),
        ToolMessage(content="a", tool_call_id="3", name="rg"),
        ToolMessage(content="b", tool_call_id="4", name="terminal"),
        AIMessage(content="先到这", tool_calls=[]),
    ]
    st = analyze_proactive_duty_state(msgs)
    assert st["checked_in"] is True
    assert st["wrapped_up"] is False
    assert st["tools_since_report"] == 3


def test_analyze_duty_state_resets_on_new_duty_human():
    """Prior round wrap_up must not make the next duty look already finished."""
    from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

    from evoflow.agents.middlewares.proactive_tool_middleware import analyze_proactive_duty_state

    msgs = [
        HumanMessage(content="上一轮值班"),
        ToolMessage(
            content='{"ok": true, "phase": "wrap_up"}',
            tool_call_id="old-1",
            name="proactive_submit_work",
        ),
        ToolMessage(content="old dig", tool_call_id="old-2", name="read"),
        HumanMessage(content="本轮值班巡检开始"),
        AIMessage(content="开工", tool_calls=[]),
    ]
    st = analyze_proactive_duty_state(msgs)
    assert st["checked_in"] is False
    assert st["wrapped_up"] is False
    assert st["tools_since_report"] == 0


def test_duty_after_model_disabled():
    from langchain_core.messages import AIMessage, ToolMessage

    from evoflow.agents.middlewares.proactive_tool_middleware import ProactiveToolMiddleware

    mw = ProactiveToolMiddleware()
    assert "tasks" in {getattr(t, "name", "") for t in (mw.tools or [])}
    rt = SimpleNamespace(context={"triggered_by": "proactive_engine", "session_key": "proactive:x"})
    state = {
        "messages": [
            ToolMessage(
                content='{"ok": true, "phase": "check_in"}',
                tool_call_id="1",
                name="proactive_submit_work",
            ),
            AIMessage(content="本轮结束了", tool_calls=[]),
        ]
    }
    assert mw.after_model(state, rt) is None


def test_duty_before_model_disabled():
    from langchain_core.messages import ToolMessage

    from evoflow.agents.middlewares.proactive_tool_middleware import ProactiveToolMiddleware

    mw = ProactiveToolMiddleware()
    rt = SimpleNamespace(context={"triggered_by": "proactive_engine", "session_key": "proactive:x"})
    state = {
        "messages": [
            ToolMessage(content="a", tool_call_id="1", name="read"),
            ToolMessage(content="b", tool_call_id="2", name="rg"),
        ]
    }
    assert mw.before_model(state, rt) is None


def test_format_duty_status_footer_mentions_tasks_tool():
    from evoflow.agents.middlewares.proactive_tool_middleware import format_proactive_duty_status_footer

    line = format_proactive_duty_status_footer(
        {"checked_in": False, "wrapped_up": False, "tools_since_report": 0}
    )
    assert "tasks" in line
    assert "进度" in line or "结案" in line
    assert "check_in" not in line
    assert "wrap_up" not in line
    # Same tip regardless of duty dict
    assert format_proactive_duty_status_footer({"checked_in": True, "wrapped_up": True})


def test_finalize_duty_allow_strips_activation_tools():
    from evoflow.agents.middlewares.proactive_tool_middleware import (
        _LEGACY_DUTY_TOOL_NAMES,
        _finalize_duty_allow,
    )

    allow = _finalize_duty_allow(
        {"read", "tool_search", "scenario", "plan", "rg", "proactive_submit_work"}
    )
    assert "read" in allow and "rg" in allow
    assert "tasks" in allow
    assert "mind_map" in allow
    assert allow.isdisjoint(_LEGACY_DUTY_TOOL_NAMES)
    assert "tool_search" not in allow
    assert "scenario" not in allow
    assert "plan" not in allow


def test_patch_proactive_tools_injects_tasks_when_missing():
    from evoflow.agents.middlewares.proactive_tool_middleware import patch_proactive_tools

    class _T:
        def __init__(self, name: str):
            self.name = name

    out = patch_proactive_tools([_T("read"), _T("rg")], allow_names={"read", "rg"})
    names = {t.name for t in out}
    assert "tasks" in names
    assert "read" in names
    assert "rg" in names


def test_proactive_tool_middleware_registers_tasks_for_create_agent():
    """Injected ``tasks`` must be on middleware.tools so LangGraph accepts ModelRequest."""
    from evoflow.agents.middlewares.proactive_tool_middleware import ProactiveToolMiddleware

    mw = ProactiveToolMiddleware()
    names = {getattr(t, "name", "") for t in (mw.tools or [])}
    assert "tasks" in names


def test_proactive_duty_prompt_lazy_rebuilds_from_role_when_missing(monkeypatch):
    """Duty loop without engine-injected brief still rebuilds from role."""
    from evoflow.agents.middlewares import proactive_tool_middleware as mod
    from evoflow.proactive.models import ProactiveRole, ProactiveRoleConfig
    from evoflow.proactive.prompt import DUTY_CONTRACT_MARKER

    role = ProactiveRole(
        agent_code="frontend_architect",
        role_name="前端架构师",
        department="Engineering",
        config=ProactiveRoleConfig(responsibilities=["把控前端质量"]),
    )

    class _Repo:
        @staticmethod
        def get_role(code: str):
            assert code == "frontend_architect"
            return role

    monkeypatch.setattr(
        "evoflow.proactive.repositories.ProactiveRepository",
        _Repo,
    )

    # User chat into employee session: session only — NOT a duty run
    chat_rt = SimpleNamespace(
        context={
            "session_key": "proactive:frontend_architect",
        }
    )
    assert mod.is_proactive_session(chat_rt) is True
    assert mod.is_proactive_duty_run(chat_rt) is False
    assert mod.is_proactive_run(chat_rt) is False

    # True duty loop: engine flags set
    duty_rt = SimpleNamespace(
        context={
            "session_key": "proactive:frontend_architect",
            "triggered_by": "proactive_engine",
            "proactive_process": True,
        }
    )
    assert mod.is_proactive_duty_run(duty_rt) is True
    assert mod.is_proactive_run(duty_rt) is True
    duty = mod._proactive_duty_prompt(duty_rt)
    assert DUTY_CONTRACT_MARKER in duty
    assert "前端架构师" in duty
    assert "把控前端质量" in duty

    # Engine-injected brief still wins
    rt2 = SimpleNamespace(
        context={
            "session_key": "proactive:frontend_architect",
            "triggered_by": "proactive_engine",
            "proactive_system_prompt": "CUSTOM_DUTY_BRIEF",
        }
    )
    assert mod._proactive_duty_prompt(rt2) == "CUSTOM_DUTY_BRIEF"
