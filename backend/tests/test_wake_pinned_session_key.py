"""wake/dispatch 必须能把本轮投回调用方指定的那一屏对话（session_key 穿透）。

【self-evolution-bot · 2026-11-17 · 第28轮】为什么要有这个文件：
用户原话「员工的 wake 不好，因为续不上当前我这个对话」。查实根因不是机制缺失 ——
第17轮已经给 `engine.think` / `runner._process_role` /
`runner.dispatch_task_fire_and_forget` 全都加了 `pinned_session_key`，但**最外层 5 处没接线**：
`DispatchTaskRequest` 无 `session_key` 字段、dispatch 端点不透传、`admin.dispatch()` 不收、
`admin.wake()` 不收、CLI 无 `--session-key`。键在外面被丢掉，里面接得再好也收不到值。

这 5 层任何一层再断，下面断言必须变红。断言全部离线（不连网关、不跑 LLM）。
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

import pytest

from evoflow.admin import employees as emp
from evoflow.proactive import router as pr
from evoflow.proactive.chat_session import normalize_pinned_session_key

SK = "proactive:self-evolution-bot:chat:2026-11-16T11-40-50.047Z"


# ── 第 1 层：HTTP 请求模型必须收得到这个字段 ────────────────────────────────
def test_dispatch_request_model_accepts_session_key():
    req = pr.DispatchTaskRequest(goal="验证装完机回到同一屏", session_key=SK)
    assert req.session_key == SK


def test_dispatch_request_session_key_defaults_empty():
    """默认必须是空串 —— 空 = 原行为，不能改变任何现有调用方的分桶。"""
    req = pr.DispatchTaskRequest(goal="普通派发")
    assert req.session_key == ""


# ── 第 2 层：dispatch 端点必须把它透传给 runner ─────────────────────────────
def test_dispatch_endpoint_passes_pinned_session_key_to_runner():
    captured: dict = {}

    async def _fake_dispatch(agent_code, goal, **kwargs):
        captured.update(kwargs)
        captured["_agent"] = agent_code
        captured["_goal"] = goal
        return {"ok": True, "dispatched": True}

    fake_runner = SimpleNamespace(dispatch_task_fire_and_forget=_fake_dispatch)
    req = pr.DispatchTaskRequest(goal="验证装完机回到同一屏", session_key=SK)

    import asyncio

    with (
        patch.object(pr, "_require_role_agent", lambda *a, **k: None),
        patch.object(pr, "_get_proactive_runner", lambda: fake_runner),
        patch(
            "evoflow.config.agents_config.load_agent_config",
            lambda code: SimpleNamespace(agent_code=code),
        ),
    ):
        out = asyncio.run(pr.dispatch_task(SimpleNamespace(), "self-evolution-bot", req))

    assert out.get("ok") is True
    # 关键断言：键必须真的到了 runner 手上（名字是 pinned_session_key）
    assert captured.get("pinned_session_key") == SK


def test_dispatch_endpoint_sends_empty_key_when_not_given():
    captured: dict = {}

    async def _fake_dispatch(agent_code, goal, **kwargs):
        captured.update(kwargs)
        return {"ok": True, "dispatched": True}

    fake_runner = SimpleNamespace(dispatch_task_fire_and_forget=_fake_dispatch)
    req = pr.DispatchTaskRequest(goal="普通派发")

    import asyncio

    with (
        patch.object(pr, "_require_role_agent", lambda *a, **k: None),
        patch.object(pr, "_get_proactive_runner", lambda: fake_runner),
        patch(
            "evoflow.config.agents_config.load_agent_config",
            lambda code: SimpleNamespace(agent_code=code),
        ),
    ):
        asyncio.run(pr.dispatch_task(SimpleNamespace(), "self-evolution-bot", req))

    # 空串 = 不钉会话，退回 task/duty 自动分桶（原行为）
    assert captured.get("pinned_session_key") == ""


# ── 第 3 层：admin.dispatch() 必须收参数并放进 HTTP payload ────────────────
def test_admin_dispatch_puts_session_key_into_payload():
    role = SimpleNamespace(agent_code="self-evolution-bot", role_name="自我进化BOT", status="active")
    sent: dict = {}

    class _Resp:
        status_code = 200
        content = b"{}"

        def json(self):
            return {"ok": True}

    class _Client:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def post(self, url, json=None):
            sent["url"] = url
            sent["payload"] = json
            return _Resp()

    with (
        patch.object(emp.ProactiveRepository, "get_role", return_value=role),
        patch("evoflow.proactive.work_items.all_referenced_tasks_done", lambda *a, **k: (False, [])),
        patch("evoflow.proactive.runner.get_proactive_runner", lambda: None),
        patch("httpx.Client", lambda **kw: _Client()),
    ):
        emp.dispatch("self-evolution-bot", "goal", session_key=SK)

    assert sent["payload"].get("session_key") == SK


def test_admin_dispatch_omits_session_key_when_empty():
    role = SimpleNamespace(agent_code="self-evolution-bot", role_name="自我进化BOT", status="active")
    sent: dict = {}

    class _Resp:
        status_code = 200
        content = b"{}"

        def json(self):
            return {"ok": True}

    class _Client:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def post(self, url, json=None):
            sent["payload"] = json
            return _Resp()

    with (
        patch.object(emp.ProactiveRepository, "get_role", return_value=role),
        patch("evoflow.proactive.work_items.all_referenced_tasks_done", lambda *a, **k: (False, [])),
        patch("evoflow.proactive.runner.get_proactive_runner", lambda: None),
        patch("httpx.Client", lambda **kw: _Client()),
    ):
        emp.dispatch("self-evolution-bot", "goal")

    # 不钉会话时不发该字段，避免给下游制造"空键"歧义
    assert "session_key" not in sent["payload"]


# ── 第 4 层：admin.wake() 必须把键一路传到 dispatch() ──────────────────────
def test_admin_wake_forwards_session_key_to_dispatch():
    target = SimpleNamespace(agent_code="self-evolution-bot", role_name="自我进化BOT", status="active")
    seen: dict = {}

    def _fake_dispatch(agent_code, goal, **kwargs):
        seen.update(kwargs)
        seen["_agent"] = agent_code
        return {"ok": True, "dispatched": True}

    with (
        patch.object(emp, "resolve_role_ref", lambda t: target),
        patch("evoflow.proactive.work_items.all_referenced_tasks_done", lambda *a, **k: (False, [])),
        patch.object(emp, "dispatch", _fake_dispatch),
    ):
        emp.wake("self-evolution-bot", "验证装完机回到同一屏", from_agent="user", session_key=SK)

    assert seen.get("session_key") == SK


# ── 第 5 层：CLI --session-key 必须解析进 args 并传给 admin.wake ───────────
def test_cli_wake_parses_session_key():
    from evoflow.cli.main import build_parser

    parser = build_parser(["employees"])
    args = parser.parse_args(["employees", "wake", "self-evolution-bot", "--session-key", SK])
    assert args.session_key == SK


def test_cli_wake_handler_passes_session_key_to_admin():
    from evoflow.cli.commands import employees as cli_emp

    seen: dict = {}

    def _fake_wake(target, goal, **kwargs):
        seen.update(kwargs)
        seen["_target"] = target
        return {"ok": True}

    args = SimpleNamespace(
        target="self-evolution-bot",
        goal="验证",
        from_agent="user",
        task_id="",
        description="",
        priority="normal",
        source="role",
        round_id="",
        resume_round=False,
        fresh_round=False,
        session_key=SK,
    )

    with patch("evoflow.admin.employees.wake", _fake_wake):
        cli_emp._wake(args)

    assert seen.get("session_key") == SK


# ── 守卫不能被绕过：别人的键/ambient 键/老键一律丢弃 ───────────────────────
@pytest.mark.parametrize(
    "raw,expected",
    [
        (SK, SK),  # 自己的真人对话键：认
        ("proactive:other-agent:chat:x", ""),  # 别人的会话：拒
        ("agent:main:new-10a8acbd", ""),  # 平台 ambient 键：拒
        ("proactive:self-evolution-bot", ""),  # 老键没有 kind：拒
        ("", ""),
    ],
)
def test_pinned_key_ownership_guard(raw, expected):
    assert normalize_pinned_session_key("self-evolution-bot", raw) == expected


# ── 第 7 层（第28轮补）：最后一米 —— fire_and_forget 内部必须把键交给 _dispatch_task_bg ──
# 为什么补这条：上面 6 层全绿时，wake 仍然新开了 thread。
# 实测（2026-11-17 00:46）CLI 带 --session-key 调用后，消息落在
# `proactive:self-evolution-bot:task:2611162352_529a`（新 thread 7db2ab9e），
# 不是用户那一屏 5ccb4e01。根因是 dispatch_task_fire_and_forget 收到键后，
# 创建后台任务时漏传该参数 —— 键在函数入口被静默丢弃。
def test_fire_and_forget_forwards_key_to_bg_dispatch():
    from evoflow.proactive import runner as rn

    captured: dict = {}
    role = SimpleNamespace(agent_code="self-evolution-bot", role_name="自我进化BOT", status="active")

    async def _fake_bg(*args, **kwargs):
        captured.update(kwargs)

    class _R:
        _bg_tasks: set = set()
        _reserve_role = staticmethod(lambda code: _async_true())
        _dispatch_task_bg = staticmethod(_fake_bg)

    async def _async_true():
        return True

    import asyncio

    with (
        patch.object(rn.ProactiveRepository, "get_role", lambda code: role),
        patch.object(rn, "resolve_dispatch_round_id", lambda **k: ("round-x", True)),
        patch.object(rn, "validate_dispatch_org_relationship", lambda **k: ""),
        patch("evoflow.proactive.work_items.all_referenced_tasks_done", lambda *a, **k: (False, [])),
    ):
        asyncio.run(
            rn.ProactiveRunner.dispatch_task_fire_and_forget(
                _R(),  # type: ignore[arg-type]
                "self-evolution-bot",
                "验证装完机回到同一屏",
                related_task_id="t-1",
                resume_round=True,
                pinned_session_key=SK,
            )
        )
        # 后台 task 可能尚未被事件循环跑完，直接看 create_task 的入参
        # （_fake_bg 是协程函数，create_task 会立即构造协程对象但不执行）
    assert captured.get("pinned_session_key") == SK


def test_fire_and_forget_bg_dispatch_defaults_empty():
    """不传键时必须保持原行为（空串 → task/duty 自动分桶），不能凭空造键。"""
    from evoflow.proactive import runner as rn

    captured: dict = {}
    role = SimpleNamespace(agent_code="self-evolution-bot", role_name="自我进化BOT", status="active")

    async def _fake_bg(*args, **kwargs):
        captured.update(kwargs)

    class _R:
        _bg_tasks: set = set()
        _reserve_role = staticmethod(lambda code: _async_true())
        _dispatch_task_bg = staticmethod(_fake_bg)

    async def _async_true():
        return True

    import asyncio

    with (
        patch.object(rn.ProactiveRepository, "get_role", lambda code: role),
        patch.object(rn, "resolve_dispatch_round_id", lambda **k: ("round-x", True)),
        patch.object(rn, "validate_dispatch_org_relationship", lambda **k: ""),
        patch("evoflow.proactive.work_items.all_referenced_tasks_done", lambda *a, **k: (False, [])),
    ):
        asyncio.run(
            rn.ProactiveRunner.dispatch_task_fire_and_forget(
                _R(),  # type: ignore[arg-type]
                "self-evolution-bot",
                "普通叫醒",
                related_task_id="t-2",
            )
        )
    assert captured.get("pinned_session_key") == ""


# ── 第 8 层（第28轮补）：岗位忙时走排队分支，键也不能丢 ──────────────────
def test_enqueue_pending_wake_keeps_session_key():
    from evoflow.proactive import runner as rn

    captured: dict = {}
    role = SimpleNamespace(agent_code="self-evolution-bot", role_name="自我进化BOT", status="active")

    class _R:
        _wake_queue: dict = {}
        _wake_queue_guard = None
        _inflight_started_at: dict = {}

    import asyncio

    class _Guard:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

    r = _R()
    r._wake_queue_guard = _Guard()

    with patch.object(rn.ProactiveRepository, "get_role", lambda code: role):
        import inspect

        sig = inspect.signature(rn.ProactiveRunner._enqueue_pending_wake)
        assert "pinned_session_key" in sig.parameters, "排队分支签名必须收会话键"
        asyncio.run(
            rn.ProactiveRunner._enqueue_pending_wake(
                r,  # type: ignore[arg-type]
                "self-evolution-bot",
                "忙时叫醒",
                related_task_id="t-3",
                pinned_session_key=SK,
            )
        )
    entry = (r._wake_queue.get("self-evolution-bot") or [{}])[0]
    assert entry.get("pinned_session_key") == SK, "排队条目必须记住回哪一屏"
