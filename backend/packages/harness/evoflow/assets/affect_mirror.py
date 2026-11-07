"""Affect as ``profile/affect.md`` (model-owned Markdown SoT).

- **User vault**: main / lead agent 心境（「我 → 情感」）
- **Employee / agent vault**: that person's 心境
"""

from __future__ import annotations

import logging
import re
from typing import Any

logger = logging.getLogger(__name__)

_FM_RE = re.compile(r"^---\s*\n.*?\n---\s*\n?", re.DOTALL)
_LEAD_CODES = frozenset({"", "main", "lead_agent", "user", "default", "system"})
# Display names sometimes leak into affect routing (assemble uses them for {agent_name}).
_LEAD_DISPLAY_ALIASES = frozenset({"evoflow", "assistant", "ai"})


def ensure_default_affect_md(entity) -> None:
    """Create default affect.md when missing (entity tree ensure hook).

    Writes via Path directly — must not call ``write_text_file`` / ``ensure_entity_tree``
    (those re-enter this hook and would recurse).
    """
    try:
        from evoflow.assets.paths import profile_path
        from evoflow.person_affect import default_affect_md

        e = entity.normalized() if hasattr(entity, "normalized") else entity
        if getattr(e, "entity_type", "") not in ("agent", "employee", "user"):
            return
        path = profile_path(e, "affect.md")
        if path.is_file():
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(default_affect_md(), encoding="utf-8")
    except Exception:
        logger.debug("ensure_default_affect_md skipped", exc_info=True)


def _user_entity(principal_id: str = ""):
    from evoflow.assets.paths import EntityRef, sanitize_user_asset_id

    pid = sanitize_user_asset_id(str(principal_id or "").strip() or "user")
    return EntityRef("user", pid).normalized()


def _entity_for_agent_code(agent_code: str, *, principal_id: str = ""):
    """Resolve which vault owns affect for this speaker."""
    from evoflow.assets.guidance import is_employee_agent_name
    from evoflow.assets.paths import EntityRef, entity_root

    code = str(agent_code or "").strip().lower()
    if code in _LEAD_CODES or code in _LEAD_DISPLAY_ALIASES:
        return _user_entity(principal_id)

    emp = EntityRef("employee", code).normalized()
    ag = EntityRef("agent", code).normalized()
    emp_affect = entity_root(emp) / "profile" / "affect.md"
    ag_affect = entity_root(ag) / "profile" / "affect.md"
    if emp_affect.is_file() or (entity_root(emp).is_dir() and is_employee_agent_name(code)):
        return emp
    if is_employee_agent_name(code):
        return emp
    if ag_affect.is_file():
        return ag
    return emp if emp_affect.parent.is_dir() else ag


def read_affect_md(agent_code: str = "", *, principal_id: str = "") -> str:
    """Return full ``profile/affect.md`` text (may be empty)."""
    code = str(agent_code or "").strip().lower()
    try:
        from evoflow.assets.hub import ensure_entity_tree
        from evoflow.assets.paths import profile_path

        ent = _entity_for_agent_code(code, principal_id=principal_id)
        ensure_entity_tree(ent)
        path = profile_path(ent, "affect.md")
        if not path.is_file():
            return ""
        return path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        logger.debug("read_affect_md skipped for %s", code or "lead", exc_info=True)
        return ""


def affect_brief_from_md(raw: str, *, max_chars: int = 600) -> str:
    """Strip frontmatter; keep a short prose block for prompt inject."""
    text = _FM_RE.sub("", str(raw or ""), count=1).strip()
    if not text:
        return ""
    parts = re.split(r"\n##\s+", text, maxsplit=1)
    head = parts[0].strip()
    if len(head) > max_chars:
        head = head[: max_chars - 1].rstrip() + "…"
    return head


def format_affect_brief_from_file(agent_code: str = "", *, principal_id: str = "") -> str:
    """Prompt inject from disk SoT."""
    return affect_brief_from_md(read_affect_md(agent_code, principal_id=principal_id))


def split_frontmatter(text: str) -> tuple[str, str]:
    """Return ``(frontmatter_block, body)``; block is "" when absent."""
    raw = str(text or "")
    m = _FM_RE.match(raw)
    if not m:
        return "", raw.lstrip("\n")
    return m.group(0).rstrip("\n"), raw[m.end() :].lstrip("\n")


def refresh_frontmatter(old_block: str, mood_hint: str = "") -> str:
    """Re-emit an existing frontmatter block with a fresh ``updated`` stamp.

    ``mode=replace`` used to write the body verbatim, which silently dropped the
    ``source/mood/updated`` header — the mirror then read as an unlabelled doc and
    any structured consumer lost the mood anchor.
    """
    from evoflow.timeutil import utc_now_iso_z

    lines: list[str] = []
    seen: set[str] = set()
    for line in old_block.splitlines():
        if line.strip() in ("---", ""):
            continue
        key, sep, _val = line.partition(":")
        if not sep:
            continue
        k = key.strip()
        seen.add(k.lower())
        if k.lower() == "updated":
            lines.append(f"updated: {utc_now_iso_z()}")
        else:
            lines.append(line.rstrip())
    if "source" not in {s.lower() for s in seen}:
        lines.insert(0, "source: person_affect")
    if mood_hint and "mood" not in {s.lower() for s in seen}:
        lines.append(f"mood: {mood_hint}")
    if not any(s.lower() == "updated" for s in seen):
        lines.append(f"updated: {utc_now_iso_z()}")
    return "---\n" + "\n".join(lines) + "\n---"


def write_affect_md(
    entity,
    content: str,
    *,
    mode: str = "replace",
) -> dict[str, Any]:
    """Model/UI write to ``profile/affect.md``. ``append`` or ``replace``.

    ``replace`` swaps the prose body only and keeps (refreshing) the frontmatter,
    unless the caller's own text carries a frontmatter block — then it wins.
    """
    from evoflow.assets.hub import ensure_entity_tree, write_text_file
    from evoflow.assets.paths import profile_path

    e = entity.normalized() if hasattr(entity, "normalized") else entity
    if getattr(e, "entity_type", "") not in ("agent", "employee", "user"):
        raise ValueError("affect_only_for_user_agent_or_employee")
    text = str(content or "").strip()
    if not text:
        raise ValueError("content is required")
    ensure_entity_tree(e)
    rel = "profile/affect.md"
    path = profile_path(e, "affect.md")
    mode_l = str(mode or "replace").strip().lower()
    existing = ""
    if path.is_file():
        try:
            existing = path.read_text(encoding="utf-8")
        except OSError:
            existing = ""
    if mode_l == "append" and existing:
        merged = (existing.rstrip() + "\n\n" + text).strip() + "\n"
    else:
        old_block, _old_body = split_frontmatter(existing)
        new_block, new_body = split_frontmatter(text)
        block = new_block or (old_block and refresh_frontmatter(old_block))
        body = new_body or text
        body = body if body.endswith("\n") else body + "\n"
        merged = f"{block}\n\n{body.lstrip()}" if block else body
    data = write_text_file(e, rel, merged)
    return {**data, "mode": "append" if mode_l == "append" else "replace", "path": rel}


def maybe_mirror_affect_file(agent_code: str, affect: dict[str, Any] | None = None) -> str | None:
    """Deprecated no-op — affect.md is model-owned; do not overwrite from DB."""
    _ = (agent_code, affect)
    return None
