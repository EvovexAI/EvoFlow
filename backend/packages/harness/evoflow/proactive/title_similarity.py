"""Normalize proactive initiative titles / goals for near-duplicate detection."""

from __future__ import annotations

import re
from collections.abc import Iterable

# Boilerplate that models prepend when paraphrasing the same mission.
_PREFIX_NOISE = (
    "真正落地",
    "真正",
    "落地",
    "全面",
    "再次",
    "继续",
    "重新",
    "彻底",
    "完整",
    "先",
    "本轮",
    "值班",
    "巡检",
)

_PUNCT_RE = re.compile(r"[\s\-_/\\|,.，。；;：:!！?？、（）()【】\[\]\"'“”‘’…·•]+")
_SPACE_RE = re.compile(r"\s+")


def normalize_proactive_title(text: str) -> str:
    """Lowercase, strip punctuation / filler prefixes for fuzzy compare."""
    s = str(text or "").strip().lower()
    if not s:
        return ""
    # Drop trailing "完成后关闭…" cleanup clauses — they inflate uniqueness.
    s = re.split(r"(完成后|执行完毕后|解决积压|关闭积压|关闭所有|关闭 \d)", s, maxsplit=1)[0]
    s = _PUNCT_RE.sub(" ", s)
    s = _SPACE_RE.sub(" ", s).strip()
    changed = True
    while changed and s:
        changed = False
        for p in _PREFIX_NOISE:
            if s.startswith(p):
                s = s[len(p) :].strip()
                changed = True
    return s


def _token_set(s: str) -> set[str]:
    return {t for t in s.split() if len(t) >= 2}


def title_similarity(a: str, b: str) -> float:
    """Jaccard on normalized tokens; also reward long shared prefix."""
    na = normalize_proactive_title(a)
    nb = normalize_proactive_title(b)
    if not na or not nb:
        return 0.0
    if na == nb:
        return 1.0
    # Character-level containment for CJK-heavy titles (few spaces).
    if len(na) >= 12 and len(nb) >= 12:
        shorter, longer = (na, nb) if len(na) <= len(nb) else (nb, na)
        if shorter in longer:
            return 0.92
        # Shared prefix ratio
        n = 0
        for x, y in zip(na, nb):
            if x != y:
                break
            n += 1
        prefix = n / max(len(na), len(nb))
        if prefix >= 0.65:
            return max(prefix, 0.78)

    ta, tb = _token_set(na), _token_set(nb)
    if not ta or not tb:
        # Pure CJK without spaces: bigram Jaccard
        ba = {na[i : i + 2] for i in range(max(0, len(na) - 1))}
        bb = {nb[i : i + 2] for i in range(max(0, len(nb) - 1))}
        if not ba or not bb:
            return 0.0
        return len(ba & bb) / len(ba | bb)
    return len(ta & tb) / len(ta | tb)


def find_near_duplicate_title(
    candidate: str,
    existing: Iterable[str],
    *,
    threshold: float = 0.72,
) -> str | None:
    """Return the first existing title that is near-duplicate of ``candidate``."""
    cand = str(candidate or "").strip()
    if not cand:
        return None
    best: tuple[float, str] | None = None
    for raw in existing:
        title = str(raw or "").strip()
        if not title:
            continue
        score = title_similarity(cand, title)
        if score >= threshold and (best is None or score > best[0]):
            best = (score, title)
    return best[1] if best else None


__all__ = [
    "normalize_proactive_title",
    "title_similarity",
    "find_near_duplicate_title",
]
