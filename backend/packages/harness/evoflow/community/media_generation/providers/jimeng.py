from __future__ import annotations

import json
import logging
import os
from typing import Any

import httpx

from evoflow.community.media_generation.aspect_ratio import ensure_jimeng_image_size
from evoflow.community.media_generation.config_helpers import (
    jimeng_image_model,
    jimeng_video_base,
    jimeng_video_model,
    volcengine_api_key,
    volcengine_ark_base,
)

logger = logging.getLogger(__name__)


def _assert_plan_capability(capability: str) -> None:
    """If an active Plan binding exists, enforce tier entitlements before calling Ark."""
    try:
        from evoflow.plans.errors import PlanError
        from evoflow.plans.resolver import assert_vendor_plan_allows
    except Exception:
        return
    try:
        assert_vendor_plan_allows(capability, vendor="volcengine", plan_family="agent_plan")
    except PlanError as exc:
        raise ValueError(exc.message) from exc


def _ark_headers() -> dict[str, str]:
    key = volcengine_api_key()
    if not key:
        raise ValueError("Set VOLCENGINE_API_KEY or ARK_API_KEY for Jimeng/Ark image APIs")
    return {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}


def _request_ark(method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
    url = f"{volcengine_ark_base()}{path}"
    with httpx.Client(timeout=120.0) as client:
        resp = client.request(method, url, headers=_ark_headers(), json=body if method.upper() != "GET" else None)
    try:
        data = resp.json()
    except Exception:
        data = {"raw": resp.text}
    if resp.status_code >= 400:
        detail = json.dumps(data, ensure_ascii=False)[:500]
        hint = ""
        low = detail.lower()
        if any(x in low for x in ("not activated", "未激活", "未开通", "invalidmodel", "model not found", "access denied")):
            hint = (
                " 提示：provider=jimeng 即火山方舟 Ark（VOLCENGINE_API_KEY）。"
                "请在火山方舟控制台 → 在线推理 → 创建接入点，开通 Seedream/Seedance 模型"
                "（或在 EvoPanel → 设置 → 模型 → 视频模型 → 火山方舟 中填写生图/生视频模型，支持 ep-xxx 接入点 ID）。"
                "勿自动改用 wan/kling，除非用户明确要求。"
            )
        elif resp.status_code == 401:
            hint = (
                " 提示：生图/生视频 API 基址应为 https://ark.cn-beijing.volces.com/api/plan/v3"
                "（不是对话用的 /api/v3）。请确认 Ark API Key 有效且已在 EvoPanel 保存。"
            )
        raise RuntimeError(f"Jimeng/Ark {resp.status_code}: {detail}{hint}")
    return data if isinstance(data, dict) else {}


def _get_ark(path: str) -> dict[str, Any]:
    return _request_ark("GET", path)


def _use_seedance_video() -> bool:
    return os.getenv("JIMENG_USE_SEEDANCE", "1").strip().lower() not in ("0", "false", "no")


def _seedance_generate_audio() -> bool:
    return os.getenv("SEEDANCE_GENERATE_AUDIO", "1").strip().lower() not in ("0", "false", "no")


def _seedance_video_model() -> str:
    return jimeng_video_model()


def _build_seedance_content(
    *,
    prompt: str,
    mode: str,
    first_frame_url: str | None,
) -> list[dict[str, Any]]:
    content: list[dict[str, Any]] = [{"type": "text", "text": prompt}]
    if mode == "image2video" and first_frame_url:
        content.append(
            {
                "type": "image_url",
                "image_url": {"url": first_frame_url},
                "role": "first_frame",
            }
        )
    return content


def _extract_task_status(data: dict[str, Any]) -> str:
    raw = data.get("status") or data.get("task_status")
    if isinstance(raw, str) and raw.strip():
        return raw.lower()
    return "processing"


def _extract_video_urls(data: dict[str, Any]) -> list[str]:
    urls = _extract_urls(data)
    for block in (data.get("output"), data.get("content"), data.get("data")):
        if not isinstance(block, dict):
            continue
        for key in ("video_url", "url"):
            val = block.get(key)
            if isinstance(val, str) and val.strip():
                urls.append(val.strip())
    return list(dict.fromkeys(urls))


def _extract_urls(data: dict[str, Any]) -> list[str]:
    urls: list[str] = []
    for item in data.get("data") or []:
        if isinstance(item, dict) and item.get("url"):
            urls.append(str(item["url"]))
    if not urls:
        for key in ("url", "image_url", "video_url"):
            if isinstance(data.get(key), str):
                urls.append(data[key])
    return urls


def submit_image(
    *,
    prompt: str,
    mode: str,
    reference_image_urls: list[str] | None = None,
    size: str | None = None,
    aspect_ratio: str = "16:9",
    model: str | None = None,
) -> str:
    """OpenAI-compatible Ark image generation (Seedream / Jimeng)."""
    _assert_plan_capability("image")
    effective_size = ensure_jimeng_image_size(size, aspect_ratio=aspect_ratio)
    m = model or jimeng_image_model()
    body: dict[str, Any] = {
        "model": m,
        "prompt": prompt,
        "size": effective_size,
        "n": 1,
        "response_format": "url",
        "watermark": False,
    }
    if mode == "image2image" and reference_image_urls:
        body["image"] = reference_image_urls[0]
    data = _request_ark("POST", "/images/generations", body)
    urls = _extract_urls(data)
    if urls:
        return f"immediate:{urls[0]}"
    task_id = data.get("id") or (data.get("data") or {}).get("task_id") if isinstance(data.get("data"), dict) else None
    if task_id:
        return str(task_id)
    if urls:
        return f"immediate:{urls[0]}"
    raise RuntimeError(f"Jimeng image response missing url/task: {json.dumps(data, ensure_ascii=False)[:300]}")


def poll_image(task_id: str) -> tuple[str, str | None, list[str]]:
    if task_id.startswith("immediate:"):
        url = task_id[len("immediate:") :]
        return "succeeded", url, [url]
    url = f"{volcengine_ark_base()}/images/generations/{task_id}"
    with httpx.Client(timeout=60.0) as client:
        resp = client.get(url, headers=_ark_headers())
    data = resp.json() if resp.status_code < 500 else {}
    urls = _extract_urls(data)
    status = str(data.get("status") or ("succeeded" if urls else "processing")).lower()
    return status, urls[0] if urls else None, urls


def submit_video(
    *,
    prompt: str,
    mode: str,
    first_frame_url: str | None = None,
    duration: int = 5,
    resolution: str = "720p",
    aspect_ratio: str = "16:9",
    model: str | None = None,
    generate_audio: bool | None = None,
) -> str:
    _assert_plan_capability("video")
    if _use_seedance_video():
        m = model or _seedance_video_model()
        with_audio = _seedance_generate_audio() if generate_audio is None else generate_audio
        body: dict[str, Any] = {
            "model": m,
            "content": _build_seedance_content(
                prompt=prompt,
                mode=mode,
                first_frame_url=first_frame_url,
            ),
            "ratio": aspect_ratio,
            "duration": duration,
            "generate_audio": with_audio,
            "resolution": resolution or "1080p",
        }
        data = _request_ark("POST", "/contents/generations/tasks", body)
        task_id = data.get("id")
        if task_id:
            return str(task_id)
        urls = _extract_video_urls(data)
        if urls:
            return f"immediate:{urls[0]}"
        raise RuntimeError(f"Seedance video missing task id: {json.dumps(data, ensure_ascii=False)[:300]}")

    base = jimeng_video_base()
    m = model or os.getenv("JIMENG_VIDEO_MODEL_LEGACY", "jimeng_v30")
    body: dict[str, Any] = {
        "model": m,
        "prompt": prompt,
        "resolution": resolution,
        "ratio": aspect_ratio,
        "duration": duration,
    }
    if mode == "image2video" and first_frame_url:
        body["images"] = [first_frame_url]

    path = os.getenv("JIMENG_VIDEO_PATH", "/videos/generations")
    url = f"{base}{path}" if path.startswith("/") else f"{base}/{path}"
    with httpx.Client(timeout=120.0) as client:
        resp = client.post(url, headers=_ark_headers(), json=body)
    data = resp.json() if resp.status_code < 500 else {"error": resp.text}
    if resp.status_code >= 400:
        raise RuntimeError(f"Jimeng video {resp.status_code}: {json.dumps(data, ensure_ascii=False)[:500]}")
    task_id = data.get("id") or data.get("task_id")
    if isinstance(data.get("data"), dict):
        task_id = task_id or data["data"].get("task_id")
    if task_id:
        return str(task_id)
    urls = _extract_urls(data)
    if urls:
        return f"immediate:{urls[0]}"
    raise RuntimeError(f"Jimeng video missing task_id: {json.dumps(data, ensure_ascii=False)[:300]}")


def poll_video(task_id: str) -> tuple[str, str | None, list[str]]:
    if task_id.startswith("immediate:"):
        url = task_id[len("immediate:") :]
        return "succeeded", url, [url]
    if _use_seedance_video():
        data = _get_ark(f"/contents/generations/tasks/{task_id}")
        urls = _extract_video_urls(data)
        status = _extract_task_status(data)
        if urls and status in ("processing", "pending", "running", "queued"):
            status = "succeeded"
        return status, urls[0] if urls else None, urls
    base = jimeng_video_base().rstrip("/")
    poll_path = os.getenv("JIMENG_VIDEO_POLL_PATH", "videos/generations").strip("/")
    url = f"{base}/{poll_path}/{task_id}"
    with httpx.Client(timeout=60.0) as client:
        resp = client.get(url, headers=_ark_headers())
    data = resp.json() if resp.status_code < 500 else {}
    urls = _extract_urls(data)
    status = str(data.get("status") or ("succeeded" if urls else "processing")).lower()
    return status, urls[0] if urls else None, urls
