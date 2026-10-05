from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_validator

# Default single-turn output budget (OpenAI-compat gateways clamp to this in factory).
DEFAULT_MODEL_MAX_OUTPUT_TOKENS = 65536
# Legacy Gateway / panel default before output budget was unified.
_LEGACY_DEFAULT_MAX_OUTPUT_TOKENS = 8192


def resolve_model_max_output_tokens(raw: int | None) -> int:
    """Normalize DB/API max_tokens: unset or legacy 8192 → 64k."""
    if raw is None or raw <= 0:
        return DEFAULT_MODEL_MAX_OUTPUT_TOKENS
    if raw == _LEGACY_DEFAULT_MAX_OUTPUT_TOKENS:
        return DEFAULT_MODEL_MAX_OUTPUT_TOKENS
    return int(raw)


DEFAULT_MODEL_TEMPERATURE = 0.7
# Ceiling for a single vendor request. The legacy 600s froze the UI on「生成中…」for
# up to 10 minutes per attempt when a gateway accepted the socket but never streamed a
# first token; with ``max_retries`` the worst case was 600s x 3 = 30 minutes. 120s
# matches the sync-compaction ceiling (``_SYNC_COMPACTION_TIMEOUT_S``) so every
# pre-model stage fails over on the same budget. Legitimate long generations keep
# working: the timeout covers the whole stream, and observed healthy calls are 2-45s.
DEFAULT_MODEL_REQUEST_TIMEOUT = 120.0
# One retry still absorbs transient gateway blips (those fail fast) while halving the
# worst-case stall versus the legacy value.
DEFAULT_MODEL_MAX_RETRIES = 1
# Hard cap. Rows written before this change stored the legacy 600 explicitly, so
# lowering the default alone would not reach them — clamp on read instead. Operators who
# genuinely need a longer ceiling should raise this constant, not a single row.
_REQUEST_TIMEOUT_CEILING = 300.0
# Rows written before this change stored the legacy 2 explicitly; clamp on read so a
# wedged gateway cannot burn 3x the timeout.
_MAX_RETRIES_CEILING = 2


def resolve_model_temperature(raw: float | None) -> float:
    """Normalize DB/API temperature: unset → 0.7."""
    if raw is None:
        return DEFAULT_MODEL_TEMPERATURE
    return float(raw)


def resolve_model_request_timeout(raw: float | None) -> float:
    """Normalize DB/API request_timeout: unset → 120, capped at 300."""
    if raw is None or raw <= 0:
        return DEFAULT_MODEL_REQUEST_TIMEOUT
    return min(float(raw), _REQUEST_TIMEOUT_CEILING)


def resolve_model_max_retries(raw: int | None) -> int:
    """Normalize DB/API max_retries: unset → 1."""
    if raw is None or raw < 0:
        return DEFAULT_MODEL_MAX_RETRIES
    return min(int(raw), _MAX_RETRIES_CEILING)


class ModelConfig(BaseModel):
    """Config section for a model"""

    @model_validator(mode="before")
    @classmethod
    def _drop_reserved_model_config_key(cls, data: Any) -> Any:
        """Strip leaked ``model_config`` field data (Pydantic class-config reserved name)."""
        if isinstance(data, dict) and "model_config" in data:
            data = dict(data)
            data.pop("model_config", None)
        return data

    vendor: str | None = Field(
        default=None,
        description="English vendor id (e.g. aliyun, openai); used when serializing models.providers",
    )
    name: str = Field(..., description="Unique name for the model")
    display_name: str | None = Field(..., default_factory=lambda: None, description="Display name for the model")
    description: str | None = Field(..., default_factory=lambda: None, description="Description for the model")
    use: str = Field(
        ...,
        description="Class path of the model provider(e.g. langchain_openai.ChatOpenAI)",
    )
    model: str = Field(..., description="Model name")
    # Connection settings
    base_url: str | None = Field(default=None, description="Base URL for the API")
    api_key: str | None = Field(default=None, description="API key for authentication")
    # Model parameters
    request_timeout: float | None = Field(default=None, description="Request timeout in seconds (default 120 when unset)")
    max_retries: int | None = Field(default=None, description="Maximum number of retries (default 1 when unset)")
    max_tokens: int | None = Field(
        default=None,
        description="Maximum output tokens per completion (default 65536 when unset)",
    )
    context_length: int | None = Field(
        default=None,
        description="Model input context window in tokens (used for compression thresholds; auto-guessed if unset)",
    )
    input_context_length: int | None = Field(
        default=None,
        description="Explicit input context window in tokens (panel override)",
    )
    output_context_length: int | None = Field(
        default=None,
        description="Output / max-tokens limit in tokens (panel override)",
    )
    temperature: float | None = Field(default=None, description="Temperature for generation")
    model_config = ConfigDict(extra="allow")
    use_responses_api: bool | None = Field(
        default=None,
        description="Whether to route OpenAI ChatOpenAI calls through the /v1/responses API",
    )
    output_version: str | None = Field(
        default=None,
        description="Structured output version for OpenAI responses content, e.g. responses/v1",
    )
    supports_thinking: bool = Field(default_factory=lambda: False, description="Whether the model supports thinking")
    supports_reasoning_effort: bool = Field(default_factory=lambda: False, description="Whether the model supports reasoning effort")
    when_thinking_enabled: dict | None = Field(
        default_factory=lambda: None,
        description="Extra settings to be passed to the model when thinking is enabled",
    )
    supports_vision: bool = Field(default_factory=lambda: False, description="Whether the model supports vision/image inputs")
    enable_web_search: bool = Field(
        default_factory=lambda: False,
        description=("Enable vendor-native web search when supported. Phase 1: DashScope/Aliyun maps this to extra_body.enable_search."),
    )
    web_search_options: dict | None = Field(
        default_factory=lambda: None,
        description="Optional vendor search_options (e.g. DashScope forced_search) when enable_web_search is on",
    )
    credentials: list[dict] = Field(
        default_factory=list,
        description="Multi-credential pool config. Each entry: {api_key_env: 'ENV_VAR_NAME', base_url: '...'}",
    )
    credential_strategy: str = Field(
        default="fill_first",
        description="Credential selection strategy: fill_first / round_robin / random / least_used",
    )
    fallback_models: list[str] = Field(
        default_factory=list,
        description="Ordered list of fallback model names to try when this model fails",
    )
    availability_status: str = Field(
        default="available",
        description="Runtime health: available | unavailable (persisted on evoflow_models)",
    )
    unavailable_reason: str | None = Field(
        default=None,
        description="Human-readable reason when availability_status is unavailable",
    )
    unavailable_code: str | None = Field(
        default=None,
        description="FailoverReason / machine code when unavailable",
    )
    unavailable_at: str | None = Field(
        default=None,
        description="ISO timestamp when the model was marked unavailable",
    )
    thinking: dict | None = Field(
        default_factory=lambda: None,
        description=(
            "Thinking settings for the model. If provided, these settings will be passed to the model when thinking is enabled. "
            "This is a shortcut for `when_thinking_enabled` and will be merged with `when_thinking_enabled` if both are provided."
        ),
    )
