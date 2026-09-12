"""Hugging Face Hub environment bootstrap for local embedding downloads.

Must run before ``huggingface_hub`` / ``sentence_transformers`` are imported so
``constants.ENDPOINT`` picks up the mirror (critical on networks that block
huggingface.co).

If hub was already imported (common when gateway modules pull it in transitively),
also patch ``constants.ENDPOINT`` in-place — env alone is ignored after import.
"""

from __future__ import annotations

import os
import sys
from urllib.parse import urlsplit

_DEFAULT_MIRROR = "https://hf-mirror.com"
_DEFAULT_HUB = "https://huggingface.co"


def _patch_hub_constants(endpoint: str) -> None:
    """Update already-imported ``huggingface_hub.constants`` to use *endpoint*."""
    mod = sys.modules.get("huggingface_hub.constants")
    if mod is None:
        return
    endpoint = endpoint.rstrip("/")
    mod.ENDPOINT = endpoint
    if hasattr(mod, "HUGGINGFACE_CO_URL_TEMPLATE"):
        mod.HUGGINGFACE_CO_URL_TEMPLATE = (
            endpoint + "/{repo_id}/resolve/{revision}/{filename}"
        )
    host = urlsplit(endpoint).hostname
    if host and hasattr(mod, "HF_URL_HOSTS"):
        try:
            mod.HF_URL_HOSTS = frozenset(set(mod.HF_URL_HOSTS) | {host.lower()})
        except Exception:
            pass


def ensure_hf_hub_env(*, mirror: str = _DEFAULT_MIRROR) -> str:
    """Ensure HF hub downloads use a reachable endpoint.

    ``setdefault`` alone is insufficient when ``HF_ENDPOINT`` is empty or still
    points at huggingface.co. Returns the effective endpoint URL.
    """
    mirror_url = (mirror or _DEFAULT_MIRROR).strip().rstrip("/")
    raw = (os.environ.get("HF_ENDPOINT") or "").strip().rstrip("/")
    if not raw or raw == _DEFAULT_HUB:
        os.environ["HF_ENDPOINT"] = mirror_url
        raw = mirror_url
    # Keep legacy alias some tooling still reads.
    os.environ.setdefault("HUGGINGFACE_HUB_ENDPOINT", raw)
    _patch_hub_constants(raw)
    return raw


def hf_hub_endpoint() -> str:
    return ensure_hf_hub_env()
