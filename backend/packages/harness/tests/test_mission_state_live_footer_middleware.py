"""Mission state live footer injects persisted objectives as HumanMessage turn-tail."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from langchain.agents.middleware.types import ModelRequest
from langchain_core.messages import HumanMessage, SystemMessage

from evoflow.agents.middlewares.mission_state_live_footer_middleware import MissionStateLiveFooterMiddleware
from evoflow.agents.mission_state.models import MissionState


def test_live_footer_injects_mission_state_as_human_message() -> None:
    mw = MissionStateLiveFooterMiddleware()
    rt = MagicMock()
    rt.context = {"thread_id": "t-ms"}
    req = ModelRequest(
        model=MagicMock(),
        messages=[HumanMessage(content="hi")],
        system_message=SystemMessage("base system\n<mission_state>old</mission_state>"),
        tools=[],
        state={"messages": [HumanMessage(content="hi")]},
        runtime=rt,
    )
    state = MissionState(
        thread_id="t-ms",
        primary_objective="Fix worker search delivery",
        active_subproblems=[{"id": "1", "title": "Hoist code reads", "status": "in_progress"}],
        version=2,
    )

    def handler(r: ModelRequest):
        sys_text = str(r.system_message.content or "")
        assert "<mission_state>" not in sys_text
        assert "old" not in sys_text
        assert "base system" in sys_text
        last = r.messages[-1]
        assert isinstance(last, HumanMessage)
        assert last.name == "session_mission_state"
        assert "Fix worker search delivery" in str(last.content)
        assert "Hoist code reads" in str(last.content)
        return MagicMock()

    with patch("evoflow.agents.mission_state.config.MISSION_STATE_PROMPT_INJECTION_ENABLED", True):
        with patch("evoflow.agents.lead_agent.prompt._build_mission_state_section") as build_section:
            build_section.return_value = (
                "<mission_state>\nFix worker search delivery\nHoist code reads\n</mission_state>"
            )
            with patch("evoflow.agents.mission_state.storage.load_mission_state", return_value=state):
                mw.wrap_model_call(req, handler)


def test_live_footer_resolves_thread_id_from_configurable() -> None:
    mw = MissionStateLiveFooterMiddleware()
    rt = MagicMock()
    rt.context = {}
    req = ModelRequest(
        model=MagicMock(),
        messages=[HumanMessage(content="go")],
        system_message=SystemMessage("base system"),
        tools=[],
        state={"messages": [HumanMessage(content="go")]},
        runtime=rt,
    )
    state = MissionState(thread_id="t-cfg", primary_objective="Analyze MCP bugs", version=1)

    def handler(r: ModelRequest):
        assert "<mission_state>" not in str(r.system_message.content or "")
        last = r.messages[-1]
        assert last.name == "session_mission_state"
        assert "Analyze MCP bugs" in str(last.content)
        return MagicMock()

    with patch("evoflow.agents.mission_state.config.MISSION_STATE_PROMPT_INJECTION_ENABLED", True):
        with patch("evoflow.agents.lead_agent.prompt._build_mission_state_section") as build_section:
            build_section.return_value = "<mission_state>\nAnalyze MCP bugs\n</mission_state>"
            with patch("langgraph.config.get_config", return_value={"configurable": {"thread_id": "t-cfg"}}):
                with patch("evoflow.agents.mission_state.storage.load_mission_state", return_value=state):
                    mw.wrap_model_call(req, handler)


def test_live_footer_noop_when_prompt_injection_disabled() -> None:
    mw = MissionStateLiveFooterMiddleware()
    rt = MagicMock()
    rt.context = {"thread_id": "t-ms"}
    req = ModelRequest(
        model=MagicMock(),
        messages=[HumanMessage(content="hi")],
        system_message=SystemMessage("base only\n<mission_state>stale</mission_state>"),
        tools=[],
        state={"messages": [HumanMessage(content="hi")]},
        runtime=rt,
    )
    state = MissionState(thread_id="t-ms", primary_objective="Should not appear", version=1)

    def handler(r: ModelRequest):
        assert r.system_message.content == "base only"
        assert all(getattr(m, "name", None) != "session_mission_state" for m in r.messages)
        return MagicMock()

    with patch("evoflow.agents.mission_state.config.MISSION_STATE_PROMPT_INJECTION_ENABLED", False):
        with patch("evoflow.agents.mission_state.storage.load_mission_state", return_value=state):
            mw.wrap_model_call(req, handler)


def test_live_footer_noop_when_primary_missing() -> None:
    mw = MissionStateLiveFooterMiddleware()
    rt = MagicMock()
    rt.context = {"thread_id": "t-ms"}
    req = ModelRequest(
        model=MagicMock(),
        messages=[HumanMessage(content="hi")],
        system_message=SystemMessage("base only"),
        tools=[],
        state={"messages": [HumanMessage(content="hi")]},
        runtime=rt,
    )
    state = MissionState(thread_id="t-ms", primary_objective="", version=1)

    def handler(r: ModelRequest):
        assert r.system_message.content == "base only"
        assert all(getattr(m, "name", None) != "session_mission_state" for m in r.messages)
        return MagicMock()

    with patch("evoflow.agents.mission_state.config.MISSION_STATE_PROMPT_INJECTION_ENABLED", True):
        with patch("evoflow.agents.mission_state.storage.load_mission_state", return_value=state):
            mw.wrap_model_call(req, handler)
