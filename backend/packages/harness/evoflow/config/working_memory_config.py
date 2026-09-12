"""Read registry configuration (sync path list; no separate digest LLM in MVP)."""

from __future__ import annotations

from pydantic import BaseModel, Field

_working_memory_config = None


class WorkingMemoryConfig(BaseModel):
    enabled: bool = Field(
        default=True,
        description="Track workspace reads; paths render inside <mission_state> via <files_already_read>",
    )
    max_entries: int = Field(default=32, ge=4, le=128)
    footer_max_entries: int = Field(default=12, ge=1, le=32)
    rule_note_max_chars: int = Field(default=240, ge=80, le=800)


def get_working_memory_config() -> WorkingMemoryConfig:
    global _working_memory_config
    if _working_memory_config is None:
        _working_memory_config = WorkingMemoryConfig()
    return _working_memory_config


def load_working_memory_config_from_dict(raw: dict | None) -> WorkingMemoryConfig:
    global _working_memory_config
    if not raw:
        _working_memory_config = WorkingMemoryConfig()
        return _working_memory_config
    # Drop deprecated digest keys from older configs silently via model extra ignore
    allowed = {k: v for k, v in raw.items() if k in WorkingMemoryConfig.model_fields}
    _working_memory_config = WorkingMemoryConfig(**allowed)
    return _working_memory_config
