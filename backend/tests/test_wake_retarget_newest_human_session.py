"""重启后自唤醒「投错屏」：会话键在注册时快照、投递时已过期。

【self-evolution-bot · 2026-11-20 · 第97轮 · 模型:deepseek-v4.1-flash-1017】
为什么有这批用例：上一轮（第96轮）修的是 live 快照没人回收，但现网复算显示
**唤醒其实发生了，只是投到了错的那一屏**：

    17:45:11  自验证脚本把 sessionKey 写进 state.json
              → …16-15-39.290Z（当时最新屏，最后真人发言 17:43:29）
    17:45:27  用户在**另一屏** …16-17-14-53.207Z 发话
    17:47:08  看门狗照旧键 wake，消息投进 16-15-39.290Z
    17:56:11  用户被打扰后才在那屏补了一条消息

用户盯着的那一屏 13 分钟没有动静 —— 界面表现就是「重启完卡在那里叫不醒」。

根因：会话键**不能在注册时快照、投递时盲用**，必须投递时按「谁最近真说过话」重算。

判据（已用现网全量反向验证，不是猜的）：面板真人消息的 content_json 形如
``{"content":[{"type":"text",...}]}`` → ``json_type(content_json,'$.content')='array'``；
系统注入（``<task-notification>`` / ``[CONTEXT COMPACTION`` / ``# 值班`` / ``推进…``）
一律是纯 str。现网 6000 条 user 消息分桶：array=2061（真人，0 条带系统前缀）、
text=2131（全系统注入）。所以 ``= 'array'`` 这条判据不会把系统注入算成真人。

断言全部离线（内存库，不连网关、不跑 LLM）。
"""

from __future__ import annotations

import json
import sqlite3

import pytest

from evoflow.proactive import chat_session as cs

CODE = "self-evolution-bot"
SK_NEW = f"proactive:{CODE}:chat:2026-11-20T18-00-00.000Z"  # 用户正在看的屏
SK_OLD = f"proactive:{CODE}:chat:2026-11-19T16-15-39.290Z"  # 注册时写死的旧屏
SK_OTHER = "proactive:release-engineer:chat:2026-11-20T18-00-00.000Z"

_DDL = """
CREATE TABLE evoflow_chat_sessions (
    session_key TEXT PRIMARY KEY,
    thread_id TEXT,
    title TEXT,
    run_status TEXT,
    current_run_id TEXT,
    context_json TEXT,
    message_count INTEGER DEFAULT 0,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT,
    created_at TEXT
);
CREATE TABLE evoflow_chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_key TEXT NOT NULL,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL,
    content_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
);
"""


def _human(text: str) -> str:
    """面板真人消息：content 是片段数组。"""
    return json.dumps({"content": [{"type": "text", "text": text}]}, ensure_ascii=False)


def _injected(text: str) -> str:
    """系统注入：content 是纯字符串。"""
    return json.dumps({"content": text}, ensure_ascii=False)


def _make_db() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.executescript(_DDL)
    return conn


def _seed(conn: sqlite3.Connection, session_key: str, *, deleted: int = 0) -> None:
    conn.execute(
        "INSERT OR IGNORE INTO evoflow_chat_sessions (session_key, is_deleted, updated_at, created_at)"
        " VALUES (?, ?, '2026-11-20T17:00:00+08:00', '2026-11-19T00:00:00+08:00')",
        (session_key, deleted),
    )


def _add_msg(conn: sqlite3.Connection, session_key: str, seq: int, role: str, payload: str, at: str) -> None:
    conn.execute(
        "INSERT INTO evoflow_chat_messages (session_key, seq, role, content_json, created_at)"
        " VALUES (?, ?, ?, ?, ?)",
        (session_key, seq, role, payload, at),
    )


@pytest.fixture()
def db(monkeypatch):
    conn = _make_db()
    monkeypatch.setattr("evoflow.persistence.db.get_db", lambda *a, **k: conn)
    yield conn
    conn.close()


# ── 判据本身：真人 vs 系统注入 ──────────────────────────────────────────────
def test_latest_human_ignores_system_injection(db):
    """系统注入比真人更新，但绝不能被当成「用户正在看的屏」。"""
    _seed(db, SK_OLD)
    _seed(db, SK_NEW)
    # 旧屏：真人 17:43 说过话
    _add_msg(db, SK_OLD, 1, "user", _human("重启好多次了，你再看看"), "2026-11-20T17:43:29+08:00")
    # 新屏：用户 17:45 在这里说，之后被系统注入刷得更新
    _add_msg(db, SK_NEW, 1, "user", _human("所以这个功能到底能不能交付"), "2026-11-20T17:45:27+08:00")
    _add_msg(db, SK_NEW, 2, "user", _injected("<task-notification>\n<task-id>x</task-id>"), "2026-11-20T17:47:08+08:00")
    _add_msg(db, SK_NEW, 3, "user", _injected("# 值班 · 「自我进化BOT」"), "2026-11-20T17:50:00+08:00")

    sk, at = cs.latest_human_session_key(CODE)
    assert sk == SK_NEW, f"选中了 {sk} —— 系统注入被误当成真人发言"
    assert at.startswith("2026-11-20T17:45:27")


def test_latest_human_picks_newest_across_screens(db):
    """多屏都有真人发言时，选时间最新的那屏。"""
    _seed(db, SK_OLD)
    _seed(db, SK_NEW)
    _add_msg(db, SK_OLD, 1, "user", _human("旧的"), "2026-11-20T10:00:00+08:00")
    _add_msg(db, SK_NEW, 1, "user", _human("新的"), "2026-11-20T17:45:27+08:00")
    assert cs.latest_human_session_key(CODE)[0] == SK_NEW


def test_latest_human_excludes_deleted_and_foreign(db):
    """已删除会话、别人的会话都不许被选中。"""
    _seed(db, SK_NEW, deleted=1)
    _add_msg(db, SK_NEW, 1, "user", _human("已删"), "2026-11-20T18:30:00+08:00")
    _seed(db, SK_OTHER)
    _add_msg(db, SK_OTHER, 1, "user", _human("别人的"), "2026-11-20T18:40:00+08:00")
    _seed(db, SK_OLD)
    _add_msg(db, SK_OLD, 1, "user", _human("我的"), "2026-11-20T10:00:00+08:00")
    assert cs.latest_human_session_key(CODE)[0] == SK_OLD


def test_latest_human_returns_empty_without_human_rows(db):
    """只有系统注入 / 没有任何消息 → 返回空，调用方退回原分桶行为。"""
    _seed(db, SK_OLD)
    _add_msg(db, SK_OLD, 1, "user", _injected("# 值班 · 简报"), "2026-11-20T17:00:00+08:00")
    assert cs.latest_human_session_key(CODE) == ("", "")


# ── 投递时校正：prefer_newest_human_session ────────────────────────────────
def test_retargets_when_user_moved_to_newer_screen(db):
    """本轮现网事故的最小复现：钉住的旧屏 17:43，用户 17:45 换了屏 → 必须换。"""
    _seed(db, SK_OLD)
    _seed(db, SK_NEW)
    _add_msg(db, SK_OLD, 1, "user", _human("旧屏最后一句话"), "2026-11-20T17:43:29+08:00")
    _add_msg(db, SK_NEW, 1, "user", _human("用户在新屏发话"), "2026-11-20T17:45:27+08:00")

    sk, reason = cs.prefer_newest_human_session(CODE, SK_OLD)
    assert reason == "retargeted"
    assert sk == SK_NEW, "仍投旧屏 —— 用户会继续等一个永远不会来的回复"


def test_keeps_pin_when_already_newest(db):
    """钉住的屏本身就是最新真人屏 → 一个字节都不许动。"""
    _seed(db, SK_OLD)
    _seed(db, SK_NEW)
    _add_msg(db, SK_OLD, 1, "user", _human("我就是最新"), "2026-11-20T17:45:27+08:00")
    _add_msg(db, SK_NEW, 1, "user", _human("我更旧"), "2026-11-20T10:00:00+08:00")
    assert cs.prefer_newest_human_session(CODE, SK_OLD) == (SK_OLD, "kept")


def test_keeps_pin_when_gap_below_threshold(db):
    """同一秒级的写入竞争不许触发换屏（min_gap_s 防抖）。"""
    _seed(db, SK_OLD)
    _seed(db, SK_NEW)
    _add_msg(db, SK_OLD, 1, "user", _human("A"), "2026-11-20T17:45:00+08:00")
    _add_msg(db, SK_NEW, 1, "user", _human("B"), "2026-11-20T17:45:30+08:00")  # 差 30s < 60s
    assert cs.prefer_newest_human_session(CODE, SK_OLD) == (SK_OLD, "kept")


def test_empty_pin_stays_unpinned(db):
    """没钉键 = 原 task/duty 分桶行为，绝不能被这里改成别的。"""
    _seed(db, SK_NEW)
    _add_msg(db, SK_NEW, 1, "user", _human("随便"), "2026-11-20T17:45:00+08:00")
    assert cs.prefer_newest_human_session(CODE, "") == ("", "unpinned")


def test_never_retargets_into_foreign_screen(db):
    """最新真人屏属于别的岗位 → 不许投过去（归属校验兜底）。"""
    _seed(db, SK_OLD)
    _seed(db, SK_OTHER)
    _add_msg(db, SK_OLD, 1, "user", _human("我的旧屏"), "2026-11-20T10:00:00+08:00")
    _add_msg(db, SK_OTHER, 1, "user", _human("别人的新屏"), "2026-11-20T18:30:00+08:00")
    sk, reason = cs.prefer_newest_human_session(CODE, SK_OLD)
    assert (sk, reason) == (SK_OLD, "kept")
# ── 接线层：admin.wake() 必须把**校正后**的键交给 dispatch ─────────────────
# 【self-evolution-bot · 2026-11-20 · 第97轮】这一层不能省：上一轮（第96轮）我修了函数
# 却漏了接线，反向验证时把调用点退回旧行为，测试**照样全绿** —— 等于没验。
# 判据：把 `employees.py` 里 `session_key=wake_session_key` 改回 `session_key=session_key`，
# 下面两条必须红。
def test_admin_wake_dispatches_retargeted_key(db, monkeypatch):
    """用户换了屏 → wake 实际交给 dispatch 的必须是新屏，不是调用方钉的旧屏。"""
    from types import SimpleNamespace
    from unittest.mock import patch

    from evoflow.admin import employees as emp

    _seed(db, SK_OLD)
    _seed(db, SK_NEW)
    _add_msg(db, SK_OLD, 1, "user", _human("旧屏最后一句话"), "2026-11-20T17:43:29+08:00")
    _add_msg(db, SK_NEW, 1, "user", _human("用户在新屏发话"), "2026-11-20T17:45:27+08:00")

    target = SimpleNamespace(agent_code=CODE, role_name="自我进化BOT", status="active")
    seen: dict = {}

    def _fake_dispatch(agent_code, goal, **kwargs):
        seen.update(kwargs)
        return {"ok": True, "dispatched": True}

    with (
        patch.object(emp, "resolve_role_ref", lambda t: target),
        patch("evoflow.proactive.work_items.all_referenced_tasks_done", lambda *a, **k: (False, [])),
        patch.object(emp, "dispatch", _fake_dispatch),
    ):
        emp.wake(CODE, "重启后自唤醒验证", from_agent="user", session_key=SK_OLD)

    assert seen.get("session_key") == SK_NEW, (
        f"wake 仍投旧屏（{seen.get('session_key')}）—— 用户会继续等一个永远不会来的回复"
    )


def test_admin_wake_keeps_pin_when_no_human_signal(db, monkeypatch):
    """库里没有真人发言信号时，必须原样保留调用方钉的键（零影响退化）。"""
    from types import SimpleNamespace
    from unittest.mock import patch

    from evoflow.admin import employees as emp

    target = SimpleNamespace(agent_code=CODE, role_name="自我进化BOT", status="active")
    seen: dict = {}

    def _fake_dispatch(agent_code, goal, **kwargs):
        seen.update(kwargs)
        return {"ok": True, "dispatched": True}

    with (
        patch.object(emp, "resolve_role_ref", lambda t: target),
        patch("evoflow.proactive.work_items.all_referenced_tasks_done", lambda *a, **k: (False, [])),
        patch.object(emp, "dispatch", _fake_dispatch),
    ):
        emp.wake(CODE, "普通唤醒", from_agent="user", session_key=SK_OLD)

    assert seen.get("session_key") == SK_OLD


# ── 第二条投递路径：proactive.dispatch.fire_and_forget ──────────────────────
# 【self-evolution-bot · 2026-11-20 · 第98轮 · 模型:deepseek-v4.1-flash-1017】
# 为什么补这两条：第97轮的重定向只加在 admin/employees.py 的 wake() 里，而看门狗 /
# 任务调度器 / 平台派单实际走的是 runner.dispatch_task_fire_and_forget —— 现网铁证
# （19:01:55）日志里是 proactive.dispatch.fire_and_forget，同一时段 employees.wake
# 日志 0 条，用户那屏依旧没被投到。判据：所有投递的公共入口都必须校正会话键，
# 不能只挂在一条调用链上。这两条用例直接断言「交给 _dispatch_task_bg 的键」。


def _fire_and_forget_with(db, monkeypatch, pinned: str, *, source: str = "role", related: str = ""):
    """跑一次 fire_and_forget，返回它交给 _dispatch_task_bg 的 kwargs。"""
    import asyncio
    from types import SimpleNamespace
    from unittest.mock import patch

    from evoflow.proactive.runner import ProactiveRunner

    seen: dict = {}

    async def _fake_bg(*args, **kwargs):
        seen.update(kwargs)
        return {"ok": True}

    # 用真实构造函数，别用 __new__ 绕过 __init__：后者缺 _inflight_guard 等锁，
    # 测试会以 AttributeError 假红（本轮自撞一次）。
    runner = ProactiveRunner()
    role = SimpleNamespace(agent_code=CODE, role_name="自我进化BOT", status="active")

    with (
        patch("evoflow.proactive.repositories.ProactiveRepository.get_role", lambda c: role),
        patch("evoflow.proactive.work_items.all_referenced_tasks_done", lambda *a, **k: (False, [])),
        # 【第100轮】带 related_task_id 时 runner 会用真实 get_project_storage 读任务行；
        # 本批用例只验「会话键怎么算」，不该碰真库（否则会把现网 Task 拉进单测）。
        patch("evoflow.proactive.work_items.load_work_item_task", lambda tid: None),
        patch.object(ProactiveRunner, "_dispatch_task_bg", _fake_bg),
    ):
        asyncio.run(
            runner.dispatch_task_fire_and_forget(
                CODE,
                "重启后自唤醒验证",
                source=source,
                from_agent="user",
                related_task_id=related,
                pinned_session_key=pinned,
            )
        )
    return seen


def _now_iso(offset_s: float = 0.0) -> str:
    """相对当前时间的 ISO 串（时效类用例必须这样造，否则时间一过就假红）。"""
    from datetime import UTC, datetime, timedelta

    return (datetime.now(UTC) + timedelta(seconds=offset_s)).isoformat()


def test_fire_and_forget_retargets_to_newer_human_screen(db, monkeypatch):
    """走 fire_and_forget 这条真实投递路径时，也必须投到用户最新的那屏。"""
    _seed(db, SK_OLD)
    _seed(db, SK_NEW)
    _add_msg(db, SK_OLD, 1, "user", _human("旧屏最后一句话"), "2026-11-20T17:43:29+08:00")
    _add_msg(db, SK_NEW, 1, "user", _human("用户在新屏发话"), "2026-11-20T18:55:00+08:00")

    seen = _fire_and_forget_with(db, monkeypatch, SK_OLD)
    assert seen.get("pinned_session_key") == SK_NEW, (
        f"fire_and_forget 仍投旧屏（{seen.get('pinned_session_key')}）—— "
        "看门狗/调度器走的就是这条路，用户会继续等一个不会来的回复"
    )


def test_fire_and_forget_keeps_pin_without_human_signal(db, monkeypatch):
    """库里没有任何真人信号时，必须原样保留调用方的键（零影响退化）。"""
    seen = _fire_and_forget_with(db, monkeypatch, SK_OLD)
    assert seen.get("pinned_session_key") == SK_OLD


# ── 第100轮：空钉派单必须自己找到「用户盯着的那一屏」 ────────────────────────
# 【self-evolution-bot · 2026-11-20 · 第100轮 · 模型:deepseek-v4.1-flash-1017】
# 为什么补这批：第99轮补的「空钉 + 引用 Task 兜底」是死代码 —— 它把
# latest_human_session_key() 的结果当旧钉传给 prefer_newest_human_session()，
# 而后者拿它和「最新屏」比，输入已是最新屏 → 恒返回 "kept" → 恒被判空、永不生效。
# 现网铁证（2026-11-20 19:26:55）：同一条派单 2611201925_1415 投了两拨，
# 带键那条落 ...chat:2026-11-19T16-15-39.290Z（用户可见），
# source=task_assigned 空钉那条落 dispatch:2026-11-20T19-26-55…（task 桶，不可见）。
# 判据：断言交给 _dispatch_task_bg 的 pinned_session_key 值，不能只断言函数返回值。


def test_fire_and_forget_adopts_newest_human_screen_when_unpinned(db, monkeypatch):
    """不带钉 + 人为来源 → 必须投该岗最新真人屏，而不是另起 task/duty 桶。"""
    _seed(db, SK_OLD)
    _seed(db, SK_NEW)
    _add_msg(db, SK_OLD, 1, "user", _human("旧屏"), _now_iso(-7200))
    _add_msg(db, SK_NEW, 1, "user", _human("用户正在这屏说话"), _now_iso(-120))

    seen = _fire_and_forget_with(db, monkeypatch, "", source="task_assigned", related="t-probe-0001")
    assert seen.get("pinned_session_key") == SK_NEW, (
        f"空钉派单落到 {seen.get('pinned_session_key')!r}（应为 {SK_NEW}）—— "
        "这正是 19:26:55 那条 task_assigned 投错屏的路径"
    )


def test_fire_and_forget_unpinned_skips_automation_sources(db, monkeypatch):
    """定时/巡检/心跳/eval 派单不得抢用户视线：参数化逐个验，一个都不能投真人屏。"""
    _seed(db, SK_NEW)
    _add_msg(db, SK_NEW, 1, "user", _human("用户正在这屏说话"), _now_iso(-60))

    for src in ("eval", "scheduler", "scheduled", "heartbeat", "patrol", "cron", "timer", "system", "internal"):
        seen = _fire_and_forget_with(db, monkeypatch, "", source=src)
        assert seen.get("pinned_session_key") == "", (
            f"source={src} 抢了用户屏（{seen.get('pinned_session_key')}）—— 自动化轮不该出现在用户对话里"
        )


def test_fire_and_forget_unpinned_ignores_stale_screen(db, monkeypatch):
    """最新真人屏是几天前的 → 不投它（投进三天前的对话比落 task 桶更糟）。"""
    _seed(db, SK_NEW)
    _add_msg(db, SK_NEW, 1, "user", _human("三天前说过的话"), _now_iso(-3 * 86400))

    seen = _fire_and_forget_with(db, monkeypatch, "", source="role")
    assert seen.get("pinned_session_key") == ""
    assert seen.get("pinned_session_key") != SK_NEW


def test_fire_and_forget_existing_pin_still_wins_over_adoption(db, monkeypatch):
    """调用方已钉了键时，第100轮的新兜底不得覆盖它（只处理空钉）。"""
    _seed(db, SK_OLD)
    _seed(db, SK_NEW)
    _add_msg(db, SK_OLD, 1, "user", _human("旧屏"), _now_iso(-30))
    _add_msg(db, SK_NEW, 1, "user", _human("更新的一屏"), _now_iso(-10))

    seen = _fire_and_forget_with(db, monkeypatch, SK_OLD, source="role")
    # 已钉键走原 prefer 语义：新屏比旧屏新 20s < 60s 最小间隔 → kept
    assert seen.get("pinned_session_key") == SK_OLD


def test_fire_and_forget_adoption_never_crosses_agent(db, monkeypatch):
    """最新真人屏属于别的岗位 → 宁可不投，也不能把本轮投进同事的对话。"""
    _seed(db, SK_OTHER)
    _add_msg(db, SK_OTHER, 1, "user", _human("在发版工程师那屏说话"), _now_iso(-60))

    seen = _fire_and_forget_with(db, monkeypatch, "", source="role")
    assert seen.get("pinned_session_key") == "", "跨岗污染：本轮被投进了别的岗位会话"


def test_dispatch_prefers_human_screen_helper_contract():
    """辅助函数的取值域契约（防止以后有人把它改成「白名单」漏掉新来源）。"""
    from evoflow.proactive.runner import _dispatch_prefers_human_screen

    for src in ("", "manual", "role", "user", "xiaomi", "task_assigned", "user_item", "unknown_new_source"):
        assert _dispatch_prefers_human_screen(src) is True, src
    for src in ("eval", "EVAL", "scheduler", "Heartbeat", "patrol"):
        assert _dispatch_prefers_human_screen(src) is False, src


def test_human_screen_fresh_enough_boundaries():
    """时效判据边界：空/坏串放行，超 6h 拦，3h 放。"""
    from evoflow.proactive.runner import _human_screen_fresh_enough

    assert _human_screen_fresh_enough("") is True
    assert _human_screen_fresh_enough("not-a-timestamp") is True
    assert _human_screen_fresh_enough(_now_iso(-3 * 3600)) is True
    assert _human_screen_fresh_enough(_now_iso(-7 * 3600)) is False
