"""OpenAI Images API — GPT Image 2.5 + OpenAI-compatible gateways (e.g. Qwen-Image).

Docs: https://developers.openai.com/api/docs/guides/image-generation
- Official: ``gpt-image-2.5-sunburst`` / ``gpt-image-2.5-flare`` → ``POST {base}/images/generations``
- Gateways (hon-maas etc.): ``Qwen-Image-2.1`` / ``Qwen-Image-2.1/QY5`` on same path
"""

from __future__ import annotations

import json
import logging
from typing import Any

import httpx

from evoflow.community.media_generation.config_helpers import openai_image_api_key, openai_image_base_url

logger = logging.getLogger(__name__)

DEFAULT_OPENAI_IMAGE_MODEL = "gpt-image-2.5-sunburst"


def _is_qwen_image(model: str) -> bool:
    return (model or "").strip().lower().startswith("qwen-image")


def submit_image(
    *,
    prompt: str,
    mode: str = "text2image",
    reference_image_urls: list[str] | None = None,
    size: str | None = None,
    aspect_ratio: str = "1:1",
    model: str | None = None,
) -> str:
    if mode == "image2image":
        raise ValueError(
            "openai image2image / edits 尚未接入平台工具；请用 text2image，"
            "或改用 jimeng（Seedream）做图生图。"
        )
    del reference_image_urls
    key = openai_image_api_key()
    if not key:
        raise ValueError("未配置 OpenAI 生图 API Key（openaiImageApiKey）")
    m = (model or DEFAULT_OPENAI_IMAGE_MODEL).strip()
    # GPT Image 2.5 supports auto + custom WxH; keep common aspect shortcuts.
    size_map = {
        "1:1": "1024x1024",
        "16:9": "1536x1024",
        "9:16": "1024x1536",
        "4:3": "1024x768",
        "3:4": "768x1024",
    }
    effective_size = size or size_map.get(aspect_ratio, "1024x1024")
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
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            json=body,
        )
    try:
        data = resp.json()
    except Exception:
        data = {"raw": resp.text}
    if resp.status_code >= 400:
        raise RuntimeError(f"OpenAI images {resp.status_code}: {json.dumps(data, ensure_ascii=False)[:500]}")
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


def poll_image(task_id: str) -> tuple[str, str | None, list[str]]:
    if task_id.startswith("immediate:"):
        url = task_id[len("immediate:") :]
        return "succeeded", url, [url]
    raise RuntimeError(f"OpenAI images has no async poll for task_id={task_id}")
