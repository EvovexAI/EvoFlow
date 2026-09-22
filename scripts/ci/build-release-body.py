#!/usr/bin/env python3
"""Build the public GitHub Release body for a desktop release.

Combines the per-version product notes with the static release footer, matching
the behavior of scripts/maintainer/windows/release-evopanel-public.ps1
(Build-CombinedReleaseBody), so tag-driven CI releases carry the same
"What's new / 本版更新" section as manually published ones.

Usage:
    python scripts/ci/build-release-body.py <version> <output-path>

Where <version> is the desktop version (e.g. 1.0.4). The product notes are read
from scripts/maintainer/windows/release-notes/PRODUCT-NOTES-<version>.md.
If that file is missing, the output is just the static footer (no crash), so CI
still publishes a valid release.
"""
from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
FOOTER_PATH = REPO_ROOT / "scripts" / "maintainer" / "windows" / "public-release-body.txt"
NOTES_DIR = REPO_ROOT / "scripts" / "maintainer" / "windows" / "release-notes"
HEADER = "## What's new / 本版更新"


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print("usage: build-release-body.py <version> <output-path>", file=sys.stderr)
        return 2

    version = argv[1].strip().lstrip("v")
    out_path = Path(argv[2]).resolve()

    footer = FOOTER_PATH.read_text(encoding="utf-8").rstrip("\n") if FOOTER_PATH.exists() else ""

    notes_path = NOTES_DIR / f"PRODUCT-NOTES-{version}.md"
    product = ""
    if notes_path.exists():
        product = notes_path.read_text(encoding="utf-8").strip()
    else:
        print(
            f"[build-release-body] No product notes at {notes_path}; "
            "using static footer only.",
            file=sys.stderr,
        )

    parts: list[str] = []
    if product:
        parts.append(f"{HEADER} (v{version})\n")
        parts.append(product)
        parts.append("---")
    if footer:
        parts.append(footer)

    body = "\n\n".join(parts).rstrip("\n") + "\n"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(body, encoding="utf-8")
    print(f"[build-release-body] Wrote {out_path} ({len(body)} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
