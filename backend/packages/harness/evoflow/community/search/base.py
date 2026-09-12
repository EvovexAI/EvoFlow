"""Base types for the unified search framework."""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class SearchResult:
    """Normalized single search result.

    Attributes:
        title: Result page title.
        url: Absolute URL to the source.
        snippet: Text excerpt / description.
        engine: Which engine produced this result.
        score: Relevance score (0-1, optional).
    """

    title: str = ""
    url: str = ""
    snippet: str = ""
    engine: str = "unknown"
    score: float = 1.0


@dataclass
class SearchResults:
    """Collection of results from one or more engines.

    Attributes:
        query: Original query string.
        results: Ordered list of results (best first).
        engines_used: Set of engine names that contributed.
        total_ms: Total wall-clock time in milliseconds.
    """

    query: str = ""
    results: list[SearchResult] = field(default_factory=list)
    engines_used: set[str] = field(default_factory=set)
    total_ms: float = 0.0

    def is_good_enough(self, min_results: int = 3) -> bool:
        return len(self.results) >= min_results

    def merge(self, other: SearchResults) -> SearchResults:
        """Merge another SearchResults, deduplicating by URL."""
        seen_urls = {r.url for r in self.results}
        new_results = [r for r in other.results if r.url not in seen_urls]
        return SearchResults(
            query=self.query,
            results=self.results + new_results,
            engines_used=self.engines_used | other.engines_used,
            total_ms=max(self.total_ms, other.total_ms),
        )

    def to_json_dict(self) -> dict:
        return {
            "query": self.query,
            "total_results": len(self.results),
            "engines": sorted(self.engines_used),
            "results": [
                {
                    "title": r.title,
                    "url": r.url,
                    "snippet": r.snippet,
                    "engine": r.engine,
                    "score": r.score,
                }
                for r in self.results
            ],
        }


class SearchEngine(ABC):
    """Abstract base class for search engine implementations."""

    @property
    @abstractmethod
    def name(self) -> str:
        """Human-readable engine name (e.g., 'baidu', 'ddg')."""

    @property
    def tier(self) -> int:
        """Speed/reliability tier: 1=fast (HTTP), 2=deep (browser)."""
        return 2  # default: slow/deep engine

    @abstractmethod
    def search(self, query: str, *, max_results: int = 5) -> SearchResults:
        """Execute search and return normalized results.

        Must NOT raise — return empty SearchResults on failure.
        """
        ...
