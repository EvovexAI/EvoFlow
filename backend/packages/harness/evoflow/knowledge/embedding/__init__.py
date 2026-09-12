"""Embedding sub-package for the evoflow knowledge base (RAG).

Unified embedding interface supporting both **cloud** (OpenAI-compatible
embeddings — ``/v1/embeddings`` or provider-versioned ``…/api/v3/embeddings``)
and **local** (sentence-transformers) backends.

Public API (drop-in replacement for the old ``embedding.py`` module):

.. code-block:: python

    from evoflow.knowledge.embedding import (
        get_embedding, get_embeddings, get_embedding_config,
        EmbeddingError, EmbeddingDimensionError,
        CloudEmbeddingProvider, LocalEmbeddingProvider,
        EmbeddingProvider, clear_embedding_cache,
    )

Backend selection is automatic from the model config:
* ``vendor: local`` (or a Hugging Face repo id with no base_url) → local
* otherwise → cloud

See :mod:`registry` for the full selection rules.
"""

from evoflow.knowledge.embedding.base import (
    DEFAULT_EMBEDDING_DIM,
    DEFAULT_EMBEDDING_MODEL,
    DEFAULT_LOCAL_DEVICE,
    DEFAULT_LOCAL_MODEL,
    EmbeddingDimensionError,
    EmbeddingError,
    EmbeddingLRUCache,
    EmbeddingProvider,
    clear_embedding_cache,
)
from evoflow.knowledge.embedding.cloud_provider import CloudEmbeddingProvider
from evoflow.knowledge.embedding.local_provider import (
    LocalEmbeddingProvider,
    clear_local_model_cache,
    local_embedding_deps_available,
    probe_local_embedding_deps,
    reconcile_local_embedding_models_for_runtime,
    warmup_local_model,
)
from evoflow.knowledge.embedding.registry import (
    detect_embedding_dim,
    get_embedding,
    get_embedding_config,
    get_embeddings,
    known_embedding_dim,
    resolve_embedding_model_config,
)

__all__ = [
    # Public API (backwards-compatible with old embedding.py)
    "get_embedding",
    "get_embeddings",
    "get_embedding_config",
    "resolve_embedding_model_config",
    # Dimension detection
    "detect_embedding_dim",
    "known_embedding_dim",
    # Errors
    "EmbeddingError",
    "EmbeddingDimensionError",
    # Providers (for advanced / testing use)
    "EmbeddingProvider",
    "CloudEmbeddingProvider",
    "LocalEmbeddingProvider",
    # Cache management
    "clear_embedding_cache",
    "EmbeddingLRUCache",
    # Local backend extras
    "warmup_local_model",
    "clear_local_model_cache",
    "local_embedding_deps_available",
    "probe_local_embedding_deps",
    "reconcile_local_embedding_models_for_runtime",
    # Constants
    "DEFAULT_EMBEDDING_MODEL",
    "DEFAULT_EMBEDDING_DIM",
    "DEFAULT_LOCAL_MODEL",
    "DEFAULT_LOCAL_DEVICE",
]
