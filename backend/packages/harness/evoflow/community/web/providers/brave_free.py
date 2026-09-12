"""Brave Search free-tier provider (Hermes-compatible)."""

from __future__ import annotations

import logging
from typing import Any

from evoflow.community.web.provider import WebSearchProvider, get_provider_env

logger = logging.getLogger(__name__)

_BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search"


class BraveFreeWebSearchProvider(WebSearchProvider):
    @property
    def name(self) -> str:
        return "brave-free"

    @property
    def display_name(self) -> str:
        return "Brave Search (Free)"

    def is_available(self) -> bool:
        return bool(get_provider_env("BRAVE_SEARCH_API_KEY"))

    def supports_search(self) -> bool:
        return True

    def supports_extract(self) -> bool:
        return False

    def search(self, query: str, limit: int = 5) -> dict[str, Any]:
        import httpx

        api_key = get_provider_env("BRAVE_SEARCH_API_KEY")
        if not api_key:
            return {"success": False, "error": "BRAVE_SEARCH_API_KEY is not set"}

        count = max(1, min(int(limit), 20))
        try:
            resp = httpx.get(
                _BRAVE_ENDPOINT,
                params={"q": query, "count": count},
                headers={
                    "X-Subscription-Token": api_key,
                    "Accept": "application/json",
                },
                timeout=15,
            )
            resp.raise_for_status()
            payload = resp.json()
        except Exception as e:
            logger.warning("Brave Search failed: %s", e)
            return {"success": False, "error": f"Brave Search failed: {e}"}

        web = []
        for i, r in enumerate((payload.get("web") or {}).get("results") or []):
            if i >= count:
                break
            web.append(
                {
                    "title": r.get("title", "") or "",
                    "url": r.get("url", "") or "",
                    "description": r.get("description", "") or "",
                    "position": i + 1,
                }
            )
        return {"success": True, "data": {"web": web}}
