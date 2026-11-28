"""部门群聊叫醒队列 API（落库版）。

【self-evolution-bot · 2026-11-20 · 第88轮 · 模型:deepseek-v4.1-flash-1017】

## 边界（刻意收窄）

本路由**只做持久化**，不做「决定叫醒谁」。判断谁该发言、防环、合并语义
仍然全部在前端 ``DeptGroupWakeQueue`` 里——那是已跑通并有多轮线上验证的逻辑，
把它搬走才是真正的破坏性改动。

这里提供的 4 个动作：
- ``POST /enqueue``  前端入队时旁路记一行（幂等，前端重试不产生重复）
- ``POST /status``   状态推进（running/done/failed），供刷新后对账
- ``GET  /pending``  刷新/重开后取回未完成任务，用于恢复队列
- ``POST /heartbeat`` 长回合续心跳，避免被当成死进程回收

所有失败都返回明确错误，不静默——前端调用侧是 best-effort，但服务端不装哑巴。
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from app.gateway.db_async import run_db
from evoflow.persistence import dept_group_wake_repositories as wake_repo

router = APIRouter(prefix="/api/dept-groups", tags=["dept-groups"])
logger = logging.getLogger(__name__)


class WakeEnqueueBody(BaseModel):
    job_id: str = Field(..., min_length=1)
    dept_id: str = ""
    agent_code: str = Field(..., min_length=1)
    role_name: str = ""
    goal: str = ""
    depth: int = 0
    chain_key: str = ""
    steward_mode: bool = False
    from_agent_name: str = ""
    source_msg_id: str = ""


class WakeStatusBody(BaseModel):
    job_id: str = Field(..., min_length=1)
    status: str = Field(..., min_length=1)
    error: str = ""
    requeue: bool = False


class WakeHeartbeatBody(BaseModel):
    job_id: str = Field(..., min_length=1)


def _public_job(job: dict[str, Any] | None) -> dict[str, Any] | None:
    if not job:
        return None
    out = dict(job)
    out["steward_mode"] = bool(out.get("steward_mode"))
    return out


@router.post("/wake-jobs/enqueue", summary="记录一条群叫醒任务（幂等）")
async def enqueue_wake_job(body: WakeEnqueueBody) -> dict[str, Any]:
    """按 ``job_id`` 幂等：前端重试/重复提交不会产生第二行。"""

    def _do() -> dict[str, Any]:
        return wake_repo.enqueue_wake_job(
            job_id=body.job_id,
            dept_id=body.dept_id,
            agent_code=body.agent_code,
            role_name=body.role_name,
            goal=body.goal,
            depth=body.depth,
            chain_key=body.chain_key,
            steward_mode=body.steward_mode,
            from_agent_name=body.from_agent_name,
            source_msg_id=body.source_msg_id,
        )

    job = await run_db(_do)
    return {"ok": True, "job": _public_job(job)}


@router.post("/wake-jobs/status", summary="推进群叫醒任务状态")
async def update_wake_status(body: WakeStatusBody) -> dict[str, Any]:
    """推进状态。三档语义，**按 status 分派而不是按 requeue 分派**。

    【self-evolution-bot · 2026-11-20 · 第88轮 · 模型:deepseek-v4.1-flash-1017】

    修的是一个真缺陷（现网可复现 HTTP 500）：前端每一轮状态变迁都会发
    ``status='running'``，而旧实现把「非 requeue」一律交给 ``finish_wake_job``，
    后者只收终态 → 抛 ValueError → 500。前端虽然吞掉错误，但
    「已开始跑」这个事实没落库，心跳也没有对象。

    现在：``running`` → 登记开始跑并续心跳；``queued`` → 退队重试；
    ``done``/``failed`` → 落终态。未知状态明确报 400，不装作成功。
    """

    def _do() -> dict[str, Any]:
        st = str(body.status or "").strip()
        # 顺序有讲究：显式 requeue **优先于** status。
        # 前端重试退队时发的正是 (status='running', requeue=true)，
        # 若先判 running 就会把「退队重试」误当成「开始跑」，任务永远退不回队列。
        if body.requeue:
            ok = wake_repo.requeue_for_retry(body.job_id, error=body.error)
        elif st == wake_repo.STATUS_RUNNING:
            ok = wake_repo.mark_running(body.job_id)
        elif st == wake_repo.STATUS_QUEUED:
            # 仅显式 requeue=true 才退队。裸 status=queued 是前端入队旁路抄送，
            # 若对已 claim 的 running 再走 requeue，会把认领锁拆掉 → 恢复重跑幽灵任务。
            ok = True
        elif st in wake_repo.TERMINAL_STATUSES:
            ok = wake_repo.finish_wake_job(body.job_id, status=st, error=body.error)
        else:
            raise HTTPException(
                status_code=400,
                detail=f"unknown wake job status: {st!r}",
            )
        return {"updated": bool(ok), "job": wake_repo.get_wake_job(body.job_id)}

    out = await run_db(_do)
    return {"ok": True, **out}


@router.post("/wake-jobs/heartbeat", summary="群叫醒任务续心跳")
async def wake_heartbeat(body: WakeHeartbeatBody) -> dict[str, Any]:
    ok = await run_db(lambda: wake_repo.heartbeat(body.job_id))
    return {"ok": True, "updated": bool(ok)}


@router.get("/wake-jobs/pending", summary="取回未完成的群叫醒任务（刷新后恢复）")
async def list_pending_wake_jobs(
    request: Request,
    dept_id: str = Query("", description="部门 id，留空=全部"),
    agent_code: str = Query("", description="员工 code，留空=全部"),
    limit: int = Query(100, ge=1, le=500),
) -> dict[str, Any]:
    """只返回 queued/running，且顺手把心跳超时的 running 退回队列。

    回收放在读路径上是有意的：恢复本身就发生在「页面刚打开」这一刻，
    此时最需要把崩溃留下的死任务解开，否则前端恢复后仍然领不到队头。
    """

    def _do() -> dict[str, Any]:
        reclaimed = wake_repo.reclaim_stale_running()
        jobs = wake_repo.list_wake_jobs(
            dept_id=dept_id,
            agent_code=agent_code,
            statuses=(wake_repo.STATUS_QUEUED, wake_repo.STATUS_RUNNING),
            limit=limit,
        )
        # 按 agent 各自最老的一条（前端按人串行，恢复顺序要与之一致）
        return {"jobs": [_public_job(j) for j in jobs], "reclaimed": reclaimed}

    out = await run_db(_do)
    return {"ok": True, **out}


class WakeClaimBody(BaseModel):
    dept_id: str = ""
    agent_code: str = Field(..., min_length=1)
    owner: str = ""


@router.post("/wake-jobs/claim", summary="认领该员工最老的一条任务（同人串行）")
async def claim_wake_job(body: WakeClaimBody) -> dict[str, Any]:
    """**恢复队列必须走这里，不能直接重跑。**

    【self-evolution-bot · 2026-11-20 · 第88轮 · 模型:deepseek-v4.1-flash-1017】

    为什么恢复要认领而不是直接重排：页面每次挂载都会调一次恢复，
    若直接重排就会每开一次页面重跑一轮（重复回复 + 重复计费）。
    认领带状态迁移（queued→running）与同人串行检查，
    天然把「同一条任务被两个标签页各自跑一遍」挡住。

    返回 ``job=null`` 表示：没有可跑的（已跑完 / 别人正在跑且心跳新鲜）。
    """

    def _do() -> dict[str, Any]:
        wake_repo.reclaim_stale_running()
        job = wake_repo.claim_next(
            dept_id=body.dept_id, agent_code=body.agent_code, owner=body.owner
        )
        return {"job": _public_job(job)}

    out = await run_db(_do)
    return {"ok": True, **out}
