"""User profile admin — asset-center dimensions (basic-info / preferences / persona)."""

from __future__ import annotations

from typing import Any

from evoflow.assets.hub import read_profile
from evoflow.assets.paths import EntityRef, sanitize_user_asset_id
from evoflow.assets.user_profile_dims import (
    ensure_user_profile_files,
    read_user_profile_dimensions,
    update_profile_dimension,
)


def _user_entity(principal_id: str = "") -> EntityRef:
    """Per-principal user bucket when authenticated, shared bucket otherwise."""
    pid = str(principal_id or "").strip()
    if pid:
        return EntityRef("user", sanitize_user_asset_id(pid)).normalized()
    return EntityRef("user", "user").normalized()


def get_user_profile(*, principal_id: str = "") -> dict[str, Any]:
    """Return user profile dimension files (asset center SoT)."""
    entity = _user_entity(principal_id)
    ensure_user_profile_files(entity)
    dims = read_user_profile_dimensions(max_chars_per_dim=8000, entity=entity)
    return {
        "dimensions": dims,
        "fields": read_profile(entity).get("fields") or {},
        "hint": "资产中心 #/assets → 画像；对话写入用 assets(action=profile, path=basic-info|preferences|persona)",
    }


def update_user_profile_dimension(
    dimension: str,
    content: str,
    *,
    mode: str = "append",
    principal_id: str = "",
) -> dict[str, Any]:
    """Append or replace one profile dimension (new asset-center API)."""
    entity = _user_entity(principal_id)
    result = update_profile_dimension(
        dimension=dimension,
        content=content,
        mode=mode,
        entity=entity,
    )
    return {"ok": True, **result, **get_user_profile(principal_id=principal_id)}
