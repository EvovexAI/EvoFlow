"""Keenable web search provider: keyless by default, optional key."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from evoflow.community.web.providers.keenable import KeenableWebSearchProvider


def _response(payload):
    resp = MagicMock()
    resp.json.return_value = payload
    resp.raise_for_status.return_value = None
    return resp


def test_keenable_keyless_uses_public_endpoint_and_maps_results():
    payload = {
        "results": [
            {"title": "A", "url": "https://a.example", "description": "", "snippet": "x" * 2000},
            {"title": "skip", "url": ""},
            {"title": "B", "url": "https://b.example", "description": "desc b", "snippet": "s"},
        ]
    }
    provider = KeenableWebSearchProvider()
    assert provider.is_available() is True
    with (
        patch("evoflow.community.web.providers.keenable.get_provider_env", return_value=""),
        patch("httpx.post", return_value=_response(payload)) as post,
    ):
        out = provider.search("ai", limit=3)

    assert post.call_args.args[0] == "https://api.keenable.ai/v1/search/public"
    assert post.call_args.kwargs["json"] == {"query": "ai", "max_results": 3}
    assert "X-API-Key" not in post.call_args.kwargs["headers"]
    web = out["data"]["web"]
    assert [w["url"] for w in web] == ["https://a.example", "https://b.example"]
    assert len(web[0]["description"]) <= 1001
    assert web[1]["description"] == "desc b"


def test_keenable_keyed_uses_keyed_endpoint():
    provider = KeenableWebSearchProvider()
    with (
        patch("evoflow.community.web.providers.keenable.get_provider_env", return_value="k-1"),
        patch("httpx.post", return_value=_response({"results": []})) as post,
    ):
        provider.search("ai")

    assert post.call_args.args[0] == "https://api.keenable.ai/v1/search"
    assert post.call_args.kwargs["headers"]["X-API-Key"] == "k-1"
