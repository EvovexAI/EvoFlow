"""Bocha / 博查 AI Web Search Hermes provider.

Official API (https://open.bochaai.com/)::

    POST https://api.bochaai.com/v1/web-search
    Authorization: Bearer <BOCHA_API_KEY>

Response is Bing-compatible ``webPages.value`` (optionally wrapped in ``{code,data}``).
"""

from __future__ import annotations

import logging
from typing import Any

from evoflow.community.web.provider import WebSearchProvider, get_provider_env

logger = logging.getLogger(__name__)

_DEFAULT_URL = "https://api.bochaai.com/v1/web-search"


def _resolve_api_key() -> str:
    for name in (
        "BOCHA_API_KEY",
        "BOCHA_SEARCH_API_KEY",
        "BOCHAAI_API_KEY",
    ):
        val = get_provider_env(name)
        if val:
            return val
    return ""


def _resolve_endpoint() -> str:
    for name in ("BOCHA_SEARCH_BASE_URL", "BOCHAAI_BASE_URL"):
        val = get_provider_env(name)
        if val:
            return val.rstrip("/")
    return _DEFAULT_URL


class BochaWebSearchProvider(WebSearchProvider):
    @property
    def name(self) -> str:
        return "bocha"

    @property
    def display_name(self) -> str:
        return "博查搜索"

    def is_available(self) -> bool:
        return bool(_resolve_api_key())

    def supports_search(self) -> bool:
        return True

    def search(self, query: str, limit: int = 5) -> dict[str, Any]:
        api_key = _resolve_api_key()
        if not api_key:
            return {
                "success": False,
                "error": (
                    "BOCHA_API_KEY not set. Create a key at https://open.bochaai.com/"
                ),
            }

        q = (query or "").strip()
        if not q:
            return {"success": False, "error": "query is empty"}

        count = max(1, min(int(limit or 5), 50))
        body: dict[str, Any] = {
            "query": q,
            "freshness": "noLimit",
            "summary": True,
            "count": count,
        }
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

        endpoint = _resolve_endpoint()
        logger.info("[博查搜索] 请求 query=%r count=%s endpoint=%s", q, count, endpoint)
        try:
            import httpx

            resp = httpx.post(endpoint, headers=headers, json=body, timeout=30)
            resp.raise_for_status()
            data = resp.json()
        except Exception as e:
            logger.warning("[博查搜索] HTTP失败 err=%s", e)
            return {"success": False, "error": f"Bocha search failed: {e}"}

        if not isinstance(data, dict):
            return {"success": False, "error": "Bocha search returned non-object JSON"}

        # Wrapped: {code, msg/message, data} — success codes commonly 200 / 0
        code = data.get("code")
        if code is not None and str(code) not in {"200", "0", "success", "Success"}:
            msg = data.get("msg") or data.get("message") or data.get("error") or code
            logger.warning("[博查搜索] 业务错误 code=%s msg=%s", code, msg)
            return {"success": False, "error": f"Bocha search error {code}: {msg}"}

        payload = data.get("data") if isinstance(data.get("data"), dict) else data
        if not isinstance(payload, dict):
            payload = {}

        web_pages = payload.get("webPages") or payload.get("WebPages") or {}
        if not isinstance(web_pages, dict):
            web_pages = {}
        values = web_pages.get("value") or web_pages.get("Value") or []
        if not isinstance(values, list):
            values = []

        web: list[dict[str, Any]] = []
        for i, item in enumerate(values):
            if not isinstance(item, dict):
                continue
            title = str(item.get("name") or item.get("title") or item.get("Name") or "").strip()
            url = str(item.get("url") or item.get("URL") or item.get("Url") or "").strip()
            if not url:
                continue
            summary = str(
                item.get("summary")
                or item.get("Summary")
                or item.get("snippet")
                or item.get("Snippet")
                or ""
            ).strip()
            site = str(item.get("siteName") or item.get("SiteName") or "").strip()
            published = str(
                item.get("datePublished") or item.get("DatePublished") or item.get("dateLastCrawled") or ""
            ).strip()
            meta = " | ".join(p for p in (site, published) if p)
            description = f"{meta}\n{summary}".strip() if meta else summary
            web.append(
                {
                    "title": title or url,
                    "url": url,
                    "description": description,
                    "position": i + 1,
                }
            )

        logger.info("[博查搜索] 返回条数=%s", len(web))
        return {"success": True, "data": {"web": web}}
