"""Resolve human-facing model vendor ids for observability (not internal wrapper class names)."""

from __future__ import annotations

from typing import Any

from evoflow.config.models_yaml import infer_vendor_from_connection

_INTERNAL_PROVIDERS = frozenset(
    {
        "patched_openai",
        "patched_deepseek",
        "patched_minimax",
        "claude_provider",
        "codex_responses",
    }
)

_ALIAS_PROVIDERS: dict[str, str] = {
    "patched_deepseek": "deepseek",
    "patched_minimax": "minimax",
    "claude_provider": "anthropic",
    "codex_responses": "openai",
}

_MODEL_PREFIX_VENDORS: dict[str, str] = {
    "google": "google",
    "anthropic": "anthropic",
    "openai": "openai",
    "deepseek": "deepseek",
    "minimax": "minimax",
    "zhipu": "zhipu",
    "qwen": "aliyun",
    "dashscope": "aliyun",
}


def _base_url_from_model_instance(model_instance: Any | None) -> str | None:
    if model_instance is None:
        return None
    for attr in ("openai_api_base", "base_url", "api_base"):
        raw = getattr(model_instance, attr, None)
        if raw:
            return str(raw).strip() or None
    return None


def _vendor_from_model_prefix(model: str | None) -> str | None:
    m = str(model or "").strip().lower()
    if not m:
        return None
    if "/" in m:
        prefix = m.split("/", 1)[0].strip()
        if prefix in _MODEL_PREFIX_VENDORS:
            return _MODEL_PREFIX_VENDORS[prefix]
    for key, vendor in _MODEL_PREFIX_VENDORS.items():
        if m.startswith(f"{key}-") or m.startswith(f"{key}_"):
            return vendor
    return None


def resolve_observability_provider(
    *,
    fallback: str | None = None,
    model: str | None = None,
    base_url: str | None = None,
    model_instance: Any | None = None,
) -> str:
    """Map internal recorder labels (e.g. ``patched_openai``) to configured / inferred vendor ids."""
    if model_instance is not None:
        configured = getattr(model_instance, "_evoflow_vendor", None)
        if configured:
            vendor = str(configured).strip()
            if vendor:
                return vendor
        if base_url is None:
            base_url = _base_url_from_model_instance(model_instance)
        if model is None:
            model = getattr(model_instance, "model_name", None) or getattr(model_instance, "model", None)

    fb = str(fallback or "").strip()
    fb_key = fb.lower()

    if fb and fb_key not in _INTERNAL_PROVIDERS and not fb_key.startswith("patched_"):
        return fb

    prefix_vendor = _vendor_from_model_prefix(model)
    if prefix_vendor:
        return prefix_vendor

    if base_url or model:
        inferred = infer_vendor_from_connection(base_url, str(model or ""))
        if inferred and inferred != "default":
            return inferred

    if fb_key in _ALIAS_PROVIDERS:
        return _ALIAS_PROVIDERS[fb_key]

    if fb_key.startswith("patched_"):
        stripped = fb_key.removeprefix("patched_")
        if stripped:
            return stripped

    return fb or "unknown"


def normalize_stored_provider(provider: str | None, *, model: str | None = None) -> str:
    """Normalize provider already persisted in SQLite (read path)."""
    return resolve_observability_provider(fallback=provider, model=model)
