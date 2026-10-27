"""Unit tests for local embedding install helpers (hub / cache / runtime)."""

from __future__ import annotations

import pytest

from evoflow.knowledge.embedding.local_install import (
    get_cache_status,
    get_runtime_info,
    validate_hub_endpoint,
)


def test_validate_hub_endpoint_accepts_https():
    assert validate_hub_endpoint("https://hf-mirror.com/") == "https://hf-mirror.com"
    assert validate_hub_endpoint("https://huggingface.co") == "https://huggingface.co"


def test_validate_hub_endpoint_rejects_bad():
    with pytest.raises(ValueError):
        validate_hub_endpoint("")
    with pytest.raises(ValueError):
        validate_hub_endpoint("not-a-url")
    with pytest.raises(ValueError):
        validate_hub_endpoint("ftp://example.com")


def test_cache_status_local_directory(tmp_path):
    st = get_cache_status(str(tmp_path))
    assert st["status"] == "cached"
    assert st["local_path"]


def test_cache_status_missing_repo():
    st = get_cache_status("org/definitely-missing-embed-model-xyz")
    assert st["status"] in {"missing", "failed", "cached", "downloading"}
    assert st["model_id"] == "org/definitely-missing-embed-model-xyz"


def test_runtime_info_shape():
    info = get_runtime_info()
    assert "ok" in info
    assert isinstance(info["ok"], bool)
    if not info["ok"]:
        assert info.get("reason")
