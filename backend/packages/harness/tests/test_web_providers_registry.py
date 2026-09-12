"""EvoFlow pluggable web provider registry + dispatch."""

from __future__ import annotations

from unittest.mock import patch

from evoflow.community.web.provider import WebSearchProvider
from evoflow.community.web.registry import (
    get_active_search_provider,
    get_provider,
    list_providers,
    register_provider,
    reset_providers_for_tests,
    resolve_search_backend,
)


class _FakeProvider(WebSearchProvider):
    def __init__(self, name: str, *, available: bool = True, hits: list[dict] | None = None):
        self._name = name
        self._available = available
        self._hits = hits or []

    @property
    def name(self) -> str:
        return self._name

    def is_available(self) -> bool:
        return self._available

    def search(self, query: str, limit: int = 5) -> dict:
        web = [
            {
                "title": h.get("title", "t"),
                "url": h.get("url", "https://example.com"),
                "description": h.get("description", "d"),
                "position": i + 1,
            }
            for i, h in enumerate(self._hits[:limit])
        ]
        return {"success": True, "data": {"web": web}}


def setup_function() -> None:
    reset_providers_for_tests()


def teardown_function() -> None:
    reset_providers_for_tests()


def test_builtin_providers_register() -> None:
    names = {p.name for p in list_providers()}
    assert {"doubao", "tavily", "infoquest", "firecrawl", "searxng", "brave-free", "ddgs"} <= names


def test_resolve_prefers_available_in_registry_order() -> None:
    reset_providers_for_tests()
    register_provider(_FakeProvider("tavily", available=True))
    register_provider(_FakeProvider("ddgs", available=True))
    # Force loaded so ensure_providers_loaded doesn't wipe fakes
    from evoflow.community.web import registry as reg

    reg._loaded = True  # noqa: SLF001
    with patch("evoflow.persistence.web_search_settings.get_preferred_backend", return_value=None):
        with patch.object(reg, "_read_web_config", return_value={}):
            # No-key ddgs is preferred over paid backends when config is unset
            assert resolve_search_backend() == "ddgs"
            active = get_active_search_provider()
            assert active is not None
            assert active.name == "ddgs"


def test_yaml_web_backend_ignored_without_settings() -> None:
    """config.yaml web.backend must not override search preference."""
    reset_providers_for_tests()
    register_provider(_FakeProvider("tavily", available=True))
    register_provider(_FakeProvider("ddgs", available=True))
    from evoflow.community.web import registry as reg

    reg._loaded = True  # noqa: SLF001
    with patch("evoflow.persistence.web_search_settings.get_preferred_backend", return_value=None):
        with patch.object(reg, "_read_web_config", return_value={"backend": "tavily"}):
            # YAML says tavily, but without settings preferred we auto-pick ddgs first
            assert resolve_search_backend() == "ddgs"


def test_panel_preferred_backend_wins() -> None:
    reset_providers_for_tests()
    register_provider(_FakeProvider("tavily", available=True))
    register_provider(_FakeProvider("ddgs", available=True))
    from evoflow.community.web import registry as reg

    reg._loaded = True  # noqa: SLF001
    with patch("evoflow.persistence.web_search_settings.get_preferred_backend", return_value="tavily"):
        with patch.object(reg, "_read_web_config", return_value={"backend": "ddgs"}):
            assert resolve_search_backend() == "tavily"


def test_api_licensed_search_maps_provider_envelope() -> None:
    from evoflow.community.baidu_search.tools import _api_licensed_search

    fake = _FakeProvider(
        "tavily",
        hits=[{"title": "Hello", "url": "https://a.example/x", "description": "snip"}],
    )
    with patch("evoflow.community.web.registry.get_provider", return_value=fake):
        with patch(
            "evoflow.community.web.registry.resolve_search_backend",
            return_value="tavily",
        ):
            with patch(
                "evoflow.community.web.registry.list_providers",
                return_value=[fake],
            ):
                rows = _api_licensed_search("q", 5)
    assert len(rows) == 1
    assert rows[0]["title"] == "Hello"
    assert rows[0]["href"] == "https://a.example/x"
    assert rows[0]["body"] == "snip"
    assert rows[0]["_engine"] == "tavily"


def test_api_licensed_search_settings_preferred_before_yaml_failover() -> None:
    """Settings preferredBackend is tried before YAML preferred_engines failover."""
    from evoflow.community.baidu_search.tools import _api_licensed_search
    from evoflow.community.web.registry import register_provider, reset_providers_for_tests

    reset_providers_for_tests()
    doubao = _FakeProvider(
        "doubao",
        hits=[{"title": "DoubaoHit", "url": "https://d.example/x", "description": "d"}],
    )
    ddgs = _FakeProvider(
        "ddgs",
        hits=[{"title": "DdgsHit", "url": "https://g.example/x", "description": "g"}],
    )
    register_provider(doubao)
    register_provider(ddgs)
    from evoflow.community.web import registry as reg

    reg._loaded = True  # noqa: SLF001

    with patch("evoflow.community.web.registry.resolve_search_backend", return_value="doubao"):
        with patch("evoflow.community.web.registry.list_providers", return_value=[doubao, ddgs]):
            with patch(
                "evoflow.community.web.registry.get_provider",
                side_effect=lambda n: {"doubao": doubao, "ddgs": ddgs}.get(n),
            ):
                rows = _api_licensed_search("q", 5, preferred=["ddgs"])
    assert len(rows) == 1
    assert rows[0]["_engine"] == "doubao"
    assert rows[0]["title"] == "DoubaoHit"
    reset_providers_for_tests()


def test_api_licensed_search_rejects_baidu_engine_name() -> None:
    from evoflow.community.baidu_search.tools import _api_licensed_search

    with patch("evoflow.community.web.registry.get_provider", return_value=None) as gp:
        with patch(
            "evoflow.community.web.registry.get_active_search_provider",
            return_value=None,
        ):
            rows = _api_licensed_search("q", 5, preferred=["baidu", "bing"])
    assert rows == []
    for call in gp.call_args_list:
        assert call.args[0] not in {"baidu", "bing", "sogou"}


def test_get_provider_after_load() -> None:
    p = get_provider("tavily")
    assert p is not None
    assert p.name == "tavily"
    assert isinstance(p.is_available(), bool)
