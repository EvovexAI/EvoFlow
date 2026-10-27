"""MiniMax video generation — official H3 / Hailuo + OpenAI-Videos gateways.

Protocols (auto-selected by Base URL + model id):
1. **Official H3** — ``POST {base}/v2/video_generation`` (content[])
   Default host ``api.minimax.cn`` / ``api.minimax.io``; models ``MiniMax-H3*``.
2. **Hailuo legacy** — ``POST {base}/v1/video_generation``; ``MiniMax-Hailuo*`` / ``T2V-`` / ``I2V-``.
3. **OpenAI Videos gateway** — ``POST {base}/videos`` (base usually ends with ``/v1``)
   e.g. ``https://token-service-qy.hon-maas.com/v1`` + model ``minimax-h3`` / ``minimax-h3/QY3``.
   Poll ``GET {base}/videos/{id}``; content ``GET {base}/videos/{id}/content``.
"""

from __future__ import annotations

import json
import logging
import tempfile
from pathlib import Path
from typing import Any

import httpx

from evoflow.community.media_generation.config_helpers import (
    minimax_media_api_key,
    minimax_media_base_url,
)

logger = logging.getLogger(__name__)

DEFAULT_MINIMAX_VIDEO_MODEL = "MiniMax-H3"
DEFAULT_GATEWAY_VIDEO_MODEL = "minimax-h3"


def _headers() -> dict[str, str]:
    key = minimax_media_api_key()
    if not key:
        raise ValueError("未配置 MiniMax 媒体 API Key（minimaxMediaApiKey）")
    return {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}


def _normalize_resolution(resolution: str | None, *, h3: bool) -> str:
    res = str(resolution or ("768P" if h3 else "768P")).strip().upper()
    if res.isdigit():
        res = f"{res}P"
    if res.endswith("P") is False and res in {"2K", "4K"}:
        return res
    if not res.endswith("P") and res not in {"2K", "4K"}:
        res = "768P"
    if h3 and res in {"720P", "1080P"}:
        res = "768P" if res == "720P" else "2K"
    return res


def _is_official_minimax_host(base: str) -> bool:
    b = (base or "").lower()
    return any(
        h in b
        for h in (
            "api.minimax.cn",
            "api.minimax.io",
            "api.minimaxi.com",
            "minimaxi.com",
        )
    )


def uses_openai_videos_api(model: str | None = None) -> bool:
    """True for OpenAI-compatible video gateways (hon-maas / …/v1 + minimax-h3)."""
    base = minimax_media_base_url().rstrip("/")
    if _is_official_minimax_host(base):
        return False
    m = (model or "").strip().lower()
    if m.startswith("minimax-h3") or m.startswith("minimax-hailuo"):
        return True
    bl = base.lower()
    if "hon-maas" in bl or "token-service" in bl:
        return True
    if bl.endswith("/v1"):
        return True
    return False


def _uses_h3_api(model: str) -> bool:
    m = (model or "").strip()
    if m.startswith("MiniMax-Hailuo") or m.startswith("T2V-") or m.startswith("I2V-"):
        return False
    return True


def _openai_size(resolution: str | None, aspect_ratio: str) -> str:
    """Map MiniMax buckets + ratio → OpenAI Videos ``size`` (WxH)."""
    res = _normalize_resolution(resolution, h3=True)
    ar = (aspect_ratio or "16:9").strip()
    portrait = ar in {"9:16", "3:4", "2:3"}
    if res in {"2K", "1080P", "4K"}:
        return "1024x1792" if portrait else "1792x1024"
    return "720x1280" if portrait else "1280x720"


def submit_video(
    *,
    prompt: str,
    mode: str = "image2video",
    first_frame_url: str | None = None,
    last_frame_url: str | None = None,
    duration: int = 6,
    resolution: str = "768P",
    aspect_ratio: str = "16:9",
    model: str | None = None,
    generate_audio: bool | None = None,
    watermark: bool | None = None,
    seed: int | None = None,
    audio_url: str | None = None,
) -> str:
    del generate_audio, seed, audio_url
    if uses_openai_videos_api(model):
        m = (model or DEFAULT_GATEWAY_VIDEO_MODEL).strip()
        return _submit_openai_videos(
            model=m,
            prompt=prompt,
            mode=mode,
            first_frame_url=first_frame_url,
            last_frame_url=last_frame_url,
            duration=duration,
            resolution=resolution,
            aspect_ratio=aspect_ratio,
        )
    m = (model or DEFAULT_MINIMAX_VIDEO_MODEL).strip()
    if _uses_h3_api(m):
        return _submit_h3(
            model=m,
            prompt=prompt,
            mode=mode,
            first_frame_url=first_frame_url,
            last_frame_url=last_frame_url,
            duration=duration,
            resolution=resolution,
            aspect_ratio=aspect_ratio,
            watermark=watermark,
        )
    return _submit_hailuo_legacy(
        model=m,
        prompt=prompt,
        mode=mode,
        first_frame_url=first_frame_url,
        duration=duration,
        resolution=resolution,
        watermark=watermark,
    )


def _submit_openai_videos(
    *,
    model: str,
    prompt: str,
    mode: str,
    first_frame_url: str | None,
    last_frame_url: str | None,
    duration: int,
    resolution: str,
    aspect_ratio: str,
) -> str:
    """OpenAI Videos-compatible create — used by hon-maas / similar relays."""
    del last_frame_url  # OpenAI Videos has a single input_reference
    base = minimax_media_base_url().rstrip("/")
    body: dict[str, Any] = {
        "model": model,
        "prompt": prompt or "",
        "seconds": str(int(duration or 5)),
        "size": _openai_size(resolution, aspect_ratio),
    }
    # Some relays also honor MiniMax resolution naming.
    body["resolution"] = _normalize_resolution(resolution, h3=True)
    if mode == "image2video" or first_frame_url:
        if not first_frame_url:
            raise ValueError(
                "图生视频需要 first_frame_url（https 或 data:image/...;base64,...）"
            )
        body["input_reference"] = {"image_url": first_frame_url}

    url = f"{base}/videos"
    with httpx.Client(timeout=120.0) as client:
        resp = client.post(url, headers=_headers(), json=body)
    try:
        data = resp.json()
    except Exception:
        data = {"raw": resp.text}
    if resp.status_code >= 400:
        raise RuntimeError(
            f"OpenAI-Videos gateway {resp.status_code}: {json.dumps(data, ensure_ascii=False)[:500]}"
        )
    task_id = data.get("id") or data.get("task_id") or data.get("video_id")
    if isinstance(data.get("data"), dict):
        task_id = task_id or data["data"].get("id") or data["data"].get("task_id")
    if task_id:
        return f"oai:{task_id}"
    raise RuntimeError(
        f"OpenAI-Videos gateway missing id: {json.dumps(data, ensure_ascii=False)[:300]}"
    )


def _submit_h3(
    *,
    model: str,
    prompt: str,
    mode: str,
    first_frame_url: str | None,
    last_frame_url: str | None,
    duration: int,
    resolution: str,
    aspect_ratio: str,
    watermark: bool | None,
) -> str:
    content: list[dict[str, Any]] = [{"type": "text", "text": prompt or ""}]
    if mode == "image2video" or first_frame_url:
        if not first_frame_url:
            raise ValueError("MiniMax H3 图生视频需要 first_frame_url（https 或 data:image/...;base64,...）")
        content.append(
            {
                "type": "image_url",
                "image_url": {"url": first_frame_url},
                "role": "first_frame",
            }
        )
    if last_frame_url:
        content.append(
            {
                "type": "image_url",
                "image_url": {"url": last_frame_url},
                "role": "last_frame",
            }
        )
    body: dict[str, Any] = {
        "model": model,
        "content": content,
        "duration": int(duration or 5),
        "resolution": _normalize_resolution(resolution, h3=True),
    }
    if not first_frame_url:
        body["ratio"] = aspect_ratio or "16:9"
    if watermark is not None:
        body["aigc_watermark"] = bool(watermark)

    base = minimax_media_base_url().rstrip("/")
    url = f"{base}/v2/video_generation"
    with httpx.Client(timeout=120.0) as client:
        resp = client.post(url, headers=_headers(), json=body)
    try:
        data = resp.json()
    except Exception:
        data = {"raw": resp.text}
    if resp.status_code >= 400:
        raise RuntimeError(f"MiniMax H3 video {resp.status_code}: {json.dumps(data, ensure_ascii=False)[:500]}")
    task_id = data.get("task_id") or data.get("id")
    if isinstance(data.get("data"), dict):
        task_id = task_id or data["data"].get("task_id")
    if task_id:
        return f"h3:{task_id}"
    raise RuntimeError(f"MiniMax H3 video missing task_id: {json.dumps(data, ensure_ascii=False)[:300]}")


def _submit_hailuo_legacy(
    *,
    model: str,
    prompt: str,
    mode: str,
    first_frame_url: str | None,
    duration: int,
    resolution: str,
    watermark: bool | None,
) -> str:
    body: dict[str, Any] = {
        "model": model,
        "prompt": prompt or "",
        "duration": int(duration or 6),
        "resolution": _normalize_resolution(resolution, h3=False),
        "prompt_optimizer": True,
    }
    if watermark is not None:
        body["aigc_watermark"] = bool(watermark)
    if mode == "image2video" or first_frame_url:
        if not first_frame_url:
            raise ValueError("MiniMax 图生视频需要 first_frame_url（https 或 data:image/...;base64,...）")
        body["first_frame_image"] = first_frame_url

    base = minimax_media_base_url().rstrip("/")
    url = f"{base}/v1/video_generation"
    with httpx.Client(timeout=120.0) as client:
        resp = client.post(url, headers=_headers(), json=body)
    try:
        data = resp.json()
    except Exception:
        data = {"raw": resp.text}
    if resp.status_code >= 400:
        raise RuntimeError(f"MiniMax video {resp.status_code}: {json.dumps(data, ensure_ascii=False)[:500]}")
    task_id = data.get("task_id") or data.get("id")
    if isinstance(data.get("data"), dict):
        task_id = task_id or data["data"].get("task_id")
    base_resp = data.get("base_resp") if isinstance(data.get("base_resp"), dict) else {}
    code = base_resp.get("status_code")
    if code not in (None, 0, "0") and not task_id:
        raise RuntimeError(f"MiniMax video rejected: {json.dumps(data, ensure_ascii=False)[:500]}")
    if task_id:
        return str(task_id)
    raise RuntimeError(f"MiniMax video missing task_id: {json.dumps(data, ensure_ascii=False)[:300]}")


def poll_video(task_id: str) -> tuple[str, str | None, list[str]]:
    if task_id.startswith("immediate:"):
        url = task_id[len("immediate:") :]
        return "succeeded", url, [url]
    if task_id.startswith("oai:"):
        return _poll_openai_videos(task_id[len("oai:") :])
    if task_id.startswith("h3:"):
        return _poll_h3(task_id[len("h3:") :])
    if uses_openai_videos_api():
        try:
            return _poll_openai_videos(task_id)
        except Exception:
            logger.debug("openai-videos poll failed for bare id; trying native", exc_info=True)
    try:
        status, primary, urls = _poll_h3(task_id)
        if status != "failed" or urls:
            return status, primary, urls
    except Exception:
        pass
    return _poll_hailuo_legacy(task_id)


def _poll_openai_videos(task_id: str) -> tuple[str, str | None, list[str]]:
    base = minimax_media_base_url().rstrip("/")
    url = f"{base}/videos/{task_id}"
    with httpx.Client(timeout=60.0) as client:
        resp = client.get(url, headers=_headers())
    try:
        data = resp.json()
    except Exception:
        data = {}
    if resp.status_code >= 400:
        return "failed", None, []

    status_raw = str(data.get("status") or "").lower()
    if status_raw in {"completed", "succeeded", "success", "done", "finished"}:
        status = "succeeded"
    elif status_raw in {"failed", "fail", "error", "cancelled", "canceled"}:
        status = "failed"
    else:
        status = "processing"

    video_url = ""
    for key in ("url", "video_url", "download_url", "content_url"):
        video_url = str(data.get(key) or "").strip()
        if video_url.startswith("http"):
            break
    nested = data.get("data") if isinstance(data.get("data"), dict) else {}
    if not video_url and nested:
        for key in ("url", "video_url", "download_url"):
            video_url = str(nested.get(key) or "").strip()
            if video_url.startswith("http"):
                break

    if status == "succeeded" and not video_url:
        local = _download_openai_content(task_id)
        if local:
            return "succeeded", local, [local]

    urls = [video_url] if video_url else []
    return status, urls[0] if urls else None, urls


def _download_openai_content(task_id: str) -> str | None:
    """Authenticated GET /videos/{id}/content → local temp mp4 path."""
    base = minimax_media_base_url().rstrip("/")
    url = f"{base}/videos/{task_id}/content"
    try:
        with httpx.Client(timeout=180.0) as client:
            resp = client.get(url, headers={"Authorization": f"Bearer {minimax_media_api_key()}"})
        if resp.status_code >= 400:
            logger.warning("OpenAI-Videos content %s → %s", task_id, resp.status_code)
            return None
        # JSON redirect with url
        ctype = (resp.headers.get("content-type") or "").lower()
        if "json" in ctype:
            try:
                data = resp.json()
            except Exception:
                data = {}
            for key in ("url", "download_url", "video_url"):
                u = str(data.get(key) or "").strip()
                if u.startswith("http"):
                    return u
            return None
        suffix = ".mp4"
        if "webm" in ctype:
            suffix = ".webm"
        fd, path = tempfile.mkstemp(prefix=f"evoflow_oai_{task_id}_", suffix=suffix)
        Path(path).write_bytes(resp.content)
        try:
            import os

            os.close(fd)
        except Exception:
            pass
        return str(Path(path).resolve())
    except Exception:
        logger.warning("OpenAI-Videos content download failed", exc_info=True)
        return None


def _poll_h3(task_id: str) -> tuple[str, str | None, list[str]]:
    base = minimax_media_base_url().rstrip("/")
    url = f"{base}/v2/query/video_generation/{task_id}"
    with httpx.Client(timeout=60.0) as client:
        resp = client.get(url, headers=_headers())
    try:
        data = resp.json()
    except Exception:
        data = {}
    task = data.get("task") if isinstance(data.get("task"), dict) else data
    status_raw = str(task.get("status") or "").lower()
    if status_raw in {"success", "succeeded", "done", "finished"}:
        status = "succeeded"
    elif status_raw in {"fail", "failed", "error", "cancelled"}:
        status = "failed"
    else:
        status = "processing"
    content = task.get("content") if isinstance(task.get("content"), dict) else {}
    video_url = str(content.get("url") or task.get("video_url") or task.get("download_url") or "").strip()
    urls = [video_url] if video_url else []
    return status, urls[0] if urls else None, urls


def _poll_hailuo_legacy(task_id: str) -> tuple[str, str | None, list[str]]:
    base = minimax_media_base_url().rstrip("/")
    url = f"{base}/v1/query/video_generation?task_id={task_id}"
    with httpx.Client(timeout=60.0) as client:
        resp = client.get(url, headers=_headers())
    try:
        data = resp.json()
    except Exception:
        data = {}
    status_raw = str(data.get("status") or data.get("task_status") or "").lower()
    if status_raw in {"success", "succeeded", "done", "finished"}:
        status = "succeeded"
    elif status_raw in {"fail", "failed", "error"}:
        status = "failed"
    else:
        status = "processing"
    file_id = data.get("file_id")
    video_url = str(data.get("video_url") or data.get("download_url") or "").strip()
    urls: list[str] = []
    if video_url:
        urls.append(video_url)
    if not urls and file_id and status == "succeeded":
        dl = _download_url_for_file(str(file_id))
        if dl:
            urls.append(dl)
    return status, urls[0] if urls else None, urls


def _download_url_for_file(file_id: str) -> str | None:
    base = minimax_media_base_url().rstrip("/")
    url = f"{base}/v1/files/retrieve?file_id={file_id}"
    try:
        with httpx.Client(timeout=60.0) as client:
            resp = client.get(url, headers=_headers())
        data = resp.json()
    except Exception:
        return None
    file_obj = data.get("file") if isinstance(data.get("file"), dict) else data
    if isinstance(file_obj, dict):
        for key in ("download_url", "url", "file_url"):
            val = str(file_obj.get(key) or "").strip()
            if val:
                return val
    return None
