"""Invoke auxiliary chat models without leaking tokens into the parent LangGraph stream."""

from __future__ import annotations

import logging
import os
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from langchain_core.messages import BaseMessage
from langchain_core.runnables import RunnableConfig

logger = logging.getLogger(__name__)

_ISOLATED_POOL = ThreadPoolExecutor(max_workers=2, thread_name_prefix="evoflow-internal-llm")
_DEFAULT_INVOKE_TIMEOUT_SECONDS = max(30.0, float(os.getenv("EVOFLOW_INTERNAL_MODEL_TIMEOUT_SECONDS", "600") or 600))


def _isolated_config(model: Any) -> RunnableConfig:
    ik = getattr(model, "_evoflow_invocation_kind", None) or "internal"
    return RunnableConfig(
        callbacks=[],
        tags=["evoflow_internal", str(ik)],
    )


def _model_non_streaming(model: Any) -> Any:
    """Disable streaming on the runnable; do not pass streaming= to SDK create()."""
    try:
        if getattr(model, "streaming", False):
            return model.bind(streaming=False)
    except Exception:
        pass
    return model


def _invoke_in_thread(model: Any, messages: list[Any]) -> Any:
    cfg = _isolated_config(model)
    return _model_non_streaming(model).invoke(messages, config=cfg)


async def _ainvoke_isolated(model: Any, messages: list[Any]) -> Any:
    cfg = _isolated_config(model)
    return await _model_non_streaming(model).ainvoke(messages, config=cfg)


def invoke_internal_chat_model(model: Any, messages: list[BaseMessage] | list[dict[str, Any]]) -> Any:
    """Blocking invoke on a worker thread so LangGraph stream hooks do not see tokens."""
    timeout = _DEFAULT_INVOKE_TIMEOUT_SECONDS
    try:
        fut = _ISOLATED_POOL.submit(_invoke_in_thread, model, messages)
        return fut.result(timeout=timeout)
    except Exception as e:
        logger.warning("isolated model invoke failed (timeout=%ss): %s", timeout, e)
        raise


async def ainvoke_internal_chat_model(model: Any, messages: list[BaseMessage] | list[dict[str, Any]]) -> Any:
    """Async invoke with empty callbacks (background jobs already off the hot stream path)."""
    return await _ainvoke_isolated(model, messages)
