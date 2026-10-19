"""Single ``<memory_assets>`` region: write policy + recalled content.

Gated with the same ``memory_enabled`` / ``assets`` tool switch — when memory is
off, ``strip_memory_xml_blocks`` removes this whole region and the tool is unbound.
"""

from __future__ import annotations

from typing import Any, Literal

MEMORY_ASSETS_TAG = "memory_assets"

Scope = Literal["main", "employee", "compact"]


def _lang_zh(prompt_language: str | None) -> bool:
    pl = str(prompt_language or "").strip().lower()
    return not pl or pl.startswith("zh")


def memory_assets_policy_text(
    *,
    scope: Scope = "main",
    agent_code: str = "",
    prompt_language: str | None = None,
) -> str:
    """Policy-only body (no outer tag). Same rules for main and employee; identity is session-bound."""
    code = str(agent_code or "").strip() or "employee"
    zh = _lang_zh(prompt_language)

    if zh:
        if scope == "employee":
            return "\n".join(
                [
                    "## 记忆与资产（本岗）",
                    "优先级：最新用户消息 > 本岗记忆 > 用户画像。未点名的旧任务不要自动续跑。",
                    "经验/过程/反思/偏好沉淀：只用 `assets`（`note` / `search` / `read` / `list`）；"
                    "用户画像用 `assets` `profile`。",
                    "会话已绑定本岗身份，工具写入员工树；勿再 `write` 拼路径，也勿写到用户桶或工作区。",
                    "用户说「记住…」或稳定偏好/称呼：立刻 `assets(note)` / `assets(profile)`。"
                    "有价值流程、过程、反复出错点：**先问用户**是否存为经验/过程/反思，获准后再 `assets(note)`"
                    "（首行 `[experience]` / `[process]` / `[reflection]` / `[preference]`）。"
                    "禁止 `knowledge` write 或旧 `experience_*`；闲聊与无复用噪声不写。",
                    "note 文件名由工具生成（slug，时间在 frontmatter）。待合并 inbox 见下方注入；Phase2 汇总后归档。"
                    "禁止直接编辑 craft/。完整路径与边界 → `$evoflow-assets` skill。",
                    f"<!-- person memory root: assets/employees/{code}/ -->",
                ]
            )
        # main + compact share the same write surface; compact is shorter ranking copy
        head = "## 记忆与资产" if scope != "compact" else "## 记忆与资产（精简）"
        return "\n".join(
            [
                head,
                "优先级：最新用户消息 > 用户画像 > 本 Agent 经验/反思/过程 > 站立摘要/facts/soul/工作空间。"
                "经验、反思、过程是高权重工作记忆：相关则优先检索复用，禁止当摆设。",
                "写入：只用 `assets`（`note` / `profile` / `search` / `read`）；勿用裸 `write` 拼资产路径。"
                "身份由会话绑定（主对话→用户桶，员工→员工树）。",
                "用户说「记住…」或稳定偏好/称呼：立刻 `assets(note)` / `assets(profile)`。"
                "有价值流程、过程、反复出错点：**先问用户**是否存为经验/过程/反思，获准后再 `assets(note)`"
                "（首行 `[experience]` / `[process]` / `[reflection]` / `[preference]`；workspace 用 `[project]`）。"
                "禁止 `knowledge` write 或旧 `experience_*`；闲聊与无复用噪声不写。Phase2 后台汇总。"
                "禁止直接编辑 craft/。完整路径、profile 维护、边界 → `$evoflow-assets` skill。",
            ]
        )

    # English
    if scope == "employee":
        return "\n".join(
            [
                "## Memory & assets (this role)",
                "Priority: latest user message > role memory > user profile. Do not resume unnamed old tasks.",
                "Deposit experience/process/reflection/prefs via `assets` only (`note` / `search` / `read` / `list`);"
                " user profile via `assets` `profile`.",
                "Session identity writes the employee tree — do not bare-`write` paths or the user bucket.",
                'On "remember…" or stable prefs: write immediately with `assets(note)` / `assets(profile)`.'
                " Valuable workflow/process/recurring mistakes: **ask first**, then `assets(note)` with"
                " `[experience]` / `[process]` / `[reflection]` / `[preference]`.",
                "No `knowledge` write or legacy `experience_*`. Note filenames are tool-generated (slug;"
                " time in frontmatter). Pending inbox notes inject below; Phase2 consolidates."
                " Do not edit craft/ directly. Paths/boundaries → `$evoflow-assets` skill.",
                f"<!-- person memory root: assets/employees/{code}/ -->",
            ]
        )
    head = "## Memory & assets" if scope != "compact" else "## Memory & assets (compact)"
    return "\n".join(
        [
            head,
            "Priority: latest user message > user profile > craft/journal/episodic > standing/facts/soul/workspace."
            " Craft/reflections/process are high-weight — reuse when relevant, not decoration.",
            "Writes: `assets` only (`note` / `profile` / `search` / `read`); no bare-`write` asset paths."
            " Session identity routes the bucket (main→user, employee→employee tree).",
            'On "remember…" or stable prefs: write immediately with `assets(note)` / `assets(profile)`.'
            " Valuable workflow/process/recurring mistakes: **ask first**, then `assets(note)` with"
            " `[experience]` / `[process]` / `[reflection]` / `[preference]` (workspace: `[project]`).",
            "No `knowledge` write or legacy `experience_*`. Phase2 consolidates. Do not edit craft/."
            " Full paths/profile/boundaries → `$evoflow-assets` skill.",
        ]
    )


def wrap_memory_assets(*parts: str) -> str:
    """Join non-empty parts into one ``<memory_assets>`` block."""
    body = "\n\n".join(p.strip() for p in parts if str(p or "").strip())
    if not body:
        return ""
    return f"<{MEMORY_ASSETS_TAG}>\n{body}\n</{MEMORY_ASSETS_TAG}>"


def build_memory_assets_block(
    *,
    scope: Scope = "main",
    agent_code: str = "",
    prompt_language: str | None = None,
    memory_context: str = "",
    person_memory_context: str = "",
    extra_body_parts: list[str] | None = None,
    include_pending_inbox: bool = False,
    include_policy: bool = True,
) -> str:
    """Build the unified memory+assets region (policy + optional recall)."""
    parts: list[str] = []
    if include_policy:
        parts.append(
            memory_assets_policy_text(
                scope=scope,
                agent_code=agent_code,
                prompt_language=prompt_language,
            )
        )

    user_mem = str(memory_context or "").strip()
    if user_mem:
        parts.append(f"<!-- user memory: reference only -->\n{user_mem}")

    code = str(agent_code or "").strip()
    person_mem = str(person_memory_context or "").strip()
    if person_mem:
        label = (
            f"<!-- person memory: assets/employees/{code}/ ，reference only -->"
            if code
            else "<!-- person memory: reference only -->"
        )
        parts.append(f"{label}\n{person_mem}")

    if include_pending_inbox and code:
        try:
            from evoflow.assets.ad_hoc_note import format_pending_inbox_notes_for_prompt
            from evoflow.assets.paths import EntityRef

            pending = format_pending_inbox_notes_for_prompt(EntityRef("employee", code))
            if pending:
                parts.append(pending)
        except Exception:
            pass

    for extra in extra_body_parts or []:
        e = str(extra or "").strip()
        if e:
            parts.append(e)

    return wrap_memory_assets(*parts)


def build_employee_memory_assets_block(
    identity: dict[str, Any],
    *,
    memory_context: str = "",
    person_memory_context: str = "",
    prompt_language: str | None = None,
) -> str:
    """Employee-chat entry: policy + user/person recall + pending inbox."""
    code = str(identity.get("code") or "").strip() or "employee"
    return build_memory_assets_block(
        scope="employee",
        agent_code=code,
        prompt_language=prompt_language,
        memory_context=memory_context,
        person_memory_context=person_memory_context,
        include_pending_inbox=True,
        include_policy=True,
    )
