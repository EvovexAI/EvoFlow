"""Resolve plan / supervisor assignee to canonical agent_code + UI display name."""

from __future__ import annotations

import logging
from functools import lru_cache

from evoflow.config.agents_config import list_all_agents

logger = logging.getLogger(__name__)

# Built-in worker ids (aligned with evoflow.subagents.builtins / agents_config materialize).
BUILTIN_AGENT_UI_NAMES: dict[str, str] = {
    "main": "EvoFlow",
    "xiaomi": "小V",
    "general-purpose": "通用助手",
    "code-agent": "代码助手",
    "bash": "终端执行",
    "claude-code": "Claude Code",
    "knowledge-retriever": "知识检索",
    "knowledge-curator": "知识整理",
    "project-architect": "项目·方案",
    "project-planner": "项目·计划",
    "project-implementer": "项目·开发",
    "project-reviewer": "项目·审查",
    "project-debugger": "项目·测试",
    "project-qa": "项目·验收",
    "media-screenwriter": "媒体·编剧",
    "media-visual-planner": "媒体·视觉策划",
    "media-artist": "媒体·美术",
    "media-video-director": "媒体·视频导演",
    "media-voice-director": "媒体·配音",
    "media-post": "媒体·后期",
    "hf-developer": "HyperFrames·动画开发",
    "hf-visual-designer": "HyperFrames·视觉设计",
    "hf-director": "HyperFrames·导演",
    "hf-renderer": "HyperFrames·后期",
    "marketing-social-media-operation": "社媒运营",
}

_EMPTY_ASSIGNEE = frozenset(
    {"", "无", "none", "—", "-", "待定", "tbd", "待分配", "未指定", "n/a", "na"},
)

DEFAULT_ASSIGNEE_CODE = "general-purpose"


def normalize_agent_code_key(raw: str | None) -> str:
    return str(raw or "").strip().lower().replace("_", "-")


@lru_cache(maxsize=1)
def _assignable_index() -> dict[str, str]:
    """Normalized agent_code -> display name (agent_name or built-in label)."""
    out = dict(BUILTIN_AGENT_UI_NAMES)
    try:
        for cfg in list_all_agents():
            ac = normalize_agent_code_key(cfg.agent_code)
            if not ac:
                continue
            an = str(cfg.agent_name or "").strip()
            if an:
                out[ac] = an
            elif ac not in out:
                out[ac] = ac
    except Exception:
        logger.debug("assignable agent index build failed", exc_info=True)
    return out


def clear_assignable_agent_cache() -> None:
    _assignable_index.cache_clear()


def list_assignable_agent_codes() -> list[str]:
    return sorted(_assignable_index().keys())


def display_name_for_agent_code(agent_code: str | None) -> str | None:
    if not agent_code:
        return None
    norm = normalize_agent_code_key(agent_code)
    if not norm:
        return None
    return _assignable_index().get(norm)


def resolve_assignable_agent(
    raw: str | None,
    *,
    default: str = DEFAULT_ASSIGNEE_CODE,
) -> tuple[str, str, list[str]]:
    """Resolve model/user assignee to (agent_code, display_name, warnings)."""
    warnings: list[str] = []
    key = str(raw or "").strip()
    if not key or key.lower() in _EMPTY_ASSIGNEE:
        key = ""

    idx = _assignable_index()
    if key:
        norm = normalize_agent_code_key(key)
        if norm in idx:
            return norm, idx[norm], warnings
        for code, dn in idx.items():
            if str(dn or "").strip() == key:
                return code, dn, warnings
            if normalize_agent_code_key(dn) == norm:
                return code, dn, warnings

    if key:
        warnings.append(f"unknown_agent:{key}:fallback_to_{default}")

    code = normalize_agent_code_key(default) or DEFAULT_ASSIGNEE_CODE
    dn = idx.get(code, code)
    return code, dn, warnings


def resolve_step_assigned_agent(step: dict) -> tuple[str, str, list[str]]:
    """From a plan step dict, resolve assignee / assigned_agent / agent_code."""
    raw = str(
        step.get("assignee")
        or step.get("assigned_agent")
        or step.get("agent_code")
        or ""
    ).strip()
    return resolve_assignable_agent(raw or None)
