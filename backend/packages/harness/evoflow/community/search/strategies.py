"""Strategy adapters for individual search backends."""

from __future__ import annotations

import json
import logging
import time

from .base import SearchEngine, SearchResult, SearchResults
from .registry import register

logger = logging.getLogger(__name__)


# ─── Licensed API Adapter ─────────────────────────────────────────


class _HermesProviderEngine(SearchEngine):
    """Hermes-style pluggable web providers (tavily/ddgs/…)."""

    @property
    def name(self) -> str:
        return "api"

    @property
    def tier(self) -> int:
        return 1

    def search(self, query: str, *, max_results: int = 5) -> SearchResults:
        t0 = time.monotonic()
        try:
            from evoflow.community.baidu_search.tools import _api_licensed_search

            raw = _api_licensed_search(query, max_results=max_results)
            results = [
                SearchResult(
                    title=r.get("title", ""),
                    url=r.get("href", r.get("url", "")),
                    snippet=r.get("body", r.get("snippet", "")),
                    engine=str(r.get("_engine") or "api"),
                )
                for r in raw
            ]
            engines_used = {str(r.get("_engine") or "api") for r in raw} or set()
            elapsed_ms = (time.monotonic() - t0) * 1000
            return SearchResults(
                query=query,
                results=results[:max_results],
                engines_used=engines_used,
                total_ms=elapsed_ms,
            )
        except Exception as e:
            elapsed_ms = (time.monotonic() - t0) * 1000
            logger.debug("Hermes provider search failed: %s", e)
            return SearchResults(
                query=query,
                results=[],
                engines_used=set(),
                total_ms=elapsed_ms,
            )


def _make_api() -> SearchEngine | None:
    try:
        from evoflow.community.web.registry import get_active_search_provider  # noqa: F401

        return _HermesProviderEngine()
    except ImportError:
        return None


register("api", _make_api)
register("tavily", _make_api)
register("ddgs", _make_api)


# ─── Web search tool wrapper (AI-daily / 53AI / API) ───────────────


class _WebSearchToolEngine(SearchEngine):
    """Full web_search_tool path (RSS / 53AI / licensed API)."""

    @property
    def name(self) -> str:
        return "web_search"

    @property
    def tier(self) -> int:
        return 1

    def search(self, query: str, *, max_results: int = 5) -> SearchResults:
        t0 = time.monotonic()
        try:
            from evoflow.community.baidu_search.tools import web_search_tool

            raw = web_search_tool(query, max_results=max_results)
            data = json.loads(raw) if isinstance(raw, str) else raw
            results = [
                SearchResult(
                    title=r.get("title", ""),
                    url=r.get("href", r.get("url", "")),
                    snippet=r.get("body", r.get("snippet", r.get("content", ""))),
                    engine=str(r.get("_engine") or "web_search"),
                )
                for r in data.get("results", data.get("data", []))
            ]
            elapsed_ms = (time.monotonic() - t0) * 1000
            return SearchResults(
                query=query,
                results=results[:max_results],
                engines_used={"web_search"} if results else set(),
                total_ms=elapsed_ms,
            )
        except Exception as e:
            elapsed_ms = (time.monotonic() - t0) * 1000
            logger.debug("web_search tool engine failed: %s", e)
            return SearchResults(
                query=query,
                results=[],
                engines_used=set(),
                total_ms=elapsed_ms,
            )


def _make_web_search() -> SearchEngine | None:
    try:
        from evoflow.community.baidu_search import web_search_tool  # noqa: F401

        return _WebSearchToolEngine()
    except ImportError:
        return None


register("web_search", _make_web_search)


# ─── Advanced Deep-Search Adapter ─────────────────────────────────


class _AdvancedEngine(SearchEngine):
    """Advanced deep-search (licensed API + optional page extract)."""

    @property
    def name(self) -> str:
        return "advanced"

    @property
    def tier(self) -> int:
        return 2

    def search(self, query: str, *, max_results: int = 5) -> SearchResults:
        t0 = time.monotonic()
        try:
            from evoflow.community.advanced_search import fast_search_v2

            result = fast_search_v2(query, max_results=max_results)
            if hasattr(result, "results"):
                items = result.results
            elif isinstance(result, list):
                items = result
            else:
                items = []
            results = []
            for r in items:
                if isinstance(r, dict):
                    results.append(
                        SearchResult(
                            title=r.get("title", ""),
                            url=r.get("url", r.get("href", "")),
                            snippet=r.get("snippet", r.get("content", "")),
                            engine="advanced",
                        )
                    )
                elif hasattr(r, "title"):
                    results.append(
                        SearchResult(
                            title=getattr(r, "title", ""),
                            url=getattr(r, "url", getattr(r, "href", "")),
                            snippet=getattr(r, "snippet", getattr(r, "content", "")),
                            engine="advanced",
                        )
                    )
            elapsed_ms = (time.monotonic() - t0) * 1000
            return SearchResults(
                query=query,
                results=results[:max_results],
                engines_used={"advanced"} if results else set(),
                total_ms=elapsed_ms,
            )
        except Exception as e:
            elapsed_ms = (time.monotonic() - t0) * 1000
            logger.debug("Advanced search failed: %s", e)
            return SearchResults(
                query=query,
                results=[],
                engines_used=set(),
                total_ms=elapsed_ms,
            )


def _make_advanced() -> SearchEngine | None:
    try:
        from evoflow.community.advanced_search import fast_search_v2  # noqa: F401

        return _AdvancedEngine()
    except ImportError:
        return None


register("advanced", _make_advanced)
