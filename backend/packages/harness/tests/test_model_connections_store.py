"""Model connection persistence (evoflow_model_connections)."""

from __future__ import annotations

from pathlib import Path

import pytest

from evoflow.persistence import model_connections as conn_repo
from evoflow.persistence.db import get_db


@pytest.fixture
def sqlite_tmp(monkeypatch: pytest.MonkeyPatch):
    import gc
    import tempfile

    from evoflow.persistence.db import reset_db_for_tests

    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        reset_db_for_tests()
        get_db()
        yield Path(tmp)
        reset_db_for_tests()
        gc.collect()


def test_sync_connection_without_models(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    rows = conn_repo.sync_model_connections(
        [
            {
                "key": "aliyun",
                "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
                "api_key": "sk-test-key",
                "api_type": "openai-completions",
                "display_name": "百炼默认",
            }
        ]
    )
    assert "aliyun" in rows
    assert rows["aliyun"]["base_url"].endswith("/v1")
    assert rows["aliyun"]["api_key"] == "sk-test-key"
    assert rows["aliyun"]["display_name"] == "百炼默认"


def test_sync_omit_api_key_preserves_existing(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    conn_repo.sync_model_connections(
        [{"key": "openai", "base_url": "https://api.openai.com/v1", "api_key": "sk-keep-me"}]
    )
    rows = conn_repo.sync_model_connections(
        [{"key": "openai", "base_url": "https://api.openai.com/v1", "api_type": "openai-completions"}]
    )
    assert rows["openai"]["api_key"] == "sk-keep-me"


def test_sync_deletes_orphan_connections(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    conn_repo.sync_model_connections(
        [
            {"key": "a", "base_url": "https://a.example/v1", "api_key": ""},
            {"key": "b", "base_url": "https://b.example/v1", "api_key": ""},
        ]
    )
    rows = conn_repo.sync_model_connections(
        [{"key": "a", "base_url": "https://a.example/v1", "api_key": ""}]
    )
    assert set(rows.keys()) == {"a"}


def test_sync_propagates_api_key_to_models(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    from evoflow.persistence.config_repositories import get_model, upsert_model

    upsert_model(
        {
            "name": "qwen-max",
            "vendor": "aliyun",
            "model": "qwen-max",
            "use": "langchain_openai:ChatOpenAI",
            "base_url": "https://old.example/v1",
            "api_key": "sk-old",
        }
    )
    conn_repo.sync_model_connections(
        [
            {
                "key": "aliyun",
                "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
                "api_key": "sk-new-key",
                "api_type": "openai-completions",
            }
        ]
    )
    row = get_model("qwen-max")
    assert row is not None
    assert row["api_key"] == "sk-new-key"
    assert row["base_url"].endswith("/v1")


def test_sync_omit_api_key_does_not_clobber_model_keys(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    from evoflow.persistence.config_repositories import get_model, upsert_model

    upsert_model(
        {
            "name": "qwen-max",
            "vendor": "aliyun",
            "model": "qwen-max",
            "use": "langchain_openai:ChatOpenAI",
            "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
            "api_key": "sk-model-keep",
        }
    )
    conn_repo.sync_model_connections(
        [
            {
                "key": "aliyun",
                "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
                "api_key": "sk-conn",
            }
        ]
    )
    # Omit api_key → preserve connection key and do not wipe model key with empty.
    conn_repo.sync_model_connections(
        [
            {
                "key": "aliyun",
                "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
                "api_type": "openai-completions",
            }
        ]
    )
    assert conn_repo.get_model_connection("aliyun")["api_key"] == "sk-conn"
    row = get_model("qwen-max")
    assert row is not None
    assert row["api_key"] == "sk-conn"


def _upsert_conn_model(name: str, vendor: str, model: str, base_url: str) -> None:
    from evoflow.persistence.config_repositories import upsert_model

    upsert_model(
        {
            "name": name,
            "vendor": vendor,
            "model": model,
            "use": "langchain_openai:ChatOpenAI",
            "base_url": base_url,
            "api_key": "sk-test",
        }
    )


def test_delete_connection_removes_its_models(sqlite_tmp: Path) -> None:
    """Deleting a connection must also remove the models it owns (vendor == key)."""
    del sqlite_tmp
    _upsert_conn_model("qwen-a", "aliyun", "qwen-max", "https://dashscope.aliyuncs.com/compatible-mode/v1")
    _upsert_conn_model("qwen-b", "aliyun", "qwen-plus", "https://dashscope.aliyuncs.com/compatible-mode/v1")
    conn_repo.sync_model_connections(
        [{"key": "aliyun", "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1", "api_key": "sk"}]
    )

    deleted = conn_repo.delete_model_connection("aliyun")

    assert deleted is True
    assert conn_repo.get_model_connection("aliyun") is None
    from evoflow.persistence.config_repositories import get_model

    assert get_model("qwen-a") is None
    assert get_model("qwen-b") is None


def test_delete_connection_keeps_other_connections_models(sqlite_tmp: Path) -> None:
    """Scope fallback must not remove models owned by another live connection."""
    del sqlite_tmp
    # Two distinct scopes → deleting one connection must not touch the other's models.
    _upsert_conn_model("openai-a", "openai", "gpt-4o", "https://api.openai.com/v1")
    _upsert_conn_model("aliyun-a", "aliyun", "qwen-max", "https://dashscope.aliyuncs.com/compatible-mode/v1")
    conn_repo.sync_model_connections(
        [
            {"key": "openai", "base_url": "https://api.openai.com/v1", "api_key": "sk"},
            {"key": "aliyun", "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1", "api_key": "sk"},
        ]
    )

    conn_repo.delete_model_connection("openai")

    from evoflow.persistence.config_repositories import get_model

    assert get_model("openai-a") is None
    assert get_model("aliyun-a") is not None


def test_sync_drops_orphan_connection_and_its_models(sqlite_tmp: Path) -> None:
    """sync_model_connections removing an orphan connection also removes its models."""
    del sqlite_tmp
    _upsert_conn_model("b-model", "b", "b-model-id", "https://b.example/v1")
    conn_repo.sync_model_connections(
        [
            {"key": "a", "base_url": "https://a.example/v1", "api_key": ""},
            {"key": "b", "base_url": "https://b.example/v1", "api_key": ""},
        ]
    )

    rows = conn_repo.sync_model_connections(
        [{"key": "a", "base_url": "https://a.example/v1", "api_key": ""}]
    )

    assert set(rows.keys()) == {"a"}
    from evoflow.persistence.config_repositories import get_model

    assert get_model("b-model") is None


def test_delete_connection_scope_fallback_does_not_steal_same_scope_models(
    sqlite_tmp: Path,
) -> None:
    """When another live connection shares the scope, its models must survive."""
    del sqlite_tmp
    base_url = "https://dashscope.aliyuncs.com/compatible-mode/v1"
    # Dirty legacy row: vendor = root 'aliyun' while the live key is 'aliyun-2'.
    _upsert_conn_model("qwen-dirty", "aliyun", "qwen-max", base_url)
    _upsert_conn_model("qwen-own", "aliyun-2", "qwen-plus", base_url)
    conn_repo.sync_model_connections(
        [
            {"key": "aliyun", "base_url": base_url, "api_key": "sk-old"},
            {"key": "aliyun-2", "base_url": base_url, "api_key": "sk-new"},
        ]
    )

    # Deleting aliyun-2 must remove its own model, but NOT the same-scope model
    # that belongs to the still-live 'aliyun' connection (legacy vendor row).
    conn_repo.delete_model_connection("aliyun-2")

    from evoflow.persistence.config_repositories import get_model

    assert get_model("qwen-own") is None
    assert get_model("qwen-dirty") is not None
