"""OpenAI Images API — GPT Image 2.5 + OpenAI-compatible gateways (e.g. Qwen-Image).

Docs: https://developers.openai.com/api/docs/guides/image-generation
- 文生图：``POST {base}/images/generations``
- 图生图：``POST {base}/images/edits``（multipart，字段 ``image`` / ``image[]``）
- Official: ``gpt-image-2.5-sunburst`` / ``gpt-image-2.5-flare``
- Gateways (hon-maas / sakutime etc.): ``Qwen-Image-2.1`` / ``Qwen-Image-2.1/QY5``
"""

from __future__ import annotations

import base64
import json
import logging
from typing import Any

import httpx

from evoflow.community.media_generation.config_helpers import openai_image_api_key, openai_image_base_url

logger = logging.getLogger(__name__)

DEFAULT_OPENAI_IMAGE_MODEL = "gpt-image-2.5-sunburst"

# 图生图单次最多送几张参考图（OpenAI edits 上限 16；平台流程实际 1-4 张足够）
_MAX_EDIT_IMAGES = 4


def _is_qwen_image(model: str) -> bool:
    return (model or "").strip().lower().startswith("qwen-image")


def _image_bytes_from_ref(ref: str) -> tuple[bytes, str, str]:
    """把参考图引用转成 (bytes, filename, mime)。

    支持：
    - ``data:image/png;base64,...``（平台已把本地路径编码成 Data URI）
    - ``http(s)://...`` 公网 URL（同步取回）
    """
    s = str(ref or "").strip()
    if not s:
        raise ValueError("参考图为空")
    if s.lower().startswith("data:"):
        header, _, payload = s.partition(",")
        mime = "image/png"
        if ";" in header:
            cand = header[5:].split(";")[0].strip()
            if cand:
                mime = cand
        if ";base64" in header.lower():
            raw = base64.b64decode(payload, validate=False)
        else:
            raw = payload.encode("utf-8")
        ext = mime.split("/")[-1] or "png"
        return raw, f"ref.{ext}", mime
    if s.lower().startswith(("http://", "https://")):
        with httpx.Client(timeout=120.0, follow_redirects=True) as client:
            resp = client.get(s)
        if resp.status_code >= 400:
            raise RuntimeError(f"下载参考图失败 {resp.status_code}: {s[:120]}")
        mime = (resp.headers.get("content-type") or "image/png").split(";")[0].strip()
        ext = mime.split("/")[-1] or "png"
        return resp.content, f"ref.{ext}", mime
    raise ValueError(
        "openai 图生图的参考图必须是 data:image/...;base64,... 或 http(s) 公网 URL；"
        f"收到：{s[:80]!r}"
    )


# gpt-image-2.5 实测：输出面积恒定归一化到约 1.57MP；比例可传但有上下限。
_IMAGE_AREA_PX = 1_570_000
_MIN_RATIO = 0.40   # 实测 <0.40 会被 clamp（1:4 竖长被夹到 0.40）
_MAX_RATIO = 2.90   # 实测 >2.90 会被 clamp（4:1 被夹到 2.77）


def _parse_ratio(aspect_ratio: str | None) -> float | None:
    """把 '21:9' / '2.35:1' / '2.35' / '235:100' 解析成浮点比例（宽/高）。"""
    s = str(aspect_ratio or "").strip().replace("：", ":").lower()
    if not s or s == "auto":
        return None
    try:
        if ":" in s:
            left, right = s.split(":", 1)
            w, h = float(left), float(right)
        else:
            w, h = float(s), 1.0
    except ValueError:
        return None
    if w <= 0 or h <= 0:
        return None
    return w / h


def _size_for(aspect_ratio: str, size: str | None) -> str:
    """算出请求 size。

    优先用显式 size；否则把 aspect_ratio 解析成 WxH（面积对齐 1.57MP）。
    这样 21:9 / 2.35:1 也能精确命中，不会掉到 1:1 兜底。
    """
    if size:
        return size
    ratio = _parse_ratio(aspect_ratio)
    if ratio is None:
        return "1024x1024"
    ratio = min(max(ratio, _MIN_RATIO), _MAX_RATIO)
    width = int((_IMAGE_AREA_PX * ratio) ** 0.5) // 8 * 8
    height = int(width / ratio) // 8 * 8
    width = max(width, 256)
    height = max(height, 256)
    return f"{width}x{height}"


def _pick_result(data: Any) -> str:
    rows = data.get("data") if isinstance(data, dict) else None
    if isinstance(rows, list) and rows:
        row = rows[0] if isinstance(rows[0], dict) else {}
        out_url = str(row.get("url") or "").strip()
        if out_url:
            return f"immediate:{out_url}"
        b64 = str(row.get("b64_json") or "").strip()
        if b64:
            return f"immediate:data:image/png;base64,{b64}"
    raise RuntimeError(f"OpenAI images missing url: {json.dumps(data, ensure_ascii=False)[:300]}")


def submit_image(
    *,
    prompt: str,
    mode: str = "text2image",
    reference_image_urls: list[str] | None = None,
    size: str | None = None,
    aspect_ratio: str = "1:1",
    model: str | None = None,
) -> str:
    key = openai_image_api_key()
    if not key:
        raise ValueError("未配置 OpenAI 生图 API Key（openaiImageApiKey）")
    m = (model or DEFAULT_OPENAI_IMAGE_MODEL).strip()
    effective_size = _size_for(aspect_ratio, size)
    headers = {"Authorization": f"Bearer {key}"}

    # ---- 图生图：POST /images/edits（multipart）----
    if mode == "image2image":
        refs = [r for r in (reference_image_urls or []) if str(r or "").strip()]
        if not refs:
            raise ValueError("openai 图生图需要 reference_image_urls（至少 1 张参考图）")
        if len(refs) > _MAX_EDIT_IMAGES:
            logger.warning("openai edits 参考图 %d 张，仅取前 %d 张", len(refs), _MAX_EDIT_IMAGES)
            refs = refs[:_MAX_EDIT_IMAGES]

        files: list[tuple[str, tuple[str, bytes, str]]] = []
        for i, ref in enumerate(refs):
            raw, fname, mime = _image_bytes_from_ref(ref)
            field = "image" if len(refs) == 1 else "image[]"
            files.append((field, (f"{i}_{fname}", raw, mime)))

        form: dict[str, Any] = {
            "model": m,
            "prompt": prompt,
            "n": "1",
            "size": effective_size,
        }
        if m.startswith("gpt-image"):
            form["quality"] = "auto"
        url = f"{openai_image_base_url().rstrip('/')}/images/edits"
        with httpx.Client(timeout=300.0) as client:
            resp = client.post(url, headers=headers, files=files, data=form)
        try:
            data = resp.json()
        except Exception:
            data = {"raw": resp.text}
        if resp.status_code >= 400:
            raise RuntimeError(
                f"OpenAI images/edits {resp.status_code}: {json.dumps(data, ensure_ascii=False)[:500]}"
            )
        return _pick_result(data)

    # ---- 文生图：POST /images/generations ----
    body: dict[str, Any] = {
        "model": m,
        "prompt": prompt,
        "n": 1,
        "size": effective_size,
    }
    # GPT Image family returns b64 by default; quality tiers for 2.5.
    if m.startswith("gpt-image"):
        body["quality"] = "auto"
    elif m.startswith("dall-e") or _is_qwen_image(m):
        # DALL·E + Qwen-Image gateways prefer URL (or return b64 anyway).
        body["response_format"] = "url"
    url = f"{openai_image_base_url().rstrip('/')}/images/generations"
    with httpx.Client(timeout=180.0) as client:
        resp = client.post(
            url,
            headers={**headers, "Content-Type": "application/json"},
            json=body,
        )
    try:
        data = resp.json()
    except Exception:
        data = {"raw": resp.text}
    if resp.status_code >= 400:
        raise RuntimeError(f"OpenAI images {resp.status_code}: {json.dumps(data, ensure_ascii=False)[:500]}")
    return _pick_result(data)


def poll_image(task_id: str) -> tuple[str, str | None, list[str]]:
    if task_id.startswith("immediate:"):
        url = task_id[len("immediate:") :]
        return "succeeded", url, [url]
    raise RuntimeError(f"OpenAI images has no async poll for task_id={task_id}")
