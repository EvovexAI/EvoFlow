"""进程内线程锁超时，不许报成「sqlite 库文件被锁」（第58轮）。

【为什么有这份测试】
``_acquire_process_db_lock`` 在 asyncio 线程上抢进程内 ``RLock`` 超时（默认 0.50s）时，
原文案是 ``database is locked (asyncio thread waited 0.50s for process lock)``。
这句话把成因指错了：

- 真实成因是**本进程另一个线程**持有 Python 级 RLock；
- 而 ``database is locked`` 在 sqlite 语境里指**库文件被别的进程/事务占用**，
  对应的正确动作是「查谁占了 .db / 删 -wal」，与本函数的正确动作（直接重试）完全相反；
- 同一个库上 sqlite 自己的 busy_timeout 是 60s，这里 0.5s 就抛，量级差 120 倍。

现网实证 2026-11-17 四次，调用方（我）看到原句后去查了库文件占用，白绕一步。

【本测试钉什么】
1. 新文案必须**自曝是进程内线程锁**，并明确说「不是 sqlite 库文件锁」；
2. 必须给出唯一正确的下一步「重试」；
3. 必须**保留原句作为子串** —— 下游有两处按 ``database is locked`` 做分类
   （``tool_error_handling_middleware`` 的正则、``http_guard`` 的子串判断），
   改文案不能把它们打空。这条是本测试最重要的一条：它同时约束「改得对」和「没改坏」。
"""

from __future__ import annotations

import re
import sqlite3

import pytest

from evoflow.persistence import db as db_mod


def _raise_on_loop_thread(monkeypatch) -> sqlite3.OperationalError:
    """让「在 asyncio 线程上」+「抢锁超时」同时成立，捕获真实抛出的异常。"""
    monkeypatch.setattr(db_mod, "_on_asyncio_loop_thread", lambda: True)

    class _NeverLock:
        def _is_owned(self) -> bool:
            return False

        def acquire(self, timeout=None) -> bool:  # noqa: ARG002
            return False

    monkeypatch.setattr(db_mod, "_lock", _NeverLock())
    with pytest.raises(sqlite3.OperationalError) as ei:
        db_mod._acquire_process_db_lock()
    return ei.value


def test_message_names_process_lock_not_sqlite_file(monkeypatch) -> None:
    """正向：文案必须说清是进程内线程锁，且不许让人去找 .db 文件。"""
    msg = str(_raise_on_loop_thread(monkeypatch))

    assert "进程内" in msg, f"没点明是进程内锁，模型会去查库文件：{msg}"
    assert "不是 sqlite" in msg, f"没否认 sqlite 库文件锁这个错误联想：{msg}"
    assert "重试" in msg, f"没给出正确的下一步（重试）：{msg}"
    assert msg.startswith("db_process_lock_timeout"), (
        f"错误码要能被稳定分类，别让调用方去正则整句：{msg}"
    )


def test_original_phrase_kept_for_downstream_matchers(monkeypatch) -> None:
    """反向/兼容：下游两处按原句分类，改文案不能把它们打空。

    ``tool_error_handling_middleware`` 用 ``re.compile(r"database is locked|sqlite")``；
    ``http_guard`` 用 ``"database is locked" in str(exc).lower()``。
    """
    msg = str(_raise_on_loop_thread(monkeypatch))
    lowered = msg.lower()

    assert "database is locked" in lowered, (
        "去掉了原句 → http_guard 的 503 判定与 middleware 的「库锁」分类会静默失效"
    )
    assert re.search(r"database is locked|sqlite", msg, re.I), (
        "middleware 的正则不再命中 → 错误分类退化成「未知错误」"
    )
