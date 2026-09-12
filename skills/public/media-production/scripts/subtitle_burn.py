#!/usr/bin/env python3
"""Burn hard subtitles into MP4 with ffmpeg."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _media_cli import emit_json, run_subtitle_burn  # noqa: E402


def main() -> int:
    p = argparse.ArgumentParser(description="Burn SRT subtitles into video (ffmpeg)")
    p.add_argument("--video-path", required=True, help="outputs/… mp4")
    p.add_argument("--subtitle-path", required=True, help="outputs/subtitles.srt")
    p.add_argument("--output-filename", default=None)
    p.add_argument("--output-dir", default="outputs")
    args = p.parse_args()
    emit_json(
        run_subtitle_burn(
            video_path=args.video_path,
            subtitle_path=args.subtitle_path,
            output_filename=args.output_filename,
            output_dir=args.output_dir,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
