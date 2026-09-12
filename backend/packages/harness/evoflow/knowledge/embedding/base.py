"""Embedding abstraction layer for the evoflow knowledge base (RAG).

Provides:
* Error types — EmbeddingError / EmbeddingDimensionError
* EmbeddingProvider ABC — unified interface for cloud and local backends
* EmbeddingLRUCache — simple in-memory cache so re-embedding identical
  texts (e.g. unchanged chunks during re-indexing) is free

Design goals
------------
* **Provider-agnostic**: callers (service.py / processor.py) only see
  ``get_embedding`` / ``get_embeddings``; the backend (cloud API vs local
  sentence-transformers) is chosen by :mod:`registry` based on ModelConfig.
* **Lazy & fault-tolerant**: local backends are imported lazily; a missing
  optional dependency produces a clear error, not a crash.
* **Cache-friendly**: identical texts are served from an LRU cache.
* **Inspired by the legacy voice module's embedding-local.js**: lazy singletons, LRU
  cache, silent-fail → caller handles, CLS pooling + L2 normalize for BGE.
"""

from __future__ import annotations

import hashlib
import logging
import re
from abc import ABC, abstractmethod
from collections import OrderedDict

from evoflow.config.model_config import ModelConfig

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Defaults & constants
# ---------------------------------------------------------------------------

# Cloud (OpenAI-compatible) defaults
DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small"
DEFAULT_EMBEDDING_DIM = 1536
DEFAULT_TIMEOUT = 120.0  # seconds — embedding calls can be slower than chat
# Classic OpenAI hosts omit a versioned API root; Volcengine Ark already ends in
# ``/api/v3``, ``/api/plan/v3``, ``/api/coding/v3`` — those must get ``/embeddings``
# only (never ``/v1/embeddings``), or callers hit HTTP 404.
EMBEDDINGS_PATH = "/v1/embeddings"
_OPENAI_COMPAT_VERSION_SUFFIX = re.compile(r"/v\d+/?$")
MAX_BATCH_SIZE = 100  # conservative to avoid payload-size limits on proxies


def openai_compat_embeddings_url(base_url: str, *, multimodal: bool = False) -> str:
    """Build the POST URL for an OpenAI-compatible embeddings endpoint.

    * ``https://api.openai.com`` → ``…/v1/embeddings``
    * ``https://api.openai.com/v1`` → ``…/v1/embeddings``
    * ``https://ark…/api/v3`` / ``…/api/plan/v3`` / ``…/api/coding/v3``
      → ``…/embeddings`` (or ``…/embeddings/multimodal``)

    Never produces ``…/api/v3/v1/embeddings`` (HTTP 404 on Volcengine Ark).
    """
    base = (base_url or "").strip().rstrip("/")
    if not base:
        return base
    lower = base.lower()
    if lower.endswith("/embeddings/multimodal"):
        base = base[: -len("/embeddings/multimodal")].rstrip("/")
        lower = base.lower()
    elif lower.endswith("/embeddings"):
        base = base[: -len("/embeddings")].rstrip("/")
        lower = base.lower()

    suffix = "/embeddings/multimodal" if multimodal else "/embeddings"
    if _OPENAI_COMPAT_VERSION_SUFFIX.search(base) or "/v1" in lower:
        return f"{base}{suffix}"
    return f"{base}/v1{suffix}"

# Local (sentence-transformers) defaults — used when vendor == "local"
DEFAULT_LOCAL_MODEL = "BAAI/bge-small-zh-v1.5"
DEFAULT_LOCAL_DIM = 512
DEFAULT_LOCAL_DEVICE = "cpu"
DEFAULT_LOCAL_TIMEOUT = 60.0  # local CPU inference is slower but no network

# LRU cache size for embedding results (identical text → cached vector)
_LRU_MAX_ENTRIES = 512


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------

class EmbeddingError(RuntimeError):
    """Raised on embedding errors (network, auth, rate-limit, bad response,
    local backend missing, dimension mismatch, ...)."""


class EmbeddingDimensionError(EmbeddingError):
    """Raised when the returned vector dimension does not match the expected value."""


# ---------------------------------------------------------------------------
# LRU cache
# ---------------------------------------------------------------------------

class EmbeddingLRUCache:
    """OrderedDict-based LRU cache for embedding vectors.

    Key: ``sha256(text + model + role)`` — ``role`` distinguishes query vs
    passage so BGE asymmetric prefixes don't collide.
    """

    def __init__(self, max_entries: int = _LRU_MAX_ENTRIES) -> None:
        self._max = max_entries
        self._store: OrderedDict[str, list[float]] = OrderedDict()

    def get(self, key: str) -> list[float] | None:
        if key not in self._store:
            return None
        self._store.move_to_end(key)
        return self._store[key]

    def set(self, key: str, value: list[float]) -> None:
        if key in self._store:
            self._store.move_to_end(key)
        self._store[key] = value
        while len(self._store) > self._max:
            self._store.popitem(last=False)

    def clear(self) -> None:
        self._store.clear()

    def __len__(self) -> int:
        return len(self._store)


# Module-level singleton cache shared across all providers
_cache = EmbeddingLRUCache()


def clear_embedding_cache() -> None:
    """Clear the global embedding LRU cache."""
    _cache.clear()


def _cache_key(text: str, model: str, *, is_query: bool = False) -> str:
    """Build a stable cache key from text + model + query/passage role."""
    role = "q" if is_query else "p"
    raw = f"{text}\x00{model}\x00{role}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# Provider ABC
# ---------------------------------------------------------------------------

class EmbeddingProvider(ABC):
    """Abstract base for embedding backends.

    A provider is bound to one :class:`ModelConfig` and exposes two methods:
    ``embed`` (single) and ``embed_batch`` (multiple). Implementations may
    cache results internally; the registry-level LRU cache also wraps calls.
    """

    def __init__(self, model_config: ModelConfig) -> None:
        self.model_config = model_config
        self._model_name = (getattr(model_config, "model", "") or "").strip()

    @property
    def model_name(self) -> str:
        return self._model_name

    @abstractmethod
    async def embed(self, text: str) -> list[float]:
        """Embed a single text string into a dense float vector."""

    @abstractmethod
    async def embed_batch(self, texts: list[str]) -> list[list[float]]:
        """Embed multiple texts. Returns vectors in the same order as inputs."""
