"""Supported extensions and folder ignore rules (spec §1.1)."""

from __future__ import annotations

SUPPORTED_EXTENSIONS = {
    # B1
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
    # B2
    ".py",
    ".js",
    ".ts",
    ".java",
    ".go",
    ".rs",
    ".c",
    ".cpp",
    ".h",
    ".ini",
    ".cfg",
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

MAX_FILE_BYTES = 50 * 1024 * 1024


def is_supported_file(name: str) -> bool:
    from pathlib import Path

    return Path(name).suffix.lower() in SUPPORTED_EXTENSIONS


def should_skip_dir(name: str) -> bool:
    return name in IGNORE_DIR_NAMES or name.startswith(".")


def should_skip_file(name: str) -> bool:
    if name in IGNORE_FILE_NAMES:
        return True
    if name.startswith(".~") or name.startswith("~$"):
        return True
    return not is_supported_file(name)
