"""Entity Asset Hub — file-backed profile, memory, and craft under ``~/.evoflow/assets/``."""

from evoflow.assets.hub import (
    ensure_assets_tree,
    list_entities,
    list_tree,
    read_text_file,
    write_text_file,
)
from evoflow.assets.paths import (
    BUILTIN_ASSET_VAULT_ID,
    EntityRef,
    assets_root,
    entity_root,
    profile_path,
    resolve_entity_file,
)

__all__ = [
    "BUILTIN_ASSET_VAULT_ID",
    "EntityRef",
    "assets_root",
    "entity_root",
    "ensure_assets_tree",
    "list_entities",
    "list_tree",
    "profile_path",
    "read_text_file",
    "resolve_entity_file",
    "write_text_file",
]
