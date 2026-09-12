"""Tier 0/1 prompt injection budgets for Entity Asset Hub (see entity-asset-hub.md §8)."""

from __future__ import annotations

import os

# Tier 0 Pin (frozen standing) — asset-related slices
TIER0_SOUL_SUMMARY_CHARS = 300
TIER0_SYSTEM_CHARS = 500
TIER0_STANDING_CHARS = 320
TIER0_USER_PROFILE_CHARS = 400
TIER0_SKILLS_MAX_ITEMS = 8
TIER0_EPISODE_MAX_ITEMS = 4
TIER0_CATALOG_MAX_ROWS = 10
TIER0_SKILL_DESC_CHARS = 30
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


def cap_text_chars(text: str, max_chars: int) -> str:
    raw = str(text or "").strip()
    cap = int(max_chars or 0)
    if not raw or cap <= 0:
        return raw
    if len(raw) <= cap:
        return raw
    return raw[: cap - 1].rstrip() + "…"
