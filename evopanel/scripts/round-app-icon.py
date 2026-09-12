#!/usr/bin/env python3
"""Apply rounded corners to a square app icon (transparent outside the mask)."""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw


def rounded_rect_mask(size: int, radius: float) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def apply_rounded_corners(
    src: Path,
    dst: Path,
    *,
    radius_ratio: float = 0.23,
) -> None:
    img = Image.open(src).convert("RGBA")
    size = img.width
    if img.height != size:
        raise ValueError(f"Expected square image, got {img.width}x{img.height}")

    radius = max(1, round(size * radius_ratio))
    mask = rounded_rect_mask(size, radius)
    _r, _g, _b, a = img.split()
    img.putalpha(ImageChops.multiply(a, mask))
    dst.parent.mkdir(parents=True, exist_ok=True)
    img.save(dst, "PNG", optimize=True)
    print(f"Wrote {dst} ({size}x{size}, radius={radius}px)")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("src", type=Path, help="Source square PNG")
    parser.add_argument("dst", type=Path, nargs="?", help="Output PNG (default: overwrite src)")
    parser.add_argument(
        "--radius-ratio",
        type=float,
        default=0.23,
        help="Corner radius as fraction of side length (default: 0.23)",
    )
    args = parser.parse_args()
    dst = args.dst or args.src
    apply_rounded_corners(args.src, dst, radius_ratio=args.radius_ratio)


if __name__ == "__main__":
    main()
