"""Regression: OpenAI ChatOpenAI must not AttributeError on str completion bodies."""

import pytest
from langchain_openai import ChatOpenAI

from evoflow.config.model_config import ModelConfig
from evoflow.models.factory import _resolve_model_use_path
from evoflow.models.patched_openai import PatchedChatOpenAI, _coerce_openai_chat_completion_response


def test_resolve_routes_stock_chat_openai_to_patched():
    cfg = ModelConfig(
        name="gpt-5.6-sol",
        model="gpt-5.6-sol",
        use="langchain_openai:ChatOpenAI",
        vendor="openai",
        base_url="https://api.openai.com/v1",
    )
    assert _resolve_model_use_path(cfg) == "evoflow.models.patched_openai:PatchedChatOpenAI"


def test_coerce_rejects_str_with_clear_error():
    with pytest.raises(ValueError, match="non-JSON text"):
        _coerce_openai_chat_completion_response("gateway html error page")


def test_patched_create_chat_result_does_not_model_dump_str():
    """Exact historical failure from langchain BaseChatOpenAI._create_chat_result."""
    stock = ChatOpenAI(model="gpt-test", api_key="sk-test")
    with pytest.raises(AttributeError, match="model_dump"):
        stock._create_chat_result("not-json-body")

    patched = PatchedChatOpenAI(model="gpt-test", api_key="sk-test")
    with pytest.raises(ValueError, match="non-JSON text"):
        patched._create_chat_result("not-json-body")
