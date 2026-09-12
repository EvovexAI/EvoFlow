"""Provider registry & public embedding API.

This is the single entry point the rest of the codebase imports:

.. code-block:: python

    from evoflow.knowledge.embedding import get_embedding, get_embeddings

It resolves which backend (cloud vs local) to use from the active
:class:`ModelConfig`, wraps calls in an LRU cache, and validates dimensions.

Provider selection rules
------------------------
* ``vendor == "local"`` → :class:`LocalEmbeddingProvider`
  (sentence-transformers, offline after first download)
* model id contains ``"/"`` and looks like a HF repo (``org/name``) and
  ``base_url`` is empty → :class:`LocalEmbeddingProvider`
* otherwise → :class:`CloudEmbeddingProvider`
  (OpenAI-compatible embeddings URL via ``openai_compat_embeddings_url``)

This lets users add an embedding model in Settings → Models with either a
remote base_url + api_key (cloud) or ``vendor: local`` + a HF model id
(local) — no code changes needed.
"""

from __future__ import annotations

import logging

from evoflow.config.app_config import get_app_config
from evoflow.config.model_config import ModelConfig
from evoflow.knowledge.embedding.base import (
    DEFAULT_EMBEDDING_DIM,
    DEFAULT_EMBEDDING_MODEL,
    MAX_BATCH_SIZE,
    EmbeddingDimensionError,
    EmbeddingError,
    EmbeddingProvider,
    _cache,
    _cache_key,
)
from evoflow.knowledge.embedding.cloud_provider import CloudEmbeddingProvider
from evoflow.knowledge.embedding.local_provider import LocalEmbeddingProvider

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Config resolution
# ---------------------------------------------------------------------------

def get_embedding_config() -> ModelConfig:
    """Resolve the embedding model config from the EvoFlow model store.

    Looks for a model whose ``name`` or ``model`` field contains
    ``"embedding"``. If none is found, returns a minimal default config
    (cloud, ``text-embedding-3-small``) with a warning.

    Returns:
        A :class:`ModelConfig` with ``model`` populated (and ``base_url`` /
        ``api_key`` when configured).
    """
    try:
        cfg = get_app_config()
        models = getattr(cfg, "models", None) or []
    except Exception:
        models = []

    for m in models:
        name_lower = (getattr(m, "name", "") or "").lower()
        model_lower = (getattr(m, "model", "") or "").lower()
        vendor_lower = str(getattr(m, "vendor", "") or "").strip().lower()
        # Match by name/model containing "embedding", OR an explicit local
        # model (vendor=local models are almost always embedding models in
        # the current EvoFlow setup — there is no local chat LLM yet).
        if "embedding" in name_lower or "embedding" in model_lower or vendor_lower == "local":
            logger.debug("Using embedding model config: %s", m.name)
            return m

    logger.warning(
        "No embedding model found in config. Using default '%s' (dim=%d). "
        "Configure an embedding model in Settings → Models for best results.",
        DEFAULT_EMBEDDING_MODEL,
        DEFAULT_EMBEDDING_DIM,
    )
    return ModelConfig(
        name=DEFAULT_EMBEDDING_MODEL,
        model=DEFAULT_EMBEDDING_MODEL,
        vendor="openai",
        base_url="",
        api_key="",
        use="langchain_openai:ChatOpenAI",
    )


def resolve_embedding_model_config(identifier: str) -> ModelConfig | None:
    """Resolve a configured embedding model by config name, model id, or display name."""
    ident = str(identifier or "").strip()
    if not ident:
        return None
    try:
        cfg = get_app_config()
    except Exception:
        return None

    mc = cfg.get_model_config(ident)
    if mc is not None:
        return mc

    ident_lower = ident.lower()
    for m in getattr(cfg, "models", None) or []:
        name = str(getattr(m, "name", "") or "").strip()
        model_id = str(getattr(m, "model", "") or "").strip()
        display = str(getattr(m, "display_name", "") or "").strip()
        if ident in (name, model_id, display):
            return m
        if ident_lower in (name.lower(), model_id.lower(), display.lower()):
            return m
    return None


def _is_local_config(mc: ModelConfig) -> bool:
    """Decide whether a model config should use the local backend.

    True when:
    * ``vendor == "local"`` (explicit), or
    * the model id looks like a Hugging Face repo (``org/name``) AND no
      ``base_url`` is set (so it's not a cloud endpoint that happens to use
      a slash in its model id).
    """
    vendor = str(getattr(mc, "vendor", "") or "").strip().lower()
    if vendor == "local":
        return True
    model_id = str(getattr(mc, "model", "") or "").strip()
    base_url = str(getattr(mc, "base_url", "") or "").strip()
    # HF repo id pattern: "org/model-name" with no scheme/host.
    if "/" in model_id and not base_url and not model_id.startswith(("http://", "https://")):
        return True
    return False


def _resolve_provider(mc: ModelConfig) -> EmbeddingProvider:
    """Pick the right provider for a model config."""
    if _is_local_config(mc):
        return LocalEmbeddingProvider(mc)
    return CloudEmbeddingProvider(mc)


# ---------------------------------------------------------------------------
# Public API (LRU-cached)
# ---------------------------------------------------------------------------

async def get_embedding(
    text: str,
    model_config: ModelConfig | None = None,
    *,
    expected_dim: int | None = None,
) -> list[float]:
    """Embed a single text string into a dense float vector.

    Results are cached: identical (text, model) pairs skip the backend call.

    Args:
        text: The input text to embed.
        model_config: Optional model config override. If ``None``, uses
            :func:`get_embedding_config`.
        expected_dim: If provided, validates the returned vector dimension.

    Returns:
        A list of floats (the embedding vector).

    Raises:
        EmbeddingError: On backend errors (network, auth, local load failure).
        EmbeddingDimensionError: If ``expected_dim`` is set and mismatched.
    """
    results = await get_embeddings([text], model_config, expected_dim=expected_dim)
    return results[0]


async def get_embeddings(
    texts: list[str],
    model_config: ModelConfig | None = None,
    *,
    expected_dim: int | None = None,
    batch_size: int = MAX_BATCH_SIZE,
) -> list[list[float]]:
    """Embed multiple texts into dense float vectors.

    Cache-aware: only texts not present in the LRU cache are sent to the
    backend; cached results are merged back in order.

    Args:
        texts: List of input strings.
        model_config: Optional model config override.
        expected_dim: If provided, validates every returned vector dimension.
        batch_size: Max texts per backend call (default 100).

    Returns:
        List of embedding vectors, one per input text, in the same order.

    Raises:
        EmbeddingError: On backend errors.
        EmbeddingDimensionError: On dimension mismatch.
        ValueError: If ``texts`` is empty.
    """
    if not texts:
        raise ValueError("texts must not be empty")

    mc = model_config or get_embedding_config()
    provider = _resolve_provider(mc)
    model_name = provider.model_name

    # 1) Partition into cached vs uncached.
    results: list[list[float] | None] = [None] * len(texts)
    uncached_idx: list[int] = []
    uncached_texts: list[str] = []
    for i, t in enumerate(texts):
        key = _cache_key(t, model_name)
        hit = _cache.get(key)
        if hit is not None:
            results[i] = hit
        else:
            uncached_idx.append(i)
            uncached_texts.append(t)

    if not uncached_texts:
        return [r for r in results if r is not None]  # all cached

    # 2) Call backend for uncached texts in batches.
    bs = max(1, min(batch_size, MAX_BATCH_SIZE))
    fetched: list[list[float]] = []
    for i in range(0, len(uncached_texts), bs):
        batch = uncached_texts[i : i + bs]
        batch_vecs = await provider.embed_batch(batch)
        if len(batch_vecs) != len(batch):
            raise EmbeddingError(
                f"Embedding backend returned {len(batch_vecs)} vectors "
                f"for {len(batch)} inputs"
            )
        fetched.extend(batch_vecs)

    # 3) Dimension validation + write back to cache + merge into results.
    for j, vec in enumerate(fetched):
        if expected_dim is not None and len(vec) != expected_dim:
            raise EmbeddingDimensionError(
                f"Embedding dimension mismatch at index {uncached_idx[j]}: "
                f"expected {expected_dim}, got {len(vec)}"
            )
        results[uncached_idx[j]] = vec
        _cache.set(_cache_key(uncached_texts[j], model_name), vec)

    # 4) Final assembly (all slots now filled).
    out: list[list[float]] = []
    for r in results:
        if r is None:  # pragma: no cover - defensive
            raise EmbeddingError("Internal error: unfilled embedding slot")
        out.append(r)
    return out


# ---------------------------------------------------------------------------
# Dimension detection
# ---------------------------------------------------------------------------

# Known model → dimension map for fast (non-probing) resolution.
# Add entries here when you introduce new local/embedding models so that
# knowledge-base creation can pick the right dimension without a live call.
_KNOWN_DIMS: dict[str, int] = {
    # Cloud (OpenAI-compatible)
    "text-embedding-3-small": 1536,
    "text-embedding-3-large": 3072,
    "text-embedding-ada-002": 1536,
    # Local (sentence-transformers / BGE)
    "baai/bge-small-zh-v1.5": 512,
    "baai/bge-base-zh-v1.5": 768,
    "baai/bge-large-zh-v1.5": 1024,
    "baai/bge-m3": 1024,
    "bge-small-zh-v1.5": 512,
    "bge-base-zh-v1.5": 768,
    "bge-large-zh-v1.5": 1024,
    "bge-m3": 1024,
    "nomic-ai/nomic-embed-text-v1.5": 768,
}


def known_embedding_dim(model_id: str) -> int | None:
    """Return the vector dimension for a known model id, or ``None`` if unknown.

    Lookups are case-insensitive so ``BAAI/bge-small-zh-v1.5`` and
    ``baai/bge-small-zh-v1.5`` both match.
    """
    if not model_id:
        return None
    key = model_id.strip().lower()
    return _KNOWN_DIMS.get(key)


async def detect_embedding_dim(
    model_config: ModelConfig | None = None,
    *,
    fallback: int = DEFAULT_EMBEDDING_DIM,
) -> int:
    """Detect the output dimension of the active embedding model.

    Resolution order:
    1. If the model id is in :data:`_KNOWN_DIMS`, return that (fast, no call).
    2. Otherwise embed a probe string and return ``len(vec)``.
    3. If probing fails, return ``fallback`` (default 1536) with a warning.

    This lets knowledge-base creation auto-pick the right dimension without
    forcing the user to know it in advance.
    """
    mc = model_config or get_embedding_config()
    model_id = (getattr(mc, "model", "") or "").strip()

    # 1) Fast path — known model.
    known = known_embedding_dim(model_id)
    if known is not None:
        return known

    # 2) Probe path — run one embedding and read its length.
    try:
        vec = await get_embedding("dimension probe", mc)
        if vec:
            return len(vec)
    except Exception as exc:
        logger.warning(
            "Embedding dimension probe failed for '%s' (%s); "
            "falling back to dim=%d. The KB will be created with this "
            "dimension — make sure your embedding model matches.",
            model_id,
            exc,
            fallback,
        )

    # 3) Fallback.
    return fallback

