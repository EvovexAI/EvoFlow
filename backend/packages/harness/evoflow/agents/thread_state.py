from typing import Annotated, Any

try:
    from typing import NotRequired, TypedDict
except ImportError:
    from typing import NotRequired

    from typing_extensions import TypedDict

from langchain.agents import AgentState


class SandboxState(TypedDict):
    sandbox_id: NotRequired[str | None]


class ThreadDataState(TypedDict):
    workspace_path: NotRequired[str | None]
    uploads_path: NotRequired[str | None]
    outputs_path: NotRequired[str | None]


class ViewedImageData(TypedDict):
    """Staging for ``ViewImageMiddleware`` — **path only**, no base64 in checkpoint."""

    path: str
    mime_type: str
    is_remote: NotRequired[bool]


def merge_artifacts(existing: list[str] | None, new: list[str] | None) -> list[str]:
    """Reducer for artifacts list - merges and deduplicates artifacts."""
    if existing is None:
        return new or []
    if new is None:
        return existing
    # Use dict.fromkeys to deduplicate while preserving order
    return list(dict.fromkeys(existing + new))


# Prefix on ``loaded_deferred_tools`` updates: full replace vs append (``tool_search``).
EVF_REPLACE_LOADED_DEFERRED_MARKER = "__EVF_REPLACE_LOADED_DEFERRED__"


def merge_loaded_deferred_tools(existing: list[str] | None, new: list[str] | None) -> list[str]:
    """Merge deferred tool names; ``scenario()`` sends a replace batch so old tools drop after deactivate."""
    if new is None:
        return list(dict.fromkeys(existing or []))
    if new and isinstance(new[0], str) and new[0] == EVF_REPLACE_LOADED_DEFERRED_MARKER:
        tail = [str(x or "").strip() for x in new[1:] if str(x or "").strip()]
        return list(dict.fromkeys(tail))
    return merge_artifacts(existing, new)


def merge_viewed_images(existing: dict[str, ViewedImageData] | None, new: dict[str, ViewedImageData] | None) -> dict[str, ViewedImageData]:
    """Reducer for viewed_images dict - merges image dictionaries.

    Special case: If new is an empty dict {}, it clears the existing images.
    This allows middlewares to clear the viewed_images state after processing.
    """
    if existing is None:
        return new or {}
    if new is None:
        return existing
    # Special case: empty dict means clear all viewed images
    if len(new) == 0:
        return {}
    # Merge dictionaries, new values override existing ones for same keys
    return {**existing, **new}


class ThreadState(AgentState):
    """AgentState plus EvoFlow thread fields.

    ``ui_messages`` holds a pre-summarization copy of the conversation for UI display
    when ``SummarizationMiddleware`` is enabled; ``messages`` is what the model sees.
    """

    sandbox: NotRequired[SandboxState | None]
    thread_data: NotRequired[ThreadDataState | None]
    title: NotRequired[str | None]
    ui_messages: NotRequired[list[Any] | None]
    artifacts: Annotated[list[str], merge_artifacts]
    todos: NotRequired[list | None]
    uploaded_files: NotRequired[list[dict] | None]
    viewed_images: Annotated[dict[str, ViewedImageData], merge_viewed_images]  # image_ref -> {path, mime_type}
    native_viewed_image_refs: Annotated[list[str], merge_artifacts]  # dedup: paths already staged this thread
    loaded_deferred_tools: Annotated[list[str], merge_loaded_deferred_tools]
