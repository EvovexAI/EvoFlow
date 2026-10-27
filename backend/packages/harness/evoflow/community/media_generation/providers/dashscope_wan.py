"""DashScope Wan (通义万相) — image + video adapters.

Protocol routing by model id:
- ``wan2.7-image*`` → multimodal-generation sync (messages/content)
- ``wan2.7-*`` video → video-synthesis async with ``input.media[]``
- ``wan2.6`` / ``wanx*`` / earlier → legacy text2image + ``img_url`` video

Docs:
- Image 2.7: multimodal-generation sync / image-generation async
- Video 2.7: video-synthesis with media[{type,url}]
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any, Literal

import httpx

from evoflow.community.media_generation.aspect_ratio import wan_image_size
from evoflow.community.media_generation.config_helpers import dashscope_api_key, dashscope_base_url
from evoflow.community.media_generation.providers.base import is_immediate_task, unwrap_immediate

logger = logging.getLogger(__name__)

DEFAULT_IMAGE_MODEL = "wan2.7-image"
DEFAULT_I2V_MODEL = "wan2.7-i2v"
DEFAULT_T2V_MODEL = "wan2.7-t2v"

WanProtocol = Literal["image_v27", "image_v26", "video_v27", "video_v26"]


def _base_url() -> str:
    return dashscope_base_url().rstrip("/")


def _api_key() -> str:
    key = dashscope_api_key()
    if not key:
        raise ValueError(
            "通义万相凭据未配置。请在 EvoFlow → 设置 → 模型 → 生图生视频 → 通义万相 填写并启用。"
        )
    return key


def _headers(*, async_enable: bool = True, resolve_oss: bool = False) -> dict[str, str]:
    headers = {
        "Authorization": f"Bearer {_api_key()}",
        "Content-Type": "application/json",
    }
    if async_enable:
        headers["X-DashScope-Async"] = "enable"
    if resolve_oss:
        headers["X-DashScope-OssResourceResolve"] = "enable"
    return headers


def _request(
    method: str,
    path: str,
    body: dict[str, Any] | None = None,
    *,
    async_enable: bool = True,
    resolve_oss: bool = False,
) -> dict[str, Any]:
    url = f"{_base_url()}{path}"
    with httpx.Client(timeout=180.0) as client:
        resp = client.request(
            method,
            url,
            headers=_headers(async_enable=async_enable, resolve_oss=resolve_oss),
            json=body,
        )
    try:
        data = resp.json()
    except Exception:
        data = {"raw": resp.text}
    if resp.status_code >= 400:
        raise RuntimeError(f"DashScope {resp.status_code}: {json.dumps(data, ensure_ascii=False)[:500]}")
    if isinstance(data, dict) and data.get("code") and not data.get("output"):
        # Sync multimodal errors often land as 200 + code/message
        raise RuntimeError(f"DashScope error: {json.dumps(data, ensure_ascii=False)[:500]}")
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


def _norm_resolution(resolution: str | None, *, default: str = "1080P") -> str:
    res = str(resolution or default).strip().upper()
    if res.isdigit():
        res = f"{res}P"
    if res.endswith("P") is False and res not in {"2K", "4K"}:
        res = default
    return res


def detect_protocol(model: str | None, *, capability: Literal["image", "video"]) -> WanProtocol:
    m = str(model or "").strip().lower()
    is_27 = m.startswith("wan2.7")
    if capability == "image":
        return "image_v27" if is_27 else "image_v26"
    return "video_v27" if is_27 else "video_v26"


def _extract_urls_from_output(out: Any) -> list[str]:
    urls: list[str] = []
    if not isinstance(out, dict):
        return urls

    # Sync multimodal: output.choices[].message.content[].image
    choices = out.get("choices")
    if isinstance(choices, list):
        for choice in choices:
            if not isinstance(choice, dict):
                continue
            msg = choice.get("message") if isinstance(choice.get("message"), dict) else {}
            content = msg.get("content")
            if isinstance(content, list):
                for item in content:
                    if isinstance(item, dict):
                        img = item.get("image") or item.get("url")
                        if isinstance(img, str) and img.startswith(("http", "data:")):
                            urls.append(img)
                    elif isinstance(item, str) and item.startswith(("http", "data:")):
                        urls.append(item)

    results = out.get("results") or out.get("video_url") or out.get("url")
    if isinstance(results, str) and results.startswith(("http", "data:")):
        urls.append(results)
    elif isinstance(results, list):
        for r in results:
            if isinstance(r, dict) and r.get("url"):
                urls.append(str(r["url"]))
            elif isinstance(r, str) and r.startswith(("http", "data:")):
                urls.append(r)

    for key in ("video_url", "image_url", "url", "output_video_url"):
        vu = out.get(key)
        if isinstance(vu, str) and vu.startswith(("http", "data:")):
            urls.append(vu)

    # Dedupe preserve order
    seen: set[str] = set()
    uniq: list[str] = []
    for u in urls:
        if u not in seen:
            seen.add(u)
            uniq.append(u)
    return uniq


def _poll_task(task_id: str) -> tuple[str, str | None, list[str]]:
    with httpx.Client(timeout=60.0) as client:
        resp = client.get(f"{_base_url()}/tasks/{task_id}", headers=_headers(async_enable=False))
    data = resp.json() if resp.status_code < 400 else {"error": resp.text}
    out = data.get("output") or {}
    status = str(out.get("task_status") or data.get("task_status") or "processing").lower()
    urls = _extract_urls_from_output(out) if isinstance(out, dict) else []
    if status in ("succeeded", "success"):
        status = "succeeded"
    elif status in ("failed", "fail", "canceled", "cancelled"):
        status = "failed"
    else:
        status = "processing"
    return status, urls[0] if urls else None, urls


# ── Image ──────────────────────────────────────────────────────────────


def _submit_image_v27(
    *,
    prompt: str,
    mode: str,
    reference_image_urls: list[str] | None,
    size: str,
    model: str,
) -> str:
    """Wan 2.7 multimodal sync — returns immediate:{url}."""
    content: list[dict[str, Any]] = [{"text": prompt}]
    if mode == "image2image" and reference_image_urls:
        for ref in reference_image_urls[:4]:
            if ref:
                content.insert(0, {"image": ref})
    body: dict[str, Any] = {
        "model": model,
        "input": {
            "messages": [
                {
                    "role": "user",
                    "content": content,
                }
            ]
        },
        "parameters": {
            "size": size,
            "n": 1,
            "prompt_extend": True,
            "watermark": False,
        },
    }
    data = _request(
        "POST",
        "/services/aigc/multimodal-generation/generation",
        body,
        async_enable=False,
        resolve_oss=any(str(u or "").startswith("oss://") for u in (reference_image_urls or [])),
    )
    out = data.get("output") if isinstance(data.get("output"), dict) else data
    urls = _extract_urls_from_output(out)
    if urls:
        return f"immediate:{urls[0]}"
    # Some gateways still return async task_id even on multimodal path
    try:
        return _task_id(data)
    except RuntimeError as exc:
        raise RuntimeError(
            f"Wan 2.7 image missing url/task: {json.dumps(data, ensure_ascii=False)[:400]}"
        ) from exc


def _submit_image_v26(
    *,
    prompt: str,
    mode: str,
    reference_image_urls: list[str] | None,
    size: str,
    model: str,
) -> str:
    input_body: dict[str, Any] = {"prompt": prompt}
    m = model
    if mode == "image2image" and reference_image_urls:
        input_body["ref_image"] = reference_image_urls[0]
        if not str(m).startswith("wan2.5") and "i2i" not in str(m).lower():
            m = os.getenv("DASHSCOPE_IMAGE_I2I_MODEL", "wan2.5-i2i-preview")
    body = {
        "model": m,
        "input": input_body,
        "parameters": {"size": size, "n": 1},
    }
    data = _request("POST", "/services/aigc/text2image/image-synthesis", body)
    return _task_id(data)


def submit_image(
    *,
    prompt: str,
    mode: str = "text2image",
    reference_image_urls: list[str] | None = None,
    size: str | None = None,
    aspect_ratio: str = "16:9",
    model: str | None = None,
) -> str:
    m = (model or os.getenv("DASHSCOPE_IMAGE_MODEL", DEFAULT_IMAGE_MODEL)).strip()
    effective_size = size if size is not None else wan_image_size(aspect_ratio)
    proto = detect_protocol(m, capability="image")
    if proto == "image_v27":
        return _submit_image_v27(
            prompt=prompt,
            mode=mode,
            reference_image_urls=reference_image_urls,
            size=effective_size,
            model=m,
        )
    return _submit_image_v26(
        prompt=prompt,
        mode=mode,
        reference_image_urls=reference_image_urls,
        size=effective_size,
        model=m,
    )


def poll_image(task_id: str) -> tuple[str, str | None, list[str]]:
    if is_immediate_task(task_id):
        url = unwrap_immediate(task_id)
        return "succeeded", url, [url]
    status, url, urls = _poll_task(task_id)
    if not urls and url:
        urls = [url]
    return status, url, urls


# ── Video ──────────────────────────────────────────────────────────────


def _submit_video_v27(
    *,
    prompt: str,
    mode: str,
    first_frame_url: str | None,
    last_frame_url: str | None,
    audio_url: str | None,
    duration: int,
    resolution: str,
    model: str,
    watermark: bool | None,
    seed: int | None,
) -> str:
    """Wan 2.7 multimodal video — ``input.media[]`` protocol."""
    media: list[dict[str, str]] = []
    if mode == "image2video" or first_frame_url:
        if not first_frame_url:
            raise ValueError("万相 2.7 图生视频需要 first_frame_url（https / data URI / oss://）")
        media.append({"type": "first_frame", "url": first_frame_url})
        if last_frame_url:
            media.append({"type": "last_frame", "url": last_frame_url})
        if audio_url:
            media.append({"type": "driving_audio", "url": audio_url})
    elif audio_url:
        # text2video + driving audio (allowed combination varies; pass through)
        media.append({"type": "driving_audio", "url": audio_url})

    input_body: dict[str, Any] = {"prompt": prompt}
    if media:
        input_body["media"] = media
    if not media and mode == "image2video":
        raise ValueError("万相 2.7 图生视频缺少 media（首帧）")

    params: dict[str, Any] = {
        "duration": int(duration or 5),
        "resolution": _norm_resolution(resolution, default="1080P"),
        "prompt_extend": True,
        "watermark": bool(watermark) if watermark is not None else False,
    }
    if seed is not None:
        try:
            params["seed"] = int(seed)
        except (TypeError, ValueError):
            pass

    body = {"model": model, "input": input_body, "parameters": params}
    resolve_oss = any(
        str(u or "").startswith("oss://")
        for u in (first_frame_url, last_frame_url, audio_url)
    )
    data = _request(
        "POST",
        "/services/aigc/video-generation/video-synthesis",
        body,
        async_enable=True,
        resolve_oss=resolve_oss,
    )
    return _task_id(data)


def _submit_video_v26(
    *,
    prompt: str,
    mode: str,
    first_frame_url: str | None,
    audio_url: str | None,
    duration: int,
    resolution: str,
    aspect_ratio: str,
    model: str,
) -> str:
    if mode == "image2video" and first_frame_url:
        input_body: dict[str, Any] = {
            "prompt": prompt,
            "img_url": first_frame_url,
        }
        if audio_url:
            input_body["audio_url"] = audio_url
    else:
        input_body = {"prompt": prompt}
        if audio_url:
            input_body["audio_url"] = audio_url

    body = {
        "model": model,
        "input": input_body,
        "parameters": {
            "duration": int(duration or 5),
            "resolution": _norm_resolution(resolution, default="720P"),
            "aspect_ratio": aspect_ratio,
            "prompt_extend": True,
        },
    }
    resolve_oss = any(str(u or "").startswith("oss://") for u in (first_frame_url, audio_url))
    data = _request(
        "POST",
        "/services/aigc/video-generation/video-synthesis",
        body,
        async_enable=True,
        resolve_oss=resolve_oss,
    )
    return _task_id(data)


def submit_video(
    *,
    prompt: str,
    mode: str = "image2video",
    first_frame_url: str | None = None,
    last_frame_url: str | None = None,
    audio_url: str | None = None,
    duration: int = 5,
    resolution: str = "720p",
    aspect_ratio: str = "16:9",
    model: str | None = None,
    watermark: bool | None = None,
    seed: int | None = None,
    generate_audio: bool | None = None,
) -> str:
    del generate_audio  # Wan handles audio via media/audio_url, not a bool flag
    if mode == "image2video" and first_frame_url:
        m = (model or os.getenv("DASHSCOPE_VIDEO_I2V_MODEL", DEFAULT_I2V_MODEL)).strip()
    else:
        m = (model or os.getenv("DASHSCOPE_VIDEO_T2V_MODEL", DEFAULT_T2V_MODEL)).strip()

    proto = detect_protocol(m, capability="video")
    if proto == "video_v27":
        return _submit_video_v27(
            prompt=prompt,
            mode=mode,
            first_frame_url=first_frame_url,
            last_frame_url=last_frame_url,
            audio_url=audio_url,
            duration=duration,
            resolution=resolution,
            model=m,
            watermark=watermark,
            seed=seed,
        )
    return _submit_video_v26(
        prompt=prompt,
        mode=mode,
        first_frame_url=first_frame_url,
        audio_url=audio_url,
        duration=duration,
        resolution=resolution,
        aspect_ratio=aspect_ratio,
        model=m,
    )


def poll_video(task_id: str) -> tuple[str, str | None, list[str]]:
    if is_immediate_task(task_id):
        url = unwrap_immediate(task_id)
        return "succeeded", url, [url]
    return _poll_task(task_id)
