"""Doubao / 豆包搜索 — EvoFlow pluggable web provider."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from evoflow.community.web.providers.doubao import DoubaoWebSearchProvider
from evoflow.persistence.web_search_settings import pick_recommended_backend


def test_doubao_unavailable_without_key(monkeypatch) -> None:
    monkeypatch.delenv("DOUBAO_SEARCH_API_KEY", raising=False)
    monkeypatch.delenv("VOLCENGINE_SEARCH_API_KEY", raising=False)
    monkeypatch.delenv("WEB_SEARCH_API_KEY", raising=False)
    monkeypatch.setattr(
        "evoflow.persistence.web_search_settings.get_web_search_settings",
        lambda: {"doubaoApiKey": "", "doubaoBaseUrl": ""},
    )
    p = DoubaoWebSearchProvider()
    assert p.is_available() is False
    out = p.search("hello")
    assert out["success"] is False
    assert "DOUBAO_SEARCH_API_KEY" in out["error"]


def test_doubao_search_maps_web_results(monkeypatch) -> None:
    monkeypatch.setenv("DOUBAO_SEARCH_API_KEY", "sk-test")
    p = DoubaoWebSearchProvider()
    assert p.is_available() is True

    fake_resp = MagicMock()
    fake_resp.raise_for_status = MagicMock()
    fake_resp.json.return_value = {
        "Result": {
            "WebResults": [
                {
                    "Title": "Hello",
                    "Url": "https://example.com/a",
                    "Summary": "snippet text",
                    "SiteName": "Example",
                    "PublishTime": "2026-08-01",
                }
            ]
        }
    }

    with patch("httpx.post", return_value=fake_resp) as post:
        out = p.search("今天新闻", limit=5)

    assert out["success"] is True
    web = out["data"]["web"]
    assert len(web) == 1
    assert web[0]["title"] == "Hello"
    assert web[0]["url"] == "https://example.com/a"
    assert "snippet text" in web[0]["description"]

    kwargs = post.call_args.kwargs
    assert kwargs["headers"]["Authorization"] == "Bearer sk-test"
    assert kwargs["json"]["Query"] == "今天新闻"
    assert kwargs["json"]["SearchType"] == "web"
    assert kwargs["json"]["NeedSummary"] is True


def test_doubao_business_error(monkeypatch) -> None:
    monkeypatch.setenv("DOUBAO_SEARCH_API_KEY", "sk-bad")
    p = DoubaoWebSearchProvider()
    fake_resp = MagicMock()
    fake_resp.raise_for_status = MagicMock()
    fake_resp.json.return_value = {
        "ResponseMetadata": {"Error": {"Code": "invalid_api_key", "Message": "bad key"}}
    }
    with patch("httpx.post", return_value=fake_resp):
        out = p.search("q")
    assert out["success"] is False
    assert "invalid_api_key" in out["error"]


def test_recommend_prefers_doubao() -> None:
    results = [
        {"name": "tavily", "ok": True, "result_count": 3, "latency_ms": 50},
        {"name": "doubao", "ok": True, "result_count": 3, "latency_ms": 200},
    ]
    assert pick_recommended_backend(results) == "doubao"
