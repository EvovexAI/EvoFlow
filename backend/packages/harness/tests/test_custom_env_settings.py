"""Custom environment variable persistence."""

from evoflow.persistence.custom_env_settings import (
    get_custom_env_dict,
    replace_custom_env_vars,
)
from evoflow.persistence.custom_env_validation import verify_custom_env_vars
from evoflow.persistence.runtime_env import apply_runtime_env_to_mapping


def test_custom_env_persist_and_apply(monkeypatch):
    store: dict = {}

    monkeypatch.setattr(
        "evoflow.persistence.custom_env_settings.cfg_repo.get_app_setting",
        lambda key: store.get(key),
    )
    monkeypatch.setattr(
        "evoflow.persistence.custom_env_settings.cfg_repo.set_app_setting",
        lambda key, value: store.update({key: value}),
    )
    monkeypatch.setattr(
        "evoflow.persistence.media_settings.cfg_repo.get_app_setting",
        lambda key: store.get(key),
    )

    replace_custom_env_vars([{"key": "MY_SKILL_KEY", "value": "secret-123"}])
    assert get_custom_env_dict()["MY_SKILL_KEY"] == "secret-123"

    env: dict[str, str] = {"EXISTING": "1"}
    apply_runtime_env_to_mapping(env)
    assert env["MY_SKILL_KEY"] == "secret-123"
    assert env["EXISTING"] == "1"


def test_verify_unknown_key_skipped():
    results = verify_custom_env_vars([{"key": "MY_CUSTOM_KEY", "value": "abc"}])
    assert len(results) == 1
    assert results[0]["key"] == "MY_CUSTOM_KEY"
    assert results[0]["skipped"] is True
    assert results[0]["ok"] is True


def test_verify_empty_key_fails():
    results = verify_custom_env_vars([{"key": "DASHSCOPE_API_KEY", "value": ""}])
    assert results[0]["ok"] is False
    assert "空" in results[0]["message"]


def test_verify_ark_key_success():
    results = verify_custom_env_vars([{"key": "ARK_API_KEY", "value": "good-key"}])
    assert results[0]["ok"] is True
    assert "已填写" in results[0]["message"]


def test_verify_ark_key_empty_fails():
    results = verify_custom_env_vars([{"key": "VOLCENGINE_API_KEY", "value": ""}])
    assert results[0]["ok"] is False
    assert "空" in results[0]["message"]


def test_verify_kling_pair_incomplete():
    results = verify_custom_env_vars([{"key": "KLING_ACCESS_KEY_ID", "value": "ak-123"}])
    assert results[0]["ok"] is False
    assert "KLING_ACCESS_KEY_SECRET" in results[0]["message"]


def test_verify_tts_pair_incomplete():
    results = verify_custom_env_vars([{"key": "VOLCENGINE_TTS_APPID", "value": "app-123"}])
    assert results[0]["ok"] is False
    assert "VOLCENGINE_TTS_ACCESS_TOKEN" in results[0]["message"]
