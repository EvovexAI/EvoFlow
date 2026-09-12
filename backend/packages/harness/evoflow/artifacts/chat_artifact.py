"""Chat deliverable (产物) contract — structured present, not @@ scrape.

Types: file | image | video | url | html | text
Location: path XOR url XOR content (at least one).
"""

from __future__ import annotations

import hashlib
import re
from typing import Any

ARTIFACT_TYPES = frozenset({"file", "image", "video", "url", "html", "text", "platform"})

_IMAGE_EXT = frozenset({".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".ico"})
_VIDEO_EXT = frozenset({".mp4", ".webm", ".mov", ".mkv", ".avi", ".m4v"})
_HTML_EXT = frozenset({".html", ".htm"})

_NAME_MAX = 240
_LABEL_MAX = 200
_PATH_MAX = 2000
_URL_MAX = 4000
_CONTENT_MAX = 200_000
_ID_MAX = 128


def normalize_artifact_type(raw: Any, *, path: str = "", url: str = "", mime: str = "") -> str:
    t = str(raw or "").strip().lower()
    if t in ARTIFACT_TYPES:
        return t
    if t in {"path", "filepath", "doc", "document", "attachment"}:
        return "file"
    if t in {"link", "uri", "href"}:
        return "url"
    if t in {"note", "string", "markdown", "md"}:
        return "text"
    if t in {"webpage", "page"}:
        return "html"
    mime_l = str(mime or "").strip().lower()
    if mime_l.startswith("image/"):
        return "image"
    if mime_l.startswith("video/"):
        return "video"
    if mime_l in {"text/html", "application/xhtml+xml"}:
        return "html"
    probe = (path or url or "").lower().split("?", 1)[0]
    for ext in _IMAGE_EXT:
        if probe.endswith(ext):
            return "image"
    for ext in _VIDEO_EXT:
        if probe.endswith(ext):
            return "video"
    for ext in _HTML_EXT:
        if probe.endswith(ext):
            return "html"
    if str(url or "").strip():
        return "url"
    return "file"


def _basename(path_or_url: str) -> str:
    s = str(path_or_url or "").replace("\\", "/").rstrip("/")
    if not s:
        return ""
    return s.rsplit("/", 1)[-1] or s


def make_artifact_id(*, type_: str, path: str = "", url: str = "", content: str = "", name: str = "") -> str:
    """Stable identity for append/upsert (not a display label)."""
    if path:
        key = f"path:{path.replace(chr(92), '/')}"
    elif url:
        key = f"url:{url}"
    elif content:
        digest = hashlib.sha256(content.encode("utf-8", errors="ignore")).hexdigest()[:24]
        key = f"content:{type_}:{name or 'untitled'}:{digest}"
    else:
        key = f"empty:{type_}:{name or 'untitled'}"
    # Keep PK-friendly length
    if len(key) <= _ID_MAX:
        return key
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()[:40]
    return f"h:{digest}"


def normalize_chat_artifact(raw: Any) -> dict[str, Any] | None:
    """Normalize one tool/API payload into a ChatArtifact dict, or None if invalid."""
    if raw is None:
        return None
    if isinstance(raw, str):
        s = raw.strip()
        if not s:
            return None
        if re.match(r"^https?://", s, re.I):
            return normalize_chat_artifact({"type": "url", "url": s})
        return normalize_chat_artifact({"type": "file", "path": s})

    if not isinstance(raw, dict):
        return None

    type_raw = str(raw.get("type") or raw.get("kind") or "").strip().lower()
    if type_raw == "platform":
        title = str(raw.get("label") or raw.get("title") or raw.get("name") or "").strip()[:_LABEL_MAX]
        if not title:
            return None
        tcid = str(raw.get("toolCallId") or raw.get("tool_call_id") or "").strip()
        action = str(raw.get("platformAction") or raw.get("platform_action") or raw.get("action") or "").strip()
        entity_id = str(raw.get("entityId") or raw.get("entity_id") or "").strip()
        aid = str(raw.get("id") or raw.get("artifact_id") or "").strip()
        if not aid:
            if tcid:
                aid = f"platform:{tcid}"
            elif action:
                aid = f"platform:{action}:{entity_id or title}"
            else:
                aid = f"platform:{title}"
        route = str(raw.get("url") or raw.get("route") or "").strip()[:_URL_MAX]
        kind_raw = str(raw.get("platformFeedbackKind") or raw.get("platform_feedback_kind") or raw.get("kind") or "").strip().lower()
        kind = kind_raw if kind_raw in {"warning", "error"} else "success"
        out: dict[str, Any] = {
            "id": aid[:_ID_MAX],
            "type": "platform",
            "name": title,
            "label": title,
            "platformFeedbackKind": kind,
        }
        if route:
            out["url"] = route
        if action:
            out["platformAction"] = action
        domain = str(raw.get("platformDomain") or raw.get("platform_domain") or raw.get("domain") or "").strip()
        if domain:
            out["platformDomain"] = domain
        subtitle = str(raw.get("platformSubtitle") or raw.get("platform_subtitle") or raw.get("subtitle") or "").strip()
        if subtitle:
            out["platformSubtitle"] = subtitle
        if tcid:
            out["toolCallId"] = tcid
        actions = raw.get("platformActions") or raw.get("platform_actions") or raw.get("actions")
        if isinstance(actions, list) and actions:
            out["platformActions"] = actions
        status = str(raw.get("status") or "").strip().lower()
        if status in {"new", "updated"}:
            out["status"] = status
        return out

    path = str(raw.get("path") or "").strip()[:_PATH_MAX]
    url = str(raw.get("url") or raw.get("href") or raw.get("link") or "").strip()[:_URL_MAX]
    content = raw.get("content")
    content_s = "" if content is None else str(content)[:_CONTENT_MAX]
    mime = str(raw.get("mime") or raw.get("mime_type") or "").strip()[:120]
    name = str(raw.get("name") or raw.get("filename") or "").strip()[:_NAME_MAX]
    label = str(raw.get("label") or raw.get("title") or "").strip()[:_LABEL_MAX]
    type_ = normalize_artifact_type(raw.get("type") or raw.get("kind"), path=path, url=url, mime=mime)

    if not path and not url and not content_s:
        return None

    if not name:
        name = _basename(path or url) or (label if label else type_)

    aid = str(raw.get("id") or raw.get("artifact_id") or "").strip()
    if not aid:
        aid = make_artifact_id(type_=type_, path=path, url=url, content=content_s, name=name)

    size_raw = raw.get("size")
    size: int | None = None
    if size_raw is not None:
        try:
            size = max(0, int(size_raw))
        except (TypeError, ValueError):
            size = None

    out: dict[str, Any] = {
        "id": aid[:_ID_MAX],
        "type": type_,
        "name": name,
    }
    if path:
        out["path"] = path
    if url:
        out["url"] = url
    if content_s and type_ in {"html", "text"}:
        out["content"] = content_s
    if label:
        out["label"] = label
    if mime:
        out["mime"] = mime
    if size is not None:
        out["size"] = size
    status = str(raw.get("status") or "").strip().lower()
    if status in {"new", "updated"}:
        out["status"] = status
    return out


def normalize_chat_artifacts(raw: Any, *, limit: int = 40) -> list[dict[str, Any]]:
    if raw is None:
        return []
    items: list[Any]
    if isinstance(raw, list):
        items = raw
    else:
        items = [raw]
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for it in items:
        if len(out) >= limit:
            break
        n = normalize_chat_artifact(it)
        if not n:
            continue
        aid = str(n["id"])
        if aid in seen:
            continue
        seen.add(aid)
        out.append(n)
    return out


def artifact_state_key(item: dict[str, Any]) -> str:
    """ThreadState.artifacts still stores string keys (path/url/id)."""
    path = str(item.get("path") or "").strip()
    if path:
        return path
    url = str(item.get("url") or "").strip()
    if url:
        return url
    return str(item.get("id") or "").strip()
