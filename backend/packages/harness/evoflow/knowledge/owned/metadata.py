"""Frontmatter / tags / wikilink helpers for owned source documents."""

from __future__ import annotations

import json
import re
from typing import Any

_FRONTMATTER_RE = re.compile(r"\A---\r?\n([\s\S]*?)\r?\n---\r?\n?", re.MULTILINE)
_WIKILINK_RE = re.compile(r"\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]")
_TAG_RE = re.compile(r"(?<!\w)#([A-Za-z0-9_/\-\u4e00-\u9fff]+)")


def parse_frontmatter(text: str) -> tuple[dict[str, Any], str]:
    """Parse simple YAML-like frontmatter; returns (meta, body_without_fm)."""
    raw = text or ""
    m = _FRONTMATTER_RE.match(raw)
    if not m:
        return {}, raw
    meta: dict[str, Any] = {}
    for line in m.group(1).splitlines():
        line = line.strip()
        if not line or line.startswith("#") or ":" not in line:
            continue
        key, _, val = line.partition(":")
        key = key.strip()
        val = val.strip()
        if not key:
            continue
        if val.startswith("[") and val.endswith("]"):
            inner = val[1:-1].strip()
            if not inner:
                meta[key] = []
                continue
            try:
                meta[key] = json.loads(val.replace("'", '"'))
                continue
            except Exception:
                parts = [p.strip().strip("\"'") for p in inner.split(",")]
                meta[key] = [p for p in parts if p]
                continue
        if (val.startswith('"') and val.endswith('"')) or (
            val.startswith("'") and val.endswith("'")
        ):
            try:
                meta[key] = json.loads(val.replace("'", '"'))
                continue
            except Exception:
                meta[key] = val.strip("\"'")
                continue
        if val.lower() in ("true", "false"):
            meta[key] = val.lower() == "true"
        elif val.isdigit():
            meta[key] = int(val)
        else:
            meta[key] = val.strip("\"'")
    body = raw[m.end() :]
    return meta, body


def extract_tags(text: str, frontmatter: dict[str, Any] | None = None) -> list[str]:
    tags: list[str] = []
    seen: set[str] = set()
    fm = frontmatter or {}
    raw_fm = fm.get("tags")
    if isinstance(raw_fm, list):
        for t in raw_fm:
            s = str(t).strip().lstrip("#")
            if s and s not in seen:
                seen.add(s)
                tags.append(s)
    elif isinstance(raw_fm, str) and raw_fm.strip():
        for part in re.split(r"[,，]", raw_fm):
            s = part.strip().lstrip("#")
            if s and s not in seen:
                seen.add(s)
                tags.append(s)
    tag_field = fm.get("tag")
    if isinstance(tag_field, str) and tag_field.strip():
        s = tag_field.strip().lstrip("#")
        if s and s not in seen:
            seen.add(s)
            tags.append(s)
    for m in _TAG_RE.finditer(text or ""):
        s = str(m.group(1) or "").strip()
        if s and s not in seen:
            seen.add(s)
            tags.append(s)
    return tags


def extract_wikilinks(text: str) -> list[str]:
    links: list[str] = []
    seen: set[str] = set()
    for m in _WIKILINK_RE.finditer(text or ""):
        target = str(m.group(1) or "").strip().replace("\\", "/")
        if not target or target in seen:
            continue
        seen.add(target)
        links.append(target)
    return links
