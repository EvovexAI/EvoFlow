from __future__ import annotations

import json
import logging
import os
from typing import Any

import httpx

from evoflow.community.media_generation.aspect_ratio import wan_image_size
from evoflow.community.media_generation.config_helpers import dashscope_api_key, dashscope_base_url

logger = logging.getLogger(__name__)


def _base_url() -> str:
    return dashscope_base_url()


def _headers(*, resolve_oss: bool = False) -> dict[str, str]:
    key = dashscope_api_key()
    if not key:
        raise ValueError("通义万相凭据未配置。请在 EvoFlow → 设置 → 模型 → 创意媒体 → 通义万相 填写并启用。")
    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "X-DashScope-Async": "enable",
    }
    if resolve_oss:
        headers["X-DashScope-OssResourceResolve"] = "enable"
    return headers


def _request(method: str, path: str, body: dict[str, Any] | None = None, *, resolve_oss: bool = False) -> dict[str, Any]:
    url = f"{_base_url()}{path}"
    with httpx.Client(timeout=120.0) as client:
        resp = client.request(method, url, headers=_headers(resolve_oss=resolve_oss), json=body)
    try:
        data = resp.json()
    except Exception:
        data = {"raw": resp.text}
    if resp.status_code >= 400:
        raise RuntimeError(f"DashScope {resp.status_code}: {json.dumps(data, ensure_ascii=False)[:500]}")
    return data if isinstance(data, dict) else {"output": data}


def _task_id(data: dict[str, Any]) -> str:
    out = data.get("output") or data
    if isinstance(out, dict):
        tid = out.get("task_id") or out.get("taskId")
        if tid:
            return str(tid)
    if data.get("task_id"):
        return str(data["task_id"])
    raise RuntimeError(f"DashScope missing task_id: {json.dumps(data, ensure_ascii=False)[:300]}")


def _poll_task(task_id: str) -> tuple[str, str | None, list[str]]:
    with httpx.Client(timeout=60.0) as client:
        resp = client.get(f"{_base_url()}/tasks/{task_id}", headers=_headers())
    data = resp.json() if resp.status_code < 400 else {"error": resp.text}
    out = data.get("output") or {}
    status = str(out.get("task_status") or data.get("task_status") or "processing").lower()
    urls: list[str] = []
    if isinstance(out, dict):
        results = out.get("results") or out.get("video_url") or out.get("url")
        if isinstance(results, str) and results.startswith("http"):
            urls.append(results)
        elif isinstance(results, list):
            for r in results:
                if isinstance(r, dict) and r.get("url"):
                    urls.append(str(r["url"]))
                elif isinstance(r, str) and r.startswith("http"):
                    urls.append(r)
        vu = out.get("video_url")
        if isinstance(vu, str):
            urls.append(vu)
    if status in ("succeeded", "success"):
        status = "succeeded"
    return status, urls[0] if urls else None, urls


def submit_image(
    *,
    prompt: str,
    mode: str,
    reference_image_urls: list[str] | None = None,
    size: str | None = None,
    aspect_ratio: str = "16:9",
    model: str = "wanx2.1-t2i-turbo",
) -> str:
    """Wan text-to-image (sync-style task via async header)."""
    effective_size = size if size is not None else wan_image_size(aspect_ratio)
    input_body: dict[str, Any] = {"prompt": prompt}
    if mode == "image2image" and reference_image_urls:
        input_body["ref_image"] = reference_image_urls[0]
        model = os.getenv("DASHSCOPE_IMAGE_I2I_MODEL", "wanx2.1-imageedit")

    body = {
        "model": model,
        "input": input_body,
        "parameters": {"size": effective_size, "n": 1},
    }
    path = "/services/aigc/text2image/image-synthesis"
    data = _request("POST", path, body)
    return _task_id(data)


def poll_image(task_id: str) -> tuple[str, str | None, list[str]]:
    status, url, urls = _poll_task(task_id)
    if not urls and url:
        urls = [url]
    return status, url, urls


def submit_video(
    *,
    prompt: str,
    mode: str,
    first_frame_url: str | None = None,
    audio_url: str | None = None,
    duration: int = 5,
    resolution: str = "720P",
    aspect_ratio: str = "16:9",
    model: str | None = None,
) -> str:
    if mode == "image2video" and first_frame_url:
        m = model or os.getenv("DASHSCOPE_VIDEO_I2V_MODEL", "wan2.6-i2v")
        input_body: dict[str, Any] = {
            "prompt": prompt,
            "img_url": first_frame_url,
        }
        if audio_url:
            input_body["audio_url"] = audio_url
    else:
        m = model or os.getenv("DASHSCOPE_VIDEO_T2V_MODEL", "wan2.6-t2v")
        input_body = {"prompt": prompt}
        if audio_url:
            input_body["audio_url"] = audio_url

    body = {
        "model": m,
        "input": input_body,
        "parameters": {
            "duration": duration,
            "resolution": resolution,
            "aspect_ratio": aspect_ratio,
            "prompt_extend": True,
        },
    }
    resolve_oss = any(str(u or "").strip().startswith("oss://") for u in (first_frame_url, audio_url))
    data = _request("POST", "/services/aigc/video-generation/video-synthesis", body, resolve_oss=resolve_oss)
    return _task_id(data)


def poll_video(task_id: str) -> tuple[str, str | None, list[str]]:
    return _poll_task(task_id)
