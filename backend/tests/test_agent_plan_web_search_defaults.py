"""Agent Plan materialize wires Doubao preferred + Plan ark- Key (official path)."""

from __future__ import annotations

from typing import Any

import pytest


def test_apply_defaults_sets_doubao_and_plan_key(monkeypatch: pytest.MonkeyPatch) -> None:
    from evoflow.persistence import web_search_settings as wss

    stored: dict[str, Any] = dict(wss.DEFAULT_WEB_SEARCH_SETTINGS)

    monkeypatch.setattr(wss, "get_web_search_settings", lambda: dict(stored))

    def _patch(patch: dict[str, Any]) -> dict[str, Any]:
        stored.update(patch)
        return dict(stored)

    monkeypatch.setattr(wss, "patch_web_search_settings", _patch)
    monkeypatch.setattr(wss, "resolve_agent_plan_doubao_search_api_key", lambda: "")

    out = wss.apply_agent_plan_web_search_defaults(api_key="ark-plan-test-key")
    assert out["preferredBackend"] == "doubao"
    assert out["preferredBackendSource"] == "agent_plan"
    assert out["doubaoApiKey"] == "ark-plan-test-key"
    assert out["doubaoKeySource"] == "agent_plan"


def test_apply_defaults_does_not_clobber_user_key(monkeypatch: pytest.MonkeyPatch) -> None:
    from evoflow.persistence import web_search_settings as wss

    stored: dict[str, Any] = {
        **wss.DEFAULT_WEB_SEARCH_SETTINGS,
        "preferredBackend": "tavily",
        "preferredBackendSource": "user",
        "doubaoApiKey": "user-search-key",
        "doubaoKeySource": "user",
    }
    monkeypatch.setattr(wss, "get_web_search_settings", lambda: dict(stored))
    monkeypatch.setattr(wss, "patch_web_search_settings", lambda patch: (_ for _ in ()).throw(AssertionError(patch)))
    monkeypatch.setattr(wss, "resolve_agent_plan_doubao_search_api_key", lambda: "ark-should-not-apply")

    out = wss.apply_agent_plan_web_search_defaults(api_key="ark-should-not-apply")
    assert out["preferredBackend"] == "tavily"
    assert out["doubaoApiKey"] == "user-search-key"
    assert out["doubaoKeySource"] == "user"


def test_apply_defaults_refreshes_agent_plan_key(monkeypatch: pytest.MonkeyPatch) -> None:
    from evoflow.persistence import web_search_settings as wss

    stored: dict[str, Any] = {
        **wss.DEFAULT_WEB_SEARCH_SETTINGS,
        "preferredBackend": "doubao",
        "preferredBackendSource": "agent_plan",
        "doubaoApiKey": "ark-old",
        "doubaoKeySource": "agent_plan",
    }

    monkeypatch.setattr(wss, "get_web_search_settings", lambda: dict(stored))

    def _patch(patch: dict[str, Any]) -> dict[str, Any]:
        stored.update(patch)
        return dict(stored)

    monkeypatch.setattr(wss, "patch_web_search_settings", _patch)

    out = wss.apply_agent_plan_web_search_defaults(api_key="ark-new")
    assert out["doubaoApiKey"] == "ark-new"
    assert out["doubaoKeySource"] == "agent_plan"


def test_assistant_guide_marks_plan_ready(monkeypatch: pytest.MonkeyPatch) -> None:
    from evoflow.admin import web_search as ws

    monkeypatch.setattr(
        ws,
        "get_web_search",
        lambda: {
            "settings": {
                "preferredBackend": "doubao",
                "doubaoKeySource": "agent_plan",
                "_configured": {"doubaoApiKey": True},
            },
            "active_backend": "doubao",
            "active_source": "agent_plan",
            "agent_plan_web_search": {
                "needs_search_key": False,
                "wired_from_plan": True,
                "ready": True,
                "harness_required": True,
                "doubao_key_source": "agent_plan",
                "steps": [],
            },
        },
    )
    # build_web_search_assistant_guide reads snapshot arg when provided
    guide = ws.build_web_search_assistant_guide(
        {
            "settings": {
                "preferredBackend": "doubao",
                "doubaoKeySource": "agent_plan",
                "_configured": {"doubaoApiKey": True},
            },
            "active_backend": "doubao",
            "active_source": "agent_plan",
            "agent_plan_web_search": {
                "needs_search_key": False,
                "wired_from_plan": True,
                "ready": True,
                "harness_required": True,
                "doubao_key_source": "agent_plan",
                "steps": [],
            },
        }
    )
    assert guide["status"] == "agent_plan_ready"
    assert guide["configured"] is True
    assert guide["online_capable"] is True
    assert guide["wired_from_plan"] is True
    assert "套餐" in guide["say_to_user"] or "Agent Plan" in guide["say_to_user"]
