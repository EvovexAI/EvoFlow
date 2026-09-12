"""Tests for model delete cleanup and stale Panel data removal."""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

from evoflow.persistence import config_repositories as cfg_repo
from evoflow.persistence import model_connections as conn_repo
from evoflow.persistence.db import get_db, reset_db_for_tests
from evoflow.persistence.model_cleanup import (
    cleanup_legacy_duplicate_models,
    cleanup_stale_model_connections,
    cleanup_stale_panel_models,
)


@pytest.fixture
def sqlite_tmp(monkeypatch: pytest.MonkeyPatch):
    import gc

    from evoflow.config.app_config import reset_app_config

    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        reset_app_config()
        reset_db_for_tests()
        get_db()
        yield Path(tmp)
        reset_db_for_tests()
        reset_app_config()
        gc.collect()


def _upsert_chat_model(**kwargs: object) -> None:
    doc = {
        "name": "test-model",
        "vendor": "aliyun",
        "model": "qwen-max",
        "display_name": "Qwen Max",
        "use": "langchain_openai:ChatOpenAI",
        "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "api_key": "sk-test",
        **kwargs,
    }
    cfg_repo.upsert_model(doc)


def test_delete_model_clears_primary_and_orphan_connection(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    _upsert_chat_model(name="primary-model")
    cfg_repo.set_app_setting("primary_model", "primary-model")
    conn_repo.sync_model_connections(
        [{"key": "aliyun", "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1", "api_key": "sk"}]
    )

    assert cfg_repo.delete_model("primary-model") is True
    assert cfg_repo.get_app_setting("primary_model") is None
    assert conn_repo.get_model_connection("aliyun") is None


def test_delete_model_keeps_connection_when_other_models_remain(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    _upsert_chat_model(name="model-a", model="qwen-max")
    _upsert_chat_model(name="model-b", model="qwen-plus")
    conn_repo.sync_model_connections(
        [{"key": "aliyun", "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1", "api_key": "sk"}]
    )

    assert cfg_repo.delete_model("model-a") is True
    assert conn_repo.get_model_connection("aliyun") is not None
    assert cfg_repo.get_model("model-b") is not None


def test_cleanup_legacy_duplicate_models(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    _upsert_chat_model(name="aliyun/qwen-max", model="qwen-max")
    _upsert_chat_model(name="aliyun-qwen-max", model="qwen-max")

    deleted = cleanup_legacy_duplicate_models()
    assert "aliyun/qwen-max" in deleted
    assert cfg_repo.get_model("aliyun/qwen-max") is None
    assert cfg_repo.get_model("aliyun-qwen-max") is not None


def test_cleanup_stale_model_connections(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    _upsert_chat_model(name="qwen-max", vendor="aliyun-2")
    conn_repo.sync_model_connections(
        [
            {"key": "aliyun", "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1", "api_key": "sk-old"},
            {"key": "aliyun-2", "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1", "api_key": "sk-new"},
        ]
    )

    deleted = cleanup_stale_model_connections()
    assert "aliyun" in deleted
    assert conn_repo.get_model_connection("aliyun") is None
    assert conn_repo.get_model_connection("aliyun-2") is not None


def test_cleanup_stale_panel_models_combined(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    _upsert_chat_model(name="aliyun/qwen-max", vendor="aliyun", model="qwen-max")
    _upsert_chat_model(name="aliyun-qwen-max", vendor="aliyun-2", model="qwen-max")
    conn_repo.sync_model_connections(
        [
            {"key": "aliyun", "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1", "api_key": "sk-old"},
            {"key": "aliyun-2", "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1", "api_key": "sk-new"},
        ]
    )

    result = cleanup_stale_panel_models()
    assert "aliyun/qwen-max" in result["legacy_models"]
    assert cfg_repo.get_model("aliyun-qwen-max") is not None
    assert conn_repo.get_model_connection("aliyun") is None
    assert conn_repo.get_model_connection("aliyun-2") is not None
    # 过期连接可能由 legacy 模型删除级联清理，也可能由 stale_connections 显式清理
    assert "aliyun" in result["stale_connections"] or conn_repo.get_model_connection("aliyun") is None
