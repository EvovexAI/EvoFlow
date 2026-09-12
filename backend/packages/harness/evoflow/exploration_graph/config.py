"""Session knowledge graph feature flags."""

from __future__ import annotations

from pydantic import BaseModel, Field

_exploration_graph_config: ExplorationGraphConfig | None = None


class ExplorationGraphConfig(BaseModel):
    enabled: bool = Field(
        default=True,
        description="Apply mind_map tool ops. Snapshot is returned from the tool (not auto-injected) unless inject_into_model_payload is true.",
    )
    inject_into_model_payload: bool = Field(
        default=False,
        description=(
            "When true, ephemerally inject <session_mind_map> into each model payload. "
            "Default false — keeps the system/prefix stable for prompt-cache hits; "
            "models read the map from mind_map tool results (update returns snapshot; query=true reads)."
        ),
    )
    return_snapshot_on_update: bool = Field(
        default=True,
        description="Append a compact <session_mind_map> snapshot to successful mind_map tool results.",
    )
    require_mind_map_ops: bool = Field(
        default=False,
        description="When true, reject empty mind_map ops or missing session goal. Default off — never blocks other tools.",
    )
    inject_max_nodes: int = Field(default=24, ge=4, le=120)
    inject_max_edges: int = Field(default=16, ge=0, le=80)
    node_body_max_chars: int = Field(default=200, ge=80, le=2000)
    soft_hints: bool = Field(
        default=True,
        description="Append non-blocking mind-map quality hints to successful mind_map tool results.",
    )


def get_exploration_graph_config() -> ExplorationGraphConfig:
    global _exploration_graph_config
    if _exploration_graph_config is None:
        _exploration_graph_config = ExplorationGraphConfig()
    return _exploration_graph_config


def is_exploration_graph_enabled() -> bool:
    """User-facing master switch (panel settings) layered on app config ``enabled``."""
    try:
        from evoflow.persistence.panel_settings import get_panel_settings

        if get_panel_settings().get("knowledgeMapEnabled") is False:
            return False
    except Exception:
        pass
    return get_exploration_graph_config().enabled


def should_inject_mind_map_into_model_payload() -> bool:
    """True only when exploration graph is on AND per-call injection is enabled."""
    if not is_exploration_graph_enabled():
        return False
    return bool(get_exploration_graph_config().inject_into_model_payload)


def load_exploration_graph_config_from_dict(raw: dict | None) -> ExplorationGraphConfig:
    global _exploration_graph_config
    if not raw:
        _exploration_graph_config = ExplorationGraphConfig()
        return _exploration_graph_config
    allowed = {k: v for k, v in raw.items() if k in ExplorationGraphConfig.model_fields}
    _exploration_graph_config = ExplorationGraphConfig(**allowed)
    return _exploration_graph_config
