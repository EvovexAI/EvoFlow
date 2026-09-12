"""Shared Plan Bundle types."""

from __future__ import annotations

from typing import Any, Literal, TypedDict

Capability = Literal[
    "chat",
    "coding",
    "embedding",
    "tts",
    "asr",
    "image",
    "video",
    "web_search",
    "music",
]

CAPABILITIES: tuple[Capability, ...] = (
    "chat",
    "coding",
    "embedding",
    "tts",
    "asr",
    "image",
    "video",
    "web_search",
    "music",
)

PlanFamily = Literal["agent_plan", "token_plan", "coding_plan"]
BindingStatus = Literal["active", "disabled", "error"]


class ResolvedRoute(TypedDict, total=False):
    capability: Capability
    binding_id: str | None
    base_url: str
    api_key: str
    headers: dict[str, str]
    model_hint: str | None
    meter_tags: dict[str, Any]
    source: str  # plan | payg_fallback
