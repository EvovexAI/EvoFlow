"""【self-evolution-bot · 2026-11-16 · 第26轮】代码索引「一文件多块」向量结构的回归锁。

为什么要有这组测试：把向量模型换成本地 `BAAI/bge-small-zh-v1.5`（512 维、0 元、
20~26 ms/块 vs 云端 770 ms/文件）之后，**整文件嵌入会掉质量**——
本地 max_seq_length 只有 512 token，而仓库文件 chars/token P50=2.5，
600 字符≈240 token，一个 2 万字符的文件模型平均只看得到 31.8% 的内容。
实测同一批 60 文件 / 8 查询：整文件本地 top1 2/8、MRR 0.317；
切块（600 字符 / 75 重叠）后 top1 5/8、MRR 0.752，反超云端整文件（4/8、0.713）。

所以 `code_vec` 从「一文件一向量」改成「一文件多块」。这个改动有三处**静默失效**的口子，
一旦被谁改回去，现网只会安静地退化成「省钱但更差」，不会有任何报错：

1. 建表退回 `path TEXT PRIMARY KEY` —— 维度对了、度量对了，但每文件只剩 1 个向量；
2. 召回不做文件聚合 —— 一个文件的几十个块会把 top_k 全占满，实际只召回 1 个文件；
3. 增量路径不切块 —— 全量建的文件有几十块、刚改过的文件只有 1 块，召回系统性偏斜。

断言全部离线（嵌入函数被替换），不依赖网络与真实模型。
"""

from __future__ import annotations

import sqlite3

import pytest

from evoflow.code_index import store as S
from evoflow.config.code_index_config import CodeIndexConfig

pytestmark = pytest.mark.skipif(
    __import__("importlib").util.find_spec("sqlite_vec") is None,
    reason="sqlite-vec 未安装，vec0 相关断言无从谈起",
)

DIM = 512
FAKE_VEC = [0.01] * DIM


def _connect_mod(tmp_path):
    """造一个只装了 vec0 的连接（不碰现网库）。"""
    import sqlite_vec

    dbp = tmp_path / "idx.db"
    conn = sqlite3.connect(str(dbp))
    conn.enable_load_extension(True)
    conn.load_extension(sqlite_vec.loadable_path())
    conn.row_factory = sqlite3.Row
    return conn


@pytest.fixture()
def Conn(tmp_path):
    conn = _connect_mod(tmp_path)
    yield conn
    conn.close()


@pytest.fixture()
def cfg() -> CodeIndexConfig:
    # 配置里故意留旧的静态 512：本地 bge 恰好也是 512，但链路不得依赖这个数
    return CodeIndexConfig(semantic_search_enabled=True, semantic_embedding_dim=512)


# ---------------------------------------------------------------------------
# 1) 建表结构：必须是块级
# ---------------------------------------------------------------------------


def test_vec_create_sql_is_chunked_with_path_aux_column() -> None:
    """建表语句主键必须是 chunk_id，path 只能是辅助列。

    vec0 支持带辅助列的 KNN（实测可用）。若退回 ``path TEXT PRIMARY KEY``，
    每个文件只会存 1 个向量 —— 本地模型又只能看到开头约 1280 字符。
    """
    sql = S._vec_create_sql(DIM)
    assert "chunk_id TEXT PRIMARY KEY" in sql, sql
    assert "path TEXT," in sql or "path TEXT ," in sql or "path TEXT, " in sql, sql
    # 反证：绝不能出现 path 当主键
    assert "path TEXT PRIMARY KEY" not in sql, sql
    assert "distance_metric=cosine" in sql, sql


def test_table_vec_is_chunked_detects_old_layout(Conn) -> None:
    """结构探测要能认出旧的一文件一向量表。"""
    Conn.execute(
        "CREATE VIRTUAL TABLE code_vec USING vec0("
        f"path TEXT PRIMARY KEY, embedding FLOAT[{DIM}] distance_metric=cosine)"
    )
    assert S._table_vec_is_chunked(Conn) is False
    Conn.execute("DROP TABLE code_vec")
    Conn.execute(S._vec_create_sql(DIM, if_not_exists=True))
    assert S._table_vec_is_chunked(Conn) is True


def test_ensure_vec_table_dim_rebuilds_when_layout_old_even_if_dim_and_metric_ok(
    Conn,
) -> None:
    """维度对、度量对，但还是一文件一向量 —— 必须重建。

    这是最容易漏的一条：只看维度和度量的话，现网那张「512 维 + cosine + 一文件一向量」
    的表会被判定为「已对齐」而留着，切块收益等于完全没生效。
    """
    Conn.execute(
        "CREATE VIRTUAL TABLE code_vec USING vec0("
        f"path TEXT PRIMARY KEY, embedding FLOAT[{DIM}] distance_metric=cosine)"
    )
    assert S._table_vec_dim(Conn) == DIM
    assert S._table_vec_metric(Conn) == "cosine"
    assert S._table_vec_is_chunked(Conn) is False

    assert S._ensure_vec_table_dim(Conn, DIM) is True
    assert S._table_vec_is_chunked(Conn) is True, "旧结构没被重建"
    # 二次调用幂等：已对齐不得反复 DROP（否则每次索引都清空向量）
    assert S._ensure_vec_table_dim(Conn, DIM) is True
    assert S._table_vec_is_chunked(Conn) is True


# ---------------------------------------------------------------------------
# 2) 切块函数
# ---------------------------------------------------------------------------


def test_chunk_text_bounds_and_coverage() -> None:
    """块长不超上限、非空白、且覆盖全文（不丢尾巴）。"""
    text = "".join(f"line {i}\n" for i in range(400))
    chunks = S._chunk_text(text)
    assert chunks, "长文本必须切出块"
    assert all(len(c) <= S._CHUNK_CHARS for c in chunks)
    assert all(c.strip() for c in chunks), "不得产出空白块（云端接口遇空 input 整批 400）"
    # 覆盖性：原文每个字符至少出现在某块里
    covered = set()
    for c in chunks:
        start = text.find(c)
        assert start >= 0, "块内容必须来自原文"
        covered.update(range(start, start + len(c)))
    assert len(covered) == len(text), f"只覆盖 {len(covered)}/{len(text)} 字符，尾巴丢了"


def test_chunk_text_overlaps_so_boundaries_are_not_cut() -> None:
    """相邻块必须有重叠，否则跨块边界的函数会被切断、两侧都检索不到。"""
    step = S._CHUNK_CHARS - S._CHUNK_OVERLAP
    assert S._CHUNK_OVERLAP > 0
    assert 0 < step < S._CHUNK_CHARS
    # 用递增数字当内容（不用重复单字符）：同字符文本里 find() 只能定位到第一个，
    # 无法证明块的起点是按 step 步进的。
    text = "".join(f"{i:06d}," for i in range(S._CHUNK_CHARS))
    chunks = S._chunk_text(text)
    assert len(chunks) >= 3
    starts = [text.find(c) for c in chunks]
    assert all(s >= 0 for s in starts), "每块都必须能在原文中唯一定位"
    assert starts[1] - starts[0] == step, f"步进应为 {step}，实为 {starts[1]-starts[0]}"
    assert starts[2] - starts[1] == step


def test_chunk_text_short_file_is_single_chunk() -> None:
    """短文件不该凭空多切出块（否则短文件在召回里被过度加权）。"""
    assert len(S._chunk_text("def f():\n    return 1\n")) == 1
    assert S._chunk_text("   \n\n  ") == []


# ---------------------------------------------------------------------------
# 3) 写入：一文件多块 + 空文件不入库
# ---------------------------------------------------------------------------


def test_index_embeddings_writes_multiple_chunks_per_file(
    monkeypatch, tmp_path, cfg
) -> None:
    """一个长文件必须写出多行，chunk_id 形如 ``rel::N``，path 辅助列指向原文件。"""
    ws = tmp_path / "ws"
    ws.mkdir()
    long_text = "".join(f"def fn_{i}(x):\n    return x * {i}\n" for i in range(120))
    (ws / "long.py").write_text(long_text, encoding="utf-8")
    (ws / "short.py").write_text("def hello():\n    return 1\n", encoding="utf-8")
    (ws / "empty.py").write_text("", encoding="utf-8")

    monkeypatch.setattr(S, "_embed_texts_sync", lambda ts: [list(FAKE_VEC) for _ in ts])
    monkeypatch.setattr(S, "_resolved_embedding_dim", lambda *a, **k: DIM)

    n = S._index_embeddings_sync(
        str(ws), ws, [ws / "long.py", ws / "short.py", ws / "empty.py"], cfg
    )
    expect_chunks = len(S._chunk_text(long_text)) + 1
    assert n == expect_chunks, f"应写 {expect_chunks} 块，实写 {n}"

    import sqlite_vec

    conn = sqlite3.connect(str(S._db_path(str(ws))))
    conn.enable_load_extension(True)
    conn.load_extension(sqlite_vec.loadable_path())
    conn.row_factory = sqlite3.Row
    try:
        assert S._table_vec_is_chunked(conn) is True
        rows = conn.execute("SELECT chunk_id, path FROM code_vec").fetchall()
        assert len(rows) == expect_chunks
        long_rows = [r for r in rows if r["path"] == "long.py"]
        assert len(long_rows) > 1, "长文件只写了 1 个向量 = 切块没生效"
        assert all(str(r["chunk_id"]).startswith(f"{r['path']}::") for r in rows)
        # 空文件不得入库（云端遇空 input 整批 400）
        assert not [r for r in rows if r["path"] == "empty.py"]
    finally:
        conn.close()


def test_index_embeddings_batches_do_not_require_whole_corpus_in_memory(
    monkeypatch, tmp_path, cfg
) -> None:
    """必须分批嵌入：单次调用条数不得超过 _EMBED_CHUNK_BATCH。

    切块后全仓约 14 万块，一次性喂给 encode 会把 512 维 × 14 万向量
    全部驻留内存（≈290 MB）且单次 encode 超过现有 30s 看门狗。
    """
    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / "big.py").write_text("a" * (S._CHUNK_CHARS * 200), encoding="utf-8")

    sizes: list[int] = []

    def _fake(texts):
        sizes.append(len(texts))
        return [list(FAKE_VEC) for _ in texts]

    monkeypatch.setattr(S, "_embed_texts_sync", _fake)
    monkeypatch.setattr(S, "_resolved_embedding_dim", lambda *a, **k: DIM)
    S._index_embeddings_sync(str(ws), ws, [ws / "big.py"], cfg)

    assert sizes, "没有发生嵌入调用"
    assert max(sizes) <= S._EMBED_CHUNK_BATCH, f"单批喂了 {max(sizes)} 条，未分批"
    assert len(sizes) > 1, "块数超过单批上限却只调用了一次 = 没分批"


# ---------------------------------------------------------------------------
# 4) 召回：按文件聚合去重
# ---------------------------------------------------------------------------


def _insert(conn, chunk_id, path, vec):
    conn.execute(
        "INSERT INTO code_vec(chunk_id, path, embedding) VALUES (?, ?, ?)",
        (chunk_id, path, S._pack_vec(vec)),
    )


def test_semantic_recall_aggregates_chunks_to_files(monkeypatch, Conn, cfg) -> None:
    """一个文件的多个块全占 top-k 时，仍必须返回 top_k 个**不同文件**。"""
    Conn.execute(S._vec_create_sql(4, if_not_exists=True))
    # a.py 的 5 个块全部与查询完全同向 —— 不聚合就会把 top_k 占满
    for i in range(5):
        _insert(Conn, f"a.py::{i}", "a.py", [1.0, 0.0, 0.0, 0.0])
    _insert(Conn, "b.py::0", "b.py", [0.9, 0.4, 0.0, 0.0])
    _insert(Conn, "c.py::0", "c.py", [0.5, 0.85, 0.0, 0.0])
    Conn.commit()

    monkeypatch.setattr(S, "_embed_query_sync", lambda q: [1.0, 0.0, 0.0, 0.0])
    hits = S._semantic_recall_sync(Conn, "q", 3, cfg)

    paths = [h["path"] for h in hits]
    assert len(paths) == 3, f"应返回 3 个不同文件，实得 {paths}"
    assert len(set(paths)) == len(paths), f"文件重复未去重：{paths}"
    assert paths[0] == "a.py"
    # 同文件只留一行，且必须是该文件里最相似的那块；块向量完全相同时
    # vec0 返回顺序不保证（实测可能是 ::4），所以只断言属于该文件、不是别的文件
    assert str(hits[0]["chunk_id"]).startswith("a.py::"), hits[0]["chunk_id"]


def test_semantic_recall_fanout_is_what_fills_top_k(monkeypatch, Conn, cfg) -> None:
    """反证：把 fanout 降成 1 就填不满 top_k —— 证明放大候选是必需的，不是保险。"""
    Conn.execute(S._vec_create_sql(4, if_not_exists=True))
    for i in range(5):
        _insert(Conn, f"a.py::{i}", "a.py", [1.0, 0.0, 0.0, 0.0])
    _insert(Conn, "b.py::0", "b.py", [0.9, 0.4, 0.0, 0.0])
    _insert(Conn, "c.py::0", "c.py", [0.5, 0.85, 0.0, 0.0])
    Conn.commit()

    monkeypatch.setattr(S, "_embed_query_sync", lambda q: [1.0, 0.0, 0.0, 0.0])
    monkeypatch.setattr(S, "_SEMANTIC_CHUNK_FANOUT", 1)
    hits = S._semantic_recall_sync(Conn, "q", 3, cfg)
    assert len(hits) < 3, f"fanout=1 竟然也能填满，说明测试前提不成立：{hits}"


# ---------------------------------------------------------------------------
# 5) 删除与增量：旧块不得残留
# ---------------------------------------------------------------------------


def test_delete_path_removes_all_chunks_of_that_file(Conn) -> None:
    """删文件要清掉它全部的块，否则召回会返回已删除文件的旧内容。"""
    # _delete_path_from_index 会连带清 FTS/symbols/deps，需要完整 schema
    S._ensure_schema(Conn)
    # _ensure_schema 会按「当前生效向量模型」的真实维度建 code_vec（本机 2048），
    # 这里重建成本测试用的 4 维小表，避免为一个纯删除断言灌 2048 维向量。
    Conn.execute("DROP TABLE IF EXISTS code_vec")
    Conn.execute(S._vec_create_sql(4, if_not_exists=True))
    for i in range(3):
        _insert(Conn, f"a.py::{i}", "a.py", [1.0, 0.0, 0.0, 0.0])
    _insert(Conn, "b.py::0", "b.py", [0.0, 1.0, 0.0, 0.0])
    Conn.commit()

    S._delete_path_from_index(Conn, "a.py")
    Conn.commit()

    remain = Conn.execute("SELECT path FROM code_vec").fetchall()
    assert [r["path"] for r in remain] == ["b.py"]


def test_incremental_reindex_replaces_all_chunks(monkeypatch, tmp_path, cfg) -> None:
    """增量重索引必须先清旧块再写新块 —— 文件变短时尾块不能残留。"""
    ws = tmp_path / "ws"
    ws.mkdir()
    f = ws / "m.py"
    f.write_text("b" * (S._CHUNK_CHARS * 6), encoding="utf-8")

    monkeypatch.setattr(S, "_embed_texts_sync", lambda ts: [list(FAKE_VEC) for _ in ts])
    monkeypatch.setattr(S, "_resolved_embedding_dim", lambda *a, **k: DIM)

    import sqlite_vec

    dbp = S._db_path(str(ws))
    dbp.parent.mkdir(parents=True, exist_ok=True)
    seed = sqlite3.connect(str(dbp))
    seed.enable_load_extension(True)
    seed.load_extension(sqlite_vec.loadable_path())
    seed.execute(S._vec_create_sql(DIM, if_not_exists=True))
    # 先塞几个「旧块」，模拟文件曾经更长
    for i in range(10):
        _insert(seed, f"m.py::{i}", "m.py", FAKE_VEC)
    seed.commit()
    seed.close()

    monkeypatch.setattr(
        S, "_index_one_file", lambda conn, root, rel, cfgo: 0, raising=False
    )
    # 直接驱动增量更新体
    S.index_file(str(ws), relative_path="m.py")

    conn = sqlite3.connect(str(dbp))
    conn.enable_load_extension(True)
    conn.load_extension(sqlite_vec.loadable_path())
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute("SELECT chunk_id FROM code_vec WHERE path='m.py'").fetchall()
        assert len(rows) < 10, f"旧块没被清掉：{len(rows)} 行"
        assert len(rows) == len(S._chunk_text(f.read_text(encoding="utf-8")))
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# 6) 默认向量模型必须真的被读取
# ---------------------------------------------------------------------------


def test_get_embedding_config_prefers_explicit_default(monkeypatch) -> None:
    """设置里指定的默认向量模型必须优先于「第一个名字含 embedding 的模型」。

    改这个的原因：原来 ``get_embedding_config()`` 完全不看默认设置，
    用户在设置里换了向量模型，代码索引与知识库仍在用旧的那个 —— 设了也白设。
    """
    from evoflow.knowledge.embedding import registry as R

    class _M:
        def __init__(self, name, model, vendor="volcengine"):
            self.name = name
            self.model = model
            self.vendor = vendor
            self.display_name = name
            self.base_url = ""
            self.api_key = ""

    cloud = _M("doubao-embedding-vision", "doubao-embedding-vision")
    local = _M("bge-small-zh", "BAAI/bge-small-zh-v1.5", vendor="local")

    class _Cfg:
        models = [cloud, local]

    monkeypatch.setattr(R, "get_app_config", lambda: _Cfg())

    # 无默认设置 → 回落到扫描（第一个含 embedding 的是云端那条）
    import evoflow.knowledge.owned.settings as owned_settings

    monkeypatch.setattr(owned_settings, "get_default_embedding_model", lambda: "")
    assert R.get_embedding_config().name == "doubao-embedding-vision"

    # 有默认设置 → 必须听设置的
    monkeypatch.setattr(
        owned_settings, "get_default_embedding_model", lambda: "bge-small-zh"
    )
    got = R.get_embedding_config()
    assert got.name == "bge-small-zh", f"默认设置没被尊重，实得 {got.name}"
    assert R._is_local_config(got) is True


# ---------------------------------------------------------------------------
# 7) 索引完整性判定：残缺索引必须被判为「不就绪」，并自动触发重建
#    根因：ready 原来只看「根路径对 + 有文件」，于是被 max_files 截断的库、
#    以及向量 0 行的库全被判为就绪，schedule_build_index 永远返回 index_ready
#    跳过重建 —— 9000 个文件里 6000 个永远进不了库，用户看到的就是「搜不到」。
# ---------------------------------------------------------------------------


def test_index_status_flags_truncated_index(monkeypatch, tmp_path, cfg) -> None:
    """顶到旧上限 3000 且没记上限的旧库 → 必须判残缺。"""
    ws = tmp_path / "ws"
    ws.mkdir()
    dbp = S._db_path(str(ws))
    dbp.parent.mkdir(parents=True, exist_ok=True)
    import sqlite_vec

    conn = sqlite3.connect(str(dbp))
    conn.enable_load_extension(True)
    conn.load_extension(sqlite_vec.loadable_path())
    S._ensure_schema(conn)
    # 造 3000 行 fts_content 模拟截断产物
    conn.executemany(
        "INSERT INTO fts_content(path, content) VALUES (?, ?)",
        [(f"f{i}.py", "x") for i in range(3000)],
    )
    conn.execute("INSERT OR REPLACE INTO meta(key,value) VALUES ('root', ?)", (str(ws),))
    conn.commit()
    conn.close()

    st = S.index_status(workspace_root=str(ws))
    assert st["ready"] is False, "3000 文件顶满旧上限却被判就绪 = 重建永远不会触发"
    assert any("max_files" in r for r in st["stale_reasons"]), st["stale_reasons"]


def test_index_status_flags_missing_vectors(monkeypatch, tmp_path, cfg) -> None:
    """有文件但 code_vec 0 行 → 必须判残缺（语义检索等于不存在）。"""
    ws = tmp_path / "ws"
    ws.mkdir()
    dbp = S._db_path(str(ws))
    dbp.parent.mkdir(parents=True, exist_ok=True)
    import sqlite_vec

    conn = sqlite3.connect(str(dbp))
    conn.enable_load_extension(True)
    conn.load_extension(sqlite_vec.loadable_path())
    S._ensure_schema(conn)
    conn.execute("INSERT INTO fts_content(path, content) VALUES ('a.py','x')")
    conn.execute("INSERT OR REPLACE INTO meta(key,value) VALUES ('root', ?)", (str(ws),))
    conn.execute(
        "INSERT OR REPLACE INTO meta(key,value) VALUES ('indexed_max_files', ?)",
        (str(cfg.max_files),),
    )
    conn.commit()
    conn.close()

    st = S.index_status(workspace_root=str(ws))
    assert st["ready"] is False
    assert "vectors_missing" in st["stale_reasons"], st["stale_reasons"]


def test_index_status_clean_index_is_ready(monkeypatch, tmp_path, cfg) -> None:
    """反证：完整的索引必须判就绪，否则每次调用都重建，索引永远在跑。"""
    ws = tmp_path / "ws"
    ws.mkdir()
    dbp = S._db_path(str(ws))
    dbp.parent.mkdir(parents=True, exist_ok=True)
    import sqlite_vec

    conn = sqlite3.connect(str(dbp))
    conn.enable_load_extension(True)
    conn.load_extension(sqlite_vec.loadable_path())
    S._ensure_schema(conn)
    conn.execute("INSERT INTO fts_content(path, content) VALUES ('a.py','x')")
    conn.execute("INSERT INTO fts_content(path, content) VALUES ('b.py','y')")
    conn.execute("INSERT OR REPLACE INTO meta(key,value) VALUES ('root', ?)", (str(ws),))
    conn.execute(
        "INSERT OR REPLACE INTO meta(key,value) VALUES ('indexed_max_files', ?)",
        (str(cfg.max_files),),
    )
    dim = S._table_vec_dim(conn) or 512
    for p in ("a.py", "b.py"):
        _insert(conn, f"{p}::0", p, [0.1] * dim)
    conn.commit()
    conn.close()

    st = S.index_status(workspace_root=str(ws))
    assert st["ready"] is True, f"完整索引被误判残缺：{st.get('stale_reasons')}"
    assert st["stale_reasons"] == []


def test_schedule_build_index_force_rebuilds_when_stale(monkeypatch, tmp_path) -> None:
    """残缺索引必须自动升级成强制重建，而不是返回 index_ready 跳过。"""
    ws = tmp_path / "ws"
    ws.mkdir()
    seen: list[dict] = []
    monkeypatch.setattr(
        S, "index_status", lambda **kw: {"ready": False, "files": 3001, "stale_reasons": ["vectors_missing"]}
    )
    monkeypatch.setattr(S, "build_index", lambda **kw: seen.append(kw) or {"ok": True})

    r = S.schedule_build_index(workspace_root=str(ws))
    import time as _t

    _t.sleep(0.6)
    assert r.get("status") == "scheduled", f"应调度重建，实得 {r}"
    assert seen, "没有真正调起 build_index"
    assert seen[0].get("force") is True, "残缺索引必须以 force=True 重建"
