"""Lean-runtime reconcile for local embedding models."""

from __future__ import annotations

from unittest.mock import patch

from evoflow.knowledge.embedding import local_provider


def test_reconcile_deletes_seed_when_deps_missing(monkeypatch) -> None:
    deleted: list[str] = []
    marked: list[str] = []

    class _Repo:
        @staticmethod
        def list_models():
            return [
                {"name": "bge-small-zh", "vendor": "local", "model": "BAAI/bge-small-zh-v1.5"},
                {"name": "my-local", "vendor": "local", "model": "BAAI/bge-m3"},
                {"name": "doubao-embed", "vendor": "volcengine", "model": "doubao-embedding"},
            ]

        @staticmethod
        def delete_model(name: str) -> bool:
            deleted.append(name)
            return True

        @staticmethod
        def mark_model_unavailable(name: str, *, reason: str, code: str | None = None) -> bool:
            marked.append(name)
            return True

    class _Settings:
        @staticmethod
        def get_default_embedding_model() -> str:
            return "bge-small-zh"

        @staticmethod
        def set_default_embedding_model(ref: str | None) -> str:
            return str(ref or "")

    monkeypatch.setattr(
        local_provider, "probe_local_embedding_deps", lambda: "missing st"
    )
    with patch.dict(
        "sys.modules",
        {},
    ):
        with patch(
            "evoflow.persistence.config_repositories.list_models",
            _Repo.list_models,
        ):
            with patch(
                "evoflow.persistence.config_repositories.delete_model",
                _Repo.delete_model,
            ):
                with patch(
                    "evoflow.persistence.config_repositories.mark_model_unavailable",
                    _Repo.mark_model_unavailable,
                ):
                    with patch(
                        "evoflow.knowledge.owned.settings.get_default_embedding_model",
                        _Settings.get_default_embedding_model,
                    ):
                        with patch(
                            "evoflow.knowledge.owned.settings.set_default_embedding_model",
                            _Settings.set_default_embedding_model,
                        ):
                            stats = local_provider.reconcile_local_embedding_models_for_runtime()

    assert stats["deleted"] == 1
    assert deleted == ["bge-small-zh"]
    assert marked == ["my-local"]
    assert stats["cleared_default"] == 1


def test_reconcile_noop_when_deps_ok(monkeypatch) -> None:
    monkeypatch.setattr(local_provider, "probe_local_embedding_deps", lambda: None)
    assert local_provider.reconcile_local_embedding_models_for_runtime() == {
        "deleted": 0,
        "marked": 0,
        "cleared_default": 0,
    }
