"""Firecrawl search provider (Hermes-compatible, simplified)."""

from __future__ import annotations

import logging
from typing import Any

from evoflow.community.web.provider import WebSearchProvider, get_provider_env

logger = logging.getLogger(__name__)


class FirecrawlWebSearchProvider(WebSearchProvider):
    @property
    def name(self) -> str:
        return "firecrawl"

    @property
    def display_name(self) -> str:
        return "Firecrawl"

    def is_available(self) -> bool:
        return bool(get_provider_env("FIRECRAWL_API_KEY") or get_provider_env("FIRECRAWL_API_URL"))

    def supports_search(self) -> bool:
        return True

    def supports_extract(self) -> bool:
        return True

    def search(self, query: str, limit: int = 5) -> dict[str, Any]:
        api_key = get_provider_env("FIRECRAWL_API_KEY") or None
        api_url = get_provider_env("FIRECRAWL_API_URL") or None
        if not api_key and not api_url:
            return {
                "success": False,
                "error": "FIRECRAWL_API_KEY (or FIRECRAWL_API_URL) is not set",
            }
        try:
            from firecrawl import FirecrawlApp

            kwargs: dict[str, Any] = {}
            if api_key:
                kwargs["api_key"] = api_key
            if api_url:
                kwargs["api_url"] = api_url.rstrip("/")
            client = FirecrawlApp(**kwargs)
            result = client.search(query, limit=max(1, min(int(limit), 20)))
            items = getattr(result, "web", None) or []
        except Exception as e:
            logger.warning("Firecrawl search failed: %s", e)
            return {"success": False, "error": f"Firecrawl search failed: {e}"}

        web = []
        for i, item in enumerate(items):
            if isinstance(item, dict):
                title = item.get("title", "") or ""
                url = item.get("url", "") or ""
                desc = item.get("description", "") or item.get("snippet", "") or ""
            else:
                title = getattr(item, "title", "") or ""
                url = getattr(item, "url", "") or ""
                desc = getattr(item, "description", "") or ""
            web.append({"title": title, "url": url, "description": desc, "position": i + 1})
        return {"success": True, "data": {"web": web}}
