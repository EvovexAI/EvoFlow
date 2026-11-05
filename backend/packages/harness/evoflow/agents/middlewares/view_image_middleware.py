"""Middleware for injecting image details into conversation before LLM call."""

from __future__ import annotations

import logging
from typing import Any

try:
    from typing import NotRequired, override
except ImportError:
    from typing import NotRequired

    from typing_extensions import override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import ModelCallResult, ModelRequest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.runtime import Runtime

from evoflow.agents.thread_state import ViewedImageData
from evoflow.tools.builtins.vision_analysis_core import (
    MODEL_INJECT_MAX_BASE64_BYTES,
    bytes_to_data_url,
    is_http_image_ref,
    load_image_bytes_for_native,
    main_model_supports_vision,
    prepare_image_bytes_for_native,
)

logger = logging.getLogger(__name__)

# Tools whose calls stage images into ``viewed_images``: the dedicated
# ``view_image`` tool, and ``read`` when its args reference image refs
# (paths/URLs/snapshots) — ``read`` dispatches images to the same pipeline.
_IMAGE_READ_EXTENSIONS = (".jpg", ".jpeg", ".png", ".webp")
_VIEW_IMAGE_SOURCES_KEY = "view_image_sources"
_OMITTED_MARKER = "base64 data omitted to save context"


def _read_args_reference_image(args: object) -> bool:
    if not isinstance(args, dict):
        return False
    raw = args.get("path")
    refs = raw if isinstance(raw, list) else [raw]
    for ref in refs:
        s = str(ref or "").strip().lower().replace("\\", "/")
        if not s:
            continue
        if s.startswith(("http://", "https://")) or "/browser-snapshots/" in s:
            return True
        if s.split("?", 1)[0].split("#", 1)[0].endswith(_IMAGE_READ_EXTENSIONS):
            return True
    return False


def _is_view_image_inject(msg: object) -> bool:
    if not isinstance(msg, HumanMessage):
        return False
    if str(getattr(msg, "name", None) or "").strip() == "view_image_inject":
        return True
    content = getattr(msg, "content", None)
    text = str(content) if not isinstance(content, list) else ""
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, dict) and isinstance(block.get("text"), str):
                parts.append(block["text"])
            elif isinstance(block, str):
                parts.append(block)
        text = "\n".join(parts)
    return (
        "Here are the images you've viewed" in text
        or "Here are the details of the images you've viewed" in text
        or "Here are the latest screen captures" in text
    )


def _has_live_image_url(msg: HumanMessage) -> bool:
    content = getattr(msg, "content", None)
    if not isinstance(content, list):
        return False
    for block in content:
        if not isinstance(block, dict):
            continue
        if str(block.get("type") or "").lower() not in {"image_url", "image", "input_image"}:
            continue
        raw = block.get("image_url")
        url = ""
        if isinstance(raw, dict):
            url = str(raw.get("url") or "")
        elif isinstance(raw, str):
            url = raw
        if url.startswith("data:image") and _OMITTED_MARKER not in url:
            return True
    return False


def _content_has_omitted_placeholder(msg: HumanMessage) -> bool:
    content = getattr(msg, "content", None)
    if isinstance(content, str):
        return _OMITTED_MARKER in content
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and _OMITTED_MARKER in str(block.get("text") or ""):
                return True
            if isinstance(block, str) and _OMITTED_MARKER in block:
                return True
    return False


class ViewImageMiddlewareState(AgentState):
    """Compatible with the `ThreadState` schema."""

    viewed_images: NotRequired[dict[str, ViewedImageData] | None]


class ViewImageMiddleware(AgentMiddleware[ViewImageMiddlewareState]):
    """Inject staged ``view_image`` paths as ephemeral multimodal blocks before LLM calls.

    Storage model (checkpoint-safe):
    - ``viewed_images`` holds **paths + mime only** (no base64 in graph state)
    - Bytes are read + resized here; base64 exists only in the injected ``HumanMessage``
    - ``context_compaction`` must not blank current-turn injects; this middleware also
      reattaches pixels in ``wrap_model_call`` (registered after compaction) if strip
      or a stale checkpoint left an omitted placeholder
    - Observability / transcript store tool JSON metadata only
    """

    state_schema = ViewImageMiddlewareState

    def _get_last_assistant_message(self, messages: list) -> AIMessage | None:
        for msg in reversed(messages):
            if isinstance(msg, AIMessage):
                return msg
        return None

    def _has_view_image_tool(self, message: AIMessage) -> bool:
        if not hasattr(message, "tool_calls") or not message.tool_calls:
            return False
        return any(
            tool_call.get("name") == "view_image"
            or (str(tool_call.get("name") or "") == "read" and _read_args_reference_image(tool_call.get("args")))
            for tool_call in message.tool_calls
        )

    def _all_tools_completed(self, messages: list, assistant_msg: AIMessage) -> bool:
        if not hasattr(assistant_msg, "tool_calls") or not assistant_msg.tool_calls:
            return False

        tool_call_ids = {tool_call.get("id") for tool_call in assistant_msg.tool_calls if tool_call.get("id")}

        try:
            assistant_idx = messages.index(assistant_msg)
        except ValueError:
            return False

        completed_tool_ids = set()
        for msg in messages[assistant_idx + 1 :]:
            if isinstance(msg, ToolMessage) and msg.tool_call_id:
                completed_tool_ids.add(msg.tool_call_id)

        return tool_call_ids.issubset(completed_tool_ids)

    def _load_staged_image_bytes(self, image_ref: str, image_data: ViewedImageData) -> tuple[bytes, str] | None:
        is_remote = bool(image_data.get("is_remote")) or is_http_image_ref(image_ref)
        path = str(image_data.get("path") or image_ref or "").strip()
        mime = str(image_data.get("mime_type") or "application/octet-stream")

        if is_remote:
            loaded = load_image_bytes_for_native(remote_url=path)
        else:
            loaded = load_image_bytes_for_native(local_path=path)

        if isinstance(loaded, str):
            logger.warning("[ViewImageMiddleware] 读取暂存图片失败 ref=%r err=%s", image_ref, loaded)
            return None
        raw_bytes, detected_mime = loaded
        return prepare_image_bytes_for_native(
            raw_bytes, detected_mime or mime, max_base64_bytes=MODEL_INJECT_MAX_BASE64_BYTES
        )

    @staticmethod
    def _is_auto(image_data: ViewedImageData) -> bool:
        return bool(image_data.get("auto"))

    def _has_auto_images(self, state: ViewImageMiddlewareState) -> bool:
        viewed_images = state.get("viewed_images", {}) or {}
        return any(self._is_auto(image_data) for image_data in viewed_images.values())

    def _sources_from_viewed(self, viewed_images: dict[str, ViewedImageData]) -> list[dict[str, Any]]:
        sources: list[dict[str, Any]] = []
        for image_ref, image_data in viewed_images.items():
            sources.append(
                {
                    "ref": str(image_ref),
                    "path": str(image_data.get("path") or image_ref),
                    "mime_type": str(image_data.get("mime_type") or "application/octet-stream"),
                    "is_remote": bool(image_data.get("is_remote")) or is_http_image_ref(str(image_ref)),
                    "auto": self._is_auto(image_data),
                    "label": str(image_data.get("label") or "").strip(),
                }
            )
        return sources

    def _create_image_details_message(
        self, state: ViewImageMiddlewareState
    ) -> tuple[list[str | dict], list[str], list[str], list[dict[str, Any]]]:
        """Build multimodal blocks for staged images.

        Returns ``(content_blocks, delivered_refs, failed_refs, sources)``.
        Never invents a "No images have been viewed" synthetic — callers must
        skip inject when ``viewed_images`` is empty (Mode B fault).
        """
        viewed_images = state.get("viewed_images", {}) or {}
        manual = {ref: data for ref, data in viewed_images.items() if not self._is_auto(data)}
        auto = {ref: data for ref, data in viewed_images.items() if self._is_auto(data)}
        if not viewed_images:
            return [], [], [], []

        content_blocks: list[str | dict] = []
        delivered_refs: list[str] = []
        failed_refs: list[str] = []
        if manual:
            content_blocks.append({"type": "text", "text": "Here are the images you've viewed:"})
        elif auto:
            content_blocks.append(
                {
                    "type": "text",
                    "text": "Here are the latest screen captures from your computer control actions:",
                }
            )

        for group, header in ((manual, None), (auto, "\nLatest screen captures:")):
            if header is not None:
                content_blocks.append({"type": "text", "text": header})
            for image_ref, image_data in group.items():
                mime_type = str(image_data.get("mime_type") or "unknown")
                path_hint = str(image_data.get("path") or image_ref)
                label = str(image_data.get("label") or "").strip()
                shown_ref = f"{image_ref} ({label})" if label else image_ref
                content_blocks.append(
                    {
                        "type": "text",
                        "text": f"\n- **{shown_ref}** ({mime_type})\n[Image attached at: {path_hint}]",
                    }
                )

                loaded = self._load_staged_image_bytes(image_ref, image_data)
                if not loaded:
                    failed_refs.append(image_ref)
                    content_blocks.append(
                        {
                            "type": "text",
                            "text": (
                                f"[pixels_delivered=false] Failed to load/resize image bytes for "
                                f"{path_hint}. Re-call read/view_image on this path."
                            ),
                        }
                    )
                    logger.warning(
                        "[ViewImageMiddleware] staged ref has no pixels (load/resize failed) ref=%r path=%r",
                        image_ref,
                        path_hint,
                    )
                    continue
                img_bytes, out_mime = loaded
                content_blocks.append(
                    {
                        "type": "image_url",
                        "image_url": {"url": bytes_to_data_url(img_bytes, out_mime)},
                    }
                )
                delivered_refs.append(image_ref)

        return content_blocks, delivered_refs, failed_refs, self._sources_from_viewed(viewed_images)

    def _should_inject_image_message(self, state: ViewImageMiddlewareState) -> tuple[bool, str]:
        messages = state.get("messages", [])
        if not messages:
            return False, "no_messages"

        last_assistant_msg = self._get_last_assistant_message(messages)
        if not last_assistant_msg:
            return False, "no_assistant"

        # ``view_image`` staging requires the tool call in the last assistant
        # message; ``auto`` staging (node_repl screenshots) is one-shot and
        # injects regardless, as long as the tools of this turn have settled.
        has_manual = self._has_view_image_tool(last_assistant_msg)
        has_auto = self._has_auto_images(state)
        if not has_manual and not has_auto:
            return False, "no_read_image_tool_and_no_auto"

        if not self._all_tools_completed(messages, last_assistant_msg):
            return False, "tools_incomplete"

        assistant_idx = messages.index(last_assistant_msg)
        for msg in messages[assistant_idx + 1 :]:
            if not isinstance(msg, HumanMessage):
                continue
            if not _is_view_image_inject(msg):
                continue
            # A prior inject with live pixels → skip. A stripped "omitted"
            # placeholder must NOT block re-inject / wrap reattach.
            if _has_live_image_url(msg):
                return False, "already_injected_this_turn"
            if _content_has_omitted_placeholder(msg):
                return True, "ok_reattach_stripped"
            return False, "already_injected_this_turn"

        return True, "ok"

    def _inject_image_message(self, state: ViewImageMiddlewareState, runtime: Runtime) -> dict | None:
        viewed_images = state.get("viewed_images", {}) or {}
        staged_n = len(viewed_images)

        if not main_model_supports_vision(runtime):
            if viewed_images:
                logger.info(
                    "[ViewImageMiddleware] SKIP inject reason=no_vision staged=%s refs=%s",
                    staged_n,
                    list(viewed_images.keys())[:5],
                )
                return {"viewed_images": {}}
            return None

        # Hard-blocked re-reads used to leave viewed_images empty while the
        # assistant still had a view_image/read tool call → inject ran and
        # produced "No images have been viewed." (Mode B). Skip when nothing staged.
        if not viewed_images:
            return None

        should, reason = self._should_inject_image_message(state)
        if not should:
            if staged_n:
                logger.info(
                    "[ViewImageMiddleware] SKIP inject reason=%s staged=%s refs=%s",
                    reason,
                    staged_n,
                    list(viewed_images.keys())[:5],
                )
            return None

        image_content, delivered_refs, failed_refs, sources = self._create_image_details_message(state)
        pixel_n = len(delivered_refs)
        human_msg = HumanMessage(
            content=image_content,
            name="view_image_inject",
            additional_kwargs={_VIEW_IMAGE_SOURCES_KEY: sources},
        )

        logger.info(
            "[ViewImageMiddleware] INJECT ok staged=%s pixels=%s failed=%s refs=%s",
            staged_n,
            pixel_n,
            len(failed_refs),
            list(viewed_images.keys())[:5],
        )

        update: dict = {"messages": [human_msg], "viewed_images": {}}
        # Only mark refs whose pixels actually entered the inject message.
        if delivered_refs:
            update["native_viewed_image_refs"] = list(delivered_refs)
        return update

    def _reload_source(self, source: dict[str, Any]) -> tuple[bytes, str] | None:
        image_data: ViewedImageData = {
            "path": str(source.get("path") or source.get("ref") or ""),
            "mime_type": str(source.get("mime_type") or "application/octet-stream"),
            "is_remote": bool(source.get("is_remote")),
            "auto": bool(source.get("auto")),
            "label": str(source.get("label") or ""),
        }
        return self._load_staged_image_bytes(str(source.get("ref") or image_data["path"]), image_data)

    def _rebuild_inject_with_pixels(self, msg: HumanMessage) -> HumanMessage | None:
        """Rebuild inject content from ``view_image_sources`` when pixels were stripped."""
        kwargs = dict(getattr(msg, "additional_kwargs", None) or {})
        sources = kwargs.get(_VIEW_IMAGE_SOURCES_KEY)
        if not isinstance(sources, list) or not sources:
            return None

        content_blocks: list[str | dict] = []
        manual = [s for s in sources if isinstance(s, dict) and not s.get("auto")]
        auto = [s for s in sources if isinstance(s, dict) and s.get("auto")]
        if manual:
            content_blocks.append({"type": "text", "text": "Here are the images you've viewed:"})
        elif auto:
            content_blocks.append(
                {
                    "type": "text",
                    "text": "Here are the latest screen captures from your computer control actions:",
                }
            )
        else:
            return None

        delivered = 0
        for group, header in ((manual, None), (auto, "\nLatest screen captures:")):
            if header is not None and group:
                content_blocks.append({"type": "text", "text": header})
            for source in group:
                path_hint = str(source.get("path") or source.get("ref") or "")
                mime_type = str(source.get("mime_type") or "unknown")
                label = str(source.get("label") or "").strip()
                ref = str(source.get("ref") or path_hint)
                shown_ref = f"{ref} ({label})" if label else ref
                content_blocks.append(
                    {
                        "type": "text",
                        "text": f"\n- **{shown_ref}** ({mime_type})\n[Image attached at: {path_hint}]",
                    }
                )
                loaded = self._reload_source(source)
                if not loaded:
                    content_blocks.append(
                        {
                            "type": "text",
                            "text": (
                                f"[pixels_delivered=false] Failed to reload image bytes for {path_hint}."
                            ),
                        }
                    )
                    continue
                img_bytes, out_mime = loaded
                content_blocks.append(
                    {
                        "type": "image_url",
                        "image_url": {"url": bytes_to_data_url(img_bytes, out_mime)},
                    }
                )
                delivered += 1

        if delivered <= 0:
            return None
        return msg.model_copy(update={"content": content_blocks, "additional_kwargs": kwargs})

    def _reattach_pixels_on_request(self, request: ModelRequest) -> ModelRequest:
        """After compaction strip: restore data-URIs on view_image_inject if blanked."""
        messages = list(getattr(request, "messages", None) or [])
        if not messages:
            return request
        changed = False
        out: list[Any] = []
        for msg in messages:
            if not _is_view_image_inject(msg):
                out.append(msg)
                continue
            if _has_live_image_url(msg) and not _content_has_omitted_placeholder(msg):
                out.append(msg)
                continue
            rebuilt = self._rebuild_inject_with_pixels(msg)
            if rebuilt is None:
                out.append(msg)
                continue
            logger.info(
                "[ViewImageMiddleware] REATTACH pixels after strip/omit on view_image_inject"
            )
            out.append(rebuilt)
            changed = True
        if not changed:
            return request
        return request.override(messages=out)

    @override
    def before_model(self, state: ViewImageMiddlewareState, runtime: Runtime) -> dict | None:
        return self._inject_image_message(state, runtime)

    @override
    async def abefore_model(self, state: ViewImageMiddlewareState, runtime: Runtime) -> dict | None:
        return self._inject_image_message(state, runtime)

    @override
    def wrap_model_call(self, request: ModelRequest, handler) -> ModelCallResult:
        return handler(self._reattach_pixels_on_request(request))

    @override
    async def awrap_model_call(self, request: ModelRequest, handler) -> ModelCallResult:
        return await handler(self._reattach_pixels_on_request(request))
