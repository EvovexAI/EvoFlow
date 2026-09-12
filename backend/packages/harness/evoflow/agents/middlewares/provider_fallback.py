"""Provider fallback middleware — automatically switches to fallback models on failure.

Usage:
    fallback = ProviderFallbackMiddleware(primary_model_name="gpt-4o")
    response = fallback.execute(llm.invoke, messages)

Config in evoflow_models.extra_json:
    fallback_models: ["deepseek-v3", "claude-sonnet"]
"""

import logging

from evoflow.config import get_app_config
from evoflow.error_classifier import classify
from evoflow.models.factory import create_chat_model

logger = logging.getLogger(__name__)


class ProviderFallbackMiddleware:
    """Wraps an LLM call with model-level fallback chain.

    On non-retryable errors (billing, model_not_found, server_error),
    automatically falls back to the next model in the ``fallback_models`` list.
    """

    def __init__(self, primary_model_name: str, max_fallbacks: int = 3):
        self.primary_model_name = primary_model_name
        self.max_fallbacks = max_fallbacks
        self._current_model = primary_model_name
        self._fallback_attempted = 0

    @property
    def current_model(self) -> str:
        return self._current_model

    def reset(self):
        """Reset to primary model after a successful call."""
        if self._current_model != self.primary_model_name:
            logger.info("Restoring primary model: %s", self.primary_model_name)
        self._current_model = self.primary_model_name
        self._fallback_attempted = 0

    def _get_fallback_chain(self) -> list[str]:
        """Get ordered fallback chain from config."""
        config = get_app_config()
        mc = config.get_model_config(self.primary_model_name)
        if not mc:
            return []
        fallbacks = list(getattr(mc, "fallback_models", None) or [])
        # Parse from extra_json if stored via DB
        if not fallbacks:
            extra = getattr(mc, "extra_json", None) or {}
            if isinstance(extra, dict):
                fallbacks = extra.get("fallback_models", [])
            elif isinstance(extra, str):
                import json

                try:
                    extra_d = json.loads(extra)
                    fallbacks = extra_d.get("fallback_models", [])
                except (json.JSONDecodeError, TypeError):
                    pass
        return fallbacks

    def _build_model(self, model_name: str):
        """Build a chat model instance for *model_name*."""
        return create_chat_model(name=model_name)

    def execute(self, fn, *args, **kwargs):
        """Execute *fn* with provider fallback support."""
        fallback_chain = [self.primary_model_name] + self._get_fallback_chain()
        fallback_chain = fallback_chain[: self.max_fallbacks + 1]

        last_error = None
        for idx, model_name in enumerate(fallback_chain):
            if idx > 0:
                logger.warning(
                    "Falling back from '%s' to fallback model #%d '%s'",
                    fallback_chain[idx - 1],
                    idx,
                    model_name,
                )
                self._current_model = model_name
                self._fallback_attempted = idx

                # Rebuild LLM for fallback model
                try:
                    self._build_model(model_name)
                    # Rebind fn if it's a bound method
                    kwargs = dict(kwargs)
                except Exception as e:
                    logger.error("Failed to build fallback model '%s': %s", model_name, e)
                    last_error = e
                    continue

            try:
                result = fn(*args, **kwargs)
                self.reset()
                return result
            except Exception as e:
                last_error = e
                cls = classify(e)
                logger.info(
                    "Model '%s' failed (attempt %d/%d): %s",
                    model_name,
                    idx + 1,
                    len(fallback_chain),
                    cls.reason.value,
                )

                # Non-retryable: try next fallback
                if not cls.retryable and idx < len(fallback_chain) - 1:
                    continue

                # Retryable but exhausted for this model: try next fallback
                if idx < len(fallback_chain) - 1:
                    continue

                # Last model in chain failed
                break

        raise last_error  # type: ignore[misc]
