"""Memory live footer freezes standing memory; query recall is HumanMessage turn-tail."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from langchain.agents.middleware.types import ModelRequest
from langchain_core.messages import HumanMessage, SystemMessage

from evoflow.agents.memory.standing_freeze import invalidate_standing_memory
from evoflow.agents.middlewares.memory_live_footer_middleware import MemoryLiveFooterMiddleware


def test_memory_live_footer_freezes_standing_and_keeps_system_stable() -> None:
    invalidate_standing_memory("t-mem-footer")
    mw = MemoryLiveFooterMiddleware()
    rt = MagicMock()
    rt.context = {
        "thread_id": "t-mem-footer",
        "evf_dynamic_prompt_meta": {
            "agent_name": "main",
            "local_workspace_root": None,
            "prompt_language": "zh",
        },
    }
    req = ModelRequest(
        model=MagicMock(),
        messages=[HumanMessage(content="hello")],
        system_message=SystemMessage(content="STATIC_PROMPT_WITHOUT_MEMORY"),
        tools=[],
        state={"messages": [HumanMessage(content="hello")]},
        runtime=rt,
    )

    standing_calls = {"n": 0}

    def fake_standing(**kwargs):
        standing_calls["n"] += 1
        assert kwargs.get("include_query_recall") is False
        return "<!-- MEMORY -->\n<memory>\nLIVE_MEMORY\n</memory>"

    with patch(
        "evoflow.agents.middlewares.plan_guard_middleware.effective_activated_scenario_keys",
        return_value=frozenset({"chat"}),
    ):
        with patch(
            "evoflow.agents.lead_agent.prompt.build_memory_injection_sections",
            side_effect=fake_standing,
        ):
            with patch(
                "evoflow.agents.lead_agent.prompt.build_memory_query_recall_sections",
                return_value="",
            ):
                out1 = mw._patch_request(req)
                out2 = mw._patch_request(
                    req.override(system_message=SystemMessage(content="STATIC_PROMPT_WITHOUT_MEMORY"))
                )

    assert standing_calls["n"] == 1
    assert "LIVE_MEMORY" in str(out1.system_message.content)
    assert str(out1.system_message.content) == str(out2.system_message.content)


def test_memory_live_footer_puts_query_recall_on_human_message() -> None:
    invalidate_standing_memory("t-mem-recall")
    mw = MemoryLiveFooterMiddleware()
    rt = MagicMock()
    rt.context = {
        "thread_id": "t-mem-recall",
        "evf_dynamic_prompt_meta": {"agent_name": "main", "prompt_language": "zh"},
    }
    req = ModelRequest(
        model=MagicMock(),
        messages=[HumanMessage(content="how do I deploy?")],
        system_message=SystemMessage(content="BASE"),
        tools=[],
        state={"messages": [HumanMessage(content="how do I deploy?")]},
        runtime=rt,
    )

    with patch(
        "evoflow.agents.middlewares.memory_live_footer_middleware._query_recall_enabled",
        return_value=True,
    ):
        with patch(
            "evoflow.agents.middlewares.plan_guard_middleware.effective_activated_scenario_keys",
            return_value=frozenset({"chat"}),
        ):
            with patch(
                "evoflow.agents.lead_agent.prompt.build_memory_injection_sections",
                return_value="",
            ):
                with patch(
                    "evoflow.agents.lead_agent.prompt.build_memory_query_recall_sections",
                    return_value="<!-- PERSON -->\nrecall-hit\n",
                ):
                    out = mw._patch_request(req)

    assert "recall-hit" not in str(out.system_message.content)
    assert out.messages[-1].name == "session_memory_recall"
    assert "recall-hit" in str(out.messages[-1].content)


def test_memory_live_footer_skips_query_recall_when_flag_off() -> None:
    """Default / kill-switch: query recall off → no per-turn archival HumanMessage."""
    invalidate_standing_memory("t-mem-recall-off")
    mw = MemoryLiveFooterMiddleware()
    rt = MagicMock()
    rt.context = {
        "thread_id": "t-mem-recall-off",
        "evf_dynamic_prompt_meta": {"agent_name": "main", "prompt_language": "zh"},
    }
    req = ModelRequest(
        model=MagicMock(),
        messages=[HumanMessage(content="how do I deploy?")],
        system_message=SystemMessage(content="BASE"),
        tools=[],
        state={"messages": [HumanMessage(content="how do I deploy?")]},
        runtime=rt,
    )

    with patch(
        "evoflow.agents.middlewares.memory_live_footer_middleware._query_recall_enabled",
        return_value=False,
    ):
        with patch(
            "evoflow.agents.middlewares.plan_guard_middleware.effective_activated_scenario_keys",
            return_value=frozenset({"chat"}),
        ):
            with patch(
                "evoflow.agents.lead_agent.prompt.build_memory_injection_sections",
                return_value="",
            ):
                with patch(
                    "evoflow.agents.lead_agent.prompt.build_memory_query_recall_sections",
                ) as recall_fn:
                    out = mw._patch_request(req)

    recall_fn.assert_not_called()
    assert all(getattr(m, "name", None) != "session_memory_recall" for m in out.messages)


def test_memory_live_footer_skips_when_injection_disabled() -> None:
    mw = MemoryLiveFooterMiddleware()
    rt = MagicMock()
    rt.context = {"thread_id": "t-mem-off"}
    req = ModelRequest(
        model=MagicMock(),
        messages=[],
        system_message=SystemMessage(content="ORIG"),
        tools=[],
        state={"messages": []},
        runtime=rt,
    )

    def handler(r: ModelRequest):
        assert (r.system_message.text if r.system_message else "") == "ORIG"
        return MagicMock()

    with patch(
        "evoflow.agents.middlewares.memory_live_footer_middleware.effective_memory_injection_enabled",
        return_value=False,
    ):
        mw.wrap_model_call(req, handler)
