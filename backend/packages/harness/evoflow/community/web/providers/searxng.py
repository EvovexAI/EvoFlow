"""SearXNG self-hosted search provider (Hermes-compatible)."""

from __future__ import annotations

import logging
from typing import Any

from evoflow.community.web.provider import WebSearchProvider, get_provider_env

logger = logging.getLogger(__name__)


class SearXNGWebSearchProvider(WebSearchProvider):
    @property
    def name(self) -> str:
        return "searxng"

    @property
    def display_name(self) -> str:
        return "SearXNG"

    def is_available(self) -> bool:
        return bool(get_provider_env("SEARXNG_URL"))

    def supports_search(self) -> bool:
        return True

    def supports_extract(self) -> bool:
        return False

    def search(self, query: str, limit: int = 5) -> dict[str, Any]:
        import httpx

        base = get_provider_env("SEARXNG_URL").rstrip("/")
        if not base:
            return {"success": False, "error": "SEARXNG_URL is not set"}

        try:
            resp = httpx.get(
                f"{base}/search",
                params={"q": query, "format": "json", "pageno": 1},
                timeout=15,
                headers={"Accept": "application/json"},
            )
            resp.raise_for_status()
            payload = resp.json()
        except Exception as e:
            logger.warning("SearXNG search failed: %s", e)
            return {"success": False, "error": f"SearXNG search failed: {e}"}

        web = []
        for i, r in enumerate(payload.get("results") or []):
            if i >= max(1, int(limit)):
                break
            web.append(
                {
                    "title": r.get("title", "") or "",
                    "url": r.get("url", "") or "",
                    "description": r.get("content", "") or r.get("description", "") or "",
                    "position": i + 1,
                }
            )
        return {"success": True, "data": {"web": web}}
