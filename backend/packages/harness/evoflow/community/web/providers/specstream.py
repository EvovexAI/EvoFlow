"""SpecStream search provider (Search API, requires SPECSTREAM_API_KEY)."""

from __future__ import annotations

import logging
from typing import Any

from evoflow.community.web.provider import WebSearchProvider, get_provider_env

logger = logging.getLogger(__name__)

_SPECSTREAM_SEARCH_ENDPOINT = "https://api.specstream.ai/v1/web-search"


class SpecStreamWebSearchProvider(WebSearchProvider):
    @property
    def name(self) -> str:
        return "specstream"

    @property
    def display_name(self) -> str:
        return "SpecStream"

    def is_available(self) -> bool:
        return bool(get_provider_env("SPECSTREAM_API_KEY"))

    def supports_search(self) -> bool:
        return True

    def supports_extract(self) -> bool:
        return False

    def search(self, query: str, limit: int = 5) -> dict[str, Any]:
        api_key = get_provider_env("SPECSTREAM_API_KEY")
        if not api_key:
            return {
                "success": False,
                "error": "SPECSTREAM_API_KEY environment variable not set. Create a key at https://specstream.ai/signup?src=evoflow",
            }
        count = max(1, min(int(limit), 20))
        try:
            import httpx

            # speed=fast returns the ranked results with their snippets and no generated answer.
            resp = httpx.get(
                _SPECSTREAM_SEARCH_ENDPOINT,
                params={"q": query, "num": count, "speed": "fast"},
                headers={"Authorization": f"Bearer {api_key}"},
                timeout=30,
            )
            resp.raise_for_status()
            payload = resp.json()
        except Exception as e:
            logger.warning("SpecStream search failed: %s", e)
            return {"success": False, "error": f"SpecStream search failed: {e}"}

        web = []
        for r in (payload.get("data") or {}).get("sources") or []:
            url = str(r.get("url") or "")
            if not url:
                continue
            web.append(
                {
                    "title": str(r.get("title") or ""),
                    "url": url,
                    "description": str(r.get("snippet") or ""),
                    "position": len(web) + 1,
                }
            )
            if len(web) >= count:
                break
        return {"success": True, "data": {"web": web}}
