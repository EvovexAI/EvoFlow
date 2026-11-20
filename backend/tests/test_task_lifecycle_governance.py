# 【self-evolution-bot · 2026-11-20 · 第86轮 · 模型:deepseek-v4.1-flash-1017】任务台账生命周期治理回归。
"""任务台账生命周期治理（第86轮，用户拍板"弄成企业级"）。

覆盖四组改动，判据全部来自现网 293 条主单取证：
1. task_status：paused 是 reclaim 在写的**非法态**（词表/转换表都没有）→ 补边。
2. create_task 去重闸：storage.find_open_main_task_id_by_name 写好后 0 调用（死代码），
   同题未结单反复新建（「电商内容台单品洞察」×19、「验证N6」×12）→ 接进唯一漏斗。
   接线测法：mock find_open_main_task_id_by_name，断言 create_task 真的在调它、
   allow_duplicate/probe 真的绕过、报错文本真的带旧单 id（不能只测函数层——第12/14轮教训）。
3. set_task_state 的 started_at：现网 262 条已结单 153 条（58%）无 started_at。
   executing 落章；completed/awaiting_close/failed 无章时用 created_at 回填并打
   started_at_estimated。接线测法：mock 读写层，捕获真正落盘的 patch 字典。
4. 探针单折叠 + stale paused 收口：纯函数判据 + 反证（正常业务单不许命中）。
"""

from __future__ import annotations

import importlib
from datetime import UTC, datetime, timedelta

import pytest

task_status = importlib.import_module("evoflow.collab.task_status")
task_noise = importlib.import_module("evoflow.collab.task_noise")
task_reclaim = importlib.import_module("evoflow.collab.task_reclaim")


# ── 1) paused 词表 / 转换表 ────────────────────────────────────────────────


def test_paused_is_a_known_state() -> None:
    assert "paused" in task_status.ALLOWED_TASK_STATES
    assert task_status.status_zh("paused") == "已暂停"


def test_executing_can_pause_and_paused_can_revive() -> None:
    # task_reclaim.stuck_executing_dead 写的就是 paused；没有这条边收口只能走强改旁路。
    assert task_status.can_transition("executing", "paused")
    assert task_status.can_transition("paused", "executing")  # 复活续跑
    assert task_status.can_transition("paused", "cancelled")  # 放弃收口
    # 反证：paused 不许跳回 pending（词表不许无限膨胀出第二条复活路径）
    assert not task_status.can_transition("paused", "pending")


def test_is_open_status_covers_board_live_states() -> None:
    for s in ("pending", "executing", "paused", "awaiting_close", "waiting_user"):
        assert task_status.is_open_status(s), s
    for s in ("completed", "reviewed", "cancelled", "failed", "timed_out", ""):
        assert not task_status.is_open_status(s), s


# ── 2) create_task 去重闸（接线测试：mock 判据函数，断言漏斗真调它）────────


@pytest.fixture()
def create_capture(monkeypatch):
    """把 admin.tasks 的存储读写全打桩，捕获 create_task 的行为。"""
    admin = importlib.import_module("evoflow.admin.tasks")

    calls: dict = {"dup_lookup": None, "saved": None}

    def _fake_find_open(storage, name, *, assignee=None):
        calls["dup_lookup"] = {"name": name, "assignee": assignee}
        return calls.get("dup_id") or None

    def _fake_bundle(name, description, **kw):
        project = {"id": "p1", "name": name, "tasks": []}
        task = {"id": "t-new", "name": name, "description": description, "status": "pending"}
        project["tasks"].append(task)
        return project, task

    def _fake_save(project):
        calls["saved"] = project
        return True

    class _DuckSave:
        def save_project(self, project):
            calls["saved"] = project
            return True

    monkeypatch.setattr(admin, "find_open_main_task_id_by_name", _fake_find_open)
    monkeypatch.setattr(admin, "new_project_bundle_root_task", _fake_bundle)
    monkeypatch.setattr(admin, "get_project_storage", lambda: _DuckSave())
    import evoflow.collab.storage as st_mod

    monkeypatch.setattr(st_mod, "find_main_task", lambda *a, **k: None)
    import evoflow.collab.task_assignee as ta

    class _Res:
        def __init__(self, code: str):
            self.code = code
            self.role_name = "发版工程师"
            self.is_fallback = False
            self.source = "code"

    # 替身必须回显入参归属（写死一个 code 会吞掉被测行为本身）
    def _fake_resolve(assignee, **kw):
        want = str(assignee or "").strip()
        if want:
            return _Res(want)
        return _Res("release-engineer") if kw.get("allow_fallback", True) else _Res("")

    monkeypatch.setattr(ta, "resolve_task_assignee", _fake_resolve)
    from evoflow.proactive import task_startup_accelerator as acc

    monkeypatch.setattr(acc, "maybe_wake_agent_for_new_task", lambda *a, **k: False)
    # 每测重建 dup_id
    calls["dup_id"] = None
    return admin, calls


def test_dedupe_gate_blocks_same_title_open_task(create_capture) -> None:
    from evoflow.admin.errors import ValidationError

    admin, calls = create_capture
    calls["dup_id"] = "2611071414_890a"
    with pytest.raises(ValidationError) as e:
        admin.create_task(name="电商内容台单品洞察", assignee="release-engineer")
    # 报错必须点名旧单 id + 出路（allow_duplicate），否则调用方只能瞎猜（报错文案纪律）
    assert "2611160" in str(e.value) or "2611071414_890a" in str(e.value)
    assert "allow_duplicate" in str(e.value)
    assert calls["saved"] is None, "被拦下却仍落库 = 静默双建"


def test_dedupe_gate_lookup_carries_title_and_assignee(create_capture) -> None:
    admin, calls = create_capture
    calls["dup_id"] = "X1"
    from evoflow.admin.errors import ValidationError

    with pytest.raises(ValidationError):
        admin.create_task(name="抖音博主分析技能注入后启动", assignee="douyin-blogger-analyst")
    assert calls["dup_lookup"] == {
        "name": "抖音博主分析技能注入后启动",
        "assignee": "douyin-blogger-analyst",
    }, "去重判据没带归属 = 跨员工同名被误拦"


def test_allow_duplicate_escapes_gate(create_capture) -> None:
    admin, calls = create_capture
    calls["dup_id"] = "X1"
    out = admin.create_task(
        name="同题单", assignee="release-engineer", allow_duplicate=True
    )
    assert calls["dup_lookup"] is None, "显式逃生门仍去查了重 = 开关没接上"
    assert out.get("task_id")


def test_probe_skips_gate_and_stamps_channel(create_capture) -> None:
    admin, calls = create_capture
    calls["dup_id"] = "X1"
    out = admin.create_task(name="__verify_round86__", assignee="self-evolution-bot", probe=True)
    assert calls["dup_lookup"] is None, "探针单还要过闸 = 自测链路被自己拦住"
    assert out.get("source_channel") == "dev_probe"


def test_unowned_create_not_scanned(create_capture) -> None:
    """无显式归属（小V 代建/eval）不扫重——判据只约束"同一员工同题未结"。"""
    admin, calls = create_capture
    calls["dup_id"] = "X1"
    admin.create_task(name="随手记个事", assignee=None)
    assert calls["dup_lookup"] is None


# ── 3) set_task_state 的 started_at（接线：捕获落盘 patch）────────────────


@pytest.fixture()
def state_capture(monkeypatch):
    admin = importlib.import_module("evoflow.admin.tasks")
    captured: dict = {}
    task_row = {
        "id": "T1",
        "name": "n",
        "status": "executing",
        "assigned_to": "release-engineer",
        "created_at": "2026-11-19T10:00:00+00:00",
        "started_at": None,
        "completed_at": None,
    }

    def _fake_patch(storage, tid, updates):
        captured["updates"] = updates
        return True

    from evoflow.collab import storage as st_mod

    monkeypatch.setattr(st_mod, "find_main_task", lambda *a, **k: ({"id": "p"}, task_row))
    monkeypatch.setattr(admin, "find_main_task", lambda *a, **k: ({"id": "p"}, task_row))
    monkeypatch.setattr(admin, "patch_collab_main_task_in_project_storage", _fake_patch)
    monkeypatch.setattr(admin, "_enforce_task_mutate_acl", lambda **k: None)
    monkeypatch.setattr(admin, "_enforce_round_initiative_quota", lambda **k: None)
    from evoflow.collab import task_outputs as to_out

    monkeypatch.setattr(to_out, "workspace_root_for_task_row", lambda t: None)
    monkeypatch.setattr(to_out, "agent_code_for_task_row", lambda t: "release-engineer")
    return admin, captured, task_row


def test_executing_state_stamps_started_at(state_capture) -> None:
    admin, captured, row = state_capture
    row["status"] = "pending"
    admin.set_task_state("T1", "executing", actor="user")
    assert captured["updates"].get("started_at"), "executing 未落 started_at（58% 缺章的根因之一）"
    assert not captured["updates"].get("started_at_estimated")


def test_close_backfills_estimated_started_at(state_capture) -> None:
    admin, captured, row = state_capture
    admin.set_task_state("T1", "completed", summary="done", actor="user")
    u = captured["updates"]
    assert u.get("started_at") == row["created_at"]
    assert u.get("started_at_estimated") is True, "估算回填必须显式打标，度量端才能区分实测/估算"


def test_close_keeps_real_started_at(state_capture) -> None:
    admin, captured, row = state_capture
    row["started_at"] = "2026-11-19T11:00:00+00:00"
    admin.set_task_state("T1", "completed", summary="done", actor="user")
    u = captured["updates"]
    assert "started_at" not in u or u.get("started_at") == row["started_at"]
    assert not u.get("started_at_estimated"), "有真实章还被覆盖 = 把实测数据改成估算"


# ── 4) find_open_main_task_id_by_name 本体（鸭子 storage，不建真库）───────


class _DuckStorage:
    def __init__(self, tasks):
        self._tasks = tasks

    def list_projects(self):
        return [{"id": "p1"}]

    def load_project(self, pid):
        return {"tasks": self._tasks}


def test_dedupe_lookup_open_states_and_assignee() -> None:
    from evoflow.collab.storage import find_open_main_task_id_by_name

    st = _DuckStorage(
        [
            {"id": "A", "name": "单品洞察", "status": "executing", "assigned_to": "x"},
            {"id": "B", "name": "单品洞察", "status": "completed", "assigned_to": "x"},
            {"id": "C", "name": "单品洞察", "status": "paused", "assigned_to": "y"},
        ]
    )
    # 旧判据只认 pending/planning——executing 漏网正是 ×19 的成因；新判据必须命中 A
    assert find_open_main_task_id_by_name(st, "单品洞察", assignee="x") == "A"
    # 已结案（B）不算活着；跨员工（C 属 y）合法扇出，不塌缩
    assert find_open_main_task_id_by_name(st, "单品洞察", assignee="zz") is None


def test_dedupe_lookup_normalizes_title() -> None:
    # "重新/再次/继续…" 在 normalize_proactive_title 的前缀噪声表里 → 归一后应塌缩。
    # 边界（反证侧）：闸只塌"归一化后相等"，不做模糊相似——「处理：X」与「X」是
    # 不同语义的单（回执链），宁可漏拦不可误拦（第17轮守卫教训）。
    from evoflow.collab.storage import find_open_main_task_id_by_name

    st = _DuckStorage([{"id": "A", "name": "重新单品洞察", "status": "pending", "assigned_to": "x"}])
    assert find_open_main_task_id_by_name(st, "单品洞察", assignee="x") == "A", "前缀噪声没归一 = 同题两种写法漏拦"
    st2 = _DuckStorage([{"id": "B", "name": "处理：单品洞察", "status": "pending", "assigned_to": "x"}])
    assert find_open_main_task_id_by_name(st2, "单品洞察", assignee="x") is None, "语义不同的前缀不许被误塌"


# ── 5) 探针判据 + 反证（真业务单不许命中）────────────────────────────────


@pytest.mark.parametrize(
    "name",
    [
        "__verify_round29_session_key__",
        "__probe_session_key_field__",
        "第28轮锚点单：构建+重装+自唤醒验证（勿手动结案）",
        "[验证]2026-10-31-待办A",
    ],
)
def test_probe_names_hit(name: str) -> None:
    assert task_noise.is_probe_task_name(name), name


@pytest.mark.parametrize(
    "name",
    [
        "电商内容台单品洞察",  # 真业务（重复问题归去重闸管，不归探针折叠）
        "第31轮交付：索引中断根因（.tsx grammar）+ 状态接口报0",  # 交付单含"验证"语义但非探针
        "知识库检索验证：用 knowledge 工具回答水温推荐",  # 用户点的功能演示——raised_by=user 不算探针
        "处理：风格调教，立刻落地",
    ],
)
def test_probe_names_do_not_swallow_business(name: str) -> None:
    assert not task_noise.is_probe_task_name(name), f"误折叠业务单: {name}"


def test_probe_noise_channel_only_hides_open_rows() -> None:
    # 已结案的存量探针：列表端折叠（is_task_center_noise=True），
    # 但清理端不许再动历史数据（classify 返回 None）。
    done = {"name": "__verify_round29_session_key__", "status": "completed", "source_channel": "dev_probe"}
    assert task_noise.is_task_center_noise(done)
    assert task_noise.classify_noise_cleanup_reason(done) is None
    live = {"name": "第30轮锚点单：wake 端到端投回本屏验证", "status": "pending", "source_channel": None}
    assert task_noise.classify_noise_cleanup_reason(live) == "probe_open"


# ── 6) stale paused 收口（纯函数 + 时限）─────────────────────────────────


def _hours_ago(h: int) -> str:
    return (datetime.now(UTC) - timedelta(hours=h)).isoformat()


def test_stale_paused_with_closed_children_is_cancelled() -> None:
    row = {"id": "Z1", "name": "抖音脚本生产", "status": "paused", "updated_at": _hours_ago(643)}
    act = task_reclaim.classify_zombie_reclaim(row)
    assert act is not None and act["to_status"] == "cancelled" and act["reason"] == "stale_paused"


def test_recent_paused_untouched() -> None:
    row = {"id": "Z2", "name": "刚暂停的单", "status": "paused", "updated_at": _hours_ago(2)}
    assert task_reclaim.classify_zombie_reclaim(row) is None


def test_paused_with_open_subtree_survives(monkeypatch) -> None:
    """还有未闭子树 → 不许收口（宁慢勿错杀）。"""
    monkeypatch.setattr(
        task_reclaim,
        "_children_all_fully_closed",
        lambda tid: {"total": 3, "open": 1, "all_done": False, "open_rows": [{"task_id": "s", "status": "in_progress"}]},
    )
    row = {"id": "Z3", "name": "带活子树", "status": "paused", "updated_at": _hours_ago(643)}
    assert task_reclaim.classify_zombie_reclaim(row) is None
