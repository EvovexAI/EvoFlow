"""Media provider contracts — every channel implements the same submit/poll surface."""

from __future__ import annotations

from typing import Any, Protocol, runtime_checkable


@runtime_checkable
class ImageBackend(Protocol):
    def submit_image(
        self,
        *,
        prompt: str,
        mode: str = "text2image",
        reference_image_urls: list[str] | None = None,
        size: str | None = None,
        aspect_ratio: str = "16:9",
        model: str | None = None,
    ) -> str:
        """Return task_id or ``immediate:{url}``."""
        ...

    def poll_image(self, task_id: str) -> tuple[str, str | None, list[str]]:
        """Return (status, primary_url, all_urls)."""
        ...


@runtime_checkable
class VideoBackend(Protocol):
    def submit_video(
        self,
        *,
        prompt: str,
        mode: str = "image2video",
        first_frame_url: str | None = None,
        last_frame_url: str | None = None,
        audio_url: str | None = None,
        duration: int = 5,
        resolution: str = "720p",
        aspect_ratio: str = "16:9",
        model: str | None = None,
        generate_audio: bool | None = None,
        watermark: bool | None = None,
        seed: int | None = None,
    ) -> str:
        """Return task_id or ``immediate:{url}``."""
        ...

    def poll_video(self, task_id: str) -> tuple[str, str | None, list[str]]:
        ...


def is_immediate_task(task_id: str) -> bool:
    return str(task_id or "").startswith("immediate:")


def unwrap_immediate(task_id: str) -> str:
    return task_id[len("immediate:") :] if is_immediate_task(task_id) else task_id


def catalog_model(
    *,
    id: str,
    label: str,
    provider: str,
    capability: str,
    use_when: str = "",
    min_tier: str | None = None,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    row: dict[str, Any] = {
        "id": id,
        "label": label,
        "provider": provider,
        "capability": capability,
        "min_tier": min_tier,
        "use_when": use_when,
    }
    if extra:
        row.update(extra)
    return row
