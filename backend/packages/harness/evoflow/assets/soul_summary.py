"""Async consolidate SOUL.md → profile/soul-summary.md (Tier 0 pin, ≤300 chars)."""

from __future__ import annotations

import logging
import re
import threading

from evoflow.assets.injection_budget import TIER0_SOUL_SUMMARY_CHARS, cap_text_chars
from evoflow.assets.paths import EntityRef, profile_path

logger = logging.getLogger(__name__)

_timer_lock = threading.Lock()
_timers: dict[str, threading.Timer] = {}
_DEBOUNCE_SEC = 2.0

_LESSONS_RE = re.compile(
    r"(?im)^#{1,3}\s*lessons?\s*learned\b[\s\S]*?(?=^#{1,3}\s|\Z)"
    r"|^\*\*\s*lessons?\s*learned\b[\s\S]*?(?=^\*\*|\Z)",
)
_HEADING_RE = re.compile(r"^#{1,6}\s+|\*\*(.+?)\*\*\s*$", re.M)


def _entity_key(entity: EntityRef) -> str:
    e = entity.normalized()
    return f"{e.entity_type}:{e.entity_id}"


def extract_soul_summary(soul_md: str, *, max_chars: int = TIER0_SOUL_SUMMARY_CHARS) -> str:
    """Deterministic summary: drop Lessons Learned, take lead paragraphs, cap length."""
    text = str(soul_md or "").strip()
    if not text:
        return ""
    text = _LESSONS_RE.sub("", text).strip()
    lines: list[str] = []
    for line in text.splitlines():
        s = line.strip()
        if not s:
            if lines and lines[-1]:
                lines.append("")
            continue
        if _HEADING_RE.match(s):
            m = _HEADING_RE.match(s)
            # ``**Heading**`` bold title → keep the inner text as a heading.
            bold = m.group(1) if m.lastindex and m.group(1) else None
            title = (bold or _HEADING_RE.sub("", s)).strip()
            if title and title.lower() not in {"soul", "personality", "人格"}:
                lines.append(title)
            continue
        if s.startswith("<!--"):
            continue
        lines.append(s)
    body = "\n".join(lines).strip()
    body = re.sub(r"\n{3,}", "\n\n", body)
    return cap_text_chars(body, max_chars)


def consolidate_soul_summary_for_entity(entity: EntityRef, soul_md: str | None = None) -> str:
    """Write soul-summary.md for agent/employee; returns summary text."""
    e = entity.normalized()
    if e.entity_type not in ("agent", "employee"):
        return ""
    if soul_md is None:
        soul_path = profile_path(e, "SOUL.md")
        if not soul_path.is_file():
            return ""
        try:
            soul_md = soul_path.read_text(encoding="utf-8")
        except OSError:
            logger.debug("consolidate_soul_summary: read SOUL failed", exc_info=True)
            return ""
    summary = extract_soul_summary(soul_md or "")
    out_path = profile_path(e, "soul-summary.md")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    header = "<!-- auto-generated from SOUL.md; do not edit manually -->\n\n"
    tmp = out_path.with_suffix(out_path.suffix + ".tmp")
    tmp.write_text(header + summary + ("\n" if summary else ""), encoding="utf-8")
    tmp.replace(out_path)
    return summary


def schedule_soul_summary_consolidate(entity: EntityRef, *, delay_s: float = _DEBOUNCE_SEC) -> None:
    """Debounced consolidate after SOUL.md edits.

    Prompt load already falls back to a live extract when summary is older than
    SOUL.md; this timer refreshes the on-disk pin for the next cold path.

    ``delay_s <= 0`` runs consolidate immediately **after** releasing
    ``_timer_lock`` — never call ``_run`` while holding the lock (non-reentrant;
    ``_run``'s finally also needs the lock).
    """
    e = entity.normalized()
    if e.entity_type not in ("agent", "employee"):
        return
    key = _entity_key(e)

    def _run() -> None:
        try:
            consolidate_soul_summary_for_entity(e)
        except Exception:
            logger.debug("soul-summary consolidate failed for %s", key, exc_info=True)
        finally:
            with _timer_lock:
                _timers.pop(key, None)

    run_now = False
    with _timer_lock:
        old = _timers.pop(key, None)
        if old is not None:
            old.cancel()
        if float(delay_s) <= 0:
            # Mark in-flight so a concurrent schedule cancels cleanly; run outside lock.
            _timers[key] = None  # type: ignore[assignment]
            run_now = True
        else:
            wait = max(0.5, float(delay_s))
            t = threading.Timer(wait, _run)
            t.daemon = True
            _timers[key] = t
            t.start()
    if run_now:
        _run()


def _mtime_ns(path) -> int:
    try:
        return int(path.stat().st_mtime_ns) if path.is_file() else 0
    except OSError:
        return 0


def _summary_fresher_than_soul(summary_path, soul_path) -> bool:
    """False when SOUL.md is newer than soul-summary (debounce lag) — caller must re-extract."""
    sm = _mtime_ns(summary_path)
    if sm <= 0:
        return False
    soul_m = _mtime_ns(soul_path)
    if soul_m <= 0:
        return True
    return sm >= soul_m


def load_soul_summary_text(agent_code: str | None) -> str:
    """Read soul-summary.md for prompt Tier 0 (empty if missing or stale vs SOUL.md)."""
    code = str(agent_code or "").strip().lower()
    if not code:
        return ""
    try:
        ent = EntityRef("agent", code)
        path = profile_path(ent, "soul-summary.md")
        soul_path = profile_path(ent, "SOUL.md")
        if path.is_file() and _summary_fresher_than_soul(path, soul_path):
            raw = path.read_text(encoding="utf-8")
            body = raw.split("<!-- auto-generated", 1)[-1]
            body = body.split("-->", 1)[-1] if "-->" in body else body
            return cap_text_chars(body.strip(), TIER0_SOUL_SUMMARY_CHARS)
    except OSError:
        pass
    try:
        ent = EntityRef("employee", code)
        path = profile_path(ent, "soul-summary.md")
        soul_path = profile_path(ent, "SOUL.md")
        if path.is_file() and _summary_fresher_than_soul(path, soul_path):
            return cap_text_chars(path.read_text(encoding="utf-8").strip(), TIER0_SOUL_SUMMARY_CHARS)
    except OSError:
        pass
    return ""
