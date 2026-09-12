"""Configuration for context compaction (main agent + compress model selection)."""

import logging
from dataclasses import dataclass
from typing import Literal

from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

ContextSizeType = Literal["fraction", "tokens", "messages"]

# Default prompt for LangChain ``SummarizationMiddleware`` when ``summary_prompt`` is unset in config.
# Must include exactly one ``{messages}`` placeholder (passed via ``str.format``).
EVOFLOW_DEFAULT_SUMMARY_PROMPT = """<role>
Context Extraction Assistant
</role>

<primary_objective>
Your sole objective in this task is to extract the highest quality/most relevant context from the conversation history below.
</primary_objective>

<language_policy>
Write the entire extracted summary in the **same primary natural language as the user** in the conversation below.
- If the user mainly writes in Chinese, the summary must be in Chinese.
- If mainly in English, use English.
- If mixed, follow the dominant language of **user** (Human) turns; keep code snippets, file paths, URLs, tool names, and identifiers unchanged.
Do not translate the user's explanations into another language for convenience.
</language_policy>

<objective_information>
You're nearing the total number of input tokens you can accept, so you must extract the highest quality/most relevant pieces of information from your conversation history.
This context will then overwrite the conversation history presented below. Because of this, ensure the context you extract is only the most important information to your overall goal.
</objective_information>

<instructions>
The conversation history below will be replaced with the context you extract in this step. Because of this, you must do your very best to extract and record all of the most important context from the conversation history.
You want to ensure that you don't repeat any actions you've already completed, so the context you extract from the conversation history should be focused on the most important information to your overall goal.
</instructions>

The user will message you with the full message history you'll be extracting context from, to then replace. Carefully read over it all, and think deeply about what information is most important to your overall goal that should be saved:

With all of this in mind, please carefully read over the entire conversation history, and extract the most important and relevant context to replace it so that you can free up space in the conversation history.
Respond ONLY with the extracted context. Do not include any additional information, or text before or after the extracted context.

<messages>
Messages to summarize:
{messages}
</messages>"""


class ContextSize(BaseModel):
    """Context size specification for trigger or keep parameters."""

    type: ContextSizeType = Field(description="Type of context size specification")
    value: int | float = Field(description="Value for the context size specification")

    def to_tuple(self) -> tuple[ContextSizeType, int | float]:
        """Convert to tuple format expected by SummarizationMiddleware."""
        return (self.type, self.value)


class SummarizationConfig(BaseModel):
    """Configuration for Hermes-style context compaction (main agent)."""

    enabled: bool = Field(
        default=True,
        description="Whether to enable automatic context compaction before each model call",
    )
    model_name: str | None = Field(
        default=None,
        description="Model for compaction summaries (invocation_kind=compress). None = default model",
    )
    threshold_ratio: float = Field(
        default=0.90,
        ge=0.1,
        le=0.95,
        description=(
            "Compress when gate tokens >= this fraction of model context_length. "
            "Default 0.90 matches runtime ``(context_window * 9) / 10``."
        ),
    )
    aggressive_ratio: float = Field(
        default=1.0,
        ge=0.5,
        le=1.0,
        description=(
            "Second pass / hard threshold after first compaction. "
            "Default 1.0 matches runtime full-window force compact."
        ),
    )
    protect_first_n: int = Field(
        default=0,
        ge=0,
        description="Keep first N messages verbatim (0 = include system/opening exchange in compaction summary)",
    )
    protect_tail_messages: int = Field(
        default=12,
        ge=3,
        description="Minimum recent messages kept verbatim",
    )
    protect_tail_tool_rounds: int = Field(
        default=3,
        ge=1,
        le=12,
        description="When folding history, keep at most this many recent ToolMessage rounds verbatim",
    )
    compaction_cooldown_seconds: float = Field(
        default=120.0,
        ge=0.0,
        le=600.0,
        description="After a successful compress LLM call, skip another for this many seconds unless context grows >8%%",
    )
    compaction_hysteresis_enabled: bool = Field(
        default=True,
        description="While in cooldown, keep using cached summary refolds instead of re-invoking compress LLM",
    )
    compaction_release_ratio: float = Field(
        default=0.42,
        ge=0.1,
        le=0.9,
        description="During cooldown, skip compress LLM while gate tokens stay below aggressive_ratio threshold",
    )
    compaction_min_middle_tokens: int = Field(
        default=2000,
        ge=0,
        description="Skip compress LLM when foldable middle is smaller than this (reuse cached summary refold only)",
    )
    compaction_trigger_message_count: int = Field(
        default=0,
        ge=0,
        description=(
            "Deprecated / ignored. Compaction is token-window only (runtime-aligned); "
            "message-count triggers are disabled."
        ),
    )
    compaction_background_llm: bool = Field(
        default=True,
        description="Run compress LLM in background (off: unified middleware uses sync compress only)",
    )
    compaction_background_debounce_seconds: float = Field(
        default=2.0,
        ge=0.5,
        le=60.0,
        description="Debounce before background compaction LLM runs",
    )
    summary_content_ratio: float = Field(
        default=0.22,
        ge=0.05,
        le=0.5,
        description="Target ratio of content tokens for summary budget (higher = larger summaries)",
    )
    tail_token_ratio: float = Field(
        default=0.18,
        ge=0.05,
        le=0.5,
        description="Ratio of threshold tokens allocated for tail protection budget",
    )
    prune_tool_min_tokens: int = Field(
        default=48,
        ge=0,
        description="Minimum token count below which non-critical tool outputs are cleared entirely",
    )
    critical_tool_truncate_tokens: int = Field(
        default=4096,
        ge=256,
        description="Head+tail truncation limit for critical tools (read_file, grep, etc.) when pruned",
    )
    moderate_tool_truncate_tokens: int = Field(
        default=1024,
        ge=128,
        description="Head+tail truncation limit for moderate tools (execute_command, etc.) when pruned",
    )
    # Legacy LangChain SummarizationMiddleware fields (ignored by compaction engine; kept for YAML compat)
    trigger: ContextSize | list[ContextSize] | None = Field(
        default=None,
        description="Deprecated: use threshold_ratio. If set and type=fraction, overrides threshold_ratio on load",
    )
    keep: ContextSize | None = Field(
        default=None,
        description="Deprecated: use protect_tail_messages. If type=messages, overrides protect_tail_messages on load",
    )
    trim_tokens_to_summarize: int | None = Field(default=None, description="Deprecated (unused)")
    summary_prompt: str | None = Field(default=None, description="Deprecated (unused)")


# Global configuration instance
_summarization_config: SummarizationConfig = SummarizationConfig()

# One-time warning flag for compaction_release_ratio auto-adjustment.
# Reset on config (re)load so users see the warning again after editing config.
_warned_release_override: bool = False


def get_summarization_config() -> SummarizationConfig:
    """Get the current summarization configuration."""
    return _summarization_config


def set_summarization_config(config: SummarizationConfig) -> None:
    """Set the summarization configuration."""
    global _summarization_config, _warned_release_override
    _summarization_config = config
    _warned_release_override = False


@dataclass(frozen=True)
class CompactionSettings:
    threshold_ratio: float
    aggressive_ratio: float
    protect_first_n: int
    protect_tail_messages: int
    protect_tail_tool_rounds: int
    compaction_cooldown_seconds: float
    compaction_hysteresis_enabled: bool
    compaction_release_ratio: float
    compaction_min_middle_tokens: int
    compaction_trigger_message_count: int
    summary_content_ratio: float
    tail_token_ratio: float
    prune_tool_min_tokens: int
    critical_tool_truncate_tokens: int
    moderate_tool_truncate_tokens: int


def get_compaction_settings() -> CompactionSettings:
    """Resolved compaction parameters for ContextCompactionMiddleware."""
    cfg = get_summarization_config()
    threshold = float(cfg.threshold_ratio)
    aggressive = float(cfg.aggressive_ratio)
    protect_first = int(cfg.protect_first_n)
    protect_tail = int(cfg.protect_tail_messages)

    if cfg.trigger is not None:
        triggers = cfg.trigger if isinstance(cfg.trigger, list) else [cfg.trigger]
        for t in triggers:
            if t.type == "fraction":
                threshold = float(t.value)
                break

    if cfg.keep is not None and cfg.keep.type == "messages":
        protect_tail = max(3, int(cfg.keep.value))

    release = float(cfg.compaction_release_ratio)
    if release >= threshold:
        new_release = max(0.1, threshold - 0.08)
        global _warned_release_override
        if not _warned_release_override:
            logger.warning(
                "compaction_release_ratio=%.2f >= threshold_ratio=%.2f; auto-adjusted to %.2f. "
                "Set compaction_release_ratio < threshold_ratio in config to silence this warning.",
                release,
                threshold,
                new_release,
            )
            _warned_release_override = True
        release = new_release

    return CompactionSettings(
        threshold_ratio=threshold,
        aggressive_ratio=aggressive,
        protect_first_n=protect_first,
        protect_tail_messages=protect_tail,
        protect_tail_tool_rounds=int(cfg.protect_tail_tool_rounds),
        compaction_cooldown_seconds=float(cfg.compaction_cooldown_seconds),
        compaction_hysteresis_enabled=bool(cfg.compaction_hysteresis_enabled),
        compaction_release_ratio=release,
        compaction_min_middle_tokens=int(cfg.compaction_min_middle_tokens),
        compaction_trigger_message_count=int(cfg.compaction_trigger_message_count),
        summary_content_ratio=float(cfg.summary_content_ratio),
        tail_token_ratio=float(cfg.tail_token_ratio),
        prune_tool_min_tokens=int(cfg.prune_tool_min_tokens),
        critical_tool_truncate_tokens=int(cfg.critical_tool_truncate_tokens),
        moderate_tool_truncate_tokens=int(cfg.moderate_tool_truncate_tokens),
    )


def load_summarization_config_from_dict(config_dict: dict) -> None:
    """Load summarization / compaction configuration from a dictionary."""
    global _summarization_config, _warned_release_override
    _summarization_config = SummarizationConfig(**config_dict)
    _warned_release_override = False
