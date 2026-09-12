"""Session intent rollup configuration."""

from __future__ import annotations

from pydantic import BaseModel, Field


class SessionIntentConfig(BaseModel):
    enabled: bool = Field(default=True)
    max_turns: int = Field(default=5, ge=1, le=20)
    llm_rollup_enabled: bool = Field(
        default=False,
        description="Cluster/summarize prior user turns with LLM; prefer mission_state primary_objective when enabled",
    )
    llm_rollup_model_name: str | None = Field(default=None, description="Model for intent rollup")
    llm_rollup_max_input_chars: int = Field(default=6000, ge=500)
    llm_rollup_min_chars: int = Field(
        default=120,
        ge=0,
        description="Only call LLM rollup when combined prior user text exceeds this",
    )
    auto_thinking_decision_enabled: bool = Field(
        default=True,
        description="Deprecated: Auto-mode per-turn thinking classification follows EvoPanel session_mode=auto only (yaml flag ignored).",
    )
    auto_thinking_model_name: str | None = Field(
        default=None,
        description="Model for auto thinking decision; defaults to llm_rollup_model_name or primary model",
    )


_session_intent_config = SessionIntentConfig()


def get_session_intent_config() -> SessionIntentConfig:
    return _session_intent_config


def load_session_intent_config_from_dict(data: dict) -> None:
    global _session_intent_config
    _session_intent_config = SessionIntentConfig(**(data or {}))
