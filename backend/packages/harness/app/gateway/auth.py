"""Bearer-token authentication dependencies for the gateway HTTP layer.

Provides :func:`verify_bearer_token`, a FastAPI dependency that extracts a
``Bearer`` token from the ``Authorization`` header, validates it via
:class:`evoflow.persistence.auth_repositories.TokenRepository`, and returns the
caller's identity dict. Invalid or revoked tokens raise ``HTTPException(401)``.

Usage in a router::

    from app.gateway.auth import require_auth

    @router.get("/protected", dependencies=[Depends(require_auth)])
    async def protected(token_data: dict = Depends(require_auth)) -> dict:
        return {"caller": token_data}
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from fastapi import Depends, Header, HTTPException, status

from evoflow.persistence.auth_repositories import token_repository

# Scheme prefix expected on the Authorization header.
_BEARER_PREFIX = "Bearer "


@dataclass(frozen=True)
class CallerCtx:
    """Lightweight caller context derived from a verified token.

    Attributes:
        identity_type: Type of the bound identity (e.g. ``"agent"``, ``"user"``).
        identity_id: Identifier of the bound identity.
        token_name: Human-readable label of the presenting token.
        token_hash: SHA-256 hash of the presenting token (for audit logging).
    """

    identity_type: str
    identity_id: str
    token_name: str
    token_hash: str


def verify_bearer_token(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    """Validate the ``Authorization: Bearer <token>`` header.

    Extracts the bearer token, looks it up via
    :meth:`TokenRepository.verify_token`, and returns the token's identity
    record. Raises ``401 Unauthorized`` when the header is missing, malformed,
    or the token is unknown / revoked.

    Args:
        authorization: Raw value of the ``Authorization`` header (FastAPI
            injects this automatically). May be ``None`` when the header is
            absent, in which case a ``401`` is raised (rather than FastAPI's
            default ``422`` for a missing required header).

    Returns:
        A dict with ``identity_type``, ``identity_id``, ``token_name`` and
        ``token_hash`` describing the authenticated caller.

    Raises:
        HTTPException: 401 when authentication fails.
    """
    if not authorization or not authorization.startswith(_BEARER_PREFIX):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or malformed Authorization header; expected 'Bearer <token>'.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    plaintext = authorization[len(_BEARER_PREFIX):].strip()
    if not plaintext:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Empty bearer token.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    record = token_repository.verify_token(plaintext)
    if record is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or revoked token.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    # Normalize to the downstream contract: identity_type / identity_id /
    # token_name plus token_hash for audit. The repository returns ``name``
    # for the human-readable label.
    return {
        "identity_type": str(record["identity_type"]),
        "identity_id": str(record["identity_id"]),
        "token_name": str(record["name"]),
        "token_hash": str(record["token_hash"]),
    }


# Convenience alias so routes can write ``Depends(require_auth)``.
require_auth = Depends(verify_bearer_token)


def get_caller_ctx(token_data: dict[str, Any] = Depends(verify_bearer_token)) -> CallerCtx:
    """Build a :class:`CallerCtx` from a verified token dependency.

    Useful as a single dependency when a handler needs the caller's identity
    in a typed, attribute-accessible form::

        @router.get("/me")
        async def me(ctx: CallerCtx = Depends(get_caller_ctx)) -> dict:
            return {"identity_type": ctx.identity_type, "identity_id": ctx.identity_id}
    """
    return CallerCtx(
        identity_type=token_data["identity_type"],
        identity_id=token_data["identity_id"],
        token_name=token_data["token_name"],
        token_hash=token_data["token_hash"],
    )
