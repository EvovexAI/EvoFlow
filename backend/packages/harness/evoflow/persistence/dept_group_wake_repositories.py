"""部门群聊叫醒队列（落库版）。

【self-evolution-bot · 2026-11-20 · 第88轮 · 模型:deepseek-v4.1-flash-1017】

## 为什么要有这个表

改造前，「@ 谁、排了几个人」这件事**只活在前端内存**（``HomeDeptGroupChat`` 的
``wakeQueueRef`` / ``DeptGroupWakeQueue``）。后果在现网真实可复现：

- 前端刷新 / 切部门 / 关页面 → 排队中的叫醒**全部消失**，用户看到「@ 了人，没回复」；
- 执行到一半的流式中断 → 该轮正文只剩半句，无法续跑；
- 没有任何持久记录，事后无法回答「这条消息到底叫醒了谁、为什么没回」。

落库后，页面重开可以从表里恢复未完成任务，进程崩溃也能靠心跳超时回收。

## 三条判据（都是踩过坑才写下的）

1. **``running`` 不等于「还活着」。** 前端崩溃会留下 status=running 的行，
   若只按状态判断，该 agent 的队头会被永久堵死。存活与否只看
   ``heartbeat_at`` 是否在 ``stale_after_s`` 窗口内（见 :func:`is_alive`）。
2. **合并判据用 ``goal_norm``，不用 ``goal``。** 与前端 ``normalizeWakeGoal``
   同口径（小写 + 折叠空白 + 截 160），否则「@ A 帮忙看下」和「@ A 帮忙看下 」
   在两端算出不同结论，一个说合并、一个说新建。
3. **同一 agent 在一个部门内串行。** :func:`claim_next` 只发放该 agent
   最老的一条 queued，且仅当没有存活 running 时才发——这是前端
   ``DeptGroupWakeQueue.pump`` 的「按人串行」语义，落库后必须保持一致。

所有时间列一律走 ``now_iso_z()``（北京时间 ISO），与 ``evoflow_chat_messages`` 同口径，
不做裸 ``datetime.now()``（第88轮镜像行就是被裸串坑过一次）。
"""

from __future__ import annotations

import logging
import re
import time
from typing import Any

from evoflow.persistence.timestamps import iso_z_to_ms, now_iso_z

logger = logging.getLogger(__name__)

# ── 状态机 ──────────────────────────────────────────────────────────────
STATUS_QUEUED = "queued"
STATUS_RUNNING = "running"
STATUS_DONE = "done"
STATUS_FAILED = "failed"
TERMINAL_STATUSES = (STATUS_DONE, STATUS_FAILED)

# 心跳存活窗口：超过这个时间没心跳的 running 视为「进程已死」，可被回收。
# 取 90s——前端单轮 LLM 回合常态 3~5s，90s 足够覆盖慢回合，又不至于让
# 崩溃后的队头堵太久。
DEFAULT_STALE_AFTER_S = 90

# 目标合并窗口：与前端 ``MERGE_WINDOW_MS``（8000ms）同口径。
MERGE_WINDOW_S = 8


def normalize_goal(goal: Any) -> str:
    """与前端 ``normalizeWakeGoal`` 逐字同口径。

    前端：``replace(/\\s+/g,' ').trim().toLowerCase().slice(0,160)``。
    两端必须算出同一个串，否则「合并 / 新建」两种结论会打架。
    """
    s = re.sub(r"\s+", " ", str(goal or "")).strip().lower()
    return s[:160]


def _row_to_job(row: Any, cols: list[str]) -> dict[str, Any] | None:
    if row is None:
        return None
    try:
        return {c: row[i] for i, c in enumerate(cols)}
    except Exception:
        return None


_JOB_COLUMNS = [
    "job_id",
    "dept_id",
    "agent_code",
    "role_name",
    "goal",
    "goal_norm",
    "depth",
    "chain_key",
    "steward_mode",
    "from_agent_name",
    "source_msg_id",
    "status",
    "attempts",
    "error",
    "owner",
    "enqueued_at",
    "started_at",
    "heartbeat_at",
    "updated_at",
]
_JOB_SELECT = ", ".join(_JOB_COLUMNS)


def enqueue_wake_job(
    *,
    job_id: str,
    dept_id: str,
    agent_code: str,
    role_name: str = "",
    goal: str = "",
    depth: int = 0,
    chain_key: str = "",
    steward_mode: bool = False,
    from_agent_name: str = "",
    source_msg_id: str = "",
) -> dict[str, Any]:
    """入队一条叫醒任务。**同 job_id 重复入队是幂等的**（前端重试不产生重复行）。

    ``job_id`` 由前端生成（``wake-{agent}-{seq}-{ts}``）：前端是叫醒意图的
    发起方，用它的 id 才能在断线重连后对回同一条任务。
    """
    from evoflow.persistence.db import get_db

    jid = str(job_id or "").strip()
    code = str(agent_code or "").strip()
    if not jid:
        raise ValueError("job_id is required")
    if not code:
        raise ValueError("agent_code is required")
    ts = now_iso_z()
    conn = get_db()
    conn.execute(
        """
        INSERT INTO evoflow_dept_group_wake_jobs
            (job_id, dept_id, agent_code, role_name, goal, goal_norm, depth,
             chain_key, steward_mode, from_agent_name, source_msg_id,
             status, attempts, error, owner,
             enqueued_at, started_at, heartbeat_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '', '', ?, '', '', ?)
        ON CONFLICT(job_id) DO NOTHING
        """,
        (
            jid,
            str(dept_id or "").strip(),
            code,
            str(role_name or "").strip(),
            str(goal or "").strip(),
            normalize_goal(goal),
            int(depth or 0),
            str(chain_key or "").strip(),
            1 if steward_mode else 0,
            str(from_agent_name or "").strip(),
            str(source_msg_id or "").strip(),
            STATUS_QUEUED,
            ts,
            ts,
        ),
    )
    conn.commit()
    job = get_wake_job(jid)
    return job or {}


def get_wake_job(job_id: str) -> dict[str, Any] | None:
    from evoflow.persistence.db import get_db

    row = get_db().execute(
        f"SELECT {_JOB_SELECT} FROM evoflow_dept_group_wake_jobs WHERE job_id = ?",
        (str(job_id or "").strip(),),
    ).fetchone()
    return _row_to_job(row, _JOB_COLUMNS)


def list_wake_jobs(
    *,
    dept_id: str = "",
    agent_code: str = "",
    statuses: tuple[str, ...] | list[str] | None = None,
    limit: int = 100,
) -> list[dict[str, Any]]:
    """按条件列任务（最新在前）。默认只列未终结的。"""
    from evoflow.persistence.db import get_db

    where: list[str] = []
    args: list[Any] = []
    if dept_id:
        where.append("dept_id = ?")
        args.append(str(dept_id).strip())
    if agent_code:
        where.append("agent_code = ?")
        args.append(str(agent_code).strip())
    st = tuple(statuses) if statuses else (STATUS_QUEUED, STATUS_RUNNING)
    if st:
        where.append(f"status IN ({','.join('?' for _ in st)})")
        args.extend(st)
    sql = f"SELECT {_JOB_SELECT} FROM evoflow_dept_group_wake_jobs"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY enqueued_at DESC, rowid DESC LIMIT ?"
    args.append(int(limit))
    rows = get_db().execute(sql, tuple(args)).fetchall()
    out = []
    for r in rows:
        j = _row_to_job(r, _JOB_COLUMNS)
        if j:
            out.append(j)
    return out


def is_alive(job: dict[str, Any] | None, *, stale_after_s: int = DEFAULT_STALE_AFTER_S) -> bool:
    """这条任务是否「真的」在跑。

    **不能只看 status == running**：前端崩溃/断线会留下永久的 running 行，
    只看状态就会让该 agent 的队头永久堵死。判据是心跳新鲜度。
    """
    if not job:
        return False
    if str(job.get("status") or "") != STATUS_RUNNING:
        return False
    hb = str(job.get("heartbeat_at") or "").strip() or str(job.get("started_at") or "").strip()
    if not hb:
        return False
    hb_ms = iso_z_to_ms(hb)
    if hb_ms <= 0:
        return False
    return (time.time() * 1000.0 - hb_ms) <= max(1, int(stale_after_s)) * 1000


def reclaim_stale_running(
    *, stale_after_s: int = DEFAULT_STALE_AFTER_S, limit: int = 200
) -> int:
    """把心跳超时的 running 行退回 queued（可重跑），返回回收条数。

    这是崩溃恢复的唯一入口：进程死了没人来改状态，只能靠这条把队头解开。
    """
    from evoflow.persistence.db import get_db

    conn = get_db()
    rows = conn.execute(
        f"SELECT {_JOB_SELECT} FROM evoflow_dept_group_wake_jobs "
        "WHERE status = ? ORDER BY enqueued_at ASC LIMIT ?",
        (STATUS_RUNNING, int(limit)),
    ).fetchall()
    reclaimed = 0
    ts = now_iso_z()
    for r in rows:
        job = _row_to_job(r, _JOB_COLUMNS)
        if not job or is_alive(job, stale_after_s=stale_after_s):
            continue
        conn.execute(
            "UPDATE evoflow_dept_group_wake_jobs "
            "SET status = ?, error = ?, owner = '', heartbeat_at = '', updated_at = ? "
            "WHERE job_id = ? AND status = ?",
            (STATUS_QUEUED, "心跳超时回收", ts, job["job_id"], STATUS_RUNNING),
        )
        reclaimed += 1
    if reclaimed:
        conn.commit()
        logger.info("dept wake: reclaimed %d stale running job(s)", reclaimed)
    return reclaimed


def mark_running(job_id: str) -> bool:
    """标记「已开始跑」：``queued → running``，并刷新心跳。

    【self-evolution-bot · 2026-11-20 · 第88轮 · 模型:deepseek-v4.1-flash-1017】

    **为什么这个函数是必须的**：前端队列状态变迁里 ``running`` 是最常出现的一档
    （每一轮都会进），但它既不是终态、也不是新入队。先前路由把一切非 requeue 的
    状态都丢给 :func:`finish_wake_job`，而后者只收终态 → 抛 ValueError → **HTTP 500**。
    后果有两层：① 网关日志每轮刷一条 500；② 「这轮已经开始跑」这个事实根本没落库，
    心跳没有对象，崩溃后分不清「还没跑」和「跑到一半死了」。

    与 :func:`claim_next` 的分工：claim 是**恢复时抢锁**（带同人串行检查，拿不到就返回
    None）；本函数是**执行方如实登记**（幂等，不判串行）。两者不重叠。
    ``done``/``failed`` 不会被拖回 ``running``——终态不可逆。
    """
    from evoflow.persistence.db import get_db

    conn = get_db()
    ts = now_iso_z()
    cur = conn.execute(
        "UPDATE evoflow_dept_group_wake_jobs "
        "SET status = ?, heartbeat_at = ?, updated_at = ?, "
        "started_at = CASE WHEN started_at = '' THEN ? ELSE started_at END "
        "WHERE job_id = ? AND status IN (?, ?)",
        (STATUS_RUNNING, ts, ts, ts, str(job_id or "").strip(), STATUS_QUEUED, STATUS_RUNNING),
    )
    conn.commit()
    return getattr(cur, "rowcount", 0) > 0


def claim_next(
    *,
    dept_id: str,
    agent_code: str,
    owner: str = "",
    stale_after_s: int = DEFAULT_STALE_AFTER_S,
) -> dict[str, Any] | None:
    """认领该 agent 在该部门里最老的一条 queued 任务。

    **同一 agent 串行**：若已有存活 running，返回 None（排队等它跑完）。
    这与前端 ``DeptGroupWakeQueue.pump`` 语义一致，落库后不能变宽松，
    否则同一个人会并行两轮、在群里说两遍。
    """
    from evoflow.persistence.db import get_db

    conn = get_db()
    code = str(agent_code or "").strip()
    did = str(dept_id or "").strip()
    if not code:
        return None

    running = list_wake_jobs(
        dept_id=did, agent_code=code, statuses=(STATUS_RUNNING,), limit=20
    )
    if any(is_alive(j, stale_after_s=stale_after_s) for j in running):
        return None

    rows = conn.execute(
        f"SELECT {_JOB_SELECT} FROM evoflow_dept_group_wake_jobs "
        "WHERE status = ? AND agent_code = ? AND dept_id = ? "
        "ORDER BY enqueued_at ASC, rowid ASC LIMIT 1",
        (STATUS_QUEUED, code, did),
    ).fetchall()
    if not rows:
        return None
    job = _row_to_job(rows[0], _JOB_COLUMNS)
    if not job:
        return None
    ts = now_iso_z()
    cur = conn.execute(
        "UPDATE evoflow_dept_group_wake_jobs "
        "SET status = ?, attempts = attempts + 1, started_at = ?, "
        "heartbeat_at = ?, owner = ?, updated_at = ? "
        "WHERE job_id = ? AND status = ?",
        (STATUS_RUNNING, ts, ts, str(owner or "").strip(), ts, job["job_id"], STATUS_QUEUED),
    )
    conn.commit()
    # 抢锁失败（0 行）= 被别人先认领了，本次不发
    if getattr(cur, "rowcount", 0) == 0:
        return None
    return get_wake_job(job["job_id"])


def heartbeat(job_id: str) -> bool:
    """续心跳。长回合必须定期调，否则会被当成死进程回收。"""
    from evoflow.persistence.db import get_db

    conn = get_db()
    ts = now_iso_z()
    cur = conn.execute(
        "UPDATE evoflow_dept_group_wake_jobs SET heartbeat_at = ?, updated_at = ? "
        "WHERE job_id = ? AND status = ?",
        (ts, ts, str(job_id or "").strip(), STATUS_RUNNING),
    )
    conn.commit()
    return getattr(cur, "rowcount", 0) > 0


def finish_wake_job(
    job_id: str, *, status: str = STATUS_DONE, error: str = ""
) -> bool:
    """落终态。只允许 queued/running → done/failed（终态不回收）。"""
    from evoflow.persistence.db import get_db

    st = str(status or "").strip()
    if st not in TERMINAL_STATUSES:
        raise ValueError(f"not a terminal status: {st!r}")
    conn = get_db()
    ts = now_iso_z()
    cur = conn.execute(
        "UPDATE evoflow_dept_group_wake_jobs "
        "SET status = ?, error = ?, heartbeat_at = '', updated_at = ? "
        "WHERE job_id = ? AND status IN (?, ?)",
        (st, str(error or ""), ts, str(job_id or "").strip(), STATUS_QUEUED, STATUS_RUNNING),
    )
    conn.commit()
    return getattr(cur, "rowcount", 0) > 0


def requeue_for_retry(
    job_id: str, *, error: str = "", stale_after_s: int = DEFAULT_STALE_AFTER_S
) -> bool:
    """退回队列重试（对方忙）。attempts 已在 claim 时 +1，这里不再加。"""
    from evoflow.persistence.db import get_db

    conn = get_db()
    ts = now_iso_z()
    cur = conn.execute(
        "UPDATE evoflow_dept_group_wake_jobs "
        "SET status = ?, error = ?, owner = '', heartbeat_at = '', updated_at = ? "
        "WHERE job_id = ? AND status = ? AND attempts < ?",
        (STATUS_QUEUED, str(error or ""), ts, str(job_id or "").strip(), STATUS_RUNNING, 4),
    )
    conn.commit()
    return getattr(cur, "rowcount", 0) > 0


def find_mergeable(
    *,
    dept_id: str,
    agent_code: str,
    goal: str,
    window_s: int = MERGE_WINDOW_S,
) -> dict[str, Any] | None:
    """短窗口内同人近似目标的排队/执行中任务（供前端决定合并而非新建）。

    与前端 ``MERGE_WINDOW_MS`` 同口径：执行中的一轮常态远超 8s，
    期间重复 @ 必须并入本轮，否则会重复回复、重复计费。
    """
    jobs = list_wake_jobs(
        dept_id=dept_id,
        agent_code=agent_code,
        statuses=(STATUS_QUEUED, STATUS_RUNNING),
        limit=20,
    )
    target = normalize_goal(goal)
    if not target:
        return None
    now_ms = time.time() * 1000.0
    for j in jobs:
        if str(j.get("goal_norm") or "") != target:
            continue
        # 执行中的不设窗口（一轮可能很久），排队的按窗口合并
        if str(j.get("status") or "") == STATUS_RUNNING:
            return j
        enq = iso_z_to_ms(str(j.get("enqueued_at") or ""))
        if enq > 0 and (now_ms - enq) <= max(1, int(window_s)) * 1000:
            return j
    return None
