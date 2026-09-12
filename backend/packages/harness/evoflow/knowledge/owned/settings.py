"""Owned knowledge preference settings (primary + default embedding)."""

from __future__ import annotations

from typing import Any, Literal

from evoflow.persistence import config_repositories as cfg_repo

PRIMARY_KEY = "knowledge.primary"
DEFAULT_EMBEDDING_KEY = "knowledge.owned.default_embedding_model"
PrimaryMode = Literal["owned", "vault", "auto"]


def get_primary() -> PrimaryMode:
    raw = cfg_repo.get_app_setting(PRIMARY_KEY)
    val = str(raw or "owned").strip().lower()
    if val in ("owned", "vault", "auto"):
        return val  # type: ignore[return-value]
    return "owned"


def set_primary(mode: str) -> PrimaryMode:
    val = str(mode or "owned").strip().lower()
    if val not in ("owned", "vault", "auto"):
        raise ValueError("primary must be owned|vault|auto")
    cfg_repo.set_app_setting(PRIMARY_KEY, val)
    return val  # type: ignore[return-value]


def get_default_embedding_model() -> str:
    raw = cfg_repo.get_app_setting(DEFAULT_EMBEDDING_KEY)
    return str(raw or "").strip()


def set_default_embedding_model(ref: str | None) -> str:
    """Store registry model ``name`` as the owned-KB default. Empty clears."""
    val = str(ref or "").strip()
    if val:
        from evoflow.knowledge.owned.embedding_bind import resolve_model_config

        if resolve_model_config(val) is None:
            raise ValueError(f"embedding model not found in registry: {val}")
    cfg_repo.set_app_setting(DEFAULT_EMBEDDING_KEY, val)
    return val


def prefer_owned(*, vault_id: str | None = None, has_owned_bases: bool = False) -> bool:
    """Decide whether Agent knowledge tools should hit owned KB first."""
    mode = get_primary()
    if mode == "vault":
        return False
    if mode == "owned":
        return bool(has_owned_bases)
    # auto: owned if any bases exist (legacy behavior)
    return bool(has_owned_bases)


def settings_payload() -> dict[str, Any]:
    from evoflow.knowledge.owned.embedding_bind import default_embedding_ref

    stored = get_default_embedding_model()
    effective = default_embedding_ref()
    return {
        "primary": get_primary(),
        "defaultEmbeddingModel": stored,
        "effectiveEmbeddingModel": effective,
    }
