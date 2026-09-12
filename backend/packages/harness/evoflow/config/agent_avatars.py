"""Agent avatar file storage (transparent WebP/PNG cutouts)."""

from __future__ import annotations

import hashlib
import logging
import re
import shutil
from pathlib import Path

logger = logging.getLogger(__name__)

_AVATAR_FILE = "avatar.webp"
_AVATAR_FILE_ALT = "avatar.png"
_AVATAR_FILE_SVG = "avatar.svg"
_SOURCE_FILE = ".avatar_source"
_MAX_BYTES = 10 * 1024 * 1024
_MAX_DIM = 4096
_AGENT_CODE_RE = re.compile(r"^[a-z0-9-]+$")

# Ship-with-product defaults for built-in agents (``avatar: image``).
_BUNDLED_AVATARS_DIR = (
    Path(__file__).resolve().parent.parent / "assets" / "builtin_agent_avatars"
)

# Codes without their own cutout file → reuse another packaged asset.
# NOTE: 小V must NOT alias to ``main`` (male lead cutout). Default is gallery
# ``preset:analyst`` (see agents_config._XIAOMI_DEFAULT_AVATAR).
_BUNDLED_AVATAR_ALIASES: dict[str, str] = {}


def _paths():
    from evoflow.config.paths import get_paths

    return get_paths()


def _normalize_code(agent_code: str) -> str:
    code = str(agent_code or "").strip().lower()
    if not code or not _AGENT_CODE_RE.match(code):
        raise ValueError(f"Invalid agent code: {agent_code!r}")
    return code


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _source_path(agent_code: str) -> Path:
    return _paths().agent_dir(agent_code) / _SOURCE_FILE


def _read_avatar_source(agent_code: str) -> str | None:
    p = _source_path(agent_code)
    if not p.is_file():
        return None
    try:
        return p.read_text(encoding="utf-8").strip() or None
    except OSError:
        return None


def _write_avatar_source(agent_code: str, value: str) -> None:
    dest_dir = _paths().agent_dir(agent_code)
    dest_dir.mkdir(parents=True, exist_ok=True)
    p = dest_dir / _SOURCE_FILE
    tmp = dest_dir / f".{_SOURCE_FILE}.tmp"
    tmp.write_text(value.strip() + "\n", encoding="utf-8")
    tmp.replace(p)


def _clear_avatar_source(agent_code: str) -> None:
    p = _source_path(agent_code)
    if p.is_file():
        p.unlink(missing_ok=True)


def bundled_avatar_path(agent_code: str) -> Path | None:
    """Return the packaged default avatar for a built-in agent code, if any."""
    try:
        code = _normalize_code(agent_code)
    except ValueError:
        return None
    candidates = [code]
    alias = _BUNDLED_AVATAR_ALIASES.get(code)
    if alias and alias not in candidates:
        candidates.append(alias)
    for stem in candidates:
        for ext in (".png", ".webp", ".svg"):
            p = _BUNDLED_AVATARS_DIR / f"{stem}{ext}"
            if p.is_file():
                return p
    return None


def seed_builtin_avatar_file(agent_code: str, *, overwrite: bool = False) -> Path | None:
    """Copy packaged default into ``agents/{code}/avatar.*`` when missing.

    Returns the local avatar path when present after seeding, else ``None``.
    Writes ``.avatar_source=bundled:<sha256>`` so later product updates can refresh
    without clobbering user uploads.
    """
    code = _normalize_code(agent_code)
    if not overwrite:
        existing = _local_avatar_path(code)
        if existing is not None:
            return existing
    src = bundled_avatar_path(code)
    if src is None:
        return None
    dest_dir = _paths().agent_dir(code)
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / f"avatar{src.suffix.lower()}"
    try:
        shutil.copyfile(src, dest)
    except OSError:
        logger.warning("failed to seed builtin avatar for %s from %s", code, src, exc_info=True)
        return None
    # Keep a single raster/svg file on disk.
    for name in (_AVATAR_FILE, _AVATAR_FILE_ALT, _AVATAR_FILE_SVG):
        other = dest_dir / name
        if other != dest and other.is_file():
            other.unlink(missing_ok=True)
    try:
        _write_avatar_source(code, f"bundled:{_sha256_file(src)}")
    except OSError:
        logger.debug("failed to write avatar source marker for %s", code, exc_info=True)
    return dest


def ensure_builtin_avatar_files(agent_codes: list[str] | tuple[str, ...] | None = None) -> int:
    """Seed packaged avatars for the given codes (or all bundled files).

    Returns how many files were newly copied.
    """
    codes = _resolve_avatar_codes(agent_codes)
    seeded = 0
    for code in codes:
        if not _should_seed_bundled_for_agent(code):
            continue
        before = _local_avatar_path(code)
        after = seed_builtin_avatar_file(code)
        if before is None and after is not None:
            seeded += 1
    return seeded


def refresh_stale_builtin_avatars(
    agent_codes: list[str] | tuple[str, ...] | None = None,
) -> int:
    """Overwrite local product-default avatars when the packaged asset changed.

    Skips avatars marked as user uploads (``.avatar_source=user``). Any other
    local copy (including legacy installs with no ``.avatar_source`` marker) is
    rewritten when it does not match the current package bytes — so upgrading
    the wheel/installer picks up new cutouts without wiping custom uploads.

    Returns how many avatars were rewritten.
    """
    refreshed = 0
    for code in _resolve_avatar_codes(agent_codes):
        if not _should_seed_bundled_for_agent(code):
            continue
        src = bundled_avatar_path(code)
        if src is None:
            continue
        try:
            new_sha = _sha256_file(src)
        except OSError:
            continue
        local = _local_avatar_path(code)
        if local is None:
            if seed_builtin_avatar_file(code) is not None:
                refreshed += 1
            continue

        source = _read_avatar_source(code)
        if source == "user":
            continue

        # Marker already points at the current package asset.
        if source == f"bundled:{new_sha}":
            continue

        try:
            local_sha = _sha256_file(local)
        except OSError:
            continue
        if local_sha == new_sha:
            # Bytes already current (e.g. legacy copy) — just stamp the marker.
            try:
                _write_avatar_source(code, f"bundled:{new_sha}")
            except OSError:
                pass
            continue

        if seed_builtin_avatar_file(code, overwrite=True) is not None:
            refreshed += 1
            reason = "source marker outdated" if source and source.startswith("bundled:") else "legacy/unmarked product default"
            logger.info("refreshed bundled avatar for %s (%s)", code, reason)
    return refreshed


def _resolve_avatar_codes(
    agent_codes: list[str] | tuple[str, ...] | None,
) -> list[str]:
    if agent_codes is None:
        if not _BUNDLED_AVATARS_DIR.is_dir():
            return []
        codes = {
            p.stem.lower()
            for p in _BUNDLED_AVATARS_DIR.iterdir()
            if p.is_file() and p.suffix.lower() in {".png", ".webp", ".svg"}
        }
        # Alias codes (e.g. xiaomi→main) must still be seeded into agents/{alias}/.
        for alias_code, target in _BUNDLED_AVATAR_ALIASES.items():
            if target in codes or bundled_avatar_path(alias_code) is not None:
                codes.add(alias_code)
        return sorted(codes)
    return list(agent_codes)


def _local_avatar_path(agent_code: str) -> Path | None:
    """On-disk avatar under ``agents/{code}/`` only (no bundled seed)."""
    code = _normalize_code(agent_code)
    base = _paths().agent_dir(code)
    for name in (_AVATAR_FILE, _AVATAR_FILE_ALT, _AVATAR_FILE_SVG):
        p = base / name
        if p.is_file():
            return p
    return None


def avatar_revision_for(agent_code: str) -> str | None:
    """Cheap cache-bust token for ``/avatar?v=…`` (bundled sha prefix or mtime)."""
    try:
        code = _normalize_code(agent_code)
    except ValueError:
        return None
    source = _read_avatar_source(code)
    if source and source.startswith("bundled:") and len(source) > 8:
        return source.split(":", 1)[1][:16]
    local = _local_avatar_path(code)
    if local is None:
        return None
    try:
        mtime = int(local.stat().st_mtime)
    except OSError:
        return None
    prefix = "u" if source == "user" else "m"
    return f"{prefix}{mtime}"


def has_local_avatar_file(agent_code: str) -> bool:
    """True when ``agents/{code}/avatar.*`` exists — does not seed bundled defaults.

    Used for API ``has_avatar_file`` so listing agents after the user switches to a
    gallery preset / emoji does not re-materialize a cutout and flip the flag back.
    """
    try:
        return _local_avatar_path(_normalize_code(agent_code)) is not None
    except ValueError:
        return False


def avatar_path_for(agent_code: str) -> Path | None:
    """Return the on-disk avatar file if present (seed bundled default lazily)."""
    code = _normalize_code(agent_code)
    existing = _local_avatar_path(code)
    if existing is not None:
        return existing
    # Fresh install / new machine: materialize product default so /avatar serves.
    # Skip when the agent config points at a gallery preset (no per-agent file).
    if not _should_seed_bundled_for_agent(code):
        return None
    return seed_builtin_avatar_file(code)


def _should_seed_bundled_for_agent(agent_code: str) -> bool:
    """Do not re-seed product cutouts over an intentional gallery preset."""
    try:
        from evoflow.config.agents_config import load_agent_config
        from evoflow.config.avatar_presets import parse_preset_avatar

        cfg = load_agent_config(agent_code)
        return parse_preset_avatar(getattr(cfg, "avatar", None)) is None
    except Exception:
        return True


def content_type_for(path: Path) -> str:
    if path.suffix.lower() == ".png":
        return "image/png"
    if path.suffix.lower() == ".svg":
        return "image/svg+xml"
    return "image/webp"


def _has_image_magic(data: bytes) -> bool:
    webp = len(data) >= 12 and data[0:4] == b"RIFF" and data[8:12] == b"WEBP"
    png = data.startswith(b"\x89PNG\r\n\x1a\n")
    return webp or png


def _image_dimensions(data: bytes) -> tuple[int, int] | None:
    if data.startswith(b"\x89PNG\r\n\x1a\n") and len(data) >= 24 and data[12:16] == b"IHDR":
        w = int.from_bytes(data[16:20], "big")
        h = int.from_bytes(data[20:24], "big")
        return w, h
    if len(data) >= 30 and data[0:4] == b"RIFF" and data[8:12] == b"WEBP" and data[12:16] == b"VP8X":
        le24 = lambda b: b[0] | (b[1] << 8) | (b[2] << 16)
        return le24(data[24:27]) + 1, le24(data[27:30]) + 1
    return None


def validate_avatar_bytes(data: bytes) -> None:
    if not data:
        raise ValueError("Empty avatar file")
    if len(data) > _MAX_BYTES:
        raise ValueError(f"Avatar too large (max {_MAX_BYTES} bytes)")
    if not _has_image_magic(data):
        raise ValueError("Avatar must be WebP or PNG")
    dims = _image_dimensions(data)
    if dims:
        w, h = dims
        if w > _MAX_DIM or h > _MAX_DIM:
            raise ValueError(f"Avatar dimensions exceed {_MAX_DIM}px")


def save_avatar_bytes(agent_code: str, data: bytes) -> Path:
    validate_avatar_bytes(data)
    code = _normalize_code(agent_code)
    dest_dir = _paths().agent_dir(code)
    dest_dir.mkdir(parents=True, exist_ok=True)
    ext = ".png" if data.startswith(b"\x89PNG") else ".webp"
    dest = dest_dir / f"avatar{ext}"
    tmp = dest_dir / f".avatar-upload{ext}"
    tmp.write_bytes(data)
    tmp.replace(dest)
    alt = dest_dir / ("avatar.png" if ext == ".webp" else "avatar.webp")
    if alt.is_file() and alt != dest:
        alt.unlink(missing_ok=True)
    # Also remove SVG if a raster avatar is uploaded.
    svg = dest_dir / _AVATAR_FILE_SVG
    if svg.is_file():
        svg.unlink(missing_ok=True)
    try:
        _write_avatar_source(code, "user")
    except OSError:
        logger.debug("failed to write user avatar source marker for %s", code, exc_info=True)
    return dest


def delete_avatar_file(agent_code: str) -> None:
    code = _normalize_code(agent_code)
    base = _paths().agent_dir(code)
    for name in (_AVATAR_FILE, _AVATAR_FILE_ALT, _AVATAR_FILE_SVG):
        p = base / name
        if p.is_file():
            p.unlink()
    _clear_avatar_source(code)
