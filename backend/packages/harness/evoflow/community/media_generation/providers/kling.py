from __future__ import annotations

import json
import logging
import time
from typing import Any

import httpx

from evoflow.community.media_generation.config_helpers import kling_api_base, kling_credentials

logger = logging.getLogger(__name__)

_BASE = "https://api.klingai.com"


def _api_base() -> str:
    return kling_api_base()


def _make_jwt(access_key_id: str, access_key_secret: str) -> str:
    try:
        import jwt  # type: ignore[import-untyped]
    except ImportError as e:
        raise RuntimeError("PyJWT is required for Kling API (pip install PyJWT)") from e

    now = int(time.time())
    payload = {"iss": access_key_id, "exp": now + 1800, "nbf": now - 5}
    return jwt.encode(payload, access_key_secret, algorithm="HS256")


def _auth_header() -> dict[str, str]:
    key_id, secret = kling_credentials()
    if key_id and secret:
        token = _make_jwt(key_id, secret)
        return {"Authorization": f"Bearer {token}"}
    if key_id:
        return {"Authorization": f"Bearer {key_id}"}
    raise ValueError("可灵凭据未配置。请在 EvoFlow → 设置 → 模型 → 创意媒体 → 可灵 填写并启用。")


def _request(method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
    url = f"{_api_base()}{path}"
    headers = {"Content-Type": "application/json", **_auth_header()}
    with httpx.Client(timeout=120.0) as client:
        resp = client.request(method, url, headers=headers, json=body)
    try:
        data = resp.json()
    except Exception:
        data = {"raw": resp.text}
    if resp.status_code >= 400:
        raise RuntimeError(f"Kling API {resp.status_code}: {json.dumps(data, ensure_ascii=False)[:500]}")
    return data if isinstance(data, dict) else {"data": data}


def _task_id_from_response(data: dict[str, Any]) -> str:
    inner = data.get("data") if isinstance(data.get("data"), dict) else data
    for key in ("task_id", "id", "taskId"):
        if isinstance(inner, dict) and inner.get(key):
            return str(inner[key])
        if data.get(key):
            return str(data[key])
    raise RuntimeError(f"Kling response missing task_id: {json.dumps(data, ensure_ascii=False)[:300]}")


def _status_from_response(data: dict[str, Any]) -> tuple[str, str | None, list[str]]:
    inner = data.get("data") if isinstance(data.get("data"), dict) else data
    if not isinstance(inner, dict):
        inner = data
    status = str(inner.get("task_status") or inner.get("status") or "processing").lower()
    urls: list[str] = []
    result = inner.get("task_result") or inner.get("result") or {}
    if isinstance(result, dict):
        for key in ("videos", "images", "url", "video_url", "image_url"):
            val = result.get(key)
            if isinstance(val, str) and val.startswith("http"):
                urls.append(val)
            elif isinstance(val, list):
                for item in val:
                    if isinstance(item, str) and item.startswith("http"):
                        urls.append(item)
                    elif isinstance(item, dict):
                        u = item.get("url") or item.get("video_url") or item.get("image_url")
                        if u:
                            urls.append(str(u))
    primary = urls[0] if urls else None
    if status in ("succeed", "succeeded", "success", "completed"):
        status = "succeeded"
    return status, primary, urls


def submit_image(
    *,
    prompt: str,
    mode: str,
    reference_image_urls: list[str] | None = None,
    aspect_ratio: str = "16:9",
    model_name: str = "kling-v2-1",
) -> str:
    body: dict[str, Any] = {
        "model_name": model_name,
        "prompt": prompt,
        "aspect_ratio": aspect_ratio,
        "n": 1,
    }
    if mode == "image2image" and reference_image_urls:
        body["image"] = reference_image_urls[0] if len(reference_image_urls) == 1 else reference_image_urls
    data = _request("POST", "/v1/images/generations", body)
    return _task_id_from_response(data)


def poll_image(task_id: str) -> tuple[str, str | None, list[str]]:
    data = _request("GET", f"/v1/images/generations/{task_id}")
    return _status_from_response(data)


def submit_video(
    *,
    prompt: str,
    mode: str,
    first_frame_url: str | None = None,
    duration: int = 5,
    aspect_ratio: str = "16:9",
    model_name: str = "kling-v2-6",
    audio_url: str | None = None,
) -> str:
    if mode == "image2video" and first_frame_url:
        path = "/v1/videos/image2video"
        body: dict[str, Any] = {
            "model_name": model_name,
            "prompt": prompt,
            "image": first_frame_url,
            "duration": str(duration),
            "aspect_ratio": aspect_ratio,
        }
    else:
        path = "/v1/videos/text2video"
        body = {
            "model_name": model_name,
            "prompt": prompt,
            "duration": str(duration),
            "aspect_ratio": aspect_ratio,
        }
    if audio_url:
        body["audio_url"] = audio_url
    data = _request("POST", path, body)
    return _task_id_from_response(data)


def poll_video(task_id: str) -> tuple[str, str | None, list[str]]:
    data = _request("GET", f"/v1/videos/{task_id}")
    return _status_from_response(data)
