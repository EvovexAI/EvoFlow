"""Duty-only extras for the shared employee skeleton (workflow, skills, presence)."""

from __future__ import annotations

from typing import Any

from evoflow.proactive.models import ProactiveRole

# Optional extra duty lines for seeded / known roles (prompt only; not enforcement).
ROLE_DUTY_PROMPT_EXTRAS: dict[str, str] = {
    "product-manager": (
        "## 本岗工作方式\n"
        "- 产出需求/改动方案文档；写清改哪、验收标准、风险与回滚。\n"
        "- 不要亲自改业务源码；需要落地时交给对口实现岗。\n"
        "- 结案时不要写「本人已改完、无需再派」。\n"
    ),
    "quality-inspector": (
        "## 本岗工作方式\n"
        "- 职责是审核方案与风险，产出审核文档；通过后派实现岗改码。\n"
        "- 不要亲自改业务源码（含「只改一行文案」）。\n"
        "- 若下一步要改码，结案时指定下游处理人；不要写「本人已改完」。\n"
    ),
}

ROLE_DUTY_SKILL_DEFAULTS: dict[str, tuple[str, ...]] = {
    "product-manager": (
        "superpowers-brainstorming",
        "superpowers-using-superpowers",
    ),
    "quality-inspector": (
        "superpowers-writing-plans",
        "superpowers-requesting-code-review",
        "superpowers-using-superpowers",
    ),
    "code-agent": (
        "superpowers-executing-plans",
        "superpowers-test-driven-development",
        "superpowers-using-git-worktrees",
        "superpowers-verification-before-completion",
    ),
    "project-implementer": (
        "superpowers-executing-plans",
        "superpowers-test-driven-development",
        "superpowers-using-git-worktrees",
        "superpowers-verification-before-completion",
    ),
    "project-debugger": (
        "superpowers-systematic-debugging",
        "superpowers-dispatching-parallel-agents",
        "superpowers-verification-before-completion",
    ),
    "marketing-social-media-operation": ("superpowers-brainstorming",),
}


def build_role_duty_prompt_extras(role: ProactiveRole) -> str:
    code = str(role.agent_code or "").strip().lower()
    text = str(ROLE_DUTY_PROMPT_EXTRAS.get(code) or "").strip()
    return f"\n{text}\n" if text else ""


def resolve_role_duty_skills(role: ProactiveRole) -> list[str]:
    """Skills for this duty (agent skills → role skills → defaults ∩ enabled)."""
    cfg_skills: list[str] = []
    inherit = True
    try:
        extra = role.config.extra_context if isinstance(role.config.extra_context, dict) else {}
        inherit = not bool(extra.get("override_capabilities"))
    except Exception:
        inherit = True
    if inherit:
        try:
            from evoflow.config.agents_config import load_agent_config

            agent_cfg = load_agent_config(str(role.agent_code or "").strip())
            if agent_cfg is not None and agent_cfg.skills is not None:
                cfg_skills = [str(s).strip() for s in agent_cfg.skills if str(s).strip()]
        except Exception:
            cfg_skills = []
    if not cfg_skills:
        cfg_skills = [str(s).strip() for s in (role.config.skills or []) if str(s).strip()]
    if not cfg_skills:
        cfg_skills = list(ROLE_DUTY_SKILL_DEFAULTS.get(str(role.agent_code or "").strip(), ()))
    if not cfg_skills:
        return []
    try:
        from evoflow.skills import load_skills

        enabled = {s.name for s in load_skills(enabled_only=True)}
    except Exception:
        enabled = set()
    if not enabled:
        return cfg_skills
    return [name for name in cfg_skills if name in enabled]


def build_duty_skills_section(role: ProactiveRole) -> str:
    names = resolve_role_duty_skills(role)
    if not names:
        return ""
    try:
        from evoflow.agents.lead_agent.prompt import get_skills_prompt_section

        block = get_skills_prompt_section(set(names), use_virtual_paths=False, compact=True)
    except Exception:
        block = ""
    if not block.strip():
        listed = "、".join(f"`{n}`" for n in names)
        return f"<duty_skills>\n本岗可用：{listed}。需要时先加载相关技能再按步骤做。\n</duty_skills>"
    return f"<duty_skills>\n实现 / 拆解 / 验收类工作时，先读相关技能再动手。\n{block}\n</duty_skills>"


def _format_kpi_lines(kpis: list[Any]) -> list[str]:
    lines: list[str] = []
    for raw in kpis or []:
        if isinstance(raw, dict):
            name = str(raw.get("name") or raw.get("title") or "").strip()
            target = str(raw.get("target") or "").strip()
            text = f"{name}（{target}）" if name and target else (name or target or str(raw))
        else:
            text = str(raw or "").strip()
        if text:
            lines.append(f"- {text}")
    return lines


def build_duty_kpi_block(role: ProactiveRole) -> str:
    kpi_lines = _format_kpi_lines(list(role.config.kpis or []))
    if not kpi_lines:
        return ""
    return "<duty_kpi>\n### 本岗 KPI\n" + "\n".join(kpi_lines) + "\n</duty_kpi>"


def _load_active_roster() -> list[ProactiveRole]:
    try:
        from evoflow.proactive.repositories import ProactiveRepository

        return list(ProactiveRepository.list_roles(status="active") or [])
    except Exception:
        return []


def build_standard_workflow_section(
    role: ProactiveRole,
    *,
    roster: list[ProactiveRole] | None = None,
    docs_rel: str = "",
) -> str:
    """Duty workflow: 接单→执行→自检→交接→验收."""
    from evoflow.proactive.org import (
        filter_roster_same_org,
        get_manager,
        list_direct_reports,
        reports_to_code,
    )

    raw = roster if roster is not None else _load_active_roster()
    peers = filter_roster_same_org(role, raw)
    manager = get_manager(role, peers)
    reports = list_direct_reports(role, peers)
    self_mgr = reports_to_code(role)
    max_n = int(getattr(role.config, "max_initiatives_per_cycle", 2) or 2)

    if reports:
        reports_list = "\n".join(
            f"  - `{r.agent_code}` · {r.role_name}（{r.department or '—'}）" for r in reports
        )
        has_downstream = True
    else:
        reports_list = "  - （无直属下级，本岗是叶子节点）"
        has_downstream = False

    if manager:
        manager_line = f"`{manager.agent_code}` · {manager.role_name}（{manager.department or '—'}）"
        has_upstream = True
    else:
        manager_line = "（无上级，本岗是顶级负责人）"
        has_upstream = False

    self_code = str(role.agent_code or "").strip()
    peers_same_mgr = [
        r
        for r in peers
        if str(r.agent_code or "").strip() != self_code
        and reports_to_code(r) == self_mgr
        and self_mgr
        and self_mgr != str(r.agent_code or "").strip()
    ]
    if peers_same_mgr:
        peer_list = "\n".join(
            f"  - `{r.agent_code}` · {r.role_name}（{r.department or '—'}）" for r in peers_same_mgr
        )
    else:
        peer_list = "  - （无同一上级下的平级岗位）"

    if has_downstream and has_upstream:
        handoff_note = (
            "你既有直属下级也有直属上级：本岗做完自己的部分后，必须通过 handlers 派给下级继续；"
            "如果是上级派来的任务且本岗已全部完成，则提交上级验收。"
        )
    elif has_downstream:
        handoff_note = (
            "你有直属下级但无上级（顶级负责人）：本岗做完方案/拆解后，必须通过 handlers 派给下级执行，"
            "不要自己越权做下游的活。"
        )
    elif has_upstream:
        handoff_note = "你有上级但无直属下级（叶子执行岗）：本岗完成全部开发/测试/执行后，直接提交上级验收。"
    else:
        handoff_note = "你是独立岗（无上级无下级）：完成后直接结案，无需交接。"

    docs_hint = f"文档类产出写到 ``{docs_rel}`` 目录。" if docs_rel else ""

    return f"""<duty_workflow>
## 标准工作流（必须严格遵守）

> **核心原则**：任务不是"做完就完了"，而是"做完 + 交接好 + 有人验收"才算闭环。
> {handoff_note}

### 阶段一：接单（理解任务）

1. 读任务标题 + 描述，明确**验收标准**是什么
2. 判断是不是本岗的活：
   - 是 → 进入执行阶段
   - 不是本岗职责 → 转派给对口岗，或上报上级
3. 如果任务描述模糊，先问清楚再动手，不要瞎猜

### 阶段二：执行（产出交付物）

4. 拆解成具体步骤，**每推进一步就回写进度**（progress 0→100）
5. 按本岗职责产出交付物：{docs_hint}
6. 只做本岗该做的事，**不要越权代做下游的活**
7. 遇到搞不定的阻塞，标记失败并写清原因，上报上级

> 工作账本是 **Task**。上下文末尾的 ``<proactive_live_tasks>`` 是权威来源，按它更新进度，不要凭记忆瞎编。

### 阶段三：自检（对照验收标准）

8. 完成后**必须自检**，对照验收标准逐项过一遍
9. 自检不通过 → 回去改，改完再自检，直到达标
10. 自检通过 → 进入交接阶段

### 阶段四：交接（最重要！）

> 干完不交 = 没干完。但「交」≠「再随便开一张新单」。

11. 判断下一步该交给谁：

    **情况 A：有直属下级，需要下游继续**
    → **唯一正确做法**：``tasks state`` 结案并带 **handlers**（系统建下游单并叫醒）
    → **禁止**：对直属下级再 ``create`` + ``wake`` 做同一次交接
    → 你的直属下级：
{reports_list}

    **情况 B：无下级 + 有上级，本岗叶子工作已全部完成**
    → 对本岗 Task ``state=completed`` 结案（写 summary）；**不要**再给上级新建任务
    → 系统会 soft-wake 上级在**原编排单**上验收；上级验收通过后再把根单 ``completed``
    → 你的直属上级：{manager_line}

    **情况 C：平级协作（同组织、同一上级下的平级岗 — 可相互调用）**
    → 新事项：``tasks create``（assignee=对方，``start=true`` 默认）即可 — **建单即开工，禁止再单独 wake**；只排队才 ``start=false``
    → 已有未结单：才 ``wake`` + ``task_id`` / ``related_task_id`` 续跑
    → 对方 busy → 稍后同一 id 重试，禁止改标题再开一张
    → 你的平级协作岗：
{peer_list}

    **情况 D：阻塞/失败**
    → 标记 failed，写清阻塞原因；需要上报时在 summary 写明，勿空建上级任务

12. 交接时必须写清楚：做了什么、验收要点、产出物路径、下游下一步

### 阶段五：验收（收到下游回执 / 被 soft-wake 时）

13. 回执 goal 会点名**父编排单 / 根单** ``task_id``：
    - **禁止**再新建「【下游回执】…」或同名验收单
    - 复核下游产出 → 通过则对本岗/根单 ``state=completed``；不通过则打回或再派 handlers
    - 父单若是 ``awaiting_close``：进度 100% ≠ 整单结束，须验收后才 completed
14. 验收是你的责任，不能「收到就过」

---

**本轮最多新开 {max_n} 张有意义的单**（续跑已有 Task 不计入「新开」）。
**有实质工作**时才留下可观测进展（更新进度或结案优先于新建）。
**看板空、无派发、无阻塞**：直接结束本轮即可——不要为交差而写「巡检报告」。
禁止对用户写「【巡检完成】/系统健康/Gateway 端口正常/无阻塞性待办」这类机房值班腔。
</duty_workflow>
"""


def build_duty_resources_block(
    role: ProactiveRole,
    *,
    query: str = "",
    include_memory: bool = True,
) -> str:
    """Presence / docs / skills / role extras; person memory+craft only when memory on."""
    parts: list[str] = []

    extras = build_role_duty_prompt_extras(role)
    if extras.strip():
        parts.append(f"<duty_role_extras>\n{extras.strip()}\n</duty_role_extras>")

    kpi = build_duty_kpi_block(role)
    if kpi:
        parts.append(kpi)

    try:
        from evoflow.person_kernel import format_person_presence_block

        presence = format_person_presence_block(role.agent_code, for_duty=True)
        if str(presence or "").strip():
            parts.append(str(presence).strip())
    except Exception:
        pass

    q = str(query or "").strip()
    if include_memory:
        try:
            from evoflow.person_kernel import format_affect_and_commitments_block

            affect = format_affect_and_commitments_block(role.agent_code)
            if str(affect or "").strip():
                parts.append(str(affect).strip())
        except Exception:
            pass

        try:
            from evoflow.person_kernel import format_person_memory_context

            pm = format_person_memory_context(role.agent_code, query=q)
            if pm.strip():
                parts.append(
                    f"<person_memory>\n### 自我经历（自传 · 先读后用）\n{pm}\n</person_memory>"
                )
        except Exception:
            pass

        try:
            from evoflow.person_kernel import format_person_craft_context

            pc = format_person_craft_context(role.agent_code, query=q)
            if pc.strip():
                parts.append(
                    f"<person_craft>\n### 本事（高权重程序记忆 · 相关则必须优先复用）\n{pc}\n</person_craft>"
                )
        except Exception:
            pass

    try:
        from evoflow.proactive.artifacts import format_role_docs_prompt_block

        docs = format_role_docs_prompt_block(role)
        if str(docs or "").strip():
            parts.append(f"<duty_docs>\n{docs.strip()}\n</duty_docs>")
    except Exception:
        pass

    skills = build_duty_skills_section(role)
    if skills:
        parts.append(skills)

    close = (
        "<duty_close>\n"
        "记住：任务闭环 = 本岗做完 + 交接到位 + 验收通过。少一步都不算完。\n"
    )
    if include_memory:
        close += "结案像人交班：若本轮承接了自传/本事/承诺，用一两句点明即可，禁止长抒情。\n"
    close += "</duty_close>"
    parts.append(close)
    return "\n\n".join(p for p in parts if p)
