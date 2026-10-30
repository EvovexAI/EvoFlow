import json
import logging
import mimetypes
from pathlib import Path
from typing import Annotated, Any

from langchain.tools import InjectedToolCallId, ToolRuntime, tool
from langchain_core.messages import ToolMessage
from langgraph.types import Command
from langgraph.typing import ContextT

from evoflow.agents.image_routing import decide_view_image_route
from evoflow.agents.thread_state import ThreadState, ViewedImageData
from evoflow.sandbox.tools import get_thread_data, replace_virtual_path
from evoflow.tools.builtins.browser_screenshot_store import resolve_browser_snapshot_ref
from evoflow.tools.builtins.vision_analysis_core import (
    analyze_image_bytes,
    analyze_images_bytes,
    download_image_from_url,
    format_native_batch_tool_result,
    format_native_tool_result,
    format_vision_batch_tool_result,
    format_vision_tool_result,
    is_http_image_ref,
    is_safe_image_url,
)
from evoflow.tools.minimal_schema import VIEW_IMAGE_DESCRIPTION

logger = logging.getLogger(__name__)

_VALID_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
VIEW_IMAGE_MAX_REFS = 8


def _normalize_ref_key(ref: str) -> str:
    return str(ref or "").strip().replace("\\", "/")


def normalize_image_path_args(image_path: str | list[str] | None) -> list[str]:
    """Coerce tool ``image_path`` (str | list) into a deduped list of refs.

    Plain strings are kept as a single path/URL (do **not** split on commas —
    URLs and Windows paths may contain them). JSON-array strings are expanded.
    """
    if image_path is None:
        return []
    if isinstance(image_path, list):
        refs = [str(x).strip() for x in image_path if str(x).strip()]
    else:
        s = str(image_path).strip()
        if not s:
            return []
        if s.startswith("["):
            try:
                parsed = json.loads(s)
                if isinstance(parsed, list):
                    refs = [str(x).strip() for x in parsed if str(x).strip()]
                else:
                    refs = [s]
            except (json.JSONDecodeError, TypeError, ValueError):
                refs = [s]
        else:
            refs = [s]
    # Preserve order, drop duplicates
    return list(dict.fromkeys(refs))


def _already_native_viewed(runtime: ToolRuntime[ContextT, ThreadState], ref: str) -> bool:
    key = _normalize_ref_key(ref)
    if not key:
        return False
    seen = runtime.state.get("native_viewed_image_refs") if runtime.state else None
    if not isinstance(seen, list):
        return False
    normalized = {_normalize_ref_key(x) for x in seen if str(x or "").strip()}
    if key in normalized:
        return True
    # Also match by resolved absolute path basename+parent (Windows slash variants).
    try:
        key_path = Path(key)
        for prev in normalized:
            try:
                if Path(prev).resolve() == key_path.resolve():
                    return True
            except OSError:
                continue
    except Exception:
        pass
    return False


def _duplicate_native_read_error(image_ref: str) -> str:
    """Stop re-read loops without counting as a hard tool failure in observability.

    Prefixed with OK so status stays success (obs noise was ToolReturnedError spam);
    models still get an explicit do-not-retry instruction.
    """
    return (
        "OK: Image already in model context — do not call read/view_image again on this path. "
        f"path={image_ref}. Continue with your next non-read action "
        "(e.g. media.generate_video with first_frame_url set to this path)."
    )

def _stage_native_image(
    *,
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


def _stage_native_batch(
    *,
    tool_call_id: str,
    items: list[dict[str, Any]],
) -> Command:
    """``items`` entries: image_ref, staged, image_size_bytes, cached."""
    viewed: dict[str, ViewedImageData] = {}
    new_refs: list[str] = []
    meta_images: list[dict[str, Any]] = []
    for item in items:
        ref = str(item["image_ref"])
        staged: ViewedImageData = item["staged"]
        cached = bool(item.get("cached"))
        size = int(item.get("image_size_bytes") or 0)
        viewed[ref] = staged
        if not cached:
            new_refs.append(ref)
        meta_images.append(
            {
                "image_ref": ref,
                "mime_type": staged.get("mime_type"),
                "image_size_bytes": size,
                "cached": cached,
            }
        )
    if len(meta_images) == 1:
        only = items[0]
        return _stage_native_image(
            tool_call_id=tool_call_id,
            image_ref=str(only["image_ref"]),
            staged=only["staged"],
            image_size_bytes=int(only.get("image_size_bytes") or 0),
            cached=bool(only.get("cached")),
        )
    payload = format_native_batch_tool_result(images=meta_images)
    update: dict = {
        "messages": [ToolMessage(content=payload, tool_call_id=tool_call_id)],
        "viewed_images": viewed,
    }
    if new_refs:
        update["native_viewed_image_refs"] = new_refs
    return Command(update=update)


def _resolve_local_actual_path(
    runtime: ToolRuntime[ContextT, ThreadState], ref: str
) -> tuple[str | None, str | None]:
    """Return ``(actual_path, error)`` for a local / browser-snapshot ref."""
    snapshot = resolve_browser_snapshot_ref(ref)
    if snapshot is not None:
        return str(snapshot), None
    if "/browser-snapshots/" in ref.replace("\\", "/"):
        return None, f"Error: Browser snapshot not found: {ref}"
    thread_data = get_thread_data(runtime)
    return replace_virtual_path(ref, thread_data), None


def _prepare_local_native_or_bytes(
    *,
    runtime: ToolRuntime[ContextT, ThreadState],
    image_path: str,
    actual_path: str,
    route: str,
) -> dict[str, Any]:
    """Return native stage item, text bytes payload, or ``{"error": ...}``."""
    path = Path(actual_path)
    if not path.is_absolute():
        logger.warning("[视觉识图:view_image] 路径非绝对路径 path=%r", image_path)
        return {"error": f"Error: Path must be absolute, got: {image_path}"}
    if not path.exists():
        logger.warning("[视觉识图:view_image] 文件不存在 path=%r", actual_path)
        return {"error": f"Error: Image file not found: {image_path}"}
    if not path.is_file():
        logger.warning("[视觉识图:view_image] 路径不是文件 path=%r", actual_path)
        return {"error": f"Error: Path is not a file: {image_path}"}
    if path.suffix.lower() not in _VALID_EXTENSIONS:
        return {
            "error": (
                f"Error: Unsupported image format: {path.suffix}. "
                f"Supported formats: {', '.join(sorted(_VALID_EXTENSIONS))}"
            )
        }

    mime_type, _ = mimetypes.guess_type(actual_path)
    if mime_type is None:
        mime_type = {
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".png": "image/png",
            ".webp": "image/webp",
        }.get(path.suffix.lower(), "application/octet-stream")

    try:
        size = path.stat().st_size
    except OSError:
        size = 0

    if route == "native":
        cached = _already_native_viewed(runtime, image_path)
        if cached:
            logger.info("[视觉识图:view_image] 跳过重复 native path=%r", image_path)
        else:
            logger.info(
                "[视觉识图:view_image] native 暂存 path=%r resolved=%r mime=%s",
                image_path,
                actual_path,
                mime_type,
            )
        return {
            "kind": "native",
            "image_ref": image_path,
            "staged": {"path": actual_path, "mime_type": mime_type, "is_remote": False},
            "image_size_bytes": int(size),
            "cached": cached,
        }

    try:
        with open(actual_path, "rb") as f:
            image_data = f.read()
    except Exception as e:
        logger.warning("[视觉识图:view_image] 读取文件失败 path=%r error=%s", actual_path, e)
        return {"error": f"Error reading image file: {str(e)}"}

    logger.info(
        "[视觉识图:view_image] text 模式分析 path=%r size_kb=%.1f mime=%s",
        actual_path,
        len(image_data) / 1024,
        mime_type,
    )
    return {
        "kind": "text",
        "image_ref": image_path,
        "img_bytes": image_data,
        "mime_type": mime_type,
    }


def _prepare_remote_native_or_bytes(
    *,
    runtime: ToolRuntime[ContextT, ThreadState],
    image_url: str,
    route: str,
) -> dict[str, Any]:
    if not is_safe_image_url(image_url):
        return {"error": "URL blocked for security reasons (internal/private address)"}

    if route == "native":
        cached = _already_native_viewed(runtime, image_url)
        if not cached:
            logger.info("[视觉识图:view_image] native 暂存远程 url=%r", image_url)
        return {
            "kind": "native",
            "image_ref": image_url,
            "staged": {"path": image_url, "mime_type": "image/jpeg", "is_remote": True},
            "image_size_bytes": 0,
            "cached": cached,
        }

    dl_result = download_image_from_url(image_url)
    if isinstance(dl_result, str):
        logger.warning("[视觉识图:view_image] 下载失败 url=%r error=%s", image_url, dl_result)
        return {"error": dl_result}

    img_bytes, mime_type = dl_result
    logger.info(
        "[视觉识图:view_image] text 模式远程 url=%r size_kb=%.1f mime=%s",
        image_url,
        len(img_bytes) / 1024,
        mime_type,
    )
    return {
        "kind": "text",
        "image_ref": image_url,
        "img_bytes": img_bytes,
        "mime_type": mime_type,
    }


def _prepare_one_ref(
    *,
    runtime: ToolRuntime[ContextT, ThreadState],
    ref: str,
    route: str,
) -> dict[str, Any]:
    if is_http_image_ref(ref):
        return _prepare_remote_native_or_bytes(runtime=runtime, image_url=ref, route=route)

    actual_path, err = _resolve_local_actual_path(runtime, ref)
    if err:
        logger.warning("[视觉识图:view_image] %s", err)
        return {"error": err}
    assert actual_path is not None
    logger.info("[视觉识图:view_image] resolved=%r -> %r", ref, actual_path)
    return _prepare_local_native_or_bytes(
        runtime=runtime,
        image_path=ref,
        actual_path=actual_path,
        route=route,
    )


def _analyze_local_image(
    *,
    runtime: ToolRuntime[ContextT, ThreadState],
    tool_call_id: str,
    image_path: str,
    actual_path: str,
) -> Command | str:
    """Single-image path kept for clarity; batch entry uses ``_prepare_*``."""
    route = decide_view_image_route(runtime=runtime)
    prepared = _prepare_local_native_or_bytes(
        runtime=runtime,
        image_path=image_path,
        actual_path=actual_path,
        route=route,
    )
    if prepared.get("error"):
        err = str(prepared["error"])
        if err.startswith("Error:") or err.startswith("Error "):
            return err
        return format_vision_tool_result({"error": err}, image_ref=image_path)
    if prepared.get("kind") == "native":
        if prepared.get("cached"):
            logger.info("[视觉识图:view_image] HARD-BLOCK 重复 native path=%r", image_path)
            return _duplicate_native_read_error(str(prepared.get("image_ref") or image_path))
        return _stage_native_image(
            tool_call_id=tool_call_id,
            image_ref=prepared["image_ref"],
            staged=prepared["staged"],
            image_size_bytes=int(prepared.get("image_size_bytes") or 0),
            cached=False,
        )
    payload = analyze_image_bytes(
        prepared["img_bytes"],
        prepared["mime_type"],
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
    route = decide_view_image_route(runtime=runtime)
    prepared = _prepare_remote_native_or_bytes(runtime=runtime, image_url=image_url, route=route)
    if prepared.get("error"):
        return format_vision_tool_result({"error": prepared["error"]}, image_ref=image_url)
    if prepared.get("kind") == "native":
        if prepared.get("cached"):
            logger.info("[视觉识图:view_image] HARD-BLOCK 重复 native url=%r", image_url)
            return _duplicate_native_read_error(str(prepared.get("image_ref") or image_url))
        return _stage_native_image(
            tool_call_id=tool_call_id,
            image_ref=prepared["image_ref"],
            staged=prepared["staged"],
            image_size_bytes=int(prepared.get("image_size_bytes") or 0),
            cached=False,
        )
    payload = analyze_image_bytes(
        prepared["img_bytes"],
        prepared["mime_type"],
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


def _view_images_batch(
    *,
    runtime: ToolRuntime[ContextT, ThreadState],
    tool_call_id: str,
    refs: list[str],
) -> Command | str:
    route = decide_view_image_route(runtime=runtime)
    logger.info(
        "[视觉识图:view_image] 批量请求 count=%s route=%s paths=%r",
        len(refs),
        route,
        refs,
    )

    prepared_list: list[dict[str, Any]] = []
    load_errors: list[dict[str, str]] = []
    for ref in refs:
        prepared = _prepare_one_ref(runtime=runtime, ref=ref, route=route)
        if prepared.get("error"):
            load_errors.append({"image_ref": ref, "error": str(prepared["error"])})
            continue
        prepared_list.append(prepared)

    if not prepared_list:
        if len(load_errors) == 1:
            only = load_errors[0]
            err = only["error"]
            if err.startswith("Error:") or err.startswith("Error "):
                return err
            return format_vision_tool_result({"error": err}, image_ref=only["image_ref"])
        return json.dumps(
            {"mode": "text", "count": 0, "error": "All images failed to load", "load_errors": load_errors},
            ensure_ascii=False,
        )

    if route == "native":
        native_items = [p for p in prepared_list if p.get("kind") == "native"]
        fresh = [p for p in native_items if not p.get("cached")]
        cached_only = [p for p in native_items if p.get("cached")]
        if cached_only and not fresh and not load_errors:
            refs = [str(p.get("image_ref") or "") for p in cached_only]
            logger.info("[视觉识图:view_image] HARD-BLOCK 批量重复 native refs=%r", refs)
            if len(refs) == 1:
                return _duplicate_native_read_error(refs[0])
            return (
                "Error: All listed images already in model context — do not call read/view_image again. "
                f"paths={refs}. Continue with your next non-read action."
            )
        # Drop cached duplicates; only stage fresh refs.
        native_items = fresh or native_items
        cmd = _stage_native_batch(tool_call_id=tool_call_id, items=native_items)
        if load_errors:
            # Annotate tool message with load errors while keeping staging.
            update = dict(cmd.update)
            messages = list(update.get("messages") or [])
            if messages and isinstance(messages[0], ToolMessage):
                try:
                    body = json.loads(str(messages[0].content))
                except (json.JSONDecodeError, TypeError, ValueError):
                    body = {"mode": "native", "message": str(messages[0].content)}
                body["load_errors"] = load_errors
                messages[0] = ToolMessage(content=json.dumps(body, ensure_ascii=False), tool_call_id=tool_call_id)
                update["messages"] = messages
            return Command(update=update)
        return cmd

    text_items = [p for p in prepared_list if p.get("kind") == "text"]
    images = [
        (p["img_bytes"], p["mime_type"], p["image_ref"])
        for p in text_items
    ]
    image_refs = [p["image_ref"] for p in text_items]
    if len(images) == 1 and not load_errors:
        payload = analyze_image_bytes(
            images[0][0],
            images[0][1],
            source="view_image",
            image_ref=image_refs[0],
            runtime=runtime,
        )
        if payload.get("error"):
            logger.warning(
                "[视觉识图:view_image] 分析未成功 path=%r model=%r error=%r",
                image_refs[0],
                payload.get("vision_model"),
                payload.get("error"),
            )
        return format_vision_tool_result(payload, image_ref=image_refs[0])

    payload = analyze_images_bytes(images, source="view_image", runtime=runtime)
    if payload.get("error"):
        logger.warning(
            "[视觉识图:view_image] 多图分析未成功 refs=%r model=%r error=%r",
            image_refs,
            payload.get("vision_model"),
            payload.get("error"),
        )
    return format_vision_batch_tool_result(
        payload,
        image_refs=image_refs,
        load_errors=load_errors or None,
    )


def run_view_image_refs(
    *,
    runtime: ToolRuntime[ContextT, ThreadState],
    tool_call_id: str,
    refs: list[str],
) -> Command | str:
    """Shared image-viewing pipeline (native staging or vision-model text analysis).

    Used by the ``view_image`` tool and delegated to by the host-direct ``read``
    tool for image refs (jpg/jpeg/png/webp, http(s) URLs, browser-snapshot refs).
    """
    if not refs:
        return "Error: image_path is required (string path/URL or list of paths/URLs)"
    if len(refs) > VIEW_IMAGE_MAX_REFS:
        return f"Error: Too many images ({len(refs)}); max is {VIEW_IMAGE_MAX_REFS} per call"
    logger.info("[视觉识图:view_image] 收到请求 count=%s path=%r", len(refs), refs if len(refs) > 1 else refs[0])

    if len(refs) == 1:
        ref = refs[0]
        snapshot = resolve_browser_snapshot_ref(ref)
        if snapshot is not None:
            logger.info("[视觉识图:view_image] browser-snapshot 解析为 %s", snapshot)
            return _analyze_local_image(
                runtime=runtime,
                tool_call_id=tool_call_id,
                image_path=ref,
                actual_path=str(snapshot),
            )
        if "/browser-snapshots/" in ref.replace("\\", "/"):
            logger.warning("[视觉识图:view_image] browser-snapshot 未找到 path=%r", ref)
            return f"Error: Browser snapshot not found: {ref}"
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

    return _view_images_batch(runtime=runtime, tool_call_id=tool_call_id, refs=refs)


@tool("view_image", description=VIEW_IMAGE_DESCRIPTION, parse_docstring=False)
def view_image_tool(
    runtime: ToolRuntime[ContextT, ThreadState],
    image_path: str | list[str],
    tool_call_id: Annotated[str, InjectedToolCallId],
) -> Command | str:
    """Load or analyze one or more images for the main model.

    Deprecated in the host-direct catalog: use ``read`` instead, which dispatches
    image refs (paths / URLs / browser-snapshots) to the same pipeline. This
    wrapper remains registered in sandbox mode and for backward-compatible tests.
    """
    refs = normalize_image_path_args(image_path)
    if not refs:
        return "Error: image_path is required (string path/URL or list of paths/URLs)"
    return run_view_image_refs(runtime=runtime, tool_call_id=tool_call_id, refs=refs)
