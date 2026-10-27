"""MiniMax OpenAI-Videos gateway routing (hon-maas style) — no live calls."""

from __future__ import annotations

from unittest.mock import patch

import pytest


@pytest.fixture
def gateway_base(monkeypatch):
    from evoflow.community.media_generation.providers import minimax_video as mv

    monkeypatch.setattr(mv, "minimax_media_api_key", lambda: "sk-test")
    monkeypatch.setattr(
        mv,
        "minimax_media_base_url",
        lambda: "https://token-service-qy.hon-maas.com/v1",
    )
    return mv


def test_detects_openai_videos_on_hon_maas(gateway_base):
    mv = gateway_base
    assert mv.uses_openai_videos_api("minimax-h3") is True
    assert mv.uses_openai_videos_api("minimax-h3/QY3") is True
    assert mv.uses_openai_videos_api("MiniMax-H3") is True  # base forces gateway


def test_official_host_stays_native(monkeypatch):
    from evoflow.community.media_generation.providers import minimax_video as mv

    monkeypatch.setattr(mv, "minimax_media_api_key", lambda: "sk-test")
    monkeypatch.setattr(mv, "minimax_media_base_url", lambda: "https://api.minimax.cn")
    assert mv.uses_openai_videos_api("MiniMax-H3") is False
    assert mv.uses_openai_videos_api("minimax-h3") is False


def test_submit_posts_videos_path(gateway_base):
    mv = gateway_base
    captured: dict = {}

    class _Resp:
        status_code = 200

        def json(self):
            return {"id": "video_abc", "status": "queued", "object": "video"}

    class _Client:
        def __init__(self, *a, **k):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def post(self, url, headers=None, json=None):
            captured["url"] = url
            captured["json"] = json
            return _Resp()

    with patch.object(mv.httpx, "Client", _Client):
        tid = mv.submit_video(
            prompt="一只猫走路",
            mode="text2video",
            model="minimax-h3",
            duration=5,
            resolution="768P",
            aspect_ratio="16:9",
        )

    assert tid == "oai:video_abc"
    assert captured["url"].endswith("/v1/videos")
    assert captured["json"]["model"] == "minimax-h3"
    assert captured["json"]["prompt"] == "一只猫走路"
    assert "seconds" in captured["json"]


def test_provider_routing_gateway_model():
    from evoflow.community.media_generation.provider_registry import provider_for_model

    assert provider_for_model("minimax-h3", capability="video") == "minimax"
    assert provider_for_model("minimax-h3/QY3", capability="video") == "minimax"
