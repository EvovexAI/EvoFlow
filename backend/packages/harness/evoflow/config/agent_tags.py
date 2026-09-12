"""Agent tag definitions and inference helpers.

This module replaces the former ``agent_teams`` taxonomy with a flat,
composable tag system stored on ``evoflow_agents.tags_json`` (a JSON array of
tag label strings, e.g. ``["核心", "代码"]``).

The built-in tag catalog (:data:`BUILTIN_AGENT_TAGS`) mirrors the data-layer
shape of the skill-tag design (``key`` / ``label`` / ``icon`` / ``color``),
but here each tag is a plain data definition with no UI behavior attached --
the frontend resolves ``label`` for display and ``key`` is stable for lookups.

Tag labels are the canonical value persisted in ``tags_json`` (Chinese labels
such as ``"核心"``, ``"媒体"``), matching the backfill mapping used by the
historical team-code → tag map (public schema epoch embeds the same mapping).
"""

from __future__ import annotations

from typing import Any

# ---------------------------------------------------------------------------
# Built-in tag catalog
# ---------------------------------------------------------------------------
#
# Each entry is a data-layer tag definition:
#   - key:   stable identifier (ASCII, used for lookups / programmatic refs)
#   - label: human label persisted into ``tags_json`` (canonical stored value)
#   - icon:  emoji for UI rendering
#   - color: hex color for UI rendering
#
# The ``label`` is the value stored in the database so that tags remain
# human-readable without an extra lookup step, consistent with the v82
# migration backfill (core -> ["核心"], media -> ["媒体"], ...).

BUILTIN_AGENT_TAGS: tuple[dict[str, Any], ...] = (
    {"key": "core", "label": "核心", "icon": "⚙️", "color": "#6366f1"},
    {"key": "project", "label": "项目", "icon": "📁", "color": "#0ea5e9"},
    {"key": "media", "label": "媒体", "icon": "🎬", "color": "#ec4899"},
    {"key": "video", "label": "视频", "icon": "🎥", "color": "#f59e0b"},
    {"key": "animation", "label": "动画", "icon": "🎞️", "color": "#f97316"},
    {"key": "code", "label": "代码", "icon": "💻", "color": "#10b981"},
    {"key": "debug", "label": "测试", "icon": "🐞", "color": "#ef4444"},
    {"key": "docs", "label": "文档", "icon": "📄", "color": "#8b5cf6"},
    {"key": "marketing", "label": "营销", "icon": "📢", "color": "#f97316"},
    {"key": "social", "label": "社媒", "icon": "📱", "color": "#06b6d4"},
    {"key": "finance", "label": "财务", "icon": "💰", "color": "#059669"},
    {"key": "custom", "label": "自定义", "icon": "✨", "color": "#64748b"},
)

# Lookup: label -> definition (labels are the canonical stored value).
_TAGS_BY_LABEL: dict[str, dict[str, Any]] = {t["label"]: t for t in BUILTIN_AGENT_TAGS}

# Lookup: key -> label (for programmatic callers that hold a stable key).
_TAGS_BY_KEY: dict[str, str] = {t["key"]: t["label"] for t in BUILTIN_AGENT_TAGS}


def builtin_tag_labels() -> list[str]:
    """Return the ordered list of built-in tag labels (canonical stored form)."""
    return [t["label"] for t in BUILTIN_AGENT_TAGS]


def is_known_tag(label: str) -> bool:
    """True when ``label`` is one of the built-in tag labels."""
    return bool(label) and label in _TAGS_BY_LABEL


def normalize_tags(tags: Any) -> list[str]:
    """Coerce an arbitrary tags value into a clean, de-duplicated list of labels.

    - ``None`` / non-list -> ``[]``
    - drops empty / whitespace-only entries
    - preserves order, removing duplicates
    """
    if not isinstance(tags, (list, tuple)):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for item in tags:
        label = str(item).strip()
        if not label or label in seen:
            continue
        seen.add(label)
        out.append(label)
    return out


# ---------------------------------------------------------------------------
# Agent-code prefixes used for tag inference (mirrors the former team rules).
# ---------------------------------------------------------------------------

_CORE_AGENT_CODES = frozenset({"general-purpose", "bash", "claude-code", "code-agent"})


def infer_tags_for_agent(agent_code: str, agent_type: str | None = None) -> list[str]:
    """Infer an initial tag list for an agent from its code prefix and type.

    Rules (highest priority first):

    * ``main`` / ``xiaomi`` -> ``[]`` (lead / system front desk).
    * ``knowledge-*`` -> ``["核心", "文档"]``.
    * ``media-*`` -> ``["媒体"]``.
    * ``hf-*`` -> ``["视频", "动画"]`` (HyperFrames video/animation crew).
    * ``project-*`` -> ``["项目"]``.
    * ``finance-*`` -> ``["财务"]``.
    * ``marketing-social-media-operation`` -> ``["营销", "社媒"]``.
    * one of the core subagents (``general-purpose`` / ``bash`` /
      ``claude-code`` / ``code-agent``) -> ``["核心", "代码"]``.
    * ``custom`` agent type -> ``["自定义"]``.

    Unknown codes with no matching prefix fall back to ``["自定义"]``.
    """
    code = str(agent_code or "").strip().lower()
    if not code:
        return []

    if code in {"main", "xiaomi"}:
        return []

    if code.startswith("knowledge-"):
        return ["核心", "文档"]
    if code.startswith("media-"):
        return ["媒体"]
    if code.startswith("hf-"):
        return ["视频", "动画"]
    if code.startswith("project-"):
        return ["项目"]
    if code.startswith("finance-"):
        return ["财务"]
    if code == "marketing-social-media-operation":
        return ["营销", "社媒"]

    if code in _CORE_AGENT_CODES:
        return ["核心", "代码"]

    # Type-based fallback for codes without a recognized prefix.
    at = str(agent_type or "custom").strip().lower()
    if at == "custom":
        return ["自定义"]
    # Subagents / acp with unknown prefixes default to 自定义 as well; callers
    # may overwrite tags explicitly when persisting.
    return ["自定义"]


def default_tags_for_new_agent(agent_type: str = "custom") -> list[str]:
    """Default tags assigned to a freshly-created agent of ``agent_type``.

    - ``custom``  -> ``["自定义"]``
    - ``subagent`` -> ``["自定义"]`` (refined later by :func:`infer_tags_for_agent`
      when the agent code is known)
    - ``acp``     -> ``["自定义"]``
    - anything else -> ``["自定义"]``
    """
    # New agents always start in the 自定义 bucket; the precise tag set is
    # inferred from the agent_code once it is chosen.
    _ = str(agent_type or "custom").strip().lower()
    return ["自定义"]
