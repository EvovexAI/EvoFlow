"""Owned knowledge base secret storage (decoupled from vault module).

Uses the shared :mod:`evoflow.persistence.secret_store` under the same
``knowledge.vault.secrets`` settings key so zero data migration is needed —
owned KBs just use a different ref prefix (``owned_<kb_id>_embedding_api_key``)
and no longer import from ``evoflow.knowledge.vault``.
"""

from __future__ import annotations

import os
from pathlib import Path

from evoflow.persistence.secret_store import SecretStore

# Keep the same settings key and key file as the legacy vault secrets module
# so existing owned KB API keys continue to work without migration.
_SETTINGS_KEY = "knowledge.vault.secrets"
_ENC_PREFIX = "enc:v1:"


def _secret_key_path() -> Path:
    """Path to the Fernet key file.

    Prefers ``EVOFLOW_KB_RUNTIME_ROOT/.secret_key`` for backwards compatibility
    with the historical vault secrets module (so existing keys keep working).
    Falls back to ``{evoflow_base}/runtime/kb-secrets.key``, checking legacy
    locations (kb-mcp/.secret_key, kb_runtime/.secret_key) first so existing
    installs don't re-encrypt everything.
    """
    override = os.getenv("EVOFLOW_KB_RUNTIME_ROOT", "").strip()
    if override:
        return Path(override).expanduser().resolve() / ".secret_key"
    from evoflow.config.paths import get_paths

    base = get_paths().base_dir
    # Check legacy locations used by the vault module (in priority order).
    legacy_candidates = [
        base / "runtime" / "kb-mcp" / ".secret_key",
        base / "kb_runtime" / ".secret_key",
    ]
    for cand in legacy_candidates:
        try:
            if cand.is_file():
                return cand
        except OSError:
            pass
    return base / "runtime" / "kb-secrets.key"


_store: SecretStore | None = None


def _get_store() -> SecretStore:
    global _store
    if _store is None:
        _store = SecretStore(
            settings_key=_SETTINGS_KEY,
            key_path=_secret_key_path(),
            enc_prefix=_ENC_PREFIX,
        )
    return _store


def embedding_key_ref(kb_id: str) -> str:
    """Standard ref name for an owned KB's embedding API key."""
    return f"owned_{str(kb_id or '').strip()}_embedding_api_key"


def put_embedding_key(kb_id: str, api_key: str) -> str:
    """Store an embedding API key for ``kb_id``. Returns the ref."""
    ref = embedding_key_ref(kb_id)
    _get_store().put(ref, str(api_key or "").strip())
    return ref


def get_embedding_key(kb_id_or_ref: str, *, is_ref: bool = False) -> str | None:
    """Return plaintext embedding API key, or ``None`` if absent.

    Pass ``is_ref=True`` when ``kb_id_or_ref`` is already a full ref string.
    """
    ref = kb_id_or_ref if is_ref else embedding_key_ref(kb_id_or_ref)
    if not ref:
        return None
    return _get_store().get(ref)


def has_embedding_key(kb_id_or_ref: str, *, is_ref: bool = False) -> bool:
    val = get_embedding_key(kb_id_or_ref, is_ref=is_ref)
    return bool(val)


def delete_embedding_key(kb_id_or_ref: str, *, is_ref: bool = False) -> None:
    ref = kb_id_or_ref if is_ref else embedding_key_ref(kb_id_or_ref)
    if not ref:
        return
    _get_store().delete(ref)
