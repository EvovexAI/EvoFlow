"""Bearer-token authentication dependency for the open-capability gateway.

Exposes :func:`verify_bearer_token` — a FastAPI dependency that extracts the
``Authorization: Bearer <token>`` header, verifies it against
:class:`evoflow.persistence.auth_repositories.TokenRepository`, and returns the
caller's identity record. Missing / malformed / unknown / revoked tokens all
raise ``401 Unauthorized`` (with ``WWW-Authenticate: Bearer``) so the open
capability bus (``/v1/tools``, ``/mcp``, ``/api/auth/whoami``) shares a single
auth gate.

``authorization`` is declared with ``Header(default=None)`` (not ``Header(...)``)
so a missing header yields ``401`` rather than FastAPI's ``422`` validation
error, keeping the contract uniform for clients.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from fastapi import Depends, Header, HTTPException, status

from evoflow.persistence.auth_repositories import token_repository

logger = logging.getLogger(__name__)

# Scheme prefix expected on the Authorization header.
_BEARER_PREFIX = "Bearer "


@dataclass
class CallerCtx:
    """Lightweight caller-context snapshot derived from a verified token.

    Mirrors the fields needed by the REST/MCP adapters to build a
    :class:`evoflow.capability.CallerCtx`. Kept as a plain dataclass (not the
    capability model) so this module has no hard dependency on the capability
    package at import time.
    """

    identity_type: str
    identity_id: str
    token_name: str
    token_hash: str


def verify_bearer_token(
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    """Validate the ``Authorization: Bearer <token>`` header.

    Extracts the bearer token, verifies it via
    :meth:`TokenRepository.verify_token`, and returns the caller's identity
    record. Raises ``401 Unauthorized`` when the header is missing, malformed,
    or the token is unknown / revoked.

    Args:
        authorization: Raw value of the ``Authorization`` header (``None`` when
            absent — declared with ``Header(default=None)`` so a missing header
            returns ``401`` instead of FastAPI's ``422``).

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

    out = {
        "identity_type": str(record["identity_type"]),
        "identity_id": str(record["identity_id"]),
        "token_name": str(record["name"]),
        "token_hash": str(record["token_hash"]),
    }
    if record.get("pinned_version") is not None:
        try:
            out["pinned_version"] = int(record["pinned_version"])
        except (TypeError, ValueError):
            out["pinned_version"] = None
    else:
        out["pinned_version"] = None
    return out



# Convenience alias for routes that only need the auth gate (no caller ctx).
require_auth = Depends(verify_bearer_token)


def verify_capability_bearer_token(
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    """Like :func:`verify_bearer_token`, but rejects app-scoped keys (``identity_type=app``).

    App keys are reserved for ``POST /v1/chat/completions`` and must not access
    the capability bus (``/v1/tools``, ``/mcp``).
    """
    data = verify_bearer_token(authorization)
    if str(data.get("identity_type") or "") == "app":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="App API keys cannot access /v1/tools or /mcp; use POST /v1/chat/completions.",
        )
    return data


def verify_app_bearer_token(
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    """Require a bearer token bound to an application (``identity_type=app``)."""
    data = verify_bearer_token(authorization)
    if str(data.get("identity_type") or "") != "app":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This endpoint requires an app API key (identity_type=app).",
        )
    if not str(data.get("identity_id") or "").strip():
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="App API key is missing a bound app id.",
        )
    return data


def get_caller_ctx(
    token_data: dict[str, Any] = Depends(verify_bearer_token),
) -> CallerCtx:
    """Build a :class:`CallerCtx` from a verified token.

    Args:
        token_data: The identity dict returned by :func:`verify_bearer_token`.

    Returns:
        A :class:`CallerCtx` populated with the caller's identity fields.
    """
    return CallerCtx(
        identity_type=str(token_data.get("identity_type", "")),
        identity_id=str(token_data.get("identity_id", "")),
        token_name=str(token_data.get("token_name", "")),
        token_hash=str(token_data.get("token_hash", "")),
    )
