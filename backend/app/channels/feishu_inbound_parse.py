"""Parse Feishu ``im.message.receive_v1`` payloads into text + media refs.

Feishu sends **one ``message_type`` per event**. Plain image/file/audio/media
arrive as separate events from any follow-up text. Rich ``post`` messages may
embed ``img`` / ``media`` tags in the same content blob.

This module is pure (no I/O): it only normalizes the event into
``ParsedFeishuInbound`` so download / coalesce layers stay testable.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)

# Resource types we can download via im/v1/messages/:id/resources/:key.
_DOWNLOADABLE_KINDS = frozenset({"image", "file", "audio", "video"})
# Feishu API ``type`` query for GetMessageResource: image | file
# (file covers files, audio, and video per official docs).
_RESOURCE_API_TYPE = {
    "image": "image",
    "file": "file",
    "audio": "file",
    "video": "file",
}


@dataclass(frozen=True)
class FeishuMediaRef:
    """One downloadable resource referenced by a Feishu message."""

    kind: str  # image | file | audio | video
    file_key: str
    message_id: str
    filename: str = ""
    resource_type: str = ""  # API query ``type``; empty → derived from kind

    def __post_init__(self) -> None:
        object.__setattr__(self, "kind", (self.kind or "file").strip().lower() or "file")
        object.__setattr__(self, "file_key", str(self.file_key or "").strip())
        object.__setattr__(self, "message_id", str(self.message_id or "").strip())
        object.__setattr__(self, "filename", str(self.filename or "").strip())
        api_type = _RESOURCE_API_TYPE.get(self.kind, "file")
        explicit = str(self.resource_type or "").strip()
        object.__setattr__(self, "resource_type", explicit or api_type)


@dataclass
class ParsedFeishuInbound:
    """Normalized inbound payload ready for download + coalesce."""

    text: str = ""
    message_type: str = "text"  # raw Feishu message_type
    refs: list[FeishuMediaRef] = field(default_factory=list)
    unsupported: str = ""  # sticker / folder / … when we skip intentionally

    @property
    def has_content(self) -> bool:
        return bool(self.text.strip()) or bool(self.refs)


def parse_feishu_message(
    *,
    message_type: str,
    content: Any,
    message_id: str,
) -> ParsedFeishuInbound:
    """Parse Feishu message content JSON into text + media refs.

    ``content`` may be a dict or a JSON string (as delivered on the event).
    """
    msg_type = str(message_type or "").strip().lower()
    mid = str(message_id or "").strip()
    body = _coerce_content_dict(content)

    if msg_type in {"sticker", "folder"}:
        return ParsedFeishuInbound(message_type=msg_type, unsupported=msg_type)

    if msg_type == "image":
        key = _str(body.get("image_key"))
        if key and mid:
            return ParsedFeishuInbound(
                message_type=msg_type,
                refs=[FeishuMediaRef(kind="image", file_key=key, message_id=mid)],
            )
        return ParsedFeishuInbound(message_type=msg_type)

    if msg_type == "file":
        key = _str(body.get("file_key"))
        name = _str(body.get("file_name") or body.get("filename"))
        if key and mid:
            return ParsedFeishuInbound(
                message_type=msg_type,
                refs=[
                    FeishuMediaRef(
                        kind="file",
                        file_key=key,
                        message_id=mid,
                        filename=name or f"feishu-file-{key[:8]}",
                    )
                ],
            )
        return ParsedFeishuInbound(message_type=msg_type)

    if msg_type == "audio":
        key = _str(body.get("file_key"))
        if key and mid:
            return ParsedFeishuInbound(
                message_type=msg_type,
                refs=[
                    FeishuMediaRef(
                        kind="audio",
                        file_key=key,
                        message_id=mid,
                        filename=f"feishu-audio-{key[:8]}.ogg",
                    )
                ],
            )
        return ParsedFeishuInbound(message_type=msg_type)

    if msg_type in {"media", "video"}:
        key = _str(body.get("file_key"))
        name = _str(body.get("file_name") or body.get("filename"))
        if key and mid:
            return ParsedFeishuInbound(
                message_type="media",
                refs=[
                    FeishuMediaRef(
                        kind="video",
                        file_key=key,
                        message_id=mid,
                        filename=name or f"feishu-video-{key[:8]}.mp4",
                    )
                ],
            )
        return ParsedFeishuInbound(message_type="media")

    if msg_type == "post" or _looks_like_post(body):
        text, refs = _parse_post(body, message_id=mid)
        return ParsedFeishuInbound(text=text, message_type="post", refs=refs)

    # Default / text (and unknown types that still carry a text field)
    text = _str(body.get("text"))
    if not text and _looks_like_post(body):
        text, refs = _parse_post(body, message_id=mid)
        return ParsedFeishuInbound(text=text, message_type=msg_type or "post", refs=refs)

    # Infer lone image_key / file_key when message_type is missing/wrong.
    refs: list[FeishuMediaRef] = []
    if not text and mid:
        image_key = _str(body.get("image_key"))
        file_key = _str(body.get("file_key"))
        if image_key and not file_key:
            refs.append(FeishuMediaRef(kind="image", file_key=image_key, message_id=mid))
        elif file_key:
            name = _str(body.get("file_name") or body.get("filename"))
            refs.append(
                FeishuMediaRef(
                    kind="file",
                    file_key=file_key,
                    message_id=mid,
                    filename=name or f"feishu-file-{file_key[:8]}",
                )
            )

    return ParsedFeishuInbound(text=text, message_type=msg_type or "text", refs=refs)


def _coerce_content_dict(content: Any) -> dict[str, Any]:
    if isinstance(content, dict):
        return content
    if isinstance(content, str):
        raw = content.strip()
        if not raw:
            return {}
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            logger.debug("[FeishuParse] content is not JSON, treating as plain text")
            return {"text": content}
        if isinstance(parsed, dict):
            return parsed
        return {}
    return {}


def _looks_like_post(body: dict[str, Any]) -> bool:
    if isinstance(body.get("content"), list):
        return True
    for key in ("zh_cn", "en_us", "post"):
        nested = body.get(key)
        if isinstance(nested, dict) and isinstance(nested.get("content"), list):
            return True
    return False


def _parse_post(body: dict[str, Any], *, message_id: str) -> tuple[str, list[FeishuMediaRef]]:
    locale = _post_locale_root(body)
    title = _str(locale.get("title") or body.get("title"))
    paragraphs = locale.get("content")
    if not isinstance(paragraphs, list):
        paragraphs = body.get("content") if isinstance(body.get("content"), list) else []

    text_paragraphs: list[str] = []
    refs: list[FeishuMediaRef] = []
    seen_keys: set[str] = set()

    for paragraph in paragraphs:
        if not isinstance(paragraph, list):
            continue
        parts: list[str] = []
        for element in paragraph:
            if not isinstance(element, dict):
                continue
            tag = _str(element.get("tag")).lower()
            if tag in {"text", "at", "a", "md", "code_block"}:
                value = _str(element.get("text"))
                if tag == "a":
                    href = _str(element.get("href"))
                    if href and href != value:
                        value = f"{value} {href}".strip() if value else href
                if value:
                    parts.append(value)
            elif tag == "img":
                key = _str(element.get("image_key"))
                if key and message_id and key not in seen_keys:
                    seen_keys.add(key)
                    refs.append(
                        FeishuMediaRef(kind="image", file_key=key, message_id=message_id)
                    )
            elif tag == "media":
                key = _str(element.get("file_key"))
                if key and message_id and key not in seen_keys:
                    seen_keys.add(key)
                    refs.append(
                        FeishuMediaRef(
                            kind="video",
                            file_key=key,
                            message_id=message_id,
                            filename=f"feishu-video-{key[:8]}.mp4",
                        )
                    )
                # Cover image is optional; skip unless no video key.
                cover = _str(element.get("image_key"))
                if not key and cover and message_id and cover not in seen_keys:
                    seen_keys.add(cover)
                    refs.append(
                        FeishuMediaRef(kind="image", file_key=cover, message_id=message_id)
                    )
            # emotion / hr → ignore
        if parts:
            text_paragraphs.append(" ".join(parts))

    body_text = "\n\n".join(text_paragraphs).strip()
    if title and body_text:
        text = f"{title}\n{body_text}"
    else:
        text = body_text or title
    return text, refs


def _post_locale_root(body: dict[str, Any]) -> dict[str, Any]:
    post = body.get("post") if isinstance(body.get("post"), dict) else None
    for candidate in (
        body.get("zh_cn"),
        body.get("en_us"),
        (post or {}).get("zh_cn") if post else None,
        (post or {}).get("en_us") if post else None,
        post,
        body,
    ):
        if isinstance(candidate, dict) and (
            isinstance(candidate.get("content"), list) or _str(candidate.get("title"))
        ):
            return candidate
    return body


def _str(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def is_downloadable_kind(kind: str) -> bool:
    return str(kind or "").strip().lower() in _DOWNLOADABLE_KINDS
