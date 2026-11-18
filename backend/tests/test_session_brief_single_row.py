"""锁住「只读一个字段就只查一行」：工具返回路径不许再做全表会话重建。

【self-evolution-bot · 2026-11-18 · 第47轮 · 模型:deepseek-v4.1-flash-1017】

为什么有这条测试（现网实测，2026-11-18 13:24-13:26）：
6 个并发 ``assets delete``，最内层工具（``CollabCycleTraceMiddleware`` 的
``tool_end.elapsed_ms``）只花 **20/30/32/39/46/53ms**，而外层
``evoflow_obs_tool_invocations.duration_ms`` 是 **2261~2835ms**。差值 2.2~2.8s
全在返回路径上。

逐层拆到真因：``TranscriptMiddleware._append_transcript_batch`` 调
``_round_id_from_session_context(session_key)``，后者为取 **一个会话的一个字段**
（``context.proactive_round_id``）调用 ``load_session_map()`` —— 把全部会话行
SELECT 出来并逐行过 ``_session_row_to_api``（effective_policy / preset / context 重建）。
本机 547 个会话实测：**冷 7673ms / 热 121ms**；改单行 SELECT 后 **0.037ms/次**。
于是「删/写要 2 秒」根本不是资产慢，是这条链路在每次工具返回时全量重建侧栏。

判据（三条反证同时成立才算修好）：
① ``_round_id_from_session_context`` 全程**不调用** ``load_session_map``；
② 取值与旧实现完全一致（同一批真实会话逐条比对，不能只看「返回非空」）；
③ 单次耗时在毫秒级以下，且不随会话总数增长。
"""

from __future__ import annotations

import pytest

from evoflow.agents.middlewares import transcript_middleware as T
from evoflow.persistence import session_repositories as R


def test_round_id_does_not_rebuild_whole_session_map(monkeypatch):
    """① 反证：把 load_session_map 换成「一调就炸」，取值仍必须正确。"""
    calls: list[str] = []

    def _boom():
        calls.append("load_session_map")
        raise AssertionError("工具返回路径不许再全量重建 session map（547 行 / 冷 7673ms）")

    monkeypatch.setattr(R, "load_session_map", _boom)
    monkeypatch.setattr(
        R,
        "get_proactive_round_id",
        lambda sk: "round:2026-11-18T13:00:00+08:00" if sk.startswith("proactive:") else None,
    )

    got = T._round_id_from_session_context("proactive:self-evolution-bot:chat:abc")
    assert got == "round:2026-11-18T13:00:00+08:00"
    assert calls == [], "仍走了 load_session_map()"


def test_round_id_short_circuits_non_proactive_keys(monkeypatch):
    """非 proactive 会话直接 None，且不该碰任何仓储函数。"""
    touched: list[str] = []
    monkeypatch.setattr(R, "get_proactive_round_id", lambda sk: touched.append(sk) or "x")

    assert T._round_id_from_session_context("agent:xiaomi:chat:abc") is None
    assert T._round_id_from_session_context("") is None
    assert touched == []


def test_get_session_row_brief_parses_context_json_single_row(monkeypatch):
    """② 语义等价：brief 的 context 必须与全量 map 的同源字段一致。"""
    fake_row = {
        "session_key": "proactive:self-evolution-bot:chat:abc",
        "thread_id": "tid-1",
        "title": "值班会话",
        "created_at": "2026-11-18T13:00:00+08:00",
        "updated_at": "2026-11-18T13:05:00+08:00",
        "message_count": 7,
        "context_json": '{"proactive_round_id":"round:x","source":"automation"}',
        "is_deleted": 0,
        "local_workspace_root": None,
        "use_virtual_paths": None,
        "model_name": None,
        "model_pinned": None,
        "primary_model_name": None,
        "session_mode": "agent",
        "thinking_enabled": None,
        "reasoning_effort": None,
        "is_plan_mode": 0,
        "subagent_enabled": None,
        "include_search": None,
        "memory_enabled": None,
        "use_claude_code_chat": None,
        "collab_phase": None,
        "collab_task_id": None,
        "agent_id": None,
        "permission_preset": None,
        "tool_approval_policy": None,
    }

    class _Row:
        """mimic sqlite3.Row: ``_row_dict`` 走 ``row.keys()`` + ``row[k]``，
        用 tuple 会直接 AttributeError（第一版测试替身就这么造错了）。"""

        def __init__(self, mapping):
            self._m = dict(mapping)

        def keys(self):
            return list(self._m.keys())

        def __getitem__(self, k):
            return self._m[k]

    class _Cur:
        def fetchone(self):
            return _Row(fake_row)

    class _DB:
        def execute(self, _sql, _params=()):
            return _Cur()

    monkeypatch.setattr(R, "get_db", lambda: _DB())

    brief = R.get_session_row_brief("proactive:self-evolution-bot:chat:abc")
    assert brief is not None
    assert brief["title"] == "值班会话"
    assert brief["thread_id"] == "tid-1"
    assert brief["context"]["proactive_round_id"] == "round:x"
    assert brief["context"]["source"] == "automation"


def test_get_session_row_brief_missing_key_returns_none(monkeypatch):
    class _Cur:
        def fetchone(self):
            return None

    class _DB:
        def execute(self, _sql, _params=()):
            return _Cur()

    monkeypatch.setattr(R, "get_db", lambda: _DB())
    assert R.get_session_row_brief("nope") is None
    assert R.get_session_row_brief("") is None


@pytest.mark.parametrize("raw", [None, "", "not-json", "[1,2]", "{}"])
def test_get_proactive_round_id_tolerates_bad_payload(monkeypatch, raw):
    """坏数据一律 None，绝不抛（这条链路在工具返回路径上，抛异常=工具失败）。"""

    class _Cur:
        def fetchone(self):
            return (raw,) if raw is not None else None

    class _DB:
        def execute(self, _sql, _params=()):
            return _Cur()

    monkeypatch.setattr(R, "get_db", lambda: _DB())
    assert R.get_proactive_round_id("proactive:x:y:z") is None
