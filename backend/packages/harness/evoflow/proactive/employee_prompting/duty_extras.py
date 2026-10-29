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
        describe_org_wiring,
        filter_roster_same_org,
        get_manager,
        list_direct_reports,
        reports_to_code,
    )

    raw = roster if roster is not None else _load_active_roster()
    peers = filter_roster_same_org(role, raw)
    wiring = describe_org_wiring(role, raw)
    manager = get_manager(role, peers)
    reports = list_direct_reports(role, peers)
    self_mgr = reports_to_code(role)
    max_n = int(getattr(role.config, "max_initiatives_per_cycle", 2) or 2)
    needs_wiring = bool(wiring.get("needs_reports_to_wiring"))

    if reports:
        reports_list = "\n".join(
            f"  - `{r.agent_code}` · {r.role_name}（{r.department or '—'}）" for r in reports
        )
        has_downstream = True
    elif needs_wiring:
        reports_list = "  - （无直属下级——同组织有人但尚未配置 reports_to 指向本岗）"
        has_downstream = False
    else:
        reports_list = "  - （无直属下级，本岗是叶子节点）"
        has_downstream = False

    if manager:
        manager_line = f"`{manager.agent_code}` · {manager.role_name}（{manager.department or '—'}）"
        has_upstream = True
    else:
        manager_line = "（无上级，本岗是顶级负责人——合法；有下级时靠下属 reports_to 指向本岗）"
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

    # Handoff one-liner only — full rules live in ``<employee_collab>``; people in ``<employee_org>``.
    if has_downstream and has_upstream:
        handoff_note = "有上下级：做完本岗部分后 handlers 派下级；下级已平级交接时勿再传令；整单验收再 completed。"
    elif has_downstream:
        handoff_note = "顶级负责人：方案/拆解后 handlers 派第一棒下级即可；勿越权做下游；勿每次回执都重派下一环。"
    elif has_upstream and peers_same_mgr:
        handoff_note = (
            "叶子执行岗（有平级）：做完若还有下一环，``completed``+handlers 直接交平级；"
            "勿只结案等上级代派；勿给上级新建验收单。"
        )
    elif has_upstream:
        handoff_note = "叶子执行岗（无平级）：做完对本岗 completed；勿给上级新建验收单。"
    elif needs_wiring:
        handoff_note = "汇报线未挂通：见 ``<employee_collab>`` / ``<employee_org>``；先 tasks create，再补 reports_to。"
    else:
        handoff_note = "独立岗：完成后直接结案。"

    docs_hint = f"文档类产出写到 ``{docs_rel}`` 目录。" if docs_rel else ""

    return f"""<duty_workflow>
## 工作流（轻量，别搞仪式感）

> 先把活干完；进度回写可选，写不了就跳过，**不要为 progress/state 空转重试**。
> 干完直接 ``state=completed``（pending 也可直达），需要下游再带 handlers。
> {handoff_note}

### 接单

1. 读标题 + 描述，弄清验收标准；不是本岗的活就转派或上报
2. 描述模糊先问清楚，不要瞎猜

### 执行

3. 按本岗职责产出交付物：{docs_hint}
4. 中间 ``progress`` **可选**——有空就写，失败/不想写就继续干活或直接结案
5. 只做本岗该做的事，不要越权代做下游
6. 搞不定 → ``state=failed`` 写清原因

> 看板权威在上下文末尾 ``<proactive_live_tasks>``；结案用里面的 task_id。

### 自检（简短）

7. 对照验收标准过一遍；不达标就改，达标就结案

### 交接（有需要才做）

> 干完不交 = 没干完。但「交」≠「再随便开一张新单」。

8. 下一步交给谁：

    **A：有直属下级要继续** → ``state=completed`` + **handlers**（禁止再 create+wake 同一次交接）
    直属下级：
{reports_list}

    **B：无下级 + 有平级 + 流水线还有下一环** → ``state=completed`` + **handlers** 交给平级（勿绕回上级代派）
    平级岗：
{peer_list}

    **C：本岗即最终环 / 无下一环** → 对本岗 ``state=completed``（写 summary）；勿给上级新建验收单；勿 handlers 指向自己
    直属上级：{manager_line}

    **D：无关新事项的平级协作** → ``tasks create``（``start=true``）；已有未结单才 wake，禁止重复造单

    **E：阻塞/失败** → ``failed`` + 原因；勿空建上级任务

### 验收（被 soft-wake / 下游回执时）

9. 在点名的父单上验收；通过则 completed，不通过则打回；禁止新建「【下游回执】」单

---

**本轮最多新开 {max_n} 张有意义的单**（续跑已有 Task 不计入）。
有实质工作才留下进展；看板空则直接结束本轮。
禁止「【巡检完成】/系统健康/Gateway 正常」交差腔。
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
