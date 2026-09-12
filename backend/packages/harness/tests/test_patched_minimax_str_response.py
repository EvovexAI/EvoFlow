"""Regression: MiniMax adapter must not call ``.model_dump()`` on str responses."""

from unittest.mock import MagicMock, patch

from langchain_core.messages import AIMessage
from langchain_core.outputs import ChatGeneration, ChatResult

from evoflow.models.patched_minimax import PatchedChatMiniMax


def test_create_chat_result_accepts_str_response_without_model_dump():
    llm = PatchedChatMiniMax(model="minimax-test", api_key="sk-test")
    parent = ChatResult(
        generations=[ChatGeneration(message=AIMessage(content="hello"))],
    )
    with patch(
        "langchain_openai.chat_models.base.BaseChatOpenAI._create_chat_result",
        return_value=parent,
    ):
        # Exact historical failure path: response is a plain str.
        result = llm._create_chat_result("not-json-body")
    assert len(result.generations) == 1
    assert result.generations[0].message.content == "hello"


def test_create_chat_result_uses_dict_choices():
    llm = PatchedChatMiniMax(model="minimax-test", api_key="sk-test")
    parent = ChatResult(
        generations=[ChatGeneration(message=AIMessage(content="hi"))],
    )
    response = {
        "choices": [
            {
                "message": {
                    "content": "hi",
                    "reasoning_details": [{"text": "think"}],
                }
            }
        ]
    }
    with patch(
        "langchain_openai.chat_models.base.BaseChatOpenAI._create_chat_result",
        return_value=parent,
    ):
        result = llm._create_chat_result(response)
    assert len(result.generations) == 1


def test_create_chat_result_accepts_object_with_model_dump():
    llm = PatchedChatMiniMax(model="minimax-test", api_key="sk-test")
    parent = ChatResult(
        generations=[ChatGeneration(message=AIMessage(content="ok"))],
    )
    response = MagicMock()
    response.model_dump.return_value = {"choices": []}
    with patch(
        "langchain_openai.chat_models.base.BaseChatOpenAI._create_chat_result",
        return_value=parent,
    ):
        result = llm._create_chat_result(response)
    assert len(result.generations) == 1
    response.model_dump.assert_called()
