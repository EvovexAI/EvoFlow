"""Persist Knowledge Vault configs in evoflow_app_settings."""

from __future__ import annotations

from typing import Any

from evoflow.knowledge.vault import secrets as vault_secrets
from evoflow.knowledge.vault.constants import (
    SEARCH_SERVER_NAME_PREFIX,
    VAULTS_SETTINGS_KEY,
    WRITE_SERVER_NAME_PREFIX,
)
from evoflow.knowledge.vault.errors import VaultNotFoundError
from evoflow.knowledge.vault.models import KnowledgeVaultConfig
from evoflow.persistence import config_repositories as cfg_repo
from evoflow.timeutil import utc_now_iso_z


def _load_raw() -> list[dict[str, Any]]:
    raw = cfg_repo.get_app_setting(VAULTS_SETTINGS_KEY)
    if isinstance(raw, dict) and isinstance(raw.get("items"), list):
        return [x for x in raw["items"] if isinstance(x, dict)]
    if isinstance(raw, list):
        return [x for x in raw if isinstance(x, dict)]
    return []


def _save_raw(items: list[dict[str, Any]]) -> None:
    cfg_repo.set_app_setting(VAULTS_SETTINGS_KEY, {"items": items})


def list_vault_configs() -> list[KnowledgeVaultConfig]:
    out: list[KnowledgeVaultConfig] = []
    for item in _load_raw():
        try:
            out.append(KnowledgeVaultConfig.model_validate(item))
        except Exception:
            continue
    return out


def get_vault_config(vault_id: str) -> KnowledgeVaultConfig | None:
    vid = str(vault_id or "").strip()
    for cfg in list_vault_configs():
        if cfg.id == vid:
            return cfg
    return None


def require_vault_config(vault_id: str) -> KnowledgeVaultConfig:
    cfg = get_vault_config(vault_id)
    if cfg is None:
        raise VaultNotFoundError(f"vault not found: {vault_id}")
    return cfg


def upsert_vault_config(cfg: KnowledgeVaultConfig) -> KnowledgeVaultConfig:
    now = utc_now_iso_z()
    items = _load_raw()
    found = False
    payload = cfg.model_dump(by_alias=True, mode="json")
    if not payload.get("createdAt"):
        payload["createdAt"] = now
    payload["updatedAt"] = now
    # Ensure server names
    if not payload.get("searchServerName"):
        payload["searchServerName"] = f"{SEARCH_SERVER_NAME_PREFIX}{cfg.id}"
    if not payload.get("writeServerName"):
        payload["writeServerName"] = f"{WRITE_SERVER_NAME_PREFIX}{cfg.id}"

    new_items: list[dict[str, Any]] = []
    for item in items:
        if str(item.get("id") or "") == cfg.id:
            # Preserve createdAt
            payload["createdAt"] = item.get("createdAt") or payload["createdAt"]
            new_items.append(payload)
            found = True
        else:
            new_items.append(item)
    if not found:
        new_items.append(payload)
    _save_raw(new_items)
    return KnowledgeVaultConfig.model_validate(payload)


def delete_vault_config(vault_id: str) -> bool:
    """Delete vault *configuration* only — never touches the Obsidian vault files."""
    vid = str(vault_id or "").strip()
    items = _load_raw()
    new_items = [x for x in items if str(x.get("id") or "") != vid]
    if len(new_items) == len(items):
        return False
    _save_raw(new_items)
    vault_secrets.delete_secrets_for_vault(vid)
    return True


def public_vault_dict(cfg: KnowledgeVaultConfig) -> dict[str, Any]:
    return cfg.public_dict(
        has_obsidian_key=vault_secrets.has_secret(cfg.obsidian_api_key_secret_ref),
        has_embedding_key=vault_secrets.has_secret(cfg.embedding_api_key_secret_ref),
    )
