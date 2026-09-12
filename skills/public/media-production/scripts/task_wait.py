#!/usr/bin/env python3
"""Poll an async video/image task and download to outputs/."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _media_cli import emit_json, run_task_wait  # noqa: E402


def main() -> int:
    p = argparse.ArgumentParser(description="Poll Ark media task until done")
    p.add_argument("--task-id", required=True)
    p.add_argument("--provider", default="jimeng")
    p.add_argument("--media-kind", default="video", choices=("video", "image", "audio"))
    p.add_argument("--max-wait-seconds", type=int, default=600)
    p.add_argument("--output-dir", default="outputs")
    args = p.parse_args()
    emit_json(
        run_task_wait(
            task_id=args.task_id,
            provider=args.provider,
            media_kind=args.media_kind,
            max_wait_seconds=args.max_wait_seconds,
            output_dir=args.output_dir,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
