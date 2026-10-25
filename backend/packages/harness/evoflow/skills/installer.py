"""Shared skill archive installation logic.

Pure business logic — no FastAPI/HTTP dependencies.
Both Gateway and Client delegate to these functions.
"""

from __future__ import annotations

import logging
import os
import posixpath
import shutil
import stat
import subprocess
import tempfile
import zipfile
from pathlib import Path, PurePosixPath, PureWindowsPath

from evoflow.skills.loader import get_skills_root_path
from evoflow.skills.paths import validate_skill_install_layout
from evoflow.skills.security import scan_skill_directory
from evoflow.skills.validation import _validate_skill_frontmatter

logger = logging.getLogger(__name__)

MAX_ZIP_ENTRIES = 4096
MAX_ZIP_FILES = 2048


class SkillAlreadyExistsError(ValueError):
    """Raised when a skill with the same name is already installed."""


def is_link_or_junction(path: Path) -> bool:
    """True if path is a symlink or Windows junction/reparse point (does not follow)."""
    try:
        st = os.lstat(path)
    except OSError:
        return False
    if stat.S_ISLNK(st.st_mode):
        return True
    if os.name == "nt" and hasattr(st, "st_file_attributes"):
        return bool(st.st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT)
    return False


def path_occupied(path: Path) -> bool:
    """True if a name is already taken under custom/ (file, dir, symlink, or junction)."""
    return path.exists() or path.is_symlink() or is_link_or_junction(path)


def remove_link_or_junction(path: Path) -> None:
    """Remove a symlink/junction without deleting the link target."""
    if not path.exists() and not path.is_symlink() and not is_link_or_junction(path):
        return
    if path.is_dir() and not path.is_symlink():
        if is_link_or_junction(path):
            path.rmdir()
            return
        raise RuntimeError(f"Refusing to remove non-link directory: {path}")
    path.unlink()


def link_skill_directory(src: Path, target: Path) -> None:
    """Create custom/<name> as a directory symlink (or Windows junction) to src."""
    src_resolved = src.resolve()
    if not src_resolved.is_dir():
        raise ValueError(f"Skill source is not a directory: {src}")
    target.parent.mkdir(parents=True, exist_ok=True)
    if path_occupied(target):
        raise SkillAlreadyExistsError(f"Skill path already occupied: {target}")

    try:
        os.symlink(str(src_resolved), str(target), target_is_directory=True)
        return
    except OSError as exc:
        if os.name != "nt":
            raise RuntimeError(f"Failed to create skill symlink: {exc}") from exc

    # Windows: directory symlink often needs Developer Mode; junction does not.
    completed = subprocess.run(
        ["cmd", "/c", "mklink", "/J", str(target), str(src_resolved)],
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0 or not path_occupied(target):
        detail = (completed.stderr or completed.stdout or "").strip() or "mklink failed"
        raise RuntimeError(f"Failed to create skill junction: {detail}")


def is_unsafe_zip_member(info: zipfile.ZipInfo) -> bool:
    """Return True if the zip member path is absolute or attempts directory traversal."""
    name = info.filename
    if not name:
        return False
    normalized = name.replace("\\", "/")
    if normalized.startswith("/"):
        return True
    path = PurePosixPath(normalized)
    if path.is_absolute():
        return True
    if PureWindowsPath(name).is_absolute():
        return True
    if ".." in path.parts:
        return True
    return False


def is_symlink_member(info: zipfile.ZipInfo) -> bool:
    """Detect symlinks based on the external attributes stored in the ZipInfo."""
    mode = info.external_attr >> 16
    return stat.S_ISLNK(mode)


def should_ignore_archive_entry(path: Path) -> bool:
    """Return True for macOS metadata dirs and dotfiles."""
    return path.name.startswith(".") or path.name == "__MACOSX"


def resolve_skill_dir_from_archive(temp_path: Path) -> Path:
    """Locate the skill root directory from extracted archive contents.

    Filters out macOS metadata (__MACOSX) and dotfiles (.DS_Store).

    Returns:
        Path to the skill directory.

    Raises:
        ValueError: If the archive is empty after filtering.
    """
    items = [p for p in temp_path.iterdir() if not should_ignore_archive_entry(p)]
    if not items:
        raise ValueError("Skill archive is empty")
    if len(items) == 1 and items[0].is_dir():
        return items[0]
    if (temp_path / "SKILL.md").is_file():
        return temp_path
    if len(items) == 1 and items[0].is_file():
        raise ValueError("Skill archive must wrap files in a single top-level directory")
    names = ", ".join(p.name for p in items)
    raise ValueError(f"Skill archive must contain exactly one top-level directory, or SKILL.md at the archive root. Found: {names}")


def safe_extract_skill_archive(
    zip_ref: zipfile.ZipFile,
    dest_path: Path,
    max_total_size: int = 512 * 1024 * 1024,
) -> None:
    """Safely extract a skill archive with security protections.

    Protections:
    - Reject absolute paths and directory traversal (..).
    - Skip symlink entries instead of materialising them.
    - Enforce a hard limit on total uncompressed size (zip bomb defence).

    Raises:
        ValueError: If unsafe members or size limit exceeded.
    """
    dest_root = dest_path.resolve()
    total_written = 0
    entry_count = 0
    file_count = 0

    for info in zip_ref.infolist():
        entry_count += 1
        if entry_count > MAX_ZIP_ENTRIES:
            raise ValueError(f"Skill archive contains too many entries (max {MAX_ZIP_ENTRIES}).")

        if is_unsafe_zip_member(info):
            raise ValueError(f"Archive contains unsafe member path: {info.filename!r}")

        if is_symlink_member(info):
            logger.warning("Skipping symlink entry in skill archive: %s", info.filename)
            continue

        normalized_name = posixpath.normpath(info.filename.replace("\\", "/"))
        member_path = dest_root.joinpath(*PurePosixPath(normalized_name).parts)
        if not member_path.resolve().is_relative_to(dest_root):
            raise ValueError(f"Zip entry escapes destination: {info.filename!r}")
        member_path.parent.mkdir(parents=True, exist_ok=True)

        if info.is_dir():
            member_path.mkdir(parents=True, exist_ok=True)
            continue

        file_count += 1
        if file_count > MAX_ZIP_FILES:
            raise ValueError(f"Skill archive contains too many files (max {MAX_ZIP_FILES}).")

        with zip_ref.open(info) as src, member_path.open("wb") as dst:
            while chunk := src.read(65536):
                total_written += len(chunk)
                if total_written > max_total_size:
                    raise ValueError("Skill archive is too large or appears highly compressed.")
                dst.write(chunk)


def install_skill_from_archive(
    zip_path: str | Path,
    *,
    skills_root: Path | None = None,
) -> dict:
    """Install a skill from a .zip archive.

    Args:
        zip_path: Path to the .zip file.
        skills_root: Override the skills root directory. If None, uses
            the default from config.

    Returns:
        Dict with success, skill_name, message.

    Raises:
        FileNotFoundError: If the file does not exist.
        ValueError: If the file is invalid (wrong extension, bad ZIP,
            invalid frontmatter, duplicate name).
    """
    logger.info("Installing skill from %s", zip_path)
    path = Path(zip_path)
    if not path.is_file():
        if not path.exists():
            raise FileNotFoundError(f"Skill file not found: {zip_path}")
        raise ValueError(f"Path is not a file: {zip_path}")
    if path.suffix.lower() != ".zip":
        raise ValueError("File must have .zip extension")

    if skills_root is None:
        skills_root = get_skills_root_path()
    custom_dir = skills_root / "custom"
    custom_dir.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)

        try:
            zf = zipfile.ZipFile(path, "r")
        except FileNotFoundError:
            raise FileNotFoundError(f"Skill file not found: {zip_path}") from None
        except (zipfile.BadZipFile, IsADirectoryError):
            raise ValueError("File is not a valid ZIP archive") from None

        with zf:
            safe_extract_skill_archive(zf, tmp_path)

        skill_dir = resolve_skill_dir_from_archive(tmp_path)

        is_valid, message, skill_name = _validate_skill_frontmatter(skill_dir, strict_keys=False)
        if not is_valid:
            raise ValueError(f"Invalid skill: {message}")

        layout_ok, layout_msg = validate_skill_install_layout(skill_dir)
        if not layout_ok:
            raise ValueError(f"Invalid skill layout: {layout_msg}")

        security_issues = scan_skill_directory(skill_dir)
        if security_issues:
            raise ValueError(f"Skill content failed security scan: {security_issues[0]}")

        if not skill_name or "/" in skill_name or "\\" in skill_name or ".." in skill_name:
            raise ValueError(f"Invalid skill name: {skill_name}")

        target = custom_dir / skill_name
        if path_occupied(target):
            raise SkillAlreadyExistsError(f"Skill '{skill_name}' already exists")

        shutil.copytree(skill_dir, target)
        logger.info("Skill %r installed to %s", skill_name, target)

    return {
        "success": True,
        "skill_name": skill_name,
        "message": f"Skill '{skill_name}' installed successfully",
        "install_mode": "copy",
        "linked_path": None,
    }


def install_skill_from_directory(
    source_dir: str | Path,
    *,
    skills_root: Path | None = None,
    link: bool = False,
) -> dict:
    """Install a skill from a local directory (no archive needed).

    Args:
        source_dir: Path to the skill directory (must contain SKILL.md).
        skills_root: Override the skills root directory. If None, uses
            the default from config.
        link: When True, create ``custom/<name>`` as a directory symlink /
            Windows junction pointing at ``source_dir`` instead of copying.
            Prefer for local monorepo / demo packs so edits stay in-source.
            Zip/market installs should keep ``link=False`` (portable copy).

    Returns:
        Dict with success, skill_name, message, install_mode, linked_path.

    Raises:
        FileNotFoundError: If the directory does not exist.
        ValueError: If the directory is invalid (no SKILL.md, invalid
            frontmatter, duplicate name).
    """
    logger.info("Installing skill from directory %s (link=%s)", source_dir, link)
    src = Path(source_dir)
    if not src.is_dir():
        if not src.exists():
            raise FileNotFoundError(f"Skill directory not found: {source_dir}")
        raise ValueError(f"Path is not a directory: {source_dir}")

    if not (src / "SKILL.md").is_file():
        raise ValueError(f"Directory does not contain SKILL.md: {source_dir}")

    is_valid, message, skill_name = _validate_skill_frontmatter(src, strict_keys=False)
    if not is_valid:
        raise ValueError(f"Invalid skill: {message}")

    layout_ok, layout_msg = validate_skill_install_layout(src)
    if not layout_ok:
        raise ValueError(f"Invalid skill layout: {layout_msg}")

    security_issues = scan_skill_directory(src)
    if security_issues:
        raise ValueError(f"Skill content failed security scan: {security_issues[0]}")

    if not skill_name or "/" in skill_name or "\\" in skill_name or ".." in skill_name:
        raise ValueError(f"Invalid skill name: {skill_name}")

    if skills_root is None:
        skills_root = get_skills_root_path()
    custom_dir = skills_root / "custom"
    custom_dir.mkdir(parents=True, exist_ok=True)

    target = custom_dir / skill_name
    if path_occupied(target):
        raise SkillAlreadyExistsError(f"Skill '{skill_name}' already exists")

    src_resolved = src.resolve()
    if link:
        link_skill_directory(src_resolved, target)
        logger.info("Skill %r linked from %s -> %s", skill_name, src_resolved, target)
        return {
            "success": True,
            "skill_name": skill_name,
            "message": f"Skill '{skill_name}' linked successfully",
            "install_mode": "link",
            "linked_path": str(src_resolved),
        }

    shutil.copytree(src_resolved, target)
    logger.info("Skill %r installed from directory to %s", skill_name, target)

    return {
        "success": True,
        "skill_name": skill_name,
        "message": f"Skill '{skill_name}' installed successfully",
        "install_mode": "copy",
        "linked_path": None,
    }
