"""Per-role document / deliverable paths under the bound workspace.

SSOT layout (English, filesystem-safe)::

    docs/roles/<agent_code>/<YYYYMMDD-HH>/…
    e.g. docs/roles/code-agent/20260721-18/sprint-note.md

Hour stamp (UTC, to the hour) keeps same-topic writes from clobbering each other.
``role_name`` stays UI-only; paths always use ``agent_code``.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any

_SAFE_SLUG = re.compile(r"[^a-zA-Z0-9._-]+")


def role_docs_slug(role: Any = None, *, agent_code: str = "") -> str:
    """Stable folder name under ``docs/roles/`` — always ``agent_code``."""
    code = str(agent_code or getattr(role, "agent_code", "") or "").strip()
    if not code:
        return "_unknown"
    cleaned = _SAFE_SLUG.sub("-", code).strip(".-_")
    return cleaned or "_unknown"


def role_docs_hour_stamp(when: datetime | None = None) -> str:
    """UTC hour bucket: ``YYYYMMDD-HH`` (e.g. ``20260721-18``)."""
    dt = when or datetime.now(timezone.utc)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    else:
        dt = dt.astimezone(timezone.utc)
    return dt.strftime("%Y%m%d-%H")


def role_docs_rel_dir(
    role: Any = None,
    *,
    agent_code: str = "",
    when: datetime | None = None,
    with_hour: bool = True,
) -> str:
    """Relative dir from workspace root, trailing slash.

    Default: ``docs/roles/<agent_code>/<YYYYMMDD-HH>/``
    ``with_hour=False`` → ``docs/roles/<agent_code>/`` (role root only).
    """
    base = f"docs/roles/{role_docs_slug(role, agent_code=agent_code)}/"
    if not with_hour:
        return base
    return f"{base}{role_docs_hour_stamp(when)}/"


def format_role_docs_prompt_block(role: Any, *, when: datetime | None = None) -> str:
    """Markdown block injected into duty system prompt."""
    code = str(getattr(role, "agent_code", "") or "").strip() or "?"
    name = str(getattr(role, "role_name", "") or "").strip() or code
    stamp = role_docs_hour_stamp(when)
    role_root = role_docs_rel_dir(role, with_hour=False)
    rel = role_docs_rel_dir(role, when=when, with_hour=True)
    html_rule = ""
    if code == "video-analyst":
        html_rule = (
            "\n**格式**：拆解分析报告必须写 **HTML（.html）**，"
            "禁止写 Markdown（.md）。用表格呈现分类/标签/评分/归因；"
            "可用 `video_render_report_html` 生成后 `--copy-to` 拷到本目录。"
            "ContentOS 拆解面板可内嵌打开 HTML 报告。"
        )
    return f"""## 交付文档目录

岗位「{name}」（`{code}`）的方案 / 报告 / 纪要等文档，写到本小时目录（UTC）：``{rel}``。
岗位根 ``{role_root}``，当前小时 ``{stamp}``。不要写到仓库根、别人岗位目录，也不要无时间戳堆在岗位根。
改业务代码仍走管辖范围内的源码路径；只有文档类交付走这里。{html_rule}
"""
