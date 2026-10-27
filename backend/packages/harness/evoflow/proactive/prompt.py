"""Proactive duty user/execution prompts + thin duty system wrapper.

Employee **system** prompt SSOT: ``evoflow.proactive.employee_prompting``.
``build_system_prompt`` → ``assemble_employee_system_prompt(mode=\"duty\")``.
"""

from __future__ import annotations

from typing import Any

from evoflow.proactive.employee_prompting.assemble import (
    DUTY_BRIEF_CLOSE,
    DUTY_BRIEF_OPEN,
    DUTY_CONTRACT_MARKER,
    assemble_employee_system_prompt,
)
from evoflow.proactive.employee_prompting.duty_extras import (
    ROLE_DUTY_PROMPT_EXTRAS,
    ROLE_DUTY_SKILL_DEFAULTS,
    build_duty_skills_section,
    build_role_duty_prompt_extras,
    build_standard_workflow_section,
    resolve_role_duty_skills,
)
from evoflow.proactive.employee_prompting.org_section import (
    ORG_CLOSE as ORG_CHART_CLOSE,
    ORG_OPEN as ORG_CHART_OPEN,
    build_collab_rules_section,
    build_org_collab_section,
    build_org_system_section,
)
from evoflow.proactive.models import (
    ProactiveMemory,
    ProactiveRole,
)

__all__ = [
    "DUTY_BRIEF_CLOSE",
    "DUTY_BRIEF_OPEN",
    "DUTY_CONTRACT_MARKER",
    "ORG_CHART_CLOSE",
    "ORG_CHART_OPEN",
    "ROLE_DUTY_PROMPT_EXTRAS",
    "ROLE_DUTY_SKILL_DEFAULTS",
    "build_collab_rules_section",
    "build_duty_skills_section",
    "build_execution_prompt",
    "build_org_collab_section",
    "build_org_system_section",
    "build_role_duty_prompt_extras",
    "build_standard_workflow_section",
    "build_system_prompt",
    "build_user_prompt",
    "compose_proactive_system_message",
    "normalize_knowledge_vault_ids",
    "resolve_role_duty_skills",
    "validate_agent_knowledge_ids",
    "wrap_proactive_duty_system_section",
]


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


def validate_agent_knowledge_ids(ids: list[str]) -> list[str]:
    """Validate agent-bound knowledge ids against owned knowledge bases."""
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
    if known:
        missing = [vid for vid in cleaned if vid not in known]
        if missing:
            raise ValueError("未知知识库 id: " + ", ".join(missing))
    return cleaned


def build_system_prompt(
    role: ProactiveRole,
    *,
    roster: list[ProactiveRole] | None = None,
    query: str = "",
) -> str:
    """Duty system prompt — shared employee skeleton (mode=duty)."""
    return assemble_employee_system_prompt(
        mode="duty",
        role=role,
        roster=roster,
        query=query,
    )


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
            "你正在「智能体员工」值班。以岗位 Task 为唯一账本：有待办就推进并结案；"
            "需要下游时在结案里指定处理人；无待办则不建单。"
        )
    return f"""{DUTY_BRIEF_OPEN}
# 智能体员工 · 值班

【主动上岗】以下即完整 system 纪律。

{body}
{DUTY_BRIEF_CLOSE}
"""


def compose_proactive_system_message(duty_prompt: str) -> str:
    return wrap_proactive_duty_system_section(duty_prompt).strip() + "\n"


def _normalize_employee_agent_code(raw: str | None) -> str:
    from evoflow.proactive.employee_prompting import normalize_employee_agent_code

    return normalize_employee_agent_code(raw)


_DISPATCH_ENV_MARKER = "### 用户派发任务"


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
                "按本岗职责推进：取证、做事；干完直接结案并写清验收要点。中间 progress 可选，写不了就跳过，勿为空转。",
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
            "干完直接结案；中间 progress 可选。需要直属下级继续则结案时填 handlers（禁止对下级 create+wake 同一次交接）。",
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
按计划执行；干完直接结案（progress 可选）。需要下游时指定处理人或叫醒对口岗。做完即可结束；标题参考：{safe_title}。
"""
