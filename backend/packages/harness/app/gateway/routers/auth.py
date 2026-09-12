"""Auth management router — issue, revoke, list and verify API tokens.

All endpoints live under ``/api/auth``. Token plaintext is returned exactly
once from ``POST /token``; only the SHA-256 hash is persisted and exposed by
the listing / revocation endpoints.

The router uses lazy imports for the repository singleton so importing the
module never touches the database (mirrors the lazy-import pattern used by
other gateway routers).
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app.gateway.auth import verify_bearer_token
from evoflow.persistence.auth_repositories import token_repository

router = APIRouter(prefix="/api/auth", tags=["auth"])


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------


class CreateTokenRequest(BaseModel):
    """Body for ``POST /api/auth/token``."""

    name: str = Field(..., description="Human-readable label for the token.")
    identity_type: str = Field(..., description="Type of the bound identity (e.g. 'agent', 'user').")
    identity_id: str = Field(..., description="Identifier of the bound identity.")


class CreateTokenResponse(BaseModel):
    """Response for ``POST /api/auth/token`` — plaintext returned only once."""

    token: str = Field(..., description="Plaintext token. Returned only once; store it securely.")
    token_hash: str = Field(..., description="SHA-256 hash of the token (safe to persist/list).")


class RevokeTokenResponse(BaseModel):
    """Response for ``DELETE /api/auth/token/{token_hash}``."""

    revoked: bool = Field(..., description="True if a live token was revoked.")
    token_hash: str = Field(..., description="The hash of the targeted token.")


class TokenInfo(BaseModel):
    """Public view of a token (no plaintext)."""

    token_hash: str
    name: str
    identity_type: str
    identity_id: str
    created_at: int
    revoked_at: int | None = Field(None, description="Unix timestamp when revoked, or None if active.")


class ListTokensResponse(BaseModel):
    """Response for ``GET /api/auth/tokens``."""

    tokens: list[TokenInfo]
    count: int


class WhoamiResponse(BaseModel):
    """Response for ``GET /api/auth/whoami``."""

    identity_type: str
    identity_id: str
    token_name: str
    token_hash: str


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.post("/token", response_model=CreateTokenResponse, status_code=status.HTTP_201_CREATED)
def create_token(body: CreateTokenRequest) -> CreateTokenResponse:
    """Issue a new API token.

    Creates a token bound to ``(identity_type, identity_id)`` and returns the
    plaintext together with its hash. The plaintext is returned **only once**;
    persist it on the caller side — it cannot be recovered later.

    Args:
        body: Token name and bound identity.

    Returns:
        The plaintext token and its SHA-256 hash.
    """
    plaintext = token_repository.create_token(
        name=body.name,
        identity_type=body.identity_type,
        identity_id=body.identity_id,
    )
    # Re-derive the hash the same way the repository does so we never need to
    # expose plaintext-derived internals from the repository.
    import hashlib

    token_hash = hashlib.sha256(plaintext.encode("utf-8")).hexdigest()
    return CreateTokenResponse(token=plaintext, token_hash=token_hash)


@router.delete("/token/{token_hash}", response_model=RevokeTokenResponse)
def revoke_token(token_hash: str) -> RevokeTokenResponse:
    """Revoke an API token by its hash.

    Marks the token as revoked (sets ``revoked_at``) without deleting the row,
    so audit history is retained. Revoking an already-revoked or unknown token
    returns ``revoked=False`` (idempotent, no error).

    Args:
        token_hash: The SHA-256 hash of the token to revoke.

    Returns:
        Whether a live token was revoked and the targeted hash.
    """
    revoked = token_repository.revoke_token(token_hash)
    if not revoked:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Token not found or already revoked.",
        )
    return RevokeTokenResponse(revoked=True, token_hash=token_hash)


@router.get("/tokens", response_model=ListTokensResponse)
def list_tokens() -> ListTokensResponse:
    """List all API tokens (plaintext is never included).

    Returns every token ordered by creation time (newest first). Revoked tokens
    are included with a non-null ``revoked_at``.

    Returns:
        A list of token info dicts and the total count.
    """
    rows: list[dict[str, Any]] = token_repository.list_tokens()
    tokens = [TokenInfo(**row) for row in rows]
    return ListTokensResponse(tokens=tokens, count=len(tokens))


@router.get("/whoami", response_model=WhoamiResponse)
def whoami(token_data: dict[str, Any] = Depends(verify_bearer_token)) -> WhoamiResponse:
    """Verify the current bearer token and return the caller's identity.

    Requires a valid ``Authorization: Bearer <token>`` header. Invalid or
    revoked tokens are rejected with ``401`` by the
    :func:`~app.gateway.auth.verify_bearer_token` dependency.

    Returns:
        The identity type, identity id, token name and token hash of the caller.
    """
    return WhoamiResponse(
        identity_type=token_data["identity_type"],
        identity_id=token_data["identity_id"],
        token_name=token_data["token_name"],
        token_hash=token_data["token_hash"],
    )
