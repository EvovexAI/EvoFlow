"""Resolve local outputs paths / data URLs to provider-accessible references.

Official Ark (Seedream / Seedance) accepts for images:
- Public http(s) URL
- Data URI: ``data:image/<fmt>;base64,<payload>`` (fmt lowercase; NOT raw base64)
- ``asset://<ASSET_ID>``

MiniMax Hailuo: public URL or Data URI.
DashScope Wan: prefers ``oss://`` temp upload for local files.
"""

from __future__ import annotations

import base64
import logging
import os
import re
from pathlib import Path
from urllib.parse import urlparse

from langchain.tools import ToolRuntime
from langgraph.typing import ContextT

from evoflow.agents.thread_state import ThreadState
from evoflow.community.media_generation.asset_recorder import thread_id_from_runtime
from evoflow.community.media_generation.providers.dashscope_upload import upload_local_file
from evoflow.persistence.media_assets import find_remote_url_for_local_path
from evoflow.tools.host_direct.workspace_context import resolve_effective_outputs_dir

logger = logging.getLogger(__name__)

_AT_MENTION_RE = re.compile(r"@@(.+?)@@")
_DATA_URL_RE = re.compile(r"^data:(image|audio)/[a-z0-9.+-]+;base64,", re.IGNORECASE)

_IMAGE_MIME = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".gif": "image/gif",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
    ".heic": "image/heic",
    ".heif": "image/heif",
}


def is_data_url(value: str | None) -> bool:
    return bool(_DATA_URL_RE.match(str(value or "").strip()))


def is_provider_accessible_url(value: str | None) -> bool:
    s = str(value or "").strip()
    if not s:
        return False
    if s.startswith("oss://") or s.startswith("asset://"):
        return True
    if is_data_url(s):
        return True
    parsed = urlparse(s)
    return parsed.scheme in ("http", "https") and bool(parsed.netloc)


def _strip_wrappers(raw: str) -> str:
    s = str(raw or "").strip()
    m = _AT_MENTION_RE.fullmatch(s)
    if m:
        s = m.group(1).strip()
    return s.strip().strip('"').strip("'")


def _normalize_path_key(path_like: str) -> str:
    return _strip_wrappers(path_like).replace("\\", "/").strip("/")


def _path_match_keys(raw: str, *, outputs_dir: Path | None) -> set[str]:
    s = _strip_wrappers(raw)
    keys: set[str] = set()
    if not s:
        return keys
    norm = _normalize_path_key(s)
    keys.add(norm)
    keys.add(norm.lower())
    name = Path(norm).name
    if name:
        keys.add(name)
        keys.add(name.lower())
        keys.add(f"outputs/{name}")
    p = Path(s)
    try:
        if p.is_file():
            keys.add(str(p.resolve()).replace("\\", "/"))
            keys.add(str(p.resolve()).replace("\\", "/").lower())
    except OSError:
        pass
    if outputs_dir is not None:
        try:
            od = outputs_dir.resolve()
            cand = od / name if name else None
            if cand and cand.is_file():
                keys.add(str(cand.resolve()).replace("\\", "/"))
                keys.add(f"outputs/{name}")
            if p.is_absolute() and name:
                keys.add(str((od / name).resolve()).replace("\\", "/"))
        except OSError:
            pass
    return {k for k in keys if k}


def resolve_local_media_file(raw: str, *, outputs_dir: Path | None) -> Path | None:
    """Map a tool argument (local path / outputs/… / @@…@@) to an existing file."""
    s = _strip_wrappers(raw)
    if not s or is_provider_accessible_url(s):
        return None
    if s.startswith("outputs/") and outputs_dir is not None:
        p = outputs_dir / s[len("outputs/") :]
        if p.is_file():
            return p.resolve()
    p = Path(s)
    if p.is_file():
        return p.resolve()
    name = p.name
    if outputs_dir is not None and name:
        cand = outputs_dir / name
        if cand.is_file():
            return cand.resolve()
    return None


def _lookup_cached_remote_url(
    raw: str,
    *,
    thread_id: str | None,
    outputs_dir: Path | None,
    media_kind: str | None = None,
) -> str | None:
    if not thread_id:
        return None
    keys = _path_match_keys(raw, outputs_dir=outputs_dir)
    if not keys:
        return None
    return find_remote_url_for_local_path(
        thread_id=thread_id,
        path_keys=keys,
        media_kind=media_kind,
    )


def _dashscope_upload_model(*, purpose: str, provider: str) -> str | None:
    if provider != "wan":
        return None
    if purpose == "first_frame":
        return os.getenv("DASHSCOPE_VIDEO_I2V_MODEL", "wan2.7-i2v")
    if purpose == "audio":
        return os.getenv("DASHSCOPE_VIDEO_T2V_MODEL", "wan2.7-t2v")
    return os.getenv("DASHSCOPE_VIDEO_I2V_MODEL", "wan2.7-i2v")


def encode_local_image_as_data_url(local_file: Path) -> str:
    """Ark / MiniMax require full Data URI, never raw base64."""
    suffix = local_file.suffix.lower()
    mime = _IMAGE_MIME.get(suffix, "image/jpeg")
    b64 = base64.b64encode(local_file.read_bytes()).decode("ascii")
    return f"data:{mime};base64,{b64}"


def _jimeng_accepts_local_encode(purpose: str) -> bool:
    return purpose in {
        "first_frame",
        "last_frame",
        "reference",
        "image2image",
        "reference_image",
    }


def _minimax_accepts_local_encode(purpose: str) -> bool:
    return purpose in {
        "first_frame",
        "last_frame",
        "reference",
        "image2image",
        "reference_image",
    }


def resolve_media_reference_url(
    raw: str | None,
    *,
    runtime: ToolRuntime[ContextT, ThreadState] | None,
    provider: str,
    purpose: str,
    media_kind: str | None = None,
    outputs_dir: Path | None = None,
) -> tuple[str | None, str | None]:
    """Return (resolved_url, note) for image/video reference args.

    Accepted inputs:
    - ``https://…`` public URL
    - ``data:image/<fmt>;base64,…`` Data URI (already OK)
    - ``oss://…`` / ``asset://…``
    - local ``outputs/…`` or absolute path → provider-specific encoding/upload
    """
    s = _strip_wrappers(str(raw or ""))
    if not s:
        return None, None

    # Reject naked base64 (no data: prefix) — Ark treats it as invalid URL.
    if re.fullmatch(r"[A-Za-z0-9+/=\s]{64,}", s) and not s.startswith("data:"):
        raise ValueError(
            "Reference image looks like raw base64. Pass a full Data URI "
            "`data:image/png;base64,...` or a public https URL / local outputs path."
        )

    if is_provider_accessible_url(s):
        return s, None

    out_dir = outputs_dir if outputs_dir is not None else resolve_effective_outputs_dir(runtime=runtime)
    tid = thread_id_from_runtime(runtime)

    cached = _lookup_cached_remote_url(s, thread_id=tid, outputs_dir=out_dir, media_kind=media_kind)
    if cached:
        return cached, "Resolved local path via media asset registry (remote URL from prior generate)."

    local_file = resolve_local_media_file(s, outputs_dir=out_dir)
    if local_file is None:
        raise ValueError(
            f"Media reference must be http(s) URL, data:image/...;base64,..., "
            f"oss:// / asset://, or a file under outputs/; could not resolve: {s!r}"
        )

    upload_model = _dashscope_upload_model(purpose=purpose, provider=provider)
    if upload_model:
        oss_url = upload_local_file(file_path=local_file, model_name=upload_model)
        return oss_url, f"Uploaded local file to DashScope temporary storage ({local_file.name})."

    if provider == "jimeng" and _jimeng_accepts_local_encode(purpose):
        data_url = encode_local_image_as_data_url(local_file)
        return data_url, f"Encoded local image as data URL for Ark ({local_file.name})."

    if provider in {"minimax", "hailuo"} and _minimax_accepts_local_encode(purpose):
        data_url = encode_local_image_as_data_url(local_file)
        return data_url, f"Encoded local image as data URL for MiniMax ({local_file.name})."

    if provider == "openai" and _jimeng_accepts_local_encode(purpose):
        data_url = encode_local_image_as_data_url(local_file)
        return data_url, f"Encoded local image as data URL for OpenAI ({local_file.name})."

    raise ValueError(
        f"Provider {provider!r} requires a public http(s) URL or data URI for {purpose}; "
        f"got local path {s!r} with no cached remote URL. "
        "Pass the `url` from a prior generate_image, or a data:image/...;base64,... URI."
    )


def uses_dashscope_oss_resolve(*urls: str | None) -> bool:
    return any(str(u or "").strip().startswith("oss://") for u in urls)
