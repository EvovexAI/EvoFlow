"""Agent orchestration: react vs hybrid prefetch vs local_scheduler."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

OrchestrationMode = Literal["react", "hybrid", "local_scheduler"]


class HybridOrchestrationConfig(BaseModel):
    prefetch_enabled: bool = Field(
        default=False,
        description="Deprecated: do not prefetch on every user turn. Parallel reads run only after search_code_index (read_limit>0).",
    )
    prefetch_max_files: int = Field(default=8, ge=1, le=32)
    read_search_via_scheduler: bool = Field(
        default=True,
        description="search_code_index lists a ranked read catalog; model uses read_file per path (no scheduler batch read by default).",
    )
    post_search_parallel_read_enabled: bool = Field(
        default=True,
        description="If true, search_code_index read_offset/read_limit triggers parallel internal read_file UI rows; false = catalog only, model calls read_file.",
    )
    post_search_path_catalog_max: int = Field(
        default=24,
        ge=1,
        le=64,
        description="Max ranked file paths listed after search (0-based indices for pagination).",
    )
    post_search_read_context_before: int = Field(
        default=12,
        ge=0,
        le=100,
        description="Lines before the index anchor line when batch-reading after search_code_index.",
    )
    post_search_read_context_after: int = Field(
        default=48,
        ge=1,
        le=200,
        description="Lines after the index anchor line when batch-reading after search_code_index.",
    )
    post_search_read_fallback_lines: int = Field(
        default=80,
        ge=10,
        le=500,
        description="When no anchor line is known, read only the first N lines instead of the whole file.",
    )
    post_search_read_batch_max: int = Field(
        default=16,
        ge=1,
        le=64,
        description="Deprecated: batch size is controlled by search_code_index read_limit from the model. Kept for config compatibility.",
    )
    post_search_auto_read_enabled: bool = Field(
        default=False,
        description="Deprecated: no auto-read when read_limit=0; model must set read_limit explicitly.",
    )
    post_search_auto_read_max_files: int = Field(
        default=5,
        ge=1,
        le=64,
        description="Deprecated: unused when post_search_auto_read_enabled is false.",
    )
    post_edit_parallel_lint_enabled: bool = Field(
        default=False,
        description="If true, terminal file edits emit parallel read_lints UI rows via scheduler.",
    )
    post_edit_auto_lint_enabled: bool = Field(
        default=False,
        description="If true, automatically lint code files after successful terminal edits.",
    )


class LocalSchedulerOrchestrationConfig(BaseModel):
    max_io_concurrency: int = Field(default=8, ge=1, le=32)
    tier0_paths: list[str] = Field(
        default_factory=lambda: [
            "package.json",
            "pyproject.toml",
            "tsconfig.json",
            "Cargo.toml",
            "go.mod",
        ]
    )


class FileReadCacheConfig(BaseModel):
    enabled: bool = Field(default=True)
    ttl_seconds: int = Field(default=90, ge=5, le=3600)
    max_entries: int = Field(default=256, ge=16, le=10_000)


class WorkerToolConfig(BaseModel):
    worker_max_concurrency: int = Field(default=5, ge=1, le=5)
    worker_default_max_turns: int = Field(default=500, ge=1, le=500)
    worker_search_default_read_limit: int = Field(
        default=0,
        ge=0,
        le=4,
        description="Default read_limit for worker action=search when omitted (0 = catalog only).",
    )


class AgentOrchestrationConfig(BaseModel):
    default: OrchestrationMode = Field(default="hybrid")
    hybrid: HybridOrchestrationConfig = Field(default_factory=HybridOrchestrationConfig)
    local_scheduler: LocalSchedulerOrchestrationConfig = Field(default_factory=LocalSchedulerOrchestrationConfig)
    file_read_cache: FileReadCacheConfig = Field(default_factory=FileReadCacheConfig)
    worker: WorkerToolConfig = Field(default_factory=WorkerToolConfig)


_agent_orchestration_config = AgentOrchestrationConfig()


def get_agent_orchestration_config() -> AgentOrchestrationConfig:
    return _agent_orchestration_config


def load_agent_orchestration_config_from_dict(data: dict) -> None:
    global _agent_orchestration_config
    raw = dict(data or {})
    if "hybrid" in raw and isinstance(raw["hybrid"], dict):
        raw["hybrid"] = HybridOrchestrationConfig(**raw["hybrid"])
    if "local_scheduler" in raw and isinstance(raw["local_scheduler"], dict):
        raw["local_scheduler"] = LocalSchedulerOrchestrationConfig(**raw["local_scheduler"])
    if "file_read_cache" in raw and isinstance(raw["file_read_cache"], dict):
        raw["file_read_cache"] = FileReadCacheConfig(**raw["file_read_cache"])
    if "worker" in raw and isinstance(raw["worker"], dict):
        raw["worker"] = WorkerToolConfig(**raw["worker"])
    _agent_orchestration_config = AgentOrchestrationConfig(**raw)


def is_hybrid_mode() -> bool:
    return get_agent_orchestration_config().default == "hybrid"


def is_local_scheduler_mode() -> bool:
    return get_agent_orchestration_config().default == "local_scheduler"
