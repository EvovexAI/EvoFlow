"""Web Search Provider ABC — Hermes-compatible contract.

Search results::

    {
        "success": True,
        "data": {
            "web": [
                {"title": str, "url": str, "description": str, "position": int},
                ...
            ]
        }
    }

On failure::

    {"success": False, "error": str}
"""

from __future__ import annotations

import abc
import os
from typing import Any


def get_provider_env(name: str) -> str:
    """Resolve env var; falls back to Settings → 联网搜索 (SQLite) and tools.web_search.api_key."""
    val = (os.getenv(name) or "").strip()
    if _looks_like_placeholder(val):
        val = ""
    if val:
        return val

    # EvoPanel Settings → 联网搜索 (evoflow_app_settings key web.search)
    try:
        from evoflow.persistence.web_search_settings import get_web_search_settings

        settings = get_web_search_settings()
        field_by_env = {
            "DOUBAO_SEARCH_API_KEY": "doubaoApiKey",
            "VOLCENGINE_SEARCH_API_KEY": "doubaoApiKey",
            "DOUBAO_SEARCH_BASE_URL": "doubaoBaseUrl",
            "BOCHA_API_KEY": "bochaApiKey",
            "BOCHA_SEARCH_API_KEY": "bochaApiKey",
            "BOCHAAI_API_KEY": "bochaApiKey",
            "BOCHA_SEARCH_BASE_URL": "bochaBaseUrl",
            "BOCHAAI_BASE_URL": "bochaBaseUrl",
            "TAVILY_API_KEY": "tavilyApiKey",
            "TAVILY_BASE_URL": "tavilyBaseUrl",
            "BRAVE_SEARCH_API_KEY": "braveApiKey",
            "FIRECRAWL_API_KEY": "firecrawlApiKey",
            "FIRECRAWL_API_URL": "firecrawlApiUrl",
            "INFOQUEST_API_KEY": "infoquestApiKey",
            "SEARXNG_URL": "searxngUrl",
        }
        field = field_by_env.get(name)
        if field:
            s = str(settings.get(field) or "").strip()
            if s and not _looks_like_placeholder(s):
                return s
    except Exception:
        pass

    # Optional: config.yaml tools.web_search.api_key as shared key for tavily/firecrawl
    if name in {"TAVILY_API_KEY", "FIRECRAWL_API_KEY"}:
        try:
            from evoflow.config import get_app_config

            cfg = get_app_config().get_tool_config("web_search")
            if cfg is not None and cfg.model_extra:
                key = str(cfg.model_extra.get("api_key") or "").strip()
                if key and not _looks_like_placeholder(key):
                    return key
        except Exception:
            pass
    return ""


_PLACEHOLDER_MARKERS = (
    "your-",
    "xxx",
    "placeholder",
    "example",
    "changeme",
    "todo",
    "replace",
)


def _looks_like_placeholder(value: str) -> bool:
    v = (value or "").strip().lower()
    if not v:
        return True
    return any(m in v for m in _PLACEHOLDER_MARKERS)

class WebSearchProvider(abc.ABC):
    """Pluggable backend for web_search (and optionally extract)."""

    @property
    @abc.abstractmethod
    def name(self) -> str:
        """Stable id used in ``web.search_backend`` / ``web.backend``."""

    @property
    def display_name(self) -> str:
        return self.name

    @abc.abstractmethod
    def is_available(self) -> bool:
        """Cheap check (env/dep present). Must not perform network I/O."""

    def supports_search(self) -> bool:
        return True

    def supports_extract(self) -> bool:
        return False

    def search(self, query: str, limit: int = 5) -> dict[str, Any]:
        return {"success": False, "error": f"{self.name} does not support search"}

    def extract(self, urls: list[str], **kwargs: Any) -> Any:
        return {"success": False, "error": f"{self.name} does not support extract"}
