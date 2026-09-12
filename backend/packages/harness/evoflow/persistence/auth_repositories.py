"""SQLite repository for API token authentication (``evoflow_api_tokens``).

Only the SHA-256 hash of each token is persisted; the plaintext is returned
exactly once from :meth:`TokenRepository.create_token` and never stored. Tokens
bind to an identity described by ``(identity_type, identity_id)`` and may be
revoked (set ``revoked_at``) without deletion so audit history is retained.

Database access follows the shared ``get_db()`` + ``db_connection_lock()`` /
``run_db_transaction`` pattern used across :mod:`evoflow.persistence`.
"""

from __future__ import annotations

import hashlib
import secrets
import time
from typing import Any

from evoflow.persistence.db import get_db, run_db_transaction

_TOKEN_SELECT_COLS = (
    "token_hash, name, identity_type, identity_id, created_at, revoked_at, pinned_version"
)


def _hash_token(plaintext: str) -> str:
    """Return the lowercase SHA-256 hex digest of ``plaintext``."""
    return hashlib.sha256(plaintext.encode("utf-8")).hexdigest()


def _row_dict(row: Any) -> dict[str, Any]:
    return {k: row[k] for k in row.keys()}


def _token_row_to_dict(row: Any) -> dict[str, Any]:
    """Map an ``evoflow_api_tokens`` row to a public dict."""
    d = _row_dict(row)
    pinned = d.get("pinned_version")
    return {
        "token_hash": str(d["token_hash"]),
        "name": str(d["name"]),
        "identity_type": str(d["identity_type"]),
        "identity_id": str(d["identity_id"]),
        "created_at": int(d["created_at"]),
        "revoked_at": int(d["revoked_at"]) if d.get("revoked_at") is not None else None,
        "pinned_version": int(pinned) if pinned is not None else None,
    }


class TokenRepository:
    """Repository for creating, verifying, revoking and listing API tokens.

    All methods operate on the shared ``evoflow.db`` connection via
    :func:`get_db`. Token plaintext is generated with
    :func:`secrets.token_hex` (256 bits of entropy) and only its SHA-256 hash
    is stored; the plaintext is returned from :meth:`create_token` exactly
    once and cannot be recovered.
    """

    def create_token(
        self,
        name: str,
        identity_type: str,
        identity_id: str,
        *,
        prefix: str = "",
        pinned_version: int | None = None,
    ) -> str:
        """Create a new API token and return its plaintext (returned only once).

        Args:
            name: Human-readable label for the token.
            identity_type: Type of the bound identity (e.g. ``"agent"``, ``"user"``, ``"app"``).
            identity_id: Identifier of the bound identity (e.g. agent code or app id).
            prefix: Optional plaintext prefix (e.g. ``"ef-"`` for app keys). The prefix
                is stored as part of the secret hashed by :func:`_hash_token`.
            pinned_version: Optional immutable app revision for app-scoped keys.

        Returns:
            The plaintext token string. The caller must persist it securely;
            it cannot be recovered later.
        """
        body = secrets.token_hex(32)
        plaintext = f"{prefix}{body}" if prefix else body
        token_hash = _hash_token(plaintext)
        now = int(time.time())
        pin = int(pinned_version) if pinned_version is not None else None

        def _write(db: Any) -> None:
            db.execute(
                """
                INSERT INTO evoflow_api_tokens
                    (token_hash, name, identity_type, identity_id, created_at, revoked_at, pinned_version)
                VALUES (?, ?, ?, ?, ?, NULL, ?)
                """,
                (token_hash, str(name), str(identity_type), str(identity_id), now, pin),
            )

        run_db_transaction(_write)
        return plaintext

    def create_app_token(
        self,
        name: str,
        app_id: str,
        *,
        pinned_version: int | None = None,
    ) -> str:
        """Mint an app-scoped API key (``identity_type=app``, plaintext prefix ``ef-``)."""
        return self.create_token(
            name=name,
            identity_type="app",
            identity_id=str(app_id),
            prefix="ef-",
            pinned_version=pinned_version,
        )

    def verify_token(self, plaintext: str) -> dict[str, Any] | None:
        """Verify a plaintext token and return its identity record, or ``None``.

        A token is valid only when its hash exists and ``revoked_at`` is ``NULL``.
        """
        if not plaintext:
            return None
        token_hash = _hash_token(plaintext)
        row = (
            get_db()
            .execute(
                f"""
                SELECT {_TOKEN_SELECT_COLS}
                FROM evoflow_api_tokens
                WHERE token_hash = ? AND revoked_at IS NULL
                """,
                (token_hash,),
            )
            .fetchone()
        )
        if not row:
            return None
        return _token_row_to_dict(row)

    def revoke_token(self, token_hash: str) -> bool:
        """Revoke a token by setting ``revoked_at`` to the current Unix time."""
        now = int(time.time())

        def _write(db: Any) -> bool:
            cur = db.execute(
                """
                UPDATE evoflow_api_tokens
                SET revoked_at = ?
                WHERE token_hash = ? AND revoked_at IS NULL
                """,
                (now, str(token_hash)),
            )
            return cur.rowcount > 0

        return run_db_transaction(_write)

    def list_tokens(self) -> list[dict[str, Any]]:
        """Return all API tokens ordered by creation time (newest first)."""
        rows = (
            get_db()
            .execute(
                f"""
                SELECT {_TOKEN_SELECT_COLS}
                FROM evoflow_api_tokens
                ORDER BY created_at DESC
                """
            )
            .fetchall()
        )
        return [_token_row_to_dict(row) for row in rows]

    def list_tokens_for_identity(
        self,
        identity_type: str,
        identity_id: str,
        *,
        include_revoked: bool = False,
    ) -> list[dict[str, Any]]:
        """List tokens bound to a specific identity (newest first)."""
        if include_revoked:
            rows = (
                get_db()
                .execute(
                    f"""
                    SELECT {_TOKEN_SELECT_COLS}
                    FROM evoflow_api_tokens
                    WHERE identity_type = ? AND identity_id = ?
                    ORDER BY created_at DESC
                    """,
                    (str(identity_type), str(identity_id)),
                )
                .fetchall()
            )
        else:
            rows = (
                get_db()
                .execute(
                    f"""
                    SELECT {_TOKEN_SELECT_COLS}
                    FROM evoflow_api_tokens
                    WHERE identity_type = ? AND identity_id = ? AND revoked_at IS NULL
                    ORDER BY created_at DESC
                    """,
                    (str(identity_type), str(identity_id)),
                )
                .fetchall()
            )
        return [_token_row_to_dict(row) for row in rows]


# Module-level singleton for convenience (mirrors the function-style access used
# by other repositories in this package).
token_repository = TokenRepository()
