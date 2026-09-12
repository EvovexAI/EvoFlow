"""DuckDuckGo (ddgs) free search provider — Hermes default no-key fallback."""

from __future__ import annotations

import concurrent.futures
import logging
from typing import Any

from evoflow.community.web.provider import WebSearchProvider

logger = logging.getLogger(__name__)

_SEARCH_TIMEOUT_SECS = 45


def _run_ddgs_search(query: str, safe_limit: int) -> list[dict[str, Any]]:
    from ddgs import DDGS

    # Prefer ``auto``; fall back to ``bing`` when DDG HTML is blocked (common in CN).
    last_err: Exception | None = None
    for backend in ("auto", "bing"):
        try:
            results: list[dict[str, Any]] = []
            with DDGS(timeout=15) as client:
                for i, hit in enumerate(
                    client.text(query, max_results=safe_limit, backend=backend)
                ):
                    if i >= safe_limit:
                        break
                    url = str(hit.get("href") or hit.get("url") or "")
                    results.append(
                        {
                            "title": str(hit.get("title", "")),
                            "url": url,
                            "description": str(hit.get("body", "")),
                            "position": i + 1,
                        }
                    )
            if results:
                return results
        except Exception as e:
            last_err = e
            logger.info("ddgs backend=%s failed: %s", backend, e)
            continue
    if last_err is not None:
        raise last_err
    return []


class DDGSWebSearchProvider(WebSearchProvider):
    @property
    def name(self) -> str:
        return "ddgs"

    @property
    def display_name(self) -> str:
        return "DuckDuckGo (ddgs)"

    def is_available(self) -> bool:
        try:
            import ddgs  # noqa: F401

            return True
        except ImportError:
            return False

    def supports_search(self) -> bool:
        return True

    def supports_extract(self) -> bool:
        return False

    def search(self, query: str, limit: int = 5) -> dict[str, Any]:
        safe_limit = max(1, min(int(limit), 20))
        try:
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                fut = pool.submit(_run_ddgs_search, query, safe_limit)
                web = fut.result(timeout=_SEARCH_TIMEOUT_SECS)
            if not web:
                return {"success": False, "error": "ddgs returned no results"}
            return {"success": True, "data": {"web": web}}
        except concurrent.futures.TimeoutError:
            return {"success": False, "error": f"ddgs search timed out after {_SEARCH_TIMEOUT_SECS}s"}
        except Exception as e:
            logger.warning("ddgs search failed: %s", e)
            return {"success": False, "error": f"ddgs search failed: {e}"}
