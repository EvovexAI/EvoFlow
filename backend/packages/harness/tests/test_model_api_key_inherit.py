"""New model rows inherit connection api_key from siblings on the same vendor."""

from __future__ import annotations

import gc
import tempfile
from pathlib import Path

import pytest

from evoflow.config import add_model_to_config, get_app_config, reload_models_from_db
from evoflow.config.app_config import reset_app_config
from evoflow.persistence.config_repositories import upsert_model
from evoflow.persistence.db import get_db, reset_db_for_tests


@pytest.fixture
def sqlite_tmp(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        reset_app_config()
        reset_db_for_tests()
        get_db()
        yield Path(tmp)
        reset_db_for_tests()
        reset_app_config()
        gc.collect()


def _seed_connection_model(*, name: str, vendor: str, api_key: str, base_url: str) -> None:
    upsert_model(
        {
            "name": name,
            "vendor": vendor,
            "model": "gpt-test",
            "use": "langchain_openai:ChatOpenAI",
            "base_url": base_url,
            "api_key": api_key,
        }
    )
    reload_models_from_db()


def test_add_model_inherits_api_key_from_same_vendor(sqlite_tmp) -> None:
    del sqlite_tmp
    _seed_connection_model(
        name="existing-model",
        vendor="aliyun-coding",
        api_key="sk-existing-secret",
        base_url="https://coding.dashscope.aliyuncs.com/v1",
    )

    created = add_model_to_config(
        {
            "name": "glm-5.2-coding",
            "vendor": "aliyun-coding",
            "model": "glm-5.2-coding",
            "use": "langchain_openai:ChatOpenAI",
            "base_url": "https://coding.dashscope.aliyuncs.com/v1",
        }
    )

    assert created.api_key == "sk-existing-secret"
    row = next(m for m in get_app_config().models if m.name == "glm-5.2-coding")
    assert row.api_key == "sk-existing-secret"


def test_add_model_does_not_inherit_masked_sibling_key(sqlite_tmp) -> None:
    del sqlite_tmp
    _seed_connection_model(
        name="broken-model",
        vendor="aliyun-coding",
        api_key="****abcd",
        base_url="https://coding.dashscope.aliyuncs.com/v1",
    )

    created = add_model_to_config(
        {
            "name": "new-model",
            "vendor": "aliyun-coding",
            "model": "qwen-max",
            "use": "langchain_openai:ChatOpenAI",
            "base_url": "https://coding.dashscope.aliyuncs.com/v1",
        }
    )

    assert created.api_key is None
