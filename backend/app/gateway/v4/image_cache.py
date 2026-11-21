"""V4 行附件的大 data: URL 落盘缓存（对齐 ZCode：行内不背大媒体字节）。

桌面 chatSend 把图片编码成 data: URL 块；旧行为把整串 base64 原样塞进 V4 row
attachments，快照/SSE 帧/主线程 JSON.parse 全部跟着膨胀（单张实测可达 2.8MB）。
ZCode 的做法是 attachments 只带 ref、字节按需取。这里把超过内联阈值的 data: URL
按内容寻址落到 ``{EVOFLOW_HOME}/v4-image-cache/``，ref 换成本地文件路径——
前端 readAttachment shim 对本地路径走 convertFileSrc（桌面）/ serve-file（Web），
两条现成链路，前端零改动。

内容寻址（sha1(url)）保证幂等：水合重放/多会话同图只写一次盘。
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import os
import tempfile
from pathlib import Path

# ≤ 该字符数的 data: URL 保持行内（小图即时渲染、帧成本可忽略）；超过才落盘。
# 64k chars ≈ 48KB 二进制——用户粘贴的截图通常 ≥100KB，几乎全部走缓存路径。
DATA_URL_INLINE_MAX_CHARS = 64_000

_EXTENSION_BY_MIME = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/bmp": ".bmp",
    "image/svg+xml": ".svg",
}


def v4_image_cache_dir() -> Path:
    """``{EVOFLOW_HOME}/v4-image-cache``（与 channel-messages 同一根，缺则创建）。"""
    try:
        from evoflow.config.paths import get_paths

        base = Path(get_paths().base_dir)
    except Exception:
        base = Path.home() / ".evoflow"
    root = base / "v4-image-cache"
    root.mkdir(parents=True, exist_ok=True)
    return root


def parse_data_url(url: str) -> tuple[str, bytes] | None:
    """``data:[mime][;base64],payload`` → ``(mime, bytes)``；解析失败返回 None。"""
    raw = str(url or "").strip()
    if not raw.lower().startswith("data:"):
        return None
    header, _, payload = raw.partition(",")
    if not payload:
        return None
    mime = header[5:].split(";", 1)[0].strip().lower() or "application/octet-stream"
    if ";base64" not in header.lower():
        return None
    try:
        return mime, base64.b64decode(payload, validate=False)
    except (binascii.Error, ValueError):
        return None


def materialize_image_data_url(url: str) -> str | None:
    """大 data: URL → 缓存文件绝对路径；小图/解析失败返回 None（调用方保持行内）。

    写盘用临时文件 + ``os.replace`` 原子落位，并发水合/直播同名碰撞只留一份完整文件。
    """
    raw = str(url or "").strip()
    if len(raw) <= DATA_URL_INLINE_MAX_CHARS:
        return None
    parsed = parse_data_url(raw)
    if not parsed or not parsed[1]:
        return None
    mime, payload = parsed
    ext = _EXTENSION_BY_MIME.get(mime)
    if ext is None:
        ext = ".png" if mime.startswith("image/") else ".bin"
    digest = hashlib.sha1(raw.encode("utf-8", "ignore")).hexdigest()[:20]
    target = v4_image_cache_dir() / f"{digest}{ext}"
    try:
        if not target.exists() or target.stat().st_size != len(payload):
            fd, tmp = tempfile.mkstemp(dir=str(target.parent), suffix=".tmp")
            try:
                with os.fdopen(fd, "wb") as fh:
                    fh.write(payload)
                os.replace(tmp, str(target))
            finally:
                if os.path.exists(tmp):
                    try:
                        os.unlink(tmp)
                    except OSError:
                        pass
    except OSError:
        return None
    return str(target)
