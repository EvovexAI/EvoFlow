from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query, Request

from app.gateway.hang_diagnostics import dump_gateway_diagnostics
from evoflow.authz.http_guard import require_org_admin


def _org_admin_dep(request: Request) -> None:
    require_org_admin(request)


router = APIRouter(prefix="/api/debug/hang-diagnostics", tags=["debug"], dependencies=[Depends(_org_admin_dep)])


@router.post("/dump")
async def dump_hang_diagnostics(reason: str = Query(default="manual")) -> dict[str, str | bool]:
    path = dump_gateway_diagnostics(reason=f"manual:{reason}")
    if path is None:
        return {"ok": False, "detail": "diagnostics disabled or dump suppressed by min interval"}
    return {"ok": True, "path": str(path)}


# 【self-evolution-bot · 2026-11-19 · 第69轮 · 模型:deepseek-v4.1-flash-1017】
# DATA 车道闸门的实时读数。此前 `_data_overflow` 只存在于进程内存里，
# 没有任何出口 → 「上限有没有真的在削峰」无从验收（本岗反复踩的
# 「检测器不接出口」同一类缺陷）。这里给一个随时可读的 GET，
# 不必等到 hang dump 落盘才能看到 overflow。
@router.get("/traffic-lanes")
async def traffic_lane_snapshot() -> dict[str, Any]:
    """Live DATA/other lane gate counters: inflight, limit, overflow, wait budget."""
    from app.gateway.traffic_lanes import data_lane_snapshot, data_lane_wait_s

    snap = data_lane_snapshot()
    snap["wait_ms"] = round(data_lane_wait_s() * 1000.0, 1)
    snap["ok"] = True
    return snap
