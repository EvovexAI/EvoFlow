"""ZCode 式 v4 目标模式：goal_engine 状态机 + 仓储 + hub 命令面。"""

from __future__ import annotations

import asyncio
import os
import tempfile
from pathlib import Path
from typing import Any

import pytest


# ── DB 隔离（对齐 test_chat_session_create_takeover_guard 的 env 法） ─────────


@pytest.fixture()
def goal_db(monkeypatch: pytest.MonkeyPatch) -> str:
    tmp = tempfile.TemporaryDirectory(prefix="evoflow-v4-goal-")
    db_path = str(Path(tmp.name) / "evoflow.db")
    prev = os.environ.get("EVOFLOW_DB_PATH")
    prev_storage = os.environ.get("EVOFLOW_STORAGE_SQLITE_PATH")
    monkeypatch.setenv("EVOFLOW_DB_PATH", db_path)
    monkeypatch.setenv("EVOFLOW_STORAGE_SQLITE_PATH", db_path)
    # db.py 持有进程级共享连接 + 读池缓存：换库前关闭（关闭后重建即指向新路径）
    from evoflow.persistence.db import reset_db_for_tests

    reset_db_for_tests()
    yield db_path
    if prev is None:
        os.environ.pop("EVOFLOW_DB_PATH", None)
    else:
        os.environ["EVOFLOW_DB_PATH"] = prev
    if prev_storage is None:
        os.environ.pop("EVOFLOW_STORAGE_SQLITE_PATH", None)
    else:
        os.environ["EVOFLOW_STORAGE_SQLITE_PATH"] = prev_storage
    reset_db_for_tests()
    tmp.cleanup()


# ── verifier 结果解析（ZCode 容错语义移植） ──────────────────────────────────


def test_parse_verification_bare_json() -> None:
    from app.gateway.v4.goal_engine import parse_goal_verification_text

    out = parse_goal_verification_text(
        '{"passed": false, "reason": "missing summary.md", "nextAction": "write summary.md"}'
    )
    assert out["passed"] is False
    assert out["nextAction"] == "write summary.md"
    assert "summary.md" in out["reason"]


def test_parse_verification_fenced_and_string_wrapped() -> None:
    from app.gateway.v4.goal_engine import parse_goal_verification_text

    fenced = '```json\n{"passed": true, "reason": "done", "nextAction": ""}\n```'
    assert parse_goal_verification_text(fenced)["passed"] is True
    wrapped = '"{\\"passed\\": true, \\"reason\\": \\"ok\\"}"'
    assert parse_goal_verification_text(wrapped)["passed"] is True
    noisy = '结果如下：{"passed": true, "reason": "完成"} 以上。'
    assert parse_goal_verification_text(noisy)["passed"] is True


def test_parse_verification_invalid_json_fails_open() -> None:
    from app.gateway.v4.goal_engine import parse_goal_verification_text

    out = parse_goal_verification_text("this is not json at all")
    # ZCode 语义：verifier 格式故障 fail-open，避免目标被裁判链路卡死。
    assert out["passed"] is True
    assert "valid JSON" in out["reason"]


def test_parse_verification_defaults() -> None:
    from app.gateway.v4.goal_engine import parse_goal_verification_text

    out = parse_goal_verification_text('{"passed": false}')
    assert out["passed"] is False
    assert out.get("nextAction") is None
    assert out["reason"]  # fallback reason 恒存在


# ── 仓储：状态机与终态护栏 ────────────────────────────────────────────────────


def test_repo_goal_lifecycle_and_terminal_guard(goal_db: str) -> None:
    from evoflow.persistence import v4_goal_repositories as repo

    assert repo.load_v4_session_goal("t1") is None
    goal = repo.upsert_v4_session_goal("t1", objective="write the report", status="active")
    assert goal["status"] == "active" and goal["iteration"] == 0

    assert repo.patch_v4_goal_atomic("t1", fields={"status": "verifying"}) == 1
    fresh = repo.append_v4_goal_verification(
        "t1",
        {"iteration": 1, "outcome": "notSatisfied", "at": 1, "anchorRowId": 9, "reason": "r"},
        bump_iteration=True,
    )
    assert fresh is not None
    assert fresh["iteration"] == 1 and fresh["verifications"][0]["outcome"] == "notSatisfied"

    assert repo.patch_v4_goal_atomic("t1", fields={"status": "verified"}, where_status_in=("verifying",)) == 1
    # 终态护栏：默认护栏（LIVE_GOAL_STATUSES）下不可写
    assert repo.patch_v4_goal_atomic("t1", fields={"status": "active"}) == 0
    # 替换目标 = 全量重置 + 新 target_id
    replacement = repo.upsert_v4_session_goal("t1", objective="new objective", status="active")
    assert replacement["target_id"] != goal["target_id"]
    assert replacement["iteration"] == 0 and replacement["verifications"] == []


def test_repo_patch_guard_blocked_when_paused_write_active_only(goal_db: str) -> None:
    from evoflow.persistence import v4_goal_repositories as repo

    repo.upsert_v4_session_goal("t2", objective="obj", status="paused")
    # where 限定 verifying 时 paused 行不可写
    assert repo.patch_v4_goal_atomic("t2", fields={"status": "active"}, where_status_in=("verifying",)) == 0
    assert repo.patch_v4_goal_atomic("t2", fields={"status": "active"}, where_status_in=("paused",)) == 1


# ── 引擎：set/pause/resume/stop + verifier 循环 ──────────────────────────────


@pytest.mark.asyncio
async def test_engine_set_verify_failopen_and_verified(goal_db: str, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.gateway.v4.conversation import HUB
    from app.gateway.v4.goal_engine import get_v4_goal_engine

    engine = get_v4_goal_engine()
    sid = "engine-verify-1"
    sess = HUB._get_or_create_session(sid)  # noqa: SLF001

    outcome = engine.set_goal(sid, "finish the demo report")
    state = engine.get_goal_state(sid)
    assert state is not None and state["objective"] == "finish the demo report"
    assert state["status"] in ("active", "verifying")

    snapshot = HUB._build_snapshot(sess)  # noqa: SLF001
    assert snapshot["goal"] is not None
    assert snapshot["goal"]["objective"] == "finish the demo report"
    assert "pauseGoal" in snapshot["availability"]

    # verifier：无模型环境 → fail-open → verified
    engine.on_run_finished(sid, run_id="run-1")
    for _ in range(80):
        await asyncio.sleep(0.05)
        st = engine.get_goal_state(sid)
        if st and st["status"] == "verified":
            break
    st = engine.get_goal_state(sid)
    assert st is not None and st["status"] == "verified", st
    assert st["iteration"] == 1
    # goalVerify marker 行（running → pass 同一行 upsert）
    markers = [r for r in sess.rows.values() if r.get("kind") == "timelineMarker"]
    assert markers and markers[-1]["marker"]["type"] == "goalVerify"
    assert markers[-1]["marker"]["outcome"] == "pass"
    assert markers[-1]["lane"] == "turnTailBoundary"
    # 终态后 availability 关闭
    avail = engine.availability(sid)
    assert avail["pauseGoal"]["allowed"] is False
    assert avail["resumeGoal"]["allowed"] is False


@pytest.mark.asyncio
async def test_engine_not_satisfied_then_continue_then_complete(goal_db: str, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.gateway.v4.conversation import HUB
    from app.gateway.v4.goal_engine import get_v4_goal_engine

    engine = get_v4_goal_engine()
    sid = "engine-loop-1"
    HUB._get_or_create_session(sid)  # noqa: SLF001

    verdicts = [
        {"passed": False, "reason": "file missing", "nextAction": "write the file"},
        {"passed": True, "reason": "all requirements covered"},
    ]
    calls = {"n": 0}

    async def fake_verifier(_sid: str, _row: dict[str, Any]) -> dict[str, Any]:
        out = verdicts[min(calls["n"], len(verdicts) - 1)]
        calls["n"] += 1
        return out

    monkeypatch.setattr(engine, "_run_verifier", fake_verifier)
    # 续跑起跑在测试环境必然失败（无 LangGraph）：吞掉即可，状态推进已足够断言
    async def fake_worker(_sid: str) -> None:
        return None

    monkeypatch.setattr(engine, "_continuation_worker", fake_worker)

    engine.set_goal(sid, "deliver the report")
    engine.on_run_finished(sid, run_id="run-1")
    for _ in range(80):
        await asyncio.sleep(0.05)
        st = engine.get_goal_state(sid)
        if st and calls["n"] >= 1 and st["status"] in ("active", "verifying"):
            break
    st = engine.get_goal_state(sid)
    assert st is not None
    assert st["status"] in ("active", "verifying"), st
    assert st["iteration"] == 1
    assert st["summaryTitle"] == "write the file"  # nextAction 作为迭代标题
    assert calls["n"] >= 1
    assert (st["verifications"][-1]["outcome"]) == "notSatisfied"

    # 第二轮 run 结束 → verifier passed → verified
    engine.on_run_finished(sid, run_id="run-2")
    for _ in range(80):
        await asyncio.sleep(0.05)
        st = engine.get_goal_state(sid)
        if st and st["status"] == "verified":
            break
    st = engine.get_goal_state(sid)
    assert st is not None and st["status"] == "verified", st
    assert st["iteration"] == 2


@pytest.mark.asyncio
async def test_engine_stop_pauses_active_goal(goal_db: str) -> None:
    from app.gateway.v4.conversation import HUB
    from app.gateway.v4.goal_engine import get_v4_goal_engine

    engine = get_v4_goal_engine()
    sid = "engine-stop-1"
    HUB._get_or_create_session(sid)  # noqa: SLF001
    engine.set_goal(sid, "long running objective")
    engine.on_stop(sid)
    st = engine.get_goal_state(sid)
    assert st is not None and st["status"] == "paused", st
    # resume → active
    engine.resume_goal(sid)
    st = engine.get_goal_state(sid)
    assert st is not None and st["status"] == "active", st
    # 幂等：无目标会话 resume 返回 None
    assert engine.resume_goal("engine-stop-none") is None


@pytest.mark.asyncio
async def test_engine_circuit_breaker_pauses_on_repeated_next_action(goal_db: str, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.gateway.v4.conversation import HUB
    from app.gateway.v4.goal_engine import MAX_SAME_NEXT_ACTION_STREAK, get_v4_goal_engine
    from evoflow.persistence import v4_goal_repositories as repo

    engine = get_v4_goal_engine()
    sid = "engine-breaker-1"
    HUB._get_or_create_session(sid)  # noqa: SLF001

    async def fake_verifier(_sid: str, _row: dict[str, Any]) -> dict[str, Any]:
        return {"passed": False, "reason": "still missing", "nextAction": "same step"}

    async def fake_worker(_sid: str) -> None:
        return None

    monkeypatch.setattr(engine, "_run_verifier", fake_verifier)
    monkeypatch.setattr(engine, "_continuation_worker", fake_worker)
    engine.set_goal(sid, "impossible objective")
    # 预置 continuation_count 到上限前一步，制造“同一 nextAction 已连续多次”的历史
    repo.patch_v4_goal_atomic(
        sid,
        fields={"continuation_count": 1, "last_next_action": "same step"},
    )
    repo.append_v4_goal_verification(
        sid,
        {"iteration": 1, "outcome": "notSatisfied", "at": 1, "anchorRowId": None, "nextAction": "same step"},
        bump_iteration=True,
    )
    repo.append_v4_goal_verification(
        sid,
        {"iteration": 2, "outcome": "notSatisfied", "at": 2, "anchorRowId": None, "nextAction": "same step"},
        bump_iteration=True,
    )
    engine.on_run_finished(sid, run_id="run-1")
    for _ in range(80):
        await asyncio.sleep(0.05)
        st = engine.get_goal_state(sid)
        if st and st["status"] == "paused":
            break
    st = engine.get_goal_state(sid)
    assert st is not None and st["status"] == "paused", st
    assert MAX_SAME_NEXT_ACTION_STREAK >= 2


@pytest.mark.asyncio
async def test_engine_plan_goal_mutual_exclusion(goal_db: str, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.gateway.v4.goal_engine import get_v4_goal_engine
    from app.gateway.v4.goal_engine import GoalRejectedError

    engine = get_v4_goal_engine()
    sid = "engine-plan-1"
    with pytest.raises(GoalRejectedError) as exc_info:
        engine.set_goal(sid, "objective", intent={"planEnabled": True})
    assert exc_info.value.reason_code == "guard.planGoalMutuallyExclusive"

    # 会话级 plan mode（evoflow_chat_sessions.is_plan_mode）
    from evoflow.persistence.db import get_db

    db = get_db()
    db.execute(
        """
        INSERT INTO evoflow_chat_sessions (session_key, thread_id, title, created_at, updated_at, is_plan_mode)
        VALUES ('sk-plan-1', ?, 't', '2026-01-01', '2026-01-01', 1)
        """,
        (sid,),
    )
    db.commit()
    with pytest.raises(GoalRejectedError):
        engine.set_goal(sid, "objective")


# ── hub 命令面：ACK 语义 ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_hub_goal_command_acks(goal_db: str) -> None:
    from app.gateway.v4.conversation import HUB, _SessionState

    sid = "hub-goal-cmd-1"
    sess = _SessionState(session_id=sid)
    HUB._sessions[sid] = sess  # noqa: SLF001

    env: dict[str, Any] = {
        "commandId": "cmd-g1",
        "type": "sendGoalCommand",
        "sessionId": sid,
        "payload": {"text": "   "},
    }
    ack = await HUB._execute_command(env, None)  # noqa: SLF001
    assert ack["status"] == "rejected" and ack["reasonCode"] == "emptyObjective"

    env = {
        "commandId": "cmd-g2",
        "type": "sendGoalCommand",
        "sessionId": sid,
        "payload": {"text": "ship it", "planEnabled": True},
    }
    ack = await HUB._execute_command(env, None)  # noqa: SLF001
    assert ack["status"] == "rejected"
    assert ack["reasonCode"] == "guard.planGoalMutuallyExclusive"

    env = {
        "commandId": "cmd-g3",
        "type": "sendGoalCommand",
        "sessionId": sid,
        "payload": {"text": "ship it"},
    }
    ack = await HUB._execute_command(env, None)  # noqa: SLF001
    assert ack["status"] == "accepted", ack
    assert ack["result"]["goal"]["objective"] == "ship it"

    env = {"commandId": "cmd-g4", "type": "pauseGoal", "sessionId": sid, "payload": {}}
    ack = await HUB._execute_command(env, None)  # noqa: SLF001
    assert ack["status"] == "accepted" and ack["result"]["goal"]["status"] == "paused"

    env = {"commandId": "cmd-g5", "type": "resumeGoal", "sessionId": sid, "payload": {}}
    ack = await HUB._execute_command(env, None)  # noqa: SLF001
    assert ack["status"] == "accepted" and ack["result"]["goal"]["status"] == "active"

    # 无目标会话：noop
    HUB._sessions["hub-goal-cmd-none"] = _SessionState(session_id="hub-goal-cmd-none")  # noqa: SLF001
    env = {"commandId": "cmd-g6", "type": "pauseGoal", "sessionId": "hub-goal-cmd-none", "payload": {}}
    ack = await HUB._execute_command(env, None)  # noqa: SLF001
    assert ack["status"] == "noop"
