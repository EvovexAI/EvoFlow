"""【self-evolution-bot · 2026-11-27 · 第135轮 · 模型:deepseek-v4-1-flash-261017】

值班/派单路径复用「库里挂着、上游已消失」的老 thread 是 404 的唯一来源：
`runs.wait` 打在 LangGraph 侧不存在的 thread 上 → 整轮 duty 直接 failed，
员工一个字都没干，但回执照发。

现网取证（2026-11-27 07:46 现场两单，今日 6 次 / 昨日 66 次）：
- thread `ce27a8d1`（11-04 建）GET → 404
- thread `efd99386`（当日在用）GET → 200
- 新建 thread → 200

修复判据（两条，缺一条就白修）：
1) 404 才判「不存在」→ 补建；连接类错误沿用原 id（探不到 ≠ 没有）。
2) 补建必须用**原 thread_id**（if_exists="do_nothing"），不许换新 id ——
   库里 `evoflow_chat_sessions.thread_id` 与历史消息都指向原 id，
   换 id = thread 漂移，用户下一句接不上本轮上下文。
"""

from __future__ import annotations

import asyncio

import httpx
from langgraph_sdk.errors import NotFoundError


def _not_found() -> NotFoundError:
    """真实 NotFoundError 必须带 response/body；纯字符串构造只会抛 TypeError。

    【self-evolution-bot · 2026-11-27 · 第135轮】本轮自撞：初版桩写
    ``NotFoundError("Thread not found")``，实际抛的是 TypeError，被
    ``is_thread_or_assistant_not_found_error`` 当成「thread 仍在」→ 测试假红。
    """
    resp = httpx.Response(
        404, request=httpx.Request("GET", "http://127.0.0.1:8384/threads/x")
    )
    return NotFoundError("Thread not found", response=resp, body=None)


class _FakeThreads:
    def __init__(self, missing: set[str] | None = None, boom: Exception | None = None):
        self.missing = missing or set()
        self.boom = boom
        self.created: list[dict] = []
        self.probed: list[str] = []
        self._alive = set()

    async def get(self, tid: str):
        self.probed.append(tid)
        if self.boom is not None:
            raise self.boom
        if tid in self.missing and tid not in self._alive:
            raise _not_found()
        return {"thread_id": tid}

    async def create(self, *, thread_id=None, if_exists=None, metadata=None):
        self.created.append(
            {"thread_id": thread_id, "if_exists": if_exists, "metadata": metadata}
        )
        if thread_id:
            self._alive.add(thread_id)
            return {"thread_id": thread_id}
        return {"thread_id": f"new-{len(self.created)}"}


class _FakeClient:
    def __init__(self, threads: _FakeThreads):
        self.threads = threads


def _run(coro):
    return asyncio.run(coro)


def _resolve(client, tid):
    from evoflow.proactive.engine import _resolve_pinned_thread

    return _run(_resolve_pinned_thread(client, pinned_thread_id=tid, metadata={"k": "v"}))


def test_existing_thread_is_reused():
    client = _FakeClient(_FakeThreads())
    tid, state = _resolve(client, "tid-alive")
    assert (tid, state) == ("tid-alive", "reused")
    assert client.threads.created == []


def test_missing_thread_is_repaired_with_same_id():
    """核心回归：上游 404 → 按**原 id** 补建，绝不换新 id（换了就 thread 漂移）。"""
    client = _FakeClient(_FakeThreads(missing={"tid-stale"}))
    tid, state = _resolve(client, "tid-stale")
    assert state == "repaired"
    assert tid == "tid-stale", "补建后 thread_id 漂移了 —— 会话指针会断"
    assert client.threads.created == [
        {"thread_id": "tid-stale", "if_exists": "do_nothing", "metadata": {"k": "v"}}
    ]


def test_connect_error_keeps_existing_thread():
    """上游只是暂时探不到 → 沿用原 id，不补建（探不到 ≠ 没有）。"""

    class ConnectError(Exception):
        pass

    ConnectError.__name__ = "ConnectError"
    client = _FakeClient(_FakeThreads(boom=ConnectError("connection refused")))
    tid, state = _resolve(client, "tid-alive")
    assert (tid, state) == ("tid-alive", "reused")
    assert client.threads.created == []


def test_empty_thread_id_creates_new():
    client = _FakeClient(_FakeThreads())
    tid, state = _resolve(client, "")
    assert state == "created"
    assert tid == "new-1"
    assert client.threads.created[0]["thread_id"] is None
