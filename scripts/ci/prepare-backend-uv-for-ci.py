"""Rewrite China mirror URLs in backend/uv.lock for GitHub Actions runners.

Local dev may lock against a regional PyPI mirror; CI runners are faster on
PyPI CDN. This script is CI-only and does not modify the committed lockfile.

Also strips accidental ``path`` / ``editable`` sources for ``pipecat-ai`` so
release jobs do not look for a sibling ``../../pipecat`` checkout.
"""
from __future__ import annotations

import re
from pathlib import Path

REPLACEMENTS = (
    (
        "https://pypi.tuna.tsinghua.edu.cn/packages/",
        "https://files.pythonhosted.org/packages/",
    ),
    (
        "https://pypi.tuna.tsinghua.edu.cn/simple",
        "https://pypi.org/simple",
    ),
)


def _strip_pipecat_path_source(pyproject: Path) -> bool:
    """Remove tool.uv.sources path/editable for pipecat-ai if present."""
    if not pyproject.is_file():
        return False
    text = pyproject.read_text(encoding="utf-8")
    # Match a whole TOML assignment line for pipecat-ai path/editable source.
    pattern = re.compile(
        r"(?m)^\s*pipecat-ai\s*=\s*\{[^}]*\b(?:path|editable)\b[^}]*\}\s*\n?"
    )
    new, n = pattern.subn("", text)
    if n == 0:
        return False
    pyproject.write_text(new, encoding="utf-8")
    print(f"Stripped {n} pipecat-ai path/editable source(s) from {pyproject}")
    return True


def main() -> None:
    repo_root = Path(__file__).resolve().parents[2]
    backend = repo_root / "backend"
    lock_path = backend / "uv.lock"
    if not lock_path.is_file():
        raise SystemExit(f"uv.lock not found: {lock_path}")

    _strip_pipecat_path_source(backend / "pyproject.toml")

    text = lock_path.read_text(encoding="utf-8")
    original = text
    for old, new in REPLACEMENTS:
        text = text.replace(old, new)

    if text == original:
        print("uv.lock already uses PyPI CDN URLs; no rewrite needed.")
        return

    lock_path.write_text(text, encoding="utf-8")
    print(f"Rewrote mirror URLs in {lock_path} for CI (PyPI CDN).")


if __name__ == "__main__":
    main()
