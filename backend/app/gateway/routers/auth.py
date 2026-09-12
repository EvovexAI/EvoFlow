"""Auth management endpoints for the open-capability gateway.

Mounted at ``/api/auth``. Provides token lifecycle operations:

* ``POST /api/auth/token``     — mint a new API token (plaintext returned once)
* ``DELETE /api/auth/token/{token_hash}`` — revoke a token
* ``GET  /api/auth/tokens``    — list all tokens (no plaintext)
* ``GET  /api/auth/whoami``    — echo the caller identity of a valid token

Token issuance is intentionally unauthenticated (anyone who can reach the
gateway can mint a token); production deployments should put the gateway behind
a network boundary. ``/whoami`` requires a valid bearer token so a freshly
minted token can be round-trip verified.
"""

from __future__ import annotations

import hashlib
import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app.gateway.auth import verify_bearer_token
from evoflow.persistence.auth_repositories import token_repository

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/auth", tags=["auth"])


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------


class CreateTokenRequest(BaseModel):
    """Body for ``POST /api/auth/token``."""

    name: str = Field(..., description="Human-readable label for the token.")
    identity_type: str = Field(
        ..., description="Type of the bound identity (e.g. 'agent', 'user')."
    )
    identity_id: str = Field(
        ..., description="Identifier of the bound identity (e.g. agent code)."
    )


class CreateTokenResponse(BaseModel):
    """Response for ``POST /api/auth/token`` — plaintext is returned only here."""

    token: str = Field(..., description="The plaintext token (shown only once).")
    token_hash: str = Field(..., description="SHA-256 hash of the token.")


class RevokeTokenResponse(BaseModel):
    """Response for ``DELETE /api/auth/token/{token_hash}``."""

    revoked: bool = Field(..., description="Whether a token was actually revoked.")
    token_hash: str = Field(..., description="The hash of the targeted token.")


class TokenInfo(BaseModel):
    """Public view of a token (never includes the plaintext)."""

    token_hash: str
    name: str
    identity_type: str
    identity_id: str
    created_at: int
    revoked_at: int | None = None


class ListTokensResponse(BaseModel):
    """Response for ``GET /api/auth/tokens``."""

    tokens: list[TokenInfo]
    count: int


class WhoAmIResponse(BaseModel):
    """Response for ``GET /api/auth/whoami``."""

    identity_type: str
    identity_id: str
    token_name: str
    token_hash: str


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.post(
    "/token",
    response_model=CreateTokenResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Mint a new API token",
)
async def create_token(body: CreateTokenRequest) -> CreateTokenResponse:
    """Mint a new API token bound to ``(identity_type, identity_id)``.

    The plaintext token is returned exactly once in the response body; only its
    SHA-256 hash is persisted. Store the plaintext securely — it cannot be
    recovered later.

    Args:
        body: Token creation request (name + identity).

    Returns:
        The plaintext token and its hash.
    """
    plaintext = token_repository.create_token(
        name=body.name,
        identity_type=body.identity_type,
        identity_id=body.identity_id,
    )
    # Recompute the hash so the response is self-contained (does not rely on
    # the repository's internal hashing routine being exposed).
    token_hash = hashlib.sha256(plaintext.encode("utf-8")).hexdigest()
    logger.info(
        "Issued API token name=%s identity_type=%s identity_id=%s hash=%s",
        body.name,
        body.identity_type,
        body.identity_id,
        token_hash,
    )
    return CreateTokenResponse(token=plaintext, token_hash=token_hash)


@router.delete(
    "/token/{token_hash}",
    response_model=RevokeTokenResponse,
    summary="Revoke an API token",
)
async def revoke_token(token_hash: str) -> RevokeTokenResponse:
    """Revoke a token by its hash (sets ``revoked_at``; row is retained).

    Args:
        token_hash: The stored SHA-256 hash of the token to revoke.

    Returns:
        ``{revoked, token_hash}`` — ``revoked`` is ``False`` when the token was
        not found or was already revoked.

    Raises:
        HTTPException: 404 when the token does not exist or is already revoked.
    """
    revoked = token_repository.revoke_token(token_hash)
    if not revoked:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Token not found or already revoked.",
        )
    logger.info("Revoked API token hash=%s", token_hash)
    return RevokeTokenResponse(revoked=True, token_hash=token_hash)


@router.get(
    "/tokens",
    response_model=ListTokensResponse,
    summary="List all API tokens",
)
async def list_tokens() -> ListTokensResponse:
    """List all API tokens (newest first), never including the plaintext.

    Returns:
        ``{tokens, count}`` where each token entry is a :class:`TokenInfo`.
    """
    rows = token_repository.list_tokens()
    tokens = [TokenInfo(**row) for row in rows]
    return ListTokensResponse(tokens=tokens, count=len(tokens))


@router.get(
    "/whoami",
    response_model=WhoAmIResponse,
    summary="Echo the caller identity of a valid token",
)
async def whoami(
    token_data: dict[str, Any] = Depends(verify_bearer_token),
) -> WhoAmIResponse:
    """Return the identity bound to the presented bearer token.

    Requires a valid ``Authorization: Bearer <token>`` header — useful for
    round-trip verification of a freshly minted token.

    Args:
        token_data: The identity dict injected by :func:`verify_bearer_token`.

    Returns:
        The caller's ``identity_type``, ``identity_id``, ``token_name`` and
        ``token_hash``.
    """
    return WhoAmIResponse(
        identity_type=str(token_data["identity_type"]),
        identity_id=str(token_data["identity_id"]),
        token_name=str(token_data["token_name"]),
        token_hash=str(token_data["token_hash"]),
    )
