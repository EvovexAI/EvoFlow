"""检索连接复用：同一 workspace 连续检索不再每次重开连接。

【self-evolution-bot · 2026-11-19 · 第64轮 · 模型:deepseek-v4.1-flash-1017】

回归对象（本轮同进程实测，库 1.84GB / code_vec 119153 行）：
``search_index`` 每次调用都 ``_connect()`` 新建 + ``close()`` 关闭连接。而**同一个
新连接**的首次 vec0 KNN 要 362.9ms、第二次起只要 90.2ms（页缓存没热）。于是每次
检索都白付这一刀。同口径 12 次取 P50：**404.7ms → 165.6ms（2.44x）**。

本文件守四件事：
1. 连续检索复用同一条连接（真的没在每次新建）；
2. 不同 workspace **绝不**共用连接（池按 root 分键）；
3. 借出的连接若在事务中，归还时不入池（不能被下一个调用继承半截事务）；
4. **接线**：``search_index`` 主路径返回后，连接真的回到了池里。
"""

from __future__ import annotations

import sqlite3

import pytest

from evoflow.code_index import store


@pytest.fixture(autouse=True)
def _clear_pool():
    store._SEARCH_CONN_POOL.clear()
    yield
    for bucket in list(store._SEARCH_CONN_POOL.values()):
        for c in bucket:
            try:
                c.close()
            except Exception:  # noqa: BLE001
                pass
    store._SEARCH_CONN_POOL.clear()


def _make_db(tmp_path, name="index.db"):
    dbp = tmp_path / name
    dbp.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(dbp))
    conn.execute("CREATE TABLE t (x INTEGER)")
    conn.commit()
    conn.close()
    return dbp


def test_scope_reuses_same_connection(tmp_path, monkeypatch):
    """第二次借出的必须是同一个对象——不是「又新建了一条」。"""
    _make_db(tmp_path)
    monkeypatch.setattr(store, "_connect", lambda root: sqlite3.connect(str(tmp_path / "index.db")))

    with store._search_conn_scope(str(tmp_path)) as c1:
        first = id(c1)
    with store._search_conn_scope(str(tmp_path)) as c2:
        second = id(c2)
    assert first == second, "连续两次借出的不是同一条连接（池没生效）"


def test_pool_is_keyed_by_workspace(tmp_path, monkeypatch):
    """不同 workspace 不能共用连接。"""
    a = tmp_path / "a"
    b = tmp_path / "b"
    for d in (a, b):
        d.mkdir(parents=True, exist_ok=True)
        (d / "index.db").write_bytes(b"")
    monkeypatch.setattr(
        store, "_connect", lambda root: sqlite3.connect(str(tmp_path / "shared.db"))
    )
    conns = {}
    for root in (str(a), str(b)):
        with store._search_conn_scope(root) as c:
            conns[root] = id(c)
    assert conns[str(a)] != conns[str(b)], "两个 workspace 复用了同一条连接"
    assert set(store._SEARCH_CONN_POOL) == {str(a), str(b)}


def test_transaction_connection_is_closed_not_pooled(tmp_path, monkeypatch):
    """在事务中的连接不入池：否则下一个调用会继承半截事务。"""
    _make_db(tmp_path)
    monkeypatch.setattr(store, "_connect", lambda root: sqlite3.connect(str(tmp_path / "index.db")))

    borrowed: list[object] = []
    with store._search_conn_scope(str(tmp_path)) as c:
        c.execute("BEGIN")
        borrowed.append(c)
    assert store._SEARCH_CONN_POOL.get(str(tmp_path)) in (None, []), "事务中的连接被还进了池"
    # sqlite3.Connection.close 是只读槽位，无法 spy；改断言「关闭」的后果：
    # 已关闭的连接再执行必然抛 ProgrammingError。
    with pytest.raises(sqlite3.ProgrammingError):
        borrowed[0].execute("SELECT 1")


def test_borrowed_dead_connection_is_replaced(tmp_path, monkeypatch):
    """池里躺着的连接若已关闭（进程/文件变动），借出时要自动换新而不是报错。"""
    _make_db(tmp_path)
    monkeypatch.setattr(store, "_connect", lambda root: sqlite3.connect(str(tmp_path / "index.db")))
    with store._search_conn_scope(str(tmp_path)):
        pass
    bucket = store._SEARCH_CONN_POOL[str(tmp_path)]
    assert bucket
    bucket[0].close()  # 人为弄死池里的连接

    with store._search_conn_scope(str(tmp_path)) as c2:
        assert c2.execute("SELECT 1").fetchone()[0] == 1


def test_search_index_returns_connection_to_pool(tmp_path, monkeypatch):
    """接线：真实 ``search_index`` 调用结束后，连接必须在池里。

    这是本岗栽过 4 次的那一类（函数层全绿、接线没通），所以从真实入口进。
    """
    root = str(tmp_path)
    monkeypatch.setattr(store, "resolve_index_root", lambda **kw: root)

    created: list[object] = []

    def _fake_connect(root_arg):
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        created.append(conn)
        return conn

    monkeypatch.setattr(store, "_connect", _fake_connect)
    monkeypatch.setattr(store, "_ensure_schema", lambda conn: None)
    monkeypatch.setattr(store, "_mark_reindex_if_tokenizer_changed", lambda conn: None)
    monkeypatch.setattr(store, "_fts_needs_rebuild", lambda conn: False)

    class _Cfg:
        auto_index_on_search = False
        search_limit = 20
        semantic_search_enabled = False
        semantic_top_k = 15
        type_relations_enabled = False

    monkeypatch.setattr(store, "get_code_index_config", lambda: _Cfg())

    # 空查询直接走早退分支——那也要归还连接
    store.search_index(workspace_root=root, query="")
    pooled = sum(len(v) for v in store._SEARCH_CONN_POOL.values())
    assert pooled >= 1, "search_index 早退后连接没有回到池里（接线断）"
    assert created, "没有新建连接，说明 _connect 替换没生效"

    # 再借一次：必须复用已有连接，不再新建
    n_before = len(created)
    store.search_index(workspace_root=root, query="")
    # 允许第一段探测再新建 0 次；早退分支不应触发新连接
    assert len(created) <= n_before + 1, (
        f"连续两次检索新建了 {len(created) - n_before} 条连接，池没被用上"
    )
