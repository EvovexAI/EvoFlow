"""Configuration for memory mechanism."""

from pydantic import BaseModel, Field

from evoflow.assets.pipeline_config import MemoryAssetsConfig


class MemoryGraphConfig(BaseModel):
    """Memory knowledge-graph extract / expand (unified mem_*). See design §13.3."""

    extract_enabled: bool = Field(
        default=True,
        description="Schedule mem_kg_batch after remember (namespace-batched LLM extract)",
    )
    expand_hops: int = Field(default=0, ge=0, le=2, description="Recall graph expand hops; default 0")
    batch_size: int = Field(
        default=24,
        ge=1,
        le=80,
        description="Max atoms per mem_kg_batch LLM call",
    )
    batch_debounce_seconds: int = Field(
        default=45,
        ge=0,
        le=600,
        description="Debounce before namespace batch extract after remember",
    )
    skip_section_llm: bool = Field(
        default=True,
        description="Do not LLM-extract section:* summary atoms in batch",
    )
    skip_bootstrap_source: bool = Field(
        default=True,
        description="Skip bootstrap/bootstrap-scan/migrate sourced atoms in batch LLM",
    )


class MemoryConsolidateConfig(BaseModel):
    """Namespace consolidate / decay / GC (unified mem_*). See design §13.2.6."""

    idle_minutes: int = Field(default=30, ge=1, le=10080)
    similarity_merge: float = Field(default=0.85, ge=0.5, le=1.0)
    decay_factor: float = Field(default=0.92, ge=0.1, le=1.0)
    archive_vitality: float = Field(default=0.15, ge=0.0, le=1.0)
    max_active_atoms: int = Field(default=300, ge=10, le=10000)
    gc_min_confidence: float = Field(default=0.55, ge=0.0, le=1.0)
    gc_idle_days: int = Field(default=30, ge=1, le=3650)


class MemoryConfig(BaseModel):
    """Configuration for global memory mechanism."""

    assets: MemoryAssetsConfig = Field(
        default_factory=MemoryAssetsConfig,
        description="runtime-aligned Asset Hub Phase1/2 pipeline settings.",
    )
    enabled: bool = Field(
        default=True,
        description="Whether to enable memory mechanism",
    )
    consolidate: MemoryConsolidateConfig = Field(
        default_factory=MemoryConsolidateConfig,
        description="Unified memory consolidate job settings",
    )
    graph: MemoryGraphConfig = Field(
        default_factory=MemoryGraphConfig,
        description="Memory graph extract / expand settings",
    )
    storage_path: str = Field(
        default="",
        description=(
            "Path to store memory data. "
            "If empty, defaults to `{base_dir}/memory.json` (see Paths.memory_file). "
            "Absolute paths are used as-is. "
            "Relative paths are resolved against `Paths.base_dir` "
            "(not the backend working directory). "
            "Note: if you previously set this to `.evoflow/memory.json`, "
            "the file will now be resolved as `{base_dir}/.evoflow/memory.json`; "
            "migrate existing data or use an absolute path to preserve the old location."
        ),
    )
    storage_class: str = Field(
        default="evoflow.agents.memory.storage.SqliteMemoryStorage",
        description="The class path for memory storage provider",
    )
    debounce_seconds: int = Field(
        default=120,
        ge=1,
        le=600,
        description="Seconds to wait before processing queued updates (debounce)",
    )
    model_name: str | None = Field(
        default=None,
        description="Model name to use for memory updates (None = use default model)",
    )
    max_facts: int = Field(
        default=100,
        ge=10,
        le=500,
        description="Maximum number of facts to store",
    )
    fact_confidence_threshold: float = Field(
        default=0.7,
        ge=0.0,
        le=1.0,
        description="Minimum confidence threshold for storing facts",
    )
    injection_enabled: bool = Field(
        default=True,
        description="Whether to inject memory into system prompt",
    )
    injection_mode: str = Field(
        default="asset",
        description=(
            "Tier-0 injection style: ``asset`` = read_path + standing only (search/read on demand); "
            "``legacy`` = SQLite <memory> block + asset catalog listing. "
            "Legacy alias ``codex`` is accepted and treated as ``asset``."
        ),
    )
    max_injection_tokens: int = Field(
        default=2000,
        ge=100,
        le=8000,
        description="Maximum tokens to use for memory injection (full profile)",
    )
    chat_compact_max_tokens: int = Field(
        default=480,
        ge=100,
        le=4000,
        description="Token budget when injection_profile is chat_compact (stable prefs + facts only)",
    )
    # --- External memory plugin (Hermes-style; optional) ---
    external_provider: str = Field(
        default="",
        description=("Optional external memory plugin id (e.g. ``echo``). Empty = disabled. Implements sync_turn + prefetch alongside built-in memory.json updates."),
    )
    external_sync_enabled: bool = Field(
        default=True,
        description="If True, after built-in memory.json LLM update, sync last user/assistant turn to the plugin.",
    )
    external_prefetch_enabled: bool = Field(
        default=True,
        description="If True, inject <memory_context> from the plugin in before_model (per thread).",
    )
    # --- echo plugin: optional LLM compression of each synced turn ---
    echo_summarize_enabled: bool = Field(
        default=False,
        description=("When ``external_provider`` is ``echo`` and this is True, call a chat model after each ``sync_turn`` to add a short bullet summary alongside the raw user/assistant text."),
    )
    echo_summarize_model: str | None = Field(
        default=None,
        description=("Model name (from config ``models``) for echo turn summaries. ``None`` uses ``memory.model_name``, then the app's default first model."),
    )


# Global configuration instance
_memory_config: MemoryConfig = MemoryConfig()


def get_memory_config() -> MemoryConfig:
    """Get the current memory configuration."""
    return _memory_config


def set_memory_config(config: MemoryConfig) -> None:
    """Set the memory configuration."""
    global _memory_config
    _memory_config = config


def load_memory_config_from_dict(config_dict: dict) -> None:
    """Load memory configuration from a dictionary."""
    global _memory_config
    _memory_config = MemoryConfig(**config_dict)
