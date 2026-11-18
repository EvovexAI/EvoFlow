"""向量覆盖率计数要缓存，但缓存不能吃掉「索引被写过」这件事。

【self-evolution-bot · 2026-11-18 · 第45轮 · 模型:deepseek-v4.1-flash-1017】

为什么有这条：`index_status` 里的两条 `COUNT(DISTINCT path)` 是检索路上最贵的一段。
现网逐条 SQL 归因（1.84GB 库 / 118605 块 / 7841 文件）：

- ``SELECT COUNT(DISTINCT path) FROM code_vec``   **548ms**
- ``SELECT COUNT(DISTINCT path) FROM fts_content``  **51ms**
- 对照 ``SELECT COUNT(*) FROM code_vec`` 只要 **32ms**（走覆盖索引）

而一次 `search_index` 会读 3 次索引状态 → 实测 1358ms 里有 600ms 是重复数同一批行。
修法：按 ``(index.db 的 st_mtime, st_size)`` 缓存这三条计数。

判据两条，缺一不可：
1. **库没变时必须命中**——第二次不能再跑那两条 COUNT（用 SQL 计数验证，不看耗时，
   耗时受机器负载影响会飘）。
2. **库变了必须重算**——缓存键失效就回原路径，语义与改动前完全一致；
   否则「补完向量仍被判残缺」或「残缺被永久判完整」，两种都是事故。
"""

from __future__ import annotations

from evoflow.code_index import store as S

# vec0 的维数是建表时写死的（本仓 512）：喂短向量会报
# 「Dimension mismatch ... Expected 512 dimensions but received 2」。
# 第一版我传了 b"\x00"*8 就撞上这条，所以固定用 512 个 float32。
_VEC_DIM = 512
_VEC_BLOB = (b"\x00\x00\x00\x00") * _VEC_DIM


def _seed(tmp_path) -> tuple[str, object]:
    """建一个带 fts + code_vec 行的小库，返回 (root, dbp)。"""
    root = str(tmp_path).replace("\\", "/")
    conn = S._connect(root)
    S._ensure_schema(conn)
    for i in range(6):
        conn.execute(
            "INSERT INTO fts_content(path, content) VALUES (?, ?)",
            (f"src/mod_{i}.py", f"def func_{i}(): return {i}\n"),
        )
    # 只给前 4 个文件写向量片段（故意让覆盖率不足，两个数字不等，能验出串值）
    for i in range(4):
        conn.execute(
            "INSERT INTO code_vec(path, chunk_id, embedding) VALUES (?, ?, ?)",
            (f"src/mod_{i}.py", f"chunk_{i}", _VEC_BLOB),
        )
    conn.commit()
    conn.close()
    return root, S._db_path(root)


def test_coverage_counts_cached_when_db_untouched(tmp_path) -> None:
    """库没被写过时，第二次取数不能再跑那两条 COUNT(DISTINCT path)。

    判据用 SQL 执行**条数**（不看耗时，耗时受机器负载影响会飘）：
    第二次取数连一条 SQL 都不该发。sqlite3.Connection 的 execute 是只读属性
    不能直接打补丁，所以用一个只拦 execute 的代理对象（其余属性原样透传）。
    """
    root, dbp = _seed(tmp_path)
    S._COVERAGE_CACHE.clear()
    conn = S._connect(root)
    try:
        first = S._vector_coverage_counts(conn, root, dbp)

        executed: list[str] = []

        class _Spy:
            def __init__(self, inner):
                self._inner = inner

            def execute(self, sql, *args, **kwargs):
                executed.append(" ".join(str(sql).split()))
                return self._inner.execute(sql, *args, **kwargs)

            def __getattr__(self, name):
                return getattr(self._inner, name)

        second = S._vector_coverage_counts(_Spy(conn), root, dbp)
    finally:
        conn.close()

    assert first == second == (4, 4, 6), f"取数语义变了: {first} / {second}"
    assert not executed, f"库没变却又跑了 SQL：{executed}"


def test_coverage_counts_recomputed_after_db_write(tmp_path) -> None:
    """索引库被写过（mtime/size 变）必须重算，不能返回旧数。

    反证「缓存把真实变化吃掉」：先取一次，再插一个新文件的向量，
    重算出的 vec_paths 必须从 4 变 5。
    """
    root, dbp = _seed(tmp_path)
    S._COVERAGE_CACHE.clear()
    conn = S._connect(root)
    try:
        before = S._vector_coverage_counts(conn, root, dbp)
        conn.execute(
            "INSERT INTO code_vec(path, chunk_id, embedding) VALUES (?, ?, ?)",
            ("src/mod_5.py", "chunk_5", _VEC_BLOB),
        )
        conn.commit()
        import os

        # 显式把 mtime 拨后 1 秒：现网写入必然改 mtime，但同一秒内的多次写
        # 在部分文件系统上 mtime 不变，size 也会变——两个键任一变化都该重算。
        st = dbp.stat()
        os.utime(dbp, (st.st_atime, st.st_mtime + 1.0))
        after = S._vector_coverage_counts(conn, root, dbp)
    finally:
        conn.close()

    assert before == (4, 4, 6), before
    assert after == (5, 5, 6), f"库变了却返回旧数: {after}"


def test_index_status_uses_cached_counts(tmp_path, monkeypatch) -> None:
    """`index_status` 连着读两次，只允许数一遍覆盖率。

    这条测的是**接线**（不是函数本身）：我此前多次栽在「函数改好了、调用点没接上」。
    """
    root, _dbp = _seed(tmp_path)
    S._COVERAGE_CACHE.clear()
    cfg = S.get_code_index_config()
    monkeypatch.setattr(cfg, "semantic_search_enabled", True)

    calls: list[tuple[int, int, int]] = []
    real = S._vector_coverage_counts

    def counting(conn, r, dbp):
        out = real(conn, r, dbp)
        calls.append(out)
        return out

    monkeypatch.setattr(S, "_vector_coverage_counts", counting)
    # 未建向量库时 ready 会 False 并触发自动重建；这里只关心「计了几次」。
    monkeypatch.setattr(S, "schedule_build_index", lambda *a, **k: {"ok": True, "skipped": "test"})
    S.index_status(workspace_root=root)
    S.index_status(workspace_root=root)

    assert len(calls) == 2, calls
    assert calls[0] == calls[1], f"两次取数不一致: {calls}"
    assert S._COVERAGE_CACHE, "缓存没有落盘，等于每次都在重算"
