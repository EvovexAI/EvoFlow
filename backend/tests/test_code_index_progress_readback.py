"""锁住「构建进度能被读回来」，防止调用点与定义再次脱节。

【self-evolution-bot · 2026-11-17 · 第31轮】为什么有这条测试：
`_merge_build_progress` 从第31轮起就调用 `_read_persisted_build_progress(conn)`，
`_update_build_progress` 也一直在往 meta 表写 `build_progress.*`，
但**读侧函数体从来没有被写出来过**。调用点抛 AttributeError/NameError，
被 `_read_index_status_unlocked` 外层宽泛 except 吞掉，整个状态查询退化到兜底分支：

    files=0 / symbols=0 / stale_reasons=["status_read_failed"]

现网表现就是「一库 9044 个文件，/index-status 报 files=0、ready=False」，
面板据此判定索引没建好 → 反复触发全量重建 → 每次都被拖回起点。

py_compile 与 ruff 对这类缺陷零分辨力（语法完全合法），
所以必须用断言把「写进去的键能被读回来」钉死。
"""

from __future__ import annotations

import sqlite3

from evoflow.code_index import store as S


def test_read_persisted_build_progress_exists() -> None:
    """函数必须真实存在于模块里，而不是只出现在调用点。"""
    assert hasattr(S, "_read_persisted_build_progress"), (
        "调用点引用了 _read_persisted_build_progress，但模块里没有这个函数——"
        "调用会抛异常并被外层 except 吞成 status_read_failed"
    )
    assert callable(S._read_persisted_build_progress)


def test_persisted_progress_roundtrip(tmp_path) -> None:
    """写 → 读 必须一致；phase 保持字符串，数值字段回读为 int。"""
    db = tmp_path / "idx.db"
    conn = sqlite3.connect(str(db))
    try:
        conn.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
        for k, v in {
            "phase": "embedding",
            "total_files": "9044",
            "indexed_files": "9044",
            "vectors_total": "142000",
            "vectors_done": "43080",
            "symbols": "55965",
            "updated_at": "1794879427",
        }.items():
            conn.execute(
                "INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)",
                (S._PROGRESS_META_PREFIX + k, v),
            )
        conn.commit()

        got = S._read_persisted_build_progress(conn)
    finally:
        conn.close()

    assert got["phase"] == "embedding"
    assert got["total_files"] == 9044
    assert got["indexed_files"] == 9044
    assert got["vectors_total"] == 142000
    assert got["vectors_done"] == 43080
    assert got["symbols"] == 55965
    # 数值字段一律 int，不能留成字符串——_merge_build_progress 里直接 int() 下游比较
    for k in ("total_files", "indexed_files", "vectors_done", "vectors_total"):
        assert isinstance(got[k], int), f"{k} 应为 int，实为 {type(got[k])}"


def test_persisted_progress_empty_is_empty_dict(tmp_path) -> None:
    """没有进度行时返回空 dict，而不是抛异常或返回假数。"""
    db = tmp_path / "idx.db"
    conn = sqlite3.connect(str(db))
    try:
        conn.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
        conn.commit()
        assert S._read_persisted_build_progress(conn) == {}
    finally:
        conn.close()


def test_persisted_progress_missing_table_degrades_quietly(tmp_path) -> None:
    """meta 表缺失时静默返回空 dict —— 进度不在关键路径上，不能反过来打断状态查询。"""
    db = tmp_path / "idx.db"
    conn = sqlite3.connect(str(db))
    try:
        assert S._read_persisted_build_progress(conn) == {}
    finally:
        conn.close()


def test_index_status_does_not_fall_into_read_failed(tmp_path, monkeypatch) -> None:
    """反证核心：库里明明有文件时，status 不许退化成 status_read_failed/files=0。"""
    root = str(tmp_path)
    dbp = S._db_path(root)

    conn = S._connect(root)
    try:
        S._ensure_schema(conn)
        conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES ('root', ?)", (root,)
        )
        conn.execute(
            "INSERT INTO fts_content(path, content) VALUES (?, ?)",
            ("a.py", "def a(): pass"),
        )
        conn.commit()
    finally:
        conn.close()

    assert dbp.exists()
    st = S._read_index_status_unlocked(root, dbp, building=False)

    assert st["files"] == 1, f"库里 1 个文件，状态却报 {st['files']}"
    assert "status_read_failed" not in (st.get("stale_reasons") or []), (
        f"不该退化成读失败：{st.get('stale_reasons')}"
    )
    assert st.get("ok") is True
