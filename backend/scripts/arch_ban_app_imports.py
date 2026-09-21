"""Architecture guard: keep the evoflow core free of app-layer imports.

Rule R1 (backend/ARCHITECTURE.md): files under backend/packages/harness/evoflow
must NOT import from the application layer (``app.*`` — backend/app or the
harness test shim). New violations fail CI; the baseline of known violations
lives in backend/scripts/arch_ban_app_imports_baseline.txt and may only shrink.

Usage:
    python backend/scripts/arch_ban_app_imports.py            # enforce
    python backend/scripts/arch_ban_app_imports.py --update   # regenerate baseline
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

# evoflow core root (script lives in backend/scripts/).
BACKEND_ROOT = Path(__file__).resolve().parents[1]
CORE_ROOT = BACKEND_ROOT / "packages" / "harness" / "evoflow"
BASELINE = BACKEND_ROOT / "scripts" / "arch_ban_app_imports_baseline.txt"

# Only real import statements count (not comments / strings).
_IMPORT_RE = re.compile(r"^\s*(?:from\s+app[.\s]|import\s+app\.)", re.MULTILINE)


def _current_violations() -> list[str]:
    """Return sorted 'relative/path.py:line' entries importing app.*."""
    out: list[str] = []
    for path in sorted(CORE_ROOT.rglob("*.py")):
        if "__pycache__" in path.parts:
            continue
        try:
            src = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        rel = path.relative_to(CORE_ROOT).as_posix()
        for m in _IMPORT_RE.finditer(src):
            line = src.count("\n", 0, m.start()) + 1
            out.append(f"{rel}:{line}")
    return out


def _load_baseline() -> list[str]:
    if not BASELINE.exists():
        return []
    return [ln.strip() for ln in BASELINE.read_text(encoding="utf-8").splitlines() if ln.strip() and not ln.startswith("#")]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--update",
        action="store_true",
        help="Regenerate the baseline from the current state (only run intentionally).",
    )
    args = parser.parse_args()

    current = _current_violations()
    if args.update:
        BASELINE.write_text(
            "# Baseline for arch_ban_app_imports (evoflow core -> app.* imports).\n# This list may only shrink. New entries require an ARCHITECTURE.md waiver.\n" + "\n".join(current) + ("\n" if current else ""),
            encoding="utf-8",
        )
        print(f"baseline updated: {len(current)} entries -> {BASELINE}")
        return 0

    baseline = set(_load_baseline())
    new = [v for v in current if v not in baseline]
    if new:
        print("FAIL: evoflow core must not import the app layer (rule R1).")
        print(f"Found {len(new)} NEW violation(s) not covered by the baseline:")
        for v in new:
            print(f"  {v}")
        print()
        print("If the dependency is genuinely needed, define a port in")
        print("evoflow/runtime/ and register the adapter from the app layer instead.")
        print("See backend/ARCHITECTURE.md (Phase 1).")
        return 1

    fixed = baseline - set(current)
    if fixed:
        print(f"OK: {len(current)} baseline violation(s) remain; {len(fixed)} resolved —")
        print("consider shrinking the baseline via:")
        print("    python backend/scripts/arch_ban_app_imports.py --update")
    else:
        print(f"OK: no violations ({len(current)} covered by baseline).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
