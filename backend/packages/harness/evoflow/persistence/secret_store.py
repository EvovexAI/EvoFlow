"""Generic encrypted key-value secret storage.

A thin, reusable wrapper around Fernet-at-rest + app-settings persistence.
Originally extracted from ``evoflow.knowledge.vault.secrets`` so that owned
knowledge bases and other modules can store API keys without depending on the
vault / Obsidian stack.

Storage format is identical to the historical vault secrets module so no data
migration is needed: values are stored as ``enc:v1:<fernet-token>`` under the
caller-supplied settings key.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Callable

from cryptography.fernet import Fernet, InvalidToken

from evoflow.persistence import config_repositories as cfg_repo

logger = logging.getLogger(__name__)

DEFAULT_ENC_PREFIX = "enc:v1:"


class SecretStore:
    """A namespaced encrypted secret store backed by app-settings.

    Parameters
    ----------
    settings_key:
        The ``app_settings`` key under which secrets are persisted as a dict.
    key_path:
        Path to the Fernet key file. Created on first write if missing.
    enc_prefix:
        Prefix used to identify ciphertext values (for plaintext migration).
    """

    def __init__(
        self,
        settings_key: str,
        key_path: str | Path,
        enc_prefix: str = DEFAULT_ENC_PREFIX,
    ) -> None:
        self._settings_key = str(settings_key or "").strip()
        if not self._settings_key:
            raise ValueError("settings_key is required")
        self._key_path = Path(key_path).expanduser().resolve()
        self._enc_prefix = enc_prefix

    # ---- key management ----

    def _load_or_create_fernet(self) -> Fernet:
        path = self._key_path
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

    # ---- crypto ----

    def _encrypt(self, value: str) -> str:
        f = self._load_or_create_fernet()
        token = f.encrypt(str(value or "").encode("utf-8")).decode("ascii")
        return f"{self._enc_prefix}{token}"

    def _decrypt(self, stored: str) -> str:
        raw = str(stored or "")
        if not raw.startswith(self._enc_prefix):
            return raw
        token = raw[len(self._enc_prefix) :].encode("ascii")
        try:
            return self._load_or_create_fernet().decrypt(token).decode("utf-8")
        except InvalidToken as exc:
            logger.error("Secret decrypt failed (key mismatch or corrupt ciphertext)")
            raise ValueError("secret decrypt failed") from exc

    # ---- persistence ----

    def _load_secrets(self) -> dict[str, str]:
        raw = cfg_repo.get_app_setting(self._settings_key)
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

    def _save_secrets(self, secrets: dict[str, str]) -> None:
        cfg_repo.set_app_setting(self._settings_key, secrets)

    # ---- public API ----

    def put(self, ref: str, value: str) -> str:
        """Store a secret under ``ref`` (encrypted). Returns the ref."""
        key = str(ref or "").strip()
        if not key:
            raise ValueError("secret ref is required")
        secrets = self._load_secrets()
        secrets[key] = self._encrypt(str(value or ""))
        self._save_secrets(secrets)
        return key

    def get(self, ref: str) -> str | None:
        """Return the plaintext secret for ``ref``, or ``None`` if absent."""
        key = str(ref or "").strip()
        if not key:
            return None
        stored = self._load_secrets().get(key)
        if stored is None:
            return None
        if not stored.startswith(self._enc_prefix):
            # Plaintext migration: encrypt on next put — migrate eagerly on read too
            try:
                self.put(key, stored)
            except Exception:
                logger.debug("secret plaintext migration deferred", exc_info=True)
            return stored
        return self._decrypt(stored)

    def has(self, ref: str) -> bool:
        val = self.get(ref)
        return bool(val)

    def delete(self, ref: str) -> None:
        key = str(ref or "").strip()
        if not key:
            return
        secrets = self._load_secrets()
        if key in secrets:
            del secrets[key]
            self._save_secrets(secrets)

    def status_map(self, refs: list[str]) -> dict[str, bool]:
        secrets = self._load_secrets()
        return {r: bool(secrets.get(r)) for r in refs if r}

    def delete_by_predicate(self, predicate: Callable[[str], bool]) -> bool:
        """Delete every secret whose key matches ``predicate``. Returns True if changed."""
        secrets = self._load_secrets()
        changed = False
        for key in list(secrets.keys()):
            if predicate(key):
                del secrets[key]
                changed = True
        if changed:
            self._save_secrets(secrets)
        return changed
