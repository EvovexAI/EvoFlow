"""Built-in Hermes-style web search providers."""

from __future__ import annotations

from evoflow.community.web.registry import register_provider

from .bocha import BochaWebSearchProvider
from .brave_free import BraveFreeWebSearchProvider
from .ddgs import DDGSWebSearchProvider
from .doubao import DoubaoWebSearchProvider
from .firecrawl import FirecrawlWebSearchProvider
from .infoquest import InfoQuestWebSearchProvider
from .searxng import SearXNGWebSearchProvider
from .tavily import TavilyWebSearchProvider


def register_all() -> None:
    for cls in (
        DoubaoWebSearchProvider,
        BochaWebSearchProvider,
        TavilyWebSearchProvider,
        InfoQuestWebSearchProvider,
        FirecrawlWebSearchProvider,
        SearXNGWebSearchProvider,
        BraveFreeWebSearchProvider,
        DDGSWebSearchProvider,
    ):
        register_provider(cls())


__all__ = [
    "register_all",
    "DoubaoWebSearchProvider",
    "BochaWebSearchProvider",
    "TavilyWebSearchProvider",
    "InfoQuestWebSearchProvider",
    "FirecrawlWebSearchProvider",
    "SearXNGWebSearchProvider",
    "BraveFreeWebSearchProvider",
    "DDGSWebSearchProvider",
]
