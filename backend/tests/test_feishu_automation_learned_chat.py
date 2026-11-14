"""Learned Feishu automation chat_id must reject test stubs like oc_test."""

from __future__ import annotations

from app.channels.feishu_automation_learned_chat import (
    is_plausible_feishu_chat_id,
    read_learned_feishu_automation_chat_id,
    remember_feishu_automation_chat_from_inbound,
)


def test_rejects_placeholder_chat_ids() -> None:
    assert not is_plausible_feishu_chat_id("oc_test")
    assert not is_plausible_feishu_chat_id("oc_test_chat")
    assert not is_plausible_feishu_chat_id("test")
    assert not is_plausible_feishu_chat_id("")
    assert is_plausible_feishu_chat_id("oc_87497a301c2f1a43dcd5f7f56438f05d")


def test_remember_ignores_placeholder(monkeypatch) -> None:
    writes: list[tuple[str, str]] = []

    monkeypatch.setattr(
        "evoflow.persistence.config_repositories.get_app_setting",
        lambda _k: None,
    )

    def _set(key: str, value: str) -> None:
        writes.append((key, value))

    monkeypatch.setattr(
        "evoflow.persistence.config_repositories.set_app_setting",
        _set,
    )

    remember_feishu_automation_chat_from_inbound("oc_test")
    assert writes == []
    remember_feishu_automation_chat_from_inbound("oc_87497a301c2f1a43dcd5f7f56438f05d")
    assert any(v == "oc_87497a301c2f1a43dcd5f7f56438f05d" for _, v in writes)


def test_read_clears_poisoned_setting(monkeypatch) -> None:
    cleared: list[str] = []

    monkeypatch.setattr(
        "evoflow.persistence.config_repositories.get_app_setting",
        lambda _k: "oc_test",
    )

    def _set(key: str, value: str) -> None:
        cleared.append(key)

    monkeypatch.setattr(
        "evoflow.persistence.config_repositories.set_app_setting",
        _set,
    )

    assert read_learned_feishu_automation_chat_id() is None
    assert "feishu.automation_learned_chat_id" in cleared
