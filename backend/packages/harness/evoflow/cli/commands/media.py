"""evoflow media — 图/视频生成与目录（对齐 platform media.*）。"""

from __future__ import annotations

import argparse

from evoflow.admin.errors import ValidationError
from evoflow.cli.common import add_json_input_flags, add_output_flags, load_json_payload


def register(subparsers: argparse._SubParsersAction) -> None:
    parser = subparsers.add_parser(
        "media",
        help="Media catalog / generate / wait (platform: media.*)",
    )
    sub = parser.add_subparsers(dest="media_cmd", required=True)

    cat_p = sub.add_parser("catalog", help="Media model catalog (platform: media.catalog)")
    cat_p.add_argument("--tier", "--tier-id", dest="tier_id", default="", help="Optional tier filter")
    add_output_flags(cat_p)
    cat_p.set_defaults(handler=_catalog)

    st_p = sub.add_parser("status", help="Media backend status (platform: media.status)")
    add_output_flags(st_p)
    st_p.set_defaults(handler=_status)

    img_p = sub.add_parser(
        "generate-image",
        help="Generate image (platform: media.generate_image)",
        description="JSON via --file/--stdin can supply full args; CLI flags override.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    img_p.add_argument("--prompt", "-p", default="", help="Image prompt")
    img_p.add_argument("--model", default="", help="Model id")
    img_p.add_argument("--mode", default="", help="Generation mode")
    img_p.add_argument("--aspect-ratio", default="", help="e.g. 1:1 / 16:9")
    img_p.add_argument("--provider", default="", help="Provider override")
    img_p.add_argument("--max-wait-seconds", type=int, default=0)
    add_json_input_flags(img_p)
    add_output_flags(img_p)
    img_p.set_defaults(handler=_generate_image)

    vid_p = sub.add_parser(
        "generate-video",
        help="Generate video (platform: media.generate_video)",
        description="JSON via --file/--stdin can supply full args; CLI flags override.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    vid_p.add_argument("--prompt", "-p", default="", help="Video prompt")
    vid_p.add_argument("--model", default="", help="Model id")
    vid_p.add_argument("--mode", default="", help="Generation mode")
    vid_p.add_argument("--first-frame-url", default="")
    vid_p.add_argument("--last-frame-url", default="")
    vid_p.add_argument("--duration", type=int, default=0)
    vid_p.add_argument("--resolution", default="")
    vid_p.add_argument("--aspect-ratio", default="")
    vid_p.add_argument("--provider", default="")
    vid_p.add_argument("--seed", type=int, default=None)
    add_json_input_flags(vid_p)
    add_output_flags(vid_p)
    vid_p.set_defaults(handler=_generate_video)

    wait_p = sub.add_parser("task-wait", help="Wait for media task (platform: media.task_wait)")
    wait_p.add_argument("task_id")
    wait_p.add_argument("--provider", default="")
    wait_p.add_argument("--media-kind", default="", help="image|video")
    wait_p.add_argument("--max-wait-seconds", type=int, default=0)
    add_output_flags(wait_p)
    wait_p.set_defaults(handler=_task_wait)


def _catalog(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import media_catalog

    body: dict = {}
    tier = str(getattr(args, "tier_id", "") or "").strip()
    if tier:
        body["tier_id"] = tier
    return media_catalog(body)


def _status(_args: argparse.Namespace):
    from evoflow.admin.platform_handlers import media_status

    return media_status({})


def _merge_payload(args: argparse.Namespace, flag_map: dict[str, object]) -> dict:
    payload = load_json_payload(args)
    body = dict(payload) if isinstance(payload, dict) else {}
    for key, val in flag_map.items():
        if val is None:
            continue
        if isinstance(val, str) and not val.strip():
            continue
        if isinstance(val, (int, float)) and val == 0 and key.endswith("seconds"):
            continue
        if isinstance(val, int) and val == 0 and key in {"duration"}:
            continue
        body[key] = val
    return body


def _generate_image(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import media_generate_image

    body = _merge_payload(
        args,
        {
            "prompt": str(getattr(args, "prompt", "") or ""),
            "model": str(getattr(args, "model", "") or ""),
            "mode": str(getattr(args, "mode", "") or ""),
            "aspect_ratio": str(getattr(args, "aspect_ratio", "") or ""),
            "provider": str(getattr(args, "provider", "") or ""),
            "max_wait_seconds": int(getattr(args, "max_wait_seconds", 0) or 0),
        },
    )
    if not str(body.get("prompt") or "").strip():
        raise ValidationError("prompt is required (--prompt or JSON.prompt)")
    return media_generate_image(body)


def _generate_video(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import media_generate_video

    body = _merge_payload(
        args,
        {
            "prompt": str(getattr(args, "prompt", "") or ""),
            "model": str(getattr(args, "model", "") or ""),
            "mode": str(getattr(args, "mode", "") or ""),
            "first_frame_url": str(getattr(args, "first_frame_url", "") or ""),
            "last_frame_url": str(getattr(args, "last_frame_url", "") or ""),
            "duration": int(getattr(args, "duration", 0) or 0),
            "resolution": str(getattr(args, "resolution", "") or ""),
            "aspect_ratio": str(getattr(args, "aspect_ratio", "") or ""),
            "provider": str(getattr(args, "provider", "") or ""),
            "seed": getattr(args, "seed", None),
        },
    )
    if not str(body.get("prompt") or "").strip():
        raise ValidationError("prompt is required (--prompt or JSON.prompt)")
    return media_generate_video(body)


def _task_wait(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import media_task_wait

    body: dict = {"task_id": args.task_id}
    provider = str(getattr(args, "provider", "") or "").strip()
    kind = str(getattr(args, "media_kind", "") or "").strip()
    wait = int(getattr(args, "max_wait_seconds", 0) or 0)
    if provider:
        body["provider"] = provider
    if kind:
        body["media_kind"] = kind
    if wait:
        body["max_wait_seconds"] = wait
    return media_task_wait(body)
