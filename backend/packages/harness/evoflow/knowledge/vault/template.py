"""Note templates for EvoFlow-created Knowledge Vault notes."""

from __future__ import annotations

import uuid
from typing import Any

from evoflow.timeutil import utc_now_iso_z

NOTE_TEMPLATE = """\
---
id: "{{generated_id}}"
type: note
status: inbox
tags: {{tags_yaml}}
aliases: []
source:
  - "{{source}}"
confidence: {{confidence}}
created: "{{created_at}}"
updated: "{{updated_at}}"
---

# {{title}}

## 摘要

{{summary}}

## 内容

{{content}}

## 相关笔记

{{related_links}}

## 来源

{{source_description}}
"""


def generate_note_id() -> str:
    """Stable ID independent of title."""
    return uuid.uuid4().hex


def _yaml_list(items: list[str]) -> str:
    if not items:
        return "[]"
    inner = ", ".join(f'"{x.replace(chr(34), "")}"' for x in items)
    return f"[{inner}]"


def render_inbox_note(
    *,
    title: str,
    content: str,
    summary: str = "",
    source: str = "evoflow",
    source_description: str = "",
    confidence: float = 0.7,
    tags: list[str] | None = None,
    related_paths: list[str] | None = None,
    note_id: str | None = None,
) -> str:
    conf = max(0.0, min(1.0, float(confidence)))
    now = utc_now_iso_z()
    related = related_paths or []
    links = "\n".join(f"- [[{p.rsplit('/', 1)[-1].removesuffix('.md')}]]" for p in related) if related else "_暂无_"
    src_desc = (source_description or "").strip() or f"Ingested by EvoFlow from {source}"
    return (
        NOTE_TEMPLATE.replace("{{generated_id}}", note_id or generate_note_id())
        .replace("{{tags_yaml}}", _yaml_list(list(tags or [])))
        .replace("{{source}}", str(source).replace('"', "'"))
        .replace("{{confidence}}", f"{conf:.2f}")
        .replace("{{created_at}}", now)
        .replace("{{updated_at}}", now)
        .replace("{{title}}", title.strip() or "Untitled")
        .replace("{{summary}}", summary.strip() or "_（无摘要）_")
        .replace("{{content}}", content.strip() or "_（无内容）_")
        .replace("{{related_links}}", links)
        .replace("{{source_description}}", src_desc)
    )


def inbox_filename(title: str) -> str:
    """Build a safe markdown filename from title."""
    base = "".join(c if c.isalnum() or c in " -_" else "" for c in (title or "note")).strip()
    base = " ".join(base.split()) or "note"
    if len(base) > 80:
        base = base[:80].rstrip()
    return f"{base}.md"


def build_ingest_meta(*, source: str, confidence: float) -> dict[str, Any]:
    return {
        "source": source or "evoflow",
        "confidence": max(0.0, min(1.0, float(confidence))),
        "created": utc_now_iso_z(),
    }
