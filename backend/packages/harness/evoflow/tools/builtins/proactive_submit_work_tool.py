"""Tool: proactive employees submit work-log / initiatives via structured args."""

from __future__ import annotations

import json
import logging
from typing import Any

from langchain.tools import ToolRuntime, tool
from langgraph.typing import ContextT
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

proactive_submit_work_ui_metadata = {
    "group": "builtin",
    "label": "员工上岗汇报",
    "icon": "🗂️",
    "description": "智能体员工开工/进度/交班必须调用：写入工作日志、新建或更新事项。纯文字无效。",
}


class ProactiveInitiativeDraft(BaseModel):
    """One proposed work item for the employee work log."""

    title: str = Field(..., description="事项标题（简短）")
    description: str = Field("", description="做什么、为什么做")
    rationale: str = Field("", description="依据与证据")
    action_type: str = Field(
        "analysis",
        description="code_change|analysis|report|task_delegation|alert|optimization",
    )
    risk_level: str = Field("low", description="low|medium|high|critical")
    expected_outcome: str = Field("", description="预期效果")
    steps: list[str] = Field(default_factory=list, description="可执行步骤")
    target_files: list[str] = Field(default_factory=list, description="相关路径")


class ProactiveInitiativeUpdate(BaseModel):
    """Update an existing open initiative (by id preferred, else title)."""

    initiative_id: str = Field("", description="已有事项 id（工作日志里会给出）")
    title: str = Field("", description="若无 id，用精确标题匹配")
    status: str = Field(
        "",
        description="可选：executing|completed|failed|proposed|skipped",
    )
    progress_note: str = Field("", description="进度说明（会追加到事项）")
    execution_result: str = Field("", description="本阶段执行结果摘要")


def _runtime_cfg(runtime: ToolRuntime[ContextT, dict] | None) -> dict[str, Any]:
    cfg: dict[str, Any] = {}
    if runtime is None:
        return cfg
    ctx = getattr(runtime, "context", None)
    if isinstance(ctx, dict):
        cfg.update(ctx)
    elif ctx is not None and hasattr(ctx, "get"):
        try:
            cfg.update(dict(ctx))  # type: ignore[arg-type]
        except Exception:
            pass
    try:
        from langgraph.config import get_config

        conf = (get_config() or {}).get("configurable") or {}
        if isinstance(conf, dict):
            cfg = {**conf, **cfg}
    except Exception:
        pass
    rc = getattr(runtime, "config", None)
    if isinstance(rc, dict):
        conf2 = rc.get("configurable") or {}
        if isinstance(conf2, dict):
            cfg = {**conf2, **cfg}
    return cfg


def _resolve_agent_code(cfg: dict[str, Any]) -> str:
    code = str(cfg.get("proactive_agent_code") or "").strip()
    if code:
        return code
    sk = str(cfg.get("session_key") or "").strip()
    if sk.startswith("proactive:"):
        return sk.split(":", 1)[1].strip()
    return ""


def _dump_models(items: list[Any] | None) -> list[Any]:
    drafts: list[Any] = []
    if not items:
        return drafts
    for item in items:
        if hasattr(item, "model_dump"):
            drafts.append(item.model_dump())
        elif isinstance(item, dict):
            drafts.append(item)
    return drafts


@tool("proactive_submit_work", parse_docstring=True)
def proactive_submit_work_tool(
    runtime: ToolRuntime[ContextT, dict],
    goal: str = "",
    outcome: str = "",
    reflection: str = "",
    observations: list[str] | None = None,
    initiatives: list[ProactiveInitiativeDraft] | None = None,
    initiative_updates: list[ProactiveInitiativeUpdate] | None = None,
    phase: str = "wrap_up",
) -> str:
    """智能体员工**必须用此工具**写工作日志（聊天正文不会入库）。

    至少两段式汇报：
    1) phase=`check_in`：开工——写清本轮 goal（尚未深挖也可）
    2) phase=`wrap_up`：交班——写 outcome/reflection，并可提出 initiatives
    中途可用 phase=`progress` + initiative_updates 更新事项进度/完成状态。

    Args:
        goal: 本轮上岗目标（开工时必填）。
        outcome: 本轮结果总结（交班时填写）。
        reflection: 反思与下次关注点。
        observations: 本轮关键观察列表。
        initiatives: 新发起的事项；无待办时传空列表。
        initiative_updates: 更新已有事项（id 或标题 + status/progress_note）。
        phase: check_in | progress | wrap_up。
    """
    from evoflow.agents.automation_runtime import triggered_by_proactive
    from evoflow.proactive.submit_work import apply_proactive_submit_work

    cfg = _runtime_cfg(runtime)
    if not triggered_by_proactive(cfg) and not str(cfg.get("proactive_process") or "").strip():
        sk = str(cfg.get("session_key") or "")
        if not sk.startswith("proactive:"):
            return json.dumps(
                {"ok": False, "error": "proactive_submit_work 仅用于智能体员工上岗"},
                ensure_ascii=False,
            )

    code = _resolve_agent_code(cfg)
    round_id = str(cfg.get("round_id") or "").strip()
    # Execute path may only have initiative_id — still allow progress/wrap via role's open round
    if not round_id:
        round_id = str(cfg.get("proactive_round_id") or "").strip()
    if not code:
        return json.dumps(
            {"ok": False, "error": "缺少 proactive_agent_code（检查上岗运行配置）"},
            ensure_ascii=False,
        )
    if not round_id:
        # Fallback for execute-only: synthesis round keyed by initiative
        iid = str(cfg.get("proactive_initiative_id") or cfg.get("initiative_id") or "").strip()
        if iid:
            round_id = f"exec:{iid}"
        else:
            return json.dumps(
                {"ok": False, "error": "缺少 round_id（检查上岗运行配置）"},
                ensure_ascii=False,
            )

    result = apply_proactive_submit_work(
        role_agent_code=code,
        round_id=round_id,
        goal=goal,
        outcome=outcome,
        reflection=reflection,
        observations=observations,
        initiatives=_dump_models(initiatives),
        initiative_updates=_dump_models(initiative_updates),
        phase=phase,
    )
    return json.dumps(result, ensure_ascii=False)
