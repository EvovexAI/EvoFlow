"""Dynamic system prompt rebuild on scenario / tool fingerprint change."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
from langchain.agents.middleware.types import ModelRequest
from langchain_core.messages import SystemMessage

from evoflow.agents.middlewares.dynamic_system_prompt_middleware import DynamicSystemPromptOnScenarioMiddleware
from evoflow.agents.middlewares.scenario_runtime_hint_middleware import _inject_hint_into_system_message


def test_skips_when_meta_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    mw = DynamicSystemPromptOnScenarioMiddleware()
    req = MagicMock()
    req.runtime = MagicMock()
    req.runtime.context = {}
    req.state = {"messages": []}
    req.tools = []
    calls: list[str] = []

    def handler(r):
        calls.append("ok")
        return MagicMock()

    mw.wrap_model_call(req, handler)
    assert calls == ["ok"]


def test_rebuilds_from_configurable_when_runtime_context_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    mw = DynamicSystemPromptOnScenarioMiddleware()
    DynamicSystemPromptOnScenarioMiddleware._last_sig_by_thread.clear()

    def handler(r: ModelRequest):
        assert isinstance(r.system_message, SystemMessage)
        assert "FROM_CONFIG" in (r.system_message.content or "")
        return MagicMock()

    rt = MagicMock()
    rt.context = {"thread_id": "t-cfg"}
    req = ModelRequest(model=MagicMock(), messages=[], tools=[], state={"messages": []}, runtime=rt)

    with patch(
        "evoflow.agents.middlewares.plan_guard_middleware.effective_activated_scenario_keys",
        return_value=frozenset({"chat"}),
    ):
        with patch(
            "langgraph.config.get_config",
            return_value={
                "configurable": {
                    "evf_dynamic_prompt_meta": {
                        "all_tool_names": ["a"],
                        "subagent_enabled": True,
                        "max_concurrent_subagents": 5,
                        "agent_name": "main",
                    }
                }
            },
        ):
            with patch(
                "evoflow.agents.lead_agent.prompt.apply_prompt_template",
                return_value="FROM_CONFIG system",
            ):
                mw.wrap_model_call(req, handler)


def test_rebuilds_when_fingerprint_changes(monkeypatch: pytest.MonkeyPatch) -> None:
    mw = DynamicSystemPromptOnScenarioMiddleware()
    DynamicSystemPromptOnScenarioMiddleware._last_sig_by_thread.clear()

    def handler(r: ModelRequest):
        assert isinstance(r.system_message, SystemMessage)
        assert "REBUILT" in (r.system_message.content or "")
        return MagicMock()

    rt = MagicMock()
    rt.context = {
        "thread_id": "t-dyn",
        "evf_dynamic_prompt_meta": {
            "all_tool_names": ["scenario", "read_file"],
            "subagent_enabled": True,
            "max_concurrent_subagents": 3,
            "use_virtual_paths": False,
            "local_workspace_root": None,
            "agent_name": "main",
            "available_skills": None,
        },
        "evf_user_question": "hi",
        "evf_prompt_source": "user_request",
    }
    rf = MagicMock(name="read_file")
    req = ModelRequest(
        model=MagicMock(),
        messages=[],
        tools=[rf],
        state={"messages": []},
        runtime=rt,
    )

    with patch(
        "evoflow.agents.middlewares.plan_guard_middleware.effective_activated_scenario_keys",
        return_value=frozenset({"plan"}),
    ):
        with patch(
            "evoflow.agents.lead_agent.prompt.apply_prompt_template",
            return_value="REBUILT system",
        ) as ap:
            mw.wrap_model_call(req, handler)
            ap.assert_called_once()

        # same fingerprint -> reuse cached assembled system (not compile-time ORIG)
        req2 = ModelRequest(
            model=MagicMock(),
            messages=[],
            system_message=SystemMessage("ORIG"),
            tools=[rf],
            state={"messages": []},
            runtime=rt,
        )

        def handler2(r: ModelRequest):
            assert "REBUILT" in (r.system_message.text if r.system_message else "")
            return MagicMock()

        with patch("evoflow.agents.lead_agent.prompt.apply_prompt_template") as ap2:
            mw.wrap_model_call(req2, handler2)
            ap2.assert_not_called()


def test_rebuild_passes_include_memory_from_runtime(monkeypatch: pytest.MonkeyPatch) -> None:
    """Per-turn system prompt rebuild must honor memory_enabled (Evopanel chat pill)."""
    mw = DynamicSystemPromptOnScenarioMiddleware()
    DynamicSystemPromptOnScenarioMiddleware._last_sig_by_thread.clear()

    rf = MagicMock(name="read_file")
    rt = MagicMock()
    rt.context = {
        "thread_id": "t-mem-ctx",
        "evf_dynamic_prompt_meta": {
            "all_tool_names": ["scenario", "read_file"],
            "subagent_enabled": True,
            "max_concurrent_subagents": 3,
            "use_virtual_paths": False,
            "local_workspace_root": None,
            "agent_name": "main",
            "available_skills": None,
        },
        "evf_user_question": "hi",
        "evf_prompt_source": "user_request",
    }
    req = ModelRequest(
        model=MagicMock(),
        messages=[],
        tools=[rf],
        state={"messages": []},
        runtime=rt,
    )

    def handler(r: ModelRequest):
        return MagicMock()

    with patch(
        "evoflow.agents.middlewares.plan_guard_middleware.effective_activated_scenario_keys",
        return_value=frozenset({"plan"}),
    ):
        with patch(
            "evoflow.agents.memory.runtime_overrides.effective_memory_injection_enabled",
            return_value=False,
        ):
            with patch(
                "evoflow.agents.lead_agent.prompt.apply_prompt_template",
                return_value="REBUILT",
            ) as ap:
                mw.wrap_model_call(req, handler)
                assert ap.call_args.kwargs.get("include_memory") is False


def test_scenario_hint_inject_skips_duplicate_activated_tools_block() -> None:
    base = SystemMessage(
        content="sys\n<scenario_activated_tools>\nold\n</scenario_activated_tools>",
    )
    patch = "<scenario_activated_tools>\nnew\n</scenario_activated_tools>"
    assert _inject_hint_into_system_message(base, patch) is None


def test_proactive_session_user_chat_falls_through_to_chat_prompt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``proactive:{code}`` without engine flags must not force duty handbook."""
    mw = DynamicSystemPromptOnScenarioMiddleware()
    DynamicSystemPromptOnScenarioMiddleware._last_sig_by_thread.clear()

    seen: dict[str, str] = {}

    def handler(r: ModelRequest):
        seen["system"] = str(getattr(r.system_message, "content", "") or "")
        return MagicMock()

    rt = MagicMock()
    rt.context = {
        "thread_id": "t-emp-chat",
        "session_key": "proactive:frontend_architect",
        "agent_name": "frontend_architect",
        # no triggered_by / proactive_process → user chat
    }
    req = ModelRequest(model=MagicMock(), messages=[], tools=[], state={"messages": []}, runtime=rt)

    with patch(
        "evoflow.agents.middlewares.plan_guard_middleware.effective_activated_scenario_keys",
        return_value=frozenset({"chat"}),
    ):
        with patch(
            "evoflow.agents.memory.runtime_overrides.effective_memory_injection_enabled",
            return_value=False,
        ):
            with patch(
                "langgraph.config.get_config",
                return_value={
                    "configurable": {
                        "evf_dynamic_prompt_meta": {
                            "agent_name": "frontend_architect",
                            "all_tool_names": [],
                            "available_skills": [],
                        },
                        "session_key": "proactive:frontend_architect",
                    }
                },
            ):
                with patch(
                    "evoflow.agents.lead_agent.prompt.apply_prompt_template",
                    return_value="CHAT_EMPLOYEE_PROMPT",
                ) as ap:
                    with patch(
                        "evoflow.agents.middlewares.dynamic_system_prompt_middleware."
                        "DynamicSystemPromptOnScenarioMiddleware._apply_proactive_duty_system",
                    ) as duty:
                        mw.wrap_model_call(req, handler)
                        duty.assert_not_called()
                        assert ap.called
                        assert seen.get("system") == "CHAT_EMPLOYEE_PROMPT"


def test_proactive_duty_engine_still_uses_duty_system(monkeypatch: pytest.MonkeyPatch) -> None:
    mw = DynamicSystemPromptOnScenarioMiddleware()
    DynamicSystemPromptOnScenarioMiddleware._last_sig_by_thread.clear()

    seen: dict[str, str] = {}

    def handler(r: ModelRequest):
        seen["system"] = str(getattr(r.system_message, "content", "") or "")
        return MagicMock()

    rt = MagicMock()
    rt.context = {
        "thread_id": "t-emp-duty",
        "session_key": "proactive:frontend_architect",
        "triggered_by": "proactive_engine",
        "proactive_process": True,
        "proactive_system_prompt": "# 值班手册\n巡检结束",
        "agent_name": "frontend_architect",
    }
    req = ModelRequest(model=MagicMock(), messages=[], tools=[], state={"messages": []}, runtime=rt)

    with patch(
        "evoflow.agents.lead_agent.prompt.apply_prompt_template",
    ) as ap:
        mw.wrap_model_call(req, handler)
        ap.assert_not_called()
        assert "proactive_duty_brief" in seen.get("system", "")
        assert "值班" in seen.get("system", "")


def test_reuses_system_when_only_human_turn_changes(monkeypatch: pytest.MonkeyPatch) -> None:
    """Runtime: new user turn keeps base instructions — no full apply_prompt_template."""
    from langchain_core.messages import HumanMessage

    mw = DynamicSystemPromptOnScenarioMiddleware()
    DynamicSystemPromptOnScenarioMiddleware._last_sig_by_thread.clear()
    DynamicSystemPromptOnScenarioMiddleware._last_system_by_thread.clear()

    meta = {
        "all_tool_names": ["read_file"],
        "subagent_enabled": True,
        "max_concurrent_subagents": 3,
        "use_virtual_paths": False,
        "local_workspace_root": None,
        "agent_name": "main",
        "available_skills": None,
    }
    rf = MagicMock(name="read_file")
    rt = MagicMock()
    rt.context = {
        "thread_id": "t-human-reuse",
        "evf_dynamic_prompt_meta": meta,
        "evf_user_question": "first",
        "evf_prompt_source": "user_request",
    }

    seen: dict[str, str] = {}

    def handler(r: ModelRequest):
        seen["system"] = str(getattr(r.system_message, "content", "") or "")
        return MagicMock()

    with patch(
        "evoflow.agents.middlewares.plan_guard_middleware.effective_activated_scenario_keys",
        return_value=frozenset({"chat"}),
    ):
        with patch(
            "evoflow.agents.lead_agent.prompt.apply_prompt_template",
            return_value="BASE system\n<memory>keep-me</memory>",
        ) as ap:
            req1 = ModelRequest(
                model=MagicMock(),
                messages=[],
                tools=[rf],
                state={"messages": [HumanMessage(content="first question", id="h1")]},
                runtime=rt,
            )
            mw.wrap_model_call(req1, handler)
            assert ap.call_count == 1
            assert "keep-me" in seen.get("system", "")

            rt.context = {
                **rt.context,
                "evf_user_question": "second",
            }
            req2 = ModelRequest(
                model=MagicMock(),
                messages=[],
                system_message=SystemMessage("COMPILE_TIME_NO_MEMORY"),
                tools=[rf],
                state={"messages": [HumanMessage(content="second question", id="h2")]},
                runtime=rt,
            )
            mw.wrap_model_call(req2, handler)
            assert ap.call_count == 1
            # Must reuse cached assembled system, not compile-time prompt.
            assert "keep-me" in seen.get("system", "")
            assert "COMPILE_TIME" not in seen.get("system", "")
