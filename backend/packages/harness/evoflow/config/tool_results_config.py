"""Configuration for large tool result offloading."""

from __future__ import annotations

import logging
import os

from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


def _env_flag(name: str, *, default: str = "1") -> bool:
    return str(os.environ.get(name, default)).strip().lower() not in {
        "0",
        "false",
        "no",
        "off",
    }

_DEFAULT_THRESHOLD = 50_000
_DEFAULT_SUMMARY_LINES = 8
_DEFAULT_SUMMARY_MAX_CHARS = 1200
_DEFAULT_MAX_AGE_HOURS = 24

_LLM_SUMMARY_TOOL_NAMES_DEFAULT = frozenset(
    {
        "web_search",
        "web_fetch",
        "search_content",
        "search_code_index",
        "grep",
        "session_search",
        "tool_search",
        "baidu_search",
    }
)

_PRUNE_PRESERVE_TOOL_NAMES_DEFAULT = frozenset(
    {
        "read_file",
        "write_to_file",
        "replace_in_file",
        "str_replace",
        "plan",
        "supervisor",
        "subagent",
        "task",
        "terminal",
        "bash",
        "list_agents",
        "list_assignable_tools",
    }
)

# Agent inventory tools: keep full JSON inline (plan/supervisor need complete agent_code list).
_PRESERVE_VERBATIM_TOOL_NAMES_DEFAULT = frozenset(
    {
        "list_agents",
        "list_assignable_tools",
    }
)


class ToolResultsConfig(BaseModel):
    """How oversized tool outputs are persisted and referenced in context."""

    shaping_enabled: bool = Field(
        default=True,
        description="native-style inline truncation on tool return (independent of disk persist / LLM summary)",
    )
    enabled: bool = Field(default=False, description="Persist large tool results to disk")
    use_token_tiers: bool = Field(
        default=True,
        description="Tier by tiktoken (tier_small/medium_tokens); false uses char thresholds below",
    )
    tier_small_tokens: int = Field(default=800, ge=100, description="Full inline body at or below this size (tokens)")
    tier_medium_tokens: int = Field(default=3000, ge=200, description="Summary above small; persist above this (tokens)")
    tool_summary_model_name: str | None = Field(
        default=None,
        description="Dedicated model for tool summaries; null uses llm_summary_model_name",
    )
    history_keep_full_tools: int = Field(
        default=3,
        ge=1,
        le=8,
        description="Newest N tool rounds kept verbatim; all older rounds merge into one [tool:history]",
    )
    history_tail_token_budget: int = Field(
        default=6000,
        ge=500,
        description="Token budget protecting recent messages from tool history aging",
    )
    history_summarize_enabled: bool = Field(
        default=False,
        description="Replace aged tool bodies with structured summaries (fast rule path in before_model)",
    )
    history_background_llm: bool = Field(
        default=False,
        description="Refine aged tool summaries via tool-summary model in background (off: use context compaction only)",
    )
    history_background_debounce_seconds: float = Field(
        default=2.0,
        ge=0.5,
        le=60.0,
        description="Debounce window before background tool-summary batch runs",
    )
    history_merge_enabled: bool = Field(
        default=False,
        description="Merge cold-zone tools into one [tool:history] block when batch thresholds met",
    )
    history_merge_min_tools: int = Field(
        default=1,
        ge=1,
        description="Minimum cold-zone tool rounds before batch merge into [tool:history]",
    )
    history_merge_min_tokens: int = Field(
        default=2500,
        ge=200,
        description="Minimum combined raw tokens in cold-zone batch before merge",
    )
    history_merge_cooldown_seconds: float = Field(
        default=60.0,
        ge=5.0,
        le=600.0,
        description="Minimum seconds between batch merges for the same thread",
    )
    code_compact_enabled: bool = Field(default=False, description="Light comment/blank-line strip for read/search tools")
    threshold_chars: int = Field(default=_DEFAULT_THRESHOLD, ge=1000, description="Chars above which results are offloaded")
    summary_max_chars: int = Field(
        default=_DEFAULT_SUMMARY_MAX_CHARS,
        ge=200,
        description="Max chars of inline summary when offloaded",
    )
    summary_head_lines: int = Field(default=_DEFAULT_SUMMARY_LINES, ge=1, le=50, description="Head lines in summary")
    max_age_hours: int = Field(default=_DEFAULT_MAX_AGE_HOURS, ge=1, le=168, description="Prune persisted files older than this")
    prune_preserve_tool_names: list[str] = Field(
        default_factory=lambda: sorted(_PRUNE_PRESERVE_TOOL_NAMES_DEFAULT),
        description="Tool names whose outputs compaction should not clear",
    )
    medium_threshold_chars: int = Field(
        default=8000,
        ge=500,
        description="Between medium and large: enhanced summary before optional LLM",
    )
    medium_background_llm: bool = Field(
        default=False,
        description="Medium-tier whitelist tools: background LLM summary (off: rule shape only; batch merge via context compaction)",
    )
    llm_summary_enabled: bool = Field(default=False, description="Use LLM for medium-large tool outputs")
    llm_summary_tool_names: list[str] = Field(
        default_factory=lambda: sorted(_LLM_SUMMARY_TOOL_NAMES_DEFAULT),
        description="Only these tools use LLM [tool:summary] on medium tier + history background refine",
    )
    llm_summary_model_name: str | None = Field(default=None, description="Model for tool output summary")
    llm_summary_max_input_chars: int = Field(default=12_000, ge=1000)
    llm_summary_target_chars: int = Field(
        default=500,
        ge=120,
        le=2000,
        description="Target length for LLM tool summaries (was hard-coded 120; increase for richer extraction)",
    )
    ref_lru_enabled: bool = Field(default=True, description="Track persisted tool paths per thread with LRU")
    ref_lru_max_chars: int = Field(default=80_000, ge=5000, description="Max estimated chars of refs kept per thread")


_tool_results_config = ToolResultsConfig()


def get_tool_results_config() -> ToolResultsConfig:
    return _tool_results_config


def set_tool_results_config(config: ToolResultsConfig) -> None:
    global _tool_results_config
    _tool_results_config = config


def tool_result_shaping_active() -> bool:
    """Inline head/tail truncation when tools return (runtime-aligned write path)."""
    if not _env_flag("EVOFLOW_TOOL_RESULT_SHAPING", default="1"):
        return False
    return bool(get_tool_results_config().shaping_enabled)


def tool_output_token_cap() -> int:
    """Shared token budget for inline tool bodies (shaper + compaction tail cap)."""
    return get_tool_results_config().tier_medium_tokens


def tool_result_compression_active() -> bool:
    """Gate for [tool:summary] / disk persist / history merge / code compact (not inline shaping)."""
    cfg = get_tool_results_config()
    return bool(
        cfg.enabled
        or cfg.history_summarize_enabled
        or cfg.history_merge_enabled
        or cfg.llm_summary_enabled
        or cfg.code_compact_enabled
    )


def load_tool_results_config_from_dict(config_dict: dict) -> None:
    global _tool_results_config
    _tool_results_config = ToolResultsConfig(**(config_dict or {}))


def prune_preserve_tool_names() -> frozenset[str]:
    cfg = get_tool_results_config()
    names = {str(n or "").strip().lower() for n in (cfg.prune_preserve_tool_names or []) if str(n or "").strip()}
    return frozenset(names or _PRUNE_PRESERVE_TOOL_NAMES_DEFAULT)


def preserve_verbatim_tool_names() -> frozenset[str]:
    """Tools whose results must stay full inline for model + UI (no tier summary / persist)."""
    return _PRESERVE_VERBATIM_TOOL_NAMES_DEFAULT


def llm_summary_tool_names_set() -> frozenset[str]:
    cfg = get_tool_results_config()
    names = {str(n or "").strip().lower() for n in (cfg.llm_summary_tool_names or []) if str(n or "").strip()}
    return frozenset(names or _LLM_SUMMARY_TOOL_NAMES_DEFAULT)


def tool_is_llm_summary_candidate(tool_name: str) -> bool:
    """Tool is on the LLM-summary whitelist (independent of llm_summary_enabled)."""
    n = str(tool_name or "").strip().lower()
    if n in ("read", "read_file", "read_files"):
        return False
    return n in llm_summary_tool_names_set()


def tool_uses_llm_summary(tool_name: str) -> bool:
    """Whether this tool may invoke the tool-summary LLM (whitelist + enabled)."""
    if not get_tool_results_config().llm_summary_enabled:
        return False
    return tool_is_llm_summary_candidate(tool_name)
