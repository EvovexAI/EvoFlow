"""Keenable search provider (keyless public endpoint, optional API key)."""

from __future__ import annotations

import logging
from typing import Any

from evoflow.community.web.provider import WebSearchProvider, get_provider_env

logger = logging.getLogger(__name__)

_KEENABLE_PUBLIC_ENDPOINT = "https://api.keenable.ai/v1/search/public"
_KEENABLE_KEYED_ENDPOINT = "https://api.keenable.ai/v1/search"
# Keenable's ``snippet`` can hold a whole page; keep descriptions short.
_MAX_DESCRIPTION_CHARS = 1000


def _description(result: dict[str, Any]) -> str:
    text = str(result.get("description") or "").strip() or str(result.get("snippet") or "").strip()
    if len(text) > _MAX_DESCRIPTION_CHARS:
        text = text[:_MAX_DESCRIPTION_CHARS].rstrip() + "…"
    return text


class KeenableWebSearchProvider(WebSearchProvider):
    @property
    def name(self) -> str:
        return "keenable"

    @property
    def display_name(self) -> str:
        return "Keenable"

    def is_available(self) -> bool:
        # Works without a key via the public endpoint.
        return True

    def supports_search(self) -> bool:
        return True

    def supports_extract(self) -> bool:
        return False

    def search(self, query: str, limit: int = 5) -> dict[str, Any]:
        import httpx

        api_key = get_provider_env("KEENABLE_API_KEY")
        headers = {"Content-Type": "application/json", "X-Keenable-Title": "EvoFlow"}
        if api_key:
            headers["X-API-Key"] = api_key
        endpoint = _KEENABLE_KEYED_ENDPOINT if api_key else _KEENABLE_PUBLIC_ENDPOINT
        count = max(1, min(int(limit), 20))
        try:
            resp = httpx.post(
                endpoint,
                json={"query": query, "max_results": count},
                headers=headers,
                timeout=15,
            )
            resp.raise_for_status()
            payload = resp.json()
        except Exception as e:
            logger.warning("Keenable search failed: %s", e)
            return {"success": False, "error": f"Keenable search failed: {e}"}

        web = []
        for r in payload.get("results") or []:
            url = str(r.get("url") or "")
            if not url:
                continue
            web.append(
                {
                    "title": str(r.get("title") or ""),
                    "url": url,
                    "description": _description(r),
                    "position": len(web) + 1,
                }
            )
            if len(web) >= count:
                break
        return {"success": True, "data": {"web": web}}
