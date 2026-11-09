"""员工模块实测（2026-11-08）挖出的四个「接口返回 ok 但没生效」缺陷的回归覆盖。

对应缺陷（详见 outputs/员工模块测试报告-2026-11-08.md）：

D1  ``employees.stop`` 之后员工「看似在岗、永不自动上班」
    - ``save_role`` 每次都会跑 ``ensure_role_schedule_fields``，它内部无条件把
      ``auto_patrol_suspended`` 清成 False → stop 刚设的挂起锁被自己的持久化冲掉；
    - ``resume_role`` 见 ``status == "active"`` 直接 noop 返回，既不解锁也不重算
      ``next_heartbeat_at`` → 用户没有任何手段恢复。

D2  ``employees.update`` 传 ``responsibilities`` 静默 no-op
    ``merge_duty_into_system_prompt`` 在已有 ``## 岗位职责`` 标题时早退，
    第二次及以后的职责编辑永远改不动（接口仍 ok、回显空数组）。

D3  巡检计划传 RRULE 多时段被截断
    ``BYHOUR=9,15`` → ``0 9 * * *``，用户以为一天两次、实际只有一次。

D4  ``employees.update`` 改不了工具白名单（落 ``ignored_keys`` 且无替代指引）。

测试全部 hermetic：不连生产库、不写真实 agent 配置，边界用 monkeypatch 拦住。
"""

from __future__ import annotations

import copy
from types import SimpleNamespace

import pytest

from evoflow.proactive.employee_prompting.job import (
    DUTY_PROMPT_SECTION,
    merge_duty_into_system_prompt,
    replace_duty_in_system_prompt,
)
from evoflow.proactive.models import ProactiveRole, ProactiveRoleConfig
from evoflow.proactive.schedule import (
    ensure_role_schedule_fields,
    legacy_rrule_to_cron,
    resolve_role_cron,
    sync_role_schedule_fields,
)


def _role(
    *,
    code: str = "duty-desk",
    name: str = "值班岗",
    schedule: str = "0 9 * * *",
    rrule: str = "FREQ=DAILY;INTERVAL=1;BYHOUR=9",
    suspended: bool = False,
    next_heartbeat_at: str | None = "2026-11-08T09:00:00+08:00",
    status: str = "active",
) -> ProactiveRole:
    cfg = ProactiveRoleConfig()
    cfg.auto_patrol_suspended = suspended
    return ProactiveRole(
        agent_code=code,
        role_name=name,
        department="测试",
        status=status,
        config=cfg,
        heartbeat_rrule=rrule,
        heartbeat_schedule=schedule,
        next_heartbeat_at=next_heartbeat_at,
    )


# ───────────────────────── D1：挂起锁不该被持久化顺手清掉 ─────────────────────────


def test_lazy_schedule_heal_preserves_stop_latch() -> None:
    """``ensure_role_schedule_fields``（save_role / lazy read 都调它）不得解锁。"""
    role = _role(suspended=True)
    ensure_role_schedule_fields(role)
    assert role.config.auto_patrol_suspended is True, (
        "schedule 自愈把 stop 的挂起锁清了 → 员工看似在岗、巡检却又活了"
    )
    # 计划字段本身仍要正常归一
    assert role.heartbeat_schedule == "0 9 * * *"


def test_schedule_heal_on_read_only_roles_is_stable() -> None:
    """读取路径反复归一化也只改字段、不改锁（幂等，且不能顺手放行巡检）。"""
    role = _role(suspended=True)
    for _ in range(3):
        ensure_role_schedule_fields(role)
    assert role.config.auto_patrol_suspended is True
    assert resolve_role_cron(role) == "0 9 * * *"


def test_explicit_schedule_write_still_clears_latch() -> None:
    """用户在面板/API 显式开巡检 → 必须解锁（不能把 D1 修成「开不了巡检」）。"""
    role = _role(suspended=True)
    sync_role_schedule_fields(role, "0 9,15 * * *")
    assert role.config.auto_patrol_suspended is False


def test_schedule_off_still_sets_latch() -> None:
    role = _role(suspended=False)
    sync_role_schedule_fields(role, "off")
    assert role.config.auto_patrol_suspended is True
    assert role.heartbeat_schedule == "off"
    assert role.next_heartbeat_at is None


@pytest.mark.parametrize(
    "role_kwargs, expect_rearmed",
    [
        # stop 过的在岗员工：status 仍是 active，但带锁 / 无下次心跳 → 必须真的解停
        ({"suspended": True, "next_heartbeat_at": None}, True),
        ({"suspended": False, "next_heartbeat_at": None}, True),
        # 正常在岗：才是真 noop
        ({"suspended": False, "next_heartbeat_at": "2026-11-08T09:00:00+08:00"}, False),
    ],
)
def test_resume_rearms_a_stopped_but_active_role(role_kwargs: dict, expect_rearmed: bool) -> None:
    from evoflow.admin import employees as emp

    role = _role(**role_kwargs)
    saved: list[ProactiveRole] = []

    fake_repo = SimpleNamespace(
        get_role=lambda code: role,
        save_role=lambda r: saved.append(r),
    )
    monkey = pytest.MonkeyPatch()
    try:
        monkey.setattr(emp, "ProactiveRepository", fake_repo)
        monkey.setattr(
            "evoflow.proactive.runner.compute_next_duty_iso",
            lambda r: "2026-11-08T09:00:00+08:00",
            raising=False,
        )
        out = emp.resume_role(role.agent_code)
    finally:
        monkey.undo()

    assert out["ok"] is True
    assert bool(out.get("noop")) is (not expect_rearmed)
    assert role.status == "active"
    assert role.config.auto_patrol_suspended is False
    if expect_rearmed:
        assert out.get("patrol_rearmed") is True
        assert role.next_heartbeat_at, "解停后必须重算下次心跳，否则永不排班"
        assert saved, "解停必须落库"


# ───────────────────────── D2：职责可反复编辑 ─────────────────────────


def test_replace_duty_overwrites_previous_list() -> None:
    sp = "口径：只回答 EVO-OK\n\n## 岗位职责\n- R1-第一版"
    out = replace_duty_in_system_prompt(sp, ["R2-第二版", "R3"])
    assert "R2-第二版" in out and "R3" in out
    assert "R1-第一版" not in out, "覆盖式写入必须换掉旧职责"
    assert out.count(DUTY_PROMPT_SECTION) == 1
    assert out.startswith("口径：只回答 EVO-OK")


def test_replace_duty_keeps_sections_after_the_duty_block() -> None:
    sp = (
        "骨架说明\n\n## 岗位职责\n- 旧职责A\n- 旧职责B\n\n## 禁止事项\n- 不得编造"
    )
    out = replace_duty_in_system_prompt(sp, ["新职责"])
    assert "- 新职责" in out
    assert "旧职责A" not in out and "旧职责B" not in out
    assert "## 禁止事项" in out and "不得编造" in out, "不得吃掉职责段之后的内容"
    assert out.index("## 岗位职责") < out.index("## 禁止事项")


def test_replace_duty_with_empty_list_removes_section_only() -> None:
    sp = "骨架\n\n## 岗位职责\n- 旧\n\n## 禁止事项\n- 别编"
    out = replace_duty_in_system_prompt(sp, [])
    assert DUTY_PROMPT_SECTION not in out
    assert "## 禁止事项" in out


def test_merge_duty_stays_append_only_for_inject_paths() -> None:
    """注入期（assemble / overlap）仍要求幂等追加：不得被 D2 改成覆盖。"""
    sp = "骨架\n\n## 岗位职责\n- 旧"
    assert merge_duty_into_system_prompt(sp, ["新"]) == sp.strip()
    assert "## 岗位职责" in merge_duty_into_system_prompt("骨架", ["新职责"])


def test_update_role_persists_second_responsibilities_edit() -> None:
    """回归主案：create 之后再 update 职责，必须真的写进 agent system_prompt。"""
    from evoflow.admin import agents as agents_admin
    from evoflow.admin import employees as emp
    from evoflow.config import agents_config

    role = _role()
    role.config.responsibilities = []
    state = {"prompt": "你是值班岗。\n\n## 岗位职责\n- R1-第一版"}
    written: list[dict] = []

    fake_repo = SimpleNamespace(get_role=lambda code: role, save_role=lambda r: None)
    monkey = pytest.MonkeyPatch()
    try:
        monkey.setattr(emp, "ProactiveRepository", fake_repo)
        monkey.setattr(
            agents_admin,
            "update_agent",
            lambda code, data: written.append(dict(data)),
        )
        monkey.setattr(
            agents_config,
            "load_agent_config",
            lambda code: SimpleNamespace(system_prompt=state["prompt"]),
        )
        monkey.setattr(
            agents_config, "invalidate_agent_config_cache", lambda code: None, raising=False
        )
        monkey.setattr(
            "evoflow.admin.agents.refresh_agent_runtime_after_capability_change",
            lambda code: None,
            raising=False,
        )
        out = emp.update_role(role.agent_code, {"responsibilities": ["R2-第二版"]})
    finally:
        monkey.undo()

    assert written, "职责更新必须写回 agent，不能再静默丢弃"
    prompt = written[-1]["system_prompt"]
    assert "R2-第二版" in prompt and "R1-第一版" not in prompt


def test_update_role_explicit_prompt_without_duties_keeps_prose_verbatim() -> None:
    """只改提示词正文（不传职责）时，不得把遗留职责又拼回去。"""
    from evoflow.admin import agents as agents_admin
    from evoflow.admin import employees as emp
    from evoflow.config import agents_config

    role = _role()
    written: list[dict] = []
    monkey = pytest.MonkeyPatch()
    try:
        monkey.setattr(emp, "ProactiveRepository", SimpleNamespace(
            get_role=lambda code: role, save_role=lambda r: None
        ))
        monkey.setattr(agents_admin, "update_agent", lambda code, data: written.append(dict(data)))
        monkey.setattr(
            agents_config,
            "load_agent_config",
            lambda code: SimpleNamespace(system_prompt="旧正文"),
        )
        emp.update_role(role.agent_code, {"system_prompt": "更新后的口径：只回答 UPDATED。"})
    finally:
        monkey.undo()

    assert written[-1]["system_prompt"] == "更新后的口径：只回答 UPDATED。"


# ───────────────────────── D3：RRULE 多时段不截断 ─────────────────────────


@pytest.mark.parametrize(
    "rrule, want",
    [
        ("FREQ=DAILY;INTERVAL=1;BYHOUR=9,15", "0 9,15 * * *"),
        ("FREQ=DAILY;INTERVAL=1;BYHOUR=9", "0 9 * * *"),
        ("FREQ=DAILY;INTERVAL=1;BYHOUR=9;BYMINUTE=30", "30 9 * * *"),
        ("FREQ=DAILY;INTERVAL=1;BYHOUR=8,12,18;BYMINUTE=0,30", "0,30 8,12,18 * * *"),
        # 非法值退回默认，不要拼出坏 cron
        ("FREQ=DAILY;INTERVAL=1;BYHOUR=bogus", "0 9 * * *"),
    ],
)
def test_legacy_rrule_to_cron_keeps_every_value(rrule: str, want: str) -> None:
    assert legacy_rrule_to_cron(rrule) == want


def test_rrule_to_cron_shared_converter_keeps_every_value() -> None:
    from evoflow.admin.automation_schedule import rrule_to_cron

    assert rrule_to_cron("FREQ=DAILY;INTERVAL=1;BYHOUR=9,15") == "0 9,15 * * *"


def test_multi_slot_cron_actually_matches_both_hours() -> None:
    """转换只是前半段；跑不跑由 cron 匹配器决定，一起锁住。"""
    from datetime import datetime

    from evoflow.admin.automation_schedule import cron_matches_at

    expr = legacy_rrule_to_cron("FREQ=DAILY;INTERVAL=1;BYHOUR=9,15")
    assert cron_matches_at(expr, datetime(2026, 11, 8, 9, 0))
    assert cron_matches_at(expr, datetime(2026, 11, 8, 15, 0))
    assert not cron_matches_at(expr, datetime(2026, 11, 8, 12, 0))


def test_rrule_with_work_window_and_multi_hour() -> None:
    """DAILY 分支不掺工作时间窗，但字段必须仍是合法 5 段。"""
    from evoflow.admin.automation_schedule import is_five_field_cron_or_keyword

    expr = legacy_rrule_to_cron("FREQ=DAILY;INTERVAL=1;BYHOUR=9,15")
    assert is_five_field_cron_or_keyword(expr)
    hourly = legacy_rrule_to_cron("FREQ=HOURLY;INTERVAL=1", _role().config)
    assert is_five_field_cron_or_keyword(hourly)


# ───────────────────────── D4：update 能改工具白名单 ─────────────────────────


def test_update_role_mirrors_tools_onto_agent() -> None:
    from evoflow.admin import agents as agents_admin
    from evoflow.admin import employees as emp

    role = _role()
    written: list[dict] = []
    monkey = pytest.MonkeyPatch()
    try:
        monkey.setattr(emp, "ProactiveRepository", SimpleNamespace(
            get_role=lambda code: role, save_role=lambda r: None
        ))
        monkey.setattr(agents_admin, "update_agent", lambda code, data: written.append(dict(data)))
        monkey.setattr(
            "evoflow.admin.agents.refresh_agent_runtime_after_capability_change",
            lambda code: None,
            raising=False,
        )
        out = emp.update_role(role.agent_code, {"tools": ["tasks", "read"]})
    finally:
        monkey.undo()

    assert {"tools": ["tasks", "read"]} in written, "tools 必须镜像到 agent 侧"
    assert "tools" not in (out.get("ignored_keys") or [])


def test_update_role_reports_bad_tool_name_instead_of_swallowing() -> None:
    from evoflow.admin import agents as agents_admin
    from evoflow.admin import employees as emp
    from evoflow.admin.errors import ValidationError

    role = _role()

    def _boom(code: str, data: dict) -> dict:
        raise ValidationError("unknown tool(s): nonexistent")

    monkey = pytest.MonkeyPatch()
    try:
        monkey.setattr(emp, "ProactiveRepository", SimpleNamespace(
            get_role=lambda code: role, save_role=lambda r: None
        ))
        monkey.setattr(agents_admin, "update_agent", _boom)
        with pytest.raises(ValidationError):
            emp.update_role(role.agent_code, {"tools": ["nonexistent"]})
    finally:
        monkey.undo()


def test_runtime_injected_keys_are_not_noise_in_ignored_keys() -> None:
    """平台工具会往 args 里注入会话键，以前每次 update 都回显一遍，纯噪音。"""
    from evoflow.admin import employees as emp

    role = _role()
    monkey = pytest.MonkeyPatch()
    try:
        monkey.setattr(emp, "ProactiveRepository", SimpleNamespace(
            get_role=lambda code: role, save_role=lambda r: None
        ))
        out = emp.update_role(
            role.agent_code,
            {"kpis": ["口径准确"], "principal_id": "p", "session_key": "s", "thread_id": "t"},
        )
    finally:
        monkey.undo()

    assert "ignored_keys" not in out, out.get("ignored_keys")
    assert out["config"]["kpis"] == ["口径准确"]


# ───────────────────────── D5：worklog 统计 dispatch 值班轮次 ─────────────────────────


def test_worklog_merges_duty_rounds_and_dedupes() -> None:
    from evoflow.admin import employees as emp

    day = "2026-11-08"
    rounds = [
        {
            "round_id": "dispatch:02:18:44",
            "at": "2026-11-08T02:18:44+08:00",
            "goal": "巡检",
            "outcome": "",
            "verdict": "done",
            "items": [],
            "item_count": 1,
            "pending_approval": 0,
            "journal_count": 0,
        }
    ]
    journals = [
        # 与 rounds 同 round_id → 去重，不得翻倍
        {
            "round_id": "dispatch:02:18:44",
            "created_at": "2026-11-08T02:18:44+08:00",
            "goal": "巡检",
            "outcome": "完成",
            "status": "completed",
            "action_plan": {"source": "duty_run", "run_id": "duty_a", "msg_count": 54, "tool_count": 29},
        },
        # dispatch 轮次（不建 initiative，以前直接看不见）
        {
            "round_id": "dispatch:02:23:10",
            "created_at": "2026-11-08T02:23:10+08:00",
            "goal": "派发上班",
            "outcome": "轨迹 54 条 · 工具 29 次",
            "status": "completed",
            "action_plan": {
                "source": "duty_run",
                "run_id": "duty_b",
                "trigger_source": "dispatch.xiaomi",
                "msg_count": 54,
                "tool_count": 29,
            },
        },
        # 别的日期 → 过滤掉
        {
            "round_id": "dispatch:11-07",
            "created_at": "2026-11-07T22:00:00+08:00",
            "goal": "旧轮次",
            "status": "completed",
            "action_plan": {"source": "duty_run", "run_id": "duty_c"},
        },
    ]

    import evoflow.proactive.duty_runs as duty_runs

    monkey = pytest.MonkeyPatch()
    try:
        monkey.setattr(duty_runs, "list_duty_rounds_for_board", lambda code, *, limit=40: journals)
        merged = emp._merge_duty_rounds(copy.deepcopy(rounds), "duty-desk", [day], limit=80)
    finally:
        monkey.undo()

    ids = [r["round_id"] for r in merged]
    assert ids == ["dispatch:02:23:10", "dispatch:02:18:44"], ids
    dispatched = merged[0]
    assert dispatched["verdict"] == "done"
    assert dispatched["tool_count"] == 29
    assert dispatched["source"] == "duty_run"


def test_worklog_skips_duty_rounds_for_skipped_patrols_shape() -> None:
    """到点跳过（outside_work_window）也要计入轮次，并带 skipped 判定。"""
    from evoflow.admin import employees as emp
    import evoflow.proactive.duty_runs as duty_runs

    journals = [
        {
            "round_id": "round:03:00",
            "created_at": "2026-11-08T03:00:01+08:00",
            "goal": "定时上班",
            "outcome": "到点触发 · 不在上班时间内，本轮未开跑",
            "status": "completed",
            "action_plan": {
                "source": "automation_run",
                "skip_reason": "outside_work_window",
                "scheduled": True,
            },
        }
    ]
    monkey = pytest.MonkeyPatch()
    try:
        monkey.setattr(duty_runs, "list_duty_rounds_for_board", lambda code, *, limit=40: journals)
        merged = emp._merge_duty_rounds([], "duty-desk", ["2026-11-08"], limit=80)
    finally:
        monkey.undo()

    assert len(merged) == 1
    assert merged[0]["verdict"] == "skipped"
    assert merged[0]["skip_reason"] == "outside_work_window"


def test_worklog_survives_duty_index_failure() -> None:
    """索引读取失败不得把整个 worklog 打挂（原来就没有这条数据源）。"""
    from evoflow.admin import employees as emp
    import evoflow.proactive.duty_runs as duty_runs

    def _boom(*a: object, **kw: object) -> list:
        raise RuntimeError("duty index unavailable")

    monkey = pytest.MonkeyPatch()
    try:
        monkey.setattr(duty_runs, "list_duty_rounds_for_board", _boom)
        merged = emp._merge_duty_rounds([], "duty-desk", ["2026-11-08"], limit=80)
    finally:
        monkey.undo()

    assert merged == []


# ───────────────────────── D6：删除如实回报残留 ─────────────────────────


def test_delete_role_reports_retained_agent_and_workspace() -> None:
    from evoflow.admin import employees as emp

    role = _role()
    role.config.workspace_path = "C:/nowhere/qa-workspace"
    monkey = pytest.MonkeyPatch()
    try:
        monkey.setattr(
            emp,
            "ProactiveRepository",
            SimpleNamespace(get_role=lambda code: role, delete_role=lambda code: True),
        )
        out = emp.delete_role(role.agent_code)
    finally:
        monkey.undo()

    assert out["ok"] is True and out["deleted"] is True
    assert out["agent_deleted"] is False
    joined = " ".join(out.get("retained") or [])
    assert "delete_agent=true" in joined, "必须告诉调用方智能体还留着、怎么一并删"


def test_get_role_accepts_role_name() -> None:
    """读接口对齐 dispatch/brief/wake：岗位名也能查。"""
    from evoflow.admin import employees as emp

    role = _role(code="duty-desk", name="值班岗")
    monkey = pytest.MonkeyPatch()
    try:
        # 岗位名查不到 code（get_role 只认 code），但 resolve_role_ref 能按名解析
        monkey.setattr(emp, "ProactiveRepository", SimpleNamespace(
            get_role=lambda code: None if code == "值班岗" else role,
            list_roles=lambda **kw: [role],
            list_initiatives=lambda **kw: [],
        ))
        out = emp.get_role("值班岗", recent_limit=0)
    finally:
        monkey.undo()

    assert out["agent_code"] == "duty-desk"


# ──────────────── D7：dispatch 返回的 round_id 必须就是实际轮次用的那个 ────────────────


def test_dispatch_returns_the_same_round_id_the_round_uses() -> None:
    # 网关以前对同一批入参解析两次 round_id（各取一次时钟）：employees.dispatch
    # 返回的 round_id 与 evoflow_duty_runs.round_id 差几十毫秒，调用方拿返回值去
    # employees.trail 查不到任何步骤。现在只解析一次，并把结果连同 resumed 判定
    # 一起交给后台轮次，返回值与实际轮次必须完全相同。
    import asyncio

    from evoflow.proactive.runner import ProactiveRunner

    captured: dict = {}

    async def _fake_bg(self, code, goal_s, **kw):  # noqa: ANN001, ARG001
        captured.update({"code": code, "goal": goal_s, **kw})

    async def _reserve_ok(self, code):  # noqa: ANN001, ARG001
        return True

    class _Repo:
        @staticmethod
        def get_role(code):
            return _role(code=str(code), name="值班岗")

        @staticmethod
        def list_roles(**kw):
            return []

    runner = ProactiveRunner.__new__(ProactiveRunner)
    runner._bg_tasks = set()

    monkey = pytest.MonkeyPatch()
    try:
        import evoflow.proactive.runner as runner_mod

        monkey.setattr(runner_mod, "ProactiveRepository", _Repo)
        monkey.setattr(ProactiveRunner, "_reserve_role", _reserve_ok)
        monkey.setattr(ProactiveRunner, "_dispatch_task_bg", _fake_bg)

        async def _run():
            out = await runner.dispatch_task_fire_and_forget(
                "duty-desk", "只回一句 OK", skip_done_guard=True
            )
            await asyncio.sleep(0.05)
            return out

        out = asyncio.run(_run())
    finally:
        monkey.undo()

    assert out["ok"] is True and out["dispatched"] is True
    rid = str(out.get("round_id") or "")
    assert rid.startswith("dispatch:"), out
    assert captured.get("resolved_round_id") == rid, (
        "响应 round_id 必须就是后台轮次拿到的那个，不能各取一次时钟"
    )
    assert bool(captured.get("resolved_resumed")) is bool(out.get("resumed_round"))


# ──────────────── D8：worklog 可按 round_id 定位；trail 不串轮次 ────────────────


def _worklog_repo(monkey, role, *, initiatives, journals, task_rows=None):
    """Patch the three data sources worklog reads (initiatives / duty index / tasks)."""
    import evoflow.admin.employees as emp
    import evoflow.proactive.duty_runs as duty_runs

    monkey.setattr(
        emp,
        "ProactiveRepository",
        SimpleNamespace(
            get_role=lambda code: role,
            list_initiatives=lambda **kw: list(initiatives),
        ),
    )
    if journals is not None:
        monkey.setattr(duty_runs, "list_duty_rounds_for_board", lambda code, *, limit=40: list(journals))
    monkey.setattr(
        emp,
        "_list_role_tasks_for_beijing_day",
        lambda code, day_s, *, limit=80: list(task_rows or []),
    )
    return emp


def test_worklog_round_id_filter_across_recent_days() -> None:
    """round_id 定位不得依赖调用方猜对日期：缺省应回溯近 7 日并只返回该轮。"""
    from datetime import datetime, timedelta

    from evoflow.timeutil import BEIJING_TZ

    role = _role()
    # 2 天前的轮次：不传 day/days 时也必须被 round_id 找到（以前的单日窗口查不到）
    old_day = (datetime.now(BEIJING_TZ) - timedelta(days=2)).strftime("%Y-%m-%d")
    now_iso = datetime.now(BEIJING_TZ).strftime("%Y-%m-%dT%H:%M:%S+08:00")
    journals = [
        {
            "round_id": "dispatch:today",
            "created_at": now_iso,
            "goal": "今天的轮次",
            "status": "completed",
            "action_plan": {"source": "duty_run", "run_id": "duty_b"},
        },
        {
            "round_id": "dispatch:old",
            "created_at": f"{old_day}T10:00:00+08:00",
            "goal": "旧轮",
            "status": "completed",
            "action_plan": {"source": "duty_run", "run_id": "duty_a"},
        },
    ]
    monkey = pytest.MonkeyPatch()
    try:
        emp = _worklog_repo(monkey, role, initiatives=[], journals=journals)
        out = emp.worklog(role.agent_code, round_id="dispatch:old")
    finally:
        monkey.undo()

    assert out["round_id_filter"] == "dispatch:old"
    assert out["round_count"] == 1, out["rounds"]
    assert out["rounds"][0]["round_id"] == "dispatch:old"
    assert out["days"] == 7, "未指定 day/days 时应回溯 7 日"
    assert out["day_from"] <= old_day <= out["day_to"]



def test_worklog_round_id_miss_is_reported_not_silent() -> None:
    import evoflow.admin.employees as emp

    role = _role()
    monkey = pytest.MonkeyPatch()
    try:
        _worklog_repo(monkey, role, initiatives=[], journals=[])
        out = emp.worklog(role.agent_code, day="2026-11-08", round_id="nope")
    finally:
        monkey.undo()

    assert out["round_count"] == 0
    assert "nope" in out["hint"] and "round_id" in out["semantics"]


def test_worklog_accepts_role_name() -> None:
    """读接口对齐：worklog 也该接受岗位名。"""
    import evoflow.admin.employees as emp

    role = _role(code="duty-desk", name="值班岗")
    monkey = pytest.MonkeyPatch()
    try:
        _worklog_repo(monkey, role, initiatives=[], journals=[])
        monkey.setattr(emp, "ProactiveRepository", SimpleNamespace(
            get_role=lambda code: None if code == "值班岗" else role,
            list_roles=lambda **kw: [role],
            list_initiatives=lambda **kw: [],
        ))
        out = emp.worklog("值班岗", day="2026-11-08")
    finally:
        monkey.undo()

    assert out["agent_code"] == "duty-desk"


def test_trail_with_explicit_round_does_not_borrow_latest_scorecard() -> None:
    """指定 round_id 但该轮无值班索引时，不得把最近一轮的结论当成它的。"""
    import evoflow.admin.employees as emp
    import evoflow.persistence.chat_message_repositories as chat_repo
    import evoflow.proactive.duty_runs as duty_runs

    role = _role()
    calls: dict = {}

    def _display(session_key, *, max_rows=200, round_id=None, include_hidden=False):
        calls["session_key"] = session_key
        calls["max_rows"] = max_rows
        calls["round_id"] = round_id
        return {"messages": [{"role": "tool", "name": "bash", "timestamp": "2026-11-08T02:00:00+08:00"}]}

    monkey = pytest.MonkeyPatch()
    try:
        monkey.setattr(emp, "ProactiveRepository", SimpleNamespace(
            get_role=lambda code: role,
            list_roles=lambda **kw: [role],
            list_initiatives=lambda **kw: [],
        ))
        monkey.setattr(duty_runs, "get_duty_run_by_round", lambda code, rid: None)
        monkey.setattr(duty_runs, "list_duty_runs", lambda code, limit=1: [{"round_id": "other:round", "run_id": "duty_x"}])
        monkey.setattr(chat_repo, "list_messages_for_display_all", _display)
        out = emp.round_trail(role.agent_code, round_id="dispatch:02:23:10", max_steps=10)
    finally:
        monkey.undo()

    assert calls["round_id"] == "dispatch:02:23:10"
    assert out["round_id"] == "dispatch:02:23:10", "不得被最近一轮的 round_id 覆盖"
    assert out["duty_run_id"] is None
    assert not (out["scorecard"] or {}).get("outcome")
    assert out["round_requested"] == "dispatch:02:23:10"


def test_trail_read_window_scales_with_max_steps() -> None:
    """长轮次不得被固定 200 行窗口静默截断。"""
    import evoflow.admin.employees as emp
    import evoflow.persistence.chat_message_repositories as chat_repo
    import evoflow.proactive.duty_runs as duty_runs

    role = _role()
    seen: dict = {}

    def _display(session_key, *, max_rows=200, round_id=None, include_hidden=False):
        seen["max_rows"] = max_rows
        return {"messages": []}

    monkey = pytest.MonkeyPatch()
    try:
        monkey.setattr(emp, "ProactiveRepository", SimpleNamespace(
            get_role=lambda code: role,
            list_roles=lambda **kw: [role],
            list_initiatives=lambda **kw: [],
        ))
        monkey.setattr(duty_runs, "get_duty_run_by_round", lambda code, rid: None)
        monkey.setattr(duty_runs, "list_duty_runs", lambda code, limit=1: [])
        monkey.setattr(chat_repo, "list_messages_for_display_all", _display)
        out = emp.round_trail(role.agent_code, round_id="dispatch:02:23:10", max_steps=120)
    finally:
        monkey.undo()

    assert seen["max_rows"] == 480, seen
    assert out["message_window"] == 480


def test_trail_missing_round_says_so() -> None:
    import evoflow.admin.employees as emp
    import evoflow.persistence.chat_message_repositories as chat_repo
    import evoflow.proactive.duty_runs as duty_runs

    role = _role()
    monkey = pytest.MonkeyPatch()
    try:
        monkey.setattr(emp, "ProactiveRepository", SimpleNamespace(
            get_role=lambda code: role,
            list_roles=lambda **kw: [role],
            list_initiatives=lambda **kw: [],
        ))
        monkey.setattr(duty_runs, "get_duty_run_by_round", lambda code, rid: None)
        monkey.setattr(duty_runs, "list_duty_runs", lambda code, limit=1: [])
        monkey.setattr(
            chat_repo,
            "list_messages_for_display_all",
            lambda session_key, *, max_rows=200, round_id=None, include_hidden=False: {"messages": []},
        )
        out = emp.round_trail(role.agent_code, round_id="ghost:round")
    finally:
        monkey.undo()

    assert out["hint"] and "ghost:round" in out["hint"]
    assert out["message_count"] == 0


# ──────────────── D9：retained 的指引必须可执行（不得死路） ────────────────


def test_delete_missing_role_with_delete_agent_points_at_agents_delete() -> None:
    """岗位已删后再带 delete_agent=true，不能只报 Role not found 让人撞墙。"""
    import evoflow.admin.employees as emp
    from evoflow.admin.errors import NotFoundError

    monkey = pytest.MonkeyPatch()
    try:
        monkey.setattr(
            emp, "ProactiveRepository", SimpleNamespace(get_role=lambda code: None)
        )
        with pytest.raises(NotFoundError) as ei:
            emp.delete_role("gone-code", delete_agent=True)
    finally:
        monkey.undo()

    msg = str(ei.value)
    assert "agents.delete" in msg, msg
    assert "gone-code" in msg


def test_retained_hint_offers_a_path_that_still_works() -> None:
    from evoflow.admin import employees as emp

    role = _role()
    monkey = pytest.MonkeyPatch()
    try:
        monkey.setattr(
            emp,
            "ProactiveRepository",
            SimpleNamespace(get_role=lambda code: role, delete_role=lambda code: True),
        )
        out = emp.delete_role(role.agent_code)
    finally:
        monkey.undo()

    joined = " ".join(out.get("retained") or [])
    # 岗位还在时可重发带 delete_agent=true；岗位已删时要给 agents.delete 这条路
    assert "delete_agent=true" in joined and "agents.delete" in joined, joined
