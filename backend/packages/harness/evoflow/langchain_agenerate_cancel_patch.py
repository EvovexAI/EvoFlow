"""Work around langchain-core ``BaseChatModel.agenerate`` masking cancellation.

``agenerate`` gathers per-prompt calls with ``return_exceptions=True`` and collects
failures via ``isinstance(res, BaseException)``. The follow-up ``on_llm_end`` path
filters with the narrower ``isinstance(res, Exception)``, so ``CancelledError``
(and other non-``Exception`` ``BaseException``s) are treated as successful
``ChatResult``s. Reading ``.generations`` then raises:

    AttributeError: 'CancelledError' object has no attribute 'generations'

which replaces the real cancellation. Upstream: langchain-ai/langchain#38469
(fix PR #38470 was closed unmerged). Patch the filter to ``BaseException``.
"""

from __future__ import annotations

import inspect
import logging
import textwrap
from typing import Any

logger = logging.getLogger(__name__)

_PATCHED = False
_NEEDLE = "if not isinstance(res, Exception)"
_FIXED = "if not isinstance(res, BaseException)"


def apply_langchain_agenerate_cancel_patch() -> None:
    """Patch ``BaseChatModel.agenerate`` once per process when the bug is present."""
    global _PATCHED
    if _PATCHED:
        return
    try:
        from langchain_core.language_models import chat_models as cm
        from langchain_core.language_models.chat_models import BaseChatModel
    except ImportError:
        logger.debug("langchain_core unavailable; skip agenerate cancel patch")
        return

    src = textwrap.dedent(inspect.getsource(BaseChatModel.agenerate))
    if _FIXED in src and _NEEDLE not in src:
        _PATCHED = True
        logger.info("langchain BaseChatModel.agenerate already uses BaseException filter; skip patch")
        return
    if _NEEDLE not in src:
        logger.warning(
            "langchain agenerate cancel patch: unexpected source (no Exception filter); skip"
        )
        return

    fixed = src.replace(_NEEDLE, _FIXED, 1)
    ns: dict[str, Any] = {}
    exec(fixed, cm.__dict__, ns)  # noqa: S102 — intentional one-line upstream bugfix
    patched = ns.get("agenerate")
    if patched is None or not inspect.iscoroutinefunction(patched):
        logger.warning("langchain agenerate cancel patch: exec did not yield async agenerate; skip")
        return

    BaseChatModel.agenerate = patched  # type: ignore[method-assign]
    _PATCHED = True
    logger.info(
        "Applied langchain BaseChatModel.agenerate patch "
        "(CancelledError uses BaseException filter; langchain#38469)"
    )


__all__ = ["apply_langchain_agenerate_cancel_patch"]
