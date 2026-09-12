"""Search Orchestrator — auto-select and combine search strategies.

Implements a tiered search strategy:
  - Tier 1 (fast): search APIs (Tavily / InfoQuest / Firecrawl / …)
  - Tier 2 (deep): Advanced — multi-source cache on top of search APIs
"""

from __future__ import annotations

import json
import logging
from collections.abc import Sequence

from .base import SearchEngine, SearchResults
from .registry import get_available_engines

logger = logging.getLogger(__name__)

# Default engine preference order: licensed API first, then deep
_DEFAULT_TIER_ORDER: list[str] = [
    "api",  # Licensed search APIs
    "web_search",  # Full tool path (RSS / 53AI / API)
    "advanced",  # Deep (licensed API + extract)
]


class SearchOrchestrator:
    """Unified search interface with automatic strategy selection.

    Usage::

        orch = SearchOrchestrator()
        results = orch.search("Python async best practices")
        print(results.to_json_dict())

        # Use specific engines
        results = orch.search("AI news", engines=["baidu", "ddg"])
    """

    def __init__(
        self,
        *,
        default_engines: list[str] | None = None,
        min_results_for_tier1: int = 3,
    ) -> None:
        self._default_engines = default_engines or list(_DEFAULT_TIER_ORDER)
        self._min_results = min_results_for_tier1
        self._engines: dict[str, SearchEngine] | None = None

    @property
    def engines(self) -> dict[str, SearchEngine]:
        if self._engines is None:
            self._engines = get_available_engines()
            logger.info(
                "Available search engines: %s",
                ", ".join(self._engines.keys()) or "(none)",
            )
        return self._engines

    def search(
        self,
        query: str,
        *,
        max_results: int = 5,
        engines: Sequence[str] | None = None,
    ) -> str | dict:
        """Execute search and return JSON string of results.

        Args:
            query: Search keywords or question.
            max_results: Maximum number of results to return.
            engines: Specific engine names to use. If None, uses auto-selection.

        Returns:
            JSON-formatted string with normalized results.
            Compatible with the existing web_search_tool output format.
        """
        if not query.strip():
            return self._error("Query cannot be empty")

        target_engines = engines or self._default_engines

        if isinstance(target_engines, (list, tuple)) and len(target_engines) == 1:
            # Single engine requested — direct call
            result = self._search_single(query, target_engines[0], max_results)
        elif engines is not None:
            # Specific multiple engines — try all, merge
            result = self._search_specific(query, list(target_engines), max_results)
        else:
            # Auto mode — tiered strategy
            result = self._search_auto(query, max_results)

        return result.to_json_dict()

    def _search_single(self, query: str, name: str, max_results: int) -> SearchResults:
        engine = self.engines.get(name)
        if engine is None:
            return SearchResults(query=query)
        return engine.search(query, max_results=max_results)

    def _search_specific(self, query: str, names: list[str], max_results: int) -> SearchResults:
        combined = SearchResults(query=query)
        for name in names:
            engine = self.engines.get(name)
            if engine is None:
                logger.debug("Engine '%s' not available, skipping", name)
                continue
            results = engine.search(query, max_results=max_results)
            combined = combined.merge(results)
        return combined

    def _search_auto(self, query: str, max_results: int) -> SearchResults:
        """Tiered auto-search: fast engines first, deep engines as fallback."""
        # Split available engines into tiers
        tier1_names = [n for n in self._default_engines if n in self.engines and self.engines[n].tier == 1]
        tier2_names = [n for n in self._default_engines if n in self.engines and self.engines[n].tier == 2]

        # Try Tier 1 (fast) first
        if tier1_names:
            tier1_result = self._search_specific(query, tier1_names, max_results)
            if tier1_result.is_good_enough(self._min_results):
                return tier1_result
            # Partial results — keep them, will merge with tier2
        else:
            tier1_result = SearchResults(query=query)

        # Fall back to Tier 2 (deep)
        if tier2_names:
            tier2_result = self._search_specific(query, tier2_names, max_results)
            return tier1_result.merge(tier2_result)

        return tier1_result

    @staticmethod
    def _error(message: str) -> str:
        return json.dumps(
            {
                "query": "",
                "total_results": 0,
                "results": [],
                "error": message,
            },
            ensure_ascii=False,
        )
