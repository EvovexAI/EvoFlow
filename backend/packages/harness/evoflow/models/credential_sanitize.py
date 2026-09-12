"""Sanitize model credentials and HTTP header values before vendor requests."""

from __future__ import annotations

import logging
import os
import re
from typing import Any

logger = logging.getLogger(__name__)

_WHITESPACE_RE = re.compile(r"\s+")
_API_KEY_FIELDS = ("api_key", "openai_api_key")
_CLIENT_CACHE_ATTRS = (
    "client",
    "async_client",
    "_client",
    "_async_client",
    "root_client",
    "root_async_client",
)


def _coerce_to_str(value: Any) -> str | None:
    if value is None:
        return None
    if hasattr(value, "get_secret_value"):
        try:
            text = value.get_secret_value()
            return text if text else None
        except Exception:
            pass
    text = str(value)
    return text if text else None


def resolve_credential_reference(value: Any) -> str | None:
    """Resolve ``$ENV_VAR`` placeholders; return trimmed literal values unchanged."""
    text = _coerce_to_str(value)
    if text is None:
        return None
    stripped = text.strip()
    if not stripped:
        return None
    if stripped.startswith("$"):
        env_name = stripped[1:].strip().lstrip("{").rstrip("}")
        if env_name:
            env_val = os.environ.get(env_name)
            return env_val.strip() if env_val else None
        return None
    return stripped


def sanitize_api_key(value: Any) -> str | None:
    """Normalize API keys copied from docs/UI (trim, drop whitespace and non-ASCII)."""
    text = _coerce_to_str(value)
    if text is None:
        return None
    stripped = text.strip()
    if not stripped:
        return None
    if is_masked_api_key(stripped):
        return None
    compact = _WHITESPACE_RE.sub("", stripped)
    ascii_only = compact.encode("ascii", "ignore").decode("ascii")
    if ascii_only != compact:
        logger.warning(
            "Removed non-ASCII characters from api_key (before=%d chars, after=%d chars)",
            len(compact),
            len(ascii_only),
        )
    elif ascii_only != stripped:
        logger.info("Removed whitespace from api_key")
    return ascii_only or None


def resolve_and_sanitize_api_key(value: Any) -> str | None:
    """Resolve ``$ENV`` then strip spaces / non-ASCII from an API key."""
    return sanitize_api_key(resolve_credential_reference(value))


def is_masked_api_key(value: Any) -> bool:
    """True for Gateway/UI masked secrets like ``****abcd`` (must not be persisted)."""
    text = str(value or "").strip()
    return bool(text) and text.startswith("****")


def sanitize_base_url(value: str | None) -> str | None:
    """Trim base URLs; internal spaces are invalid and dropped."""
    if value is None:
        return None
    trimmed = str(value).strip()
    if not trimmed:
        return None
    compact = _WHITESPACE_RE.sub("", trimmed)
    if compact != trimmed:
        logger.debug("Removed whitespace from base_url")
    return compact


def sanitize_http_header_value(value: Any) -> str:
    """Ensure header values are ASCII-safe for httpx (strip + drop non-ASCII)."""
    if value is None:
        return ""
    text = str(value).strip()
    if not text:
        return ""
    ascii_only = text.encode("ascii", "ignore").decode("ascii").strip()
    if ascii_only != text:
        logger.warning("Removed non-ASCII characters from HTTP header value")
    return ascii_only


def sanitize_default_headers(headers: dict[str, Any] | None) -> dict[str, str] | None:
    """Sanitize custom default_headers before passing to OpenAI/httpx clients."""
    if not headers:
        return None
    cleaned: dict[str, str] = {}
    for key, value in headers.items():
        name = str(key).strip()
        if not name:
            continue
        cleaned[name] = sanitize_http_header_value(value)
    return cleaned or None


_DEFAULT_REQUEST_TIMEOUT_SEC = 120.0


def sanitize_model_connection_settings(settings: dict[str, Any]) -> None:
    """In-place sanitize api_key, base_url, and default_headers in model kwargs."""
    if "timeout" not in settings and "request_timeout" not in settings:
        settings["timeout"] = _DEFAULT_REQUEST_TIMEOUT_SEC
    for key_field in _API_KEY_FIELDS:
        if key_field in settings:
            settings[key_field] = resolve_and_sanitize_api_key(settings.get(key_field))
    if "base_url" in settings:
        settings["base_url"] = sanitize_base_url(settings.get("base_url"))
    if "default_headers" in settings:
        settings["default_headers"] = sanitize_default_headers(settings.get("default_headers"))


from evoflow.config.model_config import resolve_model_max_output_tokens  # noqa: E402


def sanitize_model_document(document: dict[str, Any]) -> dict[str, Any]:
    """Sanitize model rows before SQLite upsert (literal keys only; keep ``$ENV`` refs)."""
    out = dict(document)
    # Pydantic v2 reserved class attribute — never persist as a model field.
    out.pop("model_config", None)
    raw_key = out.get("api_key")
    if raw_key is not None:
        key_text = str(raw_key).strip()
        if key_text.startswith("$"):
            out["api_key"] = key_text
        else:
            out["api_key"] = resolve_and_sanitize_api_key(key_text)
    raw_url = out.get("base_url")
    if raw_url is not None:
        out["base_url"] = sanitize_base_url(str(raw_url))
    raw_mt = out.get("max_tokens")
    try:
        mt = int(raw_mt) if raw_mt is not None else None
    except (TypeError, ValueError):
        mt = None
    out["max_tokens"] = resolve_model_max_output_tokens(mt)
    return out


def _normalized_api_key(value: Any) -> str | None:
    return resolve_and_sanitize_api_key(value)


def reset_chat_model_http_clients(model: Any) -> None:
    """Drop cached sync/async HTTP clients on a chat model (and common wrappers).

    LangChain providers lazily bind httpx/OpenAI clients to the active event loop.
    Subagents run in thread-pool workers with short-lived loops; clearing caches
    before binding a loop-local client avoids cross-loop reuse.
    """
    visited: set[int] = set()

    def _walk(obj: Any) -> None:
        if obj is None:
            return
        oid = id(obj)
        if oid in visited:
            return
        visited.add(oid)
        for attr in _CLIENT_CACHE_ATTRS:
            if hasattr(obj, attr):
                try:
                    object.__setattr__(obj, attr, None)
                except Exception:
                    pass
        for attr in ("bound", "first", "last", "middle", "runnable"):
            _walk(getattr(obj, attr, None))
        fallbacks = getattr(obj, "fallbacks", None)
        if isinstance(fallbacks, (list, tuple)):
            for item in fallbacks:
                _walk(item)

    _walk(model)


def rebuild_chat_model_http_clients(model: Any) -> None:
    """Re-run OpenAI-compatible ``validate_environment`` after httpx rebinding.

    ``reset_chat_model_http_clients`` clears cached ``async_client`` / ``client``
    handles; binding new ``http_async_client`` alone does not recreate them.
    """
    visited: set[int] = set()

    def _walk(obj: Any) -> None:
        if obj is None:
            return
        oid = id(obj)
        if oid in visited:
            return
        visited.add(oid)
        validate = getattr(obj, "validate_environment", None)
        if callable(validate):
            try:
                validate()
            except Exception as exc:
                logger.debug(
                    "rebuild_chat_model_http_clients validate_environment failed: %s",
                    exc,
                )
        for attr in ("bound", "first", "last", "middle", "runnable"):
            _walk(getattr(obj, attr, None))
        fallbacks = getattr(obj, "fallbacks", None)
        if isinstance(fallbacks, (list, tuple)):
            for item in fallbacks:
                _walk(item)

    _walk(model)


def bind_chat_model_http_clients(
    model: Any,
    *,
    http_async_client: Any | None = None,
    http_client: Any | None = None,
) -> None:
    """Attach loop-local httpx clients after ``reset_chat_model_http_clients``."""
    if http_async_client is None and http_client is None:
        return

    visited: set[int] = set()

    def _walk(obj: Any) -> None:
        if obj is None:
            return
        oid = id(obj)
        if oid in visited:
            return
        visited.add(oid)
        if http_async_client is not None and hasattr(obj, "http_async_client"):
            try:
                object.__setattr__(obj, "http_async_client", http_async_client)
            except Exception:
                pass
        if http_client is not None and hasattr(obj, "http_client"):
            try:
                object.__setattr__(obj, "http_client", http_client)
            except Exception:
                pass
        for attr in ("bound", "first", "last", "middle", "runnable"):
            _walk(getattr(obj, attr, None))
        fallbacks = getattr(obj, "fallbacks", None)
        if isinstance(fallbacks, (list, tuple)):
            for item in fallbacks:
                _walk(item)

    _walk(model)
    rebuild_chat_model_http_clients(model)


def patch_chat_model_instance_credentials(model: Any) -> None:
    """Re-apply sanitized api_key on a constructed chat model and drop cached HTTP clients."""
    changed = False
    for field in _API_KEY_FIELDS:
        if not hasattr(model, field):
            continue
        raw = _coerce_to_str(getattr(model, field, None))
        cleaned = _normalized_api_key(getattr(model, field, None))
        if cleaned is None or raw == cleaned:
            continue
        try:
            from pydantic import SecretStr

            object.__setattr__(model, field, SecretStr(cleaned))
        except Exception:
            object.__setattr__(model, field, cleaned)
        changed = True

    if not changed:
        return

    reset_chat_model_http_clients(model)
    rebuild_chat_model_http_clients(model)


def apply_credential_to_model(model: Any, api_key: str, base_url: str | None = None) -> bool:
    """Hot-swap api_key (and optionally base_url) on a constructed chat model.

    Updates the model's api_key field, resets cached HTTP clients, and rebuilds them
    so the next call uses the new credential. Returns True if any field was changed.
    """
    from pydantic import SecretStr

    changed = False
    for field in _API_KEY_FIELDS:
        if not hasattr(model, field):
            continue
        try:
            object.__setattr__(model, field, SecretStr(api_key))
            changed = True
        except Exception:
            pass

    if base_url and hasattr(model, "base_url"):
        try:
            current_base = getattr(model, "base_url", None)
            if current_base != base_url:
                object.__setattr__(model, "base_url", base_url)
                changed = True
        except Exception:
            pass

    if changed:
        reset_chat_model_http_clients(model)
        rebuild_chat_model_http_clients(model)

    return changed
