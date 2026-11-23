"""坏索引库必须当场自愈，不许把裸 sqlite 报错抛给调用方。

【self-evolution-bot · 2026-11-22 · 第124轮 · 模型:deepseek-v4.1-flash】
现网实证（2026-11-22 17:58~18:01，agent=case-fullstack-dev）：
  该员工工作区 `D:/dev/github/knowledge-library/ai-showcase/.evoflow/code_index/index.db`
  损坏（PRAGMA quick_check → "Freelist: invalid page number …"），随后每次
  `search_code_index` 都返回同一句
  "Error: search_code_index failed: database disk image is malformed"，连调 6 次
  （obs 6 条 status=error）全一样；同一时间窗我在本仓检索全部成功 → 是那个 root
  的库坏了，而检索路径里**没有任何自愈**，员工只能靠人肉删一个仓库外的隐藏目录。

本测试用**真的坏文件**（不是 mock），断言三件事：
  1. `search_index` 不再抛 `DatabaseError`；
  2. 返回带 `index_corrupt_recovered`，工具出口能说清「库坏了、已隔离、在重建」；
  3. 坏文件被改名保留（不删），并触发了一次 force 重建。

刻意不 mock sqlite：mock 掉之后本测试会变成「测我的 mock」，正是本岗反复栽的坑。
"""

from __future__ import annotations

import sqlite3

import pytest

from evoflow.code_index import store as S


def _make_corrupt_db(root: str) -> str:
    """在工作区里造一个真损坏的 index.db（sqlite 读头即判 not a database）。"""
    dbp = S.index_db_path(root)
    # 真损坏而非空文件：写一段非 sqlite 头的字节。
    dbp.write_bytes(b"\x13\x37 this is definitely not a sqlite database \x00\xff" * 40)
    return str(dbp)


def test_search_index_recovers_from_corrupt_db(tmp_path, monkeypatch):
    root = str(tmp_path).replace("\\", "/")
    dbp = _make_corrupt_db(root)

    # 先证真：坏库确实会让 sqlite 抛错，否则本测试什么都没在测。
    with pytest.raises(sqlite3.DatabaseError):
        conn = sqlite3.connect(dbp)
        try:
            conn.execute("SELECT count(*) FROM sqlite_master").fetchone()
        finally:
            conn.close()

    rebuilt: list[dict] = []

    def _fake_schedule(**kwargs):
        rebuilt.append(kwargs)
        return {"status": "scheduled"}

    monkeypatch.setattr(S, "schedule_build_index", _fake_schedule)

    data = S.search_index(workspace_root=root, query="RightStagePanel")

    # 1) 不抛错，且明确指出「库坏了、已恢复」
    assert data.get("index_corrupt_recovered") is True
    assert data.get("index_quarantined") is True
    assert data.get("hits") == []

    # 2) 坏文件被改名保留（留证，不删）
    from pathlib import Path

    quarantined = [p for p in Path(root).rglob("index.db.corrupt-*")]
    assert quarantined, "坏库必须被改名保留，不许静默删除"

    # 3) 触发了一次 force 重建
    assert rebuilt, "隔离坏库后必须调度重建，否则这个 root 永久不可用"
    assert rebuilt[0].get("force") is True


def test_search_index_still_raises_on_non_corruption_errors(monkeypatch, tmp_path):
    """边界：争锁/超时这类「库没坏」的错误必须原样抛出，不许被吃成「已恢复」。"""
    root = str(tmp_path).replace("\\", "/")

    def _boom(*args, **kwargs):
        raise sqlite3.DatabaseError("database is locked")

    monkeypatch.setattr(S, "_search_index_impl", _boom)
    with pytest.raises(sqlite3.DatabaseError, match="locked"):
        S.search_index(workspace_root=root, query="x")


def test_quarantine_releases_leaked_loan_connection(tmp_path):
    """隔离前必须主动关掉**借出未归还**的连接，否则 Windows 改名恒 [WinError 32]。

    【self-evolution-bot · 2026-11-22 · 第126轮 · 模型:deepseek-v4.1-flash】
    现网实证（2026-11-22 19:46，agent=case-fullstack-dev，root=ai-showcase）：
      工具回执写「The bad file has been quarantined …suffix」，但盘上一个
      `.corrupt-*` 都没有，`quick_check` 仍是同一份坏库（freelist 页损坏）。
      逐层探针定位到：`_search_index_impl` 是手动 `__enter__()/__exit__()`（不是 with），
      查询在 `conn.execute(...)` 抛 `DatabaseError` 直接跳出函数 → `__exit__` 永不执行
      → 那条连接一直攥着 index.db 的句柄 → `os.replace` 全员 PermissionError。
    本测试先证真「握着连接时改不了名」，再证「隔离函数能主动释放并改名成功」。
    不 mock sqlite：mock 掉就变成测自己的 mock。
    """
    from pathlib import Path

    root = S.resolve_index_root(workspace_root=str(tmp_path).replace("\\", "/"), thread_id=None)
    dbp = S.index_db_path(root)
    dbp.parent.mkdir(parents=True, exist_ok=True)

    # 先建一个**能连上**的库并把连接借出来不归还（复刻异常路径上的漏放）。
    # 为什么要能连上：坏库连 `__enter__` 的 PRAGMA 都会抛，根本借不到连接，
    #   那种情况测不到「句柄泄漏」。真实泄漏发生在库还完好、后续才损坏的场景。
    scope = S._search_conn_scope(root)
    conn = scope.__enter__()
    # 借到连接之后再把它写成真损坏（模拟「握着句柄时库坏了」）
    conn.close()  # 先释放，避免写入被自己锁住
    dbp.write_bytes(b"\x13\x37 not a sqlite database \x00\xff" * 40)
    import sqlite3 as _s

    scope2 = S._search_conn_scope(root)
    held = _s.connect(str(dbp))
    scope2.conn = held  # 直接注入一条**真攥着坏库**的连接，复刻泄漏态
    scope2._track()

    # 先证真：此刻改名必然失败（否则本测试什么都没在测）
    probe_dst = Path(str(dbp) + ".pretend")
    try:
        dbp.replace(probe_dst)
        renamed_while_held = True
    except (PermissionError, OSError):
        renamed_while_held = False
    assert not renamed_while_held, "前提不成立：连接没被持有时本测试测不到泄漏"

    moved = S._quarantine_corrupt_index(root)
    assert moved, "隔离必须真的把坏文件改名（返回空 = 没隔离成功）"
    assert not Path(str(dbp)).exists()
    assert [p for p in Path(root).rglob("index.db.corrupt-*")]
    # 泄漏表也必须清干净，否则下一条检索还会拿到指向已改名文件的旧句柄
    assert not S._SEARCH_LIVE_SCOPES.get(str(root))
    assert conn is not None
