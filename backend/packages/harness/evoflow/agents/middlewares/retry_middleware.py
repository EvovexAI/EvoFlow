"""API Retry Middleware — smart retry with error classification and recovery.

Wraps LLM invocations to provide:
- Jittered exponential backoff
- Automatic credential rotation on billing/rate-limit/auth errors
- Context compression trigger on overflow errors
- Provider fallback on server errors
"""

import logging
import random
import time
from collections.abc import Callable

from evoflow.error_classifier import classify

logger = logging.getLogger(__name__)


class ApiRetryMiddleware:
    """Stateful retry middleware for LLM API calls.

    Usage:
        retry = ApiRetryMiddleware()
        response = retry.execute(llm.invoke, messages)

    Recovery callbacks can be set to integrate with the application:
        retry.on_credential_rotate = lambda: pool.rotate()
        retry.on_context_compress = lambda: compressor.compress(messages)
        retry.on_provider_fallback = lambda: switch_provider()
    """

    def __init__(
        self,
        max_retries: int = 3,
        base_delay: float = 3.0,
        max_delay: float = 120.0,
    ):
        self.max_retries = max_retries
        self.base_delay = base_delay
        self.max_delay = max_delay

        # Callbacks — set these to integrate with your system
        self.on_credential_rotate: Callable | None = None
        self.on_context_compress: Callable | None = None
        self.on_provider_fallback: Callable | None = None

    def execute(self, fn: Callable, *args, **kwargs):
        """Execute *fn* with smart retry. Passes *args* and *kwargs* to *fn*."""
        last_error = None
        attempted_compression = False
        _rotated_credential = False

        for attempt in range(self.max_retries + 1):  # first attempt = 0, then retries
            try:
                return fn(*args, **kwargs)
            except Exception as e:
                last_error = e
                classification = classify(e)
                logger.info(
                    "API call failed (attempt %d/%d): %s",
                    attempt + 1,
                    self.max_retries + 1,
                    classification.reason.value,
                )

                if attempt >= self.max_retries:
                    logger.warning("Retry exhausted: %s", classification.reason.value)
                    break

                if not classification.retryable and attempt > 0:
                    logger.warning("Non-retryable error, giving up: %s", classification.reason.value)
                    break

                # ── Apply recovery actions ───────────────────────────

                # Compress context (only once per chain)
                if classification.should_compress and not attempted_compression:
                    if self.on_context_compress:
                        logger.info("Triggering context compression")
                        try:
                            self.on_context_compress()
                            attempted_compression = True
                        except Exception as ce:
                            logger.warning("Context compression callback failed: %s", ce)

                # Rotate credential
                if classification.should_rotate_credential:
                    if self.on_credential_rotate:
                        logger.info("Rotating credential (reason: %s)", classification.reason.value)
                        try:
                            self.on_credential_rotate()
                            _rotated_credential = True
                        except Exception as re:
                            logger.warning("Credential rotate callback failed: %s", re)

                # Fallback provider
                if classification.should_fallback_provider:
                    if self.on_provider_fallback:
                        logger.info("Falling back to alternate provider")
                        try:
                            self.on_provider_fallback()
                        except Exception as pe:
                            logger.warning("Provider fallback callback failed: %s", pe)

                # ── Backoff ─────────────────────────────────────────
                delay = min(self.base_delay * (2**attempt), self.max_delay)
                jitter = delay * 0.5 * random.random()
                actual_delay = delay + jitter
                logger.debug("Backing off %.1fs (attempt %d)", actual_delay, attempt + 1)
                time.sleep(actual_delay)

        raise last_error  # type: ignore[misc]
