"""Secrets encryption tests — ciphertext must never leak the plaintext sentinel."""

from __future__ import annotations

from unittest.mock import patch

from evoflow.knowledge.vault.constants import SECRET_ENC_PREFIX
from evoflow.knowledge.vault import secrets as vault_secrets

TEST_SECRET_SHOULD_NEVER_APPEAR = "TEST_SECRET_SHOULD_NEVER_APPEAR"


def test_put_get_encrypt_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setenv("EVOFLOW_KB_RUNTIME_ROOT", str(tmp_path / "kb-mcp"))
    store: dict = {}

    def _get(_key):
        return store.get("secrets")

    def _set(_key, value):
        store["secrets"] = value

    with (
        patch("evoflow.knowledge.vault.secrets.cfg_repo.get_app_setting", side_effect=_get),
        patch("evoflow.knowledge.vault.secrets.cfg_repo.set_app_setting", side_effect=_set),
    ):
        vault_secrets.put_secret("vault_t_obsidian_api_key", TEST_SECRET_SHOULD_NEVER_APPEAR)
        raw = store["secrets"]["vault_t_obsidian_api_key"]
        assert raw.startswith(SECRET_ENC_PREFIX)
        assert TEST_SECRET_SHOULD_NEVER_APPEAR not in raw
        assert TEST_SECRET_SHOULD_NEVER_APPEAR not in str(store)
        got = vault_secrets.get_secret("vault_t_obsidian_api_key")
        assert got == TEST_SECRET_SHOULD_NEVER_APPEAR


def test_plaintext_migration_on_get(tmp_path, monkeypatch):
    monkeypatch.setenv("EVOFLOW_KB_RUNTIME_ROOT", str(tmp_path / "kb-mcp"))
    store: dict = {"secrets": {"legacy_ref": TEST_SECRET_SHOULD_NEVER_APPEAR}}

    def _get(_key):
        return store.get("secrets")

    def _set(_key, value):
        store["secrets"] = value

    with (
        patch("evoflow.knowledge.vault.secrets.cfg_repo.get_app_setting", side_effect=_get),
        patch("evoflow.knowledge.vault.secrets.cfg_repo.set_app_setting", side_effect=_set),
    ):
        got = vault_secrets.get_secret("legacy_ref")
        assert got == TEST_SECRET_SHOULD_NEVER_APPEAR
        stored = store["secrets"]["legacy_ref"]
        assert stored.startswith(SECRET_ENC_PREFIX)
        assert TEST_SECRET_SHOULD_NEVER_APPEAR not in stored


def test_sanitize_redacts_sentinel_in_errors():
    from evoflow.knowledge.vault.sanitize import sanitize_text, sanitize_obj

    msg = f"connect failed OBSIDIAN_API_KEY={TEST_SECRET_SHOULD_NEVER_APPEAR} detail"
    cleaned = sanitize_text(msg)
    assert TEST_SECRET_SHOULD_NEVER_APPEAR not in cleaned
    payload = sanitize_obj(
        {
            "error": msg,
            "obsidianApiKey": TEST_SECRET_SHOULD_NEVER_APPEAR,
            "nested": {"token": TEST_SECRET_SHOULD_NEVER_APPEAR},
        }
    )
    blob = str(payload)
    assert TEST_SECRET_SHOULD_NEVER_APPEAR not in blob
