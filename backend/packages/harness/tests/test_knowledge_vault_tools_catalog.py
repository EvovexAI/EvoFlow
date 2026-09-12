"""Dynamic Knowledge Vault tool catalog registration."""

from __future__ import annotations

from unittest.mock import patch

from evoflow.knowledge.vault.models import AccessMode, KnowledgeVaultConfig
from evoflow.tools.tools import (
    _knowledge_vault_tools_for_catalog,
    invalidate_available_tools_cache,
)


def _vault(vid: str, *, enabled: bool = True, mode: AccessMode = AccessMode.read_only) -> KnowledgeVaultConfig:
    return KnowledgeVaultConfig.model_validate(
        {
            "id": vid,
            "name": vid,
            "vaultPath": "/tmp/vault",
            "enabled": enabled,
            "accessMode": mode.value,
        }
    )


def test_catalog_empty_when_no_enabled_vaults():
    with patch(
        "evoflow.knowledge.vault.store.list_vault_configs",
        return_value=[_vault("a", enabled=False)],
    ):
        tools = _knowledge_vault_tools_for_catalog()
    assert tools == []


def test_catalog_single_knowledge_tool_for_read_only():
    with patch(
        "evoflow.knowledge.vault.store.list_vault_configs",
        return_value=[_vault("a", mode=AccessMode.read_only)],
    ):
        tools = _knowledge_vault_tools_for_catalog()
    names = {t.name for t in tools}
    assert names == {"knowledge"}


def test_catalog_still_single_tool_when_read_write():
    with patch(
        "evoflow.knowledge.vault.store.list_vault_configs",
        return_value=[
            _vault("ro", mode=AccessMode.read_only),
            _vault("rw", mode=AccessMode.read_write),
        ],
    ):
        tools = _knowledge_vault_tools_for_catalog()
    names = {t.name for t in tools}
    assert names == {"knowledge"}


def test_invalidate_cache_callable():
    invalidate_available_tools_cache()  # should not raise
