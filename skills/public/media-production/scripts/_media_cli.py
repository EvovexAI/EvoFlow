"""Shared CLI logic for media-production skill scripts (Volcengine Ark Seedream / Seedance)."""

from __future__ import annotations

import hashlib
import json
import re
import time
from pathlib import Path

from _bootstrap import ensure_evoflow_importable

ensure_evoflow_importable()

from evoflow.community.media_generation.async_jobs import poll_until_done, save_media_from_urls
from evoflow.community.media_generation.config_helpers import resolve_image_provider, resolve_video_provider
from evoflow.community.media_generation.providers import jimeng as jimeng_provider
from evoflow.community.media_generation.schemas import error_response, success_response
from evoflow.community.media_generation.subtitle_utils import (
    audio_duration_seconds,
    build_srt_from_text,
    build_vtt_from_srt,
    whisper_transcribe_srt,
)

_MAX_IMAGE_PROMPT_CHARS = 500
_MEDIA_API_RETRY_ATTEMPTS = 3


def _is_retriable_media_error(exc: BaseException) -> bool:
    msg = str(exc).lower()
    if any(code in msg for code in ("429", "500", "502", "503", "504")):
        return True
    if "rate limit" in msg or "timeout" in msg or "timed out" in msg:
        return True
    if "connection reset" in msg or "temporarily unavailable" in msg:
        return True
    return False


def _call_with_media_retry(fn, *, label: str = "media"):
    delay = 2.0
    last_exc: BaseException | None = None
    for attempt in range(_MEDIA_API_RETRY_ATTEMPTS):
        try:
            return fn()
        except Exception as exc:
            last_exc = exc
            if attempt + 1 >= _MEDIA_API_RETRY_ATTEMPTS or not _is_retriable_media_error(exc):
                raise
            time.sleep(delay)
            delay = min(delay * 2.0, 30.0)
    if last_exc is not None:
        raise last_exc
    raise RuntimeError(f"{label} retry loop exited without result")


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


def _prepare_image_prompt(prompt: str) -> tuple[str, str | None]:
    text = re.sub(r"\s+", " ", str(prompt or "").strip())
    orig_len = len(text)
    if orig_len <= _MAX_IMAGE_PROMPT_CHARS:
        return text, None
    fitted = text
    for punct in ("。", "！", "？", ".", "!", "?", "；", ";", "，", ","):
        idx = fitted.rfind(punct, 0, _MAX_IMAGE_PROMPT_CHARS)
        if idx >= _MAX_IMAGE_PROMPT_CHARS // 4:
            fitted = fitted[: idx + 1].strip()
            break
    else:
        fitted = fitted[: _MAX_IMAGE_PROMPT_CHARS - 1].rstrip() + "…"
    note = f"prompt trimmed from {orig_len} to {len(fitted)} chars (max {_MAX_IMAGE_PROMPT_CHARS})."
    return fitted, note


def _validate_image_prompt(prompt: str) -> str | None:
    if not str(prompt or "").strip():
        return "Image prompt is empty."
    return None


def _submit_image_jimeng(**kwargs) -> str:
    from evoflow.community.media_generation.aspect_ratio import (
        jimeng_image_size,
        jimeng_image_size_for_quality,
    )

    aspect_ratio = kwargs.get("aspect_ratio") or "16:9"
    quality = kwargs.get("quality") or kwargs.get("output_quality")
    if quality:
        size = jimeng_image_size_for_quality(aspect_ratio, str(quality))
    else:
        size = kwargs.get("size") or jimeng_image_size(aspect_ratio)
    return jimeng_provider.submit_image(
        prompt=kwargs["prompt"],
        mode=kwargs.get("mode") or "text2image",
        reference_image_urls=kwargs.get("reference_image_urls"),
        size=size,
        aspect_ratio=aspect_ratio,
    )


def _poll_image_jimeng(task_id: str):
    return jimeng_provider.poll_image(task_id)


def _submit_video_jimeng(**kwargs) -> str:
    from evoflow.community.media_generation.aspect_ratio import jimeng_video_resolution_for_quality

    quality = kwargs.get("quality") or kwargs.get("output_quality")
    resolution = kwargs.get("resolution")
    if not resolution and quality:
        resolution = jimeng_video_resolution_for_quality(str(quality))
    return jimeng_provider.submit_video(
        prompt=kwargs["prompt"],
        mode=kwargs.get("mode") or "image2video",
        first_frame_url=kwargs.get("first_frame_url"),
        duration=int(kwargs.get("duration") or 5),
        aspect_ratio=kwargs.get("aspect_ratio") or "16:9",
        generate_audio=kwargs.get("generate_audio"),
        resolution=str(resolution or "1080p"),
    )


def _poll_video_jimeng(task_id: str):
    return jimeng_provider.poll_video(task_id)


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


def run_image_generate(
    *,
    prompt: str,
    mode: str = "text2image",
    provider: str | None = None,
    reference_image_urls: str | None = None,
    aspect_ratio: str = "16:9",
    size: str | None = None,
    quality: str | None = None,
    max_wait_seconds: int = 300,
    output_dir: str | None = None,
) -> str:
    prov, err = resolve_image_provider(provider)
    if err:
        return error_response(err, provider=prov)
    if prov != "jimeng":
        return error_response(
            "media-production skill scripts currently support provider=jimeng only.",
            provider=prov,
        )
    prompt_err = _validate_image_prompt(prompt)
    if prompt_err:
        return error_response(prompt_err, provider=prov)
    prompt_fitted, trim_note = _prepare_image_prompt(prompt)
    refs = _parse_reference_urls(reference_image_urls)
    if mode == "image2image" and not refs:
        return error_response("image2image requires --reference-image-urls")

    try:
        task_id = _call_with_media_retry(
            lambda: _submit_image_jimeng(
                prompt=prompt_fitted,
                mode=mode,
                reference_image_urls=refs,
                aspect_ratio=aspect_ratio,
                size=size,
                quality=quality,
            ),
            label="image_submit",
        )
    except Exception as e:
        return error_response(str(e), provider=prov)

    if task_id.startswith("immediate:"):
        url = task_id[len("immediate:") :]
        urls = [url]
        status = "succeeded"
    else:

        def _poll():
            return _poll_image_jimeng(task_id)

        try:
            status, _primary, urls = _call_with_media_retry(
                lambda: poll_until_done(_poll, max_wait_seconds=max_wait_seconds),
                label="image_poll",
            )
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
    msg = "Image generated successfully." if absolute else "Image generation finished."
    if trim_note:
        msg = f"{msg} ({trim_note})"
    data = success_response(
        provider=prov,
        task_id=task_id if not task_id.startswith("immediate:") else None,
        status=status,
        url=frame_url,
        urls=urls,
        local_path=f"outputs/{Path(absolute).name}" if absolute else None,
        absolute_path=absolute,
        first_frame_url=frame_url,
        message=msg,
        next_action="For image2video pass `url` from this JSON as --first-frame-url.",
    )
    if trim_note:
        obj = json.loads(data)
        obj["prompt_trimmed"] = True
        obj["prompt_trim_note"] = trim_note
        return json.dumps(obj, ensure_ascii=False, indent=2)
    return data


def _resolve_first_frame_url(raw: str | None, *, outputs_dir: Path) -> tuple[str | None, str | None]:
    """Resolve http(s) URL or local outputs path to a Seedance-compatible first frame."""
    import base64

    s = str(raw or "").strip().strip('"').strip("'")
    if not s:
        return None, None
    if s.startswith(("http://", "https://", "oss://", "data:")):
        return s, None

    rel = s.replace("\\", "/")
    if rel.startswith("outputs/"):
        rel = rel[len("outputs/") :]
    candidates = [Path(s), outputs_dir / rel, outputs_dir / Path(rel).name]
    local: Path | None = None
    for cand in candidates:
        try:
            if cand.is_file():
                local = cand.resolve()
                break
        except OSError:
            continue
    if local is None:
        raise ValueError(
            f"Could not resolve first frame {s!r}. Use `url` from image_generate JSON, "
            "or a file under outputs/."
        )
    suffix = local.suffix.lower()
    mime = "image/png" if suffix == ".png" else "image/jpeg"
    if suffix == ".webp":
        mime = "image/webp"
    b64 = base64.b64encode(local.read_bytes()).decode("ascii")
    return f"data:{mime};base64,{b64}", f"Encoded local image as data URL ({local.name})."


def run_video_generate(
    *,
    prompt: str,
    mode: str = "image2video",
    provider: str | None = None,
    first_frame_url: str | None = None,
    duration: int = 5,
    aspect_ratio: str = "16:9",
    resolution: str | None = None,
    quality: str | None = None,
    generate_audio: bool | None = None,
    output_dir: str | None = None,
) -> str:
    prov, err = resolve_video_provider(provider)
    if err:
        return error_response(err, provider=prov)
    if prov != "jimeng":
        return error_response(
            "media-production skill scripts currently support provider=jimeng only.",
            provider=prov,
        )
    outputs_dir = resolve_outputs_dir(output_dir)
    resolve_notes: list[str] = []
    resolved_first = first_frame_url

    try:
        if first_frame_url:
            resolved_first, note = _resolve_first_frame_url(first_frame_url, outputs_dir=outputs_dir)
            if note:
                resolve_notes.append(note)
    except ValueError as e:
        return error_response(str(e), provider=prov)

    effective_mode = mode
    if resolved_first and mode != "image2video":
        effective_mode = "image2video"
        resolve_notes.append("Auto-set mode=image2video because first_frame_url was provided.")

    if effective_mode == "image2video" and not resolved_first:
        return error_response("image2video requires --first-frame-url")

    if effective_mode == "text2video" and not resolved_first:
        return error_response(
            "Use image_generate.py first, then video_generate.py with --first-frame-url.",
            provider=prov,
        )

    try:
        task_id = _call_with_media_retry(
            lambda: _submit_video_jimeng(
                prompt=prompt,
                mode=effective_mode,
                first_frame_url=resolved_first,
                duration=duration,
                aspect_ratio=aspect_ratio,
                resolution=resolution,
                quality=quality,
                generate_audio=generate_audio,
            ),
            label="video_submit",
        )
    except Exception as e:
        return error_response(str(e), provider=prov)

    msg = "Video task submitted (may take several minutes)."
    if resolve_notes:
        msg += " " + " ".join(resolve_notes)
    script = "skills/public/media-production/scripts/task_wait.py"
    return success_response(
        provider=prov,
        task_id=task_id,
        status="processing",
        message=msg,
        next_action=(
            f"python {script} --task-id {task_id!r} --provider jimeng "
            f"--media-kind video --max-wait-seconds 600 --output-dir outputs"
        ),
        extra={"resolve_notes": resolve_notes, "first_frame_url": resolved_first},
    )


def run_task_wait(
    *,
    task_id: str,
    provider: str,
    media_kind: str = "video",
    max_wait_seconds: int = 600,
    output_dir: str | None = None,
) -> str:
    if provider != "jimeng":
        return error_response(
            "media-production skill scripts currently support provider=jimeng only.",
            provider=provider,
        )
    if task_id.startswith("immediate:"):
        url = task_id[len("immediate:") :]
        urls = [url]
        status = "succeeded"
    else:

        def _poll():
            if media_kind == "image":
                return _poll_image_jimeng(task_id)
            return _poll_video_jimeng(task_id)

        try:
            status, _primary, urls = _call_with_media_retry(
                lambda: poll_until_done(_poll, max_wait_seconds=max_wait_seconds),
                label="task_wait_poll",
            )
        except Exception as e:
            return error_response(str(e), provider=provider, task_id=task_id)

        if status.lower() in ("failed", "error", "cancelled") and not urls:
            return error_response(
                f"Task ended with status={status}",
                provider=provider,
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
        provider=provider,
        task_id=task_id,
        status=status,
        url=urls[0] if urls else None,
        urls=urls,
        local_path=f"outputs/{Path(ap).name}" if ap else None,
        absolute_path=ap,
        message=msg,
        next_action="Share @@outputs/…@@ in reply." if ap else "Retry task_wait or check Ark console.",
        extra={"local_paths": local_paths},
    )


def run_subtitle_build(
    *,
    text: str,
    audio_path: str | None = None,
    subtitle_format: str = "srt",
    locale: str = "zh",
    output_filename: str = "subtitles.srt",
    output_dir: str | None = None,
) -> str:
    outputs_dir = resolve_outputs_dir(output_dir)
    duration = 0.0
    audio_file: Path | None = None
    if audio_path:
        rel = audio_path.strip().replace("\\", "/")
        if rel.startswith("outputs/"):
            rel = rel[len("outputs/") :]
        audio_file = outputs_dir / rel
        if audio_file.is_file():
            duration = audio_duration_seconds(audio_file)

    safe_name = re.sub(r"[^\w.\-]", "_", output_filename) or "subtitles.srt"
    if subtitle_format == "vtt" and not safe_name.endswith(".vtt"):
        safe_name = Path(safe_name).stem + ".vtt"
    elif subtitle_format == "srt" and not safe_name.endswith(".srt"):
        safe_name = Path(safe_name).stem + ".srt"

    dest = outputs_dir / safe_name
    try:
        if audio_file and audio_file.is_file():
            srt_text = whisper_transcribe_srt(audio_file, locale=locale)
            if not srt_text.strip():
                srt_text = build_srt_from_text(text, duration or 30.0)
        else:
            srt_text = build_srt_from_text(text, duration or max(30.0, len(text) / 4.0))
    except Exception as e:
        return error_response(f"Subtitle build failed: {e}")

    if subtitle_format == "vtt":
        content = build_vtt_from_srt(srt_text)
    else:
        content = srt_text
    dest.write_text(content, encoding="utf-8")
    ap = _path_for_display(str(dest.resolve()))
    return success_response(
        status="succeeded",
        local_path=f"outputs/{safe_name}",
        absolute_path=ap,
        message=f"Subtitle saved: outputs/{safe_name}",
        next_action=(
            "python skills/public/media-production/scripts/subtitle_burn.py "
            f"--video-path <mp4> --subtitle-path outputs/{safe_name}"
        ),
    )


def run_subtitle_burn(
    *,
    video_path: str,
    subtitle_path: str,
    output_filename: str | None = None,
    output_dir: str | None = None,
) -> str:
    import shutil
    import subprocess

    outputs_dir = resolve_outputs_dir(output_dir)
    if not shutil.which("ffmpeg"):
        return error_response("ffmpeg not found in PATH.")

    def _resolve_media(rel_or_abs: str) -> Path:
        s = rel_or_abs.strip().replace("\\", "/")
        if s.startswith("outputs/"):
            p = outputs_dir / s[len("outputs/") :]
        else:
            p = Path(s)
            if not p.is_absolute():
                p = outputs_dir / p.name
        if not p.is_file():
            raise FileNotFoundError(f"File not found: {rel_or_abs}")
        return p.resolve()

    try:
        video = _resolve_media(video_path)
        subs = _resolve_media(subtitle_path)
    except FileNotFoundError as e:
        return error_response(str(e))

    out_name = output_filename or f"{video.stem}-subtitled.mp4"
    out_name = re.sub(r"[^\w.\-]", "_", out_name)
    if not out_name.endswith(".mp4"):
        out_name += ".mp4"
    dest = outputs_dir / out_name

    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        str(video),
        "-vf",
        f"subtitles={subs.as_posix()}",
        "-c:a",
        "copy",
        str(dest),
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True, text=True, timeout=600)
    except subprocess.CalledProcessError as e:
        return error_response(f"ffmpeg failed: {(e.stderr or e.stdout or str(e))[:500]}")
    except Exception as e:
        return error_response(str(e))

    ap = _path_for_display(str(dest.resolve()))
    return success_response(
        status="succeeded",
        local_path=f"outputs/{out_name}",
        absolute_path=ap,
        message=f"Subtitled video saved: outputs/{out_name}",
    )


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
