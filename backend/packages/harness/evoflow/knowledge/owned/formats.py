"""Supported extensions and folder ignore rules (spec §1.1).

Knowledge bases index / display document & text formats only.
Code, archives, images, and temp/hidden files are excluded for now
(images may return later as a dedicated capability).
"""

from __future__ import annotations

SUPPORTED_EXTENSIONS = {
    # Documents & plain text
    ".md",
    ".markdown",
    ".mdx",
    ".txt",
    ".log",
    ".csv",
    ".json",
    ".yaml",
    ".yml",
    ".toml",
    ".xml",
    ".html",
    ".htm",
    ".pdf",
    ".doc",
    ".docx",
    ".ppt",
    ".pptx",
    ".xls",
    ".xlsx",
}

# Explicitly rejected (never index / never show in KB file tree).
ARCHIVE_EXTENSIONS = {
    ".zip",
    ".rar",
    ".7z",
    ".tar",
    ".gz",
    ".tgz",
    ".bz2",
    ".xz",
    ".cab",
    ".iso",
}

IMAGE_EXTENSIONS = {
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".bmp",
    ".svg",
    ".ico",
    ".tif",
    ".tiff",
    ".heic",
    ".avif",
}

# Source / config — deferred; not part of knowledge retrieval yet.
CODE_EXTENSIONS = {
    ".py",
    ".js",
    ".jsx",
    ".ts",
    ".tsx",
    ".java",
    ".go",
    ".rs",
    ".c",
    ".cpp",
    ".h",
    ".hpp",
    ".cs",
    ".rb",
    ".php",
    ".swift",
    ".kt",
    ".scala",
    ".sh",
    ".bash",
    ".zsh",
    ".ps1",
    ".bat",
    ".cmd",
    ".ini",
    ".cfg",
    ".conf",
    ".css",
    ".scss",
    ".less",
    ".vue",
    ".svelte",
}

IGNORE_DIR_NAMES = {
    ".git",
    ".svn",
    ".hg",
    "node_modules",
    "__pycache__",
    ".obsidian",
    ".trash",
    ".smart-env",
    ".venv",
    "venv",
}

IGNORE_FILE_NAMES = {
    "Thumbs.db",
    ".DS_Store",
    "desktop.ini",
}

_TEMP_SUFFIXES = (
    ".tmp",
    ".temp",
    ".swp",
    ".swo",
    ".bak",
    ".crdownload",
    ".partial",
    ".part",
)

MAX_FILE_BYTES = 50 * 1024 * 1024


def is_supported_file(name: str) -> bool:
    from pathlib import Path

    return Path(name).suffix.lower() in SUPPORTED_EXTENSIONS


def should_skip_dir(name: str) -> bool:
    return name in IGNORE_DIR_NAMES or name.startswith(".")


def folder_path_has_skipped_dir(folder_path: str | None) -> bool:
    """True when any path segment is a hidden/ignored directory (e.g. ``.git``)."""
    raw = str(folder_path or "").replace("\\", "/").strip("/")
    if not raw:
        return False
    return any(should_skip_dir(part) for part in raw.split("/") if part)


def should_skip_file(name: str) -> bool:
    """Return True when a file must be ignored during folder import/scan/tree.

    Skips: OS junk, dotfiles, Office/temp locks, archives, images, source code,
    and anything outside SUPPORTED_EXTENSIONS.
    """
    base = name.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
    if not base or base in IGNORE_FILE_NAMES:
        return True
    if base.startswith("."):
        return True
    if base.startswith(".~") or base.startswith("~$") or base.startswith("~") or base.endswith("~"):
        return True
    lower = base.lower()
    from pathlib import Path

    suffix = Path(lower).suffix
    if suffix in ARCHIVE_EXTENSIONS or suffix in IMAGE_EXTENSIONS or suffix in CODE_EXTENSIONS:
        return True
    if any(lower.endswith(ext) for ext in _TEMP_SUFFIXES):
        return True
    return not is_supported_file(base)
