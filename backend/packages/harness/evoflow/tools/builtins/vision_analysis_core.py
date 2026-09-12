"""Shared vision-model resolution and image analysis for view_image."""

from __future__ import annotations

import base64
import json
import logging
import mimetypes
import time
import urllib.request
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

_VISION_TIMEOUT = 120.0
_VISION_MAX_OUTPUT_TOKENS = 2000
_DEFAULT_USER_PROMPT = "请详细描述这张图片的内容。"
_VISION_MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024  # 50 MB
_NATIVE_MAX_EDGE = 1600  # align with EvoPanel composer compress
_NATIVE_MAX_BYTES = 4 * 1024 * 1024  # cap staged read before resize


def _vision_log(event: str, *, source: str = "core", level: int = logging.INFO, **fields: Any) -> None:
    """Structured Chinese log line for vision tool debugging."""
    extras = " ".join(f"{k}={v!r}" for k, v in fields.items() if v is not None and v != "")
    msg = f"[视觉识图:{source}] {event}"
    if extras:
        msg = f"{msg} | {extras}"
    logger.log(level, msg)


def is_http_image_ref(ref: str) -> bool:
    return str(ref or "").strip().lower().startswith(("http://", "https://"))


def is_safe_image_url(url: str) -> bool:
    """Basic URL safety check to prevent SSRF."""
    try:
        parsed = urlparse(url)
        if not parsed.netloc:
            return False
        hostname = parsed.hostname or ""
        if hostname in ("localhost", "127.0.0.1", "0.0.0.0", "::1"):
            return False
        parts = hostname.split(".")
        if len(parts) == 4 and all(p.isdigit() for p in parts):
            first = int(parts[0])
            if first in (10, 127, 169) or (first == 172 and 16 <= int(parts[1]) <= 31) or (first == 192 and int(parts[1]) == 168):
                return False
        return True
    except Exception:
        return False


def download_image_from_url(url: str) -> tuple[bytes, str] | str:
    """Download image from URL, return (bytes, mime_type) or error string."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        resp = urllib.request.urlopen(req, timeout=30)
        data = resp.read()
        if len(data) > _VISION_MAX_DOWNLOAD_BYTES:
            return f"Error: Image too large ({len(data) / 1024 / 1024:.1f} MB, max 50 MB)"
        mime = resp.headers.get("Content-Type", "") or "image/jpeg"
        return data, mime
    except Exception as e:
        return f"Error: Failed to download image: {e}"


def resolve_model_name_from_runtime(runtime: Any | None) -> str | None:
    """Extract session model_name from tool/runtime context."""
    if runtime is None:
        return None
    ctx = getattr(runtime, "context", None)
    if ctx is not None:
        try:
            name = ctx.get("model_name") if hasattr(ctx, "get") else None
            if name:
                return str(name).strip() or None
        except Exception:
            pass
    try:
        from langgraph.config import get_config

        name = get_config().get("configurable", {}).get("model_name")
        if name:
            return str(name).strip() or None
    except Exception:
        pass
    try:
        _tid = ctx.get("thread_id") if ctx is not None and hasattr(ctx, "get") else None
        if not _tid:
            from langgraph.config import get_config

            _tid = get_config().get("configurable", {}).get("thread_id")
        if _tid:
            from evoflow.persistence.session_repositories import get_model_name_for_thread

            _name = get_model_name_for_thread(str(_tid).strip())
            if _name:
                return str(_name).strip() or None
    except Exception:
        pass
    return None


def model_supports_vision(model_name: str | None) -> bool:
    from evoflow.config import get_app_config

    name = str(model_name or "").strip()
    if not name:
        return False
    mc = get_app_config().get_model_config(name)
    return bool(mc is not None and getattr(mc, "supports_vision", False))


def main_model_supports_vision(runtime: Any | None) -> bool:
    return model_supports_vision(resolve_model_name_from_runtime(runtime))


def resolve_vision_model_name(*, preferred: str | None = None, source: str = "core") -> str:
    """Pick a vision-capable model name from app + panel settings."""
    from evoflow.config import get_app_config
    from evoflow.persistence.panel_settings import get_panel_settings

    config = get_app_config()
    vision_model = ""
    pick_reason = ""

    pref = str(preferred or "").strip()
    if pref and model_supports_vision(pref):
        _vision_log("选用指定视觉模型", source=source, model=pref, reason="preferred")
        return pref

    primary = (config.primary_model or "").strip()
    if primary and model_supports_vision(primary):
        vision_model = primary
        pick_reason = "主模型已开启视觉"

    if not vision_model:
        default_vision = str(get_panel_settings().get("defaultVisionModel") or "").strip()
        if default_vision:
            if model_supports_vision(default_vision):
                vision_model = default_vision
                pick_reason = "设置 → 通用 → 默认视觉模型"
            elif config.get_model_config(default_vision) is not None:
                _vision_log(
                    "默认视觉模型未开启「视觉」能力，已跳过",
                    source=source,
                    level=logging.WARNING,
                    model=default_vision,
                )

    if not vision_model:
        for m in config.models:
            if getattr(m, "supports_vision", False):
                vision_model = str(m.name or "").strip()
                pick_reason = "配置中首个 supports_vision=true 的模型"
                break

    if vision_model:
        _vision_log("已选定视觉模型", source=source, model=vision_model, reason=pick_reason)
    else:
        vision_names = [str(m.name or "") for m in config.models if getattr(m, "supports_vision", False)]
        _vision_log(
            "未找到可用视觉模型",
            source=source,
            level=logging.WARNING,
            primary=primary or None,
            default_vision=str(get_panel_settings().get("defaultVisionModel") or "").strip() or None,
            vision_models=vision_names or "（无）",
            hint="请在「设置 → 模型」开启视觉，或在「设置 → 通用」指定默认视觉模型",
        )

    return vision_model


def analyze_image_bytes(
    img_bytes: bytes,
    mime_type: str,
    *,
    user_prompt: str = _DEFAULT_USER_PROMPT,
    preferred_model: str | None = None,
    source: str = "core",
    image_ref: str | None = None,
    runtime: Any | None = None,
) -> dict[str, Any]:
    """Run vision analysis and return a structured result dict (``analysis`` or ``error``)."""
    main_model = resolve_model_name_from_runtime(runtime)
    size_kb = round(len(img_bytes or b"") / 1024, 1) if img_bytes else 0

    if not img_bytes:
        _vision_log("图片数据为空，无法分析", source=source, level=logging.WARNING, image_ref=image_ref)
        return {"error": "Empty image data"}

    _vision_log(
        "开始视觉分析",
        source=source,
        image_ref=image_ref,
        mime=mime_type,
        size_kb=size_kb,
        main_model=main_model or "（未知）",
        main_supports_vision=main_model_supports_vision(runtime) if runtime is not None else None,
        prompt_preview=(user_prompt[:80] + "…") if len(user_prompt) > 80 else user_prompt,
    )

    vision_model = resolve_vision_model_name(preferred=preferred_model, source=source)
    if not vision_model:
        return {
            "error": (
                "未配置支持视觉的模型。"
                "请在「设置 → 模型」为某个模型开启「视觉」，或在「设置 → 通用」设置「默认视觉模型」。"
            )
        }

    started = time.perf_counter()
    try:
        from langchain_core.messages import HumanMessage

        from evoflow.models import create_chat_model

        b64 = base64.b64encode(img_bytes).decode("ascii")
        data_url = f"data:{mime_type};base64,{b64}"

        _vision_log("正在调用视觉模型", source=source, model=vision_model, timeout_s=_VISION_TIMEOUT)

        model = create_chat_model(
            name=vision_model,
            thinking_enabled=False,
            invocation_kind="vision",
            timeout=_VISION_TIMEOUT,
            max_tokens=_VISION_MAX_OUTPUT_TOKENS,
            temperature=0.1,
        )
        response = model.invoke(
            [
                HumanMessage(
                    content=[
                        {"type": "text", "text": user_prompt},
                        {"type": "image_url", "image_url": {"url": data_url}},
                    ]
                )
            ]
        )
        analysis = response.content if hasattr(response, "content") else str(response)
        if isinstance(analysis, list):
            parts: list[str] = []
            for block in analysis:
                if isinstance(block, str):
                    parts.append(block)
                elif isinstance(block, dict) and block.get("type") == "text":
                    parts.append(str(block.get("text") or ""))
            analysis = "\n".join(p for p in parts if p.strip())
        analysis_text = str(analysis or "").strip()
        elapsed_ms = round((time.perf_counter() - started) * 1000, 1)

        if not analysis_text:
            _vision_log(
                "视觉模型返回空内容",
                source=source,
                level=logging.WARNING,
                model=vision_model,
                elapsed_ms=elapsed_ms,
            )
            return {"error": "视觉模型返回空分析结果", "vision_model": vision_model}

        preview = analysis_text.replace("\n", " ")[:120]
        if len(analysis_text) > 120:
            preview += "…"
        _vision_log(
            "视觉分析完成",
            source=source,
            model=vision_model,
            elapsed_ms=elapsed_ms,
            chars=len(analysis_text),
            preview=preview,
        )

        return {
            "analysis": analysis_text,
            "vision_model": vision_model,
            "image_size_bytes": len(img_bytes),
        }
    except ImportError:
        _vision_log("缺少 langchain_openai 依赖", source=source, level=logging.ERROR)
        return {"error": "langchain_openai not installed. Install with: pip install langchain-openai"}
    except Exception as e:
        elapsed_ms = round((time.perf_counter() - started) * 1000, 1)
        _vision_log(
            "视觉分析失败",
            source=source,
            level=logging.WARNING,
            model=vision_model,
            elapsed_ms=elapsed_ms,
            error=str(e),
        )
        logger.debug("vision analysis traceback model=%s", vision_model, exc_info=True)
        return {"error": f"视觉分析失败: {e}", "vision_model": vision_model}


def prepare_image_bytes_for_native(img_bytes: bytes, mime_type: str) -> tuple[bytes, str]:
    """Resize/compress for main-model injection (runtime ResizeToFit-style)."""
    if not img_bytes:
        return img_bytes, mime_type or "application/octet-stream"
    mime = str(mime_type or "application/octet-stream").lower()
    if mime == "image/gif":
        return img_bytes, mime
    try:
        from io import BytesIO

        from PIL import Image

        img = Image.open(BytesIO(img_bytes))
        w, h = img.size
        if w and h:
            scale = min(1.0, _NATIVE_MAX_EDGE / max(w, h))
            if scale < 1.0:
                img = img.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.Resampling.LANCZOS)
        if img.mode not in ("RGB", "RGBA"):
            img = img.convert("RGB")
        out = BytesIO()
        out_mime = "image/jpeg"
        img.save(out, format="JPEG", quality=85, optimize=True)
        data = out.getvalue()
        if len(data) <= len(img_bytes):
            return data, out_mime
    except Exception:
        pass
    if len(img_bytes) > _NATIVE_MAX_BYTES:
        return img_bytes[:_NATIVE_MAX_BYTES], mime
    return img_bytes, mime


def bytes_to_data_url(img_bytes: bytes, mime_type: str) -> str:
    b64 = base64.b64encode(img_bytes).decode("ascii")
    return f"data:{mime_type};base64,{b64}"


def load_image_bytes_for_native(*, local_path: str | None = None, remote_url: str | None = None) -> tuple[bytes, str] | str:
    """Read local file or download URL; return (bytes, mime) or error string."""
    if remote_url:
        dl = download_image_from_url(remote_url)
        if isinstance(dl, str):
            return dl
        return dl
    path = Path(str(local_path or "").strip())
    if not path.is_file():
        return f"Error: Image file not found: {local_path}"
    try:
        raw = path.read_bytes()
    except OSError as e:
        return f"Error reading image file: {e}"
    if len(raw) > _VISION_MAX_DOWNLOAD_BYTES:
        return f"Error: Image too large ({len(raw) / 1024 / 1024:.1f} MB, max 50 MB)"
    mime_type, _ = mimetypes.guess_type(str(path))
    if not mime_type:
        mime_type = "application/octet-stream"
    return raw, mime_type


def format_native_tool_result(
    *,
    image_ref: str,
    mime_type: str,
    image_size_bytes: int,
    cached: bool = False,
) -> str:
    """Tool output persisted to obs/transcript — metadata only, never base64."""
    body: dict[str, Any] = {
        "mode": "native",
        "image_ref": image_ref,
        "mime_type": mime_type,
        "image_size_bytes": image_size_bytes,
        "cached": cached,
        "message": (
            "Image already attached in this thread; reuse prior analysis."
            if cached
            else "Image staged for the main vision model; pixels inject before the next model call."
        ),
    }
    return json.dumps(body, ensure_ascii=False)


def format_vision_tool_result(payload: dict[str, Any], *, image_ref: str) -> str:
    """Serialize tool output for the main (possibly non-vision) agent."""
    if payload.get("error"):
        return json.dumps(
            {"mode": "text", "error": payload["error"], "image_ref": image_ref, "vision_model": payload.get("vision_model")},
            ensure_ascii=False,
        )
    return json.dumps(
        {
            "mode": "text",
            "analysis": payload.get("analysis"),
            "vision_model": payload.get("vision_model"),
            "image_ref": image_ref,
            "image_size_bytes": payload.get("image_size_bytes"),
        },
        ensure_ascii=False,
    )
