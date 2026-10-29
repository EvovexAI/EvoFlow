"""Shared CLI logic for DashScope Wan and Kling — routes through media factory."""

from __future__ import annotations

import hashlib
import json
import re
import time
from pathlib import Path

from _bootstrap import ensure_evoflow_importable

ensure_evoflow_importable()

from evoflow.community.media_generation.async_jobs import poll_until_done, save_media_from_urls
from evoflow.community.media_generation.config_helpers import provider_unavailable_message
from evoflow.community.media_generation.providers import factory as media_factory
from evoflow.community.media_generation.schemas import error_response, success_response


def _normalize_provider(provider: str) -> str:
    p = str(provider or "").strip().lower()
    if p in ("dashscope", "wan"):
        return "wan"
    return p


def _path_for_display(p: str | None) -> str | None:
    s = str(p or "").strip()
    return s.replace("\\", "/") if s else None


def _unique_media_save_prefix(media_kind: str, task_id: str, *, url: str = "") -> str:
    tid = str(task_id or "").strip()
    if tid.startswith("immediate:"):
        url_key = (tid[len("immediate:") :] or url or "").strip()
        digest = hashlib.md5(url_key.encode("utf-8", errors="ignore")).hexdigest()[:10]
        ts = int(time.time() * 1000) % 1_000_000_000
        return f"media_{media_kind}_{ts}_{digest}"
    safe = re.sub(r"[^a-zA-Z0-9_-]", "_", tid)[:32] or "task"
    return f"media_{media_kind}_{safe}"


def resolve_outputs_dir(raw: str | None) -> Path:
    if raw and str(raw).strip():
        out = Path(str(raw).strip()).expanduser()
        if not out.is_absolute():
            out = (Path.cwd() / out).resolve()
        else:
            out = out.resolve()
    else:
        out = (Path.cwd() / "outputs").resolve()
    out.mkdir(parents=True, exist_ok=True)
    return out


def emit_json(payload: str) -> None:
    print(payload)


def _parse_reference_urls(raw: str | None) -> list[str] | None:
    if not raw or not str(raw).strip():
        return None
    s = str(raw).strip()
    if s.startswith("["):
        try:
            arr = json.loads(s)
            if isinstance(arr, list):
                return [str(x).strip() for x in arr if str(x).strip()]
        except json.JSONDecodeError:
            pass
    return [p.strip() for p in s.split(",") if p.strip()]


def _guard(provider: str, *, media_kind: str) -> str | None:
    prov = _normalize_provider(provider)
    if prov not in ("wan", "kling"):
        return error_response(f"Unknown provider {provider!r}. Use wan or kling.")
    err = provider_unavailable_message(prov, media_kind=media_kind)
    if err:
        return error_response(err, provider=prov)
    return None


def run_image_generate(
    *,
    provider: str,
    prompt: str,
    mode: str = "text2image",
    reference_image_urls: str | None = None,
    aspect_ratio: str = "16:9",
    model: str | None = None,
    max_wait_seconds: int = 300,
    output_dir: str | None = None,
) -> str:
    blocked = _guard(provider, media_kind="image")
    if blocked:
        return blocked
    prov = _normalize_provider(provider)
    refs = _parse_reference_urls(reference_image_urls)
    if mode == "image2image" and not refs:
        return error_response("image2image requires --reference-image-urls", provider=prov)

    try:
        task_id = media_factory.submit_image(
            provider=prov,
            prompt=prompt,
            mode=mode,
            reference_image_urls=refs,
            aspect_ratio=aspect_ratio,
            model=model,
        )
    except Exception as e:
        return error_response(str(e), provider=prov)

    def _poll():
        return media_factory.poll_image(prov, task_id)

    try:
        status, _primary, urls = poll_until_done(_poll, max_wait_seconds=max_wait_seconds)
    except Exception as e:
        return error_response(str(e), provider=prov, task_id=task_id)

    if status.lower() in ("failed", "error", "cancelled") and not urls:
        return error_response(
            f"Image task ended with status={status}",
            provider=prov,
            task_id=task_id,
            status=status,
        )

    outputs_dir = resolve_outputs_dir(output_dir)
    local_paths: list[str] = []
    if urls:
        prefix = _unique_media_save_prefix("image", task_id, url=urls[0])
        local_paths = save_media_from_urls(urls, outputs_dir, prefix=prefix, media_kind="image")

    absolute = _path_for_display(local_paths[0] if local_paths else None)
    frame_url = urls[0] if urls else None
    extra: dict = {}
    if model:
        extra["model"] = model
    return success_response(
        provider=prov,
        task_id=task_id,
        status=status,
        url=frame_url,
        urls=urls,
        local_path=f"outputs/{Path(absolute).name}" if absolute else None,
        absolute_path=absolute,
        first_frame_url=frame_url,
        message="Image generated successfully." if absolute else "Image generation finished.",
        next_action="For image2video pass `url` from this JSON as --first-frame-url.",
        extra=extra,
    )


def run_video_generate(
    *,
    provider: str,
    prompt: str,
    mode: str = "image2video",
    first_frame_url: str | None = None,
    last_frame_url: str | None = None,
    audio_url: str | None = None,
    duration: int = 5,
    resolution: str = "720p",
    aspect_ratio: str = "16:9",
    model: str | None = None,
    output_dir: str | None = None,
    max_wait_seconds: int = 600,
    poll: bool = False,
) -> str:
    blocked = _guard(provider, media_kind="video")
    if blocked:
        return blocked
    prov = _normalize_provider(provider)

    effective_mode = mode
    if first_frame_url and mode != "image2video":
        effective_mode = "image2video"
    if effective_mode == "image2video" and not first_frame_url:
        return error_response("image2video requires --first-frame-url", provider=prov)

    try:
        task_id = media_factory.submit_video(
            provider=prov,
            prompt=prompt,
            mode=effective_mode,
            first_frame_url=first_frame_url,
            last_frame_url=last_frame_url,
            audio_url=audio_url,
            duration=duration,
            resolution=resolution,
            aspect_ratio=aspect_ratio,
            model=model,
        )
    except Exception as e:
        return error_response(str(e), provider=prov)

    if not poll:
        script = (
            "skills/public/wan-media-generation/scripts/wan_api.py"
            if prov == "wan"
            else "skills/public/kling-media-generation/scripts/kling_api.py"
        )
        extra: dict = {}
        if model:
            extra["model"] = model
        return success_response(
            provider=prov,
            task_id=task_id,
            status="processing",
            message="Video task submitted (may take several minutes).",
            next_action=(
                f"python {script} task-get --task-id {task_id!r} "
                f"--media-kind video --max-wait-seconds {max_wait_seconds} --output-dir outputs"
            ),
            extra=extra,
        )

    return run_task_wait(
        provider=prov,
        task_id=task_id,
        media_kind="video",
        max_wait_seconds=max_wait_seconds,
        output_dir=output_dir,
    )


def run_task_wait(
    *,
    provider: str,
    task_id: str,
    media_kind: str = "video",
    max_wait_seconds: int = 600,
    output_dir: str | None = None,
) -> str:
    kind = "image" if media_kind == "image" else "video"
    blocked = _guard(provider, media_kind=kind)
    if blocked:
        return blocked
    prov = _normalize_provider(provider)

    def _poll():
        if kind == "image":
            return media_factory.poll_image(prov, task_id)
        return media_factory.poll_video(prov, task_id)

    try:
        status, _primary, urls = poll_until_done(_poll, max_wait_seconds=max_wait_seconds)
    except Exception as e:
        return error_response(str(e), provider=prov, task_id=task_id)

    if status.lower() in ("failed", "error", "cancelled") and not urls:
        return error_response(
            f"Task ended with status={status}",
            provider=prov,
            task_id=task_id,
            status=status,
        )

    outputs_dir = resolve_outputs_dir(output_dir)
    local_paths: list[str] = []
    if urls:
        prefix = _unique_media_save_prefix(kind, task_id, url=urls[0])
        local_paths = save_media_from_urls(urls, outputs_dir, prefix=prefix, media_kind=kind)

    ap = _path_for_display(local_paths[0] if local_paths else None)
    msg = f"Saved: {ap}" if ap else ("Task finished." if urls else f"Task status={status}; no download URL yet.")
    return success_response(
        provider=prov,
        task_id=task_id,
        status=status,
        url=urls[0] if urls else None,
        urls=urls,
        local_path=f"outputs/{Path(ap).name}" if ap else None,
        absolute_path=ap,
        message=msg,
        next_action=(
            "Cite local_path from this result as Markdown `[name](path)` or a short backtick path "
            "(workspace-relative; zcode artifact_display)."
            if ap
            else "Retry task-get or check vendor console."
        ),
        extra={"local_paths": local_paths},
    )
