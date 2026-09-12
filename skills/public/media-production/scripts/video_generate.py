#!/usr/bin/env python3
"""Submit a Seedance video generation task (Volcengine Ark / jimeng)."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _media_cli import emit_json, run_video_generate  # noqa: E402


def main() -> int:
    p = argparse.ArgumentParser(description="Seedance video submit (Volcengine Ark / jimeng)")
    p.add_argument("--prompt", required=True, help="Motion + narration for this shot")
    p.add_argument("--mode", default="image2video", choices=("text2video", "image2video"))
    p.add_argument("--provider", default="jimeng")
    p.add_argument("--first-frame-url", required=True, help="URL or outputs/ path from image_generate")
    p.add_argument("--duration", type=int, default=5)
    p.add_argument("--aspect-ratio", default="16:9")
    p.add_argument(
        "--resolution",
        default=None,
        help="Seedance resolution: 4k | 1080p | 720p (default 1080p)",
    )
    p.add_argument(
        "--quality",
        default=None,
        help="Alias for resolution tier: 4k | 1080p | 720p",
    )
    p.add_argument(
        "--generate-audio",
        default="true",
        choices=("true", "false"),
        help="Seedance native audio (default true)",
    )
    p.add_argument("--output-dir", default="outputs")
    args = p.parse_args()
    gen_audio = None if args.generate_audio == "true" else False
    emit_json(
        run_video_generate(
            prompt=args.prompt,
            mode=args.mode,
            provider=args.provider or None,
            first_frame_url=args.first_frame_url,
            duration=args.duration,
            aspect_ratio=args.aspect_ratio,
            resolution=args.resolution,
            quality=args.quality,
            generate_audio=gen_audio,
            output_dir=args.output_dir,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
