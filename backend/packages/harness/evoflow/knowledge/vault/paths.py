"""Strict vault-relative path validation and allowlist checks."""

from __future__ import annotations

import os
from pathlib import Path, PurePosixPath

from evoflow.knowledge.vault.errors import PathEscapeDetectedError, PathForbiddenError


def normalize_vault_relative_path(raw: str) -> str:
    """Normalize a note path to vault-relative POSIX form.

    Raises:
        PathEscapeDetectedError: absolute paths, ``..``, NUL, or empty.
    """
    text = str(raw or "").replace("\x00", "")
    if not text or not text.strip():
        raise PathEscapeDetectedError("path must not be empty", code="path_escape_detected")
    if "\x00" in str(raw or ""):
        raise PathEscapeDetectedError("NUL byte in path", code="path_escape_detected")

    # Reject Windows / Unix absolute paths before joining.
    stripped = text.strip().replace("\\", "/")
    if stripped.startswith("/") or stripped.startswith("~"):
        raise PathEscapeDetectedError("absolute paths are forbidden", code="path_escape_detected")
    if len(stripped) >= 2 and stripped[1] == ":" and stripped[0].isalpha():
        raise PathEscapeDetectedError("absolute paths are forbidden", code="path_escape_detected")

    parts = PurePosixPath(stripped).parts
    if any(p == ".." for p in parts):
        raise PathEscapeDetectedError("directory traversal ('..') is forbidden", code="path_escape_detected")
    if any(p == "" for p in parts):
        raise PathEscapeDetectedError("invalid path", code="path_escape_detected")

    normalized = PurePosixPath(*parts).as_posix() if parts else ""
    if not normalized or normalized == ".":
        raise PathEscapeDetectedError("path must not be empty", code="path_escape_detected")
    return normalized


def resolve_inside_vault(vault_root: str | Path, relative: str) -> Path:
    """Resolve ``relative`` under ``vault_root`` and ensure it stays inside.

    Uses ``resolve()`` to catch symlink escapes.
    """
    rel = normalize_vault_relative_path(relative)
    root = Path(vault_root).expanduser()
    try:
        root_resolved = root.resolve(strict=False)
    except OSError as exc:
        raise PathEscapeDetectedError(f"cannot resolve vault root: {exc}", cause=exc) from exc

    candidate = (root_resolved / Path(*PurePosixPath(rel).parts)).resolve(strict=False)
    try:
        candidate.relative_to(root_resolved)
    except ValueError as exc:
        raise PathEscapeDetectedError(
            "resolved path escapes vault root (symlink escape?)",
            cause=exc,
        ) from exc
    return candidate


def path_allowed(relative: str, allowlist: list[str] | None) -> bool:
    """Return True if ``relative`` is covered by allowlist entries.

    Allowlist entries are vault-relative prefixes. ``*`` or empty list means all.
    """
    rel = normalize_vault_relative_path(relative)
    rules = list(allowlist or [])
    if not rules or "*" in rules or "**" in rules:
        return True
    for rule in rules:
        rule_s = str(rule or "").strip().replace("\\", "/").strip("/")
        if not rule_s or rule_s == "*":
            return True
        # Exact file or directory prefix
        if rel == rule_s or rel.startswith(rule_s.rstrip("/") + "/"):
            return True
        # Allow matching without trailing .md when rule is a folder
        if rule_s.endswith("/**"):
            prefix = rule_s[:-3].rstrip("/")
            if rel == prefix or rel.startswith(prefix + "/"):
                return True
    return False


def assert_read_allowed(relative: str, allowlist: list[str] | None) -> str:
    rel = normalize_vault_relative_path(relative)
    if not path_allowed(rel, allowlist):
        raise PathForbiddenError(f"read not allowed for path: {rel}", code="path_forbidden")
    return rel


def assert_write_allowed(relative: str, allowlist: list[str] | None) -> str:
    rel = normalize_vault_relative_path(relative)
    if not path_allowed(rel, allowlist):
        raise PathForbiddenError(f"write not allowed for path: {rel}", code="path_forbidden")
    return rel


def vault_root_exists(vault_path: str | Path) -> bool:
    p = Path(vault_path).expanduser()
    try:
        return p.is_dir()
    except OSError:
        return False


def has_obsidian_marker(vault_path: str | Path) -> bool:
    try:
        return (Path(vault_path).expanduser() / ".obsidian").is_dir()
    except OSError:
        return False


def _path_matches_ignore(rel_posix: str, patterns: list[str]) -> bool:
    """Minimal ignore matching for vault listings (fnmatch-style)."""
    import fnmatch

    name = PurePosixPath(rel_posix).name
    for raw in patterns:
        pat = str(raw or "").strip().replace("\\", "/")
        if not pat:
            continue
        if fnmatch.fnmatch(rel_posix, pat) or fnmatch.fnmatch(name, pat):
            return True
        # directory prefix: foo/** or foo/
        if pat.endswith("/**"):
            prefix = pat[:-3].rstrip("/")
            if rel_posix == prefix or rel_posix.startswith(prefix + "/"):
                return True
        if pat.endswith("/") and (rel_posix == pat[:-1] or rel_posix.startswith(pat)):
            return True
    return False


def iter_markdown_notes(
    vault_path: str | Path,
    *,
    ignore_patterns: str | list[str] | None = None,
    limit: int | None = None,
) -> list[dict[str, str]]:
    """List vault-relative Markdown notes for browse UI / noteCount fallback.

    Returns ``[{path, title}, ...]`` sorted by path. Skips ``.obsidian`` always.
    """
    root = Path(vault_path).expanduser()
    if not root.is_dir():
        return []

    if isinstance(ignore_patterns, str):
        patterns = [p.strip() for p in ignore_patterns.split(",") if p.strip()]
    else:
        patterns = [str(p).strip() for p in (ignore_patterns or []) if str(p).strip()]
    # Always hide Obsidian config
    if ".obsidian/**" not in patterns:
        patterns = [".obsidian/**", *patterns]

    out: list[dict[str, str]] = []
    try:
        for path in sorted(root.rglob("*.md")):
            if not path.is_file():
                continue
            try:
                rel = path.relative_to(root).as_posix()
            except ValueError:
                continue
            if _path_matches_ignore(rel, patterns):
                continue
            title = path.stem
            out.append({"path": rel, "title": title})
            if limit is not None and len(out) >= max(1, int(limit)):
                break
    except OSError:
        return out
    return out


def count_markdown_notes(
    vault_path: str | Path,
    *,
    ignore_patterns: str | list[str] | None = None,
    scan_cap: int = 5000,
) -> int:
    return len(
        iter_markdown_notes(
            vault_path,
            ignore_patterns=ignore_patterns,
            limit=scan_cap,
        )
    )

def safe_join_display(vault_name: str, relative: str) -> str:
    """Build an Obsidian URI file parameter (path only, caller encodes)."""
    return normalize_vault_relative_path(relative)


def is_localhost_url(url: str) -> bool:
    from urllib.parse import urlparse

    try:
        host = (urlparse(url).hostname or "").lower()
    except Exception:
        return False
    return host in {"127.0.0.1", "localhost", "::1"}


def samefile_or_under(child: Path, root: Path) -> bool:
    """Windows-safe containment check after resolve."""
    try:
        child.relative_to(root)
        return True
    except ValueError:
        # Case-insensitive fallback on Windows
        if os.name == "nt":
            try:
                return os.path.normcase(str(child)).startswith(os.path.normcase(str(root)) + os.sep)
            except Exception:
                return False
        return False
