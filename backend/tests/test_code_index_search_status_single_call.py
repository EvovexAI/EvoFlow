"""锁住「一次检索只读一次索引状态」，以及文件计数不走 FTS 全表扫描。

【self-evolution-bot · 2026-11-17 · 第34轮】为什么有这两条测试：

现网实测（本机 8176 文件 / 1.0GB 索引库）稳态下 `search_code_index` 每次约 580ms，
其中：
- `index_status` 103ms/次，被 `search_index` 调用 **2 次**（一次自己判 ready，
  一次经 `_wait_index_ready` 再判「是否在构建」），共 ~210ms；
- 这 103ms 里有 ~80ms 是 `SELECT COUNT(*) FROM fts_content` —— FTS5 虚拟表做全表
  COUNT 要扫整棵内容表，而 fts5 自带的 `fts_content_docsize` 影子表每篇文档一行，
  同样的库实测 0ms。

用户感知就是「搜索一次要等半秒多」。修法：
1. `search_index` 把已算好的状态传给 `_wait_index_ready(initial=...)`，稳态只算一次；
   仅在「确实在构建」时才进入轮询、才需要再算。
2. 文件数改由 `_fts_doc_count` 取，优先影子表，取不到才退回全表 COUNT。

两条都用**现网同构的库**做判据（真建 FTS5 表并插文档），不造小样。
"""

from __future__ import annotations

import sqlite3

import pytest

from evoflow.code_index import store as S


@pytest.fixture
def steady_cfg(monkeypatch):
    """让临时库被判为 ready：关掉语义向量，避免 vectors_missing 触发自动重建。

    现网稳态库是有向量的（ready=True / building=False），测试里不建向量也能达到
    同样的「ready 且不在构建」分支，从而只测那条分支是否重复读状态。
    """
    cfg = S.get_code_index_config()
    monkeypatch.setattr(cfg, "semantic_search_enabled", False)
    return cfg


def _seed(tmp_path, files: int = 40) -> str:
    root = str(tmp_path).replace("\\", "/")
    conn = S._connect(root)
    S._ensure_schema(conn)
    for i in range(files):
        conn.execute(
            "INSERT INTO fts_content(path, content) VALUES (?, ?)",
            (f"src/mod_{i}.py", f"def func_{i}(): return {i}\n"),
        )
        conn.execute(
            "INSERT INTO symbols(path, name, kind, line) VALUES (?, ?, 'function', 1)",
            (f"src/mod_{i}.py", f"func_{i}"),
        )
    # meta.root 必须与 resolve_index_root() 的归一化结果一致，否则 index_status 会判
    # ready=False 而触发真实重建（测试就会真的去 build，测不到稳态分支）。
    resolved = S.resolve_index_root(workspace_root=root)
    conn.execute(
        "INSERT OR REPLACE INTO meta(key, value) VALUES ('root', ?)",
        (resolved,),
    )
    # 现网库都记了分词器版本；不记的话 `_mark_reindex_if_tokenizer_changed` 每次都会
    # 打上 fts_needs_rebuild，search_index 就走「强制重建」分支、第二次读状态属于正常行为，
    # 测不到「稳态」这条路径（我第一版就栽在这：报 2 次，误以为是缺陷没修好）。
    conn.execute(
        "INSERT OR REPLACE INTO meta(key, value) VALUES ('index_tokenizer_version', ?)",
        (S.index_tokenizer_version(),),
    )
    conn.execute(
        "INSERT OR REPLACE INTO meta(key, value) VALUES ('indexed_max_files', ?)",
        (str(S.get_code_index_config().max_files),),
    )
    conn.commit()
    conn.close()
    return root


def test_virtual_table_count_matches_docsize_count(tmp_path) -> None:
    """影子表计数必须与全表 COUNT 一致——换了取数位置但不能换语义。"""
    root = _seed(tmp_path, files=37)
    conn = S._connect(root)
    try:
        full = int(conn.execute("SELECT COUNT(*) FROM fts_content").fetchone()[0])
        fast = S._fts_doc_count(conn)
        assert full == 37
        assert fast == full, f"_fts_doc_count={fast} 与全表 COUNT={full} 不一致"
    finally:
        conn.close()


def test_fts_doc_count_falls_back_when_docsize_missing(tmp_path) -> None:
    """老库没有 docsize 影子表时不能报 0 条，要退回全表 COUNT。"""
    root = _seed(tmp_path, files=5)
    conn = S._connect(root)
    try:
        conn.execute("DROP TABLE IF EXISTS fts_content_docsize")
        conn.commit()
        assert S._fts_doc_count(conn) == 5
    finally:
        conn.close()


def test_index_status_counts_files_via_docsize(tmp_path, steady_cfg) -> None:
    """index_status 报出的文件数必须是真实文档数（不能因为换取数位置变成 0）。"""
    root = _seed(tmp_path, files=23)
    st = S.index_status(workspace_root=root)
    assert st["files"] == 23, st
    assert st["symbols"] == 23, st


def test_steady_state_search_reads_index_status_once(tmp_path, monkeypatch, steady_cfg) -> None:
    """稳态（不在构建）下，一次 search_index 只允许读一次索引状态。

    【self-evolution-bot · 2026-11-17 · 第34轮】判据是**调用次数**而不是耗时：
    耗时受机器负载影响会飘，而「多算一次 100ms 的现状」在调用次数上是恒定的 2。
    关掉修复（去掉 `if st.get("building")` 这层判断）后此断言必然变 2 → 红；
    恢复后变 1 → 绿。
    """
    root = _seed(tmp_path, files=12)
    calls: list[int] = []
    real = S.index_status

    def counting_index_status(*args, **kwargs):
        calls.append(1)
        return real(*args, **kwargs)

    monkeypatch.setattr(S, "index_status", counting_index_status)
    data = S.search_index(workspace_root=root, query="func_1", limit=5)
    assert data.get("hits") is not None
    assert len(calls) == 1, (
        f"稳态下一次检索读了 {len(calls)} 次 index_status；"
        "应为 1 次（构建中的轮询除外）"
    )


def test_search_still_waits_while_building(tmp_path, monkeypatch, steady_cfg) -> None:
    """构建中必须继续轮询——缓存初始状态不能把「等索引就绪」这条路径吞掉。"""
    root = _seed(tmp_path, files=3)
    states = [
        {"ready": False, "building": True, "files": 0},
        {"ready": True, "building": False, "files": 3},
    ]
    calls: list[int] = []

    def fake_wait(workspace_root, *, thread_id, cfg, initial=None):
        assert initial is not None, "调用方应把已算好的状态传进来"
        calls.append(1)
        return states[-1]

    monkeypatch.setattr(S, "_wait_index_ready", fake_wait)
    monkeypatch.setattr(
        S,
        "index_status",
        lambda *a, **k: states[0],
    )
    data = S.search_index(workspace_root=root, query="func_1", limit=5)
    assert calls == [1], "构建中必须调用一次 _wait_index_ready"
    assert data.get("rebuild_in_progress") is False


def _sqlite_version() -> str:
    return sqlite3.sqlite_version
