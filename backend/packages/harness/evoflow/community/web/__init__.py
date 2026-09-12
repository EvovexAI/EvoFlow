"""Hermes-style pluggable web search backends for EvoFlow."""

from .provider import WebSearchProvider, get_provider_env
from .registry import (
    get_active_search_provider,
    get_provider,
    list_providers,
    register_provider,
    resolve_search_backend,
    run_provider_search,
)

__all__ = [
    "WebSearchProvider",
    "get_provider_env",
    "register_provider",
    "list_providers",
    "get_provider",
    "resolve_search_backend",
    "get_active_search_provider",
    "run_provider_search",
]
