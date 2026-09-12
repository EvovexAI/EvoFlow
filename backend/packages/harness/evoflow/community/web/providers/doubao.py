"""Doubao Search / 豆包搜索 (Volcengine SearchInfinity) Hermes provider.

China endpoint used by Byted ``byted-web-search`` / nanobot::

    POST https://open.feedcoopapi.com/search_api/web_search
    Authorization: Bearer <DOUBAO_SEARCH_API_KEY>

Create keys at https://console.volcengine.com/search-infinity/web-search-exp
(Ark API keys do **not** work here.)
"""

from __future__ import annotations

import logging
from typing import Any

from evoflow.community.web.provider import WebSearchProvider, get_provider_env

logger = logging.getLogger(__name__)

_DEFAULT_URL = "https://open.feedcoopapi.com/search_api/web_search"
_TRAFFIC_TAG = "evoflow"


def _resolve_api_key() -> str:
    for name in (
        "DOUBAO_SEARCH_API_KEY",
        "VOLCENGINE_SEARCH_API_KEY",
        "WEB_SEARCH_API_KEY",
    ):
        val = get_provider_env(name)
        if val:
            return val
    return ""


def _resolve_endpoint() -> str:
    for name in ("DOUBAO_SEARCH_BASE_URL", "VOLCENGINE_SEARCH_BASE_URL"):
        val = get_provider_env(name)
        if val:
            return val.rstrip("/")
    return _DEFAULT_URL


class DoubaoWebSearchProvider(WebSearchProvider):
    @property
    def name(self) -> str:
        return "doubao"

    @property
    def display_name(self) -> str:
        return "豆包搜索"

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
                    "DOUBAO_SEARCH_API_KEY not set. Create a key at "
                    "https://console.volcengine.com/search-infinity/web-search-exp "
                    "(not an Ark API key)."
                ),
            }

        q = (query or "").strip()
        if not q:
            return {"success": False, "error": "query is empty"}
        # API docs: query length typically 1–100
        if len(q) > 100:
            q = q[:100]

        count = max(1, min(int(limit or 5), 20))
        body: dict[str, Any] = {
            "Query": q,
            "SearchType": "web",
            "Count": count,
            "NeedSummary": True,
        }

        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "X-Traffic-Tag": _TRAFFIC_TAG,
        }

        logger.info("[豆包搜索] 请求 query=%r count=%s endpoint=%s", q, count, _resolve_endpoint())
        try:
            import httpx

            resp = httpx.post(
                _resolve_endpoint(),
                headers=headers,
                json=body,
                timeout=30,
            )
            resp.raise_for_status()
            data = resp.json()
        except Exception as e:
            logger.warning("[豆包搜索] HTTP失败 err=%s", e)
            return {"success": False, "error": f"Doubao search failed: {e}"}

        err = (data.get("ResponseMetadata") or {}).get("Error") if isinstance(data, dict) else None
        if not err and isinstance(data, dict):
            err = data.get("Error") or data.get("error")
        if err:
            if isinstance(err, dict):
                code = err.get("Code") or err.get("code") or "unknown"
                message = err.get("Message") or err.get("message") or err
                logger.warning("[豆包搜索] 业务错误 code=%s msg=%s", code, message)
                return {"success": False, "error": f"Doubao search error {code}: {message}"}
            logger.warning("[豆包搜索] 业务错误 err=%s", err)
            return {"success": False, "error": f"Doubao search error: {err}"}

        result = (data.get("Result") if isinstance(data, dict) else None) or data or {}
        if not isinstance(result, dict):
            result = {}
        web_results = (
            result.get("WebResults")
            or result.get("webResults")
            or result.get("results")
            or []
        )
        if not isinstance(web_results, list):
            web_results = []

        web: list[dict[str, Any]] = []
        for i, item in enumerate(web_results):
            if not isinstance(item, dict):
                continue
            title = str(item.get("Title") or item.get("title") or "").strip()
            url = str(item.get("Url") or item.get("URL") or item.get("url") or "").strip()
            if not url:
                continue
            summary = str(
                item.get("Summary")
                or item.get("summary")
                or item.get("Snippet")
                or item.get("snippet")
                or item.get("Content")
                or item.get("content")
                or ""
            ).strip()
            site = str(item.get("SiteName") or item.get("siteName") or "").strip()
            published = str(item.get("PublishTime") or item.get("publishTime") or "").strip()
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

        logger.info("[豆包搜索] 返回条数=%s", len(web))
        return {"success": True, "data": {"web": web}}
