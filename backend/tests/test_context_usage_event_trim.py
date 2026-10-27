"""context_usage 事件流 injected_sections 去重（session 上只发一次全文）。

回归背景：单轮流式会话 emit_context_usage 每次都把系统提示词注入节全文
（~41KB，技能目录/资产/记忆等）塞进 context_usage 事件，5~18 次/轮即数百 KB
冗余流量，放大前端渲染压力。UI 弹窗沿用上次正文即可（前端合并逻辑已支持
字段缺省回退），因此：内容哈希未变 → 事件省略 injected_sections；变化 → 重发全文。
DB 持久化（persist_session_context_usage）始终保持全文，不受去重影响。
"""

from __future__ import annotations

import pytest

from evoflow.agents import context_compaction_events as cce


SECTIONS_A = {"skill_injection": "A" * 1000, "memory": "M" * 500}
SECTIONS_B = {"skill_injection": "A" * 1000, "memory": "M-changed" * 500}


@pytest.fixture()
def captured(monkeypatch):
    payloads: list[dict] = []
    persisted: list[dict] = []
    monkeypatch.setattr(cce, "_try_stream_writer", lambda payload: payloads.append(payload) or True)
    import evoflow.persistence.session_context_usage as scu

    monkeypatch.setattr(scu, "persist_session_context_usage", lambda sk, snap: persisted.append(snap))
    return payloads, persisted


def _emit(session_key="agent:main:usage-trim", sections=None):
    cce.emit_context_usage(
        used_tokens=1000,
        window_tokens=8000,
        message_count=3,
        session_key=session_key,
        thread_id="thread-usage-trim",
        injected_sections=dict(sections or SECTIONS_A),
    )


def test_first_emit_carries_full_sections(captured):
    payloads, _ = captured
    _emit()
    assert payloads[0]["injected_sections"] == SECTIONS_A


def test_repeat_emit_with_unchanged_sections_omits_field(captured):
    payloads, _ = captured
    _emit()
    _emit()
    assert "injected_sections" not in payloads[1]


def test_changed_sections_resend_full_text(captured):
    payloads, _ = captured
    _emit()
    _emit()
    _emit(sections=SECTIONS_B)
    assert payloads[2]["injected_sections"] == SECTIONS_B


def test_same_content_different_session_still_sends_full(captured):
    payloads, _ = captured
    _emit(session_key="agent:main:trim-s1")
    _emit(session_key="agent:main:trim-s2")
    assert payloads[1]["injected_sections"] == SECTIONS_A


def test_persist_keeps_full_text_every_time(captured):
    payloads, persisted = captured
    _emit()
    _emit()
    assert persisted[0]["injected_sections"] == SECTIONS_A
    assert persisted[1]["injected_sections"] == SECTIONS_A
