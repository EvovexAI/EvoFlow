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
DEFAULT_MODEL_REQUEST_TIMEOUT = 600.0
DEFAULT_MODEL_MAX_RETRIES = 2


def resolve_model_temperature(raw: float | None) -> float:
    """Normalize DB/API temperature: unset → 0.7."""
    if raw is None:
        return DEFAULT_MODEL_TEMPERATURE
    return float(raw)


def resolve_model_request_timeout(raw: float | None) -> float:
    """Normalize DB/API request_timeout: unset → 600."""
    if raw is None or raw <= 0:
        return DEFAULT_MODEL_REQUEST_TIMEOUT
    return float(raw)


def resolve_model_max_retries(raw: int | None) -> int:
    """Normalize DB/API max_retries: unset → 2."""
    if raw is None or raw < 0:
        return DEFAULT_MODEL_MAX_RETRIES
    return int(raw)


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
    request_timeout: float | None = Field(default=None, description="Request timeout in seconds (default 600 when unset)")
    max_retries: int | None = Field(default=None, description="Maximum number of retries (default 2 when unset)")
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
        description=(
            "Enable vendor-native web search when supported. "
            "Phase 1: DashScope/Aliyun maps this to extra_body.enable_search."
        ),
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
