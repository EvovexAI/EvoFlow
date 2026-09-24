"""Workspace (project) memory taxonomy and write-quality gates."""

from __future__ import annotations

import re

# Fact categories agents should use for workspace/project memory.
WORKSPACE_FACT_CATEGORIES: tuple[str, ...] = (
    "module",  # 核心功能模块说明
    "logic",  # 重要业务/技术逻辑
    "architecture",  # 架构分层、数据流
    "convention",  # 项目约定（命名、目录、提交规范）
    "gotcha",  # 踩坑与约束
    "entrypoint",  # 启动/构建/部署入口
)

WORKSPACE_EPHEMERAL_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"\b(test|测试用例|unit test|e2e|临时|试一下|todo fixme)\b", re.I),
    re.compile(r"(已重写|本次|刚刚改|refactored|rewrote|added props|进度卡片|浮标)", re.I),
    re.compile(r"(hello world|placeholder|lorem|dummy|示例代码)", re.I),
)


def normalize_workspace_fact_category(raw: str) -> str:
    cat = str(raw or "").strip().lower() or "module"
    aliases = {
        "api": "module",
        "flow": "logic",
        "dependency": "architecture",
        "config": "convention",
        "file": "entrypoint",
    }
    cat = aliases.get(cat, cat)
    return cat if cat in WORKSPACE_FACT_CATEGORIES else "module"


def is_workspace_ephemeral_content(text: str) -> bool:
    """True when content looks like session noise, not durable project knowledge."""
    from evoflow.agents.memory.workspace_prompt import is_ephemeral_workspace_fact_content

    body = str(text or "").strip()
    if not body or len(body) < 12:
        return True
    if is_ephemeral_workspace_fact_content(body):
        return True
    return any(p.search(body) for p in WORKSPACE_EPHEMERAL_PATTERNS)


def should_persist_workspace_asset(
    *,
    title: str,
    content: str,
    category: str = "module",
    source: str = "conversation",
) -> bool:
    """Gate before writing workspace facts/craft/episodes."""
    from evoflow.agents.memory.workspace_prompt import (
        is_ephemeral_workspace_fact_content,
        should_persist_workspace_fact,
    )

    body = str(content or "").strip()
    if not body or len(body) < 12 or is_workspace_ephemeral_content(body):
        return False
    title_text = str(title or "").strip()
    if title_text and is_ephemeral_workspace_fact_content(title_text):
        return False
    fact = {
        "title": title,
        "content": content,
        "category": normalize_workspace_fact_category(category),
    }
    return should_persist_workspace_fact(fact, source=source)


def workspace_write_discipline_block(*, lang: str = "zh") -> str:
    if lang == "en":
        return """<workspace_memory_policy>
Project knowledge lives under **`<workspace>/.evoflow/memory/`** (same standing / facts / craft layout as user assets).

Write ONLY durable repo facts. Use a single `[project]` tag — no category subdivision.
Phase 2 merges into `.evoflow/memory/facts/`.

Do NOT store: one-off tests, session changelogs, UI tweak outcomes, greetings, or trivial snippets.
Use `write` to `memory/_inbox/notes/YYYY-MM-DDTHH-MM-SS-<slug>.md` with `[project]` as the first-line tag.
User prefs / identity → user memory or profile, NOT workspace.
</workspace_memory_policy>"""
    return """<workspace_memory_policy>
**项目知识**写在绑定工作区下的 **`<workspace>/.evoflow/memory/`**（与用户资产同构：standing / facts / craft）。

只记**可复用的项目事实**。用单一 `[project]` 标签，不区分 category；Phase 2 合并进 `.evoflow/memory/facts/`。

**不要写入**：一次性测试、会话改动流水、UI 微调结果、问候语、无结构碎片。
项目事实用 `write` 到 `memory/_inbox/notes/YYYY-MM-DDTHH-MM-SS-<slug>.md`（首行 `[project]`）。
用户偏好/身份 → 写 user 记忆或 profile，不要写 workspace。
</workspace_memory_policy>"""
