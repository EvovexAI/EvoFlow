"""Bocha / 博查搜索 — EvoFlow pluggable web provider."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from evoflow.community.web.providers.bocha import BochaWebSearchProvider
from evoflow.persistence.web_search_settings import pick_recommended_backend


def test_bocha_unavailable_without_key(monkeypatch) -> None:
    monkeypatch.delenv("BOCHA_API_KEY", raising=False)
    monkeypatch.delenv("BOCHA_SEARCH_API_KEY", raising=False)
    monkeypatch.delenv("BOCHAAI_API_KEY", raising=False)
    monkeypatch.setattr(
        "evoflow.persistence.web_search_settings.get_web_search_settings",
        lambda: {"bochaApiKey": "", "bochaBaseUrl": ""},
    )
    p = BochaWebSearchProvider()
    assert p.is_available() is False
    out = p.search("hello")
    assert out["success"] is False
    assert "BOCHA_API_KEY" in out["error"]


def test_bocha_search_maps_web_pages(monkeypatch) -> None:
    monkeypatch.setenv("BOCHA_API_KEY", "sk-bocha")
    p = BochaWebSearchProvider()
    assert p.is_available() is True

    fake_resp = MagicMock()
    fake_resp.raise_for_status = MagicMock()
    fake_resp.json.return_value = {
        "code": 200,
        "data": {
            "_type": "SearchResponse",
            "webPages": {
                "value": [
                    {
                        "name": "ESG 报告",
                        "url": "https://example.com/esg",
                        "siteName": "阿里巴巴集团",
                        "snippet": "短摘要",
                        "summary": "长摘要正文",
                        "datePublished": "2024-07-22T00:00:00+08:00",
                    }
                ]
            },
        },
    }

    with patch("httpx.post", return_value=fake_resp) as post:
        out = p.search("阿里巴巴ESG", limit=8)

    assert out["success"] is True
    web = out["data"]["web"]
    assert len(web) == 1
    assert web[0]["title"] == "ESG 报告"
    assert web[0]["url"] == "https://example.com/esg"
    assert "长摘要正文" in web[0]["description"]

    kwargs = post.call_args.kwargs
    assert kwargs["headers"]["Authorization"] == "Bearer sk-bocha"
    assert kwargs["json"]["query"] == "阿里巴巴ESG"
    assert kwargs["json"]["summary"] is True
    assert kwargs["json"]["count"] == 8
    assert str(post.call_args.args[0]).endswith("/v1/web-search")


def test_bocha_business_error(monkeypatch) -> None:
    monkeypatch.setenv("BOCHA_API_KEY", "sk-bad")
    p = BochaWebSearchProvider()
    fake_resp = MagicMock()
    fake_resp.raise_for_status = MagicMock()
    fake_resp.json.return_value = {"code": 401, "msg": "invalid api key"}
    with patch("httpx.post", return_value=fake_resp):
        out = p.search("q")
    assert out["success"] is False
    assert "401" in out["error"]


def test_recommend_bocha_after_doubao() -> None:
    results = [
        {"name": "tavily", "ok": True, "result_count": 3, "latency_ms": 50},
        {"name": "bocha", "ok": True, "result_count": 3, "latency_ms": 80},
        {"name": "doubao", "ok": True, "result_count": 3, "latency_ms": 200},
    ]
    assert pick_recommended_backend(results) == "doubao"
    results_no_doubao = [
        {"name": "tavily", "ok": True, "result_count": 3, "latency_ms": 50},
        {"name": "bocha", "ok": True, "result_count": 3, "latency_ms": 80},
    ]
    assert pick_recommended_backend(results_no_doubao) == "bocha"
