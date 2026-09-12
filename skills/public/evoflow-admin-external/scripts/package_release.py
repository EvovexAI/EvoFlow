#!/usr/bin/env python3
"""Build downloadable evoflow-admin-external release artifacts.

Produces (official-aligned layout):
  evoflow-admin-external-<ver>.zip     # preferred for EvoFlow install
  evoflow-admin-external-<ver>.skill   # same ZIP bytes, .skill extension
  SHA256SUMS.txt

Usage (from repo root or any cwd):
  python skills/public/evoflow-admin-external/scripts/package_release.py
  python skills/public/evoflow-admin-external/scripts/package_release.py --out .tmp/skills-dist
  EVOFLOW_RELEASE_OUT=/path/to/out python …/package_release.py
"""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import sys
import zipfile
from pathlib import Path

EXCLUDE_DIR_NAMES = {"__pycache__", "node_modules", ".git"}
EXCLUDE_FILE_NAMES = {".DS_Store"}
EXCLUDE_SUFFIXES = {".pyc"}


def _skill_root() -> Path:
    return Path(__file__).resolve().parents[1]


def _read_version(skill_dir: Path) -> str:
    version_file = skill_dir / "VERSION"
    if version_file.is_file():
        text = version_file.read_text(encoding="utf-8").strip()
        if text:
            return text
    skill_md = (skill_dir / "SKILL.md").read_text(encoding="utf-8")
    m = re.search(r"^version:\s*[\"']?([^\"'\s]+)[\"']?\s*$", skill_md, re.M)
    if not m:
        raise SystemExit("VERSION file missing and no version: in SKILL.md")
    return m.group(1).strip()


def _should_skip(rel: Path) -> bool:
    if any(p in EXCLUDE_DIR_NAMES for p in rel.parts):
        return True
    if rel.name in EXCLUDE_FILE_NAMES:
        return True
    if rel.suffix in EXCLUDE_SUFFIXES:
        return True
    return False


def _validate_minimal(skill_dir: Path) -> None:
    skill_md = skill_dir / "SKILL.md"
    if not skill_md.is_file():
        raise SystemExit(f"SKILL.md not found: {skill_md}")
    text = skill_md.read_text(encoding="utf-8")
    if not text.startswith("---"):
        raise SystemExit("SKILL.md must start with YAML frontmatter")
    if "name: evoflow-admin-external" not in text.split("---", 2)[1]:
        raise SystemExit("frontmatter name must be evoflow-admin-external")
    if "description:" not in text.split("---", 2)[1]:
        raise SystemExit("frontmatter description required")


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _write_zip(skill_dir: Path, zip_path: Path) -> list[str]:
    added: list[str] = []
    top = skill_dir.name
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(skill_dir.rglob("*")):
            if not path.is_file():
                continue
            rel = path.relative_to(skill_dir)
            if _should_skip(rel):
                continue
            arcname = f"{top}/{rel.as_posix()}"
            zf.write(path, arcname)
            added.append(arcname)
    return added


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help="Output directory (default: $EVOFLOW_RELEASE_OUT or <repo>/.tmp/skills-dist)",
    )
    parser.add_argument(
        "--web-public",
        type=Path,
        default=None,
        help=(
            "Also copy zip/skill/SHA256SUMS into a website public downloads dir "
            "(default: <repo>/website/apps/web/public/skills/downloads when that tree exists)"
        ),
    )
    parser.add_argument(
        "--no-web-sync",
        action="store_true",
        help="Skip syncing into website public/skills/downloads",
    )
    args = parser.parse_args()

    skill_dir = _skill_root()
    _validate_minimal(skill_dir)
    version = _read_version(skill_dir)

    repo_skills = skill_dir.parents[1]  # …/skills
    repo_root = repo_skills.parent
    env_out = os.environ.get("EVOFLOW_RELEASE_OUT", "").strip()
    if args.out is not None:
        out_dir = args.out.resolve()
    elif env_out:
        out_dir = Path(env_out).expanduser().resolve()
    else:
        out_dir = (repo_root / ".tmp" / "skills-dist").resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    base = f"evoflow-admin-external-{version}"
    zip_path = out_dir / f"{base}.zip"
    skill_path = out_dir / f"{base}.skill"
    sums_path = out_dir / "SHA256SUMS.txt"

    added = _write_zip(skill_dir, zip_path)
    # Identical bytes for .skill alias
    skill_path.write_bytes(zip_path.read_bytes())

    lines = [
        f"{_sha256(zip_path)}  {zip_path.name}",
        f"{_sha256(skill_path)}  {skill_path.name}",
        "",
    ]
    sums_path.write_text("\n".join(lines), encoding="utf-8")

    print(f"skill_dir: {skill_dir}")
    print(f"version:   {version}")
    print(f"files:     {len(added)}")
    print(f"wrote:     {zip_path}")
    print(f"wrote:     {skill_path}")
    print(f"wrote:     {sums_path}")

    web_dir: Path | None = None
    if not args.no_web_sync:
        if args.web_public is not None:
            web_dir = args.web_public.resolve()
        else:
            candidate = repo_root / "website" / "apps" / "web" / "public" / "skills" / "downloads"
            if candidate.parent.parent.exists():
                web_dir = candidate
    if web_dir is not None:
        import shutil

        web_dir.mkdir(parents=True, exist_ok=True)
        for src in (zip_path, skill_path, sums_path):
            dest = web_dir / src.name
            shutil.copy2(src, dest)
            print(f"synced:    {dest}")
        print(f"site URL:  /skills/downloads/{zip_path.name}")

    print("Install with:")
    print(f"  evoflow skills install {zip_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
