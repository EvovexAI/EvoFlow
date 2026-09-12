"""
Media generation tools — Volcengine Ark (jimeng), Kling, DashScope Wan.

Workflow hints for the agent (in docstrings):
1. media_image_generate (generate polls and saves in one call)
2. media_image_generate → media_video_generate (first_frame_url)
3. media_voiceover_synthesize → media_video_generate (audio_url) → media_subtitle_build → media_subtitle_burn
4. Images auto-preview in EvoPanel tool card; cite absolute @@/workspace/…@@ for other deliverables
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import shutil
import subprocess
import time
from pathlib import Path
from typing import Literal

from langchain.tools import ToolRuntime, tool
from langgraph.typing import ContextT

from evoflow.agents.thread_state import ThreadState
from evoflow.community.media_generation.aspect_ratio import jimeng_image_size, wan_image_size
from evoflow.community.media_generation.asset_recorder import (
    record_local_asset,
    record_task_completed,
    record_task_submitted,
)
from evoflow.community.media_generation.async_jobs import poll_until_done, save_media_from_urls
from evoflow.community.media_generation.config_helpers import (
    aliyun_credentials,
    provider_unavailable_message,
    resolve_image_provider,
    resolve_video_provider,
    resolve_voice_provider,
)
from evoflow.community.media_generation.media_url_resolver import resolve_media_reference_url
from evoflow.community.media_generation.providers import aliyun_vod, dashscope_tts, dashscope_wan, volcengine_tts
from evoflow.community.media_generation.providers import jimeng as jimeng_provider
from evoflow.community.media_generation.providers import kling as kling_provider
from evoflow.community.media_generation.schemas import error_response, success_response
from evoflow.community.media_generation.subtitle_utils import (
    audio_duration_seconds,
    build_srt_from_text,
    build_vtt_from_srt,
    whisper_transcribe_srt,
)
from evoflow.tools.host_direct.workspace_context import resolve_effective_outputs_dir

logger = logging.getLogger(__name__)

ImageProviderLit = Literal["jimeng", "kling", "wan"]
VideoProviderLit = Literal["jimeng", "kling", "wan"]
ImageModeLit = Literal["text2image", "image2image"]
VideoModeLit = Literal["text2video", "image2video"]
VoiceProviderLit = Literal["volcengine", "dashscope"]
SubtitleFormatLit = Literal["srt", "vtt"]
MediaKindLit = Literal["image", "video", "audio"]

_MAX_IMAGE_PROMPT_CHARS = 500


def _unique_media_save_prefix(media_kind: str, task_id: str, *, url: str = "") -> str:
    """Unique local filename prefix — immediate/sync responses must not all overwrite media_image_sync."""
    tid = str(task_id or "").strip()
    if tid.startswith("immediate:"):
        url_key = (tid[len("immediate:") :] or url or "").strip()
        digest = hashlib.md5(url_key.encode("utf-8", errors="ignore")).hexdigest()[:10]
        ts = int(time.time() * 1000) % 1_000_000_000
        return f"media_{media_kind}_{ts}_{digest}"
    safe = re.sub(r"[^a-zA-Z0-9_-]", "_", tid)[:32] or "task"
    return f"media_{media_kind}_{safe}"


def _resolve_outputs_dir(runtime: ToolRuntime[ContextT, ThreadState] | None) -> Path | None:
    return resolve_effective_outputs_dir(runtime=runtime)


def _image_size_for_provider(provider: str, aspect_ratio: str) -> str:
    if provider == "wan":
        return wan_image_size(aspect_ratio)
    return jimeng_image_size(aspect_ratio)


def _path_for_display(p: str | None) -> str | None:
    """Forward slashes for markdown / JSON display (Windows-safe for chat)."""
    s = str(p or "").strip()
    return s.replace("\\", "/") if s else None


def _media_image_reply_hint(absolute_path: str | None = None) -> str:
    base = (
        "EvoPanel already shows the image inline in the tool result card (click to zoom). "
        "In your reply: confirm success in one short sentence only — "
        "do NOT repeat `![...](path)` markdown, do NOT paste absolute_path again, "
        "do NOT call media_task_wait for images, and do NOT use bare http 'click to view' links."
    )
    return base


def _image_success_payload(
    *,
    provider: str,
    status: str,
    task_id: str | None,
    url: str | None,
    urls: list[str],
    absolute_path: str | None,
    message: str,
) -> str:
    ap = _path_for_display(absolute_path)
    frame_url = url or (urls[0] if urls else None)
    hint = _media_image_reply_hint(ap)
    if frame_url:
        hint += (
            " For image2video pass first_frame_url from this response (`url` / `first_frame_url`); "
            "local absolute_path is accepted and auto-resolved."
        )
    return success_response(
        provider=provider,
        task_id=task_id,
        status=status,
        url=url,
        urls=urls,
        local_path=ap,
        absolute_path=ap,
        first_frame_url=frame_url,
        message=message,
        next_action=hint,
    )


def _run_image_generate_and_wait(
    runtime: ToolRuntime[ContextT, ThreadState] | None,
    *,
    provider: str,
    prompt: str,
    mode: str,
    reference_image_urls: list[str] | None,
    aspect_ratio: str,
    max_wait_seconds: int,
) -> str:
    """Submit image job, poll until done, download to outputs — single tool round-trip."""
    try:
        task_id = _submit_image(
            provider,
            prompt=prompt,
            mode=mode,
            reference_image_urls=reference_image_urls,
            aspect_ratio=aspect_ratio,
        )
    except Exception as e:
        logger.exception("media_image_generate submit failed")
        return error_response(str(e), provider=provider)

    if task_id.startswith("immediate:"):
        url = task_id[len("immediate:") :]
        urls = [url]
        status = "succeeded"
    else:
        record_task_submitted(
            runtime,
            tool_name="media_image_generate",
            provider=provider,
            task_id=task_id,
            media_kind="image",
            meta={"mode": mode, "aspect_ratio": aspect_ratio},
        )

        def _poll():
            return _poll_image(provider, task_id)

        try:
            status, _primary, urls = poll_until_done(_poll, max_wait_seconds=max_wait_seconds)
        except Exception as e:
            return error_response(str(e), provider=provider, task_id=task_id)

        if status.lower() in ("failed", "error", "cancelled") and not urls:
            return error_response(
                f"Image task ended with status={status}",
                provider=provider,
                task_id=task_id,
                status=status,
            )

    outputs_dir = _resolve_outputs_dir(runtime)
    local_paths: list[str] = []
    if outputs_dir and urls:
        prefix = _unique_media_save_prefix("image", task_id, url=urls[0] if urls else "")
        local_paths = save_media_from_urls(urls, outputs_dir, prefix=prefix, media_kind="image")

    absolute = _path_for_display(local_paths[0] if local_paths else None)
    record_task_completed(
        runtime,
        tool_name="media_image_generate",
        provider=provider,
        task_id=task_id,
        media_kind="image",
        status=status,
        remote_url=urls[0] if urls else None,
        local_path=local_paths[0] if local_paths else None,
        outputs_dir=outputs_dir,
        meta={"urls": urls, "local_paths": local_paths, "absolute_path": absolute},
    )

    if not absolute and urls:
        return _image_success_payload(
            provider=provider,
            status=status,
            task_id=task_id if not task_id.startswith("immediate:") else None,
            url=urls[0],
            urls=urls,
            absolute_path=None,
            message="Image ready (remote URL only). Select a local workspace in EvoPanel to save under {root}/outputs/.",
        )

    msg = "Image generated successfully." if absolute else "Image generation finished."
    return _image_success_payload(
        provider=provider,
        status=status,
        task_id=task_id if not task_id.startswith("immediate:") else None,
        url=urls[0] if urls else None,
        urls=urls,
        absolute_path=absolute,
        message=msg,
    )


def _prepare_image_prompt(prompt: str) -> tuple[str, str | None]:
    """Normalize and fit a single still-frame prompt (max 500 chars). Returns (text, trim_note)."""
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

    if len(fitted) > _MAX_IMAGE_PROMPT_CHARS:
        fitted = fitted[: _MAX_IMAGE_PROMPT_CHARS - 1].rstrip() + "…"

    note = (
        f"prompt 已从 {orig_len} 字压缩至 {len(fitted)} 字（单帧上限 {_MAX_IMAGE_PROMPT_CHARS}）。"
        "下次请直接写：主体 + 环境 + 光线 + 构图，2–4 句即可；多分镜视频请每镜单独 media_image_generate，"
        "勿把整段故事板塞进一条 prompt。"
    )
    return fitted, note


def _validate_image_prompt(prompt: str) -> str | None:
    """Return error when prompt empty (length is auto-fitted via _prepare_image_prompt)."""
    text = str(prompt or "").strip()
    if not text:
        return (
            "Image prompt is empty. Describe one still frame: subject + environment + "
            "lighting + composition (max 500 chars / ~2–4 sentences)."
        )
    return None


def _parse_reference_urls(reference_image_urls: str | None) -> list[str] | None:
    if not reference_image_urls:
        return None
    ref = reference_image_urls.strip()
    if ref.startswith("["):
        try:
            parsed = json.loads(ref)
            if isinstance(parsed, list):
                return [str(x) for x in parsed if x]
        except json.JSONDecodeError:
            pass
    return [u.strip() for u in ref.split(",") if u.strip()]


def _guard_media_provider(provider: str, *, media_kind: str) -> None:
    from .config_helpers import provider_unavailable_message

    err = provider_unavailable_message(provider, media_kind=media_kind)
    if err:
        raise ValueError(err)


def _submit_image(provider: str, **kwargs) -> str:
    _guard_media_provider(provider, media_kind="image")
    aspect_ratio = kwargs.pop("aspect_ratio", "16:9")
    if provider == "kling":
        kwargs["aspect_ratio"] = aspect_ratio
        return kling_provider.submit_image(**kwargs)
    kwargs["size"] = _image_size_for_provider(provider, aspect_ratio)
    if provider == "wan":
        return dashscope_wan.submit_image(**kwargs)
    return jimeng_provider.submit_image(**kwargs)


def _poll_image(provider: str, task_id: str):
    _guard_media_provider(provider, media_kind="image")
    if provider == "kling":
        return kling_provider.poll_image(task_id)
    if provider == "wan":
        return dashscope_wan.poll_image(task_id)
    return jimeng_provider.poll_image(task_id)


def _submit_video(provider: str, **kwargs) -> str:
    _guard_media_provider(provider, media_kind="video")
    if provider == "kling":
        kwargs.pop("generate_audio", None)
        return kling_provider.submit_video(**kwargs)
    if provider == "wan":
        kwargs.pop("generate_audio", None)
        return dashscope_wan.submit_video(**kwargs)
    kwargs.pop("audio_url", None)
    return jimeng_provider.submit_video(**kwargs)


def _poll_video(provider: str, task_id: str):
    _guard_media_provider(provider, media_kind="video")
    if provider == "kling":
        return kling_provider.poll_video(task_id)
    if provider == "wan":
        return dashscope_wan.poll_video(task_id)
    return jimeng_provider.poll_video(task_id)


@tool("media_image_generate", parse_docstring=True)
def media_image_generate_tool(
    runtime: ToolRuntime[ContextT, ThreadState],
    prompt: str,
    mode: ImageModeLit = "text2image",
    provider: ImageProviderLit | None = None,
    reference_image_urls: str | None = None,
    aspect_ratio: str = "16:9",
    max_wait_seconds: int = 300,
) -> str:
    """Generate an image with Volcengine Seedream (default), Kling, or DashScope Wan.

    This tool submits the job, polls until complete, and downloads to the session
    ``outputs/`` directory in **one call** — do not call ``media_task_wait`` for images.

    **EvoPanel UX**: the client renders the saved image **inline in the tool result card**
    (click to zoom). After this tool returns, reply with a brief text confirmation only —
    do **not** embed ``![...](path)`` markdown or repeat ``absolute_path`` in the message body.

    Default provider is `jimeng` (**Volcengine Ark** — same key as EvoPanel「火山方舟」`VOLCENGINE_API_KEY`).

    **Do not** switch to `wan` or `kling` on failure unless the user explicitly asks.
    If jimeng fails with model-not-activated, tell the user to enable Seedream in Ark console
    or set image model to their Ark endpoint id (`ep-...`) in EvoPanel 设置 → 模型 → 视频模型 → 火山方舟.

    **Prompt（单帧静态图，上限 500 字符 / 约 80–120 汉字）** — 只写**一帧**画面：
    主体 + 环境 + 光线 + 构图 + 风格；2–4 短句即可。
    **禁止**把多分镜广告/故事板（推拉镜、粒子、Logo 动画等）写进一条 prompt；
    视频多镜请 **每镜各调一次** ``media_image_generate``。

    示例（可直接参考长度与结构）::

        暗色极简房间，人物背对镜头坐在发光显示器前；屏幕蓝紫光勾轮廓；16:9 中景；克制科技广告风。

    Args:
        prompt: 单帧画面描述（≤500 字符）。过长时系统会自动截断到完整句边界并提示；请主动写短。
        mode: text2image or image2image (requires reference_image_urls).
        provider: jimeng (default), kling, or wan — **only if configured** in EvoPanel 创意 API; unconfigured providers are rejected.
        reference_image_urls: Comma-separated URLs or JSON array of reference images.
        aspect_ratio: e.g. 16:9, 1:1, 9:16.
        max_wait_seconds: Max time to poll async providers (default 300).
    """
    prov, err = resolve_image_provider(provider)
    if err:
        return error_response(err, provider=prov)
    prompt_err = _validate_image_prompt(prompt)
    if prompt_err:
        return error_response(prompt_err, provider=prov)
    prompt_fitted, prompt_trim_note = _prepare_image_prompt(prompt)
    refs = _parse_reference_urls(reference_image_urls)
    if mode == "image2image" and not refs:
        return error_response("image2image requires reference_image_urls")

    raw = _run_image_generate_and_wait(
        runtime,
        provider=prov,
        prompt=prompt_fitted,
        mode=mode,
        reference_image_urls=refs,
        aspect_ratio=aspect_ratio,
        max_wait_seconds=max_wait_seconds,
    )
    if not prompt_trim_note:
        return raw
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError:
        return raw
    if obj.get("ok") is not False:
        obj["prompt_trimmed"] = True
        obj["prompt_trim_note"] = prompt_trim_note
        if isinstance(obj.get("message"), str) and obj["message"].strip():
            obj["message"] = f"{obj['message'].strip()} ({prompt_trim_note})"
        else:
            obj["message"] = prompt_trim_note
        return json.dumps(obj, ensure_ascii=False, default=str)
    return raw


@tool("media_video_generate", parse_docstring=True)
def media_video_generate_tool(
    runtime: ToolRuntime[ContextT, ThreadState],
    prompt: str,
    mode: VideoModeLit = "text2video",
    provider: VideoProviderLit | None = None,
    first_frame_url: str | None = None,
    audio_url: str | None = None,
    duration: int = 5,
    aspect_ratio: str = "16:9",
    generate_audio: bool | None = None,
) -> str:
    """Generate a video with Volcengine Seedance (default), Kling, or DashScope Wan.

    **Standard pipeline (fast, coherent)** — always after ``media_image_generate``::

        1. media_image_generate → use ``url`` or ``absolute_path`` as first frame
        2. media_video_generate(mode=image2video, first_frame_url=..., duration=5, generate_audio=true)
        3. media_task_wait(provider=jimeng, media_kind=video, max_wait_seconds=600)

    Prefer **image2video** for narrated promos. Do **not** use ``text2video`` to cram a full
    multi-beat commercial into one clip. Do **not** call ``media_voiceover_synthesize``, ffmpeg,
    or terminal to add audio when using jimeng — Seedance native audio belongs in ``prompt``.

    **Prompt (5–10s, one beat)** — 1–2 sentences of motion + **full narration/dialogue** for this shot.
    No logo reveals, scene changes, or 4K/slow-motion keyword stuffing.

    Example (image2video, 5s)::

        Camera slowly pushes toward the glowing screen; soft blue-violet particles drift outward.
        Narration (zh): 「智能，如流而动。EvoFlow，一句话唤醒你的 AI 创作团队。」

    Args:
        prompt: Motion + narration for jimeng (native audio); must match ``first_frame_url``.
        mode: **image2video** (recommended) or text2video only when no keyframe exists.
        provider: jimeng (default), kling, or wan.
        first_frame_url: Required for image2video — from prior ``media_image_generate`` (``url`` / ``absolute_path``).
        audio_url: Wan/Kling only — **ignored for jimeng** (use ``generate_audio`` + prompt instead).
        duration: **5** seconds default; use 10 only when brief requires it.
        aspect_ratio: e.g. 16:9, 9:16.
        generate_audio: Seedance native audio (default true for jimeng). Set false to mute.
    """
    prov, err = resolve_video_provider(provider)
    if err:
        return error_response(err, provider=prov)
    resolve_notes: list[str] = []
    resolved_first = first_frame_url
    resolved_audio = audio_url
    outputs_dir = _resolve_outputs_dir(runtime)

    try:
        if first_frame_url:
            resolved_first, note = resolve_media_reference_url(
                first_frame_url,
                runtime=runtime,
                provider=prov,
                purpose="first_frame",
                media_kind="image",
                outputs_dir=outputs_dir,
            )
            if note:
                resolve_notes.append(note)
        if audio_url:
            resolved_audio, note = resolve_media_reference_url(
                audio_url,
                runtime=runtime,
                provider=prov,
                purpose="audio",
                media_kind="audio",
                outputs_dir=outputs_dir,
            )
            if note:
                resolve_notes.append(note)
    except ValueError as e:
        return error_response(str(e), provider=prov)

    effective_mode = mode
    if resolved_first and mode != "image2video":
        effective_mode = "image2video"
        resolve_notes.append("Auto-set mode=image2video because first_frame_url was provided.")

    if effective_mode == "image2video" and not resolved_first:
        return error_response("image2video requires first_frame_url")

    if prov == "jimeng" and effective_mode == "text2video" and not resolved_first:
        return error_response(
            "jimeng/Seedance 禁止 text2video 做整条宣传片：请先 media_image_generate，"
            "再 media_video_generate(mode=image2video, first_frame_url=..., generate_audio=true)。",
            provider=prov,
        )

    if prov == "jimeng" and resolved_audio:
        resolve_notes.append("audio_url ignored for jimeng — put narration in prompt with generate_audio=true.")

    try:
        task_id = _submit_video(
            prov,
            prompt=prompt,
            mode=effective_mode,
            first_frame_url=resolved_first,
            audio_url=resolved_audio,
            duration=duration,
            aspect_ratio=aspect_ratio,
            generate_audio=generate_audio,
        )
    except Exception as e:
        logger.exception("media_video_generate failed")
        return error_response(str(e), provider=prov)

    if task_id.startswith("immediate:"):
        url = task_id[len("immediate:") :]
        record_task_completed(
            runtime,
            tool_name="media_video_generate",
            provider=prov,
            task_id=task_id,
            media_kind="video",
            status="succeeded",
            remote_url=url,
            meta={"mode": mode, "immediate": True},
        )
        return success_response(
            provider=prov,
            status="succeeded",
            url=url,
            urls=[url],
            message="Video ready (sync response).",
        )

    record_task_submitted(
        runtime,
        tool_name="media_video_generate",
        provider=prov,
        task_id=task_id,
        media_kind="video",
        meta={
            "mode": effective_mode,
            "duration": duration,
            "aspect_ratio": aspect_ratio,
            "first_frame_url": resolved_first,
            "resolve_notes": resolve_notes,
        },
    )
    msg = "Video task submitted (may take several minutes)."
    if resolve_notes:
        msg += " " + " ".join(resolve_notes)
    return success_response(
        provider=prov,
        task_id=task_id,
        status="processing",
        message=msg,
        next_action=f"Call media_task_wait(task_id={task_id!r}, provider={prov!r}, media_kind='video', max_wait_seconds=600).",
        extra={"resolve_notes": resolve_notes, "first_frame_url": resolved_first},
    )


@tool("media_task_wait", parse_docstring=True)
def media_task_wait_tool(
    runtime: ToolRuntime[ContextT, ThreadState],
    task_id: str,
    provider: ImageProviderLit,
    media_kind: MediaKindLit = "video",
    max_wait_seconds: int = 600,
) -> str:
    """Poll an async **video or audio** task until done and download results to outputs/.

    For **images**, use ``media_image_generate`` only (it polls and downloads in one call).

    Args:
        task_id: Task ID from media_video_generate (or legacy image submit).
        provider: Same provider used for submission (jimeng, kling, wan).
        media_kind: image, video, or audio.
        max_wait_seconds: Max poll time (default 600).
    """
    kind = "video" if media_kind == "video" else "image" if media_kind == "image" else "voice"
    if kind == "voice":
        _, err = resolve_voice_provider(None)
        if err:
            return error_response(err, provider=provider)
    else:
        err = provider_unavailable_message(provider, media_kind=kind)
        if err:
            return error_response(err, provider=provider)

    if task_id.startswith("immediate:"):
        url = task_id[len("immediate:") :]
        urls = [url]
        status = "succeeded"
    else:

        def _poll():
            if media_kind == "image":
                return _poll_image(provider, task_id)
            return _poll_video(provider, task_id)

        try:
            status, primary, urls = poll_until_done(_poll, max_wait_seconds=max_wait_seconds)
        except Exception as e:
            return error_response(str(e), provider=provider, task_id=task_id)

        if status.lower() in ("failed", "error", "cancelled") and not urls:
            return error_response(
                f"Task ended with status={status}",
                provider=provider,
                task_id=task_id,
                status=status,
            )

    outputs_dir = _resolve_outputs_dir(runtime)
    local_paths: list[str] = []
    if outputs_dir and urls:
        prefix = _unique_media_save_prefix(media_kind, task_id, url=urls[0] if urls else "")
        local_paths = save_media_from_urls(urls, outputs_dir, prefix=prefix, media_kind=media_kind)

    record_task_completed(
        runtime,
        tool_name="media_task_wait",
        provider=provider,
        task_id=task_id,
        media_kind=media_kind,
        status=status,
        remote_url=urls[0] if urls else None,
        local_path=local_paths[0] if local_paths else None,
        outputs_dir=outputs_dir,
        meta={"urls": urls, "local_paths": local_paths},
    )

    lp = local_paths[0] if local_paths else None
    ap = _path_for_display(lp)
    next_action = (
        _media_image_reply_hint(ap)
        if media_kind == "image" and ap
        else (
            "Share absolute path in chat as @@/abs/path@@ (no relative @@outputs/…@@)."
            if local_paths
            else "Retry media_task_wait or check provider dashboard."
        )
    )
    msg = f"Saved: {ap}" if ap else ("Task finished." if urls else f"Task status={status}; no download URL yet.")
    return success_response(
        provider=provider,
        task_id=task_id,
        status=status,
        url=urls[0] if urls else None,
        urls=urls,
        local_path=ap,
        absolute_path=ap,
        message=msg,
        next_action=next_action,
        extra={"local_paths": local_paths},
    )


@tool("media_voiceover_synthesize", parse_docstring=True)
def media_voiceover_synthesize_tool(
    runtime: ToolRuntime[ContextT, ThreadState],
    text: str,
    provider: VoiceProviderLit | None = None,
    output_filename: str = "voiceover.mp3",
) -> str:
    """Synthesize speech audio for video voiceover (Volcengine default, or DashScope).

    Default provider is `volcengine` (openspeech TTS). Use before
    media_subtitle_build for subtitle timing; pass audio_url to media_video_generate only
    when the video provider supports custom audio.

    Args:
        text: Narration script (plain text).
        provider: volcengine (default) or dashscope.
        output_filename: File name under outputs/ (default voiceover.mp3).
    """
    prov, err = resolve_voice_provider(provider)
    if err:
        from .config_helpers import configured_voice_providers, is_jimeng_configured

        if is_jimeng_configured() and not configured_voice_providers():
            return error_response(
                "独立 TTS 未配置或已停用。jimeng/Seedance 流水线请把口播写进 media_video_generate 的 prompt"
                "（generate_audio=true），勿调用 media_voiceover_synthesize。",
                provider=prov,
            )
        return error_response(err, provider=prov)
    outputs_dir = _resolve_outputs_dir(runtime)
    if not outputs_dir:
        return error_response("Thread outputs path unavailable; bind a session workspace first.")

    try:
        if prov == "dashscope":
            audio_bytes = dashscope_tts.synthesize_speech(text)
        else:
            audio_bytes = volcengine_tts.synthesize_speech(text)
    except Exception as e:
        return error_response(str(e), provider=prov)

    safe_name = re.sub(r"[^\w.\-]", "_", output_filename) or "voiceover.mp3"
    if not safe_name.endswith((".mp3", ".wav")):
        safe_name += ".mp3"
    dest = outputs_dir / safe_name
    dest.write_bytes(audio_bytes)

    local_rel = f"outputs/{safe_name}"
    record_local_asset(
        runtime,
        tool_name="media_voiceover_synthesize",
        media_kind="audio",
        local_path=local_rel,
        provider=prov,
        meta={"output_filename": safe_name},
        outputs_dir=outputs_dir,
    )

    return success_response(
        provider=prov,
        status="succeeded",
        local_path=f"outputs/{safe_name}",
        message="Voiceover saved.",
        next_action="Upload/serve URL if needed for media_video_generate audio_url, or pass local path via workspace.",
    )


@tool("media_subtitle_build", parse_docstring=True)
def media_subtitle_build_tool(
    runtime: ToolRuntime[ContextT, ThreadState],
    text: str,
    audio_path: str | None = None,
    subtitle_format: SubtitleFormatLit = "srt",
    locale: str = "zh",
    output_filename: str = "subtitles.srt",
) -> str:
    """Build SRT or VTT subtitles from script text and optional audio.

    Prefers faster-whisper alignment when installed; otherwise distributes sentences evenly
    across audio duration.

    Args:
        text: Full narration/subtitle script.
        audio_path: Optional outputs/ path for timing — mp3/wav or **mp4 with embedded audio**
            (e.g. outputs/voiceover.mp3 or the Seedance video mp4). Omit to evenly split text.
        subtitle_format: srt or vtt.
        locale: zh or en (for whisper).
        output_filename: Output file under outputs/.
    """
    outputs_dir = _resolve_outputs_dir(runtime)
    if not outputs_dir:
        return error_response("Thread outputs path unavailable.")

    duration = 0.0
    audio_file: Path | None = None
    if audio_path:
        rel = audio_path.strip().replace("\\", "/")
        if rel.startswith("outputs/"):
            rel = rel[len("outputs/") :]
        audio_file = outputs_dir / rel
        if audio_file.is_file():
            duration = audio_duration_seconds(audio_file)

    srt: str | None = None
    if audio_file and audio_file.is_file():
        srt = whisper_transcribe_srt(audio_file, locale=locale)
    if not srt:
        srt = build_srt_from_text(text, duration)

    if subtitle_format == "vtt":
        content = build_vtt_from_srt(srt)
        if not output_filename.endswith(".vtt"):
            output_filename = re.sub(r"\.srt$", ".vtt", output_filename) or "subtitles.vtt"
    else:
        content = srt
        if not output_filename.endswith(".srt"):
            output_filename = output_filename.rsplit(".", 1)[0] + ".srt" if "." in output_filename else "subtitles.srt"

    safe = re.sub(r"[^\w.\-]", "_", output_filename)
    dest = outputs_dir / safe
    dest.write_text(content, encoding="utf-8")

    local_rel = f"outputs/{safe}"
    record_local_asset(
        runtime,
        tool_name="media_subtitle_build",
        media_kind="subtitle",
        local_path=local_rel,
        meta={"format": subtitle_format, "locale": locale},
        outputs_dir=outputs_dir,
    )

    return success_response(
        status="succeeded",
        local_path=f"outputs/{safe}",
        message=f"Subtitle file written ({subtitle_format}).",
        next_action="Call media_subtitle_burn with video_path and this subtitle path.",
    )


@tool("media_subtitle_burn", parse_docstring=True)
def media_subtitle_burn_tool(
    runtime: ToolRuntime[ContextT, ThreadState],
    video_path: str,
    subtitle_path: str,
    output_filename: str | None = None,
) -> str:
    """Burn subtitles into video using ffmpeg (hard subtitles).

    Args:
        video_path: Path under outputs/ (e.g. outputs/video.mp4).
        subtitle_path: SRT path under outputs/.
        output_filename: Optional output name (default adds -subtitled suffix).
    """
    if not shutil.which("ffmpeg"):
        return error_response("ffmpeg not found on PATH. Install ffmpeg to burn subtitles.")

    outputs_dir = _resolve_outputs_dir(runtime)
    if not outputs_dir:
        return error_response("Thread outputs path unavailable.")

    def _resolve(p: str) -> Path:
        rel = p.strip().replace("\\", "/")
        if rel.startswith("outputs/"):
            rel = rel[len("outputs/") :]
        return outputs_dir / rel

    video = _resolve(video_path)
    subs = _resolve(subtitle_path)
    if not video.is_file():
        return error_response(f"Video not found: {video_path}")
    if not subs.is_file():
        return error_response(f"Subtitle not found: {subtitle_path}")

    out_name = output_filename or f"{video.stem}-subtitled.mp4"
    out_name = re.sub(r"[^\w.\-]", "_", out_name)
    dest = outputs_dir / out_name
    subs_esc = str(subs.resolve()).replace("\\", "/").replace(":", "\\:")
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        str(video.resolve()),
        "-vf",
        f"subtitles='{subs_esc}'",
        "-c:a",
        "copy",
        str(dest.resolve()),
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    except subprocess.TimeoutExpired:
        return error_response("ffmpeg timed out after 600s")
    except Exception as e:
        return error_response(str(e))

    if proc.returncode != 0:
        return error_response(f"ffmpeg failed: {proc.stderr[-800:]}")

    local_rel = f"outputs/{out_name}"
    record_local_asset(
        runtime,
        tool_name="media_subtitle_burn",
        media_kind="video",
        local_path=local_rel,
        meta={"source_video": video_path, "subtitle_path": subtitle_path},
        outputs_dir=outputs_dir,
    )

    return success_response(
        status="succeeded",
        local_path=f"outputs/{out_name}",
        message="Subtitled video created.",
        next_action="Cite absolute @@/workspace/path@@ in reply when delivering to user.",
    )


@tool("media_subtitle_extract", parse_docstring=True)
def media_subtitle_extract_tool(
    input_oss_url: str,
    output_oss_url: str,
    max_wait_seconds: int = 600,
) -> str:
    """Extract hard-coded subtitles from video via Aliyun IMS CaptionExtraction (OSS in/out).

    Requires ALIYUN_ACCESS_KEY_ID, ALIYUN_ACCESS_KEY_SECRET, and oss:// paths.

    Args:
        input_oss_url: oss://bucket/path/to/video.mp4
        output_oss_url: oss://bucket/path/to/output.srt
        max_wait_seconds: Poll timeout.
    """
    ak, sk, bucket = aliyun_credentials()
    if not ak or not sk:
        return error_response("Set ALIYUN_ACCESS_KEY_ID and ALIYUN_ACCESS_KEY_SECRET")
    if not input_oss_url.startswith("oss://") or not output_oss_url.startswith("oss://"):
        return error_response("input_oss_url and output_oss_url must be oss://bucket/key paths")

    try:
        job_id = aliyun_vod.submit_caption_extraction(
            input_oss=input_oss_url,
            output_oss=output_oss_url,
        )
    except Exception as e:
        return error_response(str(e))

    try:
        status, url, urls = poll_until_done(
            lambda: aliyun_vod.poll_caption_extraction(job_id),
            max_wait_seconds=max_wait_seconds,
        )
    except Exception as e:
        return error_response(str(e), task_id=job_id)

    return success_response(
        provider="aliyun_vod",
        task_id=job_id,
        status=status,
        url=url,
        urls=urls,
        message="Subtitle extraction finished." if urls else f"Status={status}",
        next_action="Download SRT from output OSS URL or re-query job.",
    )
