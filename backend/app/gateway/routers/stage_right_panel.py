"""右栏面板类型清单接口 —— 前端与模型共用同一份真源。

【self-evolution-bot · 2026-11-20 · 第87轮 · 模型:deepseek-v4.1-flash-1017】
改了什么：新增 GET /api/stage/right-stage/kinds，直接读
``evoflow.stage.right_panel_kinds``，把类型契约暴露给前端。
为什么：用户 2026-11-20 要求「前端跟后端架构不能是混乱的」。此前
「右栏支持哪些 kind / 每种必需什么字段」在前端（open-progress-from-panel-set.ts
逐个 if 校验）和后端（stage_tool._build_progress_surface 逐个 if 校验）各写一遍，
已经漂移（后端要 taskId、前端只查 agentCode）。现在只有后端一份，前端从这里取；
若取不到则退回本地默认表，保证离线/构建期不炸。
"""

from __future__ import annotations

from fastapi import APIRouter

router = APIRouter(prefix="/api/stage/right-stage", tags=["stage-right-panel"])


@router.get("/kinds")
def get_right_stage_kinds() -> dict:
    """返回右栏支持的面板类型、必需字段与触发语义。"""
    try:
        from evoflow.stage.right_panel_kinds import (
            AUTO_OPEN_ACTIONS,
            READ_ONLY_ACTIONS,
            kind_specs,
            should_auto_open,
        )

        kinds = [spec for spec in kind_specs() if spec.get("kind") != "artifacts"]
        return {
            "ok": True,
            "count": len(kinds),
            "kinds": kinds,
            "autoOpenActions": sorted(AUTO_OPEN_ACTIONS),
            "readOnlyActions": sorted(READ_ONLY_ACTIONS),
            # 示例便于前端/调试直接看到判据，不必重新推导
            "samples": {
                "tasks.list": should_auto_open("tasks.list"),
                "employees.wake": should_auto_open("employees.wake"),
            },
        }
    except Exception as exc:  # pragma: no cover - 契约表异常不应拖垮前端
        return {"ok": False, "error": str(exc), "kinds": []}
