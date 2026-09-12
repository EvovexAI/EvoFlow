"""Central registry for Hermes-style web search providers."""

from __future__ import annotations

import logging
import threading
from typing import Optional

from .provider import WebSearchProvider

logger = logging.getLogger(__name__)

_providers: dict[str, WebSearchProvider] = {}
_lock = threading.RLock()  # reentrant: ensure_providers_loaded → register_provider
_loaded = False

# Hermes auto-detect order when settings preferredBackend is empty.
# Paid engines still win when set in EvoPanel Settings → 联网搜索 (SQLite).
_AUTO_PREFERENCE: list[str] = [
    "ddgs",
    "searxng",
    "brave-free",
    "doubao",
    "bocha",
    "tavily",
    "infoquest",
    "firecrawl",
]


def register_provider(provider: WebSearchProvider) -> None:
    if not isinstance(provider, WebSearchProvider):
        raise TypeError(f"expected WebSearchProvider, got {type(provider).__name__}")
    name = provider.name
    if not isinstance(name, str) or not name.strip():
        raise ValueError("Web provider .name must be a non-empty string")
    with _lock:
        _providers[name.strip()] = provider
    logger.debug("Registered web provider '%s'", name)


def list_providers() -> list[WebSearchProvider]:
    ensure_providers_loaded()
    with _lock:
        items = list(_providers.values())
    return sorted(items, key=lambda p: p.name)


def get_provider(name: str) -> Optional[WebSearchProvider]:
    ensure_providers_loaded()
    if not isinstance(name, str):
        return None
    with _lock:
        return _providers.get(name.strip())


def _read_web_config() -> dict:
    try:
        from evoflow.config import get_app_config

        cfg = get_app_config()
        web = getattr(cfg, "web", None)
        if web is None:
            # extra="allow" fallback
            extra = getattr(cfg, "model_extra", None) or {}
            raw = extra.get("web") if isinstance(extra, dict) else None
            return dict(raw) if isinstance(raw, dict) else {}
        if hasattr(web, "model_dump"):
            return web.model_dump()
        if isinstance(web, dict):
            return web
    except Exception as e:
        logger.debug("Could not read web config: %s", e)
    return {}


def resolve_search_backend() -> str | None:
    """Resolve active search backend name.

    Order:
    1. EvoPanel SQLite ``web.search.preferredBackend`` (settings table only)
    2. Auto-detect from available providers

    ``config.yaml`` ``web.backend`` / ``tools.web_search.provider`` are **not** used
    for search preference — configure via Settings → 联网搜索.
    """
    ensure_providers_loaded()

    try:
        from evoflow.persistence.web_search_settings import get_preferred_backend

        preferred = get_preferred_backend()
        if preferred:
            return preferred
    except Exception as e:
        logger.debug("Could not read web.search preferredBackend: %s", e)

    # Auto-detect: first available in preference order
    for name in _AUTO_PREFERENCE:
        prov = get_provider(name)
        if prov is not None and prov.supports_search() and prov.is_available():
            return name

    # Any other registered available search provider
    for prov in list_providers():
        if prov.supports_search() and prov.is_available() and prov.name not in _AUTO_PREFERENCE:
            return prov.name
    return None


def get_active_search_provider() -> Optional[WebSearchProvider]:
    """Return the provider that should handle web_search."""
    ensure_providers_loaded()
    name = resolve_search_backend()
    if name:
        prov = get_provider(name)
        if prov is not None and prov.supports_search():
            # Explicit config wins even if not available (clearer error downstream)
            return prov

    # Fallback: first available search-capable provider
    for name in _AUTO_PREFERENCE:
        prov = get_provider(name)
        if prov is not None and prov.supports_search() and prov.is_available():
            return prov
    for prov in list_providers():
        if prov.supports_search() and prov.is_available():
            return prov
    return None


def run_provider_search(name: str, query: str, *, limit: int = 5) -> dict:
    """Canonical single-provider search used by ``web_search`` tool AND settings test.

    Both the agent tool path and ``settings.test_web_search`` / Gateway test must
    call this — never re-implement HTTP against Doubao/Tavily/etc. in admin/UI.
    """
    from typing import Any

    ensure_providers_loaded()
    try:
        from evoflow.persistence.runtime_env import apply_runtime_env_to_environ

        apply_runtime_env_to_environ()
    except Exception:
        pass

    n = str(name or "").strip().lower()
    if n in {"ddg", "duckduckgo"}:
        n = "ddgs"
    if not n:
        return {"success": False, "error": "provider name is empty"}

    prov = get_provider(n)
    if prov is None:
        return {"success": False, "error": f"unknown provider: {n}"}
    if not prov.supports_search():
        return {"success": False, "error": f"provider {n} does not support search"}

    q = (query or "").strip()
    if not q:
        return {"success": False, "error": "query is empty"}

    lim = max(1, min(int(limit or 5), 20))
    try:
        raw: Any = prov.search(q, limit=lim)
    except Exception as exc:
        logger.warning("provider search failed name=%s err=%s", n, exc)
        return {"success": False, "error": str(exc)}

    if not isinstance(raw, dict):
        return {"success": False, "error": f"{n} returned non-dict"}
    # Normalize legacy ``ok`` key if any provider still emits it.
    if "success" not in raw and "ok" in raw:
        raw = {**raw, "success": bool(raw.get("ok"))}
    return raw


def ensure_providers_loaded() -> None:
    global _loaded
    if _loaded:
        return
    with _lock:
        if _loaded:
            return
        try:
            from . import providers as _providers_pkg  # noqa: F401

            _providers_pkg.register_all()
        except Exception as e:
            logger.warning("Failed to load web providers: %s", e)
        _loaded = True


def reset_providers_for_tests() -> None:
    """Test helper: clear registry and reload flag."""
    global _loaded
    with _lock:
        _providers.clear()
        _loaded = False
