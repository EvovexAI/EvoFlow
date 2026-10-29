"""MiniMax video generation — official H3 / Hailuo + OpenAI-Videos gateways.

Protocols (auto-selected by Base URL + model id):
1. **Official H3** — ``POST {base}/v2/video_generation`` (content[])
   Default host ``api.minimax.cn`` / ``api.minimax.io``; models ``MiniMax-H3*``.
2. **Hailuo legacy** — ``POST {base}/v1/video_generation``; ``MiniMax-Hailuo*`` / ``T2V-`` / ``I2V-``.
3. **OpenAI Videos gateway** (hon-maas etc.) — multipart ``POST {base}/videos``
   Base like ``https://token-service-qy.hon-maas.com/v1``; model ``minimax-h3`` / ``minimax-h3/QY3``.
   Fields: model/prompt/seconds/size/width/height/aspect_ratio + extra_params
   (``t2va`` / ``fl2va``) + image frame(s) as repeated ``input_references``
   (NOT ``file`` / singular ``input_reference`` — hon-maas rejects those for fl2va).
   Poll ``GET {base}/videos/{id}``; content ``GET {base}/videos/{id}/content``.
"""

from __future__ import annotations

import base64
import json
import logging
import re
import tempfile
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx

from evoflow.community.media_generation.config_helpers import (
    minimax_media_api_key,
    minimax_media_base_url,
)

logger = logging.getLogger(__name__)

DEFAULT_MINIMAX_VIDEO_MODEL = "MiniMax-H3"
DEFAULT_GATEWAY_VIDEO_MODEL = "minimax-h3"
DEFAULT_GATEWAY_INFERENCE_STEPS = 30
DEFAULT_GATEWAY_FLOW_SHIFT = 12.0

_DATA_IMAGE_RE = re.compile(
    r"^data:(image/[a-z0-9.+-]+);base64,(.+)$",
    re.IGNORECASE | re.DOTALL,
)


def _auth_headers(*, json_body: bool = False) -> dict[str, str]:
    key = minimax_media_api_key()
    if not key:
        raise ValueError("未配置 MiniMax 媒体 API Key（minimaxMediaApiKey）")
    headers = {"Authorization": f"Bearer {key}"}
    if json_body:
        headers["Content-Type"] = "application/json"
    return headers


def _headers() -> dict[str, str]:
    """JSON APIs (official H3 / Hailuo / poll)."""
    return _auth_headers(json_body=True)


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


def _openai_dims(resolution: str | None, aspect_ratio: str) -> tuple[str, int, int, str]:
    """hon-maas MiniMax-H3 sizes: return (size, width, height, aspect_ratio).

    Doc example for 16:9 is ``1344x768`` (not OpenAI's 1280x720).
    """
    res = _normalize_resolution(resolution, h3=True)
    ar = (aspect_ratio or "16:9").strip() or "16:9"
    hi = res in {"2K", "1080P", "4K"}
    table: dict[str, tuple[tuple[int, int], tuple[int, int]]] = {
        # ar -> (default WxH, 2K WxH)
        "16:9": ((1344, 768), (1920, 1080)),
        "9:16": ((768, 1344), (1080, 1920)),
        "1:1": ((1024, 1024), (1280, 1280)),
        "4:3": ((1152, 864), (1600, 1200)),
        "3:4": ((864, 1152), (1200, 1600)),
        "3:2": ((1152, 768), (1680, 1120)),
        "2:3": ((768, 1152), (1120, 1680)),
    }
    pair = table.get(ar) or table["16:9"]
    w, h = pair[1] if hi else pair[0]
    if ar not in table:
        ar = "16:9"
    return f"{w}x{h}", w, h, ar


def _openai_size(resolution: str | None, aspect_ratio: str) -> str:
    """Map resolution + ratio → gateway ``size`` (WxH)."""
    size, _, _, _ = _openai_dims(resolution, aspect_ratio)
    return size


def _clamp_gateway_seconds(duration: int | None) -> int:
    """MiniMax H3 via OpenAI-Videos gateway accepts duration in [4, 15] only."""
    try:
        n = int(duration or 4)
    except (TypeError, ValueError):
        n = 4
    return max(4, min(n, 15))


def _materialize_image_bytes(ref: str) -> tuple[str, bytes, str]:
    """Turn https / data URI / local path into (filename, bytes, mime) for multipart ``file``."""
    s = str(ref or "").strip()
    if not s:
        raise ValueError("图生视频缺少首帧图片")

    m = _DATA_IMAGE_RE.match(s)
    if m:
        mime = (m.group(1) or "image/png").lower()
        raw = base64.b64decode(m.group(2))
        ext = "jpg" if "jpeg" in mime else mime.split("/", 1)[-1].split("+", 1)[0] or "png"
        return f"first_frame.{ext}", raw, mime

    parsed = urlparse(s)
    if parsed.scheme in {"http", "https"} and parsed.netloc:
        with httpx.Client(timeout=60.0) as client:
            resp = client.get(s)
        if resp.status_code >= 400:
            raise RuntimeError(f"下载首帧失败 HTTP {resp.status_code}")
        ctype = (resp.headers.get("content-type") or "image/png").split(";", 1)[0].strip() or "image/png"
        if not ctype.startswith("image/"):
            ctype = "image/png"
        name = Path(parsed.path).name or "first_frame.png"
        if "." not in name:
            name = f"{name}.png"
        return name, resp.content, ctype

    path = Path(s)
    if path.is_file():
        data = path.read_bytes()
        suffix = path.suffix.lower() or ".png"
        mime = {
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".webp": "image/webp",
            ".gif": "image/gif",
            ".bmp": "image/bmp",
        }.get(suffix, "image/png")
        return path.name, data, mime

    raise ValueError(
        "首帧须为 https URL、data:image/...;base64,... 或本地图片路径"
    )


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
    """hon-maas / OpenAI-Videos create — multipart form.

    Image-to-video on this gateway MUST use repeated form field
    ``input_references`` (plural) plus ``extra_params.frame_indices``:
    - first only → one part + ``[0]``
    - first+last → two parts + ``[0, -1]``
    ``file`` / singular ``input_reference`` are rejected with the fl2va
    frame_indices error even when indices are present.
    """
    base = minimax_media_base_url().rstrip("/")
    size, width, height, ar = _openai_dims(resolution, aspect_ratio)
    seconds = _clamp_gateway_seconds(duration)
    want_i2v = mode == "image2video" or bool(first_frame_url) or bool(last_frame_url)
    if want_i2v and not first_frame_url:
        raise ValueError(
            "图生视频需要 first_frame_url（https、data:image/...;base64,... 或本地路径）"
        )
    if last_frame_url and not first_frame_url:
        raise ValueError("last_frame_url 需要同时提供 first_frame_url")

    if want_i2v:
        frame_indices = [0, -1] if last_frame_url else [0]
        extra: dict[str, Any] = {"task": "fl2va", "frame_indices": frame_indices}
    else:
        extra = {"task": "t2va"}

    flow_shift = DEFAULT_GATEWAY_FLOW_SHIFT
    flow_shift_s = (
        str(int(flow_shift)) if float(flow_shift).is_integer() else str(flow_shift)
    )
    # list-of-tuples: required so repeated ``input_references`` keeps both parts
    multipart: list[tuple[str, Any]] = [
        ("model", (None, model)),
        ("prompt", (None, prompt or "")),
        ("seconds", (None, str(seconds))),
        ("size", (None, size)),
        ("width", (None, str(width))),
        ("height", (None, str(height))),
        ("aspect_ratio", (None, ar)),
        ("num_inference_steps", (None, str(DEFAULT_GATEWAY_INFERENCE_STEPS))),
        ("flow_shift", (None, flow_shift_s)),
        (
            "extra_params",
            (None, json.dumps(extra, ensure_ascii=False, separators=(",", ":"))),
        ),
    ]
    if want_i2v:
        filename, raw, mime = _materialize_image_bytes(str(first_frame_url))
        multipart.append(("input_references", (filename, raw, mime)))
        if last_frame_url:
            last_name, last_raw, last_mime = _materialize_image_bytes(str(last_frame_url))
            multipart.append(("input_references", (last_name, last_raw, last_mime)))

    url = f"{base}/videos"
    with httpx.Client(timeout=120.0) as client:
        resp = client.post(url, headers=_auth_headers(), files=multipart)
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
        logger.warning(
            "OpenAI-Videos poll %s → HTTP %s body=%s",
            task_id,
            resp.status_code,
            json.dumps(data, ensure_ascii=False)[:400],
        )
        return "failed", None, []

    status_raw = str(data.get("status") or "").lower()
    if status_raw in {"completed", "succeeded", "success", "done", "finished"}:
        status = "succeeded"
    elif status_raw in {"failed", "fail", "error", "cancelled", "canceled"}:
        err = data.get("error") if isinstance(data.get("error"), dict) else {}
        err_msg = str(err.get("message") or data.get("message") or "").strip()
        logger.warning(
            "OpenAI-Videos poll %s failed: %s",
            task_id,
            err_msg or json.dumps(data, ensure_ascii=False)[:400],
        )
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
            resp = client.get(url, headers=_auth_headers())
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
