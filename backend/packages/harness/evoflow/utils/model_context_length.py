"""Resolve LLM input context window (tokens) from ``evoflow_models.context_length`` only."""

from __future__ import annotations

import logging
import os

from evoflow.config import get_app_config
from evoflow.config.model_config import ModelConfig

logger = logging.getLogger(__name__)

# Fallback when a model row has no context_length (should be set in Settings → Models).
DEFAULT_CONTEXT_LENGTH = 256_000

# Absolute compaction-trigger cap (TTFT budget). For large-window models the
# 0.9x ratio defers compaction far beyond reasonable prefill latency —
# production 2026-11-13 saw a session reach 334K ctx / 10.9s avg TTFT before
# the ratio threshold ever fired. Cap the *non-aggressive* threshold at this
# floor; ``EVOFLOW_COMPACT_ABSOLUTE_TOKENS`` overrides (floor 20K).
_ABSOLUTE_COMPACT_CAP_DEFAULT = 150_000
_ABSOLUTE_COMPACT_CAP: int | None = None


def absolute_compact_cap() -> int:
    global _ABSOLUTE_COMPACT_CAP
    if _ABSOLUTE_COMPACT_CAP is None:
        raw = os.getenv("EVOFLOW_COMPACT_ABSOLUTE_TOKENS", "").strip()
        try:
            value = int(raw) if raw else _ABSOLUTE_COMPACT_CAP_DEFAULT
        except ValueError:
            value = _ABSOLUTE_COMPACT_CAP_DEFAULT
        _ABSOLUTE_COMPACT_CAP = max(20_000, value)
    return _ABSOLUTE_COMPACT_CAP

# runtime ``ModelInfo.auto_compact_token_limit``: ``(context_window * 9) / 10``.
AUTO_COMPACT_NUM = 9
AUTO_COMPACT_DEN = 10
AUTO_COMPACT_RATIO = AUTO_COMPACT_NUM / AUTO_COMPACT_DEN  # 0.9


def context_length_from_model_config(model_cfg: ModelConfig | None) -> int | None:
    """Read ``context_length`` stored on the model row; no name heuristics."""
    if model_cfg is None:
        return None
    raw = getattr(model_cfg, "context_length", None)
    if isinstance(raw, int) and raw > 0:
        return raw
    return None


def resolve_model_context_length(
    model_name: str | None = None,
    *,
    model_cfg: ModelConfig | None = None,
) -> int:
    """Return input context window tokens from the model table (``context_length`` column)."""
    if model_cfg is None and model_name:
        model_cfg = get_app_config().get_model_config(model_name)

    stored = context_length_from_model_config(model_cfg)
    if stored is not None:
        return stored

    label = model_name or (model_cfg.name if model_cfg else "?")
    logger.warning(
        "model %r has no context_length in evoflow_models; using default %s — set it in Settings → Models",
        label,
        DEFAULT_CONTEXT_LENGTH,
    )
    return DEFAULT_CONTEXT_LENGTH


def auto_compact_token_limit(context_length: int) -> int:
    """runtime default auto-compact limit: ``(context_window * 9) // 10``."""
    n = max(0, int(context_length))
    return (n * AUTO_COMPACT_NUM) // AUTO_COMPACT_DEN


def compression_threshold_tokens(
    context_length: int,
    *,
    aggressive: bool = False,
    threshold_ratio: float = AUTO_COMPACT_RATIO,
    aggressive_ratio: float = 1.0,
) -> int:
    """Tokens at which compaction should run (runtime-aligned).

    - Primary: when ``threshold_ratio`` is the runtime default (0.9), use integer
      ``(window * 9) // 10`` using the standard 90% auto-compact window heuristic.
    - Aggressive / hard: runtime also forces compact when usage reaches the full
      context window (``full_context_window_limit_reached``).
    - Non-aggressive thresholds are additionally capped at
      ``absolute_compact_cap()`` (default 150K): on big-window models the ratio
      alone lets prefill latency grow unbounded.
    """
    n = max(0, int(context_length))
    if aggressive:
        if float(aggressive_ratio) >= 0.999:
            return n
        return int(n * float(aggressive_ratio))
    ratio = float(threshold_ratio)
    if abs(ratio - AUTO_COMPACT_RATIO) < 1e-9:
        threshold = auto_compact_token_limit(n)
    else:
        threshold = int(n * ratio)
    return min(threshold, absolute_compact_cap())
