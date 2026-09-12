"""Shared CLI logic for DashScope Wan and Kling media providers."""

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
from evoflow.community.media_generation.providers import dashscope_wan, kling
from evoflow.community.media_generation.schemas import error_response, success_response

_PROVIDERS = {
    "wan": {
        "label": "dashscope",
        "submit_image": dashscope_wan.submit_image,
        "poll_image": dashscope_wan.poll_image,
        "submit_video": dashscope_wan.submit_video,
        "poll_video": dashscope_wan.poll_video,
    },
    "kling": {
        "label": "kling",
        "submit_image": kling.submit_image,
        "poll_image": kling.poll_image,
        "submit_video": kling.submit_video,
        "poll_video": kling.poll_video,
    },
}


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


def _provider_entry(provider: str) -> tuple[dict, str | None]:
    prov = provider.strip().lower()
    if prov in ("dashscope", "wan"):
        prov = "wan"
    if prov not in _PROVIDERS:
        return {}, error_response(f"Unknown provider {provider!r}. Use wan or kling.")
    err = provider_unavailable_message(prov, media_kind="image")
    if err:
        return {}, error_response(err, provider=prov)
    return _PROVIDERS[prov], None


def run_image_generate(
    *,
    provider: str,
    prompt: str,
    mode: str = "text2image",
    reference_image_urls: str | None = None,
    aspect_ratio: str = "16:9",
    max_wait_seconds: int = 300,
    output_dir: str | None = None,
) -> str:
    entry, err = _provider_entry(provider)
    if err:
        return err
    prov = "wan" if provider.strip().lower() in ("dashscope", "wan") else "kling"
    refs = _parse_reference_urls(reference_image_urls)
    if mode == "image2image" and not refs:
        return error_response("image2image requires --reference-image-urls", provider=prov)

    try:
        task_id = entry["submit_image"](
            prompt=prompt,
            mode=mode,
            reference_image_urls=refs,
            aspect_ratio=aspect_ratio,
        )
    except Exception as e:
        return error_response(str(e), provider=prov)

    def _poll():
        return entry["poll_image"](task_id)

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
    )


def run_video_generate(
    *,
    provider: str,
    prompt: str,
    mode: str = "image2video",
    first_frame_url: str | None = None,
    duration: int = 5,
    aspect_ratio: str = "16:9",
    output_dir: str | None = None,
    max_wait_seconds: int = 600,
    poll: bool = False,
) -> str:
    entry, err = _provider_entry(provider)
    if err:
        return err
    prov = "wan" if provider.strip().lower() in ("dashscope", "wan") else "kling"

    effective_mode = mode
    if first_frame_url and mode != "image2video":
        effective_mode = "image2video"
    if effective_mode == "image2video" and not first_frame_url:
        return error_response("image2video requires --first-frame-url", provider=prov)

    try:
        task_id = entry["submit_video"](
            prompt=prompt,
            mode=effective_mode,
            first_frame_url=first_frame_url,
            duration=duration,
            aspect_ratio=aspect_ratio,
        )
    except Exception as e:
        return error_response(str(e), provider=prov)

    if not poll:
        script = "skills/public/kling-media-generation/scripts/kling_api.py"
        return success_response(
            provider=prov,
            task_id=task_id,
            status="processing",
            message="Video task submitted (may take several minutes).",
            next_action=(
                f"python {script} task-get --task-id {task_id!r} "
                f"--media-kind video --max-wait-seconds {max_wait_seconds} --output-dir outputs"
            ),
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
    entry, err = _provider_entry(provider)
    if err:
        return err
    prov = "wan" if provider.strip().lower() in ("dashscope", "wan") else "kling"

    def _poll():
        if media_kind == "image":
            return entry["poll_image"](task_id)
        return entry["poll_video"](task_id)

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
        prefix = _unique_media_save_prefix(media_kind, task_id, url=urls[0])
        local_paths = save_media_from_urls(urls, outputs_dir, prefix=prefix, media_kind=media_kind)

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
        next_action="Share @@outputs/…@@ in reply." if ap else "Retry task-get or check vendor console.",
        extra={"local_paths": local_paths},
    )
