"""Title middleware must not overwrite a real session title after bind race."""

from __future__ import annotations

from evoflow.agents.middlewares.title_middleware import TitleMiddleware
from evoflow.persistence.session_repositories import is_replaceable_session_title


def test_persist_title_skips_non_replaceable(monkeypatch):
    upserts: list[tuple[str, str]] = []

    monkeypatch.setattr(
        "evoflow.persistence.session_repositories.find_session_key_by_thread_id",
        lambda _tid: "agent:xiaomi:new-test",
    )
    monkeypatch.setattr(
        "evoflow.persistence.session_repositories.load_session_map",
        lambda: {
            "agent:xiaomi:new-test": {
                "title": "小V · 全局助手",
                "context": {"xiaomi_global_assistant": True, "agent_id": "xiaomi"},
            }
        },
    )
    monkeypatch.setattr(
        "evoflow.persistence.session_repositories.upsert_session_row",
        lambda sk, title="": upserts.append((sk, title)) or True,
    )
    monkeypatch.setattr(
        "evoflow.agents.middlewares.title_middleware.time.sleep",
        lambda _s: None,
    )

    mw = TitleMiddleware()
    assert mw._persist_title_to_session_index("thread-1", "抖音口播脚本AI员工") is True
    assert upserts == []
    assert not is_replaceable_session_title("小V · 全局助手")


def test_persist_title_writes_when_placeholder(monkeypatch):
    upserts: list[tuple[str, str]] = []

    monkeypatch.setattr(
        "evoflow.persistence.session_repositories.find_session_key_by_thread_id",
        lambda _tid: "agent:xiaomi:new-test",
    )
    monkeypatch.setattr(
        "evoflow.persistence.session_repositories.load_session_map",
        lambda: {
            "agent:xiaomi:new-test": {
                "title": "新对话",
                "context": {"agent_id": "xiaomi"},
            }
        },
    )
    monkeypatch.setattr(
        "evoflow.persistence.session_repositories.upsert_session_row",
        lambda sk, title="": upserts.append((sk, title)) or True,
    )
    monkeypatch.setattr(
        "evoflow.agents.middlewares.title_middleware.time.sleep",
        lambda _s: None,
    )

    mw = TitleMiddleware()
    assert mw._persist_title_to_session_index("thread-1", "帮我盯值班") is True
    assert upserts == [("agent:xiaomi:new-test", "帮我盯值班")]
