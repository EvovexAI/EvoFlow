"""Platform ``media.*`` helpers — Volcengine Agent Plan (jimeng) first.

Wraps community media_generation submit/poll/save without exposing retired media_* tools.
"""

from __future__ import annotations

import json
import logging
from types import SimpleNamespace
from typing import Any

logger = logging.getLogger(__name__)

_DEFAULT_IMAGE_PROVIDER = "jimeng"
_DEFAULT_VIDEO_PROVIDER = "jimeng"


def _fake_runtime(thread_id: str | None) -> Any:
    tid = str(thread_id or "").strip()
    ctx = {"thread_id": tid} if tid else {}
    return SimpleNamespace(
        context=ctx,
        config={"configurable": dict(ctx)},
        state={},
    )


def _parse_tool_json(raw: str) -> dict[str, Any]:
    try:
        data = json.loads(raw or "")
    except Exception:
        return {"ok": False, "error": str(raw or "empty media tool response")}
    return data if isinstance(data, dict) else {"ok": False, "error": "invalid media tool response"}


def _path_display(p: str | None) -> str | None:
    s = str(p or "").strip()
    return s.replace("\\", "/") if s else None


def _image_model_guide() -> list[dict[str, Any]]:
    return [
        {
            "id": "doubao-seedream-5-0-pro",
            "label": "Seedream 5.0 Pro",
            "min_tier": "small",
            "use_when": "默认推荐；画质优先的海报 / 首帧",
            "modes": ["text2image", "image2image"],
        },
        {
            "id": "doubao-seedream-5.0-flash",
            "label": "Seedream 5.0 Flash",
            "min_tier": "small",
            "use_when": "要更快出图、可略降画质",
            "modes": ["text2image", "image2image"],
        },
    ]


def _video_model_guide() -> list[dict[str, Any]]:
    return [
        {
            "id": "doubao-seedance-2.5",
            "label": "Seedance 2.5",
            "min_tier": "large",
            "use_when": "默认推荐；更强运镜与多模态参考（最长约 30s）",
            "duration": "4–30 秒（或 -1 由模型自选）",
            "resolution": ["480p", "720p", "1080p"],
        },
        {
            "id": "doubao-seedance-2.0",
            "label": "Seedance 2.0",
            "min_tier": "large",
            "use_when": "图生视频；支持 480p/720p/1080p/4k",
            "duration": "4–15 秒（或 -1 由模型自选）",
            "resolution": ["480p", "720p", "1080p", "4k"],
        },
        {
            "id": "doubao-seedance-2.0-fast",
            "label": "Seedance 2.0 Fast",
            "min_tier": "large",
            "use_when": "要更快出片；分辨率仅 480p/720p",
            "duration": "4–15 秒",
            "resolution": ["480p", "720p"],
        },
        {
            "id": "doubao-seedance-2.0-mini",
            "label": "Seedance 2.0 Mini",
            "min_tier": "large",
            "use_when": "更轻量 / 省额度的短镜头",
            "duration": "4–15 秒",
            "resolution": ["480p", "720p"],
        },
    ]


def media_catalog(*, tier_hint: str | None = None) -> dict[str, Any]:
    """Discovery: providers, Plan entitlements, full param schema + examples.

    Call this **before** generate_* so the agent knows model IDs and how to pass them.
    Docs: https://www.volcengine.com/docs/82379/2366394 （套餐模型）
    API: https://ark.volcengine.com/docs/.../create-video-generation-task-api
    """
    from evoflow.community.media_generation.config_helpers import (
        available_media_providers,
        jimeng_image_model,
        jimeng_video_model,
    )
    from evoflow.community.media_generation.provider_registry import (
        channel_image_models,
        channel_video_models,
        credential_sources,
        input_image_formats,
        key_routing_summary,
    )

    avail = available_media_providers()
    image_models = _image_model_guide()
    video_models = _video_model_guide()
    plan: dict[str, Any] | None = None
    try:
        from evoflow.plans import bindings as bindings_store
        from evoflow.plans.volc_agent_plan_models import (
            AGENT_PLAN_CAPABILITIES,
            default_media_models_for_tier,
            media_capability_items,
        )

        binding = bindings_store.find_active_binding(
            vendor="volcengine",
            plan_family="agent_plan",
            mask_key=True,
        )
        if isinstance(binding, dict):
            tier = str(binding.get("tier_id") or tier_hint or "small").strip().lower()
            caps = list(binding.get("bound_capabilities") or [])
            defaults = default_media_models_for_tier(tier)
            # Prefer live Plan catalog rows when present; keep how-to from guides.
            plan_image = [
                {"id": r.get("id"), "label": r.get("label"), "min_tier": r.get("min_tier")}
                for r in media_capability_items("image")
            ]
            plan_video = [
                {"id": r.get("id"), "label": r.get("label"), "min_tier": r.get("min_tier")}
                for r in media_capability_items("video")
            ]
            by_id_img = {m["id"]: m for m in image_models}
            by_id_vid = {m["id"]: m for m in video_models}
            image_models = [{**by_id_img.get(str(r["id"]), {}), **r} for r in plan_image if r.get("id")]
            video_models = [{**by_id_vid.get(str(r["id"]), {}), **r} for r in plan_video if r.get("id")]
            plan = {
                "bound": True,
                "catalog_id": str(binding.get("catalog_id") or "volcengine.agent_plan"),
                "tier_id": tier,
                "capabilities": caps,
                "image_entitled": "image" in caps,
                "video_entitled": "video" in caps,
                "default_models": defaults,
                "notes": next(
                    (
                        str(c.get("summary") or "")
                        for c in AGENT_PLAN_CAPABILITIES
                        if c.get("id") == "video"
                    ),
                    "",
                ),
                "docs_url": "https://www.volcengine.com/docs/82379/2366394?lang=zh",
            }
        else:
            plan = {"bound": False}
    except Exception as exc:
        logger.info("media.catalog plan lookup skipped: %s", exc)
        plan = {"bound": False, "error": str(exc)}

    default_image = jimeng_image_model()
    default_video = jimeng_video_model()

    return {
        "ok": True,
        "how_to_discover": (
            "调用本 action（media.catalog）即可。返回 models + params + examples。"
            "生图/生视频前先读 catalog；再带 confirm=true 调 generate_*。"
            "不确定模型时用 defaults.image_model / defaults.video_model。"
        ),
        "providers": avail,
        "defaults": {
            "image_provider": _DEFAULT_IMAGE_PROVIDER,
            "video_provider": _DEFAULT_VIDEO_PROVIDER,
            "image_model": default_image,
            "video_model": default_video,
        },
        "models": {
            "image": image_models + channel_image_models(),
            "video": video_models + channel_video_models(),
        },
        "input_image_formats": input_image_formats(),
        "credentials": credential_sources(),
        "key_routing": key_routing_summary(),
        "interfaces": {
            "image": {
                "pattern": "sync_poll",
                "summary": "media.generate_image 一次完成：提交 → 短轮询 → 落盘；结果含 absolute_path / url / preview。",
                "endpoint_hint": "POST {ark}/api/plan/v3/images/generations",
                "docs_hint": "Agent Plan 生图模型见套餐概览 Seedream 行",
                "params": {
                    "prompt": {"required": True, "type": "string", "desc": "单帧画面描述（≤500 字）"},
                    "model": {
                        "required": False,
                        "type": "string",
                        "desc": "模型 ID；省略则用 defaults.image_model。选 gpt-image-2.5-* 会自动走 openai Key",
                        "enum_hint": [m["id"] for m in image_models]
                        + [m["id"] for m in channel_image_models()],
                    },
                    "mode": {
                        "required": False,
                        "type": "string",
                        "default": "text2image",
                        "enum": ["text2image", "image2image"],
                    },
                    "aspect_ratio": {
                        "required": False,
                        "type": "string",
                        "default": "16:9",
                        "enum_hint": ["16:9", "1:1", "9:16", "4:3", "3:4"],
                    },
                    "reference_image_urls": {
                        "required": False,
                        "type": "string|string[]",
                        "desc": (
                            "image2image 必填。支持：https 公网 URL；"
                            "data:image/png;base64,...；本地 outputs/absolute_path（自动转 Data URI）；"
                            "勿传裸 base64"
                        ),
                    },
                    "provider": {
                        "required": False,
                        "default": "jimeng",
                        "enum_hint": ["jimeng", "wan", "openai", "kling"],
                    },
                    "max_wait_seconds": {"required": False, "type": "int", "default": 300},
                },
                "examples": [
                    {
                        "title": "文生图（默认 Pro）",
                        "action": "media.generate_image",
                        "args": {
                            "prompt": "暗色极简房间，人物背对发光屏幕；蓝紫轮廓光；16:9 中景科技广告风",
                            "model": default_image,
                            "aspect_ratio": "16:9",
                        },
                    },
                    {
                        "title": "图生图",
                        "action": "media.generate_image",
                        "args": {
                            "prompt": "同一构图，改成暖色黄昏光",
                            "mode": "image2image",
                            "model": "doubao-seedream-5.0-flash",
                            "reference_image_urls": "<上一张 absolute_path 或 url>",
                        },
                    },
                ],
            },
            "video": {
                "pattern": "async_task",
                "summary": (
                    "media.generate_video 只提交任务；再用 media.task_wait 轮询落盘。"
                    "推荐流水线：generate_image → generate_video(mode=image2video, first_frame_url=...) → task_wait。"
                ),
                "endpoint_hint": "POST {ark}/api/plan/v3/contents/generations/tasks（Seedance）",
                "docs_hint": "https://www.volcengine.com/docs/82379/ （创建视频生成任务 API）",
                "params": {
                    "prompt": {
                        "required": True,
                        "type": "string",
                        "desc": "镜头运动 + 口播台词（generate_audio=true 时把对白写进 prompt，建议用中文引号）",
                    },
                    "model": {
                        "required": False,
                        "type": "string",
                        "desc": "Seedance 模型 ID；省略则用 defaults.video_model。Agent Plan Large/Max 才有视频。",
                        "enum_hint": [m["id"] for m in video_models]
                        + [m["id"] for m in channel_video_models()],
                    },
                    "mode": {
                        "required": False,
                        "type": "string",
                        "default": "image2video",
                        "enum": ["image2video", "text2video"],
                        "desc": "jimeng 强烈推荐 image2video；有 first_frame_url 时会自动切到 image2video",
                    },
                    "first_frame_url": {
                        "required": "image2video 时必填",
                        "type": "string",
                        "desc": "首帧：上一张图的 url / absolute_path / 公网 URL；API role=first_frame",
                    },
                    "last_frame_url": {
                        "required": False,
                        "type": "string",
                        "desc": "可选尾帧；与 first_frame 组成首尾帧图生视频（role=last_frame）",
                    },
                    "duration": {
                        "required": False,
                        "type": "int",
                        "default": 5,
                        "desc": "秒；Seedance 2.x 常用 4–15；-1 表示模型自选（以官方为准）",
                    },
                    "resolution": {
                        "required": False,
                        "type": "string",
                        "default": "720p",
                        "enum_hint": ["480p", "720p", "1080p", "4k"],
                        "desc": "2.0-fast / mini 通常仅到 720p",
                    },
                    "aspect_ratio": {
                        "required": False,
                        "type": "string",
                        "default": "16:9",
                        "enum_hint": ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "adaptive"],
                        "desc": "图生视频也可 adaptive（跟首帧）",
                    },
                    "generate_audio": {
                        "required": False,
                        "type": "bool",
                        "default": True,
                        "desc": "jimeng/Seedance 原生有声；口播写在 prompt，勿另传 audio_url",
                    },
                    "watermark": {"required": False, "type": "bool", "default": False},
                    "seed": {"required": False, "type": "int", "desc": "随机种子；相同 seed 结果更接近"},
                    "provider": {"required": False, "default": "jimeng"},
                },
                "examples": [
                    {
                        "title": "图生视频（首帧 + 口播）",
                        "steps": [
                            "media.generate_image → 记下 absolute_path / url",
                            "media.generate_video(confirm=true)",
                            "media.task_wait(task_id=...)",
                        ],
                        "action": "media.generate_video",
                        "args": {
                            "prompt": "镜头缓推向发光屏幕；口播：「智能，如流而动。」",
                            "mode": "image2video",
                            "model": default_video,
                            "first_frame_url": "<上一张图 absolute_path 或 url>",
                            "duration": 5,
                            "resolution": "720p",
                            "generate_audio": True,
                        },
                    },
                    {
                        "title": "首尾帧图生视频",
                        "action": "media.generate_video",
                        "args": {
                            "prompt": "镜头从森林入口平滑移动到湖边",
                            "mode": "image2video",
                            "model": "doubao-seedance-2.5",
                            "first_frame_url": "<首帧路径>",
                            "last_frame_url": "<尾帧路径>",
                            "duration": 8,
                            "resolution": "720p",
                        },
                    },
                ],
            },
        },
        "agent_plan": plan,
        "recommended_pipeline": [
            "1. media.catalog（看 models / params / 档位有无视频）",
            "2. media.generate_image(confirm=true, model=Seedream…)",
            "3. media.generate_video(confirm=true, mode=image2video, model=Seedance…, first_frame_url=上一步路径)",
            "4. media.task_wait(task_id=…)",
        ],
        "assistant_guide": {
            "say_to_user": (
                "先 media.catalog 看生图/生视频模型与参数；"
                "生图 media.generate_image；生视频推荐「先出图再 image2video」后 media.task_wait。"
                "可显式传 model（如 doubao-seedream-5-0-pro / doubao-seedance-2.5 / gpt-image-2.5-sunburst / MiniMax-H3）。"
            ),
        },
    }


def media_status() -> dict[str, Any]:
    """Light readiness check for image/video credentials + Plan gates."""
    cat = media_catalog()
    avail = cat.get("providers") or {}
    plan = cat.get("agent_plan") or {}
    image_ok = bool((avail.get("image") or []) and (not plan.get("bound") or plan.get("image_entitled")))
    video_ok = bool((avail.get("video") or []) and (not plan.get("bound") or plan.get("video_entitled")))
    return {
        "ok": True,
        "image_ready": image_ok,
        "video_ready": video_ok,
        "providers": avail,
        "agent_plan": plan,
        "defaults": cat.get("defaults"),
    }


def _lookup_asset_paths(
    *,
    provider: str | None,
    task_id: str | None,
) -> tuple[str | None, str | None]:
    """Fall back to evoflow_media_assets when tool JSON omitted path/url."""
    prov = str(provider or "").strip()
    tid = str(task_id or "").strip()
    if not prov or not tid:
        return None, None
    try:
        from evoflow.persistence.media_assets import get_media_asset_by_task

        row = get_media_asset_by_task(provider=prov, task_id=tid)
    except Exception:
        logger.debug("media asset lookup skipped", exc_info=True)
        return None, None
    if not isinstance(row, dict):
        return None, None
    local = _path_display(row.get("local_path") or row.get("result_url"))
    remote = str(row.get("remote_url") or "").strip() or None
    # result_url may be local when remote missing
    if not remote:
        cand = str(row.get("result_url") or "").strip()
        if cand.lower().startswith(("http://", "https://")):
            remote = cand
        elif not local and cand:
            local = _path_display(cand)
    return local, remote


def _enrich_preview(blob: dict[str, Any], *, media_kind: str) -> dict[str, Any]:
    """Normalize absolute_path / url / preview for chat inline media.

    Priority: local path → explicit url/urls → deep vendor extract → media_assets row.
    """
    from evoflow.community.media_generation.url_extract import extract_media_urls, guess_media_kind

    ap = _path_display(blob.get("absolute_path") or blob.get("local_path"))
    url = str(blob.get("url") or "").strip()
    urls_raw = blob.get("urls") if isinstance(blob.get("urls"), list) else []
    urls = [str(u).strip() for u in urls_raw if str(u).strip()]
    remote = url or (urls[0] if urls else "")

    if not ap or not remote:
        from evoflow.community.media_generation.url_extract import (
            is_httpish_media_ref,
            is_local_media_path,
        )

        extracted = extract_media_urls(blob)
        for cand in extracted:
            if not remote and is_httpish_media_ref(cand):
                remote = cand
            elif not ap and is_local_media_path(cand):
                ap = _path_display(cand)
            if ap and remote:
                break

    if not ap or not remote:
        asset_local, asset_remote = _lookup_asset_paths(
            provider=str(blob.get("provider") or "") or None,
            task_id=str(blob.get("task_id") or blob.get("taskId") or "") or None,
        )
        if not ap and asset_local:
            ap = asset_local
        if not remote and asset_remote:
            remote = asset_remote

    kind = media_kind
    preview_src = ap or remote
    if preview_src and kind not in {"image", "video"}:
        kind = guess_media_kind(preview_src, default="image")

    out = dict(blob)
    out["media_kind"] = kind
    if ap:
        out["absolute_path"] = ap
        out["local_path"] = ap
    if remote:
        out["url"] = remote
        if not urls:
            out["urls"] = [remote]
    if preview_src:
        out["preview"] = {
            "kind": kind,
            "src": preview_src,
            "absolute_path": ap,
            "url": remote or None,
            "mimeType": "image/png" if kind == "image" else "video/mp4",
        }
    return out


def generate_image(
    args: dict[str, Any],
    *,
    thread_id: str | None = None,
) -> dict[str, Any]:
    from evoflow.community.media_generation.config_helpers import resolve_image_provider
    from evoflow.community.media_generation.tools import (
        _parse_reference_urls,
        _prepare_image_prompt,
        _run_image_generate_and_wait,
        _validate_image_prompt,
    )

    provider_raw = str(args.get("provider") or "").strip() or None
    prov, err = resolve_image_provider(provider_raw)
    if err:
        return {"ok": False, "error": err, "provider": prov}

    prompt = str(args.get("prompt") or "").strip()
    prompt_err = _validate_image_prompt(prompt)
    if prompt_err:
        return {"ok": False, "error": prompt_err, "provider": prov}

    prompt_fitted, trim_note = _prepare_image_prompt(prompt)
    mode = str(args.get("mode") or "text2image").strip() or "text2image"
    refs = _parse_reference_urls(args.get("reference_image_urls") or args.get("referenceImageUrls"))
    if mode == "image2image" and not refs:
        return {"ok": False, "error": "image2image requires reference_image_urls", "provider": prov}

    aspect = str(args.get("aspect_ratio") or args.get("aspectRatio") or "16:9").strip() or "16:9"
    model = str(args.get("model") or args.get("model_id") or args.get("modelId") or "").strip() or None
    # Model id can imply provider (e.g. gpt-image-2.5-sunburst → openai)
    if model and not provider_raw:
        from evoflow.community.media_generation.provider_registry import provider_for_model

        implied = provider_for_model(model, capability="image")
        if implied and implied != prov:
            alt, alt_err = resolve_image_provider(implied)
            if not alt_err:
                prov = alt
    try:
        max_wait = int(args.get("max_wait_seconds") or args.get("maxWaitSeconds") or 300)
    except (TypeError, ValueError):
        max_wait = 300

    runtime = _fake_runtime(thread_id)
    resolve_notes: list[str] = []
    resolved_refs: list[str] | None = None
    if refs:
        from evoflow.community.media_generation.media_url_resolver import resolve_media_reference_url
        from evoflow.community.media_generation.tools import _resolve_outputs_dir

        outputs_dir = _resolve_outputs_dir(runtime)
        resolved_refs = []
        try:
            for ref in refs:
                resolved, note = resolve_media_reference_url(
                    ref,
                    runtime=runtime,
                    provider=prov,
                    purpose="reference",
                    media_kind="image",
                    outputs_dir=outputs_dir,
                )
                if resolved:
                    resolved_refs.append(resolved)
                if note:
                    resolve_notes.append(note)
        except ValueError as exc:
            return {"ok": False, "error": str(exc), "provider": prov}
        if mode == "image2image" and not resolved_refs:
            return {"ok": False, "error": "image2image requires resolvable reference_image_urls", "provider": prov}

    raw = _run_image_generate_and_wait(
        runtime,
        provider=prov,
        prompt=prompt_fitted,
        mode=mode,
        reference_image_urls=resolved_refs,
        aspect_ratio=aspect,
        max_wait_seconds=max_wait,
        model=model,
    )
    blob = _enrich_preview(_parse_tool_json(raw), media_kind="image")
    if trim_note and blob.get("ok") is not False:
        blob["prompt_trimmed"] = True
        blob["prompt_trim_note"] = trim_note
        msg = str(blob.get("message") or "").strip()
        blob["message"] = f"{msg} ({trim_note})" if msg else trim_note
    blob.setdefault("provider", prov)
    if model:
        blob["model"] = model
    if resolve_notes:
        blob["resolve_notes"] = resolve_notes
    return blob


def generate_video(
    args: dict[str, Any],
    *,
    thread_id: str | None = None,
) -> dict[str, Any]:
    """Submit only — returns task_id; caller should media.task_wait."""
    from evoflow.community.media_generation.config_helpers import resolve_video_provider
    from evoflow.community.media_generation.media_url_resolver import resolve_media_reference_url
    from evoflow.community.media_generation.schemas import error_response, success_response
    from evoflow.community.media_generation.tools import (
        _resolve_outputs_dir,
        _submit_video,
    )
    from evoflow.community.media_generation.asset_recorder import record_task_completed, record_task_submitted

    provider_raw = str(args.get("provider") or "").strip() or None
    model = str(args.get("model") or args.get("model_id") or args.get("modelId") or "").strip() or None
    if model and not provider_raw:
        from evoflow.community.media_generation.provider_registry import provider_for_model

        implied = provider_for_model(model, capability="video")
        if implied:
            provider_raw = implied
    prov, err = resolve_video_provider(provider_raw)
    if err:
        return {"ok": False, "error": err, "provider": prov}

    prompt = str(args.get("prompt") or "").strip()
    if not prompt:
        return {"ok": False, "error": "prompt is required", "provider": prov}

    mode = str(args.get("mode") or "text2video").strip() or "text2video"
    first_frame = str(args.get("first_frame_url") or args.get("firstFrameUrl") or "").strip() or None
    last_frame = str(args.get("last_frame_url") or args.get("lastFrameUrl") or "").strip() or None
    audio_url = str(args.get("audio_url") or args.get("audioUrl") or "").strip() or None
    aspect = str(args.get("aspect_ratio") or args.get("aspectRatio") or "16:9").strip() or "16:9"
    resolution = str(args.get("resolution") or "720p").strip() or "720p"
    try:
        duration = int(args.get("duration") or 5)
    except (TypeError, ValueError):
        duration = 5
    generate_audio = args.get("generate_audio")
    if generate_audio is None:
        generate_audio = args.get("generateAudio")
    watermark = args.get("watermark")
    seed = args.get("seed")

    runtime = _fake_runtime(thread_id)
    outputs_dir = _resolve_outputs_dir(runtime)
    resolve_notes: list[str] = []
    resolved_first = first_frame
    resolved_last = last_frame
    resolved_audio = audio_url
    try:
        if first_frame:
            resolved_first, note = resolve_media_reference_url(
                first_frame,
                runtime=runtime,
                provider=prov,
                purpose="first_frame",
                media_kind="image",
                outputs_dir=outputs_dir,
            )
            if note:
                resolve_notes.append(note)
        if last_frame:
            resolved_last, note = resolve_media_reference_url(
                last_frame,
                runtime=runtime,
                provider=prov,
                purpose="last_frame",
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
    except ValueError as exc:
        return {"ok": False, "error": str(exc), "provider": prov}

    effective_mode = mode
    if resolved_first and mode != "image2video":
        effective_mode = "image2video"
        resolve_notes.append("Auto-set mode=image2video because first_frame_url was provided.")
    if effective_mode == "image2video" and not resolved_first:
        return {"ok": False, "error": "image2video requires first_frame_url", "provider": prov}
    if resolved_last and not resolved_first:
        return {"ok": False, "error": "last_frame_url requires first_frame_url", "provider": prov}
    if prov == "jimeng" and effective_mode == "text2video" and not resolved_first:
        return {
            "ok": False,
            "error": (
                "jimeng/Seedance 禁止 text2video 做整条宣传片："
                "请先 media.generate_image，再 media.generate_video(mode=image2video, first_frame_url=...)。"
            ),
            "provider": prov,
        }
    if prov == "jimeng" and resolved_audio:
        resolve_notes.append("audio_url ignored for jimeng — put narration in prompt with generate_audio=true.")

    try:
        submit_kwargs: dict[str, Any] = {
            "prompt": prompt,
            "mode": effective_mode,
            "first_frame_url": resolved_first,
            "last_frame_url": resolved_last,
            "audio_url": resolved_audio,
            "duration": duration,
            "aspect_ratio": aspect,
            "resolution": resolution,
            "generate_audio": generate_audio,
            "watermark": watermark,
            "seed": seed,
        }
        if model:
            submit_kwargs["model"] = model
        task_id = _submit_video(prov, **submit_kwargs)
    except Exception as exc:
        logger.exception("platform media.generate_video failed")
        msg = str(exc)
        # Channel/catalog mismatches (obs: MiniMax-H3 → 503 model_not_found) — steer to working defaults.
        low = msg.lower()
        if "model_not_found" in low or "model_price_error" in low or "no available channel" in low:
            msg = (
                f"{msg}\n"
                "hint: 当前渠道不可用该 model。请先 media.catalog 看可用视频模型；"
                "默认改用 jimeng / doubao-seedance-2.5，或配置官方 MiniMax Key（api.minimax.cn）后再用 MiniMax-H3。"
                "OpenAI Videos 网关请用 model=minimax-h3（小写）而非 MiniMax-H3。"
            )
        return _parse_tool_json(error_response(msg, provider=prov))

    if task_id.startswith("immediate:"):
        url = task_id[len("immediate:") :]
        record_task_completed(
            runtime,
            tool_name="platform.media.generate_video",
            provider=prov,
            task_id=task_id,
            media_kind="video",
            status="succeeded",
            remote_url=url,
            meta={
                "mode": effective_mode,
                "immediate": True,
                "model": model,
                "duration": duration,
                "aspect_ratio": aspect,
                "resolution": resolution,
                "prompt": prompt,
            },
        )
        return _enrich_preview(
            _parse_tool_json(
                success_response(
                    provider=prov,
                    status="succeeded",
                    url=url,
                    urls=[url],
                    message="Video ready (sync response).",
                )
            ),
            media_kind="video",
        )

    record_task_submitted(
        runtime,
        tool_name="platform.media.generate_video",
        provider=prov,
        task_id=task_id,
        media_kind="video",
        meta={
            "mode": effective_mode,
            "duration": duration,
            "aspect_ratio": aspect,
            "resolution": resolution,
            "model": model,
            "prompt": prompt,
            "first_frame_url": resolved_first,
            "resolve_notes": resolve_notes,
        },
    )
    msg = "Video task submitted (may take several minutes)."
    if resolve_notes:
        msg += " " + " ".join(resolve_notes)
    blob = _parse_tool_json(
        success_response(
            provider=prov,
            task_id=task_id,
            status="processing",
            message=msg,
            next_action=(
                f"Call platform(action='media.task_wait', args_json="
                f'{{"task_id":"{task_id}","provider":"{prov}","media_kind":"video"}}, confirm=false).'
            ),
            extra={"resolve_notes": resolve_notes, "first_frame_url": resolved_first},
        )
    )
    blob["media_kind"] = "video"
    blob["next_platform_action"] = "media.task_wait"
    return blob


def task_wait(
    args: dict[str, Any],
    *,
    thread_id: str | None = None,
) -> dict[str, Any]:
    from evoflow.community.media_generation.async_jobs import poll_until_done, save_media_from_urls
    from evoflow.community.media_generation.asset_recorder import record_task_completed
    from evoflow.community.media_generation.config_helpers import provider_unavailable_message
    from evoflow.community.media_generation.schemas import error_response, success_response
    from evoflow.community.media_generation.tools import (
        _poll_image,
        _poll_video,
        _resolve_outputs_dir,
        _unique_media_save_prefix,
        _path_for_display,
        _media_image_reply_hint,
        _media_deliverable_reply_hint,
    )

    task_id = str(args.get("task_id") or args.get("taskId") or "").strip()
    if not task_id:
        return {"ok": False, "error": "task_id is required"}
    provider = str(args.get("provider") or _DEFAULT_VIDEO_PROVIDER).strip() or _DEFAULT_VIDEO_PROVIDER
    media_kind = str(args.get("media_kind") or args.get("mediaKind") or "video").strip().lower() or "video"
    if media_kind not in {"image", "video"}:
        return {"ok": False, "error": f"unsupported media_kind: {media_kind}"}
    try:
        max_wait = int(args.get("max_wait_seconds") or args.get("maxWaitSeconds") or 600)
    except (TypeError, ValueError):
        max_wait = 600

    kind_gate = "video" if media_kind == "video" else "image"
    err = provider_unavailable_message(provider, media_kind=kind_gate)
    if err:
        return {"ok": False, "error": err, "provider": provider}

    runtime = _fake_runtime(thread_id)
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
            status, _primary, urls = poll_until_done(_poll, max_wait_seconds=max_wait)
        except Exception as exc:
            return _parse_tool_json(error_response(str(exc), provider=provider, task_id=task_id))
        if status.lower() in ("failed", "error", "cancelled") and not urls:
            return _parse_tool_json(
                error_response(
                    f"Task ended with status={status}",
                    provider=provider,
                    task_id=task_id,
                    status=status,
                )
            )

    outputs_dir = _resolve_outputs_dir(runtime)
    local_paths: list[str] = []
    if outputs_dir and urls:
        prefix = _unique_media_save_prefix(media_kind, task_id, url=urls[0] if urls else "")
        local_paths = save_media_from_urls(urls, outputs_dir, prefix=prefix, media_kind=media_kind)

    record_task_completed(
        runtime,
        tool_name="platform.media.task_wait",
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
    if media_kind == "image" and ap:
        next_action = _media_image_reply_hint(ap)
    elif local_paths:
        next_action = _media_deliverable_reply_hint(ap)
    else:
        next_action = "Retry media.task_wait or check provider dashboard."
    msg = f"Saved: {ap}" if ap else ("Task finished." if urls else f"Task status={status}; no download URL yet.")
    blob = _parse_tool_json(
        success_response(
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
    )
    return _enrich_preview(blob, media_kind=media_kind)
