"""LangChain callback handler that accumulates streaming tokens for interruption recovery.

Attached to the model instance during ``TranscriptMiddleware.awrap_model_call``,
this handler captures every token as it streams. On ``on_llm_error`` (cancellation,
timeout, provider error) the accumulated partial content is flushed to the
``evoflow_chat_messages`` table so it survives stream interruptions.
"""

from __future__ import annotations

import logging
import threading
from uuid import UUID

from langchain_core.callbacks.base import BaseCallbackHandler

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Thread-local accumulator per model invocation (keyed by run_id).
# ---------------------------------------------------------------------------
_tl = threading.local()


def _ensure_acc(run_id: UUID) -> list[str]:
    store = getattr(_tl, "store", None)
    if store is None:
        store = {}
        _tl.store = store
    rid = str(run_id)
    if rid not in store:
        store[rid] = []
    return store[rid]


def _drop_acc(run_id: UUID) -> list[str] | None:
    store = getattr(_tl, "store", None)
    if store is None:
        return None
    return store.pop(str(run_id), None)


def _all_accumulators() -> dict[str, list[str]]:
    """Return a snapshot of all undrained accumulators (for cancellation recovery)."""
    store = getattr(_tl, "store", None)
    return dict(store) if store else {}


def _clear_all_accumulators() -> None:
    """Clear all accumulators (after draining)."""
    _tl.store = {}


class StreamAccumulatorHandler(BaseCallbackHandler):
    """Accumulates streaming LLM tokens in thread-local storage.

    Attributes:
        raise_error: Must be False so errors do not propagate through the callback chain.
    """

    raise_error: bool = False

    def on_llm_new_token(
        self,
        token: str,
        *,
        chunk: object | None = None,
        run_id: UUID,
        parent_run_id: UUID | None = None,
        tags: list[str] | None = None,
        **kwargs: object,
    ) -> None:
        """Append *token* to the accumulator for this *run_id*."""
        _ensure_acc(run_id).append(token)

    def on_llm_end(
        self,
        response: object,
        *,
        run_id: UUID,
        parent_run_id: UUID | None = None,
        **kwargs: object,
    ) -> None:
        """Model call completed normally -- discard accumulator (persisted via after_model)."""
        tokens = _drop_acc(run_id)
        if tokens is not None:
            joined = "".join(tokens)
            logger.info(
                "StreamAccumulatorHandler.on_llm_end run_id=%s accumulated_tokens=%d content_len=%d",
                run_id,
                len(tokens),
                len(joined),
            )
        else:
            logger.info(
                "StreamAccumulatorHandler.on_llm_end run_id=%s (no accumulator found)",
                run_id,
            )

    def on_llm_error(
        self,
        error: BaseException,
        *,
        run_id: UUID,
        parent_run_id: UUID | None = None,
        **kwargs: object,
    ) -> None:
        """Model call failed or was cancelled -- keep accumulator for later flush."""
        acc = _all_accumulators()
        acc_tokens = acc.get(str(run_id), [])
        logger.warning(
            "StreamAccumulatorHandler.on_llm_error run_id=%s error_type=%s error=%s accumulated_tokens=%d",
            run_id,
            type(error).__name__,
            str(error)[:500],
            len(acc_tokens),
        )
