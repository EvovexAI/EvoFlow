"""Middleware for injecting image details into conversation before LLM call."""

import logging

try:
    from typing import NotRequired, override
except ImportError:
    from typing import NotRequired, override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.runtime import Runtime

from evoflow.agents.thread_state import ViewedImageData
from evoflow.tools.builtins.vision_analysis_core import (
    bytes_to_data_url,
    is_http_image_ref,
    load_image_bytes_for_native,
    main_model_supports_vision,
    prepare_image_bytes_for_native,
)

logger = logging.getLogger(__name__)


class ViewImageMiddlewareState(AgentState):
    """Compatible with the `ThreadState` schema."""

    viewed_images: NotRequired[dict[str, ViewedImageData] | None]


class ViewImageMiddleware(AgentMiddleware[ViewImageMiddlewareState]):
    """Inject staged ``view_image`` paths as ephemeral multimodal blocks before LLM calls.

    Storage model (checkpoint-safe):
    - ``viewed_images`` holds **paths + mime only** (no base64 in graph state)
    - Bytes are read + resized here; base64 exists only in the injected ``HumanMessage``
    - ``context_compaction`` strips image blocks at model-call time (not in checkpoint long-term)
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
        return any(tool_call.get("name") == "view_image" for tool_call in message.tool_calls)

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
        return prepare_image_bytes_for_native(raw_bytes, detected_mime or mime)

    def _create_image_details_message(self, state: ViewImageMiddlewareState) -> list[str | dict]:
        viewed_images = state.get("viewed_images", {})
        if not viewed_images:
            return [{"type": "text", "text": "No images have been viewed."}]

        content_blocks: list[str | dict] = [
            {"type": "text", "text": "Here are the images you've viewed:"},
        ]

        for image_ref, image_data in viewed_images.items():
            mime_type = str(image_data.get("mime_type") or "unknown")
            path_hint = str(image_data.get("path") or image_ref)
            content_blocks.append(
                {
                    "type": "text",
                    "text": f"\n- **{image_ref}** ({mime_type})\n[Image attached at: {path_hint}]",
                }
            )

            loaded = self._load_staged_image_bytes(image_ref, image_data)
            if not loaded:
                continue
            img_bytes, out_mime = loaded
            content_blocks.append(
                {
                    "type": "image_url",
                    "image_url": {"url": bytes_to_data_url(img_bytes, out_mime)},
                }
            )

        return content_blocks

    def _should_inject_image_message(self, state: ViewImageMiddlewareState) -> bool:
        messages = state.get("messages", [])
        if not messages:
            return False

        last_assistant_msg = self._get_last_assistant_message(messages)
        if not last_assistant_msg:
            return False

        if not self._has_view_image_tool(last_assistant_msg):
            return False

        if not self._all_tools_completed(messages, last_assistant_msg):
            return False

        assistant_idx = messages.index(last_assistant_msg)
        for msg in messages[assistant_idx + 1 :]:
            if isinstance(msg, HumanMessage):
                content_str = str(msg.content)
                if "Here are the images you've viewed" in content_str or "Here are the details of the images you've viewed" in content_str:
                    return False

        return True

    def _inject_image_message(self, state: ViewImageMiddlewareState, runtime: Runtime) -> dict | None:
        if not main_model_supports_vision(runtime):
            viewed_images = state.get("viewed_images", {})
            if viewed_images:
                logger.debug("Skipping image injection — main model does not support vision")
                return {"viewed_images": {}}
            return None

        if not self._should_inject_image_message(state):
            return None

        image_content = self._create_image_details_message(state)
        human_msg = HumanMessage(content=image_content)

        logger.debug("Injecting staged view_image paths as ephemeral multimodal blocks")

        return {"messages": [human_msg], "viewed_images": {}}

    @override
    def before_model(self, state: ViewImageMiddlewareState, runtime: Runtime) -> dict | None:
        return self._inject_image_message(state, runtime)

    @override
    async def abefore_model(self, state: ViewImageMiddlewareState, runtime: Runtime) -> dict | None:
        return self._inject_image_message(state, runtime)
