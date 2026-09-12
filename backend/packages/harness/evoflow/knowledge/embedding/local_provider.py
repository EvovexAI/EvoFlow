"""Local embedding provider — sentence-transformers on CPU/GPU.

Activated when a model config has ``vendor == "local"`` or the model id
looks like a Hugging Face repo (``BAAI/bge-small-zh-v1.5``).

Design (inspired by the legacy voice module's ``embedding-local.js``):
* **Lazy singleton**: the ``SentenceTransformer`` pipeline is built on first
  ``embed`` and cached per model id; a failed load is NOT cached so the next
  call can retry (e.g. after a temporary network outage during download).
* **Non-blocking**: ``model.encode()`` is synchronous and CPU-bound, so it
  runs in ``asyncio.to_thread`` to avoid blocking the FastAPI event loop.
* **L2 normalize**: ``normalize_embeddings=True`` so cosine similarity ==
  dot product (matches the ``vec0`` cosine metric used by VectorStore).
* **Default dependency**: ``sentence-transformers`` is part of the harness
  install on Windows / Linux / macOS arm64 (and Windows gateway bundle).
  macOS Intel (x86_64) omits it because PyTorch no longer ships that wheel;
  a missing install still raises a clear ``EmbeddingError`` rather than
  crashing import.

Note on BGE asymmetric retrieval: BGE v1.5 models accept a query-side
instruction prefix for slightly better retrieval. We intentionally do NOT
apply it here to keep the query/passage vector space symmetric (the
VectorStore stores whatever the provider returns). If you later want
asymmetric retrieval, add an ``is_query`` flag to ``EmbeddingProvider`` and
apply the prefix in this provider only.
"""

from __future__ import annotations

import asyncio
import logging
import os
import sys
from pathlib import Path

from evoflow.config.model_config import ModelConfig
from evoflow.knowledge.embedding.hf_env import ensure_hf_hub_env
from evoflow.knowledge.embedding.base import (
    DEFAULT_LOCAL_DEVICE,
    DEFAULT_LOCAL_MODEL,
    EmbeddingError,
    EmbeddingProvider,
)

logger = logging.getLogger(__name__)

# Ensure HuggingFace mirror is used by default (critical for users in China).
# Must run before SentenceTransformer / huggingface_hub are imported.
ensure_hf_hub_env()

# Module-level lazy singleton cache: model_id -> SentenceTransformer.
# A failed load is deliberately not cached so the next call retries.
_model_cache: dict[str, object] = {}

_MISSING_ST_HINT = (
    "本地向量运行时未包含在当前安装包中（默认使用云端 embedding）。"
    "请在「设置 → 模型」选择云端向量模型；开发环境可 uv sync 后设 "
    "EVOFLOW_GATEWAY_INCLUDE_LOCAL_EMBEDDING=1 重新打包。"
)

_LEAN_LOCAL_UNAVAILABLE_REASON = (
    "本地向量模型不可用：当前桌面版未捆绑 sentence-transformers / torch。"
    "请改用云端向量模型（设置 → 模型）。"
)


def probe_local_embedding_deps() -> str | None:
    """Return ``None`` when local embedding deps import cleanly.

    Otherwise return a short reason. Broken/partial ``torch`` installs often
    raise ``AttributeError`` (e.g. ``torch`` has no attribute ``fx``) rather
    than ``ImportError`` — those must be treated as unavailable, not as a
    mysterious seed failure during gateway startup.

    ``ImportError`` / ``ModuleNotFoundError`` always include the underlying
    exception text: frozen gateway bundles may have ``sentence_transformers``
    present but miss a transitive module (e.g. ``scipy._external...fft``),
    and the generic hint alone hides the real packaging gap.
    """
    try:
        import sentence_transformers  # noqa: F401
    except ImportError as exc:
        # Lean desktop: ST is intentionally omitted — keep the user-facing
        # message short and actionable (avoid raw ModuleNotFoundError noise).
        if getattr(sys, "frozen", False):
            return _MISSING_ST_HINT
        detail = f"{type(exc).__name__}: {exc}".strip()
        if detail and detail not in _MISSING_ST_HINT:
            return f"{_MISSING_ST_HINT} ({detail})"
        return _MISSING_ST_HINT
    except Exception as exc:  # noqa: BLE001 — any import failure ⇒ unavailable
        if getattr(sys, "frozen", False):
            return _MISSING_ST_HINT
        return (
            f"Local embedding deps failed to import ({type(exc).__name__}: {exc}). "
            "Stop the gateway, then reinstall torch/sentence-transformers "
            "(cd backend && uv sync)."
        )
    return None


def local_embedding_deps_available() -> bool:
    """Return True when sentence-transformers (and torch) can be imported."""
    return probe_local_embedding_deps() is None


def reconcile_local_embedding_models_for_runtime() -> dict[str, int]:
    """Drop or demote local embedding rows when the lean runtime lacks ST/torch.

    Upgrades from older fat packages often leave ``bge-small-zh`` in Settings,
    which then shows as permanently「不可用」. Auto-seeded rows are deleted;
    other vendor=local rows are marked unavailable with a clear reason.
    """
    stats = {"deleted": 0, "marked": 0, "cleared_default": 0}
    deps_err = probe_local_embedding_deps()
    if deps_err is None:
        return stats
    try:
        from evoflow.persistence import config_repositories as cfg_repo
        from evoflow.knowledge.owned import settings as owned_settings
        from evoflow.knowledge.owned.embedding_bind import SEED_EMBEDDING_NAME

        for row in cfg_repo.list_models() or []:
            if not isinstance(row, dict):
                continue
            vendor = str(row.get("vendor") or "").strip().lower()
            if vendor != "local":
                continue
            name = str(row.get("name") or "").strip()
            if not name:
                continue
            # Auto-seeded default: remove so Settings stays clean on lean installs.
            if name == SEED_EMBEDDING_NAME or name == "bge-small-zh":
                if cfg_repo.delete_model(name):
                    stats["deleted"] += 1
                    logger.info("Removed lean-unavailable local embedding model: %s", name)
                continue
            if cfg_repo.mark_model_unavailable(
                name,
                reason=_LEAN_LOCAL_UNAVAILABLE_REASON,
                code="local_embedding_runtime_missing",
            ):
                stats["marked"] += 1

        default_ref = owned_settings.get_default_embedding_model()
        if not default_ref:
            return stats
        rows = cfg_repo.list_models() or []
        by_name = {str(r.get("name") or ""): r for r in rows if isinstance(r, dict)}
        row = by_name.get(default_ref)
        # Cleared seed, or default still points at a local vendor row.
        if row is None or str(row.get("vendor") or "").strip().lower() == "local":
            owned_settings.set_default_embedding_model("")
            stats["cleared_default"] += 1
    except Exception:
        logger.warning("reconcile local embedding models failed", exc_info=True)
    return stats


def _resolve_model_ref(model_id: str) -> str:
    """Return a filesystem path when *model_id* points at a local directory."""
    raw = str(model_id or "").strip()
    if not raw:
        return raw
    path = Path(raw).expanduser()
    if path.is_dir():
        return str(path.resolve())
    return raw


def _model_is_cached(model_id: str) -> bool:
    if _resolve_model_ref(model_id) != model_id:
        return True
    try:
        ensure_hf_hub_env()
        from huggingface_hub import try_to_load_from_cache

        for filename in ("config.json", "model.safetensors", "pytorch_model.bin"):
            if try_to_load_from_cache(model_id, filename) is not None:
                return True
    except Exception:
        return False
    return False


def _build_sentence_transformer(model_id: str, device: str):
    ensure_hf_hub_env()
    from sentence_transformers import SentenceTransformer

    resolved = _resolve_model_ref(model_id)
    if resolved != model_id:
        logger.info("Loading local embedding model from path %s", resolved)
        return SentenceTransformer(resolved, device=device)

    endpoint = ensure_hf_hub_env()
    if _model_is_cached(model_id):
        logger.info(
            "Loading cached local embedding model '%s' (offline, hub=%s)",
            model_id,
            endpoint,
        )
        return SentenceTransformer(model_id, device=device, local_files_only=True)

    logger.info(
        "Loading local embedding model '%s' on %s (first use downloads via %s)...",
        model_id,
        device,
        endpoint,
    )
    return SentenceTransformer(model_id, device=device)


def _get_device(model_config: ModelConfig) -> str:
    """Resolve device. ModelConfig has ``extra="allow"`` so users can set
    ``device: cuda`` / ``device: cpu`` as an extra field on the model config."""
    return getattr(model_config, "device", None) or DEFAULT_LOCAL_DEVICE


async def _load_model(model_id: str, device: str) -> object:
    """Load (or return cached) SentenceTransformer model — lazy + singleton."""
    if model_id in _model_cache:
        return _model_cache[model_id]

    def _build() -> object:
        try:
            from sentence_transformers import SentenceTransformer  # noqa: F401
        except ImportError as exc:  # pragma: no cover - packaging gap
            raise EmbeddingError(
                f"{_MISSING_ST_HINT} ({type(exc).__name__}: {exc})"
            ) from exc
        try:
            return _build_sentence_transformer(model_id, device)
        except Exception as exc:
            endpoint = ensure_hf_hub_env()
            raise EmbeddingError(
                f"Failed to load local embedding model '{model_id}': {exc}. "
                f"Hub endpoint={endpoint}. "
                "If downloads fail, set HF_ENDPOINT=https://hf-mirror.com, "
                "pre-download the model, or point model config to a local folder."
            ) from exc

    # Build off the event loop so imports / downloads don't block it.
    model = await asyncio.to_thread(_build)
    _model_cache[model_id] = model
    return model


def _load_model_sync(model_id: str, device: str) -> object:
    """Synchronous model loading — for use in dedicated threads.

    This is the sync counterpart of :func:`_load_model`.  It exists so
    that :mod:`evoflow.code_index.store` can embed texts during index
    build (which runs in a background thread) without going through
    ``asyncio.to_thread`` — which can fail with *cannot schedule new
    futures after interpreter shutdown*.
    """
    if model_id in _model_cache:
        return _model_cache[model_id]

    try:
        from sentence_transformers import SentenceTransformer  # noqa: F401
    except ImportError as exc:  # pragma: no cover - packaging gap
        raise EmbeddingError(
            f"{_MISSING_ST_HINT} ({type(exc).__name__}: {exc})"
        ) from exc

    logger.info("Loading local embedding model '%s' on %s (sync)...", model_id, device)
    try:
        model = _build_sentence_transformer(model_id, device)
    except Exception as exc:
        endpoint = ensure_hf_hub_env()
        raise EmbeddingError(
            f"Failed to load local embedding model '{model_id}': {exc}. "
            f"Hub endpoint={endpoint}."
        ) from exc
    _model_cache[model_id] = model
    return model


class LocalEmbeddingProvider(EmbeddingProvider):
    """Embedding via local sentence-transformers (CPU/GPU, offline after first download)."""

    async def embed(self, text: str) -> list[float]:
        results = await self.embed_batch([text])
        return results[0]

    async def embed_batch(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []

        model_id = self.model_name
        device = _get_device(self.model_config)
        model = await _load_model(model_id, device)

        def _encode() -> list[list[float]]:
            embs = model.encode(
                texts,
                normalize_embeddings=True,  # L2 normalize → cosine == dot product
                convert_to_numpy=True,
            )
            # Convert numpy rows to plain python lists of floats.
            return [list(map(float, row)) for row in embs]

        try:
            return await asyncio.to_thread(_encode)
        except EmbeddingError:
            raise
        except Exception as exc:
            raise EmbeddingError(
                f"Local embedding inference failed for '{model_id}': {exc}"
            ) from exc

    def embed_batch_sync(self, texts: list[str]) -> list[list[float]]:
        """Synchronous batch embedding — bypasses ``asyncio.to_thread``.

        Use when already running in a dedicated thread (e.g. code_index
        build path via :func:`_run_async_in_thread`).  Equivalent to
        :meth:`embed_batch` but without the async wrapper.
        """
        if not texts:
            return []
        model_id = self.model_name
        device = _get_device(self.model_config)
        model = _load_model_sync(model_id, device)
        embs = model.encode(
            texts,
            normalize_embeddings=True,
            convert_to_numpy=True,
        )
        return [list(map(float, row)) for row in embs]

    def embed_sync(self, text: str) -> list[float]:
        """Synchronous single-text embedding — bypasses ``asyncio.to_thread``."""
        return self.embed_batch_sync([text])[0]


def warmup_local_model(model_id: str, device: str = DEFAULT_LOCAL_DEVICE) -> None:
    """Pre-load a local model (fire-and-forget at startup).

    Model cold-start (including first download) is slow; calling this at
    startup avoids hitting the embedding call path with a multi-second
    delay. Safe to call from sync or async contexts (including
    ``asyncio.to_thread`` workers that have no event loop); failures are
    logged, not raised.
    """
    try:
        # Prefer sync load: gateway schedules this via asyncio.to_thread, and
        # worker threads on Python 3.10+ have no current event loop.
        _load_model_sync(model_id, device)
    except Exception as exc:  # pragma: no cover - best-effort warmup
        logger.warning("Local embedding warmup failed for %s: %s", model_id, exc)


def ensure_default_local_embedding_model() -> bool:
    """Seed the default local embedding model config if none exists.

    Opt-in via ``EVOFLOW_SEED_LOCAL_EMBEDDING=1``. Desktop packages default to
    cloud embedding and omit torch/sentence-transformers from the gateway
    bundle; seeding a local model there would create a permanently broken
    Settings entry. Dev/full builds that ship ST can enable seeding explicitly.

    Called at gateway startup. Idempotent: only inserts when no model with
    ``vendor == "local"`` or ``"embedding"`` in name/model is found.
    Returns ``True`` if a model was seeded.

    Skips seeding when ``sentence-transformers`` is missing so Settings does
    not show a permanently-unavailable local model on broken installs.
    """
    try:
        import os

        from evoflow.persistence.config_repositories import list_models, upsert_model

        seed_opt_in = os.environ.get("EVOFLOW_SEED_LOCAL_EMBEDDING", "").strip().lower() in {
            "1",
            "true",
            "yes",
            "on",
        }
        if not seed_opt_in:
            logger.info(
                "Skip seeding local embedding model "
                "(set EVOFLOW_SEED_LOCAL_EMBEDDING=1 to enable; cloud embedding is default)"
            )
            return False

        deps_err = probe_local_embedding_deps()
        if deps_err is not None:
            logger.warning("Skip seeding default local embedding model: %s", deps_err)
            return False

        existing = list_models()
        for m in existing:
            vendor = str(m.get("vendor", "") or "").strip().lower()
            name = str(m.get("name", "") or "").lower()
            model_id = str(m.get("model", "") or "").lower()
            if vendor == "local" or "embedding" in name or "embedding" in model_id:
                logger.debug("Embedding model already configured: %s", m.get("name"))
                return False

        upsert_model(
            {
                "name": "bge-small-zh",
                "vendor": "local",
                "display_name": "BGE Small 中文向量模型 (本地)",
                "description": (
                    "本地语义向量模型 BAAI/bge-small-zh-v1.5 (512维, ~95MB)，"
                    "用于自有知识库默认嵌入与代码索引语义检索。"
                    "可在「设置 → 模型 → 向量模型」中更换，并设为知识库默认。"
                    "首次使用自动从镜像下载。"
                ),
                "model": DEFAULT_LOCAL_MODEL,
            }
        )
        logger.info("Seeded default local embedding model: %s", DEFAULT_LOCAL_MODEL)
        return True
    except Exception as exc:
        logger.warning("Failed to seed default local embedding model: %s", exc)
        return False


def clear_local_model_cache() -> None:
    """Drop cached local models (used when switching models in settings)."""
    _model_cache.clear()
