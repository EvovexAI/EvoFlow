"""Standing.md shaping for disk normalize + prompt inject.

Disk may still hold legacy dense ``## What's in Memory`` (desc/learnings).
Inject path always collapses that section to name-only and soft-caps core
prefs/tips so every turn does not ship a 7k+ memory dump.
"""

from __future__ import annotations

import re

_CRAFT_PATH_RE = re.compile(r"(craft/[A-Za-z0-9_./\-]+\.md)")
_DAY_HEADING_RE = re.compile(r"^#{2,4}\s+\d{4}-\d{2}-\d{2}\s*$")
_DESC_OR_LEARNINGS_RE = re.compile(r"^\s*-\s*(desc|learnings)\s*:", re.IGNORECASE)

_CORE_SECTION_PRIORITY = (
    "user preferences",
    "general tips",
    "user profile",
)
_INDEX_SECTION = "what's in memory"


def whats_in_memory_bullet_name(line: str) -> str | None:
    """Collapse a dense topic bullet into a single self-describing name."""
    raw = str(line or "").rstrip()
    if not raw.lstrip().startswith("-"):
        return None
    if _DESC_OR_LEARNINGS_RE.match(raw):
        return None
    body = raw.lstrip()[1:].strip()
    if not body:
        return None
    craft = _CRAFT_PATH_RE.search(body)
    if craft:
        return craft.group(1)
    # Drop legacy "Title: kw1, kw2, ..." tails (ASCII or fullwidth colon).
    for sep in (":", "："):
        if sep in body:
            title = body.split(sep, 1)[0].strip()
            return title or None
    return body.strip() or None


def collapse_whats_in_memory_to_names(text: str, *, force: bool = False) -> str:
    """Rewrite ``## What's in Memory`` to name-only bullets.

    ``force=True`` (inject path): always collapse. Otherwise only when legacy dense
    markers (desc/learnings / day headings / long keyword tails) appear.
    """
    lines = str(text or "").splitlines()
    out: list[str] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.strip() != "## What's in Memory":
            out.append(line)
            i += 1
            continue

        out.append("## What's in Memory")
        i += 1
        section: list[str] = []
        while i < len(lines) and not (
            lines[i].startswith("## ") and lines[i].strip() != "## What's in Memory"
        ):
            section.append(lines[i])
            i += 1

        dense = force or any(
            _DESC_OR_LEARNINGS_RE.match(s)
            or (
                s.lstrip().startswith("- ")
                and (":" in s or "：" in s)
                and _CRAFT_PATH_RE.search(s) is None
                and len(s) > 80
            )
            or _DAY_HEADING_RE.match(s.strip())
            for s in section
        )
        if not dense:
            out.extend(section)
            continue

        seen: set[str] = set()
        for s in section:
            stripped = s.strip()
            if not stripped:
                continue
            if stripped.startswith("### ") or stripped.startswith("#### "):
                if _DAY_HEADING_RE.match(stripped):
                    continue
                if out and out[-1] != "":
                    out.append("")
                out.append(
                    stripped if stripped.startswith("### ") else "### " + stripped.lstrip("#").strip()
                )
                continue
            name = whats_in_memory_bullet_name(s)
            if not name or name in seen:
                continue
            seen.add(name)
            out.append(f"- {name}")
        if out and out[-1] == "":
            out.pop()

    return "\n".join(out)


def normalize_standing_document(text: str) -> str:
    """Disk write normalize: ensure ``v1`` header + name-only What's in Memory."""
    body = str(text or "").strip()
    if not body:
        return "v1\n\n# 站立摘要\n\n（暂无高密度摘要）\n"
    if not body.startswith("v1"):
        body = "v1\n\n" + body.lstrip()
    lines = body.splitlines()
    if lines[0].strip() != "v1":
        lines[0] = "v1"
        body = "\n".join(lines)
    body = collapse_whats_in_memory_to_names(body)
    return body if body.endswith("\n") else body + "\n"


def _split_h2_sections(text: str) -> list[tuple[str, str]]:
    """Return ``[(heading_or_empty, body), ...]`` preserving order (heading includes ``## …``)."""
    lines = str(text or "").splitlines()
    sections: list[tuple[str, str]] = []
    cur_h = ""
    cur_body: list[str] = []
    for line in lines:
        if line.startswith("## ") and not line.startswith("###"):
            if cur_h or cur_body:
                sections.append((cur_h, "\n".join(cur_body).rstrip()))
            cur_h = line.strip()
            cur_body = []
        else:
            cur_body.append(line)
    if cur_h or cur_body:
        sections.append((cur_h, "\n".join(cur_body).rstrip()))
    return sections


def _cap_section_body(body: str, budget: int) -> str:
    from evoflow.assets.injection_budget import cap_text_chars

    return cap_text_chars(body.strip(), budget)


def format_standing_for_inject(
    text: str,
    *,
    core_max_chars: int | None = None,
) -> str:
    """Shape standing for system-prompt L1 inject.

    Keep preferences / Tips / short Profile only. Drop ``## What's in Memory`` —
    L2 catalog already lists craft/episodic/journal names every turn.
    """
    from evoflow.assets.injection_budget import TIER0_STANDING_CORE_CHARS

    core_budget = int(core_max_chars if core_max_chars is not None else TIER0_STANDING_CORE_CHARS)
    # No need to collapse index for inject — the whole section is omitted.
    sections = _split_h2_sections(str(text or ""))
    if not sections:
        return str(text or "").strip()

    preamble = ""
    core: list[tuple[str, str, str]] = []  # (key, heading, body)
    other: list[tuple[str, str]] = []

    for heading, body in sections:
        if not heading:
            preamble = body
            continue
        key = heading.lstrip("#").strip().lower()
        if key == _INDEX_SECTION:
            continue  # catalog owns discoverability
        if key in _CORE_SECTION_PRIORITY:
            core.append((key, heading, body))
        else:
            other.append((heading, body))

    # Soft-cap core: preferences > tips > profile.
    ordered_core = sorted(
        core,
        key=lambda t: (
            _CORE_SECTION_PRIORITY.index(t[0]) if t[0] in _CORE_SECTION_PRIORITY else 99
        ),
    )
    kept_core: list[tuple[str, str]] = []
    used = 0
    if core_budget <= 0:
        kept_core = [(h, b) for _k, h, b in ordered_core]
    else:
        for _key, heading, body in ordered_core:
            block = f"{heading}\n{body.strip()}".strip() if body.strip() else heading
            remain = core_budget - used
            if remain <= 0:
                break
            if len(block) <= remain:
                kept_core.append((heading, body.strip()))
                used += len(block) + 2
                continue
            body_budget = max(0, remain - len(heading) - 1)
            if body_budget < 40:
                break
            kept_core.append((heading, _cap_section_body(body, body_budget)))
            used = core_budget

    core_order = {h: i for i, (_k, h, _b) in enumerate(core)}
    kept_core.sort(key=lambda t: core_order.get(t[0], 999))

    parts: list[str] = []
    if preamble.strip():
        pre = preamble.strip()
        if core_budget > 0 and len(pre) > 200:
            pre = "\n".join(pre.splitlines()[:6]).strip()
        parts.append(pre)

    for heading, body in kept_core:
        parts.append(f"{heading}\n{body}".strip() if body else heading)

    for heading, body in other:
        block_body = body.strip()
        if len(block_body) > 400:
            block_body = _cap_section_body(block_body, 400)
        parts.append(f"{heading}\n{block_body}".strip() if block_body else heading)

    return "\n\n".join(p for p in parts if p).strip()
