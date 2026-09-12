"""Knowledge Vault secret storage via evoflow_app_settings (Fernet at rest).

Ciphertext is stored as ``enc:v1:<token>``. Plaintext values are migrated on the
next ``put_secret``. Secret values are never logged.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken

from evoflow.knowledge.vault.constants import SECRET_ENC_PREFIX, SECRETS_SETTINGS_KEY
from evoflow.knowledge.vault.runtime_resolve import resolve_kb_runtime_root
from evoflow.persistence import config_repositories as cfg_repo

logger = logging.getLogger(__name__)


def _secret_key_path() -> Path:
    return resolve_kb_runtime_root() / ".secret_key"


def _load_or_create_fernet() -> Fernet:
    path = _secret_key_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_file():
        key = path.read_bytes().strip()
    else:
        key = Fernet.generate_key()
        path.write_bytes(key)
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
    return Fernet(key)


def _encrypt(value: str) -> str:
    token = _load_or_create_fernet().encrypt(str(value or "").encode("utf-8")).decode("ascii")
    return f"{SECRET_ENC_PREFIX}{token}"


def _decrypt(stored: str) -> str:
    raw = str(stored or "")
    if not raw.startswith(SECRET_ENC_PREFIX):
        return raw
    token = raw[len(SECRET_ENC_PREFIX) :].encode("ascii")
    try:
        return _load_or_create_fernet().decrypt(token).decode("utf-8")
    except InvalidToken as exc:
        logger.error("Knowledge Vault secret decrypt failed (key mismatch or corrupt ciphertext)")
        raise ValueError("secret decrypt failed") from exc


def _load_secrets() -> dict[str, str]:
    raw = cfg_repo.get_app_setting(SECRETS_SETTINGS_KEY)
    if not isinstance(raw, dict):
        return {}
    out: dict[str, str] = {}
    for k, v in raw.items():
        key = str(k or "").strip()
        if not key:
            continue
        if isinstance(v, str) and v:
            out[key] = v
    return out


def _save_secrets(secrets: dict[str, str]) -> None:
    cfg_repo.set_app_setting(SECRETS_SETTINGS_KEY, secrets)


def put_secret(ref: str, value: str) -> str:
    """Store a secret under ``ref`` (encrypted). Returns the ref."""
    key = str(ref or "").strip()
    if not key:
        raise ValueError("secret ref is required")
    secrets = _load_secrets()
    secrets[key] = _encrypt(str(value or ""))
    _save_secrets(secrets)
    return key


def get_secret(ref: str) -> str | None:
    key = str(ref or "").strip()
    if not key:
        return None
    stored = _load_secrets().get(key)
    if stored is None:
        return None
    if not stored.startswith(SECRET_ENC_PREFIX):
        # Plaintext migration: encrypt on next put — migrate eagerly on read too
        try:
            put_secret(key, stored)
        except Exception:
            logger.debug("secret plaintext migration deferred", exc_info=True)
        return stored
    return _decrypt(stored)


def has_secret(ref: str) -> bool:
    val = get_secret(ref)
    return bool(val)


def delete_secret(ref: str) -> None:
    key = str(ref or "").strip()
    if not key:
        return
    secrets = _load_secrets()
    if key in secrets:
        del secrets[key]
        _save_secrets(secrets)


def delete_secrets_for_vault(vault_id: str) -> None:
    prefix = f"vault_{vault_id}_"
    secrets = _load_secrets()
    changed = False
    for key in list(secrets.keys()):
        if key.startswith(prefix) or key.endswith(f"_{vault_id}") or f"_{vault_id}_" in key:
            del secrets[key]
            changed = True
    for suffix in ("obsidian_api_key", "embedding_api_key", "auth"):
        ref = f"vault_{vault_id}_{suffix}"
        if ref in secrets:
            del secrets[ref]
            changed = True
    if changed:
        _save_secrets(secrets)


def default_obsidian_key_ref(vault_id: str) -> str:
    return f"vault_{vault_id}_obsidian_api_key"


def default_embedding_key_ref(vault_id: str) -> str:
    return f"vault_{vault_id}_embedding_api_key"


def secret_status_map(refs: list[str]) -> dict[str, bool]:
    secrets = _load_secrets()
    return {r: bool(secrets.get(r)) for r in refs if r}
