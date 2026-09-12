"""User skills store: ``~/.evoflow/skills/{public,custom}``.

``public/`` is mirrored from bundled/repo system skills on gateway startup.
``custom/`` is user-installed only and is never overwritten by sync.
"""

from __future__ import annotations

import filecmp
import hashlib
import json
import logging
import os
import shutil
import stat
import sys
from pathlib import Path

logger = logging.getLogger(__name__)

_SYNC_MANIFEST = ".public-sync.json"
# Include full content hash for small files so SKILL.md edits are detected even when
# file count / global max mtime stay unchanged.
_CONTENT_HASH_MAX_BYTES = 512 * 1024


def get_user_skills_root(*, resolve: bool = True) -> Path:
    """Canonical user skills root (``~/.evoflow/skills``).

    Pass ``resolve=False`` when checking/removing a legacy junction at the link path.
    """
    p = Path.home() / ".evoflow" / "skills"
    return p.resolve() if resolve else p


def _skills_root_from_source_tree() -> Path | None:
    backend_dir = Path(__file__).resolve().parent.parent.parent.parent.parent
    candidate = (backend_dir.parent / "skills").resolve()
    if not candidate.is_dir():
        return None
    if (candidate / "public").is_dir() or (candidate / "custom").is_dir():
        return candidate
    return None


def resolve_system_skills_source() -> Path | None:
    """Bundled or checkout skills root (read-only system source)."""
    if getattr(sys, "frozen", False):
        exe_dir = Path(sys.executable).resolve().parent
        for candidate in (exe_dir / "skills", exe_dir.parent / "skills"):
            if candidate.is_dir() and (
                (candidate / "public").is_dir() or (candidate / "custom").is_dir()
            ):
                return candidate.resolve()

    src = _skills_root_from_source_tree()
    if src is not None:
        return src

    cwd_skills = (Path.cwd() / "skills").resolve()
    if cwd_skills.is_dir() and (
        (cwd_skills / "public").is_dir() or (cwd_skills / "custom").is_dir()
    ):
        return cwd_skills

    backend_dir = Path(__file__).resolve().parent.parent.parent.parent.parent
    fallback = (backend_dir.parent / "skills").resolve()
    if fallback.is_dir():
        return fallback
    return None


def _is_valid_skills_root(path: Path) -> bool:
    return path.is_dir() and (
        (path / "public").is_dir() or (path / "custom").is_dir()
    )


def _is_link_or_junction(path: Path) -> bool:
    try:
        st = os.lstat(path)
    except OSError:
        return False
    if stat.S_ISLNK(st.st_mode):
        return True
    if os.name == "nt" and hasattr(st, "st_file_attributes"):
        return bool(st.st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT)
    return False


def _remove_link_or_junction(path: Path) -> None:
    """Remove a symlink/junction without deleting the link target."""
    if not path.exists() and not path.is_symlink():
        return
    if path.is_dir() and not path.is_symlink():
        if _is_link_or_junction(path):
            path.rmdir()
            return
        raise RuntimeError(f"Refusing to remove non-link directory: {path}")
    path.unlink()


def _install_fingerprint(source_root: Path | None) -> str:
    """Detect app upgrades / install location changes (frozen exe stat or dev source root)."""
    if getattr(sys, "frozen", False):
        exe = Path(sys.executable).resolve()
        try:
            st = exe.stat()
        except OSError:
            return f"frozen|{exe}|stat-error"
        return f"frozen|{exe}|size={st.st_size}|mtime_ns={st.st_mtime_ns}"
    if source_root is not None:
        return f"dev|{source_root.resolve()}"
    return "unknown"


def _public_tree_quick_stats(public_dir: Path) -> tuple[int, int]:
    """Return ``(file_count, max_mtime_ns)`` without reading file contents."""
    if not public_dir.is_dir():
        return 0, 0
    count = 0
    max_mtime_ns = 0
    for path in public_dir.rglob("*"):
        if not path.is_file():
            continue
        count += 1
        try:
            max_mtime_ns = max(max_mtime_ns, path.stat().st_mtime_ns)
        except OSError:
            continue
    return count, max_mtime_ns


def _public_tree_content_signature(public_dir: Path) -> str:
    """Content-aware signature for ``public/`` (source tree only)."""
    if not public_dir.is_dir():
        return "missing"

    digest = hashlib.sha256()
    files = sorted(p for p in public_dir.rglob("*") if p.is_file())
    for path in files:
        rel = path.relative_to(public_dir).as_posix()
        digest.update(rel.encode("utf-8"))
        digest.update(b"\0")
        try:
            st = path.stat()
        except OSError:
            digest.update(b"stat-error\n")
            continue
        digest.update(str(st.st_size).encode("ascii"))
        digest.update(b"\0")
        digest.update(str(st.st_mtime_ns).encode("ascii"))
        digest.update(b"\0")
        if st.st_size <= _CONTENT_HASH_MAX_BYTES:
            try:
                digest.update(hashlib.sha256(path.read_bytes()).digest())
            except OSError:
                digest.update(b"read-error\n")
        else:
            digest.update(b"large-file\n")
        digest.update(b"\0")
    return digest.hexdigest()


def _read_sync_manifest(skills_root: Path) -> dict | None:
    manifest = skills_root / _SYNC_MANIFEST
    if not manifest.is_file():
        return None
    try:
        data = json.loads(manifest.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _write_sync_manifest(
    skills_root: Path,
    *,
    source_public: Path,
    signature: str,
    install_fingerprint: str,
) -> None:
    manifest = skills_root / _SYNC_MANIFEST
    file_count, max_mtime_ns = _public_tree_quick_stats(source_public)
    payload = {
        "source_public": str(source_public.resolve()),
        "signature": signature,
        "install_fingerprint": install_fingerprint,
        "file_count": file_count,
        "max_mtime_ns": max_mtime_ns,
    }
    manifest.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _sync_manifest_matches(
    prev: dict | None,
    *,
    source_public: Path,
    signature: str,
    install_fingerprint: str,
) -> bool:
    if not prev:
        return False
    return (
        prev.get("signature") == signature
        and prev.get("install_fingerprint") == install_fingerprint
        and prev.get("source_public") == str(source_public.resolve())
    )


def _should_copy_public_file(src: Path, dst: Path) -> bool:
    """True when ``dst`` is missing or content differs from bundled ``src``."""
    if not dst.is_file():
        return True
    try:
        return not filecmp.cmp(src, dst, shallow=False)
    except OSError:
        return True


def sync_system_public_skills(
    *,
    skills_root: Path,
    source: Path | None = None,
    force: bool = False,
) -> bool:
    """Mirror ``source/public`` into ``skills_root/public``; never touch ``custom/``."""
    root = skills_root.resolve()
    source_root = (source or resolve_system_skills_source())
    if source_root is None:
        logger.debug("No system skills source; skip public sync for %s", root)
        return False

    source_public = source_root / "public"
    if not source_public.is_dir():
        logger.debug("System source has no public/: %s", source_root)
        return False

    install_fingerprint = _install_fingerprint(source_root)
    source_public_resolved = str(source_public.resolve())
    prev = _read_sync_manifest(root)

    if not force and prev:
        prev_fp = prev.get("install_fingerprint")
        prev_src = prev.get("source_public")
        if prev_fp == install_fingerprint and prev_src == source_public_resolved:
            # Packaged builds: install fingerprint changes on upgrade — trust manifest.
            if getattr(sys, "frozen", False) and prev.get("signature"):
                logger.debug(
                    "Skills public sync skipped (packaged manifest hit, %s files)",
                    prev.get("file_count", "?"),
                )
                return False
            # Dev / editable installs: cheap stat scan (no content hashing).
            prev_count = prev.get("file_count")
            prev_mtime = prev.get("max_mtime_ns")
            if prev_count is not None and prev_mtime is not None:
                cur_count, cur_mtime = _public_tree_quick_stats(source_public)
                if cur_count == prev_count and cur_mtime == prev_mtime:
                    logger.debug(
                        "Skills public sync skipped (dev quick stats match, %d files)",
                        cur_count,
                    )
                    return False

    signature = _public_tree_content_signature(source_public)
    if not force and _sync_manifest_matches(
        prev,
        source_public=source_public,
        signature=signature,
        install_fingerprint=install_fingerprint,
    ):
        return False

    target_public = root / "public"
    target_public.mkdir(parents=True, exist_ok=True)
    (root / "custom").mkdir(exist_ok=True)

    source_rel_files: set[str] = set()
    for src in source_public.rglob("*"):
        rel = src.relative_to(source_public)
        rel_posix = rel.as_posix()
        dst = target_public / rel
        if src.is_dir():
            dst.mkdir(parents=True, exist_ok=True)
            continue
        source_rel_files.add(rel_posix)
        dst.parent.mkdir(parents=True, exist_ok=True)
        if not _should_copy_public_file(src, dst):
            continue
        shutil.copy2(src, dst)

    for dst in sorted(target_public.rglob("*"), reverse=True):
        rel = dst.relative_to(target_public)
        if not (source_public / rel).exists():
            try:
                if dst.is_file() or dst.is_symlink():
                    dst.unlink()
                elif dst.is_dir():
                    dst.rmdir()
            except OSError:
                shutil.rmtree(dst, ignore_errors=True)

    _write_sync_manifest(
        root,
        source_public=source_public,
        signature=signature,
        install_fingerprint=install_fingerprint,
    )
    logger.info(
        "Synced system public skills %s -> %s (%d files)",
        source_public,
        target_public,
        len(source_rel_files),
    )
    try:
        from evoflow.skills.loader import clear_skills_cache

        clear_skills_cache()
    except Exception:
        pass
    return True


def bootstrap_user_skills_path(*, force_sync: bool = False) -> Path:
    """Fast boot: ensure layout + ``EVOFLOW_SKILLS_PATH`` without blocking on full public sync.

    Full ``sync_system_public_skills`` runs post-``ready to serve`` unless ``force_sync``.
    """
    explicit = os.getenv("EVOFLOW_SKILLS_PATH", "").strip()
    if explicit:
        root = Path(explicit).expanduser().resolve()
    else:
        root_link = get_user_skills_root(resolve=False)
        if root_link.exists() or root_link.is_symlink():
            if _is_link_or_junction(root_link):
                try:
                    _remove_link_or_junction(root_link)
                    logger.info("Removed legacy skills junction at %s", root_link)
                except Exception as exc:
                    logger.warning("Could not remove legacy junction %s: %s", root_link, exc)
        root = get_user_skills_root()

    root.parent.mkdir(parents=True, exist_ok=True)
    (root / "public").mkdir(parents=True, exist_ok=True)
    (root / "custom").mkdir(exist_ok=True)
    os.environ["EVOFLOW_SKILLS_PATH"] = str(root)

    if force_sync:
        sync_system_public_skills(skills_root=root, force=True)
        return root

    source_root = resolve_system_skills_source()
    if source_root is None:
        return root
    source_public = source_root / "public"
    if not source_public.is_dir():
        return root

    prev = _read_sync_manifest(root)
    install_fingerprint = _install_fingerprint(source_root)
    source_public_resolved = str(source_public.resolve())
    if prev and prev.get("install_fingerprint") == install_fingerprint and prev.get(
        "source_public"
    ) == source_public_resolved:
        if getattr(sys, "frozen", False) and prev.get("signature"):
            return root
        prev_count = prev.get("file_count")
        prev_mtime = prev.get("max_mtime_ns")
        if prev_count is not None and prev_mtime is not None:
            cur_count, cur_mtime = _public_tree_quick_stats(source_public)
            if cur_count == prev_count and cur_mtime == prev_mtime:
                return root

    # Manifest stale/missing but destination already populated — defer heavy sync.
    if (root / "public").is_dir() and any((root / "public").rglob("SKILL.md")):
        logger.info(
            "Skills bootstrap: deferring public sync to post-ready (%s)",
            root,
        )
        return root

    sync_system_public_skills(skills_root=root, force=False)
    return root


def ensure_user_skills_install(*, force_sync: bool = False) -> Path:
    """Ensure user skills layout exists, sync ``public/`` from system, set ``EVOFLOW_SKILLS_PATH``."""
    explicit = os.getenv("EVOFLOW_SKILLS_PATH", "").strip()
    if explicit:
        root = Path(explicit).expanduser().resolve()
        root.mkdir(parents=True, exist_ok=True)
        (root / "public").mkdir(exist_ok=True)
        (root / "custom").mkdir(exist_ok=True)
        sync_system_public_skills(skills_root=root, force=force_sync)
        os.environ["EVOFLOW_SKILLS_PATH"] = str(root)
        return root

    root_link = get_user_skills_root(resolve=False)
    if root_link.exists() or root_link.is_symlink():
        if _is_link_or_junction(root_link):
            try:
                _remove_link_or_junction(root_link)
                logger.info("Removed legacy skills junction at %s", root_link)
            except Exception as exc:
                logger.warning("Could not remove legacy junction %s: %s", root_link, exc)

    root = get_user_skills_root()
    root.parent.mkdir(parents=True, exist_ok=True)
    (root / "public").mkdir(parents=True, exist_ok=True)
    (root / "custom").mkdir(exist_ok=True)

    sync_system_public_skills(skills_root=root, force=force_sync)
    os.environ["EVOFLOW_SKILLS_PATH"] = str(root)
    return root
