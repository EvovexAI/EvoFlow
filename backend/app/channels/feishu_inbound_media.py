"""Download Feishu inbound media into local temp files for the agent.

Uses lark-oapi ``im.v1.message_resource.get`` (GetMessageResource). Downstream
``ChannelManager`` forwards ``InboundMessage.files`` as ``context_files`` and
calls ``release_owned_temp_paths`` when the run finishes.
"""

from __future__ import annotations

import asyncio
import logging
import mimetypes
import os
import tempfile
from pathlib import Path
from typing import Any, Callable

from app.channels.feishu_inbound_parse import FeishuMediaRef, is_downloadable_kind

logger = logging.getLogger(__name__)

# Soft caps — keep agent context sane; Feishu API allows up to 100MB.
_MAX_IMAGE_BYTES = 20 * 1024 * 1024
_MAX_FILE_BYTES = 50 * 1024 * 1024
_ABSOLUTE_MAX_BYTES = 100 * 1024 * 1024
_MAX_REFS_PER_MESSAGE = 12


class FeishuInboundMediaCache:
    """Cache Feishu message resources to temp paths owned by the channel."""

    def __init__(
        self,
        *,
        client_resolver: Callable[[str | None], Any],
        account_id: str = "",
    ) -> None:
        self._client_resolver = client_resolver
        self._account_id = str(account_id or "").strip()
        self._temp_paths: set[str] = set()
        self._GetMessageResourceRequest: Any = None

    def _ensure_sdk(self) -> bool:
        if self._GetMessageResourceRequest is not None:
            return True
        try:
            from lark_oapi.api.im.v1 import GetMessageResourceRequest

            self._GetMessageResourceRequest = GetMessageResourceRequest
            return True
        except Exception:
            logger.warning("[FeishuMedia] lark-oapi GetMessageResourceRequest unavailable")
            return False

    async def materialize(
        self,
        refs: list[FeishuMediaRef],
        *,
        account_id: str = "",
    ) -> tuple[list[dict[str, Any]], list[str]]:
        """Download refs → ``(file_descriptors, owned_temp_paths)``."""
        if not refs:
            return [], []
        if not self._ensure_sdk():
            return [], []

        aid = str(account_id or self._account_id or "").strip()
        client = self._client_resolver(aid)
        if client is None:
            logger.warning("[FeishuMedia] no API client for account=%s", aid or "primary")
            return [], []

        descriptors: list[dict[str, Any]] = []
        owned: list[str] = []
        for ref in refs[:_MAX_REFS_PER_MESSAGE]:
            if not ref.file_key or not ref.message_id or not is_downloadable_kind(ref.kind):
                continue
            try:
                cached = await self._download_one(client, ref)
            except Exception:
                logger.exception(
                    "[FeishuMedia] download failed kind=%s key=%s msg=%s",
                    ref.kind,
                    ref.file_key[:16],
                    ref.message_id[:16],
                )
                continue
            if not cached:
                continue
            path, mime, filename, size = cached
            owned.append(path)
            descriptors.append(
                {
                    "kind": ref.kind if ref.kind in {"image", "file", "audio", "video"} else "file",
                    "path": path,
                    "mime": mime,
                    "filename": filename,
                    "size": size,
                    "url": "",
                    "account_id": aid,
                    "provider_file_id": ref.file_key,
                    "provider_message_id": ref.message_id,
                }
            )
        return descriptors, owned

    async def _download_one(
        self, client: Any, ref: FeishuMediaRef
    ) -> tuple[str, str, str, int] | None:
        request = (
            self._GetMessageResourceRequest.builder()
            .message_id(ref.message_id)
            .file_key(ref.file_key)
            .type(ref.resource_type or ("image" if ref.kind == "image" else "file"))
            .build()
        )
        resource_api = getattr(getattr(getattr(client, "im", None), "v1", None), "message_resource", None)
        if resource_api is None:
            logger.warning("[FeishuMedia] client missing im.v1.message_resource")
            return None

        get_fn = getattr(resource_api, "get", None)
        if get_fn is None:
            return None

        response = await asyncio.to_thread(get_fn, request)
        if response is None or getattr(response, "code", 1) != 0:
            logger.warning(
                "[FeishuMedia] resource get failed code=%s msg=%s key=%s",
                getattr(response, "code", None),
                getattr(response, "msg", None),
                ref.file_key[:16],
            )
            return None

        file_obj = getattr(response, "file", None)
        if file_obj is None:
            return None
        try:
            raw = file_obj.read() if hasattr(file_obj, "read") else bytes(file_obj)
        finally:
            close = getattr(file_obj, "close", None)
            if callable(close):
                try:
                    close()
                except Exception:
                    pass

        if not isinstance(raw, (bytes, bytearray)):
            raw = bytes(raw or b"")
        raw = bytes(raw)
        size = len(raw)
        if size <= 0:
            return None
        if size > _ABSOLUTE_MAX_BYTES:
            logger.warning("[FeishuMedia] skip oversized resource (%d bytes)", size)
            return None
        limit = _MAX_IMAGE_BYTES if ref.kind == "image" else _MAX_FILE_BYTES
        if size > limit:
            logger.warning(
                "[FeishuMedia] skip %s over soft limit (%d > %d)",
                ref.kind,
                size,
                limit,
            )
            return None

        api_name = str(getattr(response, "file_name", None) or "").strip()
        filename = ref.filename or api_name or _default_filename(ref)
        mime = _guess_mime(filename, ref.kind, raw)
        if ref.kind == "image":
            ext = _detect_image_ext(raw)
            filename = _ensure_ext(filename, ext)
            mime = _mime_for_ext(ext, fallback=mime or "image/jpeg")
        else:
            ext = Path(filename).suffix or _ext_for_kind(ref.kind)
            filename = _ensure_ext(filename, ext)

        path = self._cache_bytes(raw, Path(filename).suffix or ".bin")
        return path, mime, Path(filename).name, size

    def _cache_bytes(self, data: bytes, suffix: str) -> str:
        if suffix and not suffix.startswith("."):
            suffix = f".{suffix}"
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix or ".bin") as tmp:
            tmp.write(data)
            path = tmp.name
        self._temp_paths.add(path)
        return path

    def release_owned_temp_paths(self, paths: list[str] | None) -> None:
        if not paths:
            return
        asyncio.create_task(self._cleanup_temp_paths(list(paths)))

    async def _cleanup_temp_paths(self, paths: list[str]) -> None:
        for path in paths:
            self._temp_paths.discard(path)
            try:
                os.unlink(path)
            except OSError as exc:
                logger.debug("[FeishuMedia] failed to remove temp %s: %s", path, exc)

    async def cleanup_all(self) -> None:
        paths = list(self._temp_paths)
        self._temp_paths.clear()
        await self._cleanup_temp_paths(paths)


def _default_filename(ref: FeishuMediaRef) -> str:
    key = (ref.file_key or "x")[:8]
    return {
        "image": f"feishu-image-{key}.jpg",
        "audio": f"feishu-audio-{key}.ogg",
        "video": f"feishu-video-{key}.mp4",
    }.get(ref.kind, f"feishu-file-{key}.bin")


def _guess_mime(filename: str, kind: str, raw: bytes) -> str:
    guessed = mimetypes.guess_type(filename)[0]
    if guessed:
        return guessed.split(";", 1)[0].strip()
    if kind == "image":
        return _mime_for_ext(_detect_image_ext(raw), fallback="image/jpeg")
    if kind == "audio":
        return "audio/ogg"
    if kind == "video":
        return "video/mp4"
    return "application/octet-stream"


def _detect_image_ext(data: bytes) -> str:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if data.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return ".gif"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return ".webp"
    return ".jpg"


def _mime_for_ext(ext: str, *, fallback: str) -> str:
    return {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
    }.get(ext.lower(), fallback)


def _ext_for_kind(kind: str) -> str:
    return {"image": ".jpg", "audio": ".ogg", "video": ".mp4"}.get(kind, ".bin")


def _ensure_ext(filename: str, ext: str) -> str:
    name = str(filename or "attachment").strip() or "attachment"
    if not ext:
        return name
    if not ext.startswith("."):
        ext = f".{ext}"
    if Path(name).suffix.lower() == ext.lower():
        return name
    if Path(name).suffix:
        return name
    return f"{name}{ext}"
