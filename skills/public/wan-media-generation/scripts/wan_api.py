#!/usr/bin/env python3
"""CLI for DashScope 通义万相 (Wan) image and video generation."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _bootstrap import ensure_evoflow_importable  # noqa: E402
from _vendor_cli import emit_json, run_image_generate, run_task_wait, run_video_generate  # noqa: E402

PROVIDER = "wan"


def main() -> int:
    ensure_evoflow_importable()
    p = argparse.ArgumentParser(description="DashScope Wan image/video generation")
    sub = p.add_subparsers(dest="command", required=True)

    image = sub.add_parser("image", help="Text-to-image or image-to-image")
    image.add_argument("--prompt", required=True)
    image.add_argument("--mode", default="text2image", choices=("text2image", "image2image"))
    image.add_argument("--reference-image-urls", default=None, help="Comma-separated or JSON array")
    image.add_argument("--aspect-ratio", default="16:9")
    image.add_argument("--max-wait-seconds", type=int, default=300)
    image.add_argument("--output-dir", default="outputs")

    video = sub.add_parser("video", help="Submit text/image-to-video task")
    video.add_argument("--prompt", required=True)
    video.add_argument("--mode", default="image2video", choices=("text2video", "image2video"))
    video.add_argument("--first-frame-url", default=None)
    video.add_argument("--duration", type=int, default=5)
    video.add_argument("--aspect-ratio", default="16:9")
    video.add_argument("--output-dir", default="outputs")
    video.add_argument("--max-wait-seconds", type=int, default=600)
    video.add_argument("--poll", action="store_true", help="Poll until done and download")

    task = sub.add_parser("task-get", help="Poll async task and download")
    task.add_argument("--task-id", required=True)
    task.add_argument("--media-kind", default="video", choices=("video", "image"))
    task.add_argument("--max-wait-seconds", type=int, default=600)
    task.add_argument("--output-dir", default="outputs")

    args = p.parse_args()
    if args.command == "image":
        emit_json(
            run_image_generate(
                provider=PROVIDER,
                prompt=args.prompt,
                mode=args.mode,
                reference_image_urls=args.reference_image_urls,
                aspect_ratio=args.aspect_ratio,
                max_wait_seconds=args.max_wait_seconds,
                output_dir=args.output_dir,
            )
        )
    elif args.command == "video":
        emit_json(
            run_video_generate(
                provider=PROVIDER,
                prompt=args.prompt,
                mode=args.mode,
                first_frame_url=args.first_frame_url,
                duration=args.duration,
                aspect_ratio=args.aspect_ratio,
                output_dir=args.output_dir,
                max_wait_seconds=args.max_wait_seconds,
                poll=args.poll,
            )
        )
    else:
        emit_json(
            run_task_wait(
                provider=PROVIDER,
                task_id=args.task_id,
                media_kind=args.media_kind,
                max_wait_seconds=args.max_wait_seconds,
                output_dir=args.output_dir,
            )
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
