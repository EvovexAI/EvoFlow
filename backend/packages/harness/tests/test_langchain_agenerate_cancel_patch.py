"""Regression: CancelledError must not become AttributeError(.generations)."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from langchain_core.callbacks import AsyncCallbackManagerForLLMRun, CallbackManagerForLLMRun
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.tracers.stdout import ConsoleCallbackHandler

from evoflow.langchain_agenerate_cancel_patch import apply_langchain_agenerate_cancel_patch


class _CancelOnGenerate(BaseChatModel):
    """Minimal chat model whose async generate path raises CancelledError."""

    @property
    def _llm_type(self) -> str:
        return "cancel-on-generate"

    def _generate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: CallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> ChatResult:
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content="ok"))])

    async def _agenerate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: AsyncCallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> ChatResult:
        raise asyncio.CancelledError()


def test_agenerate_propagates_cancelled_error_not_generations_attr() -> None:
    apply_langchain_agenerate_cancel_patch()
    model = _CancelOnGenerate()
    # Callbacks force run_managers so the buggy on_llm_end filter path is exercised.
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(
            model.agenerate(
                [[HumanMessage(content="hi")]],
                callbacks=[ConsoleCallbackHandler()],
            )
        )
