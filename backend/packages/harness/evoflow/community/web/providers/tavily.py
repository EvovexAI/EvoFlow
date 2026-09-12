"""Tavily search provider (Hermes-compatible)."""

from __future__ import annotations

import logging
from typing import Any

from evoflow.community.web.provider import WebSearchProvider, get_provider_env

logger = logging.getLogger(__name__)


class TavilyWebSearchProvider(WebSearchProvider):
    @property
    def name(self) -> str:
        return "tavily"

    @property
    def display_name(self) -> str:
        return "Tavily"

    def is_available(self) -> bool:
        return bool(get_provider_env("TAVILY_API_KEY"))

    def supports_search(self) -> bool:
        return True

    def supports_extract(self) -> bool:
        return True

    def search(self, query: str, limit: int = 5) -> dict[str, Any]:
        api_key = get_provider_env("TAVILY_API_KEY")
        if not api_key:
            return {
                "success": False,
                "error": "TAVILY_API_KEY environment variable not set. Get a key at https://app.tavily.com/home",
            }
        try:
            import httpx

            base = get_provider_env("TAVILY_BASE_URL") or "https://api.tavily.com"
            resp = httpx.post(
                f"{base.rstrip('/')}/search",
                json={
                    "api_key": api_key,
                    "query": query,
                    "max_results": max(1, min(int(limit), 20)),
                },
                timeout=60,
            )
            resp.raise_for_status()
            data = resp.json()
        except Exception as e:
            logger.warning("Tavily search failed: %s", e)
            return {"success": False, "error": f"Tavily search failed: {e}"}

        web = []
        for i, r in enumerate(data.get("results") or []):
            web.append(
                {
                    "title": r.get("title", "") or "",
                    "url": r.get("url", "") or "",
                    "description": r.get("content", "") or "",
                    "position": i + 1,
                }
            )
        return {"success": True, "data": {"web": web}}
