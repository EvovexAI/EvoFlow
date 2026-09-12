"""Normalize Gateway HTTP paths for observability aggregation."""

from __future__ import annotations

import re

_UUID_RE = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
    re.I,
)


def normalize_gateway_obs_path(path: str) -> str:
    """Collapse UUID segments so routes aggregate by template (``{id}``)."""
    p = str(path or "").strip() or "/"
    return _UUID_RE.sub("{id}", p)
