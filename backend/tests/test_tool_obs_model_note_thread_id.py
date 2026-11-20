"""【fullstack-dev · 2026-11-14 · 第6轮】回归护栏（方案甲由本岗定位并指定，release-engineer 落地代码与本测试）。

为什么必须有这个文件：缺陷特征是「不报错、只是不出数」，函数级自测全绿也会溜过去。
断言口径：慢调用 + 可得 thread_id ⇒ 尾注含「模型侧:」；拿不到 tid ⇒ 整段静默缺席（不许瞎猜上一轮）。

2026-11-14 真因（release-engineer 端到端复现）：_format_obs_note 的六个调用点
（wrap_tool_call / awrap_tool_call 各三处）没有一个传 thread_id，且这两个函数
作用域内根本没有 tid 变量；_log_tool_call_io 内部算出了 tid_raw 却只回传
duration_ms/queue_wait_ms/timing，把它丢了。于是 _last_model_note 永远收到
['']，「模型侧:」在子 Agent / proactive 线程里静默缺席 —— 特征就是**不报错、
只是不出数**，没有断言下次还会同样溜过去。

修法（方案甲 · 单点改动）：
- _log_tool_call_io 的 return dict 增加 "thread_id": tid_raw or None；
- _format_obs_note 取值链改为 thread_id or data.get("thread_id") or ambient。
六调用点零改动。
"""

from __future__ import annotations

import pytest

from evoflow.agents.middlewares import tool_error_handling_middleware as mw


@pytest.fixture(autouse=True)
def _clear_model_note_cache():
    mw._MODEL_NOTE_CACHE.clear()
    yield
    mw._MODEL_NOTE_CACHE.clear()


class _FakeRequest:
    """最小 ToolCallRequest 替身：runtime.context 带 thread_id（同现网 proactive 形态）。"""

    def __init__(self, thread_id: str):
        self.runtime = type("RT", (), {"context": {"thread_id": thread_id}, "config": None})()


def _patch_obs_queries(monkeypatch, rows):
    """桩掉 `list_model_invocations`，记录 kwargs；返回 calls 列表。

    【self-evolution-bot · 2026-11-20 · 第92轮 · 模型:deepseek-v4.1-flash-1017】
    原来这里是 `monkeypatch.setitem(sys.modules, "evoflow.observability.queries", _Q)`
    ——把自己造的空壳模块塞进 `sys.modules`。它只在「真模块还没被 import 过」时
    才生效：一旦 `evoflow.observability.queries` 已经被真实导入（全量套件 3000+
    用例里必然发生），`from evoflow.observability import queries` 走的是**包属性**
    快照，拿到真实模块，桩完全不生效 → 用例去查真库，本机没有 thread 对应的
    model invocation 记录 → 尾注退化成 `[obs] 5000ms · 慢调用`，两条红。
    证据：`test_platform_readback_hygiene.py` + 本文件合跑 28 passed（真模块尚未
    导入时桩生效）；全量跑必然红，且报错正是「没有 模型侧」而非抛错。
    修法：打在**被测模块自己持有的名字**上（`mw` 在函数内 `from ... import
    queries as obs_queries`），并让 `monkeypatch.setattr` 负责还原——这才是
    「无论前面跑过什么，桩都生效」的写法。
    """

    calls: list[dict] = []

    class _Q:
        @staticmethod
        def list_model_invocations(**kwargs):
            calls.append(kwargs)
            return {"items": rows}

    import evoflow.observability.queries as _real_queries

    monkeypatch.setattr(_real_queries, "list_model_invocations", _Q.list_model_invocations)
    return calls


def test_log_tool_call_io_returns_thread_id(monkeypatch):
    """核心断言 1：_log_tool_call_io 必须把已解析好的 tid 回传（此前在 L396 被丢弃）。"""

    _patch_obs_queries(monkeypatch, [])
    # recorder 不可用也无妨：tid 解析在 try 前半段，return dict 不受落库影响。
    obs = mw._log_tool_call_io(
        tool_name="read",
        tool_call_id="call-1",
        tool_input={"path": "x"},
        tool_output="ok",
        status="success",
        duration_ms=7363.0,
        request=_FakeRequest("tid-fixed"),
    )
    assert obs.get("thread_id") == "tid-fixed"
    assert obs["duration_ms"] == 7363.0


def test_slow_call_with_thread_id_emits_model_side(monkeypatch):
    """核心断言 2（发版工程师点名要的）：慢调用 + 可得 thread_id ⇒ 尾注含「模型侧:」。

    关键构造：obs dict 走 _log_tool_call_io 的真实返回形态（带 thread_id），
    而 **ambient get_config() 取不到 tid**（模拟子 Agent/proactive 线程），
    且不显式传 thread_id 参数 —— 正是现网六个调用点的真实接线方式。
    """

    calls = _patch_obs_queries(
        monkeypatch,
        [{"first_token_latency_ms": 900.0, "latency_ms": 4300.0, "model": "qwen3.8-flash"}],
    )
    # ambient 失效：只有 obs["thread_id"] 这条路能拿到 tid。
    monkeypatch.setattr(mw, "_current_thread_id_for_log", lambda: "")
    monkeypatch.delenv("EVOFLOW_TOOL_OBS_NOTE", raising=False)
    monkeypatch.delenv("EVOFLOW_TOOL_OBS_MODEL_NOTE", raising=False)

    note = mw._format_obs_note(
        tool_name="bash",
        status="success",
        obs={
            "duration_ms": 7363.0,
            "queue_wait_ms": None,
            "timing": None,
            "thread_id": "tid-fixed",
        },
    )
    assert "模型侧:" in note, f"静默缺席复发：{note!r}"
    assert "TTFT 0.9s" in note and "model 4.3s" in note and "qwen3.8-flash" in note
    # 查询必须带上正确的 thread_id 与收紧后的 invocation_kind。
    assert calls and calls[-1]["thread_id"] == "tid-fixed"
    assert calls[-1]["invocation_kind"] == "main"


def test_no_thread_id_anywhere_stays_silent(monkeypatch):
    """无 tid（obs 不带 + ambient 也取不到）→ 整段不出，但绝不抛错。"""

    calls = _patch_obs_queries(monkeypatch, [{"latency_ms": 1.0, "model": "m"}])
    monkeypatch.setattr(mw, "_current_thread_id_for_log", lambda: "")
    note = mw._format_obs_note(
        tool_name="bash",
        status="success",
        obs={"duration_ms": 9999.0, "queue_wait_ms": None, "timing": None},
    )
    assert "模型侧:" not in note
    assert not calls  # 空 tid 直接短路，不查库


def test_explicit_thread_id_arg_still_wins(monkeypatch):
    """显式传参优先级不变（第四轮验收过的那行不能被本轮改破）。"""

    calls = _patch_obs_queries(monkeypatch, [{"first_token_latency_ms": 1300.0, "latency_ms": 7400.0, "model": "qwen3.8-flash"}])
    monkeypatch.setattr(mw, "_current_thread_id_for_log", lambda: "")
    note = mw._format_obs_note(
        tool_name="bash",
        status="success",
        obs={"duration_ms": 5000.0, "thread_id": "from-obs"},
        thread_id="explicit-tid",
    )
    assert "模型侧: TTFT 1.3s · model 7.4s · qwen3.8-flash" in note
    assert calls[-1]["thread_id"] == "explicit-tid"
