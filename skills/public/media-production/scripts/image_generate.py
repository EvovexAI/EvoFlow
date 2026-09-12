#!/usr/bin/env python3
"""Generate an image via Volcengine Ark Seedream (poll + download in one call)."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _media_cli import emit_json, run_image_generate  # noqa: E402


def main() -> int:
    p = argparse.ArgumentParser(description="Seedream image generation (Volcengine Ark / jimeng)")
    p.add_argument("--prompt", required=True, help="Single still-frame prompt (≤500 chars)")
    p.add_argument("--mode", default="text2image", choices=("text2image", "image2image"))
    p.add_argument("--provider", default="jimeng", help="Default jimeng (Volcengine Ark)")
    p.add_argument("--reference-image-urls", default=None, help="Comma-separated or JSON array")
    p.add_argument("--aspect-ratio", default="16:9")
    p.add_argument("--size", default=None, help="Explicit WxH (overrides quality tier)")
    p.add_argument(
        "--quality",
        default=None,
        help="Output tier: 4k | 1080p | standard (maps to Seedream size)",
    )
    p.add_argument("--max-wait-seconds", type=int, default=300)
    p.add_argument("--output-dir", default="outputs", help="Directory for saved images")
    args = p.parse_args()
    emit_json(
        run_image_generate(
            prompt=args.prompt,
            mode=args.mode,
            provider=args.provider or None,
            reference_image_urls=args.reference_image_urls,
            aspect_ratio=args.aspect_ratio,
            size=args.size,
            quality=args.quality,
            max_wait_seconds=args.max_wait_seconds,
            output_dir=args.output_dir,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
