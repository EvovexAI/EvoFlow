"""上下文占用自省提示（context_usage_hint）回归。

【self-evolution-bot · 2026-11-20 · 第94轮 · 模型:deepseek-v4.1-flash-1017】
为什么有这批用例：用户要的是「模型自己判断何时压缩」。前提是模型**每轮看得到
自己的占用率**——之前占用率只经 emit_context_usage() 发给前端 UI，模型看不到。
这批用例钉三条：低占用不注入（零噪声）、高占用注入且带真实数字、同文不重复堆叠。
"""

from __future__ import annotations

import pytest
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

from evoflow.agents.middlewares import context_usage_hint_middleware as hint_mod
from evoflow.agents.middlewares.context_usage_hint_middleware import (
    _HINT_NAME,
    ContextUsageHintMiddleware,
)


class _FakeRuntime:
    def __init__(self, session_key: str = "agent:main:hint") -> None:
        self.context = {"session_key": session_key, "thread_id": "tid-hint", "model_name": "test-model"}


def _big_transcript(rounds: int = 60):
    msgs = []
    for i in range(rounds):
        msgs.append(HumanMessage(content=f"第{i}轮提问：" + "细节描述。" * 200))
        msgs.append(AIMessage(content=f"第{i}轮回答：" + "处理结果。" * 200))
    return msgs


def _small_transcript():
    return [HumanMessage(content="你好"), AIMessage(content="在。")]


def _hint_texts(out) -> list[str]:
    if not out:
        return []
    return [
        str(getattr(m, "content", ""))
        for m in out.get("messages", [])
        if getattr(m, "name", None) == _HINT_NAME
    ]


@pytest.fixture
def patch_window(monkeypatch):
    """固定上下文窗口，让占用率可预测。"""

    def _set(window: int):
        monkeypatch.setattr(
            "evoflow.utils.model_context_length.resolve_model_context_length",
            lambda *a, **k: window,
        )

    return _set


def test_low_usage_does_not_inject(patch_window):
    patch_window(256_000)
    mw = ContextUsageHintMiddleware()
    out = mw.before_model({"messages": _small_transcript()}, _FakeRuntime())
    assert out is None, "低占用不该注入，否则每轮白占 token"


def test_high_usage_injects_with_real_numbers(patch_window):
    patch_window(8_000)  # 窗口调小 → 强制高占用
    mw = ContextUsageHintMiddleware()
    msgs = _big_transcript(10)
    out = mw.before_model({"messages": msgs}, _FakeRuntime())
    texts = _hint_texts(out)
    assert len(texts) == 1
    body = texts[0]
    assert "sessions.compact" in body, "提示必须告诉模型调哪个工具"
    assert "summary" in body, "提示必须说明参数名"
    # 必须带真实数字（模型据此判断，而不是靠感觉）
    assert "%" in body
    assert "tokens" in body
    assert "8000" in body or "8,000" in body


def test_same_hint_not_duplicated(patch_window):
    patch_window(40_000)  # 占用落在 60%~85% 的非强制区，才测得到去重
    mw = ContextUsageHintMiddleware()
    msgs = _big_transcript(10)
    first = mw.before_model({"messages": msgs}, _FakeRuntime())
    assert _hint_texts(first), "第一次应注入"

    # 【self-evolution-bot · 2026-11-20 · 第94轮 · 模型:deepseek-v4.1-flash-1017】
    # 改了什么：窗口从 8_000 提到 40_000。
    # 为什么：8_000 窗口下这批消息占用约 330%，落在 `_HINT_FORCE_PCT`(85%) 强制区，
    #   按新语义**每轮都该重注**（防漏掉最该压的那一刻），与「去重」用例的前提冲突。
    #   要测去重就必须把占用放进非强制区，否则测的是另一条规则。
    injected = first["messages"][0]
    second = mw.before_model({"messages": [*msgs, injected]}, _FakeRuntime())
    assert second is None, "占用没实质变化时不该重复堆叠进 state"


def test_hint_refreshes_when_usage_jumps(patch_window, monkeypatch):
    """占用涨了 5 个点以上必须重新注入 —— 否则模型拿着过期的数字做判断。"""
    patch_window(1_000_000)
    mw = ContextUsageHintMiddleware()
    msgs = _big_transcript(3)

    from evoflow.agents.context_compaction_core import compaction_token_snapshot as real

    def _snap_with(pct):
        def _f(m, context_length=0):
            return {**real(m, context_length=context_length), "pct_of_context": pct}

        return _f

    monkeypatch.setattr("evoflow.agents.context_compaction_core.compaction_token_snapshot", _snap_with(40.0))
    first = mw.before_model({"messages": msgs}, _FakeRuntime())
    assert _hint_texts(first)

    stale = first["messages"][0]
    # 43% —— 只涨 3 点，不刷新
    monkeypatch.setattr("evoflow.agents.context_compaction_core.compaction_token_snapshot", _snap_with(43.0))
    assert mw.before_model({"messages": [*msgs, stale]}, _FakeRuntime()) is None

    # 61% —— 涨 21 点，必须刷新
    monkeypatch.setattr("evoflow.agents.context_compaction_core.compaction_token_snapshot", _snap_with(61.0))
    out = mw.before_model({"messages": [*msgs, stale]}, _FakeRuntime())
    assert _hint_texts(out), "占用大幅上升必须重新注入新数字"


def test_threshold_boundary(patch_window, monkeypatch):
    """低于 35% 不注入，恰好跨过才注入。"""
    patch_window(1_000_000)
    mw = ContextUsageHintMiddleware()

    real_snap = hint_mod.__dict__  # noqa: F841  (保持对模块的引用，便于阅读)

    from evoflow.agents.context_compaction_core import compaction_token_snapshot as real

    monkeypatch.setattr(
        "evoflow.agents.context_compaction_core.compaction_token_snapshot",
        lambda msgs, context_length=0: {
            **real(msgs, context_length=context_length),
            "pct_of_context": 34.9,
        },
    )
    assert mw.before_model({"messages": _big_transcript(3)}, _FakeRuntime()) is None

    monkeypatch.setattr(
        "evoflow.agents.context_compaction_core.compaction_token_snapshot",
        lambda msgs, context_length=0: {
            **real(msgs, context_length=context_length),
            "pct_of_context": 35.1,
        },
    )
    out = mw.before_model({"messages": _big_transcript(3)}, _FakeRuntime())
    assert _hint_texts(out), "越过 35% 必须注入"


def test_hint_never_breaks_main_flow(monkeypatch):
    """注入失败必须静默返回 None，绝不阻断主流程。"""
    monkeypatch.setattr(
        "evoflow.utils.model_context_length.resolve_model_context_length",
        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")),
    )
    mw = ContextUsageHintMiddleware()
    assert mw.before_model({"messages": _big_transcript(2)}, _FakeRuntime()) is None


def test_hint_name_is_hidden_synthetic():
    """注入名必须在隐藏白名单里，否则会被当成真实用户轮污染 user_requests。"""
    from evoflow.agents.message_analysis_utils import is_synthetic_user_message

    assert is_synthetic_user_message(SystemMessage(name=_HINT_NAME, content="x")) is True


def test_hint_message_is_system_named():
    m = SystemMessage(name=_HINT_NAME, content="x")
    assert getattr(m, "name", None) == _HINT_NAME


# ── 判据分层：模型要看到「什么档位该压」而不是一句模糊建议 ───────────────────
# 【self-evolution-bot · 2026-11-20 · 第94轮 · 模型:deepseek-v4.1-flash-1017】
# 改了什么：新增 3 条用例钉「三档文案」与「高占用强制重注」。
# 为什么（用户点破）：「模型什么时候能知道要压缩？是什么时间段节点、什么判据？
#   要不然可能很长很长都不会触发」。原提示只有一句「收尾了可以考虑压」——
#   没有量化阈值、也没说「不自己写会怎样」，模型可以一路推到 90% 交给自动压缩，
#   那时由压缩模型代写，质量不如自己写。
def _snap_pct(monkeypatch, pct: float):
    from evoflow.agents.context_compaction_core import compaction_token_snapshot as real

    monkeypatch.setattr(
        "evoflow.agents.context_compaction_core.compaction_token_snapshot",
        lambda msgs, context_length=0: {
            **real(msgs, context_length=context_length),
            "pct_of_context": pct,
        },
    )


@pytest.mark.parametrize(
    "pct,expect_kw,forbid_kw",
    [
        (40.0, "可以压但不急", "该压了"),
        (65.0, "建议压", "可以压但不急"),
        (88.0, "该压了", "可以压但不急"),
    ],
)
def test_hint_tiers_match_usage(patch_window, monkeypatch, pct, expect_kw, forbid_kw):
    """三档判据必须按占用率切换，不能只用一句通用建议。"""
    patch_window(1_000_000)
    _snap_pct(monkeypatch, pct)
    mw = ContextUsageHintMiddleware()
    out = mw.before_model({"messages": _big_transcript(3)}, _FakeRuntime())
    texts = _hint_texts(out)
    assert texts, f"{pct}% 应注入提示"
    body = texts[0]
    assert expect_kw in body, f"{pct}% 档位文案缺失，实际：{body[:200]}"
    assert forbid_kw not in body, f"{pct}% 不该出现别的档位文案"


def test_hint_high_usage_explains_consequence(patch_window, monkeypatch):
    """≥85% 必须说清「不自己写就被压缩模型代写」——这是唯一的真实后果。"""
    patch_window(1_000_000)
    _snap_pct(monkeypatch, 90.0)
    mw = ContextUsageHintMiddleware()
    body = _hint_texts(mw.before_model({"messages": _big_transcript(3)}, _FakeRuntime()))[0]
    assert "另一个压缩模型" in body or "自动压缩" in body
    assert "quality" not in body.lower()


def test_high_usage_forces_reinject_despite_dedup(patch_window, monkeypatch):
    """≥85% 时即使与上一条只差 3 个点，也必须重新注入（防漏掉最该压的那一刻）。"""
    patch_window(1_000_000)
    mw = ContextUsageHintMiddleware()
    msgs = _big_transcript(3)

    _snap_pct(monkeypatch, 86.0)
    first = mw.before_model({"messages": msgs}, _FakeRuntime())
    assert _hint_texts(first)
    stale = first["messages"][0]

    # 89%：只涨 3 点（< _HINT_REFRESH_PCT=5），但已在强制区 → 必须重注
    _snap_pct(monkeypatch, 89.0)
    again = mw.before_model({"messages": [*msgs, stale]}, _FakeRuntime())
    assert _hint_texts(again), "高占用区不该被 5 点去重吞掉"


# 【self-evolution-bot · 2026-11-20 · 第96轮 · 模型:deepseek-v4.1-flash-1017】
# 为什么补这批：提示此前**无条件**写「调用 platform(action="sessions.compact")」，
# 但 platform 对员工是 opt-in——现网 57 个岗位只有约 10 个挂了它
# （tech-director / release-engineer 都没挂）。对剩下那批岗位，这句提示等于把模型
# 指向一个自己工具箱里不存在的工具，照着做只会拿到「未知工具」，白烧一轮。
# 判据：文案必须与本岗位**实际能力**一致；判据失手要往「按可用处理」退化，不能把主链路降级。


class _FakeRuntimeWithAgent:
    def __init__(self, agent_code: str) -> None:
        self.context = {
            "session_key": f"agent:{agent_code}:hint",
            "thread_id": f"tid-{agent_code}",
            "model_name": "test-model",
            "agent_name": agent_code,
        }


def _inject_with_agent(monkeypatch, patch_window, agent_code: str) -> str:
    patch_window(20_000)
    monkeypatch.setattr(hint_mod, "_resolve_self_compact", lambda runtime: (False, "platform_not_mounted"))
    out = ContextUsageHintMiddleware().before_model(
        {"messages": _big_transcript(3)}, _FakeRuntimeWithAgent(agent_code)
    )
    texts = _hint_texts(out)
    assert texts, "占用超阈值时必须注入一条提示"
    return texts[0]


def test_hint_without_platform_capability_does_not_point_at_unavailable_tool(
    patch_window, monkeypatch
):
    """没有 platform 的岗位，提示里**不许**出现 sessions.compact 调用串。"""
    body = _inject_with_agent(monkeypatch, patch_window, "tech-director")
    assert 'platform(action="sessions.compact"' not in body
    # 但仍要给出真实判据与当场能做的事：写进文件/产出，别只留在上下文里。
    assert "没有压缩入口" in body
    assert "90%" in body


def test_hint_with_platform_capability_keeps_actionable_recipe(patch_window, monkeypatch):
    """有 platform 的岗位（本岗/主智能体），提示必须给出可直接照抄的调用串。"""
    patch_window(20_000)
    monkeypatch.setattr(hint_mod, "_resolve_self_compact", lambda runtime: (True, ""))
    out = ContextUsageHintMiddleware().before_model(
        {"messages": _big_transcript(3)}, _FakeRuntimeWithAgent("self-evolution-bot")
    )
    body = _hint_texts(out)[0]
    assert 'platform(action="sessions.compact"' in body
    assert "没有压缩入口" not in body


def test_self_compact_probe_reads_real_role_config():
    """判据要读真实岗位配置，不是自造：TD/发版岗没 platform，本岗有。"""
    from evoflow.agents.middlewares.context_usage_hint_middleware import _resolve_self_compact

    def _probe(code: str):
        return _resolve_self_compact(_FakeRuntimeWithAgent(code))

    assert _probe("tech-director")[0] is False
    assert _probe("release-engineer")[0] is False
    assert _probe("self-evolution-bot")[0] is True
