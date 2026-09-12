from unittest.mock import MagicMock, patch

from langchain.agents.middleware.types import ModelRequest
from langchain_core.messages import HumanMessage, SystemMessage

from evoflow.agents.middlewares.session_intent_middleware import (
    SessionIntentMiddleware,
    _build_intent_block,
)
from evoflow.config.session_intent_config import SessionIntentConfig, load_session_intent_config_from_dict


def test_session_intent_block_lists_prior_turns():
    load_session_intent_config_from_dict(
        SessionIntentConfig(enabled=True, max_turns=3, llm_rollup_enabled=False).model_dump()
    )
    block = _build_intent_block(
        [
            HumanMessage(content="first goal"),
            HumanMessage(content="second goal"),
            HumanMessage(content="third goal"),
        ]
    )
    assert "<session_intent>" in block
    assert "first goal" in block
    assert "second goal" in block
    assert "third goal" not in block


def test_session_intent_middleware_injects_human_message_not_system():
    load_session_intent_config_from_dict(
        SessionIntentConfig(enabled=True, max_turns=3, llm_rollup_enabled=False).model_dump()
    )
    mw = SessionIntentMiddleware()
    rt = MagicMock()
    rt.context = {"thread_id": "t-intent"}
    msgs = [
        HumanMessage(content="first goal"),
        HumanMessage(content="second goal"),
        HumanMessage(content="third goal"),
    ]
    req = ModelRequest(
        model=MagicMock(),
        messages=msgs,
        system_message=SystemMessage("base\n<session_intent>stale</session_intent>"),
        tools=[],
        state={"messages": msgs},
        runtime=rt,
    )

    def handler(r: ModelRequest):
        assert "<session_intent>" not in str(r.system_message.content)
        assert "stale" not in str(r.system_message.content)
        assert r.messages[-1].name == "session_intent"
        assert "first goal" in str(r.messages[-1].content)
        return MagicMock()

    with patch(
        "evoflow.agents.middlewares.session_intent_middleware._mission_primary_objective",
        return_value="",
    ):
        mw.wrap_model_call(req, handler)
