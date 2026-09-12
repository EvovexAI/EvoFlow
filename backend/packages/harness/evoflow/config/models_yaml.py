"""YAML layout for ``models``: nested ``providers`` (one connection per vendor group) vs legacy flat list."""

from __future__ import annotations

import logging
import re
from collections import OrderedDict
from typing import Any
from urllib.parse import urlparse

from evoflow.config.model_config import ModelConfig

logger = logging.getLogger(__name__)

# Connection fields compared against the first model in a vendor group (omit from entry if equal)
_CONNECTION_KEYS = frozenset(
    {
        "use",
        "base_url",
        "api_key",
        "request_timeout",
        "max_retries",
        "temperature",
    }
)


def infer_vendor_from_connection(base_url: str | None, model_name: str) -> str:
    """Infer English vendor id from URL / name (legacy configs without ``vendor``)."""
    if base_url:
        host = (urlparse(base_url).hostname or "").lower()
        if "openai" in host and "azure" not in host:
            return "openai"
        if "anthropic" in host:
            return "anthropic"
        if "deepseek" in host:
            return "deepseek"
        if "google" in host or "generativelanguage" in host:
            return "google"
        if "dashscope" in host or "aliyun" in host:
            return "aliyun"
        if "siliconflow" in host:
            return "siliconflow"
        if "bigmodel" in host or "zhipu" in host:
            return "zhipu"
        if "minimax" in host:
            return "minimax"
        if "volces" in host or "volcengine" in host:
            return "volcengine"
        if "localhost" in host or "127.0.0.1" in host or "ollama" in host:
            return "ollama"
        if "nvidia" in host:
            return "nvidia"
        first = host.split(".")[0] if host else ""
        if first and re.match(r"^[a-z][a-z0-9_-]*$", first):
            return first[:48]
    slug = (model_name or "model").split("-")[0].strip().lower()
    return slug or "default"


def _coerce_model_entry(m: Any) -> dict[str, Any] | None:
    """Normalize one models-list item to a dict, or None to skip."""
    if m is None:
        return None
    if isinstance(m, dict):
        return dict(m)
    if isinstance(m, str):
        # Bare ids are invalid flat-list entries (need use/base_url/…). Skipping
        # avoids ``dict("gpt-5.6-sol")`` → char map and later confusing failures.
        name = m.strip()
        if name:
            logger.warning("Skipping bare string model entry: %r", name)
        return None
    dump = getattr(m, "model_dump", None)
    if callable(dump):
        try:
            d = dump(mode="json")
        except TypeError:
            d = dump()
        if isinstance(d, dict):
            return d
        logger.warning(
            "Skipping model entry whose model_dump() returned %s: %r",
            type(d).__name__,
            d,
        )
        return None
    if isinstance(m, (bytes, bytearray, memoryview)):
        logger.warning("Skipping non-mapping model entry: %s", type(m).__name__)
        return None
    try:
        d = dict(m)
    except Exception:
        logger.warning("Skipping non-mapping model entry: %s", type(m).__name__)
        return None
    return d if isinstance(d, dict) else None


def _normalize_models_input(raw: Any) -> list[dict[str, Any]]:
    """Turn YAML ``models`` (legacy list or ``{ providers: ... }``) into a list of model dicts."""
    if raw is None:
        return []
    if isinstance(raw, list):
        out: list[dict[str, Any]] = []
        for m in raw:
            d = _coerce_model_entry(m)
            if d is None:
                continue
            out.append(_ensure_vendor_field(d))
        return out
    if isinstance(raw, dict) and "providers" in raw:
        return flatten_providers_dict(raw["providers"])
    return []


def flatten_providers_dict(providers: dict[str, Any]) -> list[dict[str, Any]]:
    """Expand ``models.providers`` into flat model dicts (one dict per model, fully merged)."""
    out: list[dict[str, Any]] = []
    for yaml_key, pdata in providers.items():
        if not isinstance(pdata, dict):
            continue
        sub = pdata.get("models")
        if not isinstance(sub, list) or not sub:
            continue
        vendor = (pdata.get("vendor") or yaml_key or "").strip() or yaml_key
        shared = {k: v for k, v in pdata.items() if k != "models"}
        # Provider-only human label; do not merge into ModelConfig.display_name
        shared.pop("display_name", None)
        shared.pop("vendor_label", None)
        shared["vendor"] = vendor
        for entry in sub:
            if not isinstance(entry, dict):
                continue
            merged = {**shared, **entry}
            merged["vendor"] = vendor
            merged.setdefault("name", entry.get("name"))
            merged.setdefault("model", entry.get("model"))
            out.append(_ensure_vendor_field(merged))
    return out


def _ensure_vendor_field(m: dict[str, Any]) -> dict[str, Any]:
    if m.get("vendor"):
        return m
    m = dict(m)
    m["vendor"] = infer_vendor_from_connection(m.get("base_url"), str(m.get("name") or ""))
    return m


def _provider_bucket_key(mc: ModelConfig) -> tuple[str, str, str]:
    v = (mc.vendor or infer_vendor_from_connection(mc.base_url, mc.name) or "default").strip()
    bu = (mc.base_url or "").rstrip("/")
    u = mc.use or ""
    return (v, bu, u)


def _unique_provider_yaml_key(vendor: str, base_url: str | None, used: set[str]) -> str:
    bu = base_url or ""
    host = (urlparse(bu).hostname or "").lower() if bu else ""
    base = vendor or "default"
    if "coding" in host and ("dashscope" in host or "aliyuncs" in host):
        candidate = f"{base}-coding"
    elif "compatible-mode" in bu and "dashscope" in host:
        candidate = f"{base}-compatible"
    else:
        candidate = base
    key = candidate
    n = 2
    while key in used:
        key = f"{candidate}-{n}"
        n += 1
    return key


def _model_entry_dict(mc: ModelConfig, shared: ModelConfig) -> dict[str, Any]:
    if not isinstance(mc, ModelConfig) or not isinstance(shared, ModelConfig):
        raise TypeError(
            f"_model_entry_dict expects ModelConfig instances, got "
            f"{type(mc).__name__} / {type(shared).__name__}"
        )
    d = mc.model_dump(mode="json", exclude_none=True)
    sd = shared.model_dump(mode="json", exclude_none=True)
    # Never persist Pydantic's reserved class-config key if it leaked as extra.
    d.pop("model_config", None)
    sd.pop("model_config", None)
    entry: dict[str, Any] = {}
    for k, v in d.items():
        if k == "vendor":
            continue
        if k in _CONNECTION_KEYS and sd.get(k) == v:
            continue
        entry[k] = v
    entry.setdefault("name", mc.name)
    entry.setdefault("model", mc.model)
    return entry


def unflatten_models_to_providers_dict(models: list[ModelConfig]) -> dict[str, Any]:
    """Serialize flat ``list[ModelConfig]`` to ``{ providers: { yaml_key: { vendor, ..., models: [...] } } }``."""
    from collections import defaultdict

    buckets: dict[tuple[str, str, str], list[ModelConfig]] = defaultdict(list)
    order: list[tuple[str, str, str]] = []
    for mc in models:
        k = _provider_bucket_key(mc)
        if k not in buckets:
            order.append(k)
        buckets[k].append(mc)

    used_keys: set[str] = set()
    providers: OrderedDict[str, Any] = OrderedDict()

    for k in order:
        group = buckets[k]
        first = group[0]
        vendor = (first.vendor or infer_vendor_from_connection(first.base_url, first.name) or "default").strip()
        yaml_key = _unique_provider_yaml_key(vendor, first.base_url, used_keys)
        used_keys.add(yaml_key)

        shell = {
            "vendor": vendor,
            "use": first.use,
            "base_url": first.base_url,
            "api_key": first.api_key,
        }
        if first.request_timeout is not None:
            shell["request_timeout"] = first.request_timeout
        if first.max_retries is not None:
            shell["max_retries"] = first.max_retries
        if first.temperature is not None:
            shell["temperature"] = first.temperature

        providers[yaml_key] = {
            **shell,
            "models": [_model_entry_dict(m, first) for m in group],
        }

    return {"providers": dict(providers)}


def coerce_models_field_for_appconfig(raw_models: Any) -> list[dict[str, Any]]:
    """Entry point for AppConfig root validator: normalize ``models`` key."""
    return _normalize_models_input(raw_models)
