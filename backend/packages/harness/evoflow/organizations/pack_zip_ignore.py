"""Rules for what NOT to put into a published org-pack zip.

Publish is for **app/pack source** (manifest, agents, skills, extension UI, docs),
not runtime data, model envs, remake outputs, or downloaded media.

Override / extend per pack with a root ``.evoflowpackignore`` (gitignore-like,
one pattern per line).
"""

from __future__ import annotations

import fnmatch
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

IGNORE_FILENAME = ".evoflowpackignore"

# Directory names skipped at any depth.
DEFAULT_SKIP_DIR_NAMES = frozenset(
    {
        # VCS
        ".git",
        ".svn",
        ".hg",
        # Dependencies / runtimes
        "node_modules",
        ".venv",
        "venv",
        "env",
        ".tox",
        "__pycache__",
        ".mypy_cache",
        ".pytest_cache",
        ".ruff_cache",
        ".next",
        ".turbo",
        "coverage",
        ".cache",
        ".remotion",
        ".parcel-cache",
        ".svelte-kit",
        # Generated / work products (never ship these in a share pack)
        "remakes",
        "deliverables",
        "trash",
        "sessions",
        "out",
        "output",
        "outputs",
        "videos",
        "downloads",
        "productions",
        "generated",
        "uploads",
        "work",  # per-project workspaces / case media (e.g. infinite-canvas)
        ".codex-tmp",
        ".playwright-cli",
        ".chrome-profile",  # Playwright/Puppeteer browser profiles
        "ChromeExtMalware.store",
        "site-packages",  # embedded interpreter trees
        ".git-embedded-backup",
        ".evoflow",  # local code index / machine state under pack root
    }
)

# File suffixes skipped at any depth (media / dumps / nested archives).
DEFAULT_SKIP_SUFFIXES = frozenset(
    {
        ".mp4",
        ".mov",
        ".webm",
        ".mkv",
        ".avi",
        ".wav",
        ".mp3",
        ".flac",
        ".aac",
        ".m4a",
        ".ogg",
        ".zip",
        ".zip.tmp",
        ".exe",
        ".whl",
        ".raw",
    }
)

DEFAULT_SKIP_FILE_NAMES = frozenset(
    {
        ".ds_store",
        "thumbs.db",
        "desktop.ini",
    }
)


def _load_pack_ignore_patterns(src_dir: Path) -> list[str]:
    path = src_dir / IGNORE_FILENAME
    if not path.is_file():
        return []
    patterns: list[str] = []
    try:
        for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            patterns.append(line)
    except OSError as e:
        logger.debug("read %s failed: %s", path, e)
    return patterns


def _match_pack_pattern(rel_posix: str, parts: tuple[str, ...], pattern: str) -> bool:
    """Minimal gitignore-ish match against a pack-relative path."""
    pat = pattern.strip()
    if not pat:
        return False
    # Directory-only patterns (trailing /): match that prefix tree
    dir_only = pat.endswith("/")
    if dir_only:
        pat = pat.rstrip("/")
    # Root-anchored
    anchored = pat.startswith("/")
    if anchored:
        pat = pat.lstrip("/")
    # Multi-segment path (e.g. craft/cache or /craft/cache/)
    if "/" in pat:
        if rel_posix == pat or rel_posix.startswith(pat + "/"):
            return True
        if not anchored and pat in rel_posix.split("/")[:]:
            # also allow unmatched mid-path: a/craft/cache/x
            joined = "/".join(parts)
            if joined == pat or f"/{pat}/" in f"/{joined}/":
                return True
        return fnmatch.fnmatch(rel_posix, pat) or fnmatch.fnmatch(rel_posix, pat + "/**")
    # Single segment / glob on a path part
    if pat in parts:
        return True
    if any(fnmatch.fnmatch(part, pat) for part in parts):
        return True
    return fnmatch.fnmatch(rel_posix, pat) or fnmatch.fnmatch(parts[-1] if parts else "", pat)


def should_skip_pack_path(path: Path, src_dir: Path, *, extra_patterns: list[str] | None = None) -> bool:
    """Return True if ``path`` must not be written into the publish zip."""
    try:
        rel = path.relative_to(src_dir)
    except ValueError:
        return True
    parts = rel.parts
    if not parts:
        return True
    # Never pack the ignore file itself? Keep it — useful for recipients.
    name_lower = parts[-1].lower()
    if name_lower in DEFAULT_SKIP_FILE_NAMES:
        return True
    # Rotated DB / config dumps: db.json.bak-20261108-…
    if ".bak" in name_lower:
        return True
    if any(part in DEFAULT_SKIP_DIR_NAMES for part in parts):
        return True
    suffix = path.suffix.lower()
    if suffix in DEFAULT_SKIP_SUFFIXES:
        return True
    # Multi-suffix like .tar.gz
    if path.name.lower().endswith(".zip.tmp"):
        return True

    rel_posix = rel.as_posix()
    patterns = list(extra_patterns or [])
    for pat in patterns:
        if _match_pack_pattern(rel_posix, parts, pat):
            return True
    return False


def iter_pack_files(src_dir: Path) -> list[Path]:
    """List files under ``src_dir`` that should be included in a publish zip."""
    root = src_dir.resolve()
    patterns = _load_pack_ignore_patterns(root)
    out: list[Path] = []
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        if should_skip_pack_path(path, root, extra_patterns=patterns):
            continue
        out.append(path)
    return out


__all__ = [
    "IGNORE_FILENAME",
    "DEFAULT_SKIP_DIR_NAMES",
    "DEFAULT_SKIP_SUFFIXES",
    "should_skip_pack_path",
    "iter_pack_files",
]
