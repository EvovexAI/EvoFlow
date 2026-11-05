"""Tier 0/1 prompt injection budgets for Entity Asset Hub.

Layer model (see ``assets/prompts/memories/injection_layers.md``):
  L0 job skeleton → L1 standing (**full page**) → L2 catalog (short labels) →
  L3 bodies on-demand via ``assets`` → L4 pending inbox.
Know-how SoT is the asset tree; ``system_prompt`` (L0) stays a thin duty skeleton —
but L1 standing is already the compressed summary page: inject it whole, never
scissors mid-sentence. Size discipline belongs to Phase2 when rewriting standing.md.
``cap_text_chars(..., 0)`` = no truncate (same convention as catalog row caps).
"""

from __future__ import annotations

import os

# Tier 0 Pin (frozen standing) — asset-related slices
TIER0_SOUL_SUMMARY_CHARS = 400
TIER0_SYSTEM_CHARS = 500
# standing.md = derived prefs + tips + name-only What's in Memory. Inject **complete**.
# 0 = uncapped (do not hard-cut the system prompt). Phase2 owns keeping the file sane.
TIER0_STANDING_CHARS = 0
# 0 = inject full profile/USER.md (no hard cut). Placeholder stripping is no longer
# applied on inject — the whole document is the SoT the user edited in Asset Center.
TIER0_USER_PROFILE_CHARS = 0
# Prompt catalog: basenames under kind headings (no dir prefix) — **no row cap for now**.
# (Was TIER0_CATALOG_PER_KIND=10; short labels are cheap, let the model see the full index.)
# 0 / None-like: list_* treats <=0 as unlimited.
TIER0_CATALOG_PER_KIND = 0
# 0 = uncapped skill catalog rows in <skill_system> (allowlist still applies).
TIER0_SKILLS_MAX_ITEMS = 0
TIER0_EPISODE_MAX_ITEMS = 0
# Legacy alias kept for call sites that still import the name.
TIER0_CATALOG_MAX_ROWS = 0
TIER0_SKILL_DESC_CHARS = 160
# Overall budget for the <skill_system> catalog. Beyond it the catalog degrades
# stepwise — full descriptions → sentence-capped descriptions → names-only —
# so an oversized catalog never ships half-cut prose (each skill stays
# discoverable by name at the floor).
TIER0_SKILLS_SECTION_CHARS = 6000
TIER0_ASSET_TOTAL_CHARS = 900

# Tier 1 Recall (turn-tail)
TIER1_RECALL_TOP_K = 4
TIER1_RECALL_MAX_CHARS = 600
TIER1_PERSON_MEMORY_CHARS = 400
TIER1_PERSON_CRAFT_CHARS = 400
TIER0_TIER1_TOTAL_CHARS = 1800


def query_recall_enabled() -> bool:
    """Per-turn archival recall — **default off** (set EVOFLOW_QUERY_RECALL=1 to enable).

    User-message-driven memory injection makes ordinary chats noisy; keep it opt-in.
    """
    raw = (os.getenv("EVOFLOW_QUERY_RECALL") or "").strip().lower()
    if raw in {"0", "false", "no", "off"}:
        return False
    if raw in {"1", "true", "yes", "on"}:
        return True
    return False


_SENTENCE_RE = None


def _sentence_re():
    """Lazy compiled regex matching sentence terminators + trailing whitespace."""
    global _SENTENCE_RE
    if _SENTENCE_RE is None:
        import re as _re

        _SENTENCE_RE = _re.compile(r"[。！？!?；;.\n]+\s*")
    return _SENTENCE_RE


def cap_text_chars(text: str, max_chars: int) -> str:
    """Truncate to ``max_chars`` with an ellipsis — prefers sentence boundaries.

    Hard-cut mid-sentence (``raw[:cap-1] + …``) produced truncated prompts like
    ``…但不把一次性的…`` for Chinese SOUL/memory summaries. When possible, cut
    after the last complete sentence inside the budget instead.
    """
    raw = str(text or "").strip()
    cap = int(max_chars or 0)
    if not raw or cap <= 0:
        return raw
    if len(raw) <= cap:
        return raw
    # Last complete sentence end inside the budget (finditer advances past zero-width).
    cut = None
    for m in _sentence_re().finditer(raw, 0, cap):
        cut = m.end()
    if cut is not None:
        return raw[:cut].rstrip() + "…"
    return raw[: cap - 1].rstrip() + "…"
