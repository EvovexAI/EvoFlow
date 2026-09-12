"""Workspace (project) memory taxonomy and write-quality gates."""

from __future__ import annotations

import re

# Fact categories agents should use for workspace/project memory.
WORKSPACE_FACT_CATEGORIES: tuple[str, ...] = (
    "module",      # 核心功能模块说明
    "logic",       # 重要业务/技术逻辑
    "architecture",  # 架构分层、数据流
    "convention",  # 项目约定（命名、目录、提交规范）
    "gotcha",      # 踩坑与约束
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
Project knowledge lives under **assets/workspaces/{ws-hash}/memory/** (only when a workspace is bound).

Write here ONLY durable repo facts:
- **module** — core subsystems and responsibilities
- **logic** — important business/technical flows
- **architecture** — layers, data flow, key dependencies
- **convention** — naming, folders, build/run habits
- **gotcha** — constraints and pitfalls
- **entrypoint** — how to run/build/deploy

Do NOT store: one-off tests, session changelogs, UI tweak outcomes, greetings, or trivial snippets.
Use `assets(action=note, scope=workspace, content="[project][module] …")` for project facts.
User prefs / identity → user memory or profile, not workspace.
</workspace_memory_policy>"""
    return """<workspace_memory_policy>
**项目知识**仅在绑定工作区时写入 `assets/workspaces/{hash}/memory/`。

只记**可复用的项目事实**：
- **module** — 核心功能模块与职责
- **logic** — 重要业务/技术逻辑
- **architecture** — 架构分层、数据流、关键依赖
- **convention** — 命名、目录、构建/运行约定
- **gotcha** — 踩坑与约束
- **entrypoint** — 启动/构建/部署入口

**不要写入**：一次性测试、会话改动流水、UI 微调结果、问候语、无结构碎片。
项目事实用 `assets(action=note, scope=workspace, content="[project][module] …")`。
用户偏好/身份 → 写 user 记忆或 profile，不要写 workspace。
</workspace_memory_policy>"""
