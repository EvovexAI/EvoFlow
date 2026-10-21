"""web_search fail-fast when Keys missing — prompt via platform, don't hang on ddgs."""

from __future__ import annotations

from typing import Any

import pytest


def test_resolve_gate_skips_ddgs_when_agent_plan_needs_key(monkeypatch: pytest.MonkeyPatch) -> None:
    from evoflow.admin import web_search as ws

    monkeypatch.setattr(
        ws,
        "get_web_search",
        lambda: {
            "settings": {
                "preferredBackend": "doubao",
                "_configured": {"doubaoApiKey": False},
            },
            "active_backend": "doubao",
            "active_source": "agent_plan",
            "agent_plan_web_search": {"needs_search_key": True, "steps": []},
            "assistant_guide": {
                "status": "agent_plan_needs_doubao_key",
                "say_to_user": "请提供豆包联网 Key",
                "preferred_backend": "doubao",
            },
        },
    )
    gate = ws.resolve_web_search_setup_gate()
    assert gate["needs_configuration"] is True
    assert gate["skip_slow_ddgs"] is True
    assert "platform" in str(gate.get("platform_hint") or "").lower() or "settings.patch" in str(
        gate.get("platform_hint") or ""
    )


def test_resolve_gate_skips_ddgs_even_if_preferred_ddgs_while_keys_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Missing Keys → fail-fast prompt; do not burn 45s on ddgs even if preferred=ddgs."""
    from evoflow.admin import web_search as ws

    monkeypatch.setattr(
        ws,
        "get_web_search",
        lambda: {
            "settings": {"preferredBackend": "ddgs", "_configured": {}},
            "active_backend": "ddgs",
            "active_source": "settings",
            "agent_plan_web_search": {"needs_search_key": True, "steps": []},
            "assistant_guide": {
                "status": "agent_plan_needs_doubao_key",
                "say_to_user": "…",
                "preferred_backend": "ddgs",
            },
        },
    )
    gate = ws.resolve_web_search_setup_gate()
    assert gate["needs_configuration"] is True
    assert gate["skip_slow_ddgs"] is True


def test_api_licensed_search_skips_unavailable_and_slow_ddgs(monkeypatch: pytest.MonkeyPatch) -> None:
    from evoflow.community.baidu_search import tools as t
    from evoflow.community.web import registry

    class _FakeProv:
        def __init__(self, name: str, available: bool) -> None:
            self.name = name
            self._available = available

        def supports_search(self) -> bool:
            return True

        def is_available(self) -> bool:
            return self._available

    doubao = _FakeProv("doubao", False)
    ddgs = _FakeProv("ddgs", True)
    providers = {"doubao": doubao, "ddgs": ddgs}
    calls: list[str] = []

    monkeypatch.setattr(t, "_web_search_setup_gate", lambda: {
        "needs_configuration": True,
        "skip_slow_ddgs": True,
        "assistant_guide": {"status": "agent_plan_needs_doubao_key", "say_to_user": "请配 Key"},
        "platform_hint": "settings.patch_web_search",
        "reason": "agent_plan_needs_doubao_key",
    })
    monkeypatch.setattr(registry, "resolve_search_backend", lambda: "doubao")
    monkeypatch.setattr(registry, "get_provider", lambda n: providers.get(str(n)))
    monkeypatch.setattr(registry, "list_providers", lambda: [doubao, ddgs])
    monkeypatch.setattr(registry, "_AUTO_PREFERENCE", ["doubao", "ddgs"])

    def _run(name: str, q: str, limit: int = 5) -> dict[str, Any]:
        calls.append(name)
        return {"success": True, "data": {"web": [{"title": "x", "url": "http://x", "description": "y"}]}}

    monkeypatch.setattr(registry, "run_provider_search", _run)

    hits, meta = t._api_licensed_search("hello", 3)
    assert hits == []
    assert calls == []  # neither unavailable doubao nor skipped ddgs
    assert meta["needs_configuration"] is True
    assert meta["skip_slow_ddgs"] is True
