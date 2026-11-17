"""【self-evolution-bot · 2026-11-16 · 第25轮】代码索引向量链路的回归锁。

为什么要有这组测试：第24轮查出 code_vec 长期 0 行是三个叠加缺陷造成的
（维度写死 512 vs 实际 2048、建表走 L2 而打分按 cosine、空文件污染整批 400），
三处都是**静默失败**——不抛异常、不报错，只是没有向量。没有断言锁住，
下一个人把任一条改回去，现网也只是安静地退回「语义召回不存在」。

断言全部离线（嵌入函数被替换），不依赖网络与真实模型；
真模型端到端验证在 outputs/selfverify/verify-vec-dim-and-throughput-25.py。
"""

from __future__ import annotations

import logging
import sqlite3
import tempfile
from pathlib import Path

import pytest

from evoflow.code_index import store as S
from evoflow.code_index.symbols import extract_symbols
from evoflow.config.code_index_config import CodeIndexConfig

pytestmark = pytest.mark.skipif(
    __import__("importlib").util.find_spec("sqlite_vec") is None,
    reason="sqlite-vec 未安装，vec0 相关断言无从谈起",
)

DIM = 2048
FAKE_VEC = [0.01] * DIM


@pytest.fixture()
def cfg() -> CodeIndexConfig:
    """把配置里的静态维度留成旧的 512——正是被修掉的那个坑。

    测试要证明：即使配置仍写着 512，链路也必须按真实向量模型走 2048。
    """
    return CodeIndexConfig(semantic_search_enabled=True, semantic_embedding_dim=512)


def _vec_conn(root) -> sqlite3.Connection:
    conn = sqlite3.connect(str(root / "index.db"))
    conn.row_factory = sqlite3.Row
    conn.enable_load_extension(True)
    import sqlite_vec

    conn.load_extension(sqlite_vec.loadable_path())
    return conn


def test_vec_create_sql_pins_cosine_metric() -> None:
    """缺陷 C2 的锁：建表语句必须显式写 cosine。

    不写时 vec0 默认 L2，而 _score() 按 1.0 - cosine_distance 计分，
    2048 维未归一化向量 L2≈1.0~1.35 → 分数全负，语义命中反被沉底。
    """
    sql = S._vec_create_sql(DIM, if_not_exists=False)
    assert f"FLOAT[{DIM}]" in sql
    assert "distance_metric=cosine" in sql
    assert "IF NOT EXISTS" not in sql
    assert "IF NOT EXISTS" in S._vec_create_sql(DIM, if_not_exists=True)


def test_table_vec_dim_and_metric_read_back(tmp_path) -> None:
    """建表后能从 SQL 里读回维度与度量；残缺 SQL 不误报。"""
    conn = _vec_conn(tmp_path)
    try:
        conn.execute(S._vec_create_sql(DIM, if_not_exists=False))
        assert S._table_vec_dim(conn) == DIM
        assert S._table_vec_metric(conn) == "cosine"
        conn.execute("DROP TABLE code_vec")
        assert S._table_vec_dim(conn) is None
        assert S._table_vec_metric(conn) is None
    finally:
        conn.close()


def test_ensure_vec_table_dim_rebuilds_stale_table(tmp_path) -> None:
    """存量 512 维 + L2 的表必须被整体重建（vec0 改不了维度与度量）。

    同时断言「已经对了就不要动」——否则每次索引都重建，向量白算。
    """
    conn = _vec_conn(tmp_path)
    try:
        conn.execute(
            "CREATE VIRTUAL TABLE code_vec USING vec0(path TEXT PRIMARY KEY, embedding FLOAT[512])"
        )
        conn.execute(
            "INSERT INTO code_vec (path, embedding) VALUES ('a.py', ?)",
            (S._pack_vec([0.0] * 512),),
        )
        conn.commit()
        assert S._table_vec_dim(conn) == 512
        assert S._table_vec_metric(conn) is None  # 未声明 = vec0 默认 L2

        assert S._ensure_vec_table_dim(conn, DIM) is True
        assert S._table_vec_dim(conn) == DIM
        assert S._table_vec_metric(conn) == "cosine"
        assert conn.execute("SELECT count(*) FROM code_vec").fetchone()[0] == 0

        # 第二次：口径已对齐，不得再 DROP（写入的数据要留住）
        # 【self-evolution-bot · 2026-11-16 · 第26轮】表已改为块级（chunk_id 主键 + path 辅助列），
        # 写入语句必须跟着带 chunk_id，否则报「declared with a TEXT primary key」。
        conn.execute(
            "INSERT INTO code_vec (chunk_id, path, embedding) VALUES ('b.py::0', 'b.py', ?)",
            (S._pack_vec([0.0] * DIM),),
        )
        conn.commit()
        assert S._ensure_vec_table_dim(conn, DIM) is True
        assert conn.execute("SELECT count(*) FROM code_vec").fetchone()[0] == 1
    finally:
        conn.close()


def test_ensure_vec_table_dim_rebuilds_when_metric_wrong_but_dim_right(tmp_path) -> None:
    """只校验维度会漏掉「维度已对、度量还是 L2」的现网存量表（本机那张就是）。"""
    conn = _vec_conn(tmp_path)
    try:
        conn.execute(
            f"CREATE VIRTUAL TABLE code_vec USING vec0(path TEXT PRIMARY KEY, embedding FLOAT[{DIM}])"
        )
        conn.commit()
        assert S._table_vec_dim(conn) == DIM
        assert S._table_vec_metric(conn) is None
        assert S._ensure_vec_table_dim(conn, DIM) is True
        assert S._table_vec_metric(conn) == "cosine"
    finally:
        conn.close()


def test_index_embeddings_skips_empty_files_without_poisoning_batch(monkeypatch, tmp_path, cfg) -> None:
    """缺陷 C3 的锁：一个空文件混进批次，不能把整批拖成 0 条。

    实测：云端接口遇到空 input 直接 400，而本仓有 len=0 的 __init__.py、
    以及 len=1（只有一个换行）的 __init__.py —— strip() 后为空。
    """
    root_path = tmp_path / "ws"
    root_path.mkdir()
    (root_path / "good.py").write_text("def f():\n    return 1\n", encoding="utf-8")
    (root_path / "empty.py").write_text("", encoding="utf-8")
    (root_path / "newline_only.py").write_text("\n", encoding="utf-8")

    seen: list[str] = []

    def fake_embed(texts: list[str]):
        seen.extend(texts)
        return [list(FAKE_VEC) for _ in texts]

    monkeypatch.setattr(S, "_embed_texts_sync", fake_embed)
    monkeypatch.setattr(S, "get_code_index_config", lambda: cfg)

    files = [root_path / "good.py", root_path / "empty.py", root_path / "newline_only.py"]
    written = S._index_embeddings_sync(str(tmp_path / "idx"), root_path, files, cfg)

    assert written == 1, f"只有 1 个非空文件应写入，实际 {written}"
    assert len(seen) == 1, f"空文件不得送嵌入，实际送了 {len(seen)} 条"
    assert "return 1" in seen[0]


def test_index_embeddings_falls_back_per_file_on_batch_failure(monkeypatch, tmp_path, cfg) -> None:
    """整批失败不能连坐：逐文件重试，能救多少算多少。"""
    root_path = tmp_path / "ws"
    root_path.mkdir()
    (root_path / "a.py").write_text("alpha = 1\n", encoding="utf-8")
    (root_path / "b.py").write_text("beta = 2\n", encoding="utf-8")

    calls: list[int] = []

    def flaky_embed(texts: list[str]):
        calls.append(len(texts))
        if len(texts) > 1:
            return None  # 整批失败
        return [list(FAKE_VEC)]

    monkeypatch.setattr(S, "_embed_texts_sync", flaky_embed)
    monkeypatch.setattr(S, "get_code_index_config", lambda: cfg)

    files = [root_path / "a.py", root_path / "b.py"]
    written = S._index_embeddings_sync(str(tmp_path / "idx"), root_path, files, cfg)

    assert calls[0] == 2, "应先把两文件作为一批送去嵌入"
    assert written == 2, f"逐文件回退后应写入 2 条，实际 {written}"


def test_index_embeddings_uses_actual_vector_dim_not_configured(monkeypatch, tmp_path, cfg) -> None:
    """缺陷 C1 的锁：以真实向量长度为准，不拿配置里的 512 卡。

    cfg.semantic_embedding_dim 仍是 512，但实际向量 2048 → 必须写进去。
    """
    root_path = tmp_path / "ws"
    root_path.mkdir()
    (root_path / "a.py").write_text("alpha = 1\n", encoding="utf-8")

    monkeypatch.setattr(S, "_embed_texts_sync", lambda texts: [list(FAKE_VEC) for _ in texts])
    monkeypatch.setattr(S, "get_code_index_config", lambda: cfg)

    written = S._index_embeddings_sync(str(tmp_path / "idx"), root_path, [root_path / "a.py"], cfg)
    assert written == 1

    conn = _vec_conn(S._db_path(str(tmp_path / "idx")).parent)
    try:
        assert S._table_vec_dim(conn) == DIM
        assert S._table_vec_metric(conn) == "cosine"
    finally:
        conn.close()


def test_semantic_recall_skips_on_dim_mismatch_without_exception(monkeypatch, cfg) -> None:
    """查询向量与表声明维度不一致时返回空并给 warning，不抛异常、不静默 debug。"""
    conn = _vec_conn(Path(tempfile.mkdtemp(prefix="vec-recall-")))
    try:
        conn.execute(S._vec_create_sql(DIM, if_not_exists=False))
        conn.commit()
        monkeypatch.setattr(S, "_embed_query_sync", lambda q: [0.5] * 512)  # 旧口径 512
        records: list[str] = []

        class _H(logging.Handler):
            def emit(self, record):  # noqa: D102
                records.append(record.getMessage())

        handler = _H()
        S.logger.addHandler(handler)
        try:
            hits = S._semantic_recall_sync(conn, "任意查询", 10, cfg)
        finally:
            S.logger.removeHandler(handler)
        assert hits == []
        assert any("维度" in m for m in records), f"应有维度不一致的 warning，实际 {records}"
    finally:
        conn.close()


def test_extract_symbols_keeps_private_functions(tmp_path) -> None:
    """第24轮的锁：`_` 前缀函数必须进符号表（整仓 39.4% 的函数定义是私有的）。"""
    p = tmp_path / "mod.py"
    p.write_text(
        "def public_one():\n    pass\n\n"
        "def _private_one():\n    pass\n\n"
        "class C:\n"
        "    def _private_method(self):\n        pass\n",
        encoding="utf-8",
    )
    syms = extract_symbols(p, p.read_text(encoding="utf-8"), workspace_root=tmp_path)
    names = {s.get("name") for s in syms}
    assert "_private_one" in names, f"私有模块级函数未入表：{sorted(n for n in names if n)}"
    assert "public_one" in names


# 【self-evolution-bot · 2026-11-16 · 第24轮补（发版工程师复验单 2611162212 §三）】
# 上一条用 tmp_path 合成样例，tree-sitter 主路径对「模块级 def」不收录时它会静默跳过
# （本岗实测：旧版 symbols.py 走完整 extract_symbols 对该合成文件仍返回 private=1，断言照样绿）。
# 红绿缺口由此产生——还原 tree_sitter_core.py 到 40b5ba2c^ 后现有测试全绿，符号表修复无回归保护。
# 本条锚定真实仓库文件 + 三条路径分别断言，任何一条路径的 startswith("_") 过滤回归都会变红。
def test_extract_symbols_real_file_all_paths_keep_terminal_fingerprint() -> None:
    """第24轮锁·真文件版：tree-sitter / regex / AST 三路都必须收录 _terminal_command_fingerprint。"""
    from evoflow.code_index.symbols import _ast_python_symbols, _regex_python_symbols

    real = (
        Path(__file__).resolve().parents[1]
        / "packages/harness/evoflow/agents/middlewares/loop_detection_middleware.py"
    )
    text = real.read_text(encoding="utf-8")

    # 1) 完整入口（默认 tree_sitter_first，即生产索引实际走的路径）
    names = {s.get("name") for s in extract_symbols(real, text, workspace_root=real.parent)}
    assert "_terminal_command_fingerprint" in names, f"主路径丢失私有符号：{len(names)} 条"
    assert sum(1 for n in names if n and n.startswith("_")) >= 40, "私有符号占比异常，疑似过滤回归"

    # 2) regex 兜底路径单独锁（发版工程师实测 RED 条件下此路也 private=0，须证明删除真生效）
    rx = _regex_python_symbols(text)
    assert any(s["name"] == "_terminal_command_fingerprint" for s in rx), "regex 路径过滤未删干净"

    # 3) AST 路径单独锁
    ast_syms = _ast_python_symbols(text)
    assert any(s["name"] == "_terminal_command_fingerprint" for s in ast_syms), "AST 路径过滤未删干净"


def test_embed_timeout_scales_with_batch_size() -> None:
    """【第26轮】超时预算必须随批量增长，不能写死 30s。

    实测：云端 doubao 100 条一批要 39.3s（更早 40 条 24.9s），
    而原代码 `_run_async_in_thread(..., timeout=30.0)` 写死 30 秒
    → 每一批都 TimeoutError，网关日志实证：
    「sync batch embedding failed: TimeoutError: _run_async_in_thread timed out after 30.0s」
    → 3000 个文件跑完整索引后 code_vec 仍是 0 行。
    """
    assert S._embed_timeout_seconds(1) >= 60.0
    assert S._embed_timeout_seconds(100) > 30.0, "100 条批量必须给 30s 以上预算（实测需 39.3s）"
    assert S._embed_timeout_seconds(100) > S._embed_timeout_seconds(10), "预算要随批量单调增长"
    assert S._embed_timeout_seconds(200) > S._embed_timeout_seconds(100)


def test_embed_bisect_keeps_alignment_on_partial_failure(monkeypatch) -> None:
    """【第26轮】整批失败时二分拆批，且结果必须与 pairs 一一对齐。

    为什么重要：调用方用 zip(pairs, embeddings, strict=True) 落库，
    一旦错位就会把 A 文件的向量写到 B 文件上——比 0 行更难发现。
    """
    calls: list[int] = []

    def fake(texts: list[str]):
        calls.append(len(texts))
        if len(texts) > 2:
            return None  # 大批失败
        return [[0.25] * 8 for _ in texts]

    monkeypatch.setattr(S, "_embed_texts_sync", fake)
    pairs = [("a.py", "ta"), ("b.py", "tb"), ("c.py", "tc"), ("d.py", "td")]
    out = S._embed_texts_with_bisect(pairs)

    assert len(out) == len(pairs), f"必须等长对齐，实际 {len(out)} vs {len(pairs)}"
    assert all(len(v) == 8 for v in out), "每条都应有向量"
    assert calls == [4, 2, 2], f"应先整批失败再二分，实际批次 {calls}"


def test_embed_bisect_all_fail_returns_placeholders(monkeypatch) -> None:
    """全部失败时返回等长空占位，不能抛异常、不能错位。"""
    monkeypatch.setattr(S, "_embed_texts_sync", lambda texts: None)
    out = S._embed_texts_with_bisect([("a.py", "t"), ("b.py", "u")])
    assert out == [[], []]
