"""Rewrite China mirror URLs in backend/uv.lock for GitHub Actions runners.

Local dev may lock against a regional PyPI mirror; CI runners are faster on
PyPI CDN. This script is CI-only and does not modify the committed lockfile.
"""
from __future__ import annotations

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


def main() -> None:
    repo_root = Path(__file__).resolve().parents[2]
    lock_path = repo_root / "backend" / "uv.lock"
    if not lock_path.is_file():
        raise SystemExit(f"uv.lock not found: {lock_path}")

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
