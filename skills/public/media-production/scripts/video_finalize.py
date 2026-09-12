#!/usr/bin/env python3
"""Concat shot MP4s, polish color, and upscale to target resolution (default 4K)."""

from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _media_cli import emit_json, resolve_outputs_dir, success_response, error_response  # noqa: E402


def _resolve_media(outputs_dir: Path, rel_or_abs: str) -> Path:
    s = str(rel_or_abs or "").strip().replace("\\", "/")
    if s.startswith("outputs/"):
        p = outputs_dir / s[len("outputs/") :]
    else:
        p = Path(s)
        if not p.is_absolute():
            p = outputs_dir / p.name
    if not p.is_file():
        raise FileNotFoundError(f"File not found: {rel_or_abs}")
    return p.resolve()


def _parse_resolution(res: str) -> tuple[int, int]:
    raw = str(res or "3840x2160").strip().lower()
    if raw == "4k":
        return 3840, 2160
    if raw == "1080p":
        return 1920, 1080
    m = re.match(r"^(\d+)\s*[x*×]\s*(\d+)$", raw)
    if m:
        return int(m.group(1)), int(m.group(2))
    return 3840, 2160


def run_video_finalize(
    *,
    inputs: list[str],
    output_filename: str = "gufeng-travel-final-4k.mp4",
    resolution: str = "4k",
    output_dir: str | None = None,
) -> str:
    if not shutil.which("ffmpeg"):
        return error_response("ffmpeg not found in PATH.")
    if not inputs:
        return error_response("No input videos provided.")

    outputs_dir = resolve_outputs_dir(output_dir)
    try:
        paths = [_resolve_media(outputs_dir, item) for item in inputs]
    except FileNotFoundError as exc:
        return error_response(str(exc))

    width, height = _parse_resolution(resolution)
    safe_name = re.sub(r"[^\w.\-]", "_", output_filename.strip() or "final-4k.mp4")
    if not safe_name.endswith(".mp4"):
        safe_name += ".mp4"
    dest = outputs_dir / safe_name

    # Gentle polish: upscale + mild contrast/sat + light sharpen (cinematic, not HDR-blasted).
    vf = (
        f"scale={width}:{height}:flags=lanczos,"
        "eq=contrast=1.04:saturation=1.06:brightness=0.015,"
        "unsharp=3:3:0.35"
    )

    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8") as tmp:
        for p in paths:
            tmp.write(f"file '{p.as_posix()}'\n")
        list_path = tmp.name

    cmd = [
        "ffmpeg",
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        list_path,
        "-vf",
        vf,
        "-c:v",
        "libx264",
        "-preset",
        "slow",
        "-crf",
        "17",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-movflags",
        "+faststart",
        str(dest),
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True, text=True, timeout=1200)
    except subprocess.CalledProcessError as exc:
        return error_response(f"ffmpeg finalize failed: {(exc.stderr or exc.stdout or str(exc))[:800]}")
    except Exception as exc:
        return error_response(str(exc))
    finally:
        try:
            Path(list_path).unlink(missing_ok=True)
        except OSError:
            pass

    ap = str(dest.resolve()).replace("\\", "/")
    return success_response(
        status="succeeded",
        local_path=f"outputs/{safe_name}",
        absolute_path=ap,
        message=f"Finalized {len(paths)} clips → outputs/{safe_name} ({width}x{height})",
    )


def main() -> int:
    p = argparse.ArgumentParser(description="Concat + polish + upscale workflow finals")
    p.add_argument(
        "--inputs",
        required=True,
        help="Comma-separated mp4 paths (outputs/… or absolute), in shot order",
    )
    p.add_argument("--output-filename", default="gufeng-travel-final-4k.mp4")
    p.add_argument("--resolution", default="4k", help="4k | 1080p | WxH")
    p.add_argument("--output-dir", default="outputs")
    args = p.parse_args()
    items = [x.strip() for x in str(args.inputs).split(",") if x.strip()]
    emit_json(
        run_video_finalize(
            inputs=items,
            output_filename=args.output_filename,
            resolution=args.resolution,
            output_dir=args.output_dir,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
