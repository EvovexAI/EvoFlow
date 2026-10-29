#!/usr/bin/env python3
"""Regression guard for macOS 12 / Safari < 16.4 lookbehind crashes (issue #95).

Exit 0 when:
  - src/boot/0-polyfills.js exists and mentions SafeRegExp / lookbehind probe
  - main.js statically imports 0-polyfills before other local modules
  - first-party src has no lookbehind regex literals or (?<= / (?<! in /.../ forms
  - if dist/ exists: no raw lookbehind regex literals in JS chunks; dynamic
    new RegExp("(?<=...") must appear only inside try/catch or after SafeRegExp

Usage:
  python scripts/check-macos12-compat.py
  python scripts/check-macos12-compat.py --dist dist
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
# Flag source lines containing lookbehind tokens outside comments.
LOOKBEHIND_TOKEN = re.compile(r"\(\?<[=!]")
SAFE_REGEXP_MARKERS = ("SafeRegExp", "(?<=a)b", "installMacOs12SafeRegExp")


def iter_source_files(src: Path):
    for path in src.rglob("*"):
        if not path.is_file():
            continue
        if path.suffix not in {".js", ".ts", ".tsx", ".mjs", ".cjs"}:
            continue
        # Polyfill intentionally contains lookbehind strings for probing/stripping.
        if path.name == "0-polyfills.js":
            continue
        yield path


def line_is_comment_or_compat(line: str) -> bool:
    stripped = line.strip()
    return (
        stripped.startswith("//")
        or stripped.startswith("*")
        or stripped.startswith("/*")
        or "COMPAT(macOS12-JSC)" in line
    )


def check_polyfill(errors: list[str]) -> None:
    poly = ROOT / "src" / "boot" / "0-polyfills.js"
    if not poly.is_file():
        errors.append("missing src/boot/0-polyfills.js")
        return
    text = poly.read_text(encoding="utf-8")
    for marker in SAFE_REGEXP_MARKERS:
        if marker not in text:
            errors.append(f"0-polyfills.js missing marker: {marker}")


def check_main_import_order(errors: list[str]) -> None:
    main = ROOT / "src" / "main.js"
    if not main.is_file():
        errors.append("missing src/main.js")
        return
    text = main.read_text(encoding="utf-8")
    # First side-effect import among relative boot/lib imports should be polyfills.
    imports = re.findall(r"^\s*import\s+(?:[^'\"]+\s+from\s+)?['\"]([^'\"]+)['\"]", text, re.M)
    if not imports:
        errors.append("main.js has no imports")
        return
    first_local = next((i for i in imports if i.startswith(".")), None)
    if first_local != "./boot/0-polyfills.js":
        errors.append(
            f"main.js first local import must be ./boot/0-polyfills.js, got {first_local!r}"
        )


def check_first_party(errors: list[str]) -> None:
    src = ROOT / "src"
    for path in iter_source_files(src):
        rel = path.relative_to(ROOT).as_posix()
        for lineno, line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
            if line_is_comment_or_compat(line):
                continue
            if LOOKBEHIND_TOKEN.search(line):
                errors.append(f"{rel}:{lineno}: lookbehind token {line.strip()[:120]}")


def check_dist(dist: Path, errors: list[str]) -> None:
    if not dist.is_dir():
        return
    # Unprotected lookbehind *literals* like =/(?<=...) /  (parse-time crash on JSC).
    assign_literal = re.compile(r"=\s*/\(\?<[=!]")
    for path in dist.rglob("*.js"):
        text = path.read_text(encoding="utf-8", errors="replace")
        try:
            rel = path.relative_to(ROOT).as_posix()
        except ValueError:
            rel = str(path)
        if assign_literal.search(text):
            errors.append(f"{rel}: lookbehind regex literal assigned in dist chunk")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dist", type=Path, default=ROOT / "dist")
    args = parser.parse_args()
    errors: list[str] = []
    check_polyfill(errors)
    check_main_import_order(errors)
    check_first_party(errors)
    if args.dist.is_dir():
        check_dist(args.dist, errors)
    if errors:
        print("macOS 12 compat check FAILED:", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        return 1
    print("macOS 12 compat check OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
