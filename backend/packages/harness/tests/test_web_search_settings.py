"""Web search settings persistence + recommend + test helper."""

from __future__ import annotations

from unittest.mock import patch

from evoflow.persistence.web_search_settings import (
    get_preferred_backend,
    get_web_search_settings,
    get_web_search_settings_masked,
    patch_web_search_settings,
    pick_recommended_backend,
)


def test_patch_and_mask_secrets(tmp_path, monkeypatch) -> None:
    store: dict = {}

    def _get(key: str):
        return store.get(key)

    def _set(key: str, value):
        store[key] = value

    monkeypatch.setattr(
        "evoflow.persistence.web_search_settings.cfg_repo.get_app_setting",
        _get,
    )
    monkeypatch.setattr(
        "evoflow.persistence.web_search_settings.cfg_repo.set_app_setting",
        _set,
    )

    patch_web_search_settings(
        {
            "preferredBackend": "tavily",
            "tavilyApiKey": "sk-test-abcdef123456",
            "searxngUrl": "https://searx.example.com",
        }
    )
    assert get_preferred_backend() == "tavily"
    raw = get_web_search_settings()
    assert raw["tavilyApiKey"] == "sk-test-abcdef123456"
    masked = get_web_search_settings_masked()
    assert masked["preferredBackend"] == "tavily"
    assert masked["tavilyApiKey"] and "*" in str(masked["tavilyApiKey"])
    assert masked["_configured"]["tavilyApiKey"] is True
    assert masked["searxngUrl"] == "https://searx.example.com"

    # Empty secret leaves previous value
    patch_web_search_settings({"tavilyApiKey": ""})
    assert get_web_search_settings()["tavilyApiKey"] == "sk-test-abcdef123456"

    # Invalid backend → auto
    patch_web_search_settings({"preferredBackend": "nope"})
    assert get_preferred_backend() is None


def test_pick_recommended_prefers_quality_over_ddgs() -> None:
    results = [
        {"name": "ddgs", "ok": True, "result_count": 5, "latency_ms": 50},
        {"name": "tavily", "ok": True, "result_count": 3, "latency_ms": 200},
        {"name": "brave-free", "ok": True, "result_count": 4, "latency_ms": 80},
    ]
    assert pick_recommended_backend(results) == "tavily"


def test_pick_recommended_falls_back_to_ddgs() -> None:
    results = [
        {"name": "tavily", "ok": False, "result_count": 0, "latency_ms": 10, "error": "no key"},
        {"name": "ddgs", "ok": True, "result_count": 2, "latency_ms": 120},
    ]
    assert pick_recommended_backend(results) == "ddgs"


def test_pick_recommended_none_when_all_fail() -> None:
    assert pick_recommended_backend([{"name": "ddgs", "ok": False, "result_count": 0}]) is None


def test_apply_credentials_to_mapping(monkeypatch) -> None:
    store: dict = {}

    monkeypatch.setattr(
        "evoflow.persistence.web_search_settings.cfg_repo.get_app_setting",
        lambda key: store.get(key),
    )
    monkeypatch.setattr(
        "evoflow.persistence.web_search_settings.cfg_repo.set_app_setting",
        lambda key, value: store.__setitem__(key, value),
    )
    from evoflow.persistence.web_search_settings import (
        apply_web_search_credentials_to_mapping,
        patch_web_search_settings,
    )

    patch_web_search_settings({"tavilyApiKey": "tvly-xxx", "braveApiKey": "brave-yyy"})
    env: dict[str, str] = {}
    apply_web_search_credentials_to_mapping(env)
    assert env["TAVILY_API_KEY"] == "tvly-xxx"
    assert env["BRAVE_SEARCH_API_KEY"] == "brave-yyy"


def test_get_web_search_includes_agent_plan_status(monkeypatch) -> None:
    from evoflow.admin import web_search as ws

    monkeypatch.setattr(
        ws,
        "get_agent_plan_web_search_status",
        lambda: {
            "catalog_id": "volcengine.agent_plan",
            "binding_id": "bind-1",
            "tier_id": "medium",
            "label": "火山方舟 Agent Plan",
            "capability": "web_search",
            "hint": "plan hint",
            "needs_search_key": True,
            "engine": "doubao",
            "steps": ["step-a", "step-b"],
            "harness_console_url": "https://example.com/harness",
        },
    )
    monkeypatch.setattr(ws, "_active_backend_info", lambda: (None, "none"))
    monkeypatch.setattr(
        ws,
        "_provider_status_list",
        lambda: [{"id": "doubao", "label": "豆包搜索", "available": False}],
    )

    out = ws.get_web_search()
    assert out["active_backend"] == "doubao"
    assert out["active_source"] == "agent_plan"
    assert out["agent_plan_web_search"]["tier_id"] == "medium"
    assert out["providers"][0].get("plan_sourced") is True
    assert out["providers"][0].get("plan_needs_key") is True
    guide = out["assistant_guide"]
    assert guide["status"] == "agent_plan_needs_doubao_key"
    assert "ark-" in guide["say_to_user"] or "ark-" in guide["note"]
    assert guide["links"]["harness_console"]


def test_apply_agent_plan_web_search_defaults_sets_doubao(monkeypatch) -> None:
    store: dict = {}

    monkeypatch.setattr(
        "evoflow.persistence.web_search_settings.cfg_repo.get_app_setting",
        lambda key: store.get(key),
    )
    monkeypatch.setattr(
        "evoflow.persistence.web_search_settings.cfg_repo.set_app_setting",
        lambda key, value: store.__setitem__(key, value),
    )
    from evoflow.persistence.web_search_settings import (
        apply_agent_plan_web_search_defaults,
        get_preferred_backend,
        get_web_search_settings,
        patch_web_search_settings,
    )

    out = apply_agent_plan_web_search_defaults()
    assert out["preferredBackend"] == "doubao"
    assert out["preferredBackendSource"] == "agent_plan"
    assert get_preferred_backend() == "doubao"

    # User override must not be clobbered
    patch_web_search_settings(
        {"preferredBackend": "tavily", "preferredBackendSource": "user"}
    )
    apply_agent_plan_web_search_defaults()
    assert get_web_search_settings()["preferredBackend"] == "tavily"
    assert get_web_search_settings()["preferredBackendSource"] == "user"


def test_normalize_patch_marks_user_provenance() -> None:
    from evoflow.admin.web_search import normalize_web_search_patch

    out = normalize_web_search_patch(
        {"preferredBackend": "bocha", "doubaoApiKey": "sk-search-xxx"}
    )
    assert out["preferredBackendSource"] == "user"
    assert out["doubaoKeySource"] == "user"


def test_run_one_search_mocked() -> None:
    from evoflow.admin.web_search import run_one_search
    from evoflow.community.web.provider import WebSearchProvider
    from evoflow.community.web.registry import register_provider, reset_providers_for_tests

    class _P(WebSearchProvider):
        @property
        def name(self) -> str:
            return "tavily"

        def is_available(self) -> bool:
            return True

        def supports_search(self) -> bool:
            return True

        def search(self, query: str, limit: int = 5) -> dict:
            return {
                "success": True,
                "data": {
                    "web": [
                        {"title": "A", "url": "https://a.example", "description": "d", "position": 1},
                        {"title": "B", "url": "https://b.example", "description": "d", "position": 2},
                    ]
                },
            }

    reset_providers_for_tests()
    register_provider(_P())
    from evoflow.community.web import registry as reg

    reg._loaded = True  # noqa: SLF001

    item = run_one_search("tavily", "q", 5)
    assert item["ok"] is True
    assert item["result_count"] == 2
    assert "A" in item["sample_titles"]
    reset_providers_for_tests()


def test_tool_and_settings_share_run_provider_search(monkeypatch) -> None:
    """web_search tool failover and settings probe must hit the same registry entrypoint."""
    calls: list[tuple[str, str, int]] = []

    def _fake(name: str, query: str, *, limit: int = 5) -> dict:
        calls.append((name, query, limit))
        return {
            "success": True,
            "data": {"web": [{"title": "T", "url": "https://t.example", "description": "d"}]},
        }

    monkeypatch.setattr("evoflow.community.web.registry.run_provider_search", _fake)
    monkeypatch.setattr(
        "evoflow.community.web.registry.resolve_search_backend",
        lambda: "doubao",
    )
    monkeypatch.setattr(
        "evoflow.community.web.registry.get_provider",
        lambda name: type(
            "P",
            (),
            {
                "name": name,
                "supports_search": lambda self: True,
                "is_available": lambda self: True,
            },
        )(),
    )
    monkeypatch.setattr("evoflow.community.web.registry.list_providers", lambda: [])
    monkeypatch.setattr(
        "evoflow.community.web.registry._AUTO_PREFERENCE",
        ["doubao"],
    )

    from evoflow.admin.web_search import run_one_search
    from evoflow.community.baidu_search.tools import _api_licensed_search

    rows = _api_licensed_search("hello", 3)
    assert rows and rows[0]["title"] == "T"
    assert calls and calls[0][0] == "doubao"

    calls.clear()
    # Make get_provider return an object with supports_search for run_one_search availability check
    class _Prov:
        name = "doubao"

        def is_available(self) -> bool:
            return True

        def supports_search(self) -> bool:
            return True

    monkeypatch.setattr("evoflow.community.web.registry.get_provider", lambda name: _Prov())
    out = run_one_search("doubao", "hello", 3)
    assert out["ok"] is True
    assert calls and calls[0][0] == "doubao"
