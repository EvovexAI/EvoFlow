"""DashScope CosyVoice HTTP TTS client."""

from __future__ import annotations

import base64
import json
from unittest.mock import MagicMock, patch

import pytest

from evoflow.community.media_generation.providers import dashscope_tts


@pytest.fixture(autouse=True)
def _tts_env(monkeypatch):
    monkeypatch.setenv("DASHSCOPE_API_KEY", "sk-test")
    monkeypatch.delenv("DASHSCOPE_TTS_MODEL", raising=False)
    monkeypatch.delenv("DASHSCOPE_TTS_VOICE", raising=False)


def test_synthesize_uses_speech_synthesizer_endpoint():
    payload = {
        "output": {
            "finish_reason": "stop",
            "audio": {"data": base64.b64encode(b"mp3bytes").decode("ascii"), "url": ""},
        }
    }
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.headers = {"content-type": "application/json"}
    mock_resp.content = json.dumps(payload).encode()
    mock_resp.json.return_value = payload

    with patch("evoflow.community.media_generation.providers.dashscope_tts.httpx.Client") as client_cls:
        client = client_cls.return_value.__enter__.return_value
        client.post.return_value = mock_resp
        out = dashscope_tts.synthesize_speech("你好呀")

    assert out == b"mp3bytes"
    call = client.post.call_args
    assert call.args[0].endswith("/services/audio/tts/SpeechSynthesizer")
    body = call.kwargs["json"]
    assert body["model"] == "cosyvoice-v3-flash"
    assert body["input"]["text"] == "你好呀"
    assert body["input"]["voice"] == "longanyang"
    assert body["input"]["format"] == "mp3"


def test_synthesize_downloads_from_audio_url_when_data_empty():
    payload = {
        "output": {
            "audio": {
                "data": "",
                "url": "https://example.com/out.mp3",
            }
        }
    }
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.headers = {"content-type": "application/json"}
    mock_resp.content = json.dumps(payload).encode()
    mock_resp.json.return_value = payload

    audio_resp = MagicMock()
    audio_resp.status_code = 200
    audio_resp.content = b"from-url"

    with patch("evoflow.community.media_generation.providers.dashscope_tts.httpx.Client") as client_cls:
        client = client_cls.return_value.__enter__.return_value
        client.post.return_value = mock_resp
        client.get.return_value = audio_resp
        out = dashscope_tts.synthesize_speech("test")

    assert out == b"from-url"
    client.get.assert_called_once_with("https://example.com/out.mp3")


def test_legacy_voice_mapped_to_v3_default():
    payload = {
        "output": {"audio": {"data": base64.b64encode(b"x").decode(), "url": ""}},
    }
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.headers = {"content-type": "application/json"}
    mock_resp.json.return_value = payload

    with patch.dict("os.environ", {"DASHSCOPE_TTS_VOICE": "longxiaochun"}, clear=False):
        with patch("evoflow.community.media_generation.providers.dashscope_tts.httpx.Client") as client_cls:
            client = client_cls.return_value.__enter__.return_value
            client.post.return_value = mock_resp
            dashscope_tts.synthesize_speech("hi")

    body = client.post.call_args.kwargs["json"]
    assert body["input"]["voice"] == "longanyang"
