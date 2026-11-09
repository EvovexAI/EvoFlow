"""Department avatar file storage (user-uploaded custom cutouts).

Preset avatars ship inside the package (``assets/dept_avatars``) and are
referenced by bare preset id. A user upload is different: bytes live under
``{base_dir}/dept_avatars/{dept_id}/avatar.{webp,png}`` and the department row
stores the sentinel ``"image"`` as its ``avatar`` value.

Mirrors :mod:`evoflow.config.agent_avatars` (same magic/dimension validation,
same single-file-per-entity invariant) so the panel can use one mental model
for agent and department pictures.
"""

from __future__ import annotations

import logging
from pathlib import Path

logger = logging.getLogger(__name__)

#: ``evoflow_departments.avatar`` sentinel meaning "use the uploaded file".
IMAGE_AVATAR = "image"

_AVATAR_FILE = "avatar.webp"
_AVATAR_FILE_ALT = "avatar.png"
_AVATAR_FILE_JPG = "avatar.jpg"
_MAX_BYTES = 10 * 1024 * 1024
_MAX_DIM = 4096
#: Uploaded pictures are cropped to a square and capped to this edge length so a
#: 4000px phone photo does not get shipped to every org-board render.
_TARGET_DIM = 512


def _paths():
    from evoflow.config.paths import get_paths

    return get_paths()


def is_image_avatar(raw: str | None) -> bool:
    """True when *raw* selects the uploaded file instead of a preset."""
    return str(raw or "").strip().lower() == IMAGE_AVATAR


def _dept_dir(dept_id: str) -> Path:
    return _paths().dept_avatar_dir(dept_id)


def avatar_path_for(dept_id: str) -> Path | None:
    """Existing uploaded avatar file for *dept_id*, if any."""
    try:
        base = _dept_dir(dept_id)
    except ValueError:
        return None
    for name in (_AVATAR_FILE, _AVATAR_FILE_ALT, _AVATAR_FILE_JPG):
        p = base / name
        if p.is_file():
            return p
    return None


def avatar_revision_for(dept_id: str) -> str | None:
    """Cheap cache-bust token for ``/avatar?v=…``."""
    path = avatar_path_for(dept_id)
    if path is None:
        return None
    try:
        return f"u{int(path.stat().st_mtime)}"
    except OSError:
        return None


def has_local_avatar_file(dept_id: str) -> bool:
    return avatar_path_for(dept_id) is not None


def content_type_for(path: Path) -> str:
    if path.suffix.lower() == ".png":
        return "image/png"
    if path.suffix.lower() in {".jpg", ".jpeg"}:
        return "image/jpeg"
    return "image/webp"


def _has_image_magic(data: bytes) -> bool:
    webp = len(data) >= 12 and data[0:4] == b"RIFF" and data[8:12] == b"WEBP"
    png = data.startswith(b"\x89PNG\r\n\x1a\n")
    jpeg = len(data) >= 3 and data[0:3] == b"\xff\xd8\xff"
    return webp or png or jpeg


def _image_dimensions(data: bytes) -> tuple[int, int] | None:
    if data.startswith(b"\x89PNG\r\n\x1a\n") and len(data) >= 24 and data[12:16] == b"IHDR":
        w = int.from_bytes(data[16:20], "big")
        h = int.from_bytes(data[20:24], "big")
        return w, h
    if len(data) >= 30 and data[0:4] == b"RIFF" and data[8:12] == b"WEBP" and data[12:16] == b"VP8X":

        def le24(b: bytes) -> int:
            return b[0] | (b[1] << 8) | (b[2] << 16)

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


def _normalize_to_webp(data: bytes) -> bytes | None:
    """Square-crop + downscale to ``_TARGET_DIM`` WebP, or ``None`` when PIL missing.

    Phone photos are 4000px and 5MB; the org board paints these at 28–44px. A
    one-time resize keeps the DB row tiny and the payload cache-friendly.
    """
    try:
        import io

        from PIL import Image
    except Exception:
        return None
    try:
        with Image.open(io.BytesIO(data)) as im:
            im.load()
            rgba = im.convert("RGBA")
            w, h = rgba.size
            side = min(w, h)
            box = ((w - side) // 2, (h - side) // 2, (w - side) // 2 + side, (h - side) // 2 + side)
            out = rgba.crop(box)
            if side > _TARGET_DIM:
                out = out.resize((_TARGET_DIM, _TARGET_DIM), Image.LANCZOS)
            buf = io.BytesIO()
            out.save(buf, format="WEBP", lossless=True, method=4)
            return buf.getvalue()
    except Exception:
        logger.debug("dept avatar: PIL normalize failed, storing raw bytes", exc_info=True)
        return None


def save_avatar_bytes(dept_id: str, data: bytes) -> Path:
    """Write the uploaded avatar, leaving exactly one image file on disk."""
    validate_avatar_bytes(data)
    normalized = _normalize_to_webp(data)
    if normalized:
        data = normalized
    base = _dept_dir(dept_id)
    base.mkdir(parents=True, exist_ok=True)
    if data.startswith(b"\x89PNG"):
        ext = ".png"
    elif data[0:3] == b"\xff\xd8\xff":
        ext = ".jpg"
    else:
        ext = ".webp"
    dest = base / f"avatar{ext}"
    tmp = base / f".avatar-upload{ext}"
    tmp.write_bytes(data)
    tmp.replace(dest)
    for name in (_AVATAR_FILE, _AVATAR_FILE_ALT, _AVATAR_FILE_JPG):
        other = base / name
        if other != dest and other.is_file():
            other.unlink(missing_ok=True)
    return dest


def delete_avatar_file(dept_id: str) -> None:
    try:
        base = _dept_dir(dept_id)
    except ValueError:
        return
    for name in (_AVATAR_FILE, _AVATAR_FILE_ALT, _AVATAR_FILE_JPG):
        p = base / name
        if p.is_file():
            try:
                p.unlink()
            except OSError:
                logger.debug("failed to delete dept avatar file %s", p, exc_info=True)
