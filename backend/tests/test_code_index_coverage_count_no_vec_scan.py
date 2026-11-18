"""向量覆盖率计数不能再扫 vec0 虚表：改为在 rowids 上数 id 前缀。

【self-evolution-bot · 2026-11-19 · 第63轮 · 模型:deepseek-v4.1-flash-1017】

为什么有这条（用户诉求是「我自己调用的工具极致速度」，检索现网 P50 6.5s）：

`code_vec` 是 vec0 虚表，`path` 只是**辅助列**，vec0 不为它建索引，
所以 ``SELECT COUNT(DISTINCT path) FROM code_vec`` 要扫整张 1.84GB 虚表。
本机三次取中位实测：

- 现值 ``COUNT(DISTINCT path) FROM code_vec``                  334.7ms
- 改后 ``code_vec_rowids`` 上数 ``substr(id,1,instr(id,'::')-1)``   13.7ms  (-96%)
- ``COUNT(DISTINCT path) FROM fts_content``                     13.8ms
- ``fts_content_docsize`` 行数                                    0.0ms

这段每次检索都要跑，且 ``_COVERAGE_CACHE`` 的失效判据是 index.db 的
``(mtime, size)`` —— 后台补录每写一次就整段失效，稳态下它不是一次性的。

判据三条，缺一不可：
1. **等价**：新写法必须与旧写法在全表上逐值相等（不是抽样、不是只比总数）。
2. **走的是 rowids 那条路**：用 SQL spy 断言本条 SELECT 命中 ``code_vec_rowids``，
   且**没有**再对 ``code_vec`` 做 ``COUNT(DISTINCT path)``。
   只测返回值相等不够——旧写法返回同样正确，测不出「有没有换成快的实现」。
3. **fts 侧改用影子表**：断言不再对 ``fts_content`` 发 ``COUNT(DISTINCT path)``。
"""

from __future__ import annotations

from evoflow.code_index import store as S

_VEC_DIM = 512
_VEC_BLOB = (b"\x00\x00\x00\x00") * _VEC_DIM


def _seed(tmp_path):
    """建一个 fts 6 文件 / 向量 4 文件的小库（故意让两个数字不等，能验出串值）。"""
    root = str(tmp_path).replace("\\", "/")
    conn = S._connect(root)
    S._ensure_schema(conn)
    for i in range(6):
        conn.execute(
            "INSERT INTO fts_content(path, content) VALUES (?, ?)",
            (f"src/mod_{i}.py", f"def func_{i}(): return {i}\n"),
        )
    for i in range(4):
        # 每文件两块，验证「按路径去重」而不是「数块」
        for off in (0, 1):
            conn.execute(
                "INSERT INTO code_vec(path, chunk_id, embedding) VALUES (?, ?, ?)",
                (f"src/mod_{i}.py", f"src/mod_{i}.py::{off}", _VEC_BLOB),
            )
    conn.commit()
    conn.close()
    return root, S._db_path(root)


class _SqlSpy:
    """只拦 execute / 记录 SQL，其余属性原样透传给真连接。"""

    def __init__(self, inner):
        self._inner = inner
        self.sql: list[str] = []

    def execute(self, sql, *args, **kwargs):
        self.sql.append(" ".join(str(sql).split()))
        return self._inner.execute(sql, *args, **kwargs)

    def __getattr__(self, name):
        return getattr(self._inner, name)


def test_coverage_counts_do_not_scan_vec0(tmp_path) -> None:
    """计数必须走 code_vec_rowids，且不得再对 code_vec 做 COUNT(DISTINCT path)。"""
    root, dbp = _seed(tmp_path)
    S._COVERAGE_CACHE.clear()
    conn = S._connect(root)
    try:
        spy = _SqlSpy(conn)
        counts = S._vector_coverage_counts(spy, root, dbp)
    finally:
        conn.close()

    joined = " || ".join(spy.sql)
    assert any("code_vec_rowids" in s for s in spy.sql), (
        f"没有走 code_vec_rowids，实际 SQL：{spy.sql}"
    )
    assert not any(
        "code_vec" in s and "COUNT(DISTINCT path)" in s for s in spy.sql
    ), f"仍在扫 vec0 虚表做 COUNT(DISTINCT path)，实际 SQL：{spy.sql}"
    assert not any("FROM fts_content" in s.upper() and "DISTINCT" in s.upper() for s in spy.sql), (
        f"fts 侧仍在全表数 distinct path，实际 SQL：{spy.sql}"
    )
    # 4 文件 × 2 块 → 去重后必须是 4，不能是 8
    assert counts[1] == 4, f"按路径去重失效，得到 {counts[1]}（应为 4 个文件/8 块）：{joined}"


def test_coverage_counts_match_full_table_scan(tmp_path) -> None:
    """与旧写法（全表 COUNT(DISTINCT path)）逐值相等。"""
    root, dbp = _seed(tmp_path)
    S._COVERAGE_CACHE.clear()
    conn = S._connect(root)
    try:
        got = S._vector_coverage_counts(conn, root, dbp)
        want = (
            conn.execute("SELECT COUNT(*) FROM code_vec").fetchone()[0],
            conn.execute("SELECT COUNT(DISTINCT path) FROM code_vec").fetchone()[0],
            conn.execute("SELECT COUNT(DISTINCT path) FROM fts_content").fetchone()[0],
        )
    finally:
        conn.close()
    assert tuple(got) == tuple(want), f"新写法 {got} != 旧写法 {want}"


def test_coverage_counts_rowids_rows_keep_path_prefix(tmp_path) -> None:
    """保护 ``instr(id,'::')`` 这个切法：没写过 ``::`` 的 id 会让切片错位。

    ``id`` 形如 ``src/mod_0.py::1``。若将来某处写入不带 ``::`` 的 id，
    ``instr`` 返回 0 → ``substr(id, 1, -1)`` 得到空串，多行会塌成一个路径，
    计数变小但**没有任何报错**。这条把它钉死：种子数据必须能数出正确路径数。
    """
    root, dbp = _seed(tmp_path)
    S._COVERAGE_CACHE.clear()
    conn = S._connect(root)
    try:
        bad = conn.execute(
            "SELECT COUNT(*) FROM code_vec_rowids WHERE instr(id, '::') = 0"
        ).fetchone()[0]
        assert bad == 0, f"存在 {bad} 行 id 不含 '::'，substr 切法会算错"
        assert S._vector_coverage_counts(conn, root, dbp)[1] == 4
    finally:
        conn.close()
