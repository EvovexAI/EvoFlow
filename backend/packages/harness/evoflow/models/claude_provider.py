"""Custom Claude provider with OAuth Bearer auth, prompt caching, and smart thinking.

Supports two authentication modes:
  1. Standard API key (x-api-key header) — default ChatAnthropic behavior
  2. Claude Code OAuth token (Authorization: Bearer header)
     - Detected by sk-ant-oat prefix
     - Requires anthropic-beta: oauth-2025-04-20,claude-code-20250219
     - Requires billing header in system prompt for all OAuth requests

Auto-loads credentials from explicit runtime handoff:
  - $ANTHROPIC_API_KEY environment variable
  - $CLAUDE_CODE_OAUTH_TOKEN or $ANTHROPIC_AUTH_TOKEN
  - $CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR
  - $CLAUDE_CODE_CREDENTIALS_PATH
  - ~/.claude/.credentials.json
"""

import hashlib
import json
import logging
import os
import random
import socket
import time
import uuid
from typing import Any

import anthropic
from langchain_anthropic import ChatAnthropic
from langchain_core.messages import BaseMessage

from evoflow.error_classifier import FailoverReason, classify
from evoflow.models.request_payload_logger import log_model_request_payload
from evoflow.models.vendor_roundtrip import VendorRoundtripChatMixin

logger = logging.getLogger(__name__)

MAX_RETRIES = 3
THINKING_BUDGET_RATIO = 0.8

# Billing header required by Anthropic API for OAuth token access.
# Must be the first system prompt block. Format mirrors Claude Code CLI.
# Override with ANTHROPIC_BILLING_HEADER env var if the hardcoded version drifts.
_DEFAULT_BILLING_HEADER = "x-anthropic-billing-header: cc_version=2.1.85.351; cc_entrypoint=cli; cch=6c6d5;"
OAUTH_BILLING_HEADER = os.environ.get("ANTHROPIC_BILLING_HEADER", _DEFAULT_BILLING_HEADER)


class ClaudeChatModel(VendorRoundtripChatMixin, ChatAnthropic):
    """ChatAnthropic with OAuth Bearer auth, prompt caching, and smart thinking.

    Config example:
        - name: claude-sonnet-4.6
          use: evoflow.models.claude_provider:ClaudeChatModel
          model: claude-sonnet-4-6
          max_tokens: 16384
          enable_prompt_caching: true
    """

    # Custom fields
    enable_prompt_caching: bool = True
    prompt_cache_size: int = 3
    auto_thinking_budget: bool = True
    retry_max_attempts: int = MAX_RETRIES
    _is_oauth: bool = False
    _oauth_access_token: str = ""

    model_config = {"arbitrary_types_allowed": True}

    def _validate_retry_config(self) -> None:
        if self.retry_max_attempts < 1:
            raise ValueError("retry_max_attempts must be >= 1")

    def model_post_init(self, __context: Any) -> None:
        """Auto-load credentials and configure OAuth if needed."""
        from pydantic import SecretStr

        from evoflow.models.credential_loader import (
            OAUTH_ANTHROPIC_BETAS,
            is_oauth_token,
            load_claude_code_credential,
        )

        self._validate_retry_config()

        # Extract actual key value (SecretStr.str() returns '**********')
        current_key = ""
        if self.anthropic_api_key:
            if hasattr(self.anthropic_api_key, "get_secret_value"):
                current_key = self.anthropic_api_key.get_secret_value()
            else:
                current_key = str(self.anthropic_api_key)

        # Try the explicit Claude Code OAuth handoff sources if no valid key.
        if not current_key or current_key in ("your-anthropic-api-key",):
            cred = load_claude_code_credential()
            if cred:
                current_key = cred.access_token
                logger.info(f"Using Claude Code CLI credential (source: {cred.source})")
            else:
                logger.warning("No Anthropic API key or explicit Claude Code OAuth credential found.")

        # Detect OAuth token and configure Bearer auth
        if is_oauth_token(current_key):
            self._is_oauth = True
            self._oauth_access_token = current_key
            # Set the token as api_key temporarily (will be swapped to auth_token on client)
            self.anthropic_api_key = SecretStr(current_key)
            # Add required beta headers for OAuth
            self.default_headers = {
                **(self.default_headers or {}),
                "anthropic-beta": OAUTH_ANTHROPIC_BETAS,
            }
            # OAuth tokens have a limit of 4 cache_control blocks — disable prompt caching
            self.enable_prompt_caching = False
            logger.info("OAuth token detected — will use Authorization: Bearer header")
        else:
            if current_key:
                self.anthropic_api_key = SecretStr(current_key)

        # Ensure api_key is SecretStr
        if isinstance(self.anthropic_api_key, str):
            self.anthropic_api_key = SecretStr(self.anthropic_api_key)

        super().model_post_init(__context)

        # Patch clients immediately after creation for OAuth Bearer auth.
        # This must happen after super() because clients are lazily created.
        if self._is_oauth:
            self._patch_client_oauth(self._client)
            self._patch_client_oauth(self._async_client)

    def _patch_client_oauth(self, client: Any) -> None:
        """Swap api_key → auth_token on an Anthropic SDK client for OAuth Bearer auth."""
        if hasattr(client, "api_key") and hasattr(client, "auth_token"):
            client.api_key = None
            client.auth_token = self._oauth_access_token

    def _get_request_payload(
        self,
        input_: Any,
        *,
        stop: list[str] | None = None,
        **kwargs: Any,
    ) -> dict:
        """Override to inject prompt caching, thinking budget, and OAuth billing."""
        payload = super()._get_request_payload(input_, stop=stop, **kwargs)

        if self._is_oauth:
            self._apply_oauth_billing(payload)

        if self.enable_prompt_caching:
            self._apply_prompt_caching(payload)

        if self.auto_thinking_budget:
            self._apply_thinking_budget(payload)

        log_model_request_payload(
            provider="claude_provider",
            model=getattr(self, "model", None),
            payload=payload,
            invocation_kind=getattr(self, "_evoflow_invocation_kind", None),
            model_instance=self,
        )
        return payload

    def _apply_oauth_billing(self, payload: dict) -> None:
        """Inject the billing header block required for all OAuth requests.

        The billing block is always placed first in the system list, removing any
        existing occurrence to avoid duplication or out-of-order positioning.
        """
        billing_block = {"type": "text", "text": OAUTH_BILLING_HEADER}

        system = payload.get("system")
        if isinstance(system, list):
            # Remove any existing billing blocks, then insert a single one at index 0.
            filtered = [b for b in system if not (isinstance(b, dict) and OAUTH_BILLING_HEADER in b.get("text", ""))]
            payload["system"] = [billing_block] + filtered
        elif isinstance(system, str):
            cleaned = system.replace(OAUTH_BILLING_HEADER, "").strip()
            if cleaned:
                payload["system"] = [billing_block, {"type": "text", "text": cleaned}]
            else:
                payload["system"] = [billing_block]
        else:
            payload["system"] = [billing_block]

        # Add metadata.user_id required by the API for OAuth billing validation
        if not isinstance(payload.get("metadata"), dict):
            payload["metadata"] = {}
        if "user_id" not in payload["metadata"]:
            # Generate a stable device_id from the machine's hostname
            hostname = socket.gethostname()
            device_id = hashlib.sha256(f"evoflow-{hostname}".encode()).hexdigest()
            session_id = str(uuid.uuid4())
            payload["metadata"]["user_id"] = json.dumps(
                {
                    "device_id": device_id,
                    "account_uuid": "evoflow",
                    "session_id": session_id,
                }
            )

    def _apply_prompt_caching(self, payload: dict) -> None:
        """Apply ephemeral cache_control to system and recent messages."""
        # Cache system messages
        system = payload.get("system")
        if system and isinstance(system, list):
            for block in system:
                if isinstance(block, dict) and block.get("type") == "text":
                    block["cache_control"] = {"type": "ephemeral"}
        elif system and isinstance(system, str):
            payload["system"] = [
                {
                    "type": "text",
                    "text": system,
                    "cache_control": {"type": "ephemeral"},
                }
            ]

        # Cache recent messages
        messages = payload.get("messages", [])
        cache_start = max(0, len(messages) - self.prompt_cache_size)
        for i in range(cache_start, len(messages)):
            msg = messages[i]
            if not isinstance(msg, dict):
                continue
            content = msg.get("content")
            if isinstance(content, list):
                for block in content:
                    if isinstance(block, dict):
                        block["cache_control"] = {"type": "ephemeral"}
            elif isinstance(content, str) and content:
                msg["content"] = [
                    {
                        "type": "text",
                        "text": content,
                        "cache_control": {"type": "ephemeral"},
                    }
                ]

        # Cache the last tool definition
        tools = payload.get("tools", [])
        if tools and isinstance(tools[-1], dict):
            tools[-1]["cache_control"] = {"type": "ephemeral"}

    def _apply_thinking_budget(self, payload: dict) -> None:
        """Auto-allocate thinking budget (80% of max_tokens)."""
        thinking = payload.get("thinking")
        if not thinking or not isinstance(thinking, dict):
            return
        if thinking.get("type") != "enabled":
            return
        if thinking.get("budget_tokens"):
            return

        max_tokens = payload.get("max_tokens", 8192)
        thinking["budget_tokens"] = int(max_tokens * THINKING_BUDGET_RATIO)

    def _anthropic_retryable_error_types(self) -> tuple[type[BaseException], ...]:
        names = (
            "RateLimitError",
            "InternalServerError",
            "APIConnectionError",
            "APITimeoutError",
            "APIStatusError",
            "BadRequestError",
        )
        out: list[type[BaseException]] = []
        for name in names:
            cls = getattr(anthropic, name, None)
            if isinstance(cls, type) and issubclass(cls, BaseException):
                out.append(cls)
        return tuple(out)

    def _rotate_credential_if_available(self, *, reason: str = "auth") -> bool:
        pool = getattr(self, "_credential_pool", None)
        if pool is None:
            return False
        try:
            current = pool.get()
            if current is not None:
                pool.mark_failed(current, reason)
            cred = pool.get()
            if cred is None or not cred.api_key:
                return False
            from pydantic import SecretStr

            self.anthropic_api_key = SecretStr(cred.api_key)
            if self._is_oauth:
                self._oauth_access_token = cred.api_key
                self._patch_client_oauth(self._client)
                self._patch_client_oauth(self._async_client)
            else:
                if hasattr(self._client, "api_key"):
                    self._client.api_key = cred.api_key
                if hasattr(self._async_client, "api_key"):
                    self._async_client.api_key = cred.api_key
            logger.info("Rotated Anthropic credential via pool (reason=%s)", reason)
            return True
        except Exception:
            logger.warning("Anthropic credential rotation failed", exc_info=True)
            return False

    def _sleep_backoff(self, seconds: float) -> None:
        """Backoff sleep that avoids freezing a running asyncio event loop."""
        import asyncio

        try:
            loop = asyncio.get_running_loop()
            if loop.is_running():
                if seconds > 0.05:
                    logger.debug(
                        "Skipping %.2fs sync backoff while event loop is running (use _agenerate path)",
                        seconds,
                    )
                return
        except RuntimeError:
            pass
        time.sleep(seconds)

    def _prepare_retry_after_error(self, error: Exception, attempt: int) -> None:
        cls = classify(error)
        reason = cls.reason.value if cls.reason else "unknown"
        if cls.should_rotate_credential:
            self._rotate_credential_if_available(reason=reason)
        wait_ms = self._calc_backoff_ms(attempt, error)
        logger.warning(
            "Anthropic API error (%s), retrying attempt %d/%d after %dms",
            error.__class__.__name__,
            attempt,
            self.retry_max_attempts,
            wait_ms,
        )
        self._sleep_backoff(wait_ms / 1000)

    def _should_retry_error(self, error: Exception, attempt: int) -> bool:
        if attempt >= self.retry_max_attempts:
            return False
        cls = classify(error)
        if not cls.retryable:
            if cls.should_rotate_credential and self._rotate_credential_if_available(
                reason=cls.reason.value if cls.reason else "auth"
            ):
                return True
            return False
        if cls.reason == FailoverReason.CONTEXT_OVERFLOW:
            return False
        auth_types = _anthropic_error_types("AuthenticationError", "PermissionDeniedError", "NotFoundError")
        if auth_types and isinstance(error, auth_types):
            if cls.should_rotate_credential and self._rotate_credential_if_available(
                reason=cls.reason.value if cls.reason else "auth"
            ):
                return True
            return False
        return True

    def _generate(self, messages: list[BaseMessage], stop: list[str] | None = None, **kwargs: Any) -> Any:
        """Override with OAuth patching and retry logic."""
        retryable_types = self._anthropic_retryable_error_types()
        for attempt in range(1, self.retry_max_attempts + 1):
            if self._is_oauth:
                self._patch_client_oauth(self._client)
            try:
                return super()._generate(messages, stop=stop, **kwargs)
            except Exception as e:
                if not isinstance(e, retryable_types) and not _is_transient_classified_error(e):
                    if not self._should_retry_error(e, attempt):
                        raise
                elif not self._should_retry_error(e, attempt):
                    raise
                self._prepare_retry_after_error(e, attempt)
        raise RuntimeError("Anthropic model call failed after retries")

    async def _agenerate(self, messages: list[BaseMessage], stop: list[str] | None = None, **kwargs: Any) -> Any:
        """Async override with OAuth patching and retry logic."""
        import asyncio

        retryable_types = self._anthropic_retryable_error_types()
        for attempt in range(1, self.retry_max_attempts + 1):
            if self._is_oauth:
                self._patch_client_oauth(self._async_client)
            try:
                return await super()._agenerate(messages, stop=stop, **kwargs)
            except Exception as e:
                if not isinstance(e, retryable_types) and not _is_transient_classified_error(e):
                    if not self._should_retry_error(e, attempt):
                        raise
                elif not self._should_retry_error(e, attempt):
                    raise
                wait_ms = self._calc_backoff_ms(attempt, e)
                cls = classify(e)
                if cls.should_rotate_credential:
                    self._rotate_credential_if_available(reason=cls.reason.value if cls.reason else "auth")
                logger.warning(
                    "Anthropic API error (%s), retrying attempt %d/%d after %dms",
                    e.__class__.__name__,
                    attempt,
                    self.retry_max_attempts,
                    wait_ms,
                )
                await asyncio.sleep(wait_ms / 1000)
        raise RuntimeError("Anthropic model call failed after retries")

    @staticmethod
    def _calc_backoff_ms(attempt: int, error: Exception) -> int:
        """Exponential backoff with random jitter and optional Retry-After."""
        backoff_ms = 2000 * (1 << (attempt - 1))
        jitter_ms = random.uniform(0, backoff_ms * 0.2)
        total_ms = int(backoff_ms + jitter_ms)

        if hasattr(error, "response") and error.response is not None:
            retry_after = error.response.headers.get("Retry-After")
            if retry_after:
                try:
                    total_ms = int(float(retry_after) * 1000)
                except (ValueError, TypeError):
                    pass

        return total_ms


def _is_transient_classified_error(error: Exception) -> bool:
    cls = classify(error)
    return cls.retryable and cls.reason not in {FailoverReason.CONTEXT_OVERFLOW, FailoverReason.MODEL_NOT_FOUND}


def _anthropic_error_types(*names: str) -> tuple[type[BaseException], ...]:
    out: list[type[BaseException]] = []
    for name in names:
        cls = getattr(anthropic, name, None)
        if isinstance(cls, type) and issubclass(cls, BaseException):
            out.append(cls)
    return tuple(out)
