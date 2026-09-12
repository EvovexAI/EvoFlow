"""Centralized API error classification for EvoFlow.

Maps API errors from various providers (OpenAI, Anthropic, etc.) to
structured recovery actions. Enables smart retry, credential rotation,
provider fallback, and context compression decisions.
"""

import logging
import re
from dataclasses import dataclass
from enum import Enum

logger = logging.getLogger(__name__)


class FailoverReason(Enum):
    """Structured classification of API failures."""

    AUTH = "auth"
    AUTH_PERMANENT = "auth_permanent"
    BILLING = "billing"
    RATE_LIMIT = "rate_limit"
    OVERLOADED = "overloaded"
    SERVER_ERROR = "server_error"
    TIMEOUT = "timeout"
    CONTEXT_OVERFLOW = "context_overflow"
    PAYLOAD_TOO_LARGE = "payload_too_large"
    MODEL_NOT_FOUND = "model_not_found"
    FORMAT_ERROR = "format_error"
    CONNECTION_ERROR = "connection_error"
    UNKNOWN = "unknown"


@dataclass
class Classification:
    """Classification result with recovery guidance."""

    reason: FailoverReason
    retryable: bool = True
    should_rotate_credential: bool = False
    should_compress: bool = False
    should_fallback_provider: bool = False
    message: str = ""


# ---------------------------------------------------------------------------
# Pattern sets for error message matching
# ---------------------------------------------------------------------------

_BILLING_PATTERNS = [
    "insufficient_quota",
    "billing",
    "exceeded.*quota",
    "payment required",
    "quota exceeded",
    "quota_exceeded",
    "billing_hard_limit_reached",
    "credit limit",
    "rate limit.*billing",
    "accountquotaexceeded",
    "monthly usage quota",
    "402",
]

# Account-level monthly quota — rotating API keys on the same account cannot help.
_ACCOUNT_QUOTA_PATTERNS = [
    "accountquotaexceeded",
    "monthly usage quota",
]

_RATE_LIMIT_PATTERNS = [
    "rate_limit",
    "rate limit",
    "too many requests",
    "429",
    "requests ratelimited",
    "request limit",
    # DeepSeek / Ark: account concurrent or set inference cap (retryable)
    "setlimitexceeded",
    "set inference limit",
    "inference limit",
]

_AUTH_PATTERNS = [
    # Do NOT use bare ``auth`` or ``invalid.*token``: Ark/DashScope
    # ``InvalidParameter`` + ``…exceed … tokens`` was misread as auth and
    # exhausted the only credential instead of compressing context.
    "invalid.*api.*key",
    r"invalid[_\s-]*(?:api|access)[_\s-]*key",
    r"invalid[_\s-]*(?:api|access)[_\s-]*token",
    r"\binvalid[_\s-]+token\b",
    "authentication",
    "unauthorized",
    r"\b401\b",
    r"\bauthorization\b",
    "missing.*api.*key",
    "没有提供apikey",
    "apikey 无效",
]

_CONTEXT_OVERFLOW_PATTERNS = [
    "context_length_exceeded",
    "maximum context",
    "token limit",
    "too many tokens",
    "输入token数超过上限",
    "maximum context length",
    "context length",
    "context window",
    "exceeds the context",
    "input exceeds",
    "exceeds.*context",
    # Volcengine Ark / DashScope vision+text gate (400 InvalidParameter)
    "exceed max message tokens",
    "max message tokens",
    "tokens of image and text",
    "image and text exceed",
    "total tokens.*exceed",
]

_OVERLOADED_PATTERNS = [
    "overloaded",
    "servers are currently overloaded",
    "capacity exceeded",
]

_MODEL_NOT_FOUND_PATTERNS = [
    "model.*not found",
    "model.*not.*exist",
    "deployment.*not found",
]

_SERVER_ERROR_PATTERNS = [
    "server error",
    "internal error",
    "service unavailable",
    "500",
    "502",
    "503",
    "504",
    "temporarily unavailable",
]

_TIMEOUT_PATTERNS = [
    "timeout",
    "timed out",
    "deadline exceeded",
    "connection.*time",
    "socket.*time",
]


def _matches(text: str, patterns: list[str]) -> bool:
    """Check if any pattern matches the text (case-insensitive)."""
    return any(re.search(p, text, re.IGNORECASE) for p in patterns)


def _extract_status_code(exc: Exception) -> int | None:
    """Extract HTTP status code from any exception type.

    Handles LangChain exceptions, requests.Response, httpx, etc.
    """
    # Direct attribute access
    for attr in ("status_code", "status", "http_status"):
        val = getattr(exc, attr, None)
        if isinstance(val, int):
            return val

    # LangChain: exc.response.status_code
    resp = getattr(exc, "response", None)
    if resp is not None:
        if hasattr(resp, "status_code"):
            return resp.status_code
        if isinstance(resp, int):
            return resp

    # httpx: exc.__context__ (wrapped HTTPStatusError)
    ctx = getattr(exc, "__context__", None)
    if ctx is not None:
        sc = getattr(ctx, "status_code", None)
        if isinstance(sc, int):
            return sc

    # OpenAI: exc.code (often numeric string)
    code = getattr(exc, "code", None)
    if code is not None:
        try:
            return int(str(code))
        except (ValueError, TypeError):
            pass

    return None


def classify(exception: Exception, context: dict | None = None) -> Classification:
    """Classify an API exception and return structured recovery actions.

    Args:
        exception: The exception raised by the LLM/API call.
        context: Optional dict with extra info (e.g. {"model": "gpt-4o"}).

    Returns:
        Classification with reason and recovery guidance booleans.
    """
    status_code = _extract_status_code(exception)
    error_msg = str(exception)
    error_lower = error_msg.lower()

    logger.debug("Classifying error: status=%s, msg=%.200s", status_code, error_msg)

    # ── Billing / Quota ──────────────────────────────────────────────
    if status_code == 402 or _matches(error_lower, _BILLING_PATTERNS):
        account_quota = _matches(error_lower, _ACCOUNT_QUOTA_PATTERNS)
        return Classification(
            reason=FailoverReason.BILLING,
            retryable=False,
            should_rotate_credential=not account_quota,
            should_fallback_provider=True,
            message=f"Billing/quota error: {error_msg[:200]}",
        )

    # ── Rate limit ───────────────────────────────────────────────────
    if status_code == 429 or _matches(error_lower, _RATE_LIMIT_PATTERNS):
        return Classification(
            reason=FailoverReason.RATE_LIMIT,
            retryable=True,
            should_rotate_credential=True,
            message=f"Rate limited: {error_msg[:200]}",
        )

    # ── Context overflow (before auth) ───────────────────────────────
    # Token-exceed 400s often use code=InvalidParameter; must not hit auth rotation.
    if _matches(error_lower, _CONTEXT_OVERFLOW_PATTERNS):
        return Classification(
            reason=FailoverReason.CONTEXT_OVERFLOW,
            retryable=True,
            should_compress=True,
            message=f"Context overflow: {error_msg[:200]}",
        )

    # Legacy: some gateways still return 400 without a recognizable overflow message.
    if status_code == 400 and (
        ("context" in error_lower and "length" in error_lower)
        or ("exceed" in error_lower and "token" in error_lower)
    ):
        return Classification(
            reason=FailoverReason.CONTEXT_OVERFLOW,
            retryable=True,
            should_compress=True,
            message=f"Context overflow: {error_msg[:200]}",
        )

    # ── Auth ─────────────────────────────────────────────────────────
    if status_code == 401 or _matches(error_lower, _AUTH_PATTERNS):
        return Classification(
            reason=FailoverReason.AUTH,
            retryable=True,
            should_rotate_credential=True,
            message=f"Auth error: {error_msg[:200]}",
        )

    # ── Payload too large ────────────────────────────────────────────
    if status_code == 413 or _matches(
        error_lower,
        [
            "payload too large",
            "request too large",
            "content too large",
            "max bytes to request body",
            "exceeded limit on max bytes",
            "request body.*too large",
            "entity too large",
        ],
    ):
        return Classification(
            reason=FailoverReason.PAYLOAD_TOO_LARGE,
            retryable=True,
            should_compress=True,
            message=f"Payload too large: {error_msg[:200]}",
        )

    # ── Model not found ──────────────────────────────────────────────
    model_not_found = (status_code == 404 and ("model" in error_lower or "deployment" in error_lower)) or _matches(
        error_lower, _MODEL_NOT_FOUND_PATTERNS
    )
    if model_not_found:
        return Classification(
            reason=FailoverReason.MODEL_NOT_FOUND,
            retryable=False,
            should_fallback_provider=True,
            message=f"Model not found: {error_msg[:200]}",
        )

    # ── Overloaded (retryable; prefer same-model retry before fallback) ─
    if _matches(error_lower, _OVERLOADED_PATTERNS):
        return Classification(
            reason=FailoverReason.OVERLOADED,
            retryable=True,
            should_fallback_provider=True,
            message=f"Overloaded: {error_msg[:200]}",
        )

    # ── Server errors ────────────────────────────────────────────────
    if status_code in (500, 502, 503, 504) or _matches(error_lower, _SERVER_ERROR_PATTERNS):
        return Classification(
            reason=FailoverReason.SERVER_ERROR,
            retryable=True,
            should_fallback_provider=True,
            message=f"Server error: {error_msg[:200]}",
        )

    # ── Connection error（含中转站/代理常见断流）─────────────────────
    cls_name = getattr(exception, "__class__", type(exception)).__name__
    if cls_name in {
        "APIConnectionError",
        "ConnectionError",
        "ConnectError",
        "RemoteProtocolError",
        "LocalProtocolError",
        "ReadError",
        "WriteError",
        "NetworkError",
        "ProxyError",
        "ProtocolError",
        "BrokenPipeError",
        "ConnectionResetError",
        "ConnectionAbortedError",
        "IncompleteRead",
        "StreamClosed",
        "StreamError",
        "StreamReset",
    } or _matches(error_lower, [
        "connection error",
        "connection refused",
        "connection reset",
        "connection aborted",
        "connection closed",
        "name or service not known",
        "nodename nor servname provided",
        "network is unreachable",
        "failed to establish",
        "peer closed connection",
        "remote end closed",
        "remote disconnected",
        "server disconnected",
        "incomplete chunked read",
        "chunked encoding",
        "broken pipe",
        "unexpected eof",
        "eof occurred",
        "stream reset",
        "stream closed",
        "ssl.*eof",
        "temporarily unavailable",
        "bad gateway",
        "gateway timeout",
        "error communicating with",
        "network error",
        "proxy error",
        "连接.*重置",
        "连接.*关闭",
        "连接.*中断",
        "网络.*异常",
        "网络.*错误",
    ]):
        return Classification(
            reason=FailoverReason.CONNECTION_ERROR,
            retryable=True,
            should_fallback_provider=True,
            message=f"Connection error ({cls_name}): {error_msg[:200]}",
        )

    # ── Timeout ──────────────────────────────────────────────────────
    cls_name = getattr(exception, "__class__", type(exception)).__name__
    if cls_name in {"ReadTimeout", "WriteTimeout", "ConnectTimeout", "PoolTimeout", "TimeoutError", "APITimeoutError"}:
        return Classification(
            reason=FailoverReason.TIMEOUT,
            retryable=True,
            should_fallback_provider=True,
            message=f"Timeout ({cls_name}): {error_msg[:200]}",
        )

    if _matches(error_lower, _TIMEOUT_PATTERNS):
        return Classification(
            reason=FailoverReason.TIMEOUT,
            retryable=True,
            should_fallback_provider=True,
            message=f"Timeout: {error_msg[:200]}",
        )

    # ── Unknown ──────────────────────────────────────────────────────
    return Classification(
        reason=FailoverReason.UNKNOWN,
        retryable=True,
        message=f"Unknown error: {error_msg[:200]}",
    )
