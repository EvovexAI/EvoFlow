import json
import logging
import mimetypes
from pathlib import Path
from typing import Annotated

from langchain.tools import InjectedToolCallId, ToolRuntime, tool
from langchain_core.messages import ToolMessage
from langgraph.types import Command
from langgraph.typing import ContextT

from evoflow.agents.image_routing import decide_view_image_route
from evoflow.agents.thread_state import ThreadState, ViewedImageData
from evoflow.sandbox.tools import get_thread_data, replace_virtual_path
from evoflow.tools.builtins.vision_analysis_core import (
    analyze_image_bytes,
    download_image_from_url,
    format_native_tool_result,
    format_vision_tool_result,
    is_http_image_ref,
    is_safe_image_url,
    load_image_bytes_for_native,
)
from evoflow.tools.minimal_schema import VIEW_IMAGE_DESCRIPTION

logger = logging.getLogger(__name__)

_VALID_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}


def _normalize_ref_key(ref: str) -> str:
    return str(ref or "").strip().replace("\\", "/")


def _already_native_viewed(runtime: ToolRuntime[ContextT, ThreadState], ref: str) -> bool:
    key = _normalize_ref_key(ref)
    if not key:
        return False
    seen = runtime.state.get("native_viewed_image_refs") if runtime.state else None
    if not isinstance(seen, list):
        return False
    normalized = {_normalize_ref_key(x) for x in seen if str(x or "").strip()}
    return key in normalized


def _stage_native_image(
    *,
    runtime: ToolRuntime[ContextT, ThreadState],
    tool_call_id: str,
    image_ref: str,
    staged: ViewedImageData,
    image_size_bytes: int,
    cached: bool = False,
) -> Command:
    payload = format_native_tool_result(
        image_ref=image_ref,
        mime_type=staged["mime_type"],
        image_size_bytes=image_size_bytes,
        cached=cached,
    )
    message = ToolMessage(content=payload, tool_call_id=tool_call_id)
    update: dict = {
        "messages": [message],
        "viewed_images": {image_ref: staged},
    }
    if not cached:
        update["native_viewed_image_refs"] = [image_ref]
    return Command(update=update)


def _analyze_local_image(
    *,
    runtime: ToolRuntime[ContextT, ThreadState],
    tool_call_id: str,
    image_path: str,
    actual_path: str,
) -> Command | str:
    path = Path(actual_path)
    if not path.is_absolute():
        logger.warning("[视觉识图:view_image] 路径非绝对路径 path=%r", image_path)
        return f"Error: Path must be absolute, got: {image_path}"

    if not path.exists():
        logger.warning("[视觉识图:view_image] 文件不存在 path=%r", actual_path)
        return f"Error: Image file not found: {image_path}"

    if not path.is_file():
        logger.warning("[视觉识图:view_image] 路径不是文件 path=%r", actual_path)
        return f"Error: Path is not a file: {image_path}"

    if path.suffix.lower() not in _VALID_EXTENSIONS:
        return f"Error: Unsupported image format: {path.suffix}. Supported formats: {', '.join(_VALID_EXTENSIONS)}"

    mime_type, _ = mimetypes.guess_type(actual_path)
    if mime_type is None:
        mime_type = {
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".png": "image/png",
            ".webp": "image/webp",
        }.get(path.suffix.lower(), "application/octet-stream")

    route = decide_view_image_route(runtime=runtime)
    if route == "native":
        if _already_native_viewed(runtime, image_path):
            logger.info("[视觉识图:view_image] 跳过重复 native path=%r", image_path)
            try:
                size = path.stat().st_size
            except OSError:
                size = 0
            return _stage_native_image(
                runtime=runtime,
                tool_call_id=tool_call_id,
                image_ref=image_path,
                staged={"path": actual_path, "mime_type": mime_type, "is_remote": False},
                image_size_bytes=int(size),
                cached=True,
            )

        logger.info(
            "[视觉识图:view_image] native 暂存 path=%r resolved=%r mime=%s",
            image_path,
            actual_path,
            mime_type,
        )
        try:
            size = path.stat().st_size
        except OSError:
            size = 0
        return _stage_native_image(
            runtime=runtime,
            tool_call_id=tool_call_id,
            image_ref=image_path,
            staged={"path": actual_path, "mime_type": mime_type, "is_remote": False},
            image_size_bytes=int(size),
        )

    try:
        with open(actual_path, "rb") as f:
            image_data = f.read()
    except Exception as e:
        logger.warning("[视觉识图:view_image] 读取文件失败 path=%r error=%s", actual_path, e)
        return f"Error reading image file: {str(e)}"

    logger.info(
        "[视觉识图:view_image] text 模式分析 path=%r size_kb=%.1f mime=%s",
        actual_path,
        len(image_data) / 1024,
        mime_type,
    )
    payload = analyze_image_bytes(
        image_data,
        mime_type,
        source="view_image",
        image_ref=image_path,
        runtime=runtime,
    )
    if payload.get("error"):
        logger.warning(
            "[视觉识图:view_image] 分析未成功 path=%r model=%r error=%r",
            image_path,
            payload.get("vision_model"),
            payload.get("error"),
        )
    return format_vision_tool_result(payload, image_ref=image_path)


def _analyze_remote_image(
    *,
    runtime: ToolRuntime[ContextT, ThreadState],
    tool_call_id: str,
    image_url: str,
) -> Command | str:
    if not is_safe_image_url(image_url):
        return format_vision_tool_result(
            {"error": "URL blocked for security reasons (internal/private address)"},
            image_ref=image_url,
        )

    route = decide_view_image_route(runtime=runtime)
    if route == "native":
        if _already_native_viewed(runtime, image_url):
            return _stage_native_image(
                runtime=runtime,
                tool_call_id=tool_call_id,
                image_ref=image_url,
                staged={"path": image_url, "mime_type": "image/jpeg", "is_remote": True},
                image_size_bytes=0,
                cached=True,
            )
        logger.info("[视觉识图:view_image] native 暂存远程 url=%r", image_url)
        return _stage_native_image(
            runtime=runtime,
            tool_call_id=tool_call_id,
            image_ref=image_url,
            staged={"path": image_url, "mime_type": "image/jpeg", "is_remote": True},
            image_size_bytes=0,
        )

    dl_result = download_image_from_url(image_url)
    if isinstance(dl_result, str):
        logger.warning("[视觉识图:view_image] 下载失败 url=%r error=%s", image_url, dl_result)
        return format_vision_tool_result({"error": dl_result}, image_ref=image_url)

    img_bytes, mime_type = dl_result
    logger.info(
        "[视觉识图:view_image] text 模式远程 url=%r size_kb=%.1f mime=%s",
        image_url,
        len(img_bytes) / 1024,
        mime_type,
    )
    payload = analyze_image_bytes(
        img_bytes,
        mime_type,
        source="view_image",
        image_ref=image_url,
        runtime=runtime,
    )
    if payload.get("error"):
        logger.warning(
            "[视觉识图:view_image] 分析未成功 url=%r model=%r error=%r",
            image_url,
            payload.get("vision_model"),
            payload.get("error"),
        )
    return format_vision_tool_result(payload, image_ref=image_url)


@tool("view_image", description=VIEW_IMAGE_DESCRIPTION, parse_docstring=False)
def view_image_tool(
    runtime: ToolRuntime[ContextT, ThreadState],
    image_path: str,
    tool_call_id: Annotated[str, InjectedToolCallId],
) -> Command | str:
    """Load or analyze an image for the main model."""
    ref = str(image_path or "").strip()
    logger.info("[视觉识图:view_image] 收到请求 path=%r", ref)

    if is_http_image_ref(ref):
        return _analyze_remote_image(runtime=runtime, tool_call_id=tool_call_id, image_url=ref)

    thread_data = get_thread_data(runtime)
    actual_path = replace_virtual_path(ref, thread_data)
    logger.info("[视觉识图:view_image] resolved=%r", actual_path)
    return _analyze_local_image(
        runtime=runtime,
        tool_call_id=tool_call_id,
        image_path=ref,
        actual_path=actual_path,
    )
