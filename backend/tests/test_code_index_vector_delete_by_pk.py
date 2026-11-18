"""锁住「删文件向量不得全表扫」。

【self-evolution-bot · 2026-11-19 · 第62轮 · 模型:deepseek-v4.1-flash-1017】
为什么有这条测试：
`code_vec` 是 vec0 虚表，`vec0(chunk_id TEXT PRIMARY KEY, path TEXT, embedding ...)`
里 `path` 只是**辅助列、没有索引**。原来 `DELETE FROM code_vec WHERE path = ?`
要扫全表。本机实测（现网库 `code_vec` 119141 行 / 1.84GB，被删文件 82 块）：
  旧写法 按 path 删            350.0 ms
  新写法 按 chunk_id 主键删       9.5 ms   ← 约 37 倍
  端到端 index_file（同进程 A/B，只换删除段）：1590 ms → 673 ms（-58%）
单文件增量因此从「百毫秒级全表扫」降到「只与本文件块数相关」，
漂移自愈一轮 24 文件时写事务持有时间同比缩短，重建挡检索的窗口一起变窄。

判据不能只测「快」——慢机器上绝对毫秒数不稳——所以这里锁**语义**：
  1. 前缀邻居文件不许被误删（半开区间上界 ':;' 的意义）；
  2. 本文件的块必须清零；
  3. 其它文件的块数一字不变；
  4. 不存在的 path 返回 0 且不改任何行；
  5. 必须有一条从 `_delete_path_from_index` **入口**进的接线测试——
     只测函数本体时，调用点被改回旧写法也照样全绿（第61轮同类教训）。

注：`fts_content` 那一段**没有改**。实测按 path 删 11.6ms、先查 rowid 再删 11.1ms，
只快 4%，不够格进仓库（第17轮判据：复算无效的改动不留）。
"""
from __future__ import annotations

import importlib

import pytest


@pytest.fixture()
def store_mod():
    return importlib.import_module("evoflow.code_index.store")


def _make_fake_db(store_mod, tmp_path):
    """建一个只有 code_vec_rowids 的最小库，够验 id 前缀语义。"""
    import sqlite3

    db = tmp_path / "index.db"
    conn = sqlite3.connect(str(db))
    conn.execute(
        """
        CREATE TABLE code_vec_rowids(
            rowid INTEGER PRIMARY KEY AUTOINCREMENT,
            id TEXT UNIQUE NOT NULL,
            chunk_id INTEGER,
            chunk_offset INTEGER
        )
        """
    )
    # 目标文件 3 块
    for i in range(3):
        conn.execute("INSERT INTO code_vec_rowids(id) VALUES (?)", (f"a/b.py::{i}",))
    # 前缀邻居：a/b.py.bak::* —— 不能被当成 a/b.py 的块
    for i in range(2):
        conn.execute("INSERT INTO code_vec_rowids(id) VALUES (?)", (f"a/b.py.bak::{i}",))
    # 前缀邻居：a/b.py2::* —— ':' 和 '2' 之间，不能被区间收进来
    conn.execute("INSERT INTO code_vec_rowids(id) VALUES (?)", (f"a/b.py2::{0}",))
    # 完全无关的文件
    conn.execute("INSERT INTO code_vec_rowids(id) VALUES (?)", ("z/nothing.py::0",))
    conn.commit()
    return conn


def test_id_prefix_range_does_not_touch_neighbors(store_mod, tmp_path):
    """半开区间 ['rel::', 'rel:;') 只能覆盖 rel::*，不碰 rel.bak::/rel2::。"""
    conn = _make_fake_db(store_mod, tmp_path)
    lo, hi = "a/b.py::", "a/b.py:;"
    ids = [
        r[0]
        for r in conn.execute(
            "SELECT id FROM code_vec_rowids WHERE id >= ? AND id < ?", (lo, hi)
        )
    ]
    assert sorted(ids) == ["a/b.py::0", "a/b.py::1", "a/b.py::2"], (
        f"区间取错了：拿到 {sorted(ids)}。必须只含 a/b.py::*，不含 .bak:: 或 py2::"
    )
    conn.close()


def test_delete_vectors_clears_only_target_file(store_mod, tmp_path):
    """_delete_file_vectors 要清空目标文件、且不动任何邻居。"""
    conn = _make_fake_db(store_mod, tmp_path)
    # 补一张能被 DELETE 的 vec 替身表（真 vec0 需要 sqlite-vec 扩展，CI 上没有）
    conn.execute("CREATE TABLE code_vec(chunk_id TEXT PRIMARY KEY, path TEXT)")
    for cid in ("a/b.py::0", "a/b.py::1", "a/b.py::2", "a/b.py.bak::0", "a/b.py2::0"):
        conn.execute("INSERT INTO code_vec(chunk_id) VALUES (?)", (cid,))
    conn.commit()

    before_total = conn.execute("SELECT count(*) FROM code_vec").fetchone()[0]
    n = store_mod._delete_file_vectors(conn, "a/b.py")
    after_total = conn.execute("SELECT count(*) FROM code_vec").fetchone()[0]
    left = [
        r[0] for r in conn.execute("SELECT chunk_id FROM code_vec ORDER BY chunk_id")
    ]

    assert n == 3, f"应删 3 块，实际 {n}"
    assert after_total == before_total - 3, "删过头了"
    assert left == ["a/b.py.bak::0", "a/b.py2::0"], f"误删邻居：{left}"
    conn.close()


def test_delete_vectors_on_missing_file_is_noop(store_mod, tmp_path):
    """不存在的 path：返回 0，且一行都不改（空输入不许给出假结论）。"""

    conn = _make_fake_db(store_mod, tmp_path)
    conn.execute("CREATE TABLE code_vec(chunk_id TEXT PRIMARY KEY, path TEXT)")
    conn.execute("INSERT INTO code_vec(chunk_id) VALUES ('a/b.py::0')")
    conn.commit()

    before = conn.execute("SELECT count(*) FROM code_vec").fetchone()[0]
    n = store_mod._delete_file_vectors(conn, "no/such/file.py")
    after = conn.execute("SELECT count(*) FROM code_vec").fetchone()[0]

    assert n == 0
    assert after == before == 1
    conn.close()


def test_接线_delete_path_from_index_真的删掉了向量块(store_mod, tmp_path):
    """从 `_delete_path_from_index` 入口进，向量块必须真被删。

    【self-evolution-bot · 2026-11-19 · 第62轮 · 模型:deepseek-v4.1-flash-1017】
    为什么补这一条：原有 3 条测试全部直接调 `_delete_file_vectors` 本体，
    **没有一条走 `_delete_path_from_index` 这个真实调用点**。只要哪天有人把
    调用点改回 `conn.execute("DELETE FROM code_vec WHERE path = ?")`，
    那 3 条照样全绿——第61轮我已经在 replace 上栽过同型一次
    （`tests/` 全绿但调用点参数没传下去）。反向验证的第一刀必须砍在接线处。
    """
    import sqlite3

    conn = sqlite3.connect(str(tmp_path / "w.db"))
    conn.execute(
        "CREATE TABLE code_vec_rowids(rowid INTEGER PRIMARY KEY AUTOINCREMENT,"
        " id TEXT UNIQUE NOT NULL, chunk_id INTEGER, chunk_offset INTEGER)"
    )
    # 目标文件 3 块 + 两个前缀邻居 + 一个无关文件
    for cid in ("a/b.py::0", "a/b.py::1", "a/b.py::2"):
        conn.execute("INSERT INTO code_vec_rowids(id) VALUES (?)", (cid,))
    for cid in ("a/b.py.bak::0", "a/b.py2::0", "z/c.py::0"):
        conn.execute("INSERT INTO code_vec_rowids(id) VALUES (?)", (cid,))
    conn.execute("CREATE TABLE code_vec(chunk_id TEXT PRIMARY KEY, path TEXT)")
    for cid in ("a/b.py::0", "a/b.py::1", "a/b.py::2",
                "a/b.py.bak::0", "a/b.py2::0", "z/c.py::0"):
        conn.execute("INSERT INTO code_vec(chunk_id) VALUES (?)", (cid,))
    # _delete_path_from_index 需要的其余表
    for ddl in (
        "CREATE TABLE fts_content(path TEXT, content TEXT)",
        "CREATE TABLE symbols(path TEXT, name TEXT)",
        "CREATE TABLE file_deps(from_path TEXT, to_path TEXT)",
        "CREATE TABLE internal_refs(from_path TEXT, to_path TEXT)",
        "CREATE TABLE type_relations(from_path TEXT, to_path TEXT)",
    ):
        conn.execute(ddl)
    conn.commit()

    store_mod._delete_path_from_index(conn, "a/b.py")

    left = [
        r[0]
        for r in conn.execute("SELECT chunk_id FROM code_vec ORDER BY chunk_id")
    ]
    assert left == ["a/b.py.bak::0", "a/b.py2::0", "z/c.py::0"], (
        f"接线没通或删错：调用 _delete_path_from_index 后 code_vec 剩 {left}。"
        " 期望只余两个前缀邻居 + 无关文件（说明入口确实走到了按主键删的路径）。"
    )
    conn.close()


def test_delete_path_from_index_actually_removes_fts_rows(store_mod, tmp_path):
    """_delete_path_from_index 必须真的把 fts 行删掉（行为判据，不锁实现）。

    【self-evolution-bot · 2026-11-18 · 第51轮 · 模型:deepseek-v4.1-flash-1017】
    为什么补这一条：第51轮反向验证时发现，把 fts 删除退回「按 path 整表匹配」
    后我原有 3 条测试**仍然全绿**——等于这条路径没被测到。
    这里用一条能真删/真没删的二值判据，两种写法都过不了假：
    删干净 = PASS；一行没删 = FAIL。
    """
    import sqlite3

    conn = sqlite3.connect(str(tmp_path / "i.db"))
    conn.execute("CREATE TABLE fts_content(path TEXT, content TEXT)")
    conn.execute("CREATE TABLE symbols(path TEXT, name TEXT)")
    conn.execute("CREATE TABLE file_deps(from_path TEXT, to_path TEXT)")
    conn.execute("CREATE TABLE internal_refs(from_path TEXT, to_path TEXT)")
    conn.execute("CREATE TABLE type_relations(from_path TEXT, to_path TEXT)")
    conn.execute("INSERT INTO fts_content VALUES ('a/b.py', 'x'), ('a/b.py', 'y'), ('z/c.py', 'w')")
    conn.execute("INSERT INTO symbols VALUES ('a/b.py', 'f')")
    conn.commit()

    store_mod._delete_path_from_index(conn, "a/b.py")

    left_own = conn.execute(
        "SELECT count(*) FROM fts_content WHERE path = 'a/b.py'"
    ).fetchone()[0]
    left_all = conn.execute("SELECT count(*) FROM fts_content").fetchone()[0]

    assert left_own == 0, f"本文件 fts 行没删干净，剩 {left_own} 行"
    assert left_all == 1, f"误删了别的文件：全表剩 {left_all} 行（应为 1）"
    conn.close()
