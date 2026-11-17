"""锁住「打开索引库不能拖进 embedding 栈」，防止检索工具再次莫名慢 3~4 秒。

【self-evolution-bot · 2026-11-17 · 第33轮】为什么有这条测试：
`_ensure_schema` 会被**每次检索**调用两次（`index_status` + `search_index`），
它内部走 `_ensure_vec_table -> _resolved_embedding_dim()`，而后者 import
`evoflow.knowledge.embedding.registry`，模块级连带 `base`/`local_provider`，
实测一次拖进 **2426 个模块 / 1063 个重型依赖（transformers+numpy+PIL）/ 4340ms**。

现网表现是：`search_code_index` 每次都花 5.5~13 秒，而同为读取的 `read` 只有 14ms，
差 400 倍；用户感知就是「读取类工具莫名其妙很慢」。

修法：`code_vec` 表已存在时直接返回，不再解析维度（CREATE IF NOT EXISTS 本就是空操作）。
本测试把这条稳态路径钉死：表存在时不得 import embedding 栈，且整个调用必须够快。
"""

from __future__ import annotations

import sys
from pathlib import Path

from evoflow.code_index import store as S

_HARNESS_ROOT = str(Path(__file__).resolve().parents[1] / "packages" / "harness")


def _fresh_conn(tmp_path):
    root = str(tmp_path).replace("\\", "/")
    conn = S._connect(root)
    S._ensure_schema(conn)
    return conn


def test_vec_table_exists_detects_real_table(tmp_path) -> None:
    conn = _fresh_conn(tmp_path)
    try:
        assert S._vec_table_exists(conn) is True
        conn.execute("DROP TABLE IF EXISTS code_vec")
        conn.commit()
        assert S._vec_table_exists(conn) is False
    finally:
        conn.close()


def test_first_index_status_in_fresh_process_is_cheap(tmp_path) -> None:
    """新进程里第一次打开索引库必须够快（这是网关的真实处境）。

    【self-evolution-bot · 2026-11-17 · 第33轮】为什么必须开子进程：
    同进程里前面任何一个用例碰过 embedding，`sys.modules` 就被预热了，
    缺陷在进程内**完全不可见**——我第一版用「本次调用是否新增模块」当判据，
    在把修复关掉之后照样全绿，等于没测。只有全新解释器才能复现：
    修复前首次 2999ms（要 import 4340ms 的 embedding 栈），修复后 ~100ms。
    """
    import subprocess

    root = str(tmp_path).replace("\\", "/")
    # 先用本进程把库建好（含 code_vec），子进程只测「打开已有库」的稳态路径。
    conn = _fresh_conn(tmp_path)
    try:
        assert S._vec_table_exists(conn) is True
    finally:
        conn.close()

    code = (
        "import time, importlib, sys;"
        f"sys.path.insert(0, {str(_HARNESS_ROOT)!r});"
        "st=importlib.import_module('evoflow.code_index.store');"
        f"t=time.perf_counter(); st.index_status(workspace_root={root!r});"
        "print(round((time.perf_counter()-t)*1000))"
    )
    out = subprocess.run(
        [sys.executable, "-c", code], capture_output=True, text=True, timeout=180
    )
    assert out.returncode == 0, out.stderr[-800:]
    first_ms = int(out.stdout.strip().splitlines()[-1])
    assert first_ms < 1000, (
        f"新进程首次 index_status 花 {first_ms}ms，"
        "疑似又去解析 embedding 维度（应只在表不存在时才做）"
    )
