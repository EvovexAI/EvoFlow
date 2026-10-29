"""MiniMax OpenAI-Videos gateway routing (hon-maas style) — no live calls."""

from __future__ import annotations

import json
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


def test_openai_dims_match_hon_maas_doc(gateway_base):
    mv = gateway_base
    size, w, h, ar = mv._openai_dims("768P", "16:9")
    assert size == "1344x768"
    assert (w, h, ar) == (1344, 768, "16:9")
    size2, w2, h2, _ = mv._openai_dims("2K", "9:16")
    assert size2 == "1080x1920"
    assert (w2, h2) == (1080, 1920)


def _multipart_map(files) -> dict:
    """Normalize list-of-tuples or dict multipart into {name: first_value}."""
    if isinstance(files, dict):
        return files
    out: dict = {}
    for name, value in files or []:
        out.setdefault(name, value)
    return out


def _multipart_all(files, key: str) -> list:
    if isinstance(files, dict):
        val = files.get(key)
        return [val] if val is not None else []
    return [value for name, value in (files or []) if name == key]


def test_submit_posts_multipart_t2va(gateway_base):
    mv = gateway_base
    captured: dict = {}

    class _Resp:
        status_code = 200

        def json(self):
            return {"id": "video_abc", "status": "queued", "progress": 0}

    class _Client:
        def __init__(self, *a, **k):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def post(self, url, headers=None, files=None, json=None, data=None):
            captured["url"] = url
            captured["headers"] = headers
            captured["files"] = files
            captured["json"] = json
            captured["data"] = data
            return _Resp()

    with patch.object(mv.httpx, "Client", _Client):
        tid = mv.submit_video(
            prompt="A cat walking in a garden",
            mode="text2video",
            model="minimax-h3/QY3",
            duration=4,
            resolution="768P",
            aspect_ratio="16:9",
        )

    assert tid == "oai:video_abc"
    assert captured["url"].endswith("/v1/videos")
    assert captured["json"] is None
    assert captured["data"] is None
    assert "Content-Type" not in (captured["headers"] or {})
    files = _multipart_map(captured["files"])
    assert files["model"][1] == "minimax-h3/QY3"
    assert files["prompt"][1] == "A cat walking in a garden"
    assert files["seconds"][1] == "4"
    assert files["size"][1] == "1344x768"
    assert files["width"][1] == "1344"
    assert files["height"][1] == "768"
    assert files["aspect_ratio"][1] == "16:9"
    assert files["num_inference_steps"][1] == "30"
    assert files["flow_shift"][1] == "12"
    assert "file" not in files
    assert "input_references" not in files
    extra = json.loads(files["extra_params"][1])
    assert extra == {"task": "t2va"}


def test_submit_posts_multipart_fl2va_with_input_references(gateway_base):
    mv = gateway_base
    captured: dict = {}

    class _Resp:
        status_code = 200

        def json(self):
            return {"id": "video_i2v", "status": "queued", "progress": 0}

    class _Client:
        def __init__(self, *a, **k):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def post(self, url, headers=None, files=None, json=None, data=None):
            captured["files"] = files
            return _Resp()

    png = (
        "data:image/png;base64,"
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
    )
    with patch.object(mv.httpx, "Client", _Client):
        tid = mv.submit_video(
            prompt="animate",
            mode="image2video",
            model="minimax-h3",
            first_frame_url=png,
            duration=4,
            aspect_ratio="16:9",
        )

    assert tid == "oai:video_i2v"
    refs = _multipart_all(captured["files"], "input_references")
    assert len(refs) == 1
    assert refs[0][0].endswith(".png")
    assert isinstance(refs[0][1], (bytes, bytearray))
    assert not _multipart_all(captured["files"], "file")
    extra = json.loads(_multipart_map(captured["files"])["extra_params"][1])
    assert extra == {"task": "fl2va", "frame_indices": [0]}


def test_submit_posts_multipart_fl2va_first_last(gateway_base):
    mv = gateway_base
    captured: dict = {}

    class _Resp:
        status_code = 200

        def json(self):
            return {"id": "video_fl", "status": "queued", "progress": 0}

    class _Client:
        def __init__(self, *a, **k):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def post(self, url, headers=None, files=None, json=None, data=None):
            captured["files"] = files
            return _Resp()

    png = (
        "data:image/png;base64,"
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
    )
    with patch.object(mv.httpx, "Client", _Client):
        tid = mv.submit_video(
            prompt="from first to last",
            mode="image2video",
            model="minimax-h3/QY3",
            first_frame_url=png,
            last_frame_url=png,
            duration=4,
            aspect_ratio="16:9",
        )

    assert tid == "oai:video_fl"
    refs = _multipart_all(captured["files"], "input_references")
    assert len(refs) == 2
    extra = json.loads(_multipart_map(captured["files"])["extra_params"][1])
    assert extra == {"task": "fl2va", "frame_indices": [0, -1]}


def test_provider_routing_gateway_model():
    from evoflow.community.media_generation.provider_registry import provider_for_model

    assert provider_for_model("minimax-h3", capability="video") == "minimax"
    assert provider_for_model("minimax-h3/QY3", capability="video") == "minimax"


def test_clamp_gateway_seconds_min_is_four(gateway_base):
    mv = gateway_base
    assert mv._clamp_gateway_seconds(3) == 4
    assert mv._clamp_gateway_seconds(4) == 4
    assert mv._clamp_gateway_seconds(15) == 15
    assert mv._clamp_gateway_seconds(99) == 15
