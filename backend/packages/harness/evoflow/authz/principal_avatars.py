"""Per-principal avatar file storage (``scopes/personal/<id>/avatar.*``)."""

from __future__ import annotations

import logging
import re
from pathlib import Path

logger = logging.getLogger(__name__)

_AVATAR_WEBP = "avatar.webp"
_AVATAR_PNG = "avatar.png"
_MAX_BYTES = 5 * 1024 * 1024
_MAX_DIM = 2048
_SAFE_PID = re.compile(r"[^A-Za-z0-9._@+-]+")


def _safe_principal_id(principal_id: str) -> str:
    raw = str(principal_id or "").strip()
    if not raw:
        raise ValueError("principal_id required")
    s = raw.replace("\\", "/").replace("/", "__")
    s = _SAFE_PID.sub("_", s).strip("._") or "_"
    return s[:180]


def _principal_home(principal_id: str) -> Path:
    from evoflow.authz.scope import personal_scope
    from evoflow.authz.scope_paths import scope_dir

    return scope_dir(personal_scope(_safe_principal_id(principal_id)))


def avatar_path_for(principal_id: str) -> Path | None:
    home = _principal_home(principal_id)
    for name in (_AVATAR_WEBP, _AVATAR_PNG):
        p = home / name
        if p.is_file():
            return p
    return None


def has_avatar_file(principal_id: str) -> bool:
    try:
        return avatar_path_for(principal_id) is not None
    except ValueError:
        return False


def avatar_revision_for(principal_id: str) -> str | None:
    path = avatar_path_for(principal_id)
    if path is None:
        return None
    try:
        return f"u{int(path.stat().st_mtime)}"
    except OSError:
        return None


def content_type_for(path: Path) -> str:
    if path.suffix.lower() == ".png":
        return "image/png"
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


def save_avatar_bytes(principal_id: str, data: bytes) -> Path:
    validate_avatar_bytes(data)
    home = _principal_home(principal_id)
    home.mkdir(parents=True, exist_ok=True)
    ext = ".png" if data.startswith(b"\x89PNG") else ".webp"
    dest = home / f"avatar{ext}"
    tmp = home / f".avatar-upload{ext}"
    tmp.write_bytes(data)
    tmp.replace(dest)
    alt = home / ("avatar.png" if ext == ".webp" else "avatar.webp")
    if alt.is_file() and alt != dest:
        alt.unlink(missing_ok=True)
    return dest


def delete_avatar_file(principal_id: str) -> None:
    home = _principal_home(principal_id)
    for name in (_AVATAR_WEBP, _AVATAR_PNG):
        p = home / name
        if p.is_file():
            p.unlink(missing_ok=True)
