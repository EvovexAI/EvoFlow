"""Tool: proactive employees look up their own work history during think loops.
"""
from __future__ import annotations

import json
import logging
from typing import Any

from langchain.tools import ToolRuntime, tool

logger = logging.getLogger(__name__)

proactive_history_ui_metadata = {
    "group": "builtin",
    "label": "员工工作记录查询",
    "icon": "📋",
    "description": "智能体员工查询自己的工作历史和事项记录（上岗前先翻工作日志）。",
}

@tool("proactive_history", parse_docstring=True)
def proactive_history_tool(
    runtime: ToolRuntime,
    action: str,
    initiative_id: str | None = None,
    round_id: str | None = None,
    status: str | None = None,
    limit: int = 10,
) -> str:
    """查询你自己的历史工作记录。

    Args:
        action: list|detail|round
        initiative_id: detail 时必填
        round_id: round 时选填
        status: 可选状态筛选
        limit: 返回条数上限 (1-30)
    """
    from evoflow.agents.automation_runtime import triggered_by_proactive
    from evoflow.agents.lead_agent.runtime_context import runtime_context_mapping
    ctx = runtime_context_mapping(runtime) if runtime is not None else {}
    if not triggered_by_proactive(ctx):
        sk = str(ctx.get("session_key") or "")
        if not sk.startswith("proactive:"):
            return json.dumps({"ok": False, "error": "proactive_history 仅用于智能体员工上岗期间"}, ensure_ascii=False)

    code = str(ctx.get("proactive_agent_code") or "").strip()
    if not code:
        return json.dumps({"ok": False, "error": "缺少 proactive_agent_code"}, ensure_ascii=False)

    from evoflow.proactive.repositories import ProactiveRepository
    act = str(action or "").strip().lower()

    if act == "list":
        kwargs = {"role_agent_code": code, "limit": limit}
        if status:
            kwargs["status"] = str(status).strip()
        initiatives = ProactiveRepository.list_initiatives(**kwargs)
        if not initiatives:
            return json.dumps({"ok": True, "action": "list", "count": 0, "summary": "暂无历史记录"}, ensure_ascii=False)
        lines = [f"\U0001f4cb 最近 {len(initiatives)} 条工作记录："]
        for i, init in enumerate(initiatives, 1):
            d = _initiative_to_dict(init)
            lines.append(f"\n{i}. {_fmt_initiative(d)}")
        return json.dumps({"ok": True, "action": "list", "count": len(initiatives), "summary": "\n".join(lines)}, ensure_ascii=False)

    elif act == "detail":
        iid = str(initiative_id or "").strip()
        if not iid:
            return json.dumps({"ok": False, "error": "detail 模式需要 initiative_id"}, ensure_ascii=False)
        initiative = ProactiveRepository.get_initiative(iid)
        if not initiative:
            return json.dumps({"ok": False, "error": f"事项 {iid} 不存在"}, ensure_ascii=False)
        if initiative.role_agent_code != code:
            return json.dumps({"ok": False, "error": "该事项不属于你的角色"}, ensure_ascii=False)
        d = _initiative_to_dict(initiative)
        lines = [_fmt_initiative(d)]
        lines.append(f"\n**描述**: {initiative.description or chr(8212)}")
        lines.append(f"\n**依据**: {initiative.rationale or chr(8212)}")
        lines.append(f"\n**预期效果**: {initiative.expected_outcome or chr(8212)}")
        if initiative.round_id:
            lines.append(f"\n**上岗轮次**: {initiative.round_id}")
        if initiative.goal:
            lines.append(f"\n**上岗目标**: {initiative.goal}")
        if initiative.outcome:
            lines.append(f"\n**上岗结果**: {initiative.outcome}")
        if initiative.execution_result:
            lines.append(f"\n**执行结果**: {initiative.execution_result[:2000]}")
        return json.dumps({"ok": True, "action": "detail", "initiative": d, "summary": "\n".join(lines)}, ensure_ascii=False)

    elif act == "round":
        rid = str(round_id or "").strip()
        kwargs = {"role_agent_code": code, "limit": limit}
        if rid:
            kwargs["round_id"] = rid
        if status:
            kwargs["status"] = str(status).strip()
        initiatives = ProactiveRepository.list_initiatives(**kwargs)
        if not initiatives:
            return json.dumps({"ok": True, "action": "round", "count": 0, "summary": "无记录"}, ensure_ascii=False)
        label = f"上岗轮次 {rid}" if rid else "最近记录"
        lines = [f"\U0001f4cb {label}（共 {len(initiatives)} 条）："]
        for i, init in enumerate(initiatives, 1):
            d = _initiative_to_dict(init)
            lines.append(f"\n{i}. {_fmt_initiative(d)}")
        return json.dumps({"ok": True, "action": "round", "round_id": rid, "count": len(initiatives), "summary": "\n".join(lines)}, ensure_ascii=False)

    return json.dumps({"ok": False, "error": f"未知 action: {action}"}, ensure_ascii=False)


STATUS_EMOJI = {
    "proposed": "💡", "pending_approval": "🕐", "approved": "👍",
    "rejected": "🚫", "executing": "⏳", "completed": "✅",
    "failed": "❌", "timeout_rejected": "⌛", "skipped": "⏭️",
}
RISK_EMOJI = {"low": "🟢", "medium": "🟡", "high": "🟠", "critical": "🔴"}

def _fmt_initiative(d: dict) -> str:
    status = str(d.get("status") or "?")
    risk = str(d.get("risk_level") or "low")
    emoji = STATUS_EMOJI.get(status, chr(8226))
    risk_icon = RISK_EMOJI.get(risk, "⚪")
    title = str(d.get("title") or "?")
    init_id = str(d.get("id") or "")
    result = d.get("execution_result") or ""
    parts = [f"{emoji} [{status}] {risk_icon} {title}"]
    parts.append(f"    ID: `{init_id}`")
    if result:
        summary = result[:200].replace("\n", " ")
        parts.append(f"    执行结果: {summary}" + ("..." if len(result) > 200 else ""))
    d.get("goal") and parts.append(f"    上岗目标: {d.get("goal")[:120]}")
    return "\n".join(parts)


def _initiative_to_dict(init) -> dict[str, Any]:
    return {
        "id": init.id,
        "role_agent_code": init.role_agent_code,
        "title": init.title,
        "description": init.description,
        "rationale": init.rationale,
        "action_type": init.action_type.value if hasattr(init.action_type, "value") else str(init.action_type),
        "risk_level": init.risk_level.value if hasattr(init.risk_level, "value") else str(init.risk_level),
        "status": init.status.value if hasattr(init.status, "value") else str(init.status),
        "execution_result": init.execution_result,
        "round_id": init.round_id,
        "goal": init.goal,
        "outcome": init.outcome,
        "created_at": init.created_at,
        "updated_at": init.updated_at,
    }
