from unittest.mock import MagicMock, patch

from langchain_core.messages import HumanMessage

from evoflow.agents.middlewares.session_intent_middleware import _build_intent_block, _llm_rollup
from evoflow.config.session_intent_config import SessionIntentConfig, load_session_intent_config_from_dict


def test_llm_rollup_default_disabled():
    load_session_intent_config_from_dict(SessionIntentConfig().model_dump())
    assert SessionIntentConfig().llm_rollup_enabled is False
    assert _llm_rollup(["goal one " * 30, "goal two " * 30]) is None


def test_llm_rollup_when_explicitly_enabled():
    load_session_intent_config_from_dict(
        SessionIntentConfig(llm_rollup_enabled=True, llm_rollup_min_chars=0).model_dump()
    )
    mock_resp = MagicMock()
    mock_resp.content = "User wants auth refactor and tests."
    mock_model = MagicMock()
    mock_model.invoke.return_value = mock_resp

    with patch("evoflow.models.create_chat_model", return_value=mock_model):
        text = _llm_rollup(["goal one " * 30, "goal two " * 30])
    assert text == "User wants auth refactor and tests."
    mock_model.invoke.assert_called_once()


def test_build_intent_block_uses_rollup_when_llm_returns():
    load_session_intent_config_from_dict(
        SessionIntentConfig(enabled=True, max_turns=3, llm_rollup_enabled=True, llm_rollup_min_chars=0).model_dump()
    )
    with (
        patch(
            "evoflow.agents.middlewares.session_intent_middleware._mission_primary_objective",
            return_value="",
        ),
        patch(
            "evoflow.agents.middlewares.session_intent_middleware._llm_rollup",
            return_value="Clustered goals summary.",
        ),
    ):
        block = _build_intent_block(
            [
                HumanMessage(content="first"),
                HumanMessage(content="second"),
                HumanMessage(content="third"),
            ]
        )
    assert "Clustered goals summary." in block
    assert "Rolling summary" in block
    assert "first" not in block


def test_build_intent_block_skipped_when_mission_primary_exists():
    load_session_intent_config_from_dict(SessionIntentConfig(enabled=True, max_turns=3).model_dump())
    with patch(
        "evoflow.agents.middlewares.session_intent_middleware._mission_primary_objective",
        return_value="Fix auth module",
    ):
        block = _build_intent_block(
            [
                HumanMessage(content="first"),
                HumanMessage(content="second"),
            ],
            thread_id="t-mission",
        )
    assert block == ""
