"""Token counting helpers for tool-result tiering.

Thin wrapper that delegates to :mod:`evoflow.context.compaction_token_utils`
so we have a single source of truth for tokenizer selection (model-aware
encoder routing + CJK-aware heuristic fallback). Previously this module
maintained its own ``cl100k_base`` encoder and ``len/4`` fallback, which
drifted from the main compaction estimator.
"""

from __future__ import annotations

from evoflow.context.compaction_token_utils import (
    _CHARS_PER_TOKEN,  # re-exported for backwards compat
    count_text_tokens,
)

__all__ = ["count_tool_tokens", "_CHARS_PER_TOKEN"]


def count_tool_tokens(text: str, *, model: str | None = None) -> int:
    """Estimate token count for tool-result text.

    Routes through :func:`count_text_tokens`, which picks the right tiktoken
    encoding based on the active model scope (or explicit ``model`` arg) and
    falls back to a CJK-aware heuristic when tiktoken is unavailable.
    """
    return count_text_tokens(text, model=model)
