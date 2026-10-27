"""Unified media provider factory — single dispatch surface for tools/platform_media.

Adapters normalize kwargs (model vs model_name, size vs aspect_ratio) so callers
never branch on provider-specific signatures.
"""

from __future__ import annotations

import logging
from typing import Any

from evoflow.community.media_generation.aspect_ratio import jimeng_image_size, wan_image_size

logger = logging.getLogger(__name__)

IMAGE_PROVIDERS = frozenset({"jimeng", "wan", "kling", "openai"})
VIDEO_PROVIDERS = frozenset({"jimeng", "wan", "kling", "minimax"})


def _guard(provider: str, *, media_kind: str) -> None:
    from evoflow.community.media_generation.config_helpers import provider_unavailable_message

    err = provider_unavailable_message(provider, media_kind=media_kind)
    if err:
        raise ValueError(err)


def _image_size(provider: str, aspect_ratio: str) -> str:
    if provider == "wan":
        return wan_image_size(aspect_ratio)
    return jimeng_image_size(aspect_ratio)


def submit_image(
    provider: str,
    *,
    prompt: str,
    mode: str = "text2image",
    reference_image_urls: list[str] | None = None,
    aspect_ratio: str = "16:9",
    model: str | None = None,
    size: str | None = None,
) -> str:
    """Route image generation to the matching backend."""
    p = str(provider or "").strip()
    if p not in IMAGE_PROVIDERS:
        raise ValueError(f"未知生图渠道: {provider}（支持: {', '.join(sorted(IMAGE_PROVIDERS))}）")
    _guard(p, media_kind="image")

    if p == "kling":
        from evoflow.community.media_generation.providers import kling as kling_provider

        kwargs: dict[str, Any] = {
            "prompt": prompt,
            "mode": mode,
            "reference_image_urls": reference_image_urls,
            "aspect_ratio": aspect_ratio,
        }
        if model:
            kwargs["model_name"] = model
        return kling_provider.submit_image(**kwargs)

    if p == "openai":
        from evoflow.community.media_generation.providers import openai_images

        return openai_images.submit_image(
            prompt=prompt,
            mode=mode,
            reference_image_urls=reference_image_urls,
            size=size,
            aspect_ratio=aspect_ratio,
            model=model,
        )

    if p == "wan":
        from evoflow.community.media_generation.providers import dashscope_wan

        return dashscope_wan.submit_image(
            prompt=prompt,
            mode=mode,
            reference_image_urls=reference_image_urls,
            size=size or _image_size(p, aspect_ratio),
            aspect_ratio=aspect_ratio,
            model=model or "wan2.7-image",
        )

    from evoflow.community.media_generation.providers import jimeng as jimeng_provider

    kwargs = {
        "prompt": prompt,
        "mode": mode,
        "reference_image_urls": reference_image_urls,
        "size": size or _image_size(p, aspect_ratio),
    }
    if model:
        kwargs["model"] = model
    return jimeng_provider.submit_image(**kwargs)


def poll_image(provider: str, task_id: str) -> tuple[str, str | None, list[str]]:
    p = str(provider or "").strip()
    if p not in IMAGE_PROVIDERS:
        raise ValueError(f"未知生图渠道: {provider}")
    _guard(p, media_kind="image")

    if p == "kling":
        from evoflow.community.media_generation.providers import kling as kling_provider

        return kling_provider.poll_image(task_id)
    if p == "openai":
        from evoflow.community.media_generation.providers import openai_images

        return openai_images.poll_image(task_id)
    if p == "wan":
        from evoflow.community.media_generation.providers import dashscope_wan

        return dashscope_wan.poll_image(task_id)
    from evoflow.community.media_generation.providers import jimeng as jimeng_provider

    return jimeng_provider.poll_image(task_id)


def submit_video(
    provider: str,
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
    """Route video generation to the matching backend."""
    p = str(provider or "").strip()
    if p not in VIDEO_PROVIDERS:
        raise ValueError(f"未知生视频渠道: {provider}（支持: {', '.join(sorted(VIDEO_PROVIDERS))}）")
    _guard(p, media_kind="video")

    if p == "kling":
        from evoflow.community.media_generation.providers import kling as kling_provider

        kwargs: dict[str, Any] = {
            "prompt": prompt,
            "mode": mode,
            "first_frame_url": first_frame_url,
            "duration": duration,
            "aspect_ratio": aspect_ratio,
            "audio_url": audio_url,
        }
        if model:
            kwargs["model_name"] = model
        return kling_provider.submit_video(**kwargs)

    if p == "wan":
        from evoflow.community.media_generation.providers import dashscope_wan

        return dashscope_wan.submit_video(
            prompt=prompt,
            mode=mode,
            first_frame_url=first_frame_url,
            last_frame_url=last_frame_url,
            audio_url=audio_url,
            duration=duration,
            resolution=resolution,
            aspect_ratio=aspect_ratio,
            model=model,
            watermark=watermark,
            seed=seed,
        )

    if p == "minimax":
        from evoflow.community.media_generation.providers import minimax_video

        return minimax_video.submit_video(
            prompt=prompt,
            mode=mode,
            first_frame_url=first_frame_url,
            last_frame_url=last_frame_url,
            audio_url=audio_url,
            duration=duration,
            resolution=resolution,
            aspect_ratio=aspect_ratio,
            model=model,
            generate_audio=generate_audio,
            watermark=watermark,
            seed=seed,
        )

    from evoflow.community.media_generation.providers import jimeng as jimeng_provider

    kwargs = {
        "prompt": prompt,
        "mode": mode,
        "first_frame_url": first_frame_url,
        "last_frame_url": last_frame_url,
        "duration": duration,
        "resolution": resolution,
        "aspect_ratio": aspect_ratio,
        "generate_audio": generate_audio,
        "watermark": watermark,
        "seed": seed,
    }
    if model:
        kwargs["model"] = model
    return jimeng_provider.submit_video(**kwargs)


def poll_video(provider: str, task_id: str) -> tuple[str, str | None, list[str]]:
    p = str(provider or "").strip()
    if p not in VIDEO_PROVIDERS:
        raise ValueError(f"未知生视频渠道: {provider}")
    _guard(p, media_kind="video")

    if p == "kling":
        from evoflow.community.media_generation.providers import kling as kling_provider

        return kling_provider.poll_video(task_id)
    if p == "wan":
        from evoflow.community.media_generation.providers import dashscope_wan

        return dashscope_wan.poll_video(task_id)
    if p == "minimax":
        from evoflow.community.media_generation.providers import minimax_video

        return minimax_video.poll_video(task_id)
    from evoflow.community.media_generation.providers import jimeng as jimeng_provider

    return jimeng_provider.poll_video(task_id)
