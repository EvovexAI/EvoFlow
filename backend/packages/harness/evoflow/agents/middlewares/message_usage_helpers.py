"""Normalize LLM token usage onto ``AIMessage.usage_metadata`` for persistence and UI.

Many OpenAI-compatible gateways (DashScope, proxies, etc.) attach counts only under
``response_metadata["token_usage"]`` / ``usage``; LangChain's ``usage_metadata`` stays null.

Prompt-cache fields (when vendors report them):
  - Anthropic: ``cache_read_input_tokens``, ``cache_creation_input_tokens`` (``input_tokens`` is uncached only)
  - OpenAI / compatible: ``prompt_tokens_details.cached_tokens`` (included in ``prompt_tokens``)
  - Bailian explicit cache: ``prompt_tokens_details.cache_creation_input_tokens``
"""

from __future__ import annotations

from typing import Any

from langchain_core.messages import AIMessage

_CACHE_READ_KEYS = ("cache_read_input_tokens", "cache_read_tokens")
_CACHE_CREATION_KEYS = ("cache_creation_input_tokens", "cache_creation_tokens")
_TOKEN_DETAIL_KEYS = ("input_token_details", "prompt_tokens_details", "input_tokens_details")


def _int_token(v: Any) -> int:
    if v is None or v is False:
        return 0
    try:
        return max(0, int(v))
    except (TypeError, ValueError):
        return 0


def _is_anthropic_style_usage(raw: dict[str, Any]) -> bool:
    """Vendor reports cache read/create outside the primary input/prompt total."""
    return raw.get("cache_read_input_tokens") is not None or raw.get("cache_creation_input_tokens") is not None


def _pick_cache_read_tokens(raw: dict[str, Any]) -> int:
    cache_read = 0
    for key in _CACHE_READ_KEYS:
        cache_read = max(cache_read, _int_token(raw.get(key)))
    for details_key in _TOKEN_DETAIL_KEYS:
        details = raw.get(details_key)
        if isinstance(details, dict):
            cache_read = max(
                cache_read,
                _int_token(details.get("cached_tokens")),
                _int_token(details.get("cache_read")),
            )
    return cache_read


def _pick_cache_creation_tokens(raw: dict[str, Any]) -> int:
    cache_creation = 0
    for key in _CACHE_CREATION_KEYS:
        cache_creation = max(cache_creation, _int_token(raw.get(key)))
    for details_key in _TOKEN_DETAIL_KEYS:
        details = raw.get(details_key)
        if isinstance(details, dict):
            cache_creation = max(
                cache_creation,
                _int_token(details.get("cache_creation_input_tokens")),
                _int_token(details.get("cache_creation_tokens")),
                _int_token(details.get("cache_creation")),
            )
    return cache_creation


def extract_cache_tokens(raw: dict[str, Any] | None, *, input_tokens: int = 0) -> dict[str, int]:
    """Best-effort prompt-cache breakdown from a vendor usage dict."""
    normed = normalize_usage_counts(raw)
    if not normed:
        return {}
    out: dict[str, int] = {}
    for src, dst in (
        ("cache_read_tokens", "cache_read_tokens"),
        ("cache_creation_tokens", "cache_creation_tokens"),
        ("cache_miss_tokens", "cache_miss_tokens"),
    ):
        val = _int_token(normed.get(src))
        if val > 0:
            out[dst] = val
    return out


def normalize_usage_counts(raw: dict[str, Any] | None) -> dict[str, int] | None:
    """Return canonical usage triplet plus optional cache fields, or None if no non-zero usage."""
    if not raw or not isinstance(raw, dict):
        return None

    prompt_or_input = _int_token(raw.get("prompt_tokens") or raw.get("input_tokens"))
    output_tokens = _int_token(raw.get("output_tokens") or raw.get("completion_tokens"))

    cache_read = max(_int_token(raw.get("cache_read_tokens")), _pick_cache_read_tokens(raw))
    cache_creation = max(_int_token(raw.get("cache_creation_tokens")), _pick_cache_creation_tokens(raw))

    is_anthropic = _is_anthropic_style_usage(raw)
    if is_anthropic:
        input_total = prompt_or_input + cache_read + cache_creation
        input_uncached = prompt_or_input
    else:
        input_total = prompt_or_input
        input_uncached = max(0, input_total - cache_read - cache_creation)

    total_tokens = _int_token(raw.get("total_tokens"))
    if total_tokens <= 0:
        total_tokens = input_total + output_tokens

    if input_total == 0 and output_tokens == 0 and total_tokens == 0:
        return None

    cache_miss_raw = raw.get("cache_miss_tokens")
    if cache_miss_raw is not None and not is_anthropic:
        input_uncached = max(0, _int_token(cache_miss_raw))

    result: dict[str, int] = {
        "input_tokens": input_total,
        "output_tokens": output_tokens,
        "total_tokens": total_tokens,
    }
    if cache_read > 0:
        result["cache_read_tokens"] = cache_read
    if cache_creation > 0:
        result["cache_creation_tokens"] = cache_creation
    if input_uncached > 0 and (cache_read > 0 or cache_creation > 0):
        result["cache_miss_tokens"] = input_uncached
    return result


def _merge_normalized_usage(parts: list[dict[str, int]]) -> dict[str, int] | None:
    if not parts:
        return None
    merged = dict(parts[0])
    for part in parts[1:]:
        for key in ("input_tokens", "output_tokens", "total_tokens"):
            merged[key] = max(merged.get(key, 0), part.get(key, 0))
        for key in ("cache_read_tokens", "cache_creation_tokens", "cache_miss_tokens"):
            if key in part:
                merged[key] = max(merged.get(key, 0), part[key])
    return merged


def _usage_source_dicts_from_ai_message(msg: AIMessage) -> list[dict[str, Any]]:
    sources: list[dict[str, Any]] = []
    um = msg.usage_metadata
    if isinstance(um, dict):
        sources.append(um)
    rm = msg.response_metadata
    if isinstance(rm, dict):
        for key in ("usage", "token_usage"):
            v = rm.get(key)
            if isinstance(v, dict):
                sources.append(v)
    ak = msg.additional_kwargs
    if isinstance(ak, dict):
        for key in ("usage", "token_usage"):
            v = ak.get(key)
            if isinstance(v, dict):
                sources.append(v)
    return sources


def _usage_source_dicts_from_checkpoint(msg: dict[str, Any]) -> list[dict[str, Any]]:
    sources: list[dict[str, Any]] = []
    um = msg.get("usage_metadata")
    if isinstance(um, dict):
        sources.append(um)
    rm = msg.get("response_metadata")
    if isinstance(rm, dict):
        for key in ("usage", "token_usage"):
            v = rm.get(key)
            if isinstance(v, dict):
                sources.append(v)
    ak = msg.get("additional_kwargs")
    if isinstance(ak, dict):
        for key in ("usage", "token_usage"):
            v = ak.get(key)
            if isinstance(v, dict):
                sources.append(v)
    return sources


def infer_usage_metadata_for_ai_message(msg: Any) -> dict[str, int] | None:
    """Best-effort usage for an ``AIMessage`` (usage_metadata first, then provider-specific fields)."""
    if not isinstance(msg, AIMessage):
        return None
    normed = [normalize_usage_counts(s) for s in _usage_source_dicts_from_ai_message(msg)]
    normed = [n for n in normed if n]
    return _merge_normalized_usage(normed)


def infer_usage_metadata_from_checkpoint_ai_dict(msg: dict[str, Any]) -> dict[str, int] | None:
    """Same inference as :func:`infer_usage_metadata_for_ai_message` for LangGraph checkpoint dict rows."""
    if not isinstance(msg, dict):
        return None
    t = str(msg.get("type") or "").strip()
    role = str(msg.get("role") or "").strip().lower()
    is_ai = role == "assistant" or t in ("ai", "AIMessage", "AIMessageChunk")
    if not is_ai:
        return None
    normed = [normalize_usage_counts(s) for s in _usage_source_dicts_from_checkpoint(msg)]
    normed = [n for n in normed if n]
    return _merge_normalized_usage(normed)


def normalize_usage_triplet_for_wire(obj: dict[str, Any] | None) -> dict[str, int] | None:
    """Normalize a usage dict for SSE / client wire format (includes cache when present)."""
    return normalize_usage_counts(obj)


def resolve_token_fields_for_persist(
    src: dict[str, Any] | None = None,
    *,
    input_tokens: int | None = None,
    output_tokens: int | None = None,
    total_tokens: int | None = None,
    cache_read_tokens: int | None = None,
    cache_creation_tokens: int | None = None,
    cache_miss_tokens: int | None = None,
) -> tuple[int | None, int | None, int | None, int | None, int | None, int | None]:
    """Canonical per-request token columns for ``evoflow_chat_messages``.

    Prefer vendor usage embedded in ``src`` (``response_metadata`` / ``usage_metadata``).
    Fall back to explicit flat columns (already normalized or raw vendor shapes).
    """
    if isinstance(src, dict) and src:
        inferred = infer_usage_metadata_from_checkpoint_ai_dict(src)
        if inferred:
            return (
                inferred.get("input_tokens"),
                inferred.get("output_tokens"),
                inferred.get("total_tokens"),
                inferred.get("cache_read_tokens"),
                inferred.get("cache_creation_tokens"),
                inferred.get("cache_miss_tokens"),
            )

    explicit: dict[str, Any] = {}
    if input_tokens is not None:
        explicit["input_tokens"] = input_tokens
    if output_tokens is not None:
        explicit["output_tokens"] = output_tokens
    if total_tokens is not None:
        explicit["total_tokens"] = total_tokens
    if cache_read_tokens is not None:
        explicit["cache_read_tokens"] = cache_read_tokens
    if cache_creation_tokens is not None:
        explicit["cache_creation_tokens"] = cache_creation_tokens
    if cache_miss_tokens is not None:
        explicit["cache_miss_tokens"] = cache_miss_tokens
    normed = normalize_usage_counts(explicit or None)
    if not normed:
        return (None, None, None, None, None, None)
    return (
        normed.get("input_tokens"),
        normed.get("output_tokens"),
        normed.get("total_tokens"),
        normed.get("cache_read_tokens"),
        normed.get("cache_creation_tokens"),
        normed.get("cache_miss_tokens"),
    )


def token_fields_for_session_rollup(
    *,
    input_tokens: int | None = None,
    output_tokens: int | None = None,
    total_tokens: int | None = None,
    cache_read_tokens: int | None = None,
    cache_creation_tokens: int | None = None,
    cache_miss_tokens: int | None = None,
) -> dict[str, int]:
    """Non-zero token deltas to accumulate on ``evoflow_chat_sessions`` (session totals)."""
    inp = max(0, int(input_tokens or 0))
    out = max(0, int(output_tokens or 0))
    tot = max(0, int(total_tokens or 0))
    if tot <= 0 and (inp or out):
        tot = inp + out
    cread = max(0, int(cache_read_tokens or 0))
    ccreate = max(0, int(cache_creation_tokens or 0))
    cmiss = max(0, int(cache_miss_tokens or 0))
    return {
        "input_tokens": inp,
        "output_tokens": out,
        "total_tokens": tot,
        "cache_read_tokens": cread,
        "cache_creation_tokens": ccreate,
        "cache_miss_tokens": cmiss,
    }
