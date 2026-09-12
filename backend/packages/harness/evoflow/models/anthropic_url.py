"""Anthropic Messages API URL helpers.

Official contract (platform.claude.com):
  - SDK / client base URL: ``https://api.anthropic.com`` (no trailing ``/v1``)
  - HTTP endpoint: ``POST /v1/messages`` → ``https://api.anthropic.com/v1/messages``

The Anthropic Python SDK appends ``/v1/messages`` to ``base_url``. Passing a base that
already ends with ``/v1`` yields ``.../v1/v1/messages``.
"""

from __future__ import annotations


def normalize_anthropic_sdk_base_url(base_url: str | None) -> str:
    """Return a base URL suitable for ChatAnthropic / anthropic.Anthropic.

    Strips a trailing ``/v1`` so the SDK does not double the version segment.
    """
    url = str(base_url or "").strip().rstrip("/")
    if not url:
        return ""
    if url.endswith("/v1"):
        url = url[: -len("/v1")].rstrip("/")
    return url


def anthropic_messages_http_url(base_url: str | None) -> str:
    """Full Messages API URL for raw HTTP probes (curl-equivalent).

    Accepts either SDK-style bases (``https://api.anthropic.com``) or already-versioned
    bases (``https://api.anthropic.com/v1`` / proxy ``…/v1``).
    """
    url = str(base_url or "").strip().rstrip("/")
    if not url:
        return ""
    if url.endswith("/v1"):
        return f"{url}/messages"
    return f"{url}/v1/messages"
