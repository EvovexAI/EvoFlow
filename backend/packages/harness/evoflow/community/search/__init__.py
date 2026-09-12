"""Unified Search Interface — Strategy Pattern for multi-engine web search.

Provides a consistent API across search backends (Tavily / InfoQuest /
Firecrawl / DDGS / …) plus the full web_search tool path.

Usage::

    from evoflow.community.search import SearchOrchestrator
    orch = SearchOrchestrator()
    results = orch.search("Python async best practices")
"""

from .base import SearchEngine, SearchResult
from .orchestrator import SearchOrchestrator

# Import strategies so engines register themselves on package load.
from . import strategies as _strategies  # noqa: F401

__all__ = [
    "SearchOrchestrator",
    "SearchResult",
    "SearchEngine",
]
