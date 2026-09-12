"""Lead-agent system prompt language selection (zh / en)."""

from __future__ import annotations

import os
from typing import Literal

PromptLanguage = Literal["zh", "en"]

DEFAULT_PROMPT_LANGUAGE: PromptLanguage = "zh"


def resolve_prompt_language(value: str | None = None) -> PromptLanguage:
    """Resolve prompt language: explicit arg > ``EVOFLOW_PROMPT_LANGUAGE`` env > default (zh)."""
    raw = str(value or os.getenv("EVOFLOW_PROMPT_LANGUAGE") or DEFAULT_PROMPT_LANGUAGE).strip().lower()
    if raw in {"zh", "zh-cn", "zh_cn", "chinese", "cn"}:
        return "zh"
    return "en"
