"""Hermes-style web search/extract backend configuration."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


from pydantic import BaseModel, ConfigDict, Field, field_validator


class WebConfig(BaseModel):
    """Pluggable web backends (mirrors Hermes ``web:`` section).

    Resolution order for search:
    1. ``search_backend`` (if set)
    2. ``backend`` (shared fallback)
    3. Auto-detect from env / available providers
    """

    model_config = ConfigDict(extra="allow")

    backend: str | None = Field(
        default=None,
        description="Shared backend for search/extract (e.g. tavily, firecrawl, ddgs)",
    )
    search_backend: str | None = Field(
        default=None,
        description="Override backend for web_search only",
    )
    extract_backend: str | None = Field(
        default=None,
        description="Override backend for web_fetch/extract only",
    )

    @field_validator("backend", "search_backend", "extract_backend", mode="before")
    @classmethod
    def _empty_str_to_none(cls, v: object) -> object:
        if isinstance(v, str) and not v.strip():
            return None
        return v


def coerce_web_config(value: object) -> object:
    """YAML ``web:`` with only comments often parses as null."""
    if value is None:
        return {}
    return value
