from __future__ import annotations

import base64
import logging
import uuid

import httpx

logger = logging.getLogger(__name__)


def synthesize_speech(text: str, *, voice_type: str | None = None) -> bytes:
    """Volcengine openspeech TTS (same API as podcast-generation skill)."""
    from evoflow.persistence.media_settings import get_vendor_credentials, vendor_setup_hint

    bundle = get_vendor_credentials("volcengine-tts")
    app_id = bundle.get("ttsAppId", "")
    access_token = bundle.get("ttsAccessToken", "")
    cluster = bundle.get("ttsCluster", "volcano_tts")

    if not app_id or not access_token:
        raise ValueError(vendor_setup_hint("volcengine-tts"))

    voice = voice_type or bundle.get("ttsSpeaker", "zh_female_vv_uranus_bigtts")
    url = "https://openspeech.bytedance.com/api/v1/tts"
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer;{access_token}",
    }
    payload = {
        "app": {"appid": app_id, "token": "access_token", "cluster": cluster},
        "user": {"uid": "evoflow-media"},
        "audio": {"voice_type": voice, "encoding": "mp3", "speed_ratio": 1.0},
        "request": {
            "reqid": str(uuid.uuid4()),
            "text": text,
            "text_type": "plain",
            "operation": "query",
        },
    }

    with httpx.Client(timeout=120.0) as client:
        resp = client.post(url, json=payload, headers=headers)

    if resp.status_code != 200:
        raise RuntimeError(f"Volcengine TTS HTTP {resp.status_code}: {resp.text[:300]}")

    result = resp.json()
    if result.get("code") != 3000:
        raise RuntimeError(f"Volcengine TTS error: {result.get('message')} (code={result.get('code')})")

    audio_data = result.get("data")
    if not audio_data:
        raise RuntimeError("Volcengine TTS returned empty audio data")
    return base64.b64decode(audio_data)
