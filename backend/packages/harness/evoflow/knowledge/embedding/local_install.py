"""Local embedding install helpers: hub endpoint, cache status, background download.

Used by Gateway ``/models/local-embedding/*`` routes so the panel can show an
explicit install + verify flow instead of relying on first-probe lazy download.
"""

from __future__ import annotations

import logging
import threading
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from evoflow.knowledge.embedding.hf_env import (
    _DEFAULT_MIRROR,
    ensure_hf_hub_env,
    hf_hub_endpoint,
    set_hf_hub_endpoint,
)

logger = logging.getLogger(__name__)

_HF_ENDPOINT_SETTING_KEY = "local_embedding.hf_endpoint"

# model_id -> job dict
_jobs: dict[str, dict[str, Any]] = {}
_jobs_lock = threading.Lock()
_download_threads: dict[str, threading.Thread] = {}


def _normalize_model_id(model_id: str) -> str:
    return str(model_id or "").strip()


def resolve_local_path(model_id: str) -> str | None:
    """Return absolute directory path when *model_id* points at an existing folder."""
    raw = _normalize_model_id(model_id)
    if not raw:
        return None
    path = Path(raw).expanduser()
    if path.is_dir():
        return str(path.resolve())
    return None


def model_is_cached(model_id: str) -> bool:
    """True when weights exist locally (directory or HF hub cache)."""
    if resolve_local_path(model_id):
        return True
    mid = _normalize_model_id(model_id)
    if not mid:
        return False
    try:
        ensure_hf_hub_env()
        from huggingface_hub import try_to_load_from_cache

        for filename in ("config.json", "model.safetensors", "pytorch_model.bin"):
            if try_to_load_from_cache(mid, filename) is not None:
                return True
    except Exception:
        return False
    return False


def validate_hub_endpoint(endpoint: str) -> str:
    """Normalize and validate an HF hub endpoint URL. Raises ValueError."""
    raw = str(endpoint or "").strip().rstrip("/")
    if not raw:
        raise ValueError("镜像地址不能为空")
    parts = urlsplit(raw)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        raise ValueError("镜像地址须为 http(s) URL，例如 https://hf-mirror.com")
    return raw


def load_persisted_hf_endpoint() -> str | None:
    try:
        from evoflow.persistence.config_repositories import get_app_setting

        val = get_app_setting(_HF_ENDPOINT_SETTING_KEY)
        if isinstance(val, str) and val.strip():
            return validate_hub_endpoint(val)
    except Exception:
        return None
    return None


def persist_hf_endpoint(endpoint: str) -> str:
    """Validate, persist, and apply HF hub endpoint. Returns effective URL."""
    cleaned = validate_hub_endpoint(endpoint)
    from evoflow.persistence.config_repositories import set_app_setting

    set_app_setting(_HF_ENDPOINT_SETTING_KEY, cleaned)
    return set_hf_hub_endpoint(cleaned)


def get_hub_info() -> dict[str, Any]:
    ensure_hf_hub_env()
    persisted = load_persisted_hf_endpoint()
    effective = hf_hub_endpoint()
    return {
        "endpoint": effective,
        "default": _DEFAULT_MIRROR,
        "persisted": persisted,
    }


def get_runtime_info() -> dict[str, Any]:
    from evoflow.knowledge.embedding.local_provider import probe_local_embedding_deps

    err = probe_local_embedding_deps()
    return {
        "ok": err is None,
        "reason": err,
    }


def _job_snapshot(model_id: str) -> dict[str, Any] | None:
    with _jobs_lock:
        job = _jobs.get(model_id)
        return dict(job) if job else None


def get_cache_status(model_id: str) -> dict[str, Any]:
    mid = _normalize_model_id(model_id)
    if not mid:
        return {"model_id": "", "status": "missing", "message": "模型 ID 为空"}

    local_path = resolve_local_path(mid)
    if local_path:
        return {
            "model_id": mid,
            "status": "cached",
            "message": f"本地目录已就绪：{local_path}",
            "local_path": local_path,
        }

    job = _job_snapshot(mid)
    if job and job.get("status") == "downloading":
        return {
            "model_id": mid,
            "status": "downloading",
            "message": job.get("message") or "正在下载…",
            "started_at": job.get("started_at"),
        }
    if job and job.get("status") == "failed":
        # Prefer live cache check — a later successful probe may have filled cache.
        if model_is_cached(mid):
            return {
                "model_id": mid,
                "status": "cached",
                "message": "本地缓存已就绪",
                "endpoint": hf_hub_endpoint(),
            }
        return {
            "model_id": mid,
            "status": "failed",
            "message": job.get("message") or "下载失败",
            "error": job.get("error"),
            "endpoint": hf_hub_endpoint(),
        }

    if model_is_cached(mid):
        return {
            "model_id": mid,
            "status": "cached",
            "message": "本地缓存已就绪",
            "endpoint": hf_hub_endpoint(),
        }

    return {
        "model_id": mid,
        "status": "missing",
        "message": "尚未下载到本地缓存",
        "endpoint": hf_hub_endpoint(),
    }


def _set_job(model_id: str, **fields: Any) -> dict[str, Any]:
    with _jobs_lock:
        cur = _jobs.get(model_id) or {"model_id": model_id}
        cur.update(fields)
        _jobs[model_id] = cur
        return dict(cur)


def _run_snapshot_download(model_id: str) -> None:
    ensure_hf_hub_env()
    endpoint = hf_hub_endpoint()
    _set_job(
        model_id,
        status="downloading",
        message=f"正在从 {endpoint} 下载…",
        error=None,
        started_at=time.time(),
        finished_at=None,
    )
    try:
        from huggingface_hub import snapshot_download

        snapshot_download(repo_id=model_id)
        _set_job(
            model_id,
            status="cached",
            message="下载完成，已写入本地缓存",
            error=None,
            finished_at=time.time(),
        )
        logger.info("Local embedding download finished: %s via %s", model_id, endpoint)
    except Exception as exc:
        msg = str(exc).strip() or type(exc).__name__
        _set_job(
            model_id,
            status="failed",
            message=f"下载失败（hub={endpoint}）：{msg}",
            error=msg,
            finished_at=time.time(),
        )
        logger.warning("Local embedding download failed for %s: %s", model_id, exc)
    finally:
        with _jobs_lock:
            _download_threads.pop(model_id, None)


def start_download(model_id: str) -> dict[str, Any]:
    """Start background snapshot_download when needed. Idempotent per model_id."""
    mid = _normalize_model_id(model_id)
    if not mid:
        raise ValueError("模型 ID 不能为空")

    status = get_cache_status(mid)
    if status.get("status") == "cached":
        return status
    if status.get("status") == "downloading":
        return status

    # Runtime must be present for sentence-transformers path; hub download itself
    # only needs huggingface_hub, but panel should not advertise install without ST.
    from evoflow.knowledge.embedding.local_provider import probe_local_embedding_deps

    deps_err = probe_local_embedding_deps()
    if deps_err is not None:
        raise RuntimeError(deps_err)

    with _jobs_lock:
        existing = _download_threads.get(mid)
        if existing and existing.is_alive():
            return get_cache_status(mid)
        t = threading.Thread(
            target=_run_snapshot_download,
            args=(mid,),
            name=f"local-embed-dl:{mid}",
            daemon=True,
        )
        _download_threads[mid] = t
        _set_job(
            mid,
            status="downloading",
            message="准备下载…",
            error=None,
            started_at=time.time(),
            finished_at=None,
        )
        t.start()

    return get_cache_status(mid)
