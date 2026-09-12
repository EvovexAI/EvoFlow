"""Bind owned KB embedding to the global models registry (Settings → 向量模型)."""

from __future__ import annotations

import logging
from typing import Any

from evoflow.config.model_config import ModelConfig
from evoflow.knowledge.embedding.registry import (
    _is_local_config,
    resolve_embedding_model_config,
)

logger = logging.getLogger(__name__)

# Seeded by ensure_default_local_embedding_model
SEED_EMBEDDING_NAME = "bge-small-zh"
FALLBACK_LOCAL_MODEL = "BAAI/bge-small-zh-v1.5"
FALLBACK_CLOUD_MODEL = "text-embedding-3-small"


def list_embedding_model_rows() -> list[dict[str, Any]]:
    """Return embedding-capable rows from the global models store."""
    try:
        from evoflow.persistence.config_repositories import list_models
    except Exception:
        return []
    out: list[dict[str, Any]] = []
    for m in list_models() or []:
        if not isinstance(m, dict):
            continue
        vendor = str(m.get("vendor") or "").strip().lower()
        name = str(m.get("name") or "").lower()
        model_id = str(m.get("model") or "").lower()
        if vendor == "local" or "embedding" in name or "embedding" in model_id:
            out.append(m)
            continue
        if vendor in ("doubao", "volcengine", "ark") and ("embed" in model_id or "vision" in model_id):
            out.append(m)
            continue
        if any(tok in model_id for tok in ("bge", "e5-", "nomic-embed")):
            out.append(m)
    return out


def resolve_model_config(ref: str | None) -> ModelConfig | None:
    ident = str(ref or "").strip()
    if not ident:
        return None
    return resolve_embedding_model_config(ident)


def snapshot_from_config(mc: ModelConfig) -> dict[str, str]:
    """Derive kb_bases snapshot fields from a registry ModelConfig."""
    local = _is_local_config(mc)
    return {
        "embedding_mode": "local" if local else "cloud",
        "embedding_model": str(getattr(mc, "model", "") or "").strip()
        or (FALLBACK_LOCAL_MODEL if local else FALLBACK_CLOUD_MODEL),
        "embedding_base_url": "" if local else str(getattr(mc, "base_url", "") or "").strip(),
        "embedding_model_ref": str(getattr(mc, "name", "") or "").strip(),
    }


def match_registry_ref(
    *,
    mode: str | None = None,
    model: str | None = None,
    base_url: str | None = None,
    ref: str | None = None,
) -> str:
    """Best-effort match a legacy snapshot to a registry model name."""
    if ref and resolve_model_config(ref):
        return str(ref).strip()

    model_s = str(model or "").strip()
    mode_s = str(mode or "").strip().lower()
    base_s = str(base_url or "").strip().rstrip("/")

    if model_s:
        mc = resolve_model_config(model_s)
        if mc is not None:
            return str(getattr(mc, "name", "") or model_s).strip()

    for row in list_embedding_model_rows():
        name = str(row.get("name") or "").strip()
        mid = str(row.get("model") or "").strip()
        vendor = str(row.get("vendor") or "").strip().lower()
        row_base = str(row.get("base_url") or "").strip().rstrip("/")
        if model_s and mid == model_s:
            if mode_s == "local" and vendor == "local":
                return name
            if mode_s != "local" and vendor != "local":
                if not base_s or not row_base or base_s == row_base:
                    return name
            if not mode_s:
                return name
    return ""


def default_embedding_ref() -> str:
    """Global default from settings, else first usable embedding.

    Prefer a local model when local deps are available (matches desktop KBs that
    work offline). Fall back to cloud only when lean/no local, or when the user
    explicitly configured a default.
    """
    from evoflow.knowledge.owned import settings as owned_settings

    configured = owned_settings.get_default_embedding_model()
    if configured and resolve_model_config(configured):
        return configured

    local_ok = True
    try:
        from evoflow.knowledge.embedding.local_provider import local_embedding_deps_available

        local_ok = local_embedding_deps_available()
    except Exception:
        local_ok = False

    if local_ok and resolve_model_config(SEED_EMBEDDING_NAME):
        return SEED_EMBEDDING_NAME

    cloud_fallback = ""
    local_fallback = ""
    for row in list_embedding_model_rows():
        name = str(row.get("name") or "").strip()
        if not name:
            continue
        vendor = str(row.get("vendor") or "").strip().lower()
        if vendor == "local":
            if local_ok and not local_fallback:
                local_fallback = name
            continue
        if not cloud_fallback:
            cloud_fallback = name
    if local_ok and local_fallback:
        return local_fallback
    return cloud_fallback or (local_fallback if local_ok else "")


def resolve_create_binding(payload: dict[str, Any]) -> dict[str, Any]:
    """Resolve create/update payload into ref + snapshot (+ optional inline api key).

    Preference order:
    1. embeddingModelRef / embedding_model_ref
    2. global default
    3. legacy embeddingMode/Model/BaseUrl/ApiKey fields
    """
    ref = str(
        payload.get("embeddingModelRef")
        or payload.get("embedding_model_ref")
        or ""
    ).strip()
    if not ref:
        # Only use global default when caller did not pass legacy cloud/local override
        has_legacy = bool(
            payload.get("embeddingModel")
            or payload.get("embedding_model")
            or payload.get("embeddingApiKey")
            or payload.get("embedding_api_key")
            or payload.get("embeddingBaseUrl")
            or payload.get("embedding_base_url")
        )
        if not has_legacy:
            ref = default_embedding_ref()

    mc = resolve_model_config(ref) if ref else None
    if mc is not None:
        snap = snapshot_from_config(mc)
        api_key = ""
        # Prefer registry key; allow one-shot override on create
        override = payload.get("embeddingApiKey") or payload.get("embedding_api_key")
        if override and str(override).strip():
            api_key = str(override).strip()
        elif getattr(mc, "api_key", None):
            api_key = str(mc.api_key or "").strip()
        binding = {
            **snap,
            "embedding_api_key": api_key,
            "from_registry": True,
        }
        return _ensure_create_binding_ready(binding, payload)

    # Legacy path (still supported for scripts / migration)
    from evoflow.knowledge.embedding.local_provider import local_embedding_deps_available

    default_mode = "local" if local_embedding_deps_available() else "cloud"
    mode = str(payload.get("embeddingMode") or payload.get("embedding_mode") or default_mode).lower()
    if mode not in ("local", "cloud"):
        mode = default_mode
    if mode == "local" and not local_embedding_deps_available():
        mode = "cloud"
    model = str(
        payload.get("embeddingModel")
        or payload.get("embedding_model")
        or (FALLBACK_LOCAL_MODEL if mode == "local" else FALLBACK_CLOUD_MODEL)
    ).strip()
    base_url = str(
        payload.get("embeddingBaseUrl") or payload.get("embedding_base_url") or ""
    ).strip()
    api_key = str(
        payload.get("embeddingApiKey") or payload.get("embedding_api_key") or ""
    ).strip()
    matched = match_registry_ref(mode=mode, model=model, base_url=base_url)
    binding = {
        "embedding_mode": mode,
        "embedding_model": model,
        "embedding_base_url": base_url if mode != "local" else "",
        "embedding_model_ref": matched,
        "embedding_api_key": api_key,
        "from_registry": False,
    }
    return _ensure_create_binding_ready(binding, payload)


def _ensure_create_binding_ready(
    binding: dict[str, Any],
    payload: dict[str, Any],
) -> dict[str, Any]:
    """If cloud binding cannot run, fall back to local when available.

    Avoids creating KBs that immediately leave every document stuck in
    ``processing`` because embeddings never start.
    """
    # Caller explicitly forced mode/model — respect it (surface errors at index time).
    forced = bool(
        payload.get("embeddingModelRef")
        or payload.get("embedding_model_ref")
        or payload.get("embeddingMode")
        or payload.get("embedding_mode")
        or payload.get("embeddingModel")
        or payload.get("embedding_model")
    )
    probe = {
        "embedding_mode": binding.get("embedding_mode"),
        "embedding_model": binding.get("embedding_model"),
        "embedding_base_url": binding.get("embedding_base_url"),
        "embedding_model_ref": binding.get("embedding_model_ref"),
        "embedding_api_key_ref": "",
        "id": "create",
    }
    # Inline key for readiness probe (not yet stored as secret ref).
    if binding.get("embedding_api_key") and str(binding.get("embedding_mode") or "") != "local":
        from evoflow.config.model_config import ModelConfig
        from evoflow.models.credential_sanitize import resolve_and_sanitize_api_key

        api_key = resolve_and_sanitize_api_key(str(binding.get("embedding_api_key") or "")) or ""
        base_url = str(binding.get("embedding_base_url") or "").strip().rstrip("/")
        if api_key and base_url:
            return binding
        # Also try registry-resolved config
        ready, _reason = embedding_runtime_ready_for_base_row(probe)
        if ready:
            return binding
    else:
        ready, _reason = embedding_runtime_ready_for_base_row(probe)
        if ready:
            return binding

    if forced:
        return binding

    try:
        from evoflow.knowledge.embedding.local_provider import local_embedding_deps_available

        if not local_embedding_deps_available():
            return binding
    except Exception:
        return binding

    local_ref = ""
    if resolve_model_config(SEED_EMBEDDING_NAME):
        local_ref = SEED_EMBEDDING_NAME
    else:
        for row in list_embedding_model_rows():
            if str(row.get("vendor") or "").strip().lower() == "local":
                local_ref = str(row.get("name") or "").strip()
                if local_ref:
                    break
    if not local_ref:
        return binding
    mc = resolve_model_config(local_ref)
    if mc is None:
        return binding
    logger.info(
        "owned KB create: cloud embedding not ready; falling back to local %s",
        local_ref,
    )
    snap = snapshot_from_config(mc)
    return {**snap, "embedding_api_key": "", "from_registry": True}

def model_config_for_base_row(base: dict[str, Any]) -> ModelConfig:
    """Build runtime ModelConfig for indexing / search."""
    ref = str(base.get("embedding_model_ref") or base.get("embeddingModelRef") or "").strip()
    mc = resolve_model_config(ref) if ref else None
    if mc is not None:
        # Clone-ish name for cache isolation per KB still uses registry credentials
        return mc

    mode = str(base.get("embedding_mode") or "local").lower()
    model = str(base.get("embedding_model") or FALLBACK_LOCAL_MODEL)
    base_url = str(base.get("embedding_base_url") or "") or None
    api_key = None
    key_ref = str(base.get("embedding_api_key_ref") or "").strip()
    if key_ref:
        try:
            from evoflow.knowledge.vault import secrets as vault_secrets

            api_key = vault_secrets.get_secret(key_ref) or None
        except Exception:
            logger.debug("owned embedding secret resolve failed", exc_info=True)
    if not api_key and mode != "local":
        import os

        api_key = (
            os.environ.get("EVOFLOW_OWNED_EMBEDDING_API_KEY")
            or os.environ.get("OPENAI_API_KEY")
            or None
        )
    kb_id = str(base.get("id") or "")[:8] or "x"
    if mode == "local":
        return ModelConfig(
            name=f"owned-emb-{kb_id}",
            use="local",
            model=model,
            vendor="local",
            base_url=None,
            api_key=None,
        )
    return ModelConfig(
        name=f"owned-emb-{kb_id}",
        use="langchain_openai.OpenAIEmbeddings",
        model=model,
        vendor="openai",
        base_url=base_url,
        api_key=api_key,
    )


def embedding_runtime_ready_for_base_row(base: dict[str, Any]) -> tuple[bool, str | None]:
    """Return ``(True, None)`` when indexing embeddings can run for this KB row."""
    mode = str(base.get("embedding_mode") or base.get("embeddingMode") or "cloud").strip().lower()
    if mode == "local":
        try:
            from evoflow.knowledge.embedding.local_provider import probe_local_embedding_deps

            deps_err = probe_local_embedding_deps()
            if deps_err is not None:
                return False, str(deps_err)
        except Exception as exc:
            return False, str(exc)
        return True, None

    try:
        mc = model_config_for_base_row(base)
        from evoflow.models.credential_sanitize import resolve_and_sanitize_api_key

        api_key = resolve_and_sanitize_api_key(getattr(mc, "api_key", "") or "") or ""
        base_url = str(getattr(mc, "base_url", "") or "").strip().rstrip("/")
        if not api_key:
            return False, "embedding API unavailable (missing API key for cloud embedding model)"
        if not base_url:
            return False, "embedding API unavailable (missing base URL for cloud embedding model)"
    except Exception as exc:
        return False, f"embedding runtime check failed: {exc}"
    return True, None
