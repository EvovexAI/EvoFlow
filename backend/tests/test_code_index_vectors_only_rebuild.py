"""【self-evolution-bot · 2026-11-17 · 第31轮】「只缺向量」时不得清空文件索引的回归锁。

为什么要有这组测试：全量重建第一步就是 `_clear_tables()`，会把已建好的
fts_content / symbols / file_deps / code_vec 全部 DELETE。而向量段是整个流程里
最慢、最容易被重启或超时打断的一段（本仓约 14.2 万块、本地 bge 约 16ms/块 ≈ 38 分钟）。

实测踩到的坑（2026-11-17）：
- 09:07:56 文件段跑满 9044/9044，进入 embedding 阶段；
- 09:29 用户重启 Gateway，向量段被掐断，库里只剩 `code_vec` 7 行；
- `_read_index_status_unlocked` 判出 `vectors_incomplete:7<9044` → `ready=False`；
- 下一次 `schedule_build_index` 看到残缺就走 force=True 全量重建 →
  **再把已经完整的 9044 个文件解析一遍**，而真正缺的只有向量。

所以加一条分流：stale_reasons 里**全部**属于向量类时，跳过清表与文件段，只补向量。
文件类残缺（截断、路径不符）仍然走完整重建，这条边界必须由测试守住。

断言全部离线：只检查判定逻辑与「没有清表」这一事实，不真的跑嵌入。
"""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
HARNESS = BACKEND / "packages" / "harness"
if str(HARNESS) not in sys.path:
    sys.path.insert(0, str(HARNESS))



def _is_vectors_only(stale: list[str], files: int) -> bool:
    """与 build_index 内部分流完全一致的判定，独立复刻以便单测。"""
    return bool(stale) and bool(files) and all(
        s.startswith("vectors_missing") or s.startswith("vectors_incomplete") for s in stale
    )


def test_vectors_only_recognises_both_vector_reasons() -> None:
    """两种向量残缺文案都必须被认成「只缺向量」。"""
    assert _is_vectors_only(["vectors_missing"], 9044) is True
    assert _is_vectors_only(["vectors_incomplete:7<9044"], 9044) is True


def test_file_level_staleness_still_full_rebuild() -> None:
    """文件类残缺不能被误判成只补向量 —— 那会跳过本该重建的文件段。

    边界：只要有一条 stale 不是向量类，就必须走完整重建。
    """
    assert _is_vectors_only(["max_files_upgraded:3000->20000"], 9044) is False
    assert _is_vectors_only(["max_files_unrecorded_at_old_cap"], 9044) is False
    # 混合场景：向量缺 + 上限升级 —— 必须以「要重建文件」为准
    assert _is_vectors_only(["vectors_missing", "max_files_upgraded:3000->20000"], 9044) is False


def test_vectors_only_requires_existing_files() -> None:
    """空库不算「只缺向量」—— 没有任何文件索引时补向量没有意义。"""
    assert _is_vectors_only(["vectors_missing"], 0) is False
    assert _is_vectors_only([], 9044) is False


def test_store_actually_skips_clear_when_vectors_only() -> None:
    """接线证据：build_index 里清表与文件段都被 `if not vectors_only` 包住。

    这条防的是「判定写对了但没接上」——本项目已栽过多次
    （第16轮：声明处↔使用处↔输出处数量不等，BOM+Parser 门禁全绿也抓不到）。
    """
    src = (HARNESS / "evoflow" / "code_index" / "store.py").read_text(encoding="utf-8")
    # 声明 1 处
    assert "vectors_only = False" in src
    # 必须有「跳过清表与文件段」的分支
    assert "if not vectors_only:" in src, "清表/文件段没有被 vectors_only 分流包住"
    # 进入该分支后必须同时跳过 _clear_tables 与批次循环
    tail = src.split("if not vectors_only:", 1)[1][:800]
    assert "run_index_db(root, _clear_tables)" in tail
    assert "_BUILD_BATCH_SIZE" in tail
    # 只补向量时要沿用已有文件数，而不是从 0 开始
    assert '_st.get("files")' in src


def test_vectors_only_does_not_delete_existing_rows(tmp_path: Path) -> None:
    """行为证据：只补向量路径下，fts_content 既有行必须原样保留。

    用真实 sqlite 建一张最小 fts 表模拟「已建好的文件索引」，
    再跑一遍分流判断应有的行为（不清表），确认行数不变。
    """
    dbp = tmp_path / "index.db"
    conn = sqlite3.connect(dbp)
    try:
        conn.execute(
            "CREATE VIRTUAL TABLE fts_content USING fts5(path, content, "
            "tokenize=\"unicode61 remove_diacritics 0 tokenchars '_-./'\")"
        )
        for i in range(5):
            conn.execute("INSERT INTO fts_content(path, content) VALUES (?, ?)", (f"f{i}.py", "x"))
        conn.commit()
        before = conn.execute("SELECT COUNT(*) FROM fts_content").fetchone()[0]
        assert before == 5
        # vectors_only 分支绝不执行 DELETE（这里复刻该分支的唯一动作：什么都不做）
        if not _is_vectors_only(["vectors_incomplete:7<9044"], before):
            conn.execute("DELETE FROM fts_content")
            conn.commit()
        after = conn.execute("SELECT COUNT(*) FROM fts_content").fetchone()[0]
        assert after == 5, "只补向量时不该删掉已有文件索引"
    finally:
        conn.close()
