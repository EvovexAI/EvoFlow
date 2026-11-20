"""Installer-bundled bge-small-zh path + seed gating."""

from __future__ import annotations

from pathlib import Path

import pytest


def test_find_bundled_model_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from evoflow.knowledge.embedding import bundled as b

    model_dir = tmp_path / "tools" / "local-embed" / "models" / "BAAI" / "bge-small-zh-v1.5"
    model_dir.mkdir(parents=True)
    (model_dir / "config.json").write_text("{}", encoding="utf-8")
    (model_dir / "modules.json").write_text("[]", encoding="utf-8")

    monkeypatch.setenv("EVOFLOW_LOCAL_EMBED_ROOT", str(tmp_path))
    found = b.find_bundled_local_model_dir("BAAI/bge-small-zh-v1.5")
    assert found is not None
    assert found == model_dir.resolve()
    assert b.bundled_local_model_available() is True


def test_resolve_model_ref_prefers_bundled(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from evoflow.knowledge.embedding import local_provider as lp

    model_dir = tmp_path / "tools" / "local-embed" / "models" / "BAAI" / "bge-small-zh-v1.5"
    model_dir.mkdir(parents=True)
    (model_dir / "config.json").write_text("{}", encoding="utf-8")
    (model_dir / "model.safetensors").write_bytes(b"x")
    monkeypatch.setenv("EVOFLOW_LOCAL_EMBED_ROOT", str(tmp_path))

    resolved = lp._resolve_model_ref("BAAI/bge-small-zh-v1.5")
    assert Path(resolved) == model_dir.resolve()


def test_should_seed_when_bundled_and_deps(monkeypatch: pytest.MonkeyPatch) -> None:
    from evoflow.knowledge.embedding import local_provider as lp

    monkeypatch.delenv("EVOFLOW_SEED_LOCAL_EMBEDDING", raising=False)
    monkeypatch.setattr(lp, "probe_local_embedding_deps", lambda: None)
    monkeypatch.setattr(
        "evoflow.knowledge.embedding.bundled.bundled_local_model_available",
        lambda: True,
    )
    assert lp._should_seed_local_embedding() is True


def test_inprocess_allowed_with_local_embed_worker_env(monkeypatch: pytest.MonkeyPatch) -> None:
    from evoflow.knowledge.embedding import local_provider as lp

    monkeypatch.setattr(lp.sys, "platform", "win32")
    monkeypatch.delenv("EVOFLOW_EMBEDDING_WARMUP", raising=False)
    monkeypatch.delenv("EVOFLOW_CODE_INDEX_BUILD_WORKER", raising=False)
    monkeypatch.setenv("EVOFLOW_LOCAL_EMBED_WORKER", "1")
    assert lp.inprocess_local_embed_allowed() is True


def test_get_embedding_config_falls_back_to_bundled(monkeypatch: pytest.MonkeyPatch) -> None:
    from types import SimpleNamespace

    from evoflow.knowledge.embedding import registry as R
    from evoflow.knowledge.embedding.base import DEFAULT_LOCAL_MODEL

    monkeypatch.setattr(
        R,
        "get_app_config",
        lambda: SimpleNamespace(models=[], get_model_config=lambda _n: None),
    )
    monkeypatch.setattr(
        "evoflow.knowledge.owned.settings.get_default_embedding_model",
        lambda: "",
    )
    monkeypatch.setattr(
        "evoflow.knowledge.owned.embedding_bind.default_embedding_ref",
        lambda: "",
    )
    monkeypatch.setattr(
        "evoflow.knowledge.embedding.bundled.bundled_local_model_available",
        lambda: True,
    )
    monkeypatch.setattr(
        "evoflow.knowledge.embedding.local_provider.local_embedding_deps_available",
        lambda: True,
    )
    cfg = R.get_embedding_config()
    assert cfg.vendor == "local"
    assert cfg.model == DEFAULT_LOCAL_MODEL
    assert cfg.name == "bge-small-zh"
