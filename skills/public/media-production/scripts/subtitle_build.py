#!/usr/bin/env python3
"""Build SRT/VTT subtitles from narration script."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _media_cli import emit_json, run_subtitle_build  # noqa: E402


def main() -> int:
    p = argparse.ArgumentParser(description="Build subtitles from script text")
    p.add_argument("--text", required=True, help="Full narration / subtitle script")
    p.add_argument("--audio-path", default=None, help="Optional outputs/ mp4/mp3 for timing")
    p.add_argument("--format", dest="subtitle_format", default="srt", choices=("srt", "vtt"))
    p.add_argument("--locale", default="zh", choices=("zh", "en"))
    p.add_argument("--output-filename", default="subtitles.srt")
    p.add_argument("--output-dir", default="outputs")
    args = p.parse_args()
    emit_json(
        run_subtitle_build(
            text=args.text,
            audio_path=args.audio_path,
            subtitle_format=args.subtitle_format,
            locale=args.locale,
            output_filename=args.output_filename,
            output_dir=args.output_dir,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
