"""SpecStream web search provider: Search API with a required key."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import httpx

from evoflow.community.web.providers.specstream import SpecStreamWebSearchProvider


def _response(payload):
    resp = MagicMock()
    resp.json.return_value = payload
    resp.raise_for_status.return_value = None
    return resp


def test_specstream_maps_sources_with_bearer_key():
    payload = {
        "data": {
            "sources": [
                {"title": "A", "url": "https://a.example", "site": "a.example", "snippet": "snippet a", "cited": False},
                {"title": "skip", "url": "", "snippet": "", "cited": False},
                {"title": "B", "url": "https://b.example", "site": "b.example", "snippet": "snippet b", "cited": False},
            ]
        }
    }
    provider = SpecStreamWebSearchProvider()
    with (
        patch("evoflow.community.web.providers.specstream.get_provider_env", return_value="ss-1"),
        patch("httpx.get", return_value=_response(payload)) as get,
    ):
        assert provider.is_available() is True
        out = provider.search("ai", limit=3)

    assert get.call_args.args[0] == "https://api.specstream.ai/v1/web-search"
    assert get.call_args.kwargs["params"] == {"q": "ai", "num": 3, "speed": "fast"}
    assert get.call_args.kwargs["headers"]["Authorization"] == "Bearer ss-1"
    web = out["data"]["web"]
    assert [w["url"] for w in web] == ["https://a.example", "https://b.example"]
    assert [w["position"] for w in web] == [1, 2]
    assert web[1]["description"] == "snippet b"


def test_specstream_without_key_is_unavailable_and_skips_request():
    provider = SpecStreamWebSearchProvider()
    with (
        patch("evoflow.community.web.providers.specstream.get_provider_env", return_value=""),
        patch("httpx.get") as get,
    ):
        assert provider.is_available() is False
        out = provider.search("ai")

    assert out["success"] is False
    assert "SPECSTREAM_API_KEY" in out["error"]
    get.assert_not_called()


def test_specstream_http_error_returns_failure():
    resp = MagicMock()
    resp.raise_for_status.side_effect = httpx.HTTPStatusError("401 Unauthorized", request=MagicMock(), response=MagicMock())
    provider = SpecStreamWebSearchProvider()
    with (
        patch("evoflow.community.web.providers.specstream.get_provider_env", return_value="ss-1"),
        patch("httpx.get", return_value=resp),
    ):
        out = provider.search("ai")

    assert out["success"] is False
    assert out["error"].startswith("SpecStream search failed")
