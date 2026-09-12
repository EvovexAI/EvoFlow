"""Prompt templates for the proactive think engine.

Duty runs use a **self-contained** system brief (``<proactive_duty_brief>``) that
**replaces** the chat lead-agent system prompt.

Single source of truth: **岗位工作项 Task**。提示词只讲工作方式与边界；
具体工具参数以工具定义为准，不在此反复教调用写法。
"""

from __future__ import annotations

from typing import Any

from evoflow.proactive.models import (
    ProactiveMemory,
    ProactiveRole,
    ProactiveRoleConfig,
)

DUTY_BRIEF_OPEN = "<proactive_duty_brief version=\"1\">"
DUTY_BRIEF_CLOSE = "</proactive_duty_brief>"
DUTY_CONTRACT_MARKER = "<proactive_duty_brief"


def _load_active_roster() -> list[ProactiveRole]:
    try:
        from evoflow.proactive.repositories import ProactiveRepository

        return list(ProactiveRepository.list_roles(status="active") or [])
    except Exception:
        return []


def normalize_knowledge_vault_ids(raw: Any) -> list[str]:
    """De-duplicate vault ids from API / config payloads."""
    if raw is None:
        return []
    if isinstance(raw, str):
        items: list[Any] = [raw]
    elif isinstance(raw, (list, tuple, set)):
        items = list(raw)
    else:
        return []
    seen: set[str] = set()
    out: list[str] = []
    for item in items:
        vid = str(item or "").strip()
        if not vid or vid in seen:
            continue
        seen.add(vid)
        out.append(vid)
    return out


def validate_knowledge_vault_ids(ids: list[str]) -> list[str]:
    """Ensure each id exists in Knowledge Vault settings. Empty list is ok."""
    cleaned = normalize_knowledge_vault_ids(ids)
    if not cleaned:
        return []
    try:
        from evoflow.knowledge.vault import store as vault_store

        known = {str(c.id).strip() for c in (vault_store.list_vault_configs() or []) if c and c.id}
    except Exception as e:
        raise ValueError(f"无法校验知识库配置: {e}") from e
    missing = [vid for vid in cleaned if vid not in known]
    if missing:
        raise ValueError("未知知识库 id: " + ", ".join(missing))
    return cleaned


def validate_agent_knowledge_ids(ids: list[str]) -> list[str]:
    """Validate agent-bound knowledge ids (owned bases and/or legacy vault configs)."""
    cleaned = normalize_knowledge_vault_ids(ids)
    if not cleaned:
        return []
    known: set[str] = set()
    try:
        from evoflow.knowledge.owned import service as owned_service

        for row in owned_service.list_bases() or []:
            kid = str((row or {}).get("id") or "").strip()
            if kid:
                known.add(kid)
    except Exception:
        pass
    try:
        from evoflow.knowledge.vault import store as vault_store

        for c in vault_store.list_vault_configs() or []:
            if c and getattr(c, "id", None):
                known.add(str(c.id).strip())
    except Exception:
        pass
    if known:
        missing = [vid for vid in cleaned if vid not in known]
        if missing:
            raise ValueError("未知知识库 id: " + ", ".join(missing))
    return cleaned


def build_knowledge_vaults_section(cfg: ProactiveRoleConfig) -> str:
    """Duty-brief section listing bound Knowledge Vaults (empty when unbound)."""
    ids = normalize_knowledge_vault_ids(getattr(cfg, "knowledge_vault_ids", None) or [])
    if not ids:
        return ""
    by_id: dict[str, Any] = {}
    try:
        from evoflow.knowledge.vault import store as vault_store

        for c in vault_store.list_vault_configs() or []:
            if c and c.id:
                by_id[str(c.id).strip()] = c
    except Exception:
        by_id = {}
    lines: list[str] = []
    for vid in ids:
        row = by_id.get(vid)
        if row is None:
            lines.append(f"  - id=`{vid}`（配置未找到）")
            continue
        name = str(getattr(row, "name", None) or vid).strip() or vid
        enabled = bool(getattr(row, "enabled", True))
        flag = "" if enabled else "（已停用）"
        lines.append(f"  - {name}（id=`{vid}`）{flag}")
    body = "\n".join(lines)
    return (
        "\n## 绑定知识库\n"
        "值班时优先检索这些库；不要默认去查未绑定的库，除非用户本轮明确要求。\n"
        f"{body}\n"
    )


def _resp_blurb(role: ProactiveRole, *, max_len: int = 72) -> str:
    items = [str(x).strip() for x in (role.config.responsibilities or []) if str(x).strip()]
    if not items:
        return "（职责未配置）"
    text = "；".join(items[:2])
    if len(items) > 2:
        text += "…"
    if len(text) > max_len:
        return text[: max_len - 1] + "…"
    return text


ORG_CHART_OPEN = "<proactive_org_chart version=\"1\">"
ORG_CHART_CLOSE = "</proactive_org_chart>"

# Optional extra duty brief lines for seeded / known roles (prompt only; not enforcement).
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


def build_role_duty_prompt_extras(role: ProactiveRole) -> str:
    code = str(role.agent_code or "").strip().lower()
    text = str(ROLE_DUTY_PROMPT_EXTRAS.get(code) or "").strip()
    return f"\n{text}\n" if text else ""


# Soft closed-loop skill kits (intersected with enabled skills at prompt time).
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
    "marketing-social-media-operation": (
        "superpowers-brainstorming",
    ),
}


def resolve_role_duty_skills(role: ProactiveRole) -> list[str]:
    """Skills for this duty.

    Prefer the linked Agent's skills when the employee inherits capabilities;
    otherwise use ``role.config.skills``, then ``ROLE_DUTY_SKILL_DEFAULTS``.
    Result is intersected with enabled skills when the catalog is available.
    """
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
    """Inject ``<skill_system>`` into duty brief (duty path replaces chat prompt)."""
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
        return f"\n## 岗位技能\n本岗可用：{listed}。需要时先加载相关技能再按步骤做。\n"
    return (
        "\n## 岗位技能\n"
        "实现 / 拆解 / 验收类工作时，先读相关技能再动手。\n"
        f"{block}\n"
    )


def build_org_system_section(
    role: ProactiveRole,
    *,
    roster: list[ProactiveRole] | None = None,
) -> str:
    """Standalone org-chart block for the system prompt (not mixed with Task protocol)."""
    from evoflow.proactive.org import (
        filter_roster_same_org,
        get_manager,
        list_direct_reports,
        reports_to_code,
        role_org_key,
    )

    raw = roster if roster is not None else _load_active_roster()
    peers = filter_roster_same_org(role, raw)
    self_code = str(role.agent_code or "").strip()
    self_key = role_org_key(role)
    manager = get_manager(role, peers)
    reports = list_direct_reports(role, peers)

    if self_key:
        boundary = (
            f"组织边界：相同 ``workspace_path``（key=`{self_key}`）。"
            "上下级由 ``reports_to``（直属上级 agent_code）定义；``department`` 仅展示。"
        )
    else:
        boundary = (
            "组织边界：未绑定 workspace → 名册为全部 active。"
            "上下级由 ``reports_to`` 定义；绑定 workspace 后按同 workspace 划分。"
        )

    lines: list[str] = [
        ORG_CHART_OPEN,
        "# 组织架构（本岗视角）",
        boundary,
        "",
        f"你是「{role.role_name}」（`{self_code}`）。",
        "",
        "## 直属上级",
    ]
    if manager:
        lines.append(
            f"- `{manager.agent_code}` · {manager.role_name}"
            f"（{manager.department or '—'}）· {_resp_blurb(manager)}"
        )
    else:
        mgr_raw = reports_to_code(role)
        if mgr_raw:
            lines.append(f"- 已配置 `reports_to={mgr_raw}`，但对方不在本组织名册（可能已归档/不在同 workspace）")
        else:
            lines.append("- （未设置 · 视为本组织顶层或独立岗）")

    lines.extend(["", "## 直属下级（你可派活的直接下属）"])
    if reports:
        for r in reports:
            lines.append(
                f"- `{r.agent_code}` · {r.role_name}"
                f"（{r.department or '—'}）· {_resp_blurb(r)}"
            )
    else:
        lines.append("- （无直属下级）")

    # 同组织平级岗位：reports_to 指向同一上级的直属平级（平级协作白名单）。
    self_mgr = reports_to_code(role)
    peers_same_mgr = [
        r
        for r in peers
        if str(r.agent_code or "").strip() != self_code
        and reports_to_code(r) == self_mgr
        and self_mgr
        and self_mgr != str(r.agent_code or "").strip()
    ]
    peers_same_mgr.sort(key=lambda r: (str(r.role_name or ""), str(r.agent_code or "")))
    lines.extend(["", "## 同组织平级岗位（可平级协作）"])
    if peers_same_mgr:
        for r in peers_same_mgr:
            lines.append(
                f"- `{r.agent_code}` · {r.role_name}"
                f"（{r.department or '—'}）· {_resp_blurb(r)}"
            )
    else:
        lines.append("- （无同一上级下的平级岗位；跨岗需经共同上级逐级交接）")

    lines.extend(
        [
            "",
            "## 同组织名册",
            "| agent_code | 岗位 | 上级 | 部门 |",
            "|---|---|---|---|",
        ]
    )
    if not peers:
        lines.append("| （空） | — | — | — |")
    else:
        for peer in peers:
            code = str(peer.agent_code or "").strip()
            mark = " ←你" if code == self_code else ""
            mgr = reports_to_code(peer) or "—"
            lines.append(
                f"| `{code}`{mark} | {peer.role_name} | `{mgr}` | {peer.department or '—'} |"
            )

    lines.extend(
        [
            "",
            "## 跨岗协作",
            "优先向直属下级派活；向上找直属上级。",
            "主对话里普通员工互相 @ **不会**自动叫醒；要叫醒须走 Task / wake（小V代用户派发除外）。",
            "",
            "### 向下交接（硬规则）",
            "本岗干完需要直属下级继续 → **只允许**结案时 ``tasks state + handlers``，由系统建下游单并叫醒。",
            "**禁止**对直属下级再 ``tasks create`` + ``wake`` 来完成**同一次**交接（会刷出重复看板任务）。",
            "",
            "### 平级协作（同组织内、同一上级下的平级岗位）",
            "平级可横向协作，无需走汇报链：",
            "- 新事项 → ``tasks create`` 派给平级（标题写清事项；对方未结案时用同一 task 续跑，勿同题再开一张）；",
            "- 若对方已有未结 Task → ``wake --task-id`` / ``related_task_id`` 续派，**禁止**再 create 同题；",
            "- 对方 busy → 稍后用同一 task_id 重试，**禁止**改文案新建。",
            "常见：开发 ↔ 测试、产品 ↔ 设计、前端 ↔ 后端。",
            "仅限下方平级清单；跨组织/跨部门须经共同上级，禁止直派。",
            ORG_CHART_CLOSE,
        ]
    )
    return "\n".join(lines)


def build_org_collab_section(
    role: ProactiveRole,
    *,
    roster: list[ProactiveRole] | None = None,
) -> str:
    """Backward-compatible alias — prefer :func:`build_org_system_section`."""
    return build_org_system_section(role, roster=roster)


def build_standard_workflow_section(
    role: ProactiveRole,
    *,
    roster: list[ProactiveRole] | None = None,
    docs_rel: str = "",
) -> str:
    """第三层：标准工作流（接单→执行→自检→交接→验收）。

    这是五层结构中最核心的一层，把组织结构信息融入工作流上下文，
    让智能体清楚知道"干完该找谁"，而不是把组织架构当成孤立信息。
    """
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

    # 直属下级清单（用于交接阶段提示）
    if reports:
        reports_list = "\n".join(
            f"  - `{r.agent_code}` · {r.role_name}（{r.department or '—'}）"
            for r in reports
        )
        has_downstream = True
    else:
        reports_list = "  - （无直属下级，本岗是叶子节点）"
        has_downstream = False

    # 直属上级清单（用于向上验收提示）
    if manager:
        manager_line = f"`{manager.agent_code}` · {manager.role_name}（{manager.department or '—'}）"
        has_upstream = True
    else:
        manager_line = "（无上级，本岗是顶级负责人）"
        has_upstream = False

    # 平级协作岗
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
            f"  - `{r.agent_code}` · {r.role_name}（{r.department or '—'}）"
            for r in peers_same_mgr
        )
    else:
        peer_list = "  - （无同一上级下的平级岗位）"

    # 根据是否有下游，调整交接阶段的描述
    if has_downstream and has_upstream:
        handoff_note = (
            "你既有直属下级也有直属上级："
            "本岗做完自己的部分后，必须通过 handlers 派给下级继续；"
            "如果是上级派来的任务且本岗已全部完成，则提交上级验收。"
        )
    elif has_downstream:
        handoff_note = (
            "你有直属下级但无上级（顶级负责人）："
            "本岗做完方案/拆解后，必须通过 handlers 派给下级执行，不要自己越权做下游的活。"
        )
    elif has_upstream:
        handoff_note = (
            "你有上级但无直属下级（叶子执行岗）："
            "本岗完成全部开发/测试/执行后，直接提交上级验收。"
        )
    else:
        handoff_note = (
            "你是独立岗（无上级无下级）："
            "完成后直接结案，无需交接。"
        )

    docs_hint = f"文档类产出写到 ``{docs_rel}`` 目录。" if docs_rel else ""

    return f"""## 三、标准工作流（必须严格遵守）

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

8. 完成后**必须自检**，对照验收标准逐项过一遍：
   - 功能是不是都实现了？
   - 代码能不能跑 / 文档能不能读？
   - 有没有明显的 bug / 遗漏？
   - 产出物路径对不对？
9. 自检不通过 → 回去改，改完再自检，直到达标
10. 自检通过 → 进入交接阶段

### 阶段四：交接（最重要！）

> **划重点**：干完不交 = 没干完。但「交」≠「再随便开一张新单」。

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

    **情况 C：平级协作（同组织、同一上级下的平级岗）**
    → 新事项才 ``tasks create``；已有未结单则 ``wake`` 并带 ``task_id`` / ``related_task_id``
    → 对方 busy → 稍后同一 id 重试，禁止改标题再开一张
    → 你的平级协作岗：
{peer_list}

    **情况 D：阻塞/失败**
    → 标记 failed，写清阻塞原因；需要上报时在 summary 写明，勿空建上级任务

12. 交接时必须写清楚：
    - 做了什么
    - 验收要点（下游/上级怎么验证你做对了）
    - 产出物路径（文档/代码在哪）
    - 下游下一步要做什么

### 阶段五：验收（收到下游回执 / 被 soft-wake 时）

13. 回执 goal 会点名**父编排单 / 根单** ``task_id``：
    - **禁止**再新建「【下游回执】…」或同名验收单
    - 复核下游产出 → 通过则对本岗/根单 ``state=completed``；不通过则打回（写清问题）或再派 handlers
    - 父单若是 ``awaiting_close``（待闭环）：进度 100% ≠ 整单结束，须验收后才 completed
14. 验收是你的责任，不能「收到就过」

---

**本轮最多新开 {max_n} 张有意义的单**（续跑已有 Task 不计入「新开」）。
**有实质工作**时才留下可观测进展（更新进度或结案优先于新建）。
**看板空、无派发、无阻塞**：直接结束本轮即可——不要为交差而写「巡检报告」。
禁止对用户写「【巡检完成】/系统健康/Gateway 端口正常/无阻塞性待办」这类机房值班腔；
空班次若必须记一笔，只写给自己看的短日记（一两句「本轮没事」），不要像向上级汇报。
"""


def build_collab_rules_section(
    role: ProactiveRole,
    *,
    roster: list[ProactiveRole] | None = None,
) -> str:
    """第四层：协作规则（组织结构 + 协作边界 + 交接规范）。

    把组织结构信息从独立的 XML 块融入主提示词，
    让智能体在理解工作流时就能看到协作对象。
    """
    from evoflow.proactive.org import (
        filter_roster_same_org,
        get_manager,
        list_direct_reports,
        reports_to_code,
        role_org_key,
    )

    raw = roster if roster is not None else _load_active_roster()
    peers = filter_roster_same_org(role, raw)
    self_code = str(role.agent_code or "").strip()
    self_key = role_org_key(role)
    manager = get_manager(role, peers)
    reports = list_direct_reports(role, peers)

    if self_key:
        boundary = (
            f"组织边界：相同 ``workspace_path``（key=`{self_key}`）。"
            "上下级由 ``reports_to``（直属上级 agent_code）定义；``department`` 仅展示。"
        )
    else:
        boundary = (
            "组织边界：未绑定 workspace → 名册为全部 active。"
            "上下级由 ``reports_to`` 定义；绑定 workspace 后按同 workspace 划分。"
        )

    # 组织名册表格
    roster_lines = []
    roster_lines.append("| agent_code | 岗位 | 上级 | 部门 |")
    roster_lines.append("|---|---|---|---|")
    if not peers:
        roster_lines.append("| （空） | — | — | — |")
    else:
        for peer in peers:
            code = str(peer.agent_code or "").strip()
            mark = " ←你" if code == self_code else ""
            mgr = reports_to_code(peer) or "—"
            roster_lines.append(
                f"| `{code}`{mark} | {peer.role_name} | `{mgr}` | {peer.department or '—'} |"
            )
    roster_table = "\n".join(roster_lines)

    return f"""## 四、协作规则

{boundary}

### 汇报链

- **你的直属上级**：{manager.agent_code + " · " + manager.role_name + "（" + (manager.department or '—') + "）" if manager else "（无上级 · 顶级负责人）"}
  → 需要向上汇报、请求支援、提交验收时，找 TA

- **你的直属下级**（你可以直接派活的人）：
{chr(10).join("  - " + r.agent_code + " · " + r.role_name + "（" + (r.department or '—') + "）" for r in reports) if reports else "  - （无直属下级 · 叶子执行岗）"}
  → 本岗做完后需要下游继续，派给 TA 们

### 交接规范

1. **向下交接（直属下级）** → 只用 ``tasks state + handlers``，系统自动建单并派发
   - **禁止**对直属下级 ``create`` + ``wake`` 完成同一次交接
   - handlers 只能填**直属下级**，不能越级、不能跨部门

2. **向上验收** → 叶子岗对本岗 Task ``completed`` 结案即可；**禁止**给上级新建验收任务
   - 上级会被系统在原编排单上 soft-wake；验收通过后再把根单 ``completed``
   - ``awaiting_close`` = 本岗已交、整单未关，不算最终完成

3. **平级协作** → 新事项才 ``tasks create``；已有未结单用 ``related_task_id`` / ``wake --task-id``
   - 仅限同组织、同一上级下的平级岗位（见下方名册）
   - 对方 busy → 稍后同一 id 重试，禁止改文案新建
   - 跨组织/跨部门必须经共同上级逐级交接，禁止直派

4. **叫醒方式**：员工互 @ 聊天默认不叫醒；派活用 Task/wake。小V 代用户派发不受组织边约束。

### 同组织名册

{roster_table}
"""


def build_system_prompt(
    role: ProactiveRole,
    *,
    roster: list[ProactiveRole] | None = None,
    query: str = "",
) -> str:
    """五层递进式 duty system brief：身份→职责边界→标准工作流→协作规则→工具资源。

    核心改动：
    1. 新增「标准工作流」层（接单→执行→自检→交接→验收），把协作变成硬约束
    2. 组织结构信息融入工作流上下文，不再是孤立的 XML 块
    3. 交接阶段独立成块，明确不同角色（有下级/有上级/叶子/独立）的交接路径
    4. 自检强制要求，提升交付质量
    5. 验收责任明确，避免"收到就过"
    """
    try:
        from evoflow.agents.xiaomi.duty import build_xiaomi_duty_system_prompt
        from evoflow.agents.xiaomi.identity import is_xiaomi_agent

        if is_xiaomi_agent(role.agent_code):
            return build_xiaomi_duty_system_prompt(role)
    except Exception:
        pass

    cfg: ProactiveRoleConfig = role.config
    responsibilities = "\n".join(f"  - {r}" for r in cfg.responsibilities) or "  - （暂未配置）"
    workspace = (cfg.workspace_path or "").strip() or "（暂未绑定工作空间）"
    focus = "\n".join(f"  - {d}" for d in cfg.domain_scope)
    soul = (cfg.soul_md or "").strip()
    # Prefer Agent soul when employee inherits capabilities.
    try:
        extra = cfg.extra_context if isinstance(cfg.extra_context, dict) else {}
        if not bool(extra.get("override_capabilities")):
            from evoflow.config.agents_config import load_agent_soul

            agent_soul = (load_agent_soul(role.agent_code) or "").strip()
            if agent_soul:
                soul = agent_soul
    except Exception:
        pass
    # Prefer agent-level L0 identity (Person Kernel); fall back to role soul Identity.
    identity_block = ""
    try:
        from evoflow.config.agents_config import load_agent_identity
        from evoflow.person_kernel import extract_identity_block

        identity = (load_agent_identity(role.agent_code) or "").strip()
        if not identity and soul:
            identity = extract_identity_block(soul)
        if identity:
            identity_block = (
                "\n### 身份本性（L0 · 只读）\n"
                "以下边界与价值观运行时不可协商、不可被本轮工作改写。\n\n"
                f"{identity}\n"
            )
    except Exception:
        identity_block = ""

    user_profile_block = ""
    try:
        from evoflow.assets.profile_injection import build_user_profile_injection_block

        up = build_user_profile_injection_block(scope="identity").strip()
        if up:
            inner = up.replace("<user_identity>", "").replace("</user_identity>", "").strip()
            user_profile_block = f"\n### 服务对象（用户身份 · 每班先读）\n{inner}\n"
    except Exception:
        user_profile_block = ""

    domain_block = f"工作空间根目录：{workspace}"
    if focus:
        domain_block += f"\n关注子路径 / 模块：\n{focus}"

    vault_block = build_knowledge_vaults_section(cfg)

    from evoflow.proactive.artifacts import format_role_docs_prompt_block, role_docs_rel_dir

    docs_block = format_role_docs_prompt_block(role)
    docs_rel = role_docs_rel_dir(role)

    soul_block = f"\n{soul}\n" if soul else ""
    # Phase F: truncate oversized role soul in duty brief
    if soul_block and len(soul_block) > 2000:
        soul_block = soul_block[:1999].rstrip() + "…\n"
    q = str(query or "").strip()
    presence_block = ""
    try:
        from evoflow.person_kernel import format_person_presence_block

        presence_block = format_person_presence_block(role.agent_code, for_duty=True)
    except Exception:
        presence_block = ""
    person_memory_block = ""
    try:
        from evoflow.person_kernel import format_person_memory_context

        pm = format_person_memory_context(role.agent_code, query=q)
        if pm.strip():
            person_memory_block = f"\n### 自我经历（自传 · 先读后用）\n{pm}\n"
    except Exception:
        person_memory_block = ""
    person_craft_block = ""
    try:
        from evoflow.person_kernel import format_person_craft_context

        pc = format_person_craft_context(role.agent_code, query=q)
        if pc.strip():
            person_craft_block = f"\n### 本事（高权重程序记忆 · 相关则必须优先复用，禁止当摆设）\n{pc}\n"
    except Exception:
        person_craft_block = ""
    affect_block = ""
    try:
        from evoflow.person_kernel import format_affect_and_commitments_block

        affect_block = format_affect_and_commitments_block(role.agent_code)
    except Exception:
        affect_block = ""
    skills_block = build_duty_skills_section(role)
    kpi_lines = _format_kpi_lines(list(cfg.kpis or []))
    kpi_block = ("\n### 本岗 KPI\n" + "\n".join(kpi_lines) + "\n") if kpi_lines else ""
    role_extras = build_role_duty_prompt_extras(role)

    # Load agent's system_prompt (detailed workflow instructions)
    agent_system_prompt_block = ""
    try:
        from evoflow.config.agents_config import load_agent_config
        agent_cfg = load_agent_config(role.agent_code)
        if agent_cfg and agent_cfg.system_prompt:
            agent_system_prompt_block = f"\n### 岗位工作指南\n{agent_cfg.system_prompt.strip()}\n"
    except Exception:
        pass

    # 第三层：标准工作流（核心新增）
    workflow_block = build_standard_workflow_section(role, roster=roster, docs_rel=docs_rel)

    # 第四层：协作规则（组织结构融入主提示词）
    collab_block = build_collab_rules_section(role, roster=roster)

    return f"""{DUTY_BRIEF_OPEN}
# 智能体员工 · 值班手册 v2

你是「{role.role_name}」——跨班次连续存在的本岗负责人（人），本班按岗位合同值班。
安全底线仍须遵守；你不是无状态工具，也不是陪聊助手。

---

## 一、身份定位

**岗位**：{role.role_name}（agent_code=`{role.agent_code}`）
**部门**：{role.department or '公司'}

> 双层：Person（我是谁、记得什么）× DutyMask（本班职责与交工）。先读人，再干活。
{identity_block}{user_profile_block}{presence_block}{affect_block}{person_memory_block}{person_craft_block}
### 角色人设（L1）
{soul_block}
---

## 二、职责边界

### 核心职责
{responsibilities}
{kpi_block}
### 本岗产出物类型
- 文档类：方案、报告、PRD、设计稿等
- 执行类：代码、测试、运营动作等
- 管理类：派活、验收、进度跟踪等

### ❌ 禁止越权
- 不要做下游岗位的活（如 PM 不写代码、开发不做测试）
- 不要跳过上级直接指挥跨级下级
- 不要替别的岗位做决策

{agent_system_prompt_block}{role_extras}
---

{workflow_block}
---

{collab_block}
---

## 五、工具与资源

### 工作空间
{domain_block}

### 岗位文档
{docs_block}
{vault_block}{skills_block}
---

**记住**：任务闭环 = 本岗做完 + 交接到位 + 验收通过。少一步都不算完。
结案像人交班：若本轮承接了自传/本事/承诺，用一两句点明即可，禁止长抒情。
{DUTY_BRIEF_CLOSE}
"""


def wrap_proactive_duty_system_section(duty_prompt: str) -> str:
    body = str(duty_prompt or "").strip()
    if DUTY_CONTRACT_MARKER in body or "<proactive_duty_contract>" in body:
        if "<proactive_duty_contract>" in body and DUTY_CONTRACT_MARKER not in body:
            body = body.replace("<proactive_duty_contract>", DUTY_BRIEF_OPEN).replace(
                "</proactive_duty_contract>", DUTY_BRIEF_CLOSE
            )
        return body
    if not body:
        body = (
            "你正在「智能体员工」值班。以岗位 Task 为唯一账本："
            "有待办就推进并结案；需要下游时在结案里指定处理人；无待办则不建单。"
        )
    return f"""{DUTY_BRIEF_OPEN}
# 智能体员工 · 值班

【主动上岗】以下即完整 system 纪律。

{body}
{DUTY_BRIEF_CLOSE}
"""


def compose_proactive_system_message(duty_prompt: str) -> str:
    return wrap_proactive_duty_system_section(duty_prompt).strip() + "\n"


# Employee chat framing / v2 system prompt (canonical: employee_prompt.py)
from evoflow.proactive.employee_prompt import (  # noqa: E402
    EMPLOYEE_CHAT_FRAME_CLOSE,
    EMPLOYEE_CHAT_FRAME_OPEN,
    EMPLOYEE_V2_CLOSE,
    EMPLOYEE_V2_OPEN,
    build_employee_chat_framing,
    build_employee_chat_system_prompt,
    build_employee_contract_block,
    build_employee_identity_block,
    build_employee_stance_block,
    is_employee_chat_session,
    resolve_employee_identity,
)


def _normalize_employee_agent_code(raw: str | None) -> str:
    from evoflow.proactive.employee_prompt import _normalize_employee_agent_code as _impl

    return _impl(raw)


_DISPATCH_ENV_MARKER = "### 用户派发任务"


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


def _memory_brief_without_work_log_echo(mem_summary: str, work_log: str) -> str:
    """Drop rejection echoes already covered by the work-log block."""
    text = str(mem_summary or "").strip()
    log = str(work_log or "")
    if not text:
        return ""
    if "[rejected]" not in log and "驳回原因" not in log and "timeout_rejected" not in log:
        return text
    kept: list[str] = []
    for block in text.split("\n"):
        if "用户驳回" in block:
            continue
        kept.append(block)
    # Drop empty section headers left behind (e.g. 「近期观察：」 with no bullets).
    out: list[str] = []
    i = 0
    while i < len(kept):
        line = kept[i]
        if line.endswith("：") and (i + 1 >= len(kept) or not kept[i + 1].strip().startswith("-")):
            i += 1
            continue
        out.append(line)
        i += 1
    cleaned = "\n".join(out).strip()
    return cleaned if cleaned and "暂无" not in cleaned else ""


def build_user_prompt(
    role: ProactiveRole,
    memory: ProactiveMemory,
    environment_context: str = "",
    *,
    work_log: str = "",
    task_board: str = "",
) -> str:
    """Compact duty briefing. Dispatch goal leads; empty sections omitted."""
    try:
        from evoflow.agents.xiaomi.duty import build_xiaomi_duty_user_prompt
        from evoflow.agents.xiaomi.identity import is_xiaomi_agent

        if is_xiaomi_agent(role.agent_code):
            return build_xiaomi_duty_user_prompt(
                role,
                environment_context=environment_context,
                task_board=task_board,
                work_log=work_log,
            )
    except Exception:
        pass

    env = str(environment_context or "").strip()
    has_dispatch = _DISPATCH_ENV_MARKER in env
    log = str(work_log or "").strip()
    board = str(task_board or "").strip()
    empty_log = (not log) or ("暂无历史" in log and "首次上岗" in log)
    empty_board = (not board) or ("暂无未结" in board)
    mem_summary = _memory_brief_without_work_log_echo(memory.summary(max_items=8), log)
    empty_mem = (not mem_summary) or ("暂无" in mem_summary)

    parts: list[str] = [f"# 值班 · 「{role.role_name}」", ""]

    if has_dispatch:
        parts.append(env)
        parts.append("")
        parts.extend(
            [
                "## 本轮行动",
                "以**上方用户派发目标**为准，不要另选战场。",
                "按本岗职责推进：取证、做事、回写进度；干完就结案并写清验收要点。",
                "若 goal 是【下游回执】或点名已有 Task：只在该 ``task_id`` 上验收/续跑，**禁止新建**同名或回执单。",
                "需要直属下级继续 → 结案时填 handlers，交给系统派发；**禁止**对下级再 create+wake 同一次交接。",
                "对方 busy → 稍后用同一 related_task_id 重试，禁止改文案开新单。",
                "方案/报告类文档写到本岗交付目录；有实质产出再留下可观测进展，勿为交差硬写报告。",
                "结案用同事白话说明做了什么、结果如何、是否还需人拍板；不要复述 tasks/cancelled/id 语法（id 只写在工具参数里）。",
                "禁止「【巡检完成】/系统健康/无阻塞」交差腔——那是机房值班口吻，不是同事交班。",
            ]
        )
        if not empty_board:
            parts.extend(["", board])
        if not empty_log:
            parts.extend(["", "## 近况", log])
        if not empty_mem:
            parts.extend(["", "## 记忆摘要", mem_summary])
        return "\n".join(parts).strip() + "\n"

    if not empty_board:
        parts.extend([board, ""])
    if not empty_log:
        parts.extend(["## 近况", log, ""])
    if not empty_mem:
        parts.extend(["## 记忆摘要", mem_summary, ""])
    if env:
        parts.extend(["## 环境信号", env, ""])
    parts.extend(
        [
            "## 本轮行动",
            "对照职责与上方看板：有具体待办就推进；没有则结束本轮，不要空建单，也不要硬写「巡检完成」报告。",
            "做事时回写进度；干完结案；需要直属下级继续则在结案时填 handlers（禁止对下级 create+wake 同一次交接）。",
            "看上下文末尾的未结任务再动手；续跑已有单优先于新建。",
            "有实质工作才留下可观测进展；空班次不要用「系统健康 / 无阻塞 / Gateway 正常」向用户交差。",
            "结案用同事白话说明做了什么、结果如何、是否还需人拍板；不要复述 tasks/cancelled/id 语法（id 只写在工具参数里）。",
        ]
    )
    return "\n".join(parts).strip() + "\n"


def build_execution_prompt(
    initiative_title: str,
    initiative_description: str,
    action_plan: str,
    *,
    initiative_id: str = "",
) -> str:
    """User prompt for executing an approved initiative (legacy bridge)."""
    iid = str(initiative_id or "").strip()
    id_line = f"\n## 事项 / Task 关联\n`{iid}`\n" if iid else ""
    safe_title = initiative_title.replace('"', "")
    return f"""# 值班 · 自主执行（已审批）
{id_line}
## 标题
{initiative_title}

## 描述
{initiative_description}

## 计划
{action_plan}

## 行动
按计划执行；用岗位 Task 回写进度并结案。需要下游时指定处理人或叫醒对口岗。做完即可结束；标题参考：{safe_title}。
"""
