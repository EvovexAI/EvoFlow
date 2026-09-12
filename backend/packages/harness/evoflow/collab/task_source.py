"""Canonical task source (任务来源) — only three product values.

  - chat      主对话（含人手 / CLI / API 等随手建单）
  - workflow  工作流（任务中心协作 / App / supervisor）
  - role      智能体岗位（值班巡检 / 员工派发）

Legacy raw values are normalized via ``normalize_task_source``.
Fine-grained origin (e.g. ``proactive_patrol``) may still be stored as
``source_channel`` when it differs from the canonical source.
"""

from __future__ import annotations

from typing import Any

TASK_SOURCE_CHAT = "chat"
TASK_SOURCE_WORKFLOW = "workflow"
TASK_SOURCE_ROLE = "role"

CANONICAL_TASK_SOURCES: frozenset[str] = frozenset(
    {
        TASK_SOURCE_CHAT,
        TASK_SOURCE_WORKFLOW,
        TASK_SOURCE_ROLE,
    }
)

TASK_SOURCE_LABELS_ZH: dict[str, str] = {
    TASK_SOURCE_CHAT: "主对话",
    TASK_SOURCE_WORKFLOW: "工作流",
    TASK_SOURCE_ROLE: "智能体岗位",
    "": "未标注",
}

# Legacy / channel-specific → one of the three.
_SOURCE_ALIASES: dict[str, str] = {
    # chat
    "conversation": TASK_SOURCE_CHAT,
    "chat_mention": TASK_SOURCE_CHAT,
    "main_chat": TASK_SOURCE_CHAT,
    "manual": TASK_SOURCE_CHAT,
    "cli": TASK_SOURCE_CHAT,
    "api": TASK_SOURCE_CHAT,
    "restart_task": TASK_SOURCE_CHAT,
    # workflow
    "automation": TASK_SOURCE_WORKFLOW,
    "task_center": TASK_SOURCE_WORKFLOW,
    "app": TASK_SOURCE_WORKFLOW,
    "app_runner": TASK_SOURCE_WORKFLOW,
    "app_runner_lead": TASK_SOURCE_WORKFLOW,
    "supervisor": TASK_SOURCE_WORKFLOW,
    # role
    "proactive": TASK_SOURCE_ROLE,
    "proactive_patrol": TASK_SOURCE_ROLE,
    "proactive_dispatch": TASK_SOURCE_ROLE,
    "proactive_initiative": TASK_SOURCE_ROLE,
    "proactive_think": TASK_SOURCE_ROLE,
    "employee_page": TASK_SOURCE_ROLE,
    "role_work": TASK_SOURCE_ROLE,
    "status_check": TASK_SOURCE_ROLE,
    "xiaomi_assistant": TASK_SOURCE_ROLE,
}


def normalize_task_source(raw: Any, *, default: str = "") -> str:
    """Map a raw source string to chat|workflow|role (or ``default``)."""
    s = str(raw or "").strip().lower()
    if not s:
        d = str(default or "").strip().lower()
        return d if d in CANONICAL_TASK_SOURCES else ""
    if s in CANONICAL_TASK_SOURCES:
        return s
    if s.startswith("event:") or s.startswith("dispatch:"):
        return TASK_SOURCE_ROLE
    aliased = _SOURCE_ALIASES.get(s)
    if aliased:
        return aliased
    # Unknown → chat (safest bucket for ad-hoc creates)
    return TASK_SOURCE_CHAT


def task_source_zh(raw: Any) -> str:
    """Chinese label for UI / CLI."""
    canon = normalize_task_source(raw)
    return TASK_SOURCE_LABELS_ZH.get(canon, TASK_SOURCE_LABELS_ZH[""])


def sources_equal(stored: Any, filter_value: Any) -> bool:
    """True if stored source matches a filter (canonical + aliases)."""
    want = normalize_task_source(filter_value)
    if not want:
        return True
    return normalize_task_source(stored) == want


def resolve_write_source(
    raw: Any,
    *,
    default: str = TASK_SOURCE_CHAT,
) -> tuple[str, str | None]:
    """Normalize for write path.

    Returns ``(canonical_source, source_channel_or_none)``.
    ``source_channel`` is set when the raw value is a finer-grained alias
    (e.g. proactive_patrol → role + channel=proactive_patrol).
    """
    raw_s = str(raw or "").strip()
    if not raw_s:
        canon = normalize_task_source(default, default=TASK_SOURCE_CHAT) or TASK_SOURCE_CHAT
        return canon, None
    canon = normalize_task_source(raw_s, default=default) or TASK_SOURCE_CHAT
    if raw_s.lower() in CANONICAL_TASK_SOURCES:
        return canon, None
    channel = raw_s if raw_s.lower() != canon else None
    return canon, channel


def list_task_sources() -> list[dict[str, str]]:
    """Catalog for API / UI pickers."""
    return [
        {"id": sid, "label_zh": TASK_SOURCE_LABELS_ZH[sid]}
        for sid in (TASK_SOURCE_CHAT, TASK_SOURCE_WORKFLOW, TASK_SOURCE_ROLE)
    ]
