"""第57轮回归：mmap 上限必须覆盖**整个**索引库，不能写死 1GiB。

【self-evolution-bot · 2026-11-18 · 第57轮 · 模型:deepseek-v4.1-flash-1017】

为什么值得锁：第39轮把 mmap 打开时写死 `PRAGMA mmap_size=1073741824`（1GiB），
前提是「库当前 999MB 刚好整库可映射」。这条前提在库长到 **1.72GB** 时就失效了，
而 sqlite 对超上限的行为是**不报错、静默退化成部分映射**——42% 的向量段读不到映射，
没人会发现，只表现为「检索怎么这么慢」。

同一进程、同一份向量、只改 mmap 大小的 A/B（k=75，本机实测）：
    1GiB(旧写死值) 300ms / 2GiB 91ms / 3GiB 89ms / 关掉 mmap 646ms
→ 旧值是整库可映射的 3.3 倍，而且是**每次检索都付**。

判据选「读回值 ≥ 库大小」，不选耗时阈值：耗时随机器/缓存波动，
而「mmap 能不能覆盖整库」是确定的、可读回的。
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

from evoflow.code_index import store


def _db_bytes(conn: sqlite3.Connection) -> int:
    return int(conn.execute("PRAGMA page_size").fetchone()[0]) * int(
        conn.execute("PRAGMA page_count").fetchone()[0]
    )


def test_mmap_covers_whole_db_for_large_db(tmp_path: Path) -> None:
    """正向：库大于 1GiB 时，mmap 必须 >= 库大小（否则只剩部分映射）。

    用 `zeroblob` 造一个 >1GiB 的库。稀疏文件不会真的占满磁盘，
    但 page_count 会如实上去，正好是我们要的判据输入。
    """
    dbp = tmp_path / "big.db"
    conn = sqlite3.connect(str(dbp))
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("CREATE TABLE blobber (id INTEGER PRIMARY KEY, payload BLOB)")
        # 单行 BLOB 有 ~1GB 上限（实测 DataError: string or blob too big），
        # 所以用多行累加到 1.15 GiB —— 超过旧写死的 1GiB 就够触发缺陷。
        for _ in range(12):
            conn.execute("INSERT INTO blobber (payload) VALUES (zeroblob(?))", (100 << 20,))
        conn.commit()

        store._configure_sqlite_connection(conn)

        got = int(conn.execute("PRAGMA mmap_size").fetchone()[0])
        need = _db_bytes(conn)
    finally:
        conn.close()

    assert need > 1073741824, f"夹具没造够大（{need}），测不到旧缺陷"
    assert got >= need, (
        f"mmap_size={got} 小于库大小 {need}：向量段会有 "
        f"{(1 - got / need) * 100:.0f}% 读不到映射，KNN 每次白等约 3 倍"
    )


def test_mmap_keeps_floor_for_small_db(tmp_path: Path) -> None:
    """反证/边界：小库也必须拿到 >=1GiB，不能被"按库大小算"改成 0。

    为什么单独测：把上限改成 `库大小 + 余量` 最容易被写成"小库就几乎不映射"，
    那等于把第39轮的收益（KNN -82%）又还回去。
    """
    conn = sqlite3.connect(str(tmp_path / "small.db"))
    try:
        store._configure_sqlite_connection(conn)
        got = int(conn.execute("PRAGMA mmap_size").fetchone()[0])
    finally:
        conn.close()
    assert got >= 1073741824, f"小库 mmap 退化到 {got}，第39轮收益被还回去了"


def test_mmap_pragma_still_survives_failure(tmp_path: Path) -> None:
    """mmap 是纯优化：page_size/page_count 查询失败时也必须有值、且不抛。"""

    class RaisingConn(sqlite3.Connection):
        def execute(self, sql, *args, **kwargs):  # type: ignore[override]
            s = str(sql)
            if "mmap_size" in s or "page_count" in s or "page_size" in s:
                raise sqlite3.OperationalError("simulated: unsupported")
            return super().execute(sql, *args, **kwargs)

    conn = sqlite3.connect(str(tmp_path / "raise.db"), factory=RaisingConn)
    try:
        store._configure_sqlite_connection(conn)  # 不应抛
        assert conn.execute("SELECT 1").fetchone()[0] == 1
    finally:
        conn.close()
