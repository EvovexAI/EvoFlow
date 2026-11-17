"""SQLite FTS5 workspace index.

When indexing runs
------------------
- **Full rebuild (blocking API)**: ``POST /api/workspaces/index-build`` — runs in a worker thread on the gateway (HTTP waits until done).
- **Background rebuild (preferred for UI)**: ``POST /api/workspaces/index-warm`` — returns immediately; poll ``GET /api/workspaces/index-status``.
  Default implementation spawns a **subprocess** (``python -m evoflow.code_index.build_worker``)
  so sentence-transformers / sklearn imports cannot GIL-stall the Gateway event loop.
  Set ``EVOFLOW_CODE_INDEX_BUILD_INPROCESS=1`` only for tests that monkeypatch ``build_index``.
- **Incremental**: ``POST /api/workspaces/index-file`` or the background watcher after file changes.
- **Watcher**: ``POST /api/workspaces/index-watch`` (EvoPanel starts after initial build).
- **Lazy**: first search if no DB exists.
- **Throttle**: full rebuild skipped if indexed within ``reindex_min_interval_seconds``.

Where data is stored
--------------------
- Directory: ``<workspace>/.evoflow/code_index/`` (gitignored with the rest of ``.evoflow/``).
- One SQLite file per workspace: ``index.db`` (+ WAL sidecars).
- Tables: ``fts_content`` (FTS5), ``symbols``, ``file_deps``, ``internal_refs``, ``type_relations``, ``meta``.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import sqlite3
import struct
import subprocess
import sys
import threading
import time
from collections import defaultdict
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any, Protocol, TypeVar

from evoflow.code_index.deps import (
    dependency_neighbors,
    extract_file_deps,
    list_importers,
    list_outgoing_imports,
)
from evoflow.code_index.symbols import extract_symbols
from evoflow.code_index.tokenize import build_fts_aux_text, index_tokenizer_version, tokens_from_text
from evoflow.config.code_index_config import CodeIndexConfig, get_code_index_config
from evoflow.utils.workspace_browse import resolve_under_workspace

logger = logging.getLogger(__name__)

T = TypeVar("T")

# Porter stemmer hurts code identifiers (CredentialPool, assistant_chunk). unicode61 keeps them.
_FTS_TOKENIZE = "unicode61 remove_diacritics 0 tokenchars '_-./'"
_FTS_SCHEMA_VERSION = "unicode61_v2"
_BUILD_BATCH_SIZE = 50

# Relative to the bound workspace root (same layout as project memory under ``.evoflow/``).
CODE_INDEX_REL_DIR = Path(".evoflow") / "code_index"
CODE_INDEX_DB_NAME = "index.db"

_SKIP_DIRS = {
    ".git",
    "node_modules",
    "__pycache__",
    ".venv",
    "venv",
    "dist",
    "build",
    ".next",
    "_next",  # Next.js export (out/_next/static/chunks) — minified bundles, not source
    "target",
    "binaries",
    "_internal",
    # 【self-evolution-bot · 2026-11-17 · 第32轮】删掉 "code_index" 条目。
    # 原注释意图是「不索引索引库自身」，但索引库在 <root>/.evoflow/code_index/，
    # 那个 "code_index" 片段的上层是 ".evoflow"，早已被下面的 p.startswith(".") 挡掉；
    # 这一条真正拦掉的是**索引器自己的源码目录** backend/packages/harness/evoflow/code_index/，
    # 导致 15 个源文件（store.py / symbols.py / tree_sitter_core.py …）0 行入库，
    # 实测搜 "_read_persisted_build_progress" 搜不到它自己的定义。
    # 索引库不会被误收：_TEXT_SUFFIXES 不含 .db，且 .evoflow/ 仍被点目录规则排除。
}
_TEXT_SUFFIXES = {
    ".py",
    ".js",
    ".ts",
    ".tsx",
    ".jsx",
    ".java",
    ".go",
    ".kt",
    ".rs",
    ".md",
    ".yaml",
    ".yml",
    ".json",
    ".toml",
    ".sql",
    ".html",
    ".css",
    ".scss",
    ".sh",
    ".ps1",
    ".vue",
    ".cs",
    ".cpp",
    ".h",
    ".hpp",
    ".c",
}


def resolve_index_root(
    *,
    workspace_root: str | None = None,
    thread_id: str | None = None,
) -> str:
    """Resolve absolute workspace directory for indexing (local root or thread sandbox)."""
    root_s = str(workspace_root or "").strip()
    if root_s:
        return str(resolve_under_workspace(root_s, "."))
    tid = str(thread_id or "").strip()
    if tid:
        from evoflow.tools.host_direct.workspace_context import resolve_host_workspace_root_for_files

        host = resolve_host_workspace_root_for_files(thread_id=tid)
        if host:
            return str(resolve_under_workspace(host, "."))
        from evoflow.config.paths import get_paths

        sandbox = get_paths().sandbox_work_dir(tid)
        sandbox.mkdir(parents=True, exist_ok=True)
        return str(sandbox.resolve())
    raise ValueError("workspace_root or thread_id is required")


def _workspace_hash(root: str) -> str:
    return hashlib.sha256(str(root).encode("utf-8")).hexdigest()[:16]


def index_db_path(workspace_root: str) -> Path:
    """SQLite index file for a resolved workspace root: ``<root>/.evoflow/code_index/index.db``."""
    root = Path(workspace_root).resolve()
    base = root / CODE_INDEX_REL_DIR
    base.mkdir(parents=True, exist_ok=True)
    return base / CODE_INDEX_DB_NAME


def _db_path(root: str) -> Path:
    return index_db_path(root)


def index_freshness(root: str) -> dict:
    """索引库最后写入时刻与年龄（秒）。

    【self-evolution-bot · 2026-11-17 · 第33轮】用户问「搜索的时效性你能看到吗」——
    实测**看不到**：`search_index` 的返回里只有 `rebuild_in_progress`，
    而 `format_results` 只在「正在构建」时打一行 stale 提示；
    `index_status` 虽有 `updated_at`/`stale_reasons`，但那是 /index-status 接口用的，
    不随工具结果返回。于是判断「这份结果可不可信」只能额外跑一次 sqlite 手查
    （实测查一次要 index_age≈5 分钟），等于每次多绕一步，多数时候就不绕了。
    现在把新鲜度直接挂进搜索结果，让调用方一眼看到「这份索引几岁」。
    """
    dbp = _db_path(root)
    try:
        mtime = dbp.stat().st_mtime
    except OSError:
        return {"index_updated_at": None, "index_age_seconds": None}
    age = max(0, int(time.time() - mtime))
    return {
        "index_updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(mtime)),
        "index_age_seconds": age,
    }


def _configure_sqlite_connection(conn: sqlite3.Connection) -> None:
    """Match main app DB pragmas so searches survive background index builds."""
    conn.execute("PRAGMA busy_timeout=60000")
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    _load_sqlite_vec_extension(conn)


def _load_sqlite_vec_extension(conn: sqlite3.Connection) -> None:
    """Best-effort load of the ``sqlite-vec`` extension for vec0 vector table."""
    global _SQLITE_VEC_LOAD_WARNED, _SQLITE_VEC_AVAILABLE  # noqa: PLW0603
    try:
        import sqlite_vec

        conn.enable_load_extension(True)
        conn.load_extension(sqlite_vec.loadable_path())
        _SQLITE_VEC_AVAILABLE = True
    except Exception as exc:  # noqa: BLE001 - optional, must never block
        _SQLITE_VEC_AVAILABLE = False
        logger.debug("code_index: sqlite-vec extension not loaded: %s", exc)
        # 【self-evolution-bot · 2026-11-16 · 第23轮】P2 可见性（判定单 §四）：
        # 为什么：静默降级曾导致「code_vec 建好却 0 行」类问题无人察觉；
        # 首次失败升级 WARNING 一次（进程内），index_status 暴露 vector_available。
        if not _SQLITE_VEC_LOAD_WARNED:
            _SQLITE_VEC_LOAD_WARNED = True
            logger.warning(
                "code_index: sqlite-vec extension failed to load (semantic vector recall disabled): %s",
                exc,
            )


_SQLITE_VEC_LOAD_WARNED = False
_SQLITE_VEC_AVAILABLE: bool | None = None


def _sqlite_vec_available(conn: sqlite3.Connection) -> bool:
    """Whether vec0 module is actually usable on this connection (probe once, cache)."""
    global _SQLITE_VEC_AVAILABLE  # noqa: PLW0603
    if _SQLITE_VEC_AVAILABLE is not None:
        return _SQLITE_VEC_AVAILABLE
    try:
        row = conn.execute("SELECT COUNT(*) FROM pragma_module_list WHERE name='vec0'").fetchone()
        _SQLITE_VEC_AVAILABLE = bool(row and int(row[0]) > 0)
    except Exception:  # noqa: BLE001 - health probe must never break status
        _SQLITE_VEC_AVAILABLE = False
    return _SQLITE_VEC_AVAILABLE


def _connect(root: str) -> sqlite3.Connection:
    dbp = _db_path(root)
    dbp.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(dbp), timeout=60.0)
    conn.row_factory = sqlite3.Row
    _configure_sqlite_connection(conn)
    return conn


_workspace_locks_guard = threading.Lock()
_workspace_locks: dict[str, threading.RLock] = {}


def _workspace_db_lock(root: str) -> threading.RLock:
    key = _workspace_hash(root)
    with _workspace_locks_guard:
        lock = _workspace_locks.get(key)
        if lock is None:
            lock = threading.RLock()
            _workspace_locks[key] = lock
        return lock


def _is_sqlite_busy(exc: BaseException) -> bool:
    msg = str(exc).lower()
    return "locked" in msg or "busy" in msg


def run_index_db[T](root: str, fn: Callable[[], T], *, max_attempts: int = 10) -> T:
    """Serialize index DB access per workspace + retry on sqlite busy/locked."""
    lock = _workspace_db_lock(root)
    last: BaseException | None = None
    for attempt in range(max(1, int(max_attempts))):
        with lock:
            try:
                return fn()
            except sqlite3.OperationalError as exc:
                last = exc
                if not _is_sqlite_busy(exc):
                    raise
        if attempt >= max_attempts - 1:
            break
        time.sleep(min(0.05 * (2**attempt), 1.0))
    if last:
        raise last
    raise RuntimeError("run_index_db failed without exception")


def _migrate_fts_if_needed(conn: sqlite3.Connection) -> None:
    """Recreate FTS when legacy porter / path-unindexed schema is detected."""
    row = conn.execute("SELECT value FROM meta WHERE key='fts_schema_version'").fetchone()
    if row and str(row[0]) == _FTS_SCHEMA_VERSION:
        return
    sql_row = conn.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='fts_content'").fetchone()
    ddl = str(sql_row[0] if sql_row else "")
    if not ddl:
        return
    ddl_lc = ddl.lower()
    legacy = "porter" in ddl_lc or "path unindexed" in ddl_lc.replace("\n", " ")
    if not legacy:
        conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES ('fts_schema_version', ?)",
            (_FTS_SCHEMA_VERSION,),
        )
        conn.commit()
        return
    logger.info("code_index: migrating fts_content from legacy schema (%s…)", ddl[:80])
    conn.execute("DROP TABLE IF EXISTS fts_content")
    fts_tokenize_sql = f'"{_FTS_TOKENIZE}"'
    conn.execute(
        f"""
        CREATE VIRTUAL TABLE fts_content USING fts5(
            path,
            content,
            tokenize={fts_tokenize_sql}
        )
        """
    )
    conn.execute(
        "INSERT OR REPLACE INTO meta(key, value) VALUES ('fts_schema_version', ?)",
        (_FTS_SCHEMA_VERSION,),
    )
    conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES ('fts_needs_rebuild', '1')")
    conn.commit()


def _ensure_schema(conn: sqlite3.Connection) -> None:
    fts_tokenize_sql = f'"{_FTS_TOKENIZE}"'
    conn.executescript(
        f"""
        CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY,
            value TEXT
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS fts_content USING fts5(
            path,
            content,
            tokenize={fts_tokenize_sql}
        );
        CREATE TABLE IF NOT EXISTS symbols (
            path TEXT NOT NULL,
            name TEXT NOT NULL,
            kind TEXT NOT NULL,
            line INTEGER NOT NULL,
            PRIMARY KEY (path, name, line)
        );
        CREATE TABLE IF NOT EXISTS file_deps (
            from_path TEXT NOT NULL,
            spec TEXT NOT NULL,
            line INTEGER NOT NULL DEFAULT 0,
            to_path TEXT,
            dep_kind TEXT NOT NULL DEFAULT 'import',
            PRIMARY KEY (from_path, spec, line)
        );
        CREATE INDEX IF NOT EXISTS idx_file_deps_from ON file_deps(from_path);
        CREATE INDEX IF NOT EXISTS idx_file_deps_to ON file_deps(to_path);
        CREATE TABLE IF NOT EXISTS internal_refs (
            from_path TEXT NOT NULL,
            to_path TEXT NOT NULL,
            line INTEGER NOT NULL DEFAULT 0,
            ref_kind TEXT NOT NULL DEFAULT 'import_use',
            symbol TEXT,
            PRIMARY KEY (from_path, to_path, line, ref_kind, symbol)
        );
        CREATE INDEX IF NOT EXISTS idx_internal_refs_to ON internal_refs(to_path);
        CREATE INDEX IF NOT EXISTS idx_internal_refs_from ON internal_refs(from_path);
        CREATE TABLE IF NOT EXISTS type_relations (
            from_path TEXT NOT NULL,
            from_type TEXT NOT NULL,
            to_path TEXT,
            to_type TEXT NOT NULL,
            rel_kind TEXT NOT NULL DEFAULT 'extends',
            line INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (from_path, from_type, to_type, rel_kind, line)
        );
        CREATE INDEX IF NOT EXISTS idx_type_relations_from ON type_relations(from_path);
        CREATE INDEX IF NOT EXISTS idx_type_relations_to ON type_relations(to_path);
        CREATE INDEX IF NOT EXISTS idx_type_relations_from_type ON type_relations(from_type);
        CREATE INDEX IF NOT EXISTS idx_type_relations_to_type ON type_relations(to_type);
        CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name COLLATE NOCASE);
        """
    )
    conn.commit()
    _migrate_fts_if_needed(conn)
    _ensure_vec_table(conn)
    row = conn.execute("SELECT value FROM meta WHERE key='fts_schema_version'").fetchone()
    if not row:
        conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES ('fts_schema_version', ?)",
            (_FTS_SCHEMA_VERSION,),
        )
        conn.commit()


def _vec_table_exists(conn: sqlite3.Connection) -> bool:
    """``code_vec`` 是否已建好。

    【self-evolution-bot · 2026-11-17 · 第33轮】新增。仅查 sqlite_master，不做任何
    embedding 栈 import —— 用来把「表已存在」的稳态路径压到微秒级。
    """
    try:
        row = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='code_vec' LIMIT 1"
        ).fetchone()
        return row is not None
    except sqlite3.Error:
        return False


def _ensure_vec_table(conn: sqlite3.Connection) -> None:
    """Create the ``code_vec`` vec0 virtual table for semantic search.

    Best-effort: if sqlite-vec is not loaded, the table is skipped and
    semantic search degrades to FTS5-only.
    """
    cfg = get_code_index_config()
    if not cfg.semantic_search_enabled:
        return
    # 【self-evolution-bot · 2026-11-17 · 第33轮】表已存在就**不解析维度**。
    # 为什么：CREATE VIRTUAL TABLE IF NOT EXISTS 对已存在的表本就是空操作，
    # 但 _resolved_embedding_dim() 要 import evoflow.knowledge.embedding.registry，
    # 连带拖进 base -> transformers/numpy/PIL（实测 2426 模块 / 4340ms）。
    # 而 _ensure_vec_table 由 _ensure_schema 调用，_ensure_schema 又在**每次检索**
    # 里被调两次（index_status + search_index），于是「打开索引库」稳定花 3~4s，
    # 用户感知就是搜索类工具莫名其妙很慢。稳态下这里应当接近 0 成本。
    if _vec_table_exists(conn):
        return
    # 【self-evolution-bot · 2026-11-16 · 第24轮】维度不再照抄配置里的静态 512。
    # 为什么：512 是本地 bge-small-zh 的维度，而当前生效的向量模型是云端 2048 维，
    # 于是每条向量插入都被拒（Dimension mismatch Expected 512 but received 2048），
    # 且只落 debug 日志——code_vec 建好了却 0 行，语义召回等于不存在。
    # 同时显式声明 distance_metric=cosine：_score() 的注释本来就是按
    # 「1.0 - cosine_distance，范围 0~1」写的，但建表没写度量 → vec0 默认 L2，
    # 2048 维未归一化向量 L2 ≈1.0~1.35，score 全成负数，语义命中反被沉到最底。
    dim = _resolved_embedding_dim(cfg)
    try:
        conn.execute(_vec_create_sql(dim, if_not_exists=True))
        conn.commit()
    except sqlite3.OperationalError as exc:
        if "vec0" in str(exc).lower() or "no such module" in str(exc).lower():
            logger.debug("code_index: vec0 module not available, semantic search disabled")
        else:
            raise


def _resolved_embedding_dim(cfg: CodeIndexConfig | None = None) -> int:
    """【self-evolution-bot · 2026-11-16 · 第24轮】按「当前生效的向量模型」解析维度。

    配置里的 ``semantic_embedding_dim`` 只是本地 bge-small-zh 的旧默认值（512）。
    换成云端模型（doubao-embedding-vision = 2048）后它不会自动跟着变，
    于是每条向量插入都被 vec0 拒绝，code_vec 建好了却 0 行。
    这里优先按模型 id 查已知维度表，查不到才退回配置值；
    真正的兜底在 :func:`_ensure_vec_table_dim`——以实际产出的向量长度为准。
    """
    base = cfg or get_code_index_config()
    configured = int(getattr(base, "semantic_embedding_dim", 0) or 0) or 512
    try:
        from evoflow.knowledge.embedding.registry import (
            get_embedding_config,
            known_embedding_dim,
        )

        mc = get_embedding_config()
        model_id = str(getattr(mc, "model", "") or "").strip()
        known = known_embedding_dim(model_id)
        if known:
            return int(known)
    except Exception as exc:  # noqa: BLE001 - 维度解析失败不能挡住索引
        logger.debug("code_index: resolve embedding dim failed: %s", exc)
    return configured


def _vec_create_sql(dim: int, *, if_not_exists: bool = True) -> str:
    """【self-evolution-bot · 2026-11-16 · 第24轮】code_vec 建表语句统一出口。

    显式写 ``distance_metric=cosine``，与实际使用方式对齐：
    ``_score()`` 按 ``score = 1.0 - cosine_distance``（0~1）计分并 ×100 加重排。
    不写度量时 vec0 默认 L2，2048 维未归一化向量的 L2 距离 ≈1.0~1.35，
    score 全为负数，语义命中反而被排到最底。

    【self-evolution-bot · 2026-11-16 · 第26轮】主键从 ``path`` 改成 ``chunk_id``，
    ``path`` 降为辅助列（vec0 支持带辅助列的 KNN，实测可用）。
    为什么必须一文件多向量：本地 bge-small-zh ``max_seq_length=512`` token，
    而仓库文件按 ``chars/token`` P50=2.5 折算，**55/60 个文件超长**，
    整文件嵌入平均只看到 31.8% 的内容——本地 top1 只有 2/8（云端整文件 4/8）。
    切块后同一批查询本地 top1 升到 5/8、MRR 0.752 > 云端 0.713。
    也就是说：不切块，本地模型是「省钱但更差」；切块之后才「又省钱又更好」。
    """
    ine = "IF NOT EXISTS " if if_not_exists else ""
    return (
        f"CREATE VIRTUAL TABLE {ine}code_vec USING vec0("
        f"chunk_id TEXT PRIMARY KEY, path TEXT, "
        f"embedding FLOAT[{int(dim)}] distance_metric=cosine)"
    )


# 【self-evolution-bot · 2026-11-16 · 第26轮】切块参数。
# 依据是实测而非直觉：在 150 个真实仓库文件上量「切出来的块有多少超过 512 token」，
#   chunk=600  overlap=75  -> 超限 0.21%   (块数 141,994 / 全量 ≈37.9 分钟)
#   chunk=900  overlap=112 -> 超限 5.00%
#   chunk=1200 overlap=150 -> 超限 22.49%
#   chunk=1500 overlap=187 -> 超限 70.80%
# 取 600/75 是唯一「几乎零截断」档；再大一档就有 5% 的块被模型静默截尾。
# 重叠取 chunk/8：跨块边界的函数签名与实现都能落在同一块里，避免切丢上下文。
_CHUNK_CHARS = 600
_CHUNK_OVERLAP = 75

# 【self-evolution-bot · 2026-11-16 · 第26轮】每批嵌入多少块。
# 实测本地 bge 在 batch=64 时 16.1 ms/块、batch=128 时 16.0 ms/块、batch=32 时 27.9 ms/块，
# 64 与 128 基本同速，取 64：单批 encode 约 1 秒，远低于 30s 看门狗，
# 且中途失败只损失 64 块而不是整仓。
_EMBED_CHUNK_BATCH = 64

# 【self-evolution-bot · 2026-11-16 · 第26轮】语义召回的块→文件放大倍数。
# 一文件多块后，KNN 取 top_k 个块可能全落在同一文件里，必须放大候选再按文件聚合。
# 取 5：按 600 字符/块计，一个命中文件平均贡献远小于 5 个高分块，
# 放大 5 倍足以让 top_k 个不同文件填满，又不会把 KNN 成本放大太多。
_SEMANTIC_CHUNK_FANOUT = 5


def _chunk_text(text: str) -> list[str]:
    """【self-evolution-bot · 2026-11-16 · 第26轮】把文件正文切成定长重叠块。

    纯字符切分，不引入 tokenizer 依赖——索引路径上多跑一遍分词没必要，
    且 ``bge`` 的 tokenizer 与模型绑定，放在这里会让 code_index 反依赖
    sentence-transformers（云端模型时本地根本没装）。
    600/75 这组参数是按实测截断率选的（见 ``_CHUNK_CHARS`` 上方数据）。
    """
    step = _CHUNK_CHARS - _CHUNK_OVERLAP
    if step <= 0:  # 防御：参数写坏时退化成不重叠，别死循环
        step = _CHUNK_CHARS
    out: list[str] = []
    n = len(text)
    i = 0
    while i < n:
        piece = text[i : i + _CHUNK_CHARS]
        if piece.strip():
            out.append(piece)
        if i + _CHUNK_CHARS >= n:
            break
        i += step
    return out


def _table_vec_metric(conn: sqlite3.Connection) -> str | None:
    """code_vec 声明的距离度量（``cosine`` / ``l2`` / None=vec0 默认 L2）。"""
    try:
        row = conn.execute("SELECT sql FROM sqlite_master WHERE name='code_vec'").fetchone()
    except sqlite3.OperationalError:
        return None
    if not row or not row[0]:
        return None
    m = re.search(r"distance_metric\s*=\s*(\w+)", str(row[0]), re.IGNORECASE)
    return m.group(1).lower() if m else None


def _table_vec_is_chunked(conn: sqlite3.Connection) -> bool:
    """【self-evolution-bot · 2026-11-16 · 第26轮】code_vec 是否已是「一文件多块」结构。

    判据是主键名：旧表 ``path TEXT PRIMARY KEY``（一文件一向量），
    新表 ``chunk_id TEXT PRIMARY KEY, path TEXT``（辅助列）。
    只看维度会漏掉「维度已对但还是一文件一向量」的存量表，
    那种表即使维度对了，本地模型仍然只能看到每个文件的前 512 token。
    """
    try:
        row = conn.execute("SELECT sql FROM sqlite_master WHERE name='code_vec'").fetchone()
    except sqlite3.OperationalError:
        return False
    if not row or not row[0]:
        return False
    return "chunk_id" in str(row[0])


def _table_vec_dim(conn: sqlite3.Connection) -> int | None:
    """code_vec 声明的向量维度（从建表 SQL 的 ``FLOAT[n]`` 读）；表不存在返回 None。"""
    try:
        row = conn.execute("SELECT sql FROM sqlite_master WHERE name='code_vec'").fetchone()
    except sqlite3.OperationalError:
        return None
    if not row or not row[0]:
        return None
    m = re.search(r"FLOAT\[(\d+)\]", str(row[0]), re.IGNORECASE)
    return int(m.group(1)) if m else None


def _ensure_vec_table_dim(conn: sqlite3.Connection, dim: int) -> bool:
    """确保 code_vec 的声明维度与实际向量维度一致、且距离度量为 cosine；不符就整表重建。

    vec0 的维度与度量都写死在建表语句里、改不了，只能 DROP 重建。
    重建后向量要等下一轮索引重跑才补得回来，所以这里必须用 warning，
    不能再像原来那样静默 continue——0 行向量等于语义召回根本不存在。

    【self-evolution-bot · 2026-11-16 · 第24轮】补上度量校验：
    只看维度会漏掉「维度已对、但度量还是 vec0 默认 L2」的现网存量表
    （本机那张就是 2048 + L2），负分排序问题会一直留着。

    【self-evolution-bot · 2026-11-16 · 第26轮】再加结构校验：
    一文件一向量（主键 ``path``）的旧表必须重建为块级表（主键 ``chunk_id``），
    否则本地模型仍只能看到每个文件开头 600 字符，切块收益等于没生效。
    """
    if not dim or dim <= 0:
        return False
    current = _table_vec_dim(conn)
    metric = _table_vec_metric(conn)
    chunked = _table_vec_is_chunked(conn)
    if current == dim and metric == "cosine" and chunked:
        return True
    if current is not None:
        if not chunked:
            logger.warning(
                "code_index: code_vec 重建（一文件一向量 → 一文件多块，dim=%d）；"
                "重建后需重新索引补齐向量",
                dim,
            )
        else:
            logger.warning(
                "code_index: code_vec 重建（维度 %s→%d，度量 %s→cosine）；重建后需重新索引补齐向量",
                current,
                dim,
                metric or "l2(默认)",
            )
        try:
            conn.execute("DROP TABLE IF EXISTS code_vec")
            conn.commit()
        except sqlite3.OperationalError as exc:
            logger.warning("code_index: 重建 code_vec 失败: %s", exc)
            return False
    try:
        conn.execute(_vec_create_sql(dim, if_not_exists=True))
        conn.commit()
        return True
    except sqlite3.OperationalError as exc:
        logger.warning("code_index: code_vec 建表失败（vec0 不可用？）: %s", exc)
        return False


def _path_has_skipped_segment(rel: str) -> bool:
    parts = Path(rel).as_posix().split("/")
    return any(p in _SKIP_DIRS or p.startswith(".") for p in parts if p)


def _dir_escapes_workspace(child: Path, root_resolved: Path) -> bool:
    """True if *child* is a symlink/junction or otherwise resolves outside *root_resolved*.

    Windows directory junctions report ``is_symlink() is False`` / ``os.path.islink`` False,
    so ``os.walk(..., followlinks=False)`` still descends into them and indexes foreign
    repos (e.g. EvoFlow/clawdevoflow → ../evo/clawdevoflow). Skip those.
    """
    try:
        if child.is_symlink():
            return True
        is_junc = getattr(child, "is_junction", None)
        if callable(is_junc) and bool(is_junc()):
            return True
        child.resolve().relative_to(root_resolved)
        return False
    except (ValueError, OSError):
        return True


def _normalize_path_prefix(prefix: str | None) -> str | None:
    p = str(prefix or "").strip().replace("\\", "/").strip("/")
    return p or None


def _path_under_prefix(rel_path: str, prefix: str | None) -> bool:
    pref = _normalize_path_prefix(prefix)
    if not pref:
        return True
    rel = str(rel_path or "").replace("\\", "/").strip("/")
    # Exact prefix match (fast path)
    if rel == pref or rel.startswith(pref + "/"):
        return True
    # Fuzzy match: if the prefix is a single directory name (no /), match it
    # as any path segment. e.g. path:react matches evopanel/src/react/ChatApp.tsx
    if "/" not in pref:
        segments = rel.split("/")
        # Check if any directory segment matches the prefix
        # (exclude the filename — last segment)
        return any(seg == pref for seg in segments[:-1])
    # Multi-segment prefix: try matching the last segment as a directory name
    # e.g. path:src/react matches evopanel/src/react/... even if user omitted evopanel/
    last_seg = pref.rsplit("/", 1)[-1]
    if last_seg and len(last_seg) >= 2:
        segments = rel.split("/")
        if any(seg == last_seg for seg in segments[:-1]):
            # Verify the full prefix tail matches the path tail
            pref_segs = pref.split("/")
            for i in range(len(segments) - len(pref_segs) + 1):
                if segments[i : i + len(pref_segs)] == pref_segs:
                    return True
    return False


def _looks_like_identifier_token(tok: str) -> bool:
    t = str(tok or "").strip()
    if len(t) < 2:
        return False
    if t.casefold() in _SEARCH_STOPWORDS:
        return False
    if re.fullmatch(r"[A-Za-z_]\w*", t):
        if "_" in t or "-" in t:
            return True
        if re.search(r"[A-Z]", t) and re.search(r"[a-z]", t):
            return True
        if t[0].isupper():
            return True
        return len(t) >= 6
    return False


def _strip_seps(text: str) -> str:
    """去掉下划线/连字符/空格并小写 —— 用于分隔符不敏感的符号比对。

    【self-evolution-bot · 2026-11-17 · 第32轮】见 _search_symbols 里的用法。
    """
    return re.sub(r"[_\-\s]+", "", str(text or "")).lower()


def _name_tokens(name: str) -> list[str]:
    """把符号名切成小写词元：camelCase / snake_case / kebab-case 都拆开。

    【self-evolution-bot · 2026-11-17 · 第36轮】整句比对需要「按词」而不是「按字符」
    比较，否则 `plugin uninstall` 与 `plugins_uninstall` 差一个 s 就判不等。
    """
    s = str(name or "")
    s = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", s)
    s = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1 \2", s)
    return [t.lower() for t in re.split(r"[^A-Za-z0-9]+", s) if t]


def _sing_tok(word: str) -> str:
    """词尾单数化（只动词尾，不做词干提取，避免误伤 progress/series 这类词）。"""
    w = str(word or "").lower()
    if len(w) > 3 and w.endswith("ies"):
        return w[:-3] + "y"
    if len(w) > 3 and w.endswith("ses"):
        return w[:-2]
    if len(w) > 2 and w.endswith("s") and not w.endswith("ss"):
        return w[:-1]
    return w


def _whole_name_matches(whole_query: str, name: str) -> bool:
    """整句匹配：查询词元序列与符号名词元序列**逐位相等**（单复数视为相等）。

    实测收益（见第36轮）：`plugin uninstall` 曾完全查不到 `plugins_uninstall`
    （去分隔符后 'pluginuninstall' vs 'pluginsuninstall'，严格全等失败），
    首条给的是短泛名 `uninstall`。按词元比对后两侧都是
    ['plugin','uninstall'] vs ['plugins','uninstall']，单数化后一致 → 命中。
    """
    # 判据一（主）：去分隔符后全等。覆盖绝大多数情况，且不会误伤
    # ZCodeBackgroundTaskControlItem 这类「大写缩写连写」—— 词元方案会把
    # ZCode 拆成 z/code，反而对不上（第36轮我先漏掉这条，一次退化了 4 条）。
    if _strip_seps(whole_query) == _strip_seps(name):
        return True
    # 判据二（补）：逐词元相等，单复数归一。专治 plugin↔plugins 这种差一个 s、
    # 全等判据够不着的情况。
    q = _name_tokens(whole_query)
    n = _name_tokens(name)
    if not q or len(q) != len(n):
        return False
    return all(_sing_tok(a) == _sing_tok(b) for a, b in zip(q, n))


def _hyphen_variants(term: str) -> list[str]:
    """Expand hyphen spellings (``dall-e`` ↔ ``dalle``) for symbol + FTS lookup."""
    t = str(term or "").strip()
    if not t or len(t) < 3 or not re.fullmatch(r"[\w-]+", t):
        return []
    out: list[str] = []
    if "-" in t:
        collapsed = re.sub(r"-+", "", t)
        if collapsed != t and len(collapsed) >= 3:
            out.append(collapsed)
        underscored = t.replace("-", "_")
        if underscored != t:
            out.append(underscored)
    # 【self-evolution-bot · 2026-11-17 · 第32轮】删掉原来的 elif 反向分支：
    #   它把任何「纯小写 ASCII 词」机械拆成 t[:-1] + "-" + t[-1]，
    #   于是 read/progress/build 被扩展出 persiste-d / progres-s / buil-d 这类
    #   任何源码里都不存在的词项，全部并进 FTS 的 OR 查询里稀释相关性。
    #   实测（query=_read_persisted_build_progress）：12 个词项里 6 个是这样的垃圾，
    #   候选池被 "build"/"progress" 之类泛词占满，真命中被挤出前 10。
    #   原意图 dall-e → dalle 那类「用户输入带连字符」的情况，上面的 if 分支已覆盖；
    #   反向（dalle → dall-e）没有证据表明有用，且无法验证哪个位置该插连字符。
    return out


def _boost_filename_path_matches(
    hits: list[dict],
    symbols: list[dict],
    *,
    query: str,
    query_body: str | None = None,
) -> tuple[list[dict], list[dict]]:
    """Move rows whose path matches a filename-like query to the front."""
    q = str(query_body if query_body is not None else query or "").strip()
    if q.startswith("path:"):
        q = q.split(" ", 1)[1] if " " in q else ""
    if not q:
        return hits, symbols
    base = q.replace("\\", "/").split("/")[-1].casefold()
    if not base:
        return hits, symbols

    def _tier(row: dict) -> int:
        p = str(row.get("path") or "").replace("\\", "/").casefold()
        fname = p.split("/")[-1]
        stem = fname.rsplit(".", 1)[0] if "." in fname else fname
        if fname == base or stem == base or p.endswith(f"/{base}"):
            return 0
        if base in fname or base in stem:
            return 1
        if base in p:
            return 2
        return 3

    # Stable sort: same-tier rows preserve their input order (which comes
    # from _rerank_index_rows and includes semantic similarity scores).
    # Using just the tier (not (tier, path)) as the key ensures semantic
    # hits are not re-sorted alphabetically and sunk below FTS5 noise.
    return (
        sorted(hits, key=_tier),
        sorted(symbols, key=_tier),
    )


_KIND_BONUS: dict[str, float] = {
    "function": 10.0,
    "def": 10.0,
    "method": 10.0,
    "async_function": 10.0,
    "class": 8.0,
    "class_definition": 8.0,
    "interface": 9.0,
    "constructor": 8.0,
    "enum": 5.0,
    "type": 6.0,
    "type_alias": 6.0,
    "variable": 2.0,
    "constant": 3.0,
    "property": 3.0,
    "field": 3.0,
    "import": 1.0,
    "module": 4.0,
}


def _rerank_index_rows(
    hits: list[dict],
    symbols: list[dict],
    *,
    terms: list[str],
    path_prefix: str | None,
    query_body: str,
) -> tuple[list[dict], list[dict]]:
    """Unified relevance sort for content hits and symbol rows."""

    def _score(row: dict) -> float:
        score = 0.0
        path = str(row.get("path") or "")
        name = str(row.get("name") or "")
        match_rank = int(row.get("match_rank") or 0)

        # Semantic vector similarity: use the score from _semantic_recall_sync
        # (score = 1.0 - cosine_distance, range ~0..1). Scale ×100 so a strong
        # semantic match (≈0.8) gets ~80 pts — competitive with keyword exact
        # name match (+100) but below it, and well above FTS5 noise (+4).
        # Without this, semantic hits have _score ≈ 0 and sink to the bottom.
        if str(row.get("kind") or "") == "semantic":
            sem = float(row.get("score") or 0.0)
            score += sem * 100.0

        # 【self-evolution-bot · 2026-11-17 · 第34轮】整句全等（match_rank=5）必须压过
        # 「某个短词恰好等于符号名」（match_rank=4）。原实现所有 >=3 一律 +120，
        # 于是查 `resolve data paths` 时，符号 `resolve()` 靠下面 terms 的
        # `n == t` 再加 100 分，比真目标 resolve_data_paths 还高 —— 检索层排对了，
        # 这里又给推翻。分档必须单调。
        if match_rank >= 5:
            score += 260.0
        elif match_rank >= 3:
            score += 120.0
        elif match_rank == 2:
            score += 70.0
        elif match_rank == 1:
            score += 30.0
        for term in terms:
            t = term.casefold()
            if name:
                n = name.casefold()
                if n == t:
                    score += 100.0
                elif n.startswith(t) and len(t) >= 2:
                    score += 55.0
                elif len(term) >= 5 and t in n:
                    score += 22.0
            if t in path.casefold():
                score += 10.0
        if path_prefix and _path_under_prefix(path, path_prefix):
            score += 45.0
        qb = str(query_body or "").strip().casefold()
        if qb:
            fname = path.replace("\\", "/").split("/")[-1].casefold()
            stem = fname.rsplit(".", 1)[0] if "." in fname else fname
            qb_base = qb.split("/")[-1]
            if fname == qb_base or stem == qb_base:
                score += 85.0
        kind = str(row.get("kind") or "").lower().strip()
        score += _KIND_BONUS.get(kind, 0)
        if kind == "content":
            score += 4.0
        return score

    hits_out = sorted(hits, key=lambda r: (-_score(r), str(r.get("path") or "")))
    symbols_out = sorted(
        symbols,
        key=lambda r: (-_score(r), str(r.get("name") or ""), str(r.get("path") or "")),
    )
    return hits_out, symbols_out


def _filter_index_rows(rows: list[dict], *, path_prefix: str | None, limit: int) -> list[dict]:
    """Drop polluted paths (bundled deps) and apply optional path scope.

    [self-evolution-bot 2026-11-17 第32轮] 签名一度放宽成 limit: int | None
    （想支持「不在 rerank 前截断」），但两个调用点都传具体值、None 分支无人走，
    且该改动复算不出差别 —— 已撤回，签名与调用实际保持一致。
    """
    out: list[dict] = []
    for row in rows:
        p = str(row.get("path") or "")
        if not p or _path_has_skipped_segment(p):
            continue
        if not _path_under_prefix(p, path_prefix):
            continue
        out.append(row)
        if len(out) >= limit:
            break
    return out


def _normalize_relative_path(root: Path, relative_path: str) -> str:
    rel = str(relative_path or "").strip().replace("\\", "/")
    if not rel or rel in {".", "/"}:
        raise ValueError("relative_path is required")
    resolved = resolve_under_workspace(str(root), rel)
    return resolved.relative_to(root.resolve()).as_posix()


def _should_index_file(path: Path) -> bool:
    if path.suffix.lower() not in _TEXT_SUFFIXES:
        return False
    try:
        if path.stat().st_size > 512_000:
            return False
    except OSError:
        return False
    return True


# ---------------------------------------------------------------------------
# Semantic search helpers (embedding + vec0 recall)
# ---------------------------------------------------------------------------


def _pack_vec(values: Sequence[float]) -> bytes:
    """Pack floats into little-endian float32 blob for vec0."""
    return struct.pack(f"{len(values)}f", *values)


async def _embed_texts_batch(texts: list[str]) -> list[list[float]] | None:
    """Batch embed texts via the active embedding model.

    Returns ``None`` on failure so callers can gracefully degrade to FTS5-only.
    """
    try:
        from evoflow.knowledge.embedding import get_embeddings

        return await get_embeddings(texts, purpose="index")
    except Exception as exc:
        logger.warning("code_index: batch embedding failed: %s: %s", type(exc).__name__, exc)
        return None


async def _embed_query(text: str) -> list[float] | None:
    """Embed a search query. Returns ``None`` on failure."""
    try:
        from evoflow.knowledge.embedding import get_embedding

        return await get_embedding(text, purpose="query")
    except Exception as exc:
        logger.warning("code_index: query embedding failed: %s: %s", type(exc).__name__, exc)
        return None


def _embed_texts_sync(texts: list[str]) -> list[list[float]] | None:
    """Synchronous batch embedding — bypasses ``asyncio.to_thread``.

    Used by :func:`_index_embeddings_sync` which already runs in a
    background thread.  Calling the async :func:`get_embeddings` from
    there would invoke ``asyncio.to_thread`` inside a fresh event loop
    created by :func:`_run_async_in_thread`, which can fail with
    *cannot schedule new futures after interpreter shutdown* when the
    global ThreadPoolExecutor is in a bad state.

    For local providers we call ``model.encode()`` directly via the
    provider's ``embed_batch_sync``; for cloud providers we fall back
    to the async path.
    """
    try:
        from evoflow.knowledge.embedding.local_provider import LocalEmbeddingProvider
        from evoflow.knowledge.embedding.registry import (
            _resolve_provider,
            get_embedding_config,
        )

        try:
            asyncio.get_running_loop()
            loop_running = True
        except RuntimeError:
            loop_running = False

        mc = get_embedding_config()
        provider = _resolve_provider(mc)
        if isinstance(provider, LocalEmbeddingProvider):
            from evoflow.knowledge.embedding.usage_meter import embedding_usage_scope

            with embedding_usage_scope(purpose="index"):
                return provider.embed_batch_sync(texts)
        if loop_running:
            logger.debug(
                "code_index: skip sync remote batch embed while event loop is running"
            )
            return None
        # 【self-evolution-bot · 2026-11-16 · 第26轮】超时不再写死 30 秒，按批大小给预算。
        # 为什么：云端 doubao 实测 770~794 ms/文件，一批 100 条要 77~79 秒，
        # 而这里原来硬编码 30.0s —— 每一批都必然 TimeoutError，
        # 网关日志实证：「sync batch embedding failed: TimeoutError: _run_async_in_thread
        # timed out after 30.0s (daemon still running)」，于是 3000 个文件走完整索引后
        # code_vec 仍是 0 行。批量嵌入是「一个都不能少」的路径，超时预算必须跟着批量走。
        budget = _embed_timeout_seconds(len(texts))
        return _run_async_in_thread(lambda: _embed_texts_batch(texts), timeout=budget)
    except Exception as exc:
        logger.warning(
            "code_index: sync batch embedding failed: %s: %s (%d 条)",
            type(exc).__name__,
            exc,
            len(texts),
        )
        return None


def _embed_timeout_seconds(n_texts: int) -> float:
    """【self-evolution-bot · 2026-11-16 · 第26轮】按批量给嵌入超时预算。

    云端实测 770~794 ms/文件（100 条 ≈ 77~79 s），本地 bge 约 20~26 ms/文件。
    取 1.2 s/文件 + 60 s 底，既是云端 1.5 倍余量，也不会让本地小批量空等。
    """
    return max(60.0, 1.2 * max(1, int(n_texts or 1)))


def _embed_texts_with_bisect(pairs: list[tuple[str, str]]) -> list[list[float]]:
    """【self-evolution-bot · 2026-11-16 · 第26轮】整批失败时二分拆批重试。

    保持与 ``pairs`` 一一对齐（失败的位放空列表占位），
    这样调用方 ``zip(pairs, embeddings, strict=True)`` 不会错位。
    单条仍失败就放弃该条——一条坏数据不该拖垮整库。
    """
    if not pairs:
        return []
    got = _embed_texts_sync([t for _, t in pairs])
    if got and len(got) == len(pairs):
        return got
    if len(pairs) == 1:
        return [[]]
    mid = len(pairs) // 2
    return _embed_texts_with_bisect(pairs[:mid]) + _embed_texts_with_bisect(pairs[mid:])


def _embed_query_sync(text: str) -> list[float] | None:
    """Synchronous query embedding — bypasses ``asyncio.to_thread``.

    Must not be called from the gateway asyncio thread with a remote provider:
    that path used to ``Thread.join`` for tens of seconds (429 retries) and
    froze the whole UI. Local providers stay sync; remote embeds from a
    running loop are skipped (callers fall back to FTS / overlap).
    """
    try:
        try:
            asyncio.get_running_loop()
            loop_running = True
        except RuntimeError:
            loop_running = False

        from evoflow.knowledge.embedding.local_provider import LocalEmbeddingProvider
        from evoflow.knowledge.embedding.registry import (
            _resolve_provider,
            get_embedding_config,
        )

        mc = get_embedding_config()
        provider = _resolve_provider(mc)
        if isinstance(provider, LocalEmbeddingProvider):
            from evoflow.knowledge.embedding.usage_meter import embedding_usage_scope

            with embedding_usage_scope(purpose="query"):
                return provider.embed_sync(text)
        if loop_running:
            logger.debug(
                "code_index: skip sync remote embed while event loop is running"
            )
            return None
        return _run_async_in_thread(lambda: _embed_query(text), timeout=8.0)
    except Exception as exc:
        logger.warning(
            "code_index: sync query embedding failed: %s: %s",
            type(exc).__name__,
            exc,
        )
        return None


def _run_async_in_thread(
    coro_factory: Callable[[], Any],
    *,
    timeout: float | None = 15.0,
) -> Any:
    """Run an async coroutine in a separate thread with its own event loop.

    This avoids ``Cannot run the event loop while another loop is running``
    when :func:`build_index` / :func:`search_index` are called from within an
    async context (e.g. tests using ``asyncio.run``).

    Never call this from the *same* thread that owns a running loop and then
    join forever — that stalls the gateway. If a loop is already running on
    this thread, refuse immediately. ``timeout`` caps ``join`` for worker-thread
    callers (remote embed 429 retries can otherwise hang for minutes).
    """
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        pass
    else:
        raise RuntimeError(
            "refusing _run_async_in_thread while an event loop is running on this thread"
        )

    result: list[Any] = [None]
    exception: list[BaseException | None] = [None]

    def _runner() -> None:
        try:
            loop = asyncio.new_event_loop()
            try:
                result[0] = loop.run_until_complete(coro_factory())
            finally:
                loop.close()
        except BaseException as exc:  # noqa: BLE001
            exception[0] = exc

    t = threading.Thread(target=_runner, daemon=True)
    t.start()
    t.join(timeout=timeout)

    if t.is_alive():
        raise TimeoutError(
            f"_run_async_in_thread timed out after {timeout}s (daemon still running)"
        )

    if exception[0] is not None:
        raise exception[0]
    return result[0]


def _index_embeddings_sync(
    root: str,
    root_path: Path,
    files: list[Path],
    cfg: CodeIndexConfig,
) -> int:
    """Batch-embed files and store vectors in ``code_vec``.

    Called after the FTS/symbols batch loop in :func:`build_index`.
    Runs embedding in a fresh event loop because the build path is
    synchronous (background thread). Returns the number of files embedded.
    """
    if not cfg.semantic_search_enabled:
        return 0

    # Collect (rel_path, text) pairs
    # 【self-evolution-bot · 2026-11-16 · 第24轮】跳过空/纯空白文本。
    # 为什么：云端向量接口遇到空 input 直接整单 400（实测
    # "The parameter `input` ... input could not be empty"），
    # 而本仓有 8 个 len=0 的 __init__.py 之类文件，只要有一个混进批次，
    # 整批嵌入全部失败 → code_vec 长期 0 行，语义召回根本不存在。
    pairs: list[tuple[str, str]] = []
    skipped_empty = 0
    for fp in files:
        try:
            rel = fp.relative_to(root_path).as_posix()
            text = fp.read_text(encoding="utf-8", errors="replace")[: cfg.max_chars_per_file]
        except OSError:
            continue
        if not text.strip():
            skipped_empty += 1
            continue
        # 【self-evolution-bot · 2026-11-16 · 第26轮】一文件切成多块再嵌入。
        # 为什么：本地 bge-small-zh 的 max_seq_length 只有 512 token，
        # 而仓库文件 chars/token P50=2.5 → 600 字符≈240 token、48k 字符≈19k token。
        # 整文件嵌入时模型只看前 512 token（≈1280 字符），一个 2 万字符的文件
        # 平均只有 31.8% 的内容进入向量——这是本地 top1 只有 2/8 的真因，不是模型差。
        # pairs 的元素改成 (rel, chunk_text)，下面按块写入 code_vec。
        for idx, piece in enumerate(_chunk_text(text)):
            pairs.append((rel, piece))

    if skipped_empty:
        logger.info("code_index: 跳过 %d 个空文件（不送嵌入）", skipped_empty)

    if not pairs:
        return 0

    # Batch embed (sync path avoids asyncio.to_thread issues in background threads)
    # 【self-evolution-bot · 2026-11-16 · 第26轮】按批嵌入并按批落库，不再一次性喂全部。
    # 为什么：切块后全仓约 14.2 万块（实测 600/75 口径 141,994 块），
    # 一次 embed 全部 + 全部向量驻留内存 = 141994 × 512 × 4B ≈ 290 MB，
    # 且本地 encode 单次跨度过大会把 GIL 线程占满几十秒（现有 30s 看门狗会直接超时）。
    # 分批后峰值内存降到单批量级，且每批成功即落库，中途失败不会全丢。
    dim = 0
    conn = _connect(root)
    try:
        _ensure_schema(conn)
        count = 0
        failed_chunks = 0
        batch_size = _EMBED_CHUNK_BATCH
        for start in range(0, len(pairs), batch_size):
            batch = pairs[start : start + batch_size]
            try:
                embeddings = _embed_texts_sync([t for _, t in batch])
            except Exception as exc:
                logger.warning("code_index: embedding failed: %s: %s", type(exc).__name__, exc)
                embeddings = None

            # 【self-evolution-bot · 2026-11-16 · 第24轮】整批失败不能连坐。
            # 一把梭失败（超长文件、单条被接口拒）时退回二分拆批，能救多少算多少，
            # 而不是整库 0 行。
            # 【第26轮】二分拆批保住 O(log n) 次调用，别退化成逐块重试。
            if not embeddings or len(embeddings) != len(batch):
                embeddings = _embed_texts_with_bisect(batch)

            if not embeddings or len(embeddings) != len(batch):
                logger.warning(
                    "code_index: embedding count mismatch (%d vs %d), skipping batch at %d",
                    len(embeddings or []),
                    len(batch),
                    start,
                )
                failed_chunks += len(batch)
                continue

            # 【self-evolution-bot · 2026-11-16 · 第24轮】以「实际向量长度」为权威维度，
            # 不再拿配置里的静态 512 卡。首条非空向量的长度即权威维度。
            if not dim:
                dim = next((len(v) for v in embeddings if v), 0)
                if not dim:
                    logger.warning("code_index: 本轮没有任何可用向量，跳过写入")
                    return 0
                if not _ensure_vec_table_dim(conn, dim):
                    logger.warning(
                        "code_index: code_vec 维度对齐失败，本轮 %d 块向量未写入", len(pairs)
                    )
                    return 0

            for offset, ((rel, _), vec) in enumerate(zip(batch, embeddings, strict=True)):
                if not vec or len(vec) != dim:
                    failed_chunks += 1
                    continue
                conn.execute(
                    "INSERT OR REPLACE INTO code_vec (chunk_id, path, embedding) VALUES (?, ?, ?)",
                    (f"{rel}::{start + offset}", rel, _pack_vec(vec)),
                )
                count += 1
            conn.commit()
            # 【self-evolution-bot · 2026-11-17 · 第31轮】向量段逐批上报进度。
            # 为什么：这个阶段占整个建库的大头（本仓约 14 万块、20~40 分钟），
            # 而原来只在进入/退出各报一次，中间几十分钟界面上完全静止，
            # 用户没法判断是「正在跑」还是「卡死了」——这正是「哪里能看到进度」的由来。
            # 累计值写进 meta，Gateway 跨进程可读。
            _update_build_progress(
                root,
                phase="embedding",
                indexed_files=len(files),
                vectors_total=len(pairs),
                vectors_done=count,
            )

        logger.info(
            "code_index: embedded %d/%d 块 into code_vec (dim=%d, %d 个文件)",
            count,
            len(pairs),
            dim,
            len(files),
        )
        if failed_chunks:
            logger.warning("code_index: %d 块未能写入向量（维度不符或嵌入失败）", failed_chunks)
        return count
    except sqlite3.OperationalError as exc:
        logger.warning("code_index: code_vec insert failed: %s", exc)
        return 0
    finally:
        conn.close()


def _semantic_recall_sync(
    conn: sqlite3.Connection,
    query_text: str,
    top_k: int,
    cfg: CodeIndexConfig,
) -> list[dict]:
    """Embed query and recall top-k files by vector similarity.

    Returns list of ``{path, score, distance, kind: 'semantic'}``.
    Returns empty list if embedding or vec0 is unavailable.
    """
    if not cfg.semantic_search_enabled:
        return []

    # Embed query (sync path bypasses asyncio.to_thread — see _embed_query_sync)
    try:
        query_vec = _embed_query_sync(query_text)
    except Exception as exc:
        logger.warning("code_index: query embedding failed: %s: %s", type(exc).__name__, exc)
        return []

    if not query_vec:
        return []

    # 【self-evolution-bot · 2026-11-16 · 第24轮】召回侧同样以表里声明的维度为准，
    # 不再拿配置的静态 512 去比；不一致时给 warning，别再 debug 静默返回空列表。
    table_dim = _table_vec_dim(conn)
    if table_dim and len(query_vec) != table_dim:
        logger.warning(
            "code_index: 查询向量维度 %d 与 code_vec 声明维度 %d 不一致，语义召回跳过（需重建索引）",
            len(query_vec),
            table_dim,
        )
        return []

    blob = _pack_vec(query_vec)
    try:
        # 【self-evolution-bot · 2026-11-16 · 第26轮】一文件多块 → k 要放大，再按文件去重。
        # 为什么：表里每个文件有几十个块，直接取 top_k 个块可能全落在同一个文件里，
        # 文件级召回数会严重不足（原来 top_k=20 时实际可能只有 1~2 个文件）。
        # 这里取 top_k 的 _SEMANTIC_CHUNK_FANOUT 倍块数，按 path 聚合取最高分，
        # 最后截回 top_k 个文件——与改造前的「top_k 个文件」语义保持一致。
        rows = conn.execute(
            "SELECT path, chunk_id, distance FROM code_vec WHERE embedding MATCH ? AND k = ? "
            "ORDER BY distance",
            (blob, max(top_k, top_k * _SEMANTIC_CHUNK_FANOUT)),
        ).fetchall()
    except sqlite3.OperationalError:
        return []

    # 按文件聚合：同一文件多个块命中时只保留最相似的那块（距离最小）。
    best: dict[str, dict] = {}
    for r in rows:
        path = str(r["path"] or "")
        if not path:
            continue
        dist = float(r["distance"])
        prev = best.get(path)
        if prev is None or dist < prev["distance"]:
            best[path] = {
                "path": path,
                "chunk_id": str(r["chunk_id"] or ""),
                "distance": dist,
            }
    ranked = sorted(best.values(), key=lambda d: d["distance"])[:top_k]
    return [
        {
            "path": d["path"],
            "chunk_id": d["chunk_id"],
            "distance": round(d["distance"], 4),
            "score": round(1.0 - d["distance"], 4),
            "kind": "semantic",
        }
        for d in ranked
    ]


def _fts_document(rel: str, snippet: str, symbol_names: list[str] | None = None) -> str:
    aux = build_fts_aux_text(rel, snippet, symbol_names)
    return f"{rel}\n{snippet}\n{aux}" if aux else f"{rel}\n{snippet}"


def _mark_reindex_if_tokenizer_changed(conn: sqlite3.Connection) -> None:
    ver = index_tokenizer_version()
    row = conn.execute("SELECT value FROM meta WHERE key='index_tokenizer_version'").fetchone()
    if row and str(row[0]) == ver:
        return
    conn.execute(
        "INSERT OR REPLACE INTO meta(key, value) VALUES ('index_tokenizer_version', ?)",
        (ver,),
    )
    # Missing key = legacy DB built before versioning; differing value = tokenizer changed.
    # Either way the FTS corpus must be rebuilt. Fresh builds stamp the version in
    # ``_touch_index_meta`` so this path is not hit right after a successful index.
    conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES ('fts_needs_rebuild', '1')")
    conn.commit()


def _delete_path_from_index(conn: sqlite3.Connection, rel: str) -> None:
    conn.execute("DELETE FROM fts_content WHERE path = ?", (rel,))
    conn.execute("DELETE FROM symbols WHERE path = ?", (rel,))
    conn.execute("DELETE FROM file_deps WHERE from_path = ? OR to_path = ?", (rel, rel))
    conn.execute("DELETE FROM internal_refs WHERE from_path = ? OR to_path = ?", (rel, rel))
    conn.execute("DELETE FROM type_relations WHERE from_path = ? OR to_path = ?", (rel, rel))
    try:
        # 【self-evolution-bot · 2026-11-16 · 第26轮】块级表按辅助列 path 删（实测 vec0 支持）。
        # 原来按主键 path 删单条向量；改块级后同一文件有多行，必须按辅助列整体清掉，
        # 否则文件改动后旧块会残留，召回里出现已删除的行号/内容。
        conn.execute("DELETE FROM code_vec WHERE path = ?", (rel,))
    except sqlite3.OperationalError:
        pass  # vec0 table may not exist if sqlite-vec is unavailable


def _index_file_deps(conn: sqlite3.Connection, root: Path, rel: str, text: str, cfg: CodeIndexConfig) -> int:
    if not cfg.dependency_graph_enabled:
        return 0
    conn.execute("DELETE FROM file_deps WHERE from_path = ?", (rel,))
    abs_path = root / rel
    deps = extract_file_deps(abs_path, text, root)
    count = 0
    for d in deps:
        conn.execute(
            """
            INSERT OR REPLACE INTO file_deps(from_path, spec, line, to_path, dep_kind)
            VALUES (?, ?, ?, ?, ?)
            """,
            (rel, d["spec"], int(d.get("line") or 0), d.get("to_path"), d.get("dep_kind") or "import"),
        )
        count += 1
    return count


def _index_internal_refs(conn: sqlite3.Connection, root: Path, rel: str, text: str, cfg: CodeIndexConfig) -> int:
    if not cfg.internal_refs_enabled:
        return 0
    abs_path = root / rel
    from evoflow.code_index.internal_refs import extract_internal_refs, supports_internal_refs

    if not supports_internal_refs(abs_path):
        return 0

    conn.execute("DELETE FROM internal_refs WHERE from_path = ?", (rel,))
    refs = extract_internal_refs(abs_path, text, root)
    for r in refs:
        conn.execute(
            """
            INSERT OR REPLACE INTO internal_refs(from_path, to_path, line, ref_kind, symbol)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                r["from_path"],
                r["to_path"],
                int(r.get("line") or 0),
                r.get("ref_kind") or "import_use",
                str(r.get("symbol") or ""),
            ),
        )
    return len(refs)


def _index_type_relations(conn: sqlite3.Connection, root: Path, rel: str, text: str, cfg: CodeIndexConfig) -> int:
    if not cfg.type_relations_enabled:
        return 0
    abs_path = root / rel
    from evoflow.code_index.type_relations import extract_type_relations, supports_type_relations

    if not supports_type_relations(abs_path):
        return 0

    conn.execute("DELETE FROM type_relations WHERE from_path = ?", (rel,))
    try:
        from_rel = abs_path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        from_rel = rel
    rows = extract_type_relations(abs_path, text, root, conn=conn)
    from evoflow.code_index.type_relations import enrich_type_relations

    enrich_type_relations(conn, rows, from_rel=from_rel)
    for r in rows:
        conn.execute(
            """
            INSERT OR REPLACE INTO type_relations(from_path, from_type, to_path, to_type, rel_kind, line)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                r["from_path"],
                r["from_type"],
                r.get("to_path"),
                r["to_type"],
                r.get("rel_kind") or "extends",
                int(r.get("line") or 0),
            ),
        )
    return len(rows)


def _index_one_file(
    conn: sqlite3.Connection,
    root: Path,
    rel: str,
    cfg: CodeIndexConfig,
    *,
    for_full_build: bool = False,
) -> int:
    """Insert FTS + symbols for one relative path; return symbol count."""
    abs_path = root / rel
    if not abs_path.is_file() or not _should_index_file(abs_path):
        return 0
    text = abs_path.read_text(encoding="utf-8", errors="replace")
    snippet = text[: cfg.max_chars_per_file]
    _delete_path_from_index(conn, rel)
    sym_names: list[str] = []
    sym_count = 0
    for sym in extract_symbols(abs_path, text, workspace_root=str(root), for_full_build=for_full_build):
        sym_names.append(str(sym["name"]))
        conn.execute(
            "INSERT OR REPLACE INTO symbols(path, name, kind, line) VALUES (?, ?, ?, ?)",
            (rel, sym["name"], sym["kind"], sym["line"]),
        )
        sym_count += 1
    conn.execute(
        "INSERT INTO fts_content(path, content) VALUES (?, ?)",
        (rel, _fts_document(rel, snippet, sym_names)),
    )
    _index_file_deps(conn, root, rel, text, cfg)
    _index_internal_refs(conn, root, rel, text, cfg)
    _index_type_relations(conn, root, rel, text, cfg)
    return sym_count


def _touch_index_meta(conn: sqlite3.Connection, root: str, dbp: Path) -> None:
    conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES ('root', ?)", (root,))
    conn.execute(
        "INSERT OR REPLACE INTO meta(key, value) VALUES ('indexed_at', ?)",
        (str(int(time.time())),),
    )
    conn.execute(
        "INSERT OR REPLACE INTO meta(key, value) VALUES ('index_db_path', ?)",
        (str(dbp),),
    )
    conn.execute(
        "INSERT OR REPLACE INTO meta(key, value) VALUES ('index_tokenizer_version', ?)",
        (index_tokenizer_version(),),
    )
    # 【self-evolution-bot · 2026-11-16 · 第26轮】记下本次建库用的 max_files 上限。
    # 为什么必须记：状态判定要能区分「索引完整」与「被截断」。
    # 本机那张表 3001 个文件、上限正好 3000——不记上限的话，
    # 下次把上限调大也判断不出这张表是残缺的，重建永远不会触发。
    try:
        conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES ('indexed_max_files', ?)",
            (str(int(get_code_index_config().max_files)),),
        )
    except Exception:  # noqa: BLE001 - 记录失败不能挡住建库收尾
        logger.debug("code_index: write indexed_max_files failed", exc_info=True)


def index_file(
    workspace_root: str | None = None,
    *,
    relative_path: str,
    thread_id: str | None = None,
    deleted: bool = False,
) -> dict:
    """Incrementally update or remove one file from the workspace index."""
    cfg = get_code_index_config()
    if not cfg.enabled:
        return {"ok": False, "reason": "disabled"}
    if not cfg.incremental_enabled:
        return {"ok": False, "reason": "incremental_disabled"}
    root = resolve_index_root(workspace_root=workspace_root, thread_id=thread_id)
    root_path = Path(root)
    try:
        rel = _normalize_relative_path(root_path, relative_path)
    except (ValueError, FileNotFoundError) as e:
        return {"ok": False, "reason": str(e)}
    if _path_has_skipped_segment(rel):
        return {"ok": True, "action": "skipped", "path": rel, "reason": "ignored_path"}

    dbp = _db_path(root)

    def _update() -> dict:
        conn = _connect(root)
        try:
            _ensure_schema(conn)
            _mark_reindex_if_tokenizer_changed(conn)

            abs_path = root_path / rel
            if deleted or not abs_path.exists():
                _delete_path_from_index(conn, rel)
                _touch_index_meta(conn, root, dbp)
                conn.commit()
                return {"ok": True, "action": "removed", "path": rel, "root": root, "db_path": str(dbp)}

            if not _should_index_file(abs_path):
                _delete_path_from_index(conn, rel)
                _touch_index_meta(conn, root, dbp)
                conn.commit()
                return {
                    "ok": True,
                    "action": "removed",
                    "path": rel,
                    "reason": "not_indexable",
                    "root": root,
                }

            sym_count = _index_one_file(conn, root_path, rel, cfg)

            # Incremental embedding for this file
            if cfg.semantic_search_enabled:
                try:
                    inc_text = abs_path.read_text(encoding="utf-8", errors="replace")[
                        : cfg.max_chars_per_file
                    ]
                    # 【self-evolution-bot · 2026-11-16 · 第26轮】增量也要切块，与全量口径一致。
                    # 原来这里只嵌入整文件一条（且用的是 query role），改块级之后
                    # 两个路径必须同口径，否则增量更新的文件永远只有 1 个向量、
                    # 而全量建的文件有几十个——召回会系统性偏向刚改过的文件。
                    pieces = _chunk_text(inc_text)
                    if pieces:
                        vecs = _embed_texts_sync(pieces)
                        tdim = _table_vec_dim(conn)
                        if not vecs or len(vecs) != len(pieces):
                            logger.warning(
                                "code_index: 增量嵌入返回 %d 条（应为 %d），跳过 %s",
                                len(vecs or []),
                                len(pieces),
                                rel,
                            )
                        elif tdim and any(v and len(v) != tdim for v in vecs):
                            logger.warning(
                                "code_index: 增量向量维度与 code_vec 声明 %d 不一致，跳过 %s（需重建索引）",
                                tdim,
                                rel,
                            )
                        else:
                            # 先清掉该文件的旧块，再写新块——否则文件变短后尾块会残留。
                            conn.execute("DELETE FROM code_vec WHERE path = ?", (rel,))
                            for idx, vec in enumerate(vecs):
                                if not vec:
                                    continue
                                conn.execute(
                                    "INSERT OR REPLACE INTO code_vec (chunk_id, path, embedding) "
                                    "VALUES (?, ?, ?)",
                                    (f"{rel}::{idx}", rel, _pack_vec(vec)),
                                )
                except Exception as exc:
                    logger.warning("code_index: incremental embedding failed for %s: %s", rel, exc)

            _touch_index_meta(conn, root, dbp)
            conn.commit()
            return {
                "ok": True,
                "action": "updated",
                "path": rel,
                "symbols": sym_count,
                "root": root,
                "db_path": str(dbp),
            }
        finally:
            conn.close()

    return run_index_db(root, _update)


def _iter_source_files(root: Path, max_files: int) -> list[Path]:
    found: list[Path] = []
    try:
        root_resolved = root.resolve()
    except OSError:
        root_resolved = root
    for dirpath, dirnames, filenames in os.walk(root):
        kept: list[str] = []
        for d in dirnames:
            if d in _SKIP_DIRS or d.startswith("."):
                continue
            child = Path(dirpath) / d
            if _dir_escapes_workspace(child, root_resolved):
                continue
            kept.append(d)
        dirnames[:] = kept
        for name in filenames:
            p = Path(dirpath) / name
            if p.suffix.lower() not in _TEXT_SUFFIXES:
                continue
            try:
                if p.stat().st_size > 512_000:
                    continue
            except OSError:
                continue
            found.append(p)
            if len(found) >= max_files:
                return found
    return found


def _fts_doc_count(conn: sqlite3.Connection) -> int:
    """FTS5 里「有多少条文档」，优先走影子表，别每次全表数。

    【self-evolution-bot · 2026-11-17 · 第34轮】原来这里是
    ``SELECT COUNT(*) FROM fts_content``：FTS5 对虚拟表做 COUNT(*) 要走整棵
    内容表，实测 80ms（8177 条文档、库 1.0GB），而 index_status 每次检索至少调一次。
    ``fts_content_docsize`` 是 fts5 自带影子表，每篇文档一行（默认 columnsize=1），
    实测同样的库 0ms。取数语义不变，只是换了个等价且更省的位置数。
    找不到影子表（老库 columnsize=0）就退回全表 COUNT，不改变正确性。
    """
    try:
        row = conn.execute("SELECT COUNT(*) FROM fts_content_docsize").fetchone()
        if row is not None:
            return int(row[0] or 0)
    except sqlite3.Error:
        pass
    try:
        return int(conn.execute("SELECT COUNT(*) FROM fts_content").fetchone()[0])
    except sqlite3.Error:
        return 0


def _read_index_status_unlocked(root: str, dbp: Path, *, building: bool) -> dict:
    """Lock-free read of index readiness (WAL allows concurrent reads during rebuild)."""
    try:
        conn = _connect(root)
        try:
            _ensure_schema(conn)
            row = conn.execute("SELECT value FROM meta WHERE key='root'").fetchone()
            n = _fts_doc_count(conn)
            sym_n = int(conn.execute("SELECT COUNT(*) FROM symbols").fetchone()[0])
            # 【self-evolution-bot · 2026-11-16 · 第26轮】两处修正：
            # (1) vector_available 原来是 conn.close() 之后才算的——use-after-close，
            #     异常被 except 吞掉后 _SQLITE_VEC_AVAILABLE 会被永久缓存成 False，
            #     于是整个进程生命周期都不再报告向量健康度。必须在关连接前算。
            # (2) ready 原来只判「根路径对 + 有文件」，不看索引是否残缺：
            #     本机那张表 3001 个文件（上限 3000 截断）也被判 ready，
            #     于是 schedule_build_index 直接 index_ready 跳过重建，
            #     9000 个文件里 6000 个永远进不了库——这是「搜不到东西」的第一原因。
            vec_ok = _sqlite_vec_available(conn)
            stale_reasons: list[str] = []
            cfg = get_code_index_config()
            built_max = conn.execute(
                "SELECT value FROM meta WHERE key='indexed_max_files'"
            ).fetchone()
            built_max_n = int(built_max[0]) if built_max and str(built_max[0]).isdigit() else 0
            if built_max_n and int(cfg.max_files) > built_max_n:
                stale_reasons.append(
                    f"max_files_upgraded:{built_max_n}->{int(cfg.max_files)}"
                )
            elif not built_max_n and n > 0 and n >= 3000:
                # 旧库没记录上限、且文件数顶到旧默认值 → 几乎必然是截断产物
                stale_reasons.append("max_files_unrecorded_at_old_cap")
            if cfg.semantic_search_enabled and vec_ok:
                vec_n = 0
                try:
                    vec_n = int(conn.execute("SELECT COUNT(*) FROM code_vec").fetchone()[0])
                except sqlite3.OperationalError:
                    vec_n = 0
                if n > 0 and vec_n == 0:
                    stale_reasons.append("vectors_missing")
                elif n > 0 and vec_n < n:
                    # 块级表应当「文件数 <= 块数」；块数少于文件数说明只写了一部分
                    stale_reasons.append(f"vectors_incomplete:{vec_n}<{n}")
        finally:
            conn.close()
        updated_at = None
        try:
            updated_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(dbp.stat().st_mtime))
        except OSError:
            pass
        ready = bool(row and str(row[0]) == root and n > 0 and not stale_reasons)
        return {
            "ok": True,
            "ready": ready,
            "building": building,
            "root": root,
            "db_path": str(dbp),
            "files": n,
            "symbols": sym_n,
            "updated_at": updated_at,
            # 【self-evolution-bot · 2026-11-16 · 第23轮】P2 向量健康度（判定单 §四）
            "vector_available": vec_ok,
            # 【self-evolution-bot · 2026-11-16 · 第26轮】索引为何「不完整」，
            # 空列表 = 完整。外部（面板/重建入口）据此决定要不要自动重建，
            # 而不是靠人记得手动点。
            "stale_reasons": stale_reasons,
            # 【self-evolution-bot · 2026-11-17 · 第31轮】子进程构建时，进度只能从库里读。
            # 由 _merge_build_progress 消费后从对外字段里剔除，不外泄这个内部键。
            "_persisted_progress": _read_persisted_build_progress(conn),
        }
    except Exception:
        return {
            "ok": True,
            "ready": False,
            "building": building,
            "root": root,
            "db_path": str(dbp),
            "files": 0,
            "symbols": 0,
            "updated_at": None,
            "stale_reasons": ["status_read_failed"],
        }


def index_status(
    workspace_root: str | None = None,
    *,
    thread_id: str | None = None,
) -> dict:
    """Fast check whether a usable index exists for this workspace root (shared across sessions)."""
    cfg = get_code_index_config()
    if not cfg.enabled:
        return {"ok": False, "reason": "disabled", "ready": False}
    root = resolve_index_root(workspace_root=workspace_root, thread_id=thread_id)
    dbp = _db_path(root)
    key = _workspace_hash(root)
    with _jobs_lock:
        building = key in _build_jobs and _build_jobs[key].is_alive()
    if not dbp.exists():
        return _merge_build_progress(
            {
                "ok": True,
                "ready": False,
                "building": building,
                "root": root,
                "db_path": str(dbp),
                "files": 0,
                "symbols": 0,
            },
            root,
        )
    return _merge_build_progress(_read_index_status_unlocked(root, dbp, building=building), root)


class _BuildJob(Protocol):
    def is_alive(self) -> bool: ...


class _ThreadBuildJob:
    __slots__ = ("_thread",)

    def __init__(self, thread: threading.Thread) -> None:
        self._thread = thread

    def is_alive(self) -> bool:
        return self._thread.is_alive()


class _SubprocessBuildJob:
    """Track a child-process build without holding ML imports in Gateway."""

    __slots__ = ("_proc",)

    def __init__(self, proc: subprocess.Popen[Any]) -> None:
        self._proc = proc

    def is_alive(self) -> bool:
        return self._proc.poll() is None


_build_jobs: dict[str, _BuildJob] = {}


def _code_index_build_inprocess() -> bool:
    """Tests monkeypatch ``build_index`` in-process; production must use a subprocess."""
    return (os.environ.get("EVOFLOW_CODE_INDEX_BUILD_INPROCESS") or "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def _spawn_build_subprocess(
    *,
    workspace_root: str | None,
    thread_id: str | None,
    force: bool,
    job_key: str,
) -> _SubprocessBuildJob:
    from evoflow.utils.subprocess_platform import subprocess_hide_window_kwargs

    cmd = [sys.executable, "-m", "evoflow.code_index.build_worker"]
    if workspace_root:
        cmd.extend(["--workspace-root", str(workspace_root)])
    if thread_id:
        cmd.extend(["--thread-id", str(thread_id)])
    if force:
        cmd.append("--force")
    # Inherit env so the child sees the same profile / DB roots as Gateway.
    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        **subprocess_hide_window_kwargs(),
    )
    job = _SubprocessBuildJob(proc)

    def _reap() -> None:
        try:
            proc.wait()
        except Exception:
            logger.debug("code_index: reap wait failed key=%s", job_key, exc_info=True)
        finally:
            with _jobs_lock:
                cur = _build_jobs.get(job_key)
                if cur is job:
                    _build_jobs.pop(job_key, None)

    threading.Thread(
        target=_reap,
        name=f"code-index-reap-{job_key[:8]}",
        daemon=True,
    ).start()
    logger.info(
        "code_index: scheduled subprocess build pid=%s key=%s force=%s",
        proc.pid,
        job_key[:8],
        force,
    )
    return job


# 【self-evolution-bot · 2026-11-17 · 第31轮】进度跨进程可见性。
# 生产默认 `build_worker` 子进程建库，`_build_progress` 是进程内 dict，
# 所以 Gateway 读 /index-status 时 build_phase / build_progress_pct 永远为空，
# 界面上看不到「跑到哪了」。改为同时写进 index.db 的 meta 表（build_progress.* 前缀），
# 子进程构建时 Gateway 也能读到，进程被打断也留痕。
_PROGRESS_META_PREFIX = "build_progress."

_build_progress: dict[str, dict] = {}
_jobs_lock = threading.Lock()


def _update_build_progress(root: str, **fields: object) -> None:
    key = _workspace_hash(root)
    with _jobs_lock:
        cur = dict(_build_progress.get(key) or {})
        cur.update(fields)
        _build_progress[key] = cur
    # 【self-evolution-bot · 2026-11-17 · 第31轮】同时落进 index.db 的 meta 表。
    # 为什么：生产默认把构建丢进**子进程**（`build_worker`），而 `_build_progress` 是
    # 进程内 dict —— 于是 Gateway 读 /index-status 拿到 `build_phase=None`、
    # `build_progress_pct=None`，界面上只有「已索引 N 文件」这种事后数字。
    # 向量段是全流程最慢的一段（本仓约 14 万块、20~40 分钟），这段时间界面完全静止，
    # 看起来就像卡死。写进库后 Gateway 能跨进程读，进程被打断也留痕可查。
    _persist_build_progress(root, {k: v for k, v in fields.items() if v is not None})


def _get_build_progress(root: str) -> dict:
    key = _workspace_hash(root)
    with _jobs_lock:
        return dict(_build_progress.get(key) or {})


def _persist_build_progress(root: str, fields: dict) -> None:
    """把构建进度写进 index.db 的 meta 表（失败静默，进度不在关键路径上）。"""
    if not fields:
        return
    try:
        conn = _connect(root)
    except Exception:  # noqa: BLE001
        return
    try:
        for k, v in fields.items():
            conn.execute(
                "INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)",
                (_PROGRESS_META_PREFIX + str(k), str(v)),
            )
        conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)",
            (_PROGRESS_META_PREFIX + "updated_at", str(int(time.time()))),
        )
        conn.commit()
    except Exception:  # noqa: BLE001 - 进度落盘失败绝不能打断建库
        logger.debug("code_index: persist build progress failed", exc_info=True)
    finally:
        try:
            conn.close()
        except Exception:  # noqa: BLE001
            pass


def _clear_build_progress(root: str) -> None:
    key = _workspace_hash(root)
    with _jobs_lock:
        _build_progress.pop(key, None)
    _clear_persisted_build_progress(root)


def _read_persisted_build_progress(conn: sqlite3.Connection) -> dict:
    """从已打开的 index.db 连接读回 build_progress.* 进度（跨进程可见）。

    【self-evolution-bot · 2026-11-17 · 第31轮】补上这个被我漏定义的读侧。
    为什么必须补：`_update_build_progress` 每轮都往 meta 表写 `build_progress.*`，
    `_merge_build_progress` 也早就调用了本函数 —— 但函数体从来没被写出来过。
    调用点抛 NameError，被 `_read_index_status_unlocked` 外层的
    `except Exception` 吞掉，于是整个函数退化到兜底分支：
    `files=0 / symbols=0 / stale_reasons=["status_read_failed"]`。
    实测代价：/index-status 对着一库 9044 文件报 `files=0`，
    而 `ready` 因此恒为 False —— 面板永远认为索引没建好，反复触发重建。
    """
    raw: dict[str, str] = {}
    try:
        rows = conn.execute(
            "SELECT key, value FROM meta WHERE key LIKE ?", (_PROGRESS_META_PREFIX + "%",)
        ).fetchall()
    except sqlite3.Error:
        return {}
    for row in rows:
        try:
            k, v = str(row[0]), str(row[1])
        except (IndexError, TypeError):
            continue
        raw[k[len(_PROGRESS_META_PREFIX) :]] = v
    if not raw:
        return {}
    out: dict[str, object] = {}
    for k, v in raw.items():
        if k == "phase":
            out[k] = v
            continue
        # 数值字段按整数回读；读不出就跳过这个键，而不是塞个 0 假数进去。
        try:
            out[k] = int(float(v))
        except (TypeError, ValueError):
            continue
    return out


def _clear_persisted_build_progress(root: str) -> None:
    try:
        conn = _connect(root)
    except Exception:  # noqa: BLE001
        return
    try:
        conn.execute("DELETE FROM meta WHERE key LIKE ?", (_PROGRESS_META_PREFIX + "%",))
        conn.commit()
    except Exception:  # noqa: BLE001
        logger.debug("code_index: clear persisted progress failed", exc_info=True)
    finally:
        try:
            conn.close()
        except Exception:  # noqa: BLE001
            pass


def _merge_build_progress(status: dict, root: str) -> dict:
    prog = _get_build_progress(root)
    if not prog and not status.get("building"):
        # 【self-evolution-bot · 2026-11-17 · 第31轮】进程内没有进度时回退读库里的。
        # 子进程构建的情况下 `_build_progress` 永远是空的，只有落库那份能反映真实进度。
        prog = dict(status.get("_persisted_progress") or {})
    if not prog and not status.get("building"):
        return status
    out = dict(status)
    out.pop("_persisted_progress", None)
    total = int(prog.get("total_files") or status.get("build_total_files") or 0)
    done = int(prog.get("indexed_files") or status.get("build_indexed_files") or 0)
    # 向量段用块数计进度：vectors_done / vectors_total 比「文件数」更能反映真实推进，
    # 这个阶段文件数早已跑满 100%，只看文件数会以为卡住不动。
    v_total = int(prog.get("vectors_total") or 0)
    v_done = int(prog.get("vectors_done") or 0)
    phase = prog.get("phase") or status.get("build_phase")
    if phase in {"embedding", "embedding_done"} and v_total > 0:
        done, total = v_done, v_total
    pct = round(100.0 * done / total, 1) if total > 0 else None
    if prog or status.get("building"):
        out.update(
            {
                "build_total_files": total or None,
                "build_indexed_files": done or None,
                "build_progress_pct": pct,
                "build_phase": phase,
            }
        )
        if prog.get("symbols") is not None:
            out["symbols"] = int(prog.get("symbols") or 0)
    return out


def schedule_build_index(
    workspace_root: str | None = None,
    *,
    thread_id: str | None = None,
    force: bool = False,
) -> dict:
    """Enqueue a full index build (one job per workspace root).

    Production default: **subprocess** so embedding-model imports cannot
    stall the Gateway event loop (GIL / import lock are process-wide —
    a background thread does not protect HTTP).
    """
    cfg = get_code_index_config()
    if not cfg.enabled:
        return {"ok": False, "reason": "disabled"}
    root = resolve_index_root(workspace_root=workspace_root, thread_id=thread_id)
    dbp = _db_path(root)
    if not force:
        st = index_status(workspace_root=workspace_root, thread_id=thread_id)
        # 【self-evolution-bot · 2026-11-16 · 第26轮】索引残缺要自动重建，不能算「已就绪」。
        # 原来的判据是 st["ready"] —— 而 ready 只看「根路径对 + 有文件」，
        # 于是被 max_files 截断的索引、以及向量 0 行的索引全部被判为就绪，
        # 之后每次调用都返回 index_ready 直接跳过，没人会去重建它们。
        # 实测后果：本机 9000 个文件只有 3001 个在库里、code_vec 只有 3 行，
        # 而系统一直认为「索引是好的」——用户问「为什么搜不到」的根就在这里。
        if st.get("ready"):
            return {
                "ok": True,
                "skipped": True,
                "reason": "index_ready",
                "status": "ready",
                "root": root,
                "db_path": str(dbp),
                "files": st.get("files"),
            }
        stale = list(st.get("stale_reasons") or [])
        if stale and st.get("files"):
            # 库里有数据但被判残缺 → 无需人工介入，直接升级为强制重建。
            # 【self-evolution-bot · 2026-11-17 · 第31轮】注意「只缺向量」这种残缺
            # 不能在 build_index 里从头清表重来（会把 9044 个文件的 FTS/符号全删掉），
            # 那条分流在 build_index 内部按同一批 stale_reasons 判定，
            # 这样 subprocess / in-process 两条启动路径都能自动生效，不靠传参。
            force = True
            logger.warning(
                "code_index: 索引残缺（%s），自动触发重建（root=%s, 现有 %s 文件）",
                ", ".join(stale),
                root,
                st.get("files"),
            )
    key = _workspace_hash(root)
    with _jobs_lock:
        existing = _build_jobs.get(key)
        if existing is not None and existing.is_alive():
            return {
                "ok": True,
                "status": "building",
                "root": root,
                "db_path": str(dbp),
            }

        if not _code_index_build_inprocess():
            try:
                job = _spawn_build_subprocess(
                    workspace_root=workspace_root,
                    thread_id=thread_id,
                    force=force,
                    job_key=key,
                )
                _build_jobs[key] = job
                return {
                    "ok": True,
                    "status": "scheduled",
                    "mode": "subprocess",
                    "root": root,
                    "db_path": str(dbp),
                }
            except Exception:
                logger.exception(
                    "code_index: subprocess schedule failed for %s; falling back to in-process thread",
                    root,
                )

        def _run() -> None:
            try:
                build_index(workspace_root=workspace_root, thread_id=thread_id, force=force)
            except Exception:
                logger.exception("background code_index build failed for %s", root)
            finally:
                with _jobs_lock:
                    _build_jobs.pop(key, None)

        t = threading.Thread(target=_run, name=f"code-index-build-{key[:8]}", daemon=True)
        _build_jobs[key] = _ThreadBuildJob(t)
        t.start()
    return {
        "ok": True,
        "status": "scheduled",
        "mode": "inprocess",
        "root": root,
        "db_path": str(dbp),
    }


def build_index(
    workspace_root: str | None = None,
    *,
    thread_id: str | None = None,
    force: bool = False,
) -> dict:
    """Index text files under a workspace (local path or LangGraph thread sandbox)."""
    cfg = get_code_index_config()
    if not cfg.enabled:
        return {"ok": False, "reason": "disabled"}
    root = resolve_index_root(workspace_root=workspace_root, thread_id=thread_id)
    dbp = _db_path(root)
    if not force:
        st = index_status(workspace_root=workspace_root, thread_id=thread_id)
        if st.get("ready"):
            return {
                "ok": True,
                "skipped": True,
                "reason": "index_ready",
                "root": root,
                "db_path": str(dbp),
                "files": st.get("files"),
            }
        if dbp.exists():
            try:
                mtime = dbp.stat().st_mtime
                if st.get("ready") and time.time() - mtime < cfg.reindex_min_interval_seconds:
                    return {
                        "ok": True,
                        "skipped": True,
                        "reason": "recent_index",
                        "root": root,
                        "db_path": str(dbp),
                    }
            except OSError:
                pass

    from evoflow.code_index.lsp_pool import reset_build_budget

    reset_build_budget(root)

    root_path = Path(root)
    source_files = _iter_source_files(root_path, cfg.max_files)
    total_files = len(source_files)

    # 【self-evolution-bot · 2026-11-17 · 第31轮】「只缺向量」时跳过清表与文件段。
    # 为什么：全量重建第一步 _clear_tables() 会把已建好的 FTS/符号/deps 全删掉，
    # 而向量段（本仓约 14.2 万块、本地 bge 约 16ms/块 ≈ 38 分钟）是最容易被重启或超时
    # 打断的一段。实测踩到：09:07 文件段 9044/9044 完成、进 embedding；
    # 09:29 重启打断 → 库里「文件全在、code_vec 只有 7 行」；
    # 而 ready=False 会驱动下一次调用再做一遍完整 9044 文件重建，
    # 等于每被打断一次就白烧一遍全仓解析。
    # 判据只看 stale_reasons 是否**全部**属于向量类，文件类残缺仍走全量重建。
    vectors_only = False
    try:
        _st = _read_index_status_unlocked(root, dbp, building=False) if dbp.exists() else {}
    except Exception:
        _st = {}
    _stale = list(_st.get("stale_reasons") or [])
    if _stale and _st.get("files") and all(
        s.startswith("vectors_missing") or s.startswith("vectors_incomplete") for s in _stale
    ):
        vectors_only = True
        logger.warning(
            "code_index: 仅向量段残缺（%s），跳过清表与文件段，只补向量（root=%s, %s 文件）",
            ", ".join(_stale),
            root,
            _st.get("files"),
        )

    _update_build_progress(
        root,
        phase="embedding" if vectors_only else "indexing",
        total_files=total_files,
        indexed_files=0,
        symbols=0,
    )
    parser_stats: dict[str, int] = defaultdict(int)
    dep_count = 0
    ref_count = 0
    type_rel_count = 0
    indexed = 0
    sym_count = 0
    skipped_files = 0

    try:

        if vectors_only:
            # 只补向量：保留既有 fts/symbols/deps，不清表也不跑文件段。
            indexed = int(_st.get("files") or 0)
            sym_count = int(_st.get("symbols") or 0)
            logger.info(
                "code_index: vectors-only 重建，沿用已建好的 %d 个文件索引（跳过解析）",
                indexed,
            )

        def _clear_tables() -> None:
            conn = _connect(root)
            try:
                _ensure_schema(conn)
                _mark_reindex_if_tokenizer_changed(conn)
                conn.execute("DELETE FROM fts_content")
                conn.execute("DELETE FROM symbols")
                conn.execute("DELETE FROM file_deps")
                conn.execute("DELETE FROM internal_refs")
                conn.execute("DELETE FROM type_relations")
                try:
                    conn.execute("DELETE FROM code_vec")
                except sqlite3.OperationalError:
                    pass  # vec0 may not exist
                conn.execute("DELETE FROM meta")
                conn.commit()
            finally:
                conn.close()

        if not vectors_only:
            run_index_db(root, _clear_tables)

            for batch_start in range(0, len(source_files), _BUILD_BATCH_SIZE):
                batch = source_files[batch_start : batch_start + _BUILD_BATCH_SIZE]

                def _index_batch(files: list[Path] = batch) -> None:
                    nonlocal indexed, sym_count, dep_count, ref_count, type_rel_count, skipped_files
                    conn = _connect(root)
                    try:
                        _ensure_schema(conn)
                        for fp in files:
                            try:
                                rel = fp.relative_to(root_path).as_posix()
                                text = fp.read_text(encoding="utf-8", errors="replace")
                            except OSError:
                                continue
                            # 【self-evolution-bot · 2026-11-17 · 第31轮】单文件失败必须隔离。
                            # 为什么：原来只有 read 被 try 包住，extract_symbols 等环节抛任何异常
                            # 都会冒到 _run 的 except → **整个 build_index 中途退出**，留下半截库。
                            # 实证：2026-11-17 07:32:25 Gateway 日志
                            #   ERROR background code_index build failed / RecursionError
                            #   （tree_sitter_core._walk_symbols 递归 987 层爆栈）
                            # 结果库里 6454/9033 个文件、code_vec 只 14 行，且三轮重建死在同一处。
                            # 递归已改迭代（根因），这里再兜一层：坏文件只丢它自己，不毁整库。
                            try:
                                snippet = text[: cfg.max_chars_per_file]
                                sym_names: list[str] = []
                                for sym in extract_symbols(fp, text, workspace_root=root, for_full_build=True):
                                    sym_names.append(str(sym["name"]))
                                    conn.execute(
                                        "INSERT OR REPLACE INTO symbols(path, name, kind, line) VALUES (?, ?, ?, ?)",
                                        (rel, sym["name"], sym["kind"], sym["line"]),
                                    )
                                    sym_count += 1
                                    parser_stats[str(sym.get("parser") or "unknown")] += 1
                                conn.execute(
                                    "INSERT INTO fts_content(path, content) VALUES (?, ?)",
                                    (rel, _fts_document(rel, snippet, sym_names)),
                                )
                                dep_count += _index_file_deps(conn, root_path, rel, text, cfg)
                                ref_count += _index_internal_refs(conn, root_path, rel, text, cfg)
                                type_rel_count += _index_type_relations(conn, root_path, rel, text, cfg)
                                indexed += 1
                            except Exception:
                                skipped_files += 1
                                logger.warning(
                                    "code_index: 单文件索引失败已跳过 path=%s（不中断整库构建）",
                                    rel,
                                    exc_info=True,
                                )
                                continue
                        conn.commit()
                    finally:
                        conn.close()

                run_index_db(root, _index_batch)
                _update_build_progress(
                    root,
                    phase="indexing",
                    total_files=total_files,
                    indexed_files=indexed,
                    symbols=sym_count,
                )
                time.sleep(0)

        # --- Semantic embedding pass ---
        # 【self-evolution-bot · 2026-11-16 · 第26轮】向量阶段单独上报进度。
        # 为什么：切块后这个阶段是全量重建里最耗时的一段（14.2 万块、约 38 分钟），
        # 而原来只上报 indexing 阶段，于是「文件都索引完了」后进度条停在 100%
        # 却还要再等半小时——用户会以为卡死了，只能干等，没有任何可见性。
        _update_build_progress(
            root,
            phase="embedding",
            total_files=total_files,
            indexed_files=indexed,
            symbols=sym_count,
            vectors_total=int(getattr(cfg, "max_files", 0) or 0) or None,
            vectors_done=0,
        )
        vec_count = _index_embeddings_sync(root, root_path, source_files, cfg)
        _update_build_progress(
            root,
            phase="embedding_done",
            total_files=total_files,
            indexed_files=indexed,
            symbols=sym_count,
            vectors_done=int(vec_count or 0),
        )

        def _finalize_meta() -> None:
            conn = _connect(root)
            try:
                _ensure_schema(conn)
                _touch_index_meta(conn, root, dbp)
                conn.execute(
                    "INSERT OR REPLACE INTO meta(key, value) VALUES ('symbol_parsers', ?)",
                    (json.dumps(dict(parser_stats)),),
                )
                conn.execute(
                    "INSERT OR REPLACE INTO meta(key, value) VALUES ('fts_schema_version', ?)",
                    (_FTS_SCHEMA_VERSION,),
                )
                conn.execute("DELETE FROM meta WHERE key='fts_needs_rebuild'")
                conn.commit()
            finally:
                conn.close()

        run_index_db(root, _finalize_meta)
    finally:
        _clear_build_progress(root)

    logger.info(
        "code_index: indexed %d files (%d symbols, %d deps, %d refs, %d type_rels, %d vecs, %d skipped) under %s -> %s parsers=%s",
        indexed,
        sym_count,
        dep_count,
        ref_count,
        type_rel_count,
        vec_count,
        skipped_files,
        root,
        dbp,
        dict(parser_stats),
    )
    return {
        "ok": True,
        "files": indexed,
        "skipped_files": skipped_files,
        "symbols": sym_count,
        "dependencies": dep_count,
        "internal_refs": ref_count,
        "type_relations": type_rel_count,
        "vectors": vec_count,
        "root": root,
        "db_path": str(dbp),
        "symbol_parsers": dict(parser_stats),
    }


# English fluff models often append to code-search queries (stripped for symbol/FTS terms).
_SEARCH_STOPWORDS = frozenset(
    {
        "a",
        "an",
        "the",
        "and",
        "or",
        "for",
        "to",
        "in",
        "on",
        "of",
        "is",
        "are",
        "usage",
        "use",
        "using",
        "used",
        "channel",
        "how",
        "what",
        "where",
        "when",
        "help",
        "about",
        "find",
        "search",
        "explain",
        "show",
        "code",
        "file",
        "files",
        "function",
        "class",
        "method",
        "module",
        "implementation",
    }
)


def merge_search_queries(query: str = "", *, queries: list[str] | None = None) -> tuple[str, list[str]]:
    """Merge primary ``query`` and optional synonyms (supports ``a|b|c`` pipe syntax)."""
    from evoflow.tools.arg_coerce import normalize_search_query_inputs

    primary, rest = normalize_search_query_inputs(query, queries)
    if not primary and not rest:
        return "", []
    explicit = [primary, *rest][:12]
    label = " | ".join(explicit)
    return label, explicit


def _expand_search_terms(
    query: str,
    *,
    explicit_terms: list[str] | None = None,
    synonym_mode: bool = False,
) -> list[str]:
    """Split natural-language queries into symbol/FTS terms (CamelCase, snake_case, CJK)."""
    q = str(query or "").strip()
    terms: list[str] = []
    seen: set[str] = set()

    def add(raw: str, *, force: bool = False) -> None:
        t = raw.strip().strip("\"'")
        if not t or len(t) < 2:
            return
        key = t.casefold()
        if key in seen:
            return
        if not force and key in _SEARCH_STOPWORDS:
            return
        seen.add(key)
        terms.append(t)

    for tok in tokens_from_text(q, max_tokens=40):
        add(tok, force=synonym_mode or _looks_like_identifier_token(tok))

    for raw in explicit_terms or []:
        add(raw, force=True)
        for tok in tokens_from_text(raw, max_tokens=20):
            add(tok, force=True)

    for t in list(terms):
        for variant in _hyphen_variants(t):
            add(variant, force=True)

    if not terms and q:
        terms = [q]
    return terms[:20]


def _fts5_quote_term(term: str) -> str:
    return '"' + term.replace('"', '""') + '"'


def _build_fts_match_query(terms: list[str], *, original: str, combine_mode: str = "or") -> str:
    if not terms:
        return original
    if len(terms) == 1:
        return _fts5_quote_term(terms[0])
    joiner = " AND " if str(combine_mode or "").strip().lower() == "and" else " OR "
    return joiner.join(_fts5_quote_term(t) for t in terms)


def _nl_fts_terms(terms: list[str], *, primary: str = "") -> list[str]:
    """Drop generic NL noise; keep identifiers for AND-style content search."""
    primary_s = str(primary or "").strip()
    primary_cf = primary_s.casefold()
    kept: list[str] = []
    for t in terms:
        if primary_cf and t.casefold() == primary_cf:
            kept.append(t)
            continue
        if _looks_like_identifier_token(t):
            kept.append(t)
            continue
        if t.casefold() in _SEARCH_STOPWORDS:
            continue
        if len(t) >= 5:
            kept.append(t)
    if kept:
        return kept
    if primary_s:
        return [primary_s]
    return terms[:3]


def _search_symbols(
    conn: sqlite3.Connection,
    terms: list[str],
    lim: int,
    *,
    whole_query: str = "",
) -> list[dict]:
    """Symbol lookup: whole-query → exact → prefix → substring (substring only for terms ≥5 chars)."""
    symbols: list[dict] = []
    sym_keys: set[tuple[str, str, int]] = set()

    def _push(row: sqlite3.Row, *, match_rank: int) -> bool:
        key = (str(row["path"]), str(row["name"]), int(row["line"] or 0))
        if key in sym_keys:
            return len(symbols) >= lim
        sym_keys.add(key)
        symbols.append(
            {
                "path": key[0],
                "name": key[1],
                "kind": row["kind"],
                "line": key[2],
                "match_rank": match_rank,
            }
        )
        return len(symbols) >= lim

    # 【self-evolution-bot · 2026-11-17 · 第32轮】分隔符不敏感的整串符号匹配，必须走在最前。
    # 实测问题：查 "read persisted build progress"，库里明明有
    # `_read_persisted_build_progress`（去掉分隔符后与查询完全相同），
    # 但原实现只做「原样精确 / 前缀 / 子串」，一个都命不中；
    # 而 per-term 循环先轮到 'read' 这个泛名（库里有 20 个叫 read 的符号），
    # 名额被占满，整句根本没机会匹配。
    # 实测（冻结池 60 条拆词查询、K=10、关语义召回）：
    #   HEAD 原版 hit@1=4/60，只加本处整串匹配 29/60，再叠加输出层分档 44/60。
    # 关键顺序：按去分隔符长度降序试，长串（整句）优先，短泛词最后。
    # 只认**整串**：把整个查询的每个词拼起来再比对。
    # 若允许每个词单独参与（我第一版就是这么写的），progress / build / persisted
    # 这些泛词也会拿 match_rank=4，等于把「叫 Progress 的组件」提成最高档，
    # 反而压掉真正的 _read_persisted_build_progress —— 实测就是这么错的。
    # 只在「查询里存在一个够长的整体词项」时才启用：_expand_search_terms 会把
    # 整句原样保留为一个 term（见实测 terms 末尾的 'read persisted build progress'），
    # 拿它去做去分隔符比对；短泛词不参与。
    # 【self-evolution-bot · 2026-11-17 · 第34轮】整句比对必须排在所有拆词之前。
    # 实测（冻结池 60 条、K=10、关语义）：16 条 miss@1 里 14 条是同一个机制——
    # 查询被拆成单词后，短泛词（resolve / build / preview / status）先拿到 match_rank=4
    # 把名额占满，而「整句拼起来」这个候选**从没参与过比对**：
    #   resolve data paths → 库里真有 resolve_data_paths，答的是 resolve()
    #   build diff summary → 库里真有 buildDiffSummary，答的是 build()
    #   plugins uninstall  → 库里真有 plugins_uninstall，答的是 uninstall()
    # 判据：整句每个词拼起来去分隔符，与符号名去分隔符后**全等**才算整句命中。
    # 给 match_rank=5 而不是 4：整串全等必然强于「某个单词恰巧等于符号名」，必须压过它。
    _whole_norm = _strip_seps(whole_query) if whole_query else ""
    if len(_whole_norm) >= 6:
        # 【self-evolution-bot · 2026-11-17 · 第36轮】整句匹配必须容忍单复数差异。
        # 实测（工具出口评测，60 条查询）：`plugin uninstall` 查不到
        # `plugins_uninstall` —— 去分隔符后是 'pluginuninstall' vs 'pluginsuninstall'，
        # 差一个 s 就不全等，于是整句档（rank=5）完全没参与比对，答案排到 10 名外，
        # 首条给的是短泛名 `uninstall`。而 `resolve data paths` / `build diff summary`
        # 能进是因为它们恰好逐字相同 —— 这不是能力差异，只是一个字符的运气。
        # 做法：把「词尾单复数」在归一化阶段抹平（plugin↔plugins、index↔indexes）。
        # 只做尾部，不做词干提取：词干会把 progress/progresses 之外的东西也吃掉，
        # 引入不可控的误匹配。
        # 【self-evolution-bot · 2026-11-17 · 第36轮】SQL 只做粗筛：候选名必须
        # 「词元数相同」且首词元前 6 个字符相同（走 name 索引前缀，避免全表 Python 扫）。
        # 精确判定交给 _whole_name_matches（逐词元比对 + 单复数归一）。
        # 粗筛用「子串」而不是「前缀」：前缀会漏掉带前导下划线的 `_build_overlay`，
        # 也会漏掉大写缩写连写的 `ZCodeBackgroundTaskControlItem`（实测这两类共退化 4 条）。
        # 5.2 万行子串扫描在 SQLite 上是几十毫秒量级，相比整体 p50 ~600ms 可忽略。
        _q_tokens = _name_tokens(whole_query)
        _head = (_q_tokens[0][:6] if _q_tokens else "") or _whole_norm[:6]
        _cand_sql = (
            "SELECT path, name, kind, line FROM symbols"
            " WHERE name LIKE ?"
            " ORDER BY CASE WHEN kind IN"
            " ('function','class','method','constructor','interface','type','struct')"
            " THEN 0 ELSE 1 END"
            " LIMIT ?"
        )
        # 【self-evolution-bot · 2026-11-17 · 第36轮】同一档（rank=5）内还要再排一次：
        # 去分隔符**全等**的必须排在「靠单复数容错才相等」的前面。
        # 实测教训：查 `build overlay` 时 `_buildOverlays`（复数容错命中）排在
        # `_build_overlay`（逐字全等）前面，用户看到的首条是错的那个 ——
        # 复数容错本是为了补召回，不该抢走逐字命中的首位。
        _exact: list = []
        _fuzzy: list = []
        for row in conn.execute(_cand_sql, ("%" + _head + "%", lim * 40)).fetchall():
            name = str(row["name"] or "")
            if _strip_seps(whole_query) == _strip_seps(name):
                _exact.append(row)
            elif _whole_name_matches(whole_query, name):
                _fuzzy.append(row)
        for row in _exact + _fuzzy:
            if _push(row, match_rank=5):
                break

    _long_terms = [t for t in terms if len(_strip_seps(t)) >= 6]
    _norm_terms = sorted({_strip_seps(t) for t in _long_terms}, key=len, reverse=True)[:2]
    for _nt in _norm_terms:
        if len(symbols) >= lim:
            break
        for row in conn.execute(
            "SELECT path, name, kind, line FROM symbols"
            " WHERE replace(replace(lower(name),'_',''),'-','') = ?"
            " LIMIT ?",
            (_nt, lim),
        ).fetchall():
            if _push(row, match_rank=4):
                break

    for term in terms:
        if len(symbols) >= lim:
            break
        t = str(term or "").strip()
        if len(t) < 2:
            continue
        for row in conn.execute(
            "SELECT path, name, kind, line FROM symbols WHERE name = ? COLLATE NOCASE LIMIT ?",
            (t, lim),
        ).fetchall():
            if _push(row, match_rank=3):
                break
        if len(symbols) >= lim:
            break
        esc = t.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        for row in conn.execute(
            "SELECT path, name, kind, line FROM symbols WHERE name LIKE ? ESCAPE '\\' LIMIT ?",
            (esc + "%", lim),
        ).fetchall():
            if _push(row, match_rank=2):
                break
        if len(symbols) >= lim:
            break
        if len(t) < 5:
            continue
        like = f"%{esc}%"
        for row in conn.execute(
            "SELECT path, name, kind, line FROM symbols WHERE name LIKE ? ESCAPE '\\' LIMIT ?",
            (like, lim),
        ).fetchall():
            if _push(row, match_rank=1):
                break
    return symbols[:lim]


def _fts_needs_rebuild(conn: sqlite3.Connection) -> bool:
    row = conn.execute("SELECT value FROM meta WHERE key='fts_needs_rebuild'").fetchone()
    return bool(row and str(row[0]).strip() in {"1", "true", "yes"})


def _wait_index_ready(
    workspace_root: str | None,
    *,
    thread_id: str | None,
    cfg: CodeIndexConfig,
    initial: dict | None = None,
) -> dict:
    """Poll until index is ready or timeout (only while a build job is active).

    【self-evolution-bot · 2026-11-17 · 第34轮】新增 *initial*：调用方可以把它刚算出来的
    状态传进来。为什么：稳态下 search_index 已经算过一次 index_status（实测 103ms/次，
    其中 80ms 是 fts_content 全表 COUNT），这里又原样再算一遍只为判「是否在构建」，
    等于每次检索白花约 100ms、占稳态 580ms 的 17%。传入初始状态后稳态只算一次。
    """
    wait_s = float(cfg.search_wait_seconds or 0)
    if wait_s <= 0:
        return initial if initial is not None else index_status(workspace_root=workspace_root, thread_id=thread_id)
    deadline = time.time() + wait_s
    st = initial if initial is not None else index_status(workspace_root=workspace_root, thread_id=thread_id)
    while not st.get("ready") and st.get("building") and time.time() < deadline:
        time.sleep(0.25)
        st = index_status(workspace_root=workspace_root, thread_id=thread_id)
    return st


def search_index(
    workspace_root: str | None = None,
    query: str = "",
    *,
    queries: list[str] | None = None,
    thread_id: str | None = None,
    limit: int | None = None,
) -> dict:
    cfg = get_code_index_config()
    lim = limit or cfg.search_limit
    root = resolve_index_root(workspace_root=workspace_root, thread_id=thread_id)
    conn = _connect(root)
    _ensure_schema(conn)
    _mark_reindex_if_tokenizer_changed(conn)
    needs_rebuild = _fts_needs_rebuild(conn)
    conn.close()

    rebuild_in_progress = False
    if cfg.auto_index_on_search:
        st = index_status(workspace_root=workspace_root, thread_id=thread_id)
        rebuild_in_progress = bool(st.get("building"))
        if needs_rebuild or (not st.get("ready") and not st.get("building")):
            schedule_build_index(
                workspace_root=workspace_root,
                thread_id=thread_id,
                force=bool(needs_rebuild),
            )
            st = index_status(workspace_root=workspace_root, thread_id=thread_id)
            rebuild_in_progress = bool(st.get("building"))
        # 【self-evolution-bot · 2026-11-17 · 第34轮】只有「正在构建」才需要等；
        # 稳态（已 ready 且无构建任务）直接把上面这份状态复用下去，
        # 不再为同一个判定重复算一次 index_status（每次约 100ms）。
        if st.get("building"):
            st = _wait_index_ready(workspace_root, thread_id=thread_id, cfg=cfg, initial=st)
            rebuild_in_progress = bool(st.get("building"))
        if st.get("building") and not st.get("ready") and int(st.get("files") or 0) == 0:
            return {
                "hits": [],
                "symbols": [],
                "related_files": [],
                "imported_by": [],
                "imports": [],
                "internal_ref_users": [],
                "type_supertypes": [],
                "type_subtypes": [],
                "query": query,
                "search_terms": [],
                "root": root,
                "db_path": str(_db_path(root)),
                "building": True,
                "ready": False,
            }

    conn = _connect(root)
    _ensure_schema(conn)
    from evoflow.tools.arg_coerce import normalize_search_query_inputs, parse_search_path_prefix

    path_prefix, query_body = parse_search_path_prefix(query)
    primary, extra = normalize_search_query_inputs(query_body, queries=queries)
    label, explicit = merge_search_queries(primary, queries=extra)
    if path_prefix and query_body != str(query or "").strip():
        scope = _normalize_path_prefix(path_prefix) or path_prefix
        label = f"path:{scope}" + (f" {label}" if label else "")
    if not label and path_prefix:
        label = f"path:{_normalize_path_prefix(path_prefix) or path_prefix}"
    if not label:
        conn.close()
        return {"hits": [], "symbols": [], "root": root, "db_path": str(_db_path(root))}

    q = label
    joined = " ".join(explicit)
    synonym_mode = len(explicit) > 1
    terms = _expand_search_terms(joined, explicit_terms=explicit, synonym_mode=synonym_mode)
    fts_mode = "or"
    if synonym_mode:
        fts_q = _build_fts_match_query(terms, original=joined, combine_mode="or")
    else:
        nl_terms = _nl_fts_terms(terms, primary=primary)
        nl_query = bool(re.search(r"\s", str(query_body or "").strip()))
        fts_mode = "and" if nl_query and len(nl_terms) >= 2 else "or"
        fts_q = _build_fts_match_query(nl_terms or terms, original=joined, combine_mode=fts_mode)
    fetch_lim = max(lim, lim * 8) if path_prefix else max(lim, lim * 2)

    hits: list[dict] = []
    hit_paths: set[str] = set()
    # 【self-evolution-bot · 2026-11-17 · 第32轮】必须 ORDER BY rank，否则候选池按 rowid
    # （入库先后）返回，等于随机抽样：先入库的 README / CONTRIBUTING / RELEASE 永远占前排。
    # 实证（同一份库，query="_read_persisted_build_progress"）：
    #   无 rank  → README.md / CONTRIBUTING.md / RELEASE.md  ← 全是仓库根早期文件
    #   有 rank  → 命中该符号的真实文件进前列
    # 代价实测 0~5ms（8849 文件库），可忽略。
    try:
        rows = conn.execute(
            "SELECT path, snippet(fts_content, 1, '<b>', '</b>', '…', 8) AS snip"
            " FROM fts_content WHERE fts_content MATCH ? ORDER BY rank LIMIT ?",
            (fts_q, fetch_lim),
        ).fetchall()
        for r in rows:
            p = str(r["path"])
            if p in hit_paths:
                continue
            hit_paths.add(p)
            hits.append({"path": p, "snippet": r["snip"], "kind": "content"})
    except sqlite3.OperationalError as e:
        logger.debug("FTS query failed (%r): %s", fts_q, e)
        for term in terms:
            if len(hits) >= fetch_lim:
                break
            try:
                rows = conn.execute(
                    "SELECT path, snippet(fts_content, 1, '<b>', '</b>', '…', 8) AS snip FROM fts_content WHERE fts_content MATCH ? LIMIT ?",
                    (_fts5_quote_term(term), max(1, fetch_lim - len(hits))),
                ).fetchall()
                for r in rows:
                    p = str(r["path"])
                    if p in hit_paths:
                        continue
                    hit_paths.add(p)
                    hits.append({"path": p, "snippet": r["snip"], "kind": "content"})
            except sqlite3.OperationalError:
                continue

    raw_hits = list(hits)

    # --- Semantic vector recall (hybrid merge) ---
    semantic_hits: list[dict] = []
    if cfg.semantic_search_enabled:
        semantic_hits = _semantic_recall_sync(
            conn,
            str(query_body or joined or label),
            cfg.semantic_top_k,
            cfg,
        )
        # Filter + merge semantic hits not already in FTS results
        for sh in semantic_hits:
            p = str(sh.get("path") or "")
            if not p or _path_has_skipped_segment(p):
                continue
            if path_prefix and not _path_under_prefix(p, path_prefix):
                continue
            if p not in hit_paths:
                hit_paths.add(p)
                raw_hits.append(sh)

    # 【self-evolution-bot · 2026-11-17 · 第34轮】把「整句」传进符号检索。
    # 不传的话新加的 match_rank=5 整句分支永远进不去（走不到），
    # 也就是经典的「改了函数、没接调用点」。
    raw_symbols = _search_symbols(
        conn, terms, fetch_lim, whole_query=str(query_body or label or "")
    )

    # [self-evolution-bot 2026-11-17 第32轮] 「把 rerank 前的 limit 截断延后」这个改动
    # 已撤销：回退后测试全绿、同池评测零差别 → 拿不出「改动前后有差别」的证据，
    # 就不留没被证实的代码。这里维持原样（在 rerank 之前按 lim 截断）。
    hits = _filter_index_rows(raw_hits, path_prefix=path_prefix, limit=lim)
    symbols = _filter_index_rows(raw_symbols, path_prefix=path_prefix, limit=lim)
    hits, symbols = _rerank_index_rows(
        hits,
        symbols,
        terms=terms,
        path_prefix=path_prefix,
        query_body=str(query_body or joined or label),
    )
    hits, symbols = _boost_filename_path_matches(
        hits,
        symbols,
        query=label,
        query_body=str(query_body or joined),
    )
    path_scope_relaxed = False
    path_scope_empty_hint = ""

    if path_prefix and not hits and not symbols and (raw_hits or raw_symbols):
        path_scope_empty_hint = f"No matches under path:{_normalize_path_prefix(path_prefix)} ({len(raw_hits)} content / {len(raw_symbols)} symbol hits elsewhere). Drop path: prefix or use a broader subdirectory."

    related: list[dict] = []
    imported_by: list[dict] = []
    imports: list[dict] = []
    seeds = list({h["path"] for h in hits} | {s["path"] for s in symbols})

    if cfg.dependency_graph_enabled and cfg.dependency_search_hops > 0 and seeds:
        extra = dependency_neighbors(
            conn,
            seeds,
            hops=cfg.dependency_search_hops,
            limit=lim,
        )
        for p in extra:
            if _path_has_skipped_segment(str(p)):
                continue
            if path_prefix and not _path_under_prefix(str(p), path_prefix):
                continue
            related.append({"path": p, "kind": "dependency_neighbor"})

    if cfg.dependency_graph_enabled and seeds:
        imported_by = list_importers(conn, seeds, limit=lim)
        imports = list_outgoing_imports(conn, seeds, limit=lim)
        if path_prefix:
            imported_by = [r for r in imported_by if _path_under_prefix(str(r.get("from_path") or ""), path_prefix) or _path_under_prefix(str(r.get("to_path") or ""), path_prefix)]
            imports = [r for r in imports if _path_under_prefix(str(r.get("from_path") or ""), path_prefix) or _path_under_prefix(str(r.get("to_path") or ""), path_prefix)]

    ref_users: list[dict] = []
    if cfg.internal_refs_enabled and seeds:
        placeholders = ",".join("?" for _ in seeds)
        rows = conn.execute(
            f"""
            SELECT DISTINCT from_path, to_path, symbol, line FROM internal_refs
            WHERE to_path IN ({placeholders})
            LIMIT ?
            """,
            (*seeds, lim),
        ).fetchall()
        for r in rows:
            ref_users.append(
                {
                    "from_path": str(r[0]),
                    "to_path": str(r[1]),
                    "symbol": str(r[2] or ""),
                    "line": int(r[3] or 0),
                    "kind": "internal_ref",
                }
            )
        if path_prefix:
            ref_users = [r for r in ref_users if _path_under_prefix(str(r.get("from_path") or ""), path_prefix)]

    type_supertypes: list[dict] = []
    type_subtypes: list[dict] = []
    type_names: list[str] = list({str(s["name"]) for s in symbols if s.get("name")})
    for term in terms:
        if re.fullmatch(r"[A-Za-z_]\w*", term):
            type_names.append(term)
    type_names = list(dict.fromkeys(type_names))

    if cfg.type_relations_enabled and (seeds or type_names):
        from evoflow.code_index.type_relations import list_type_relations_for_search

        type_supertypes, type_subtypes = list_type_relations_for_search(
            conn,
            seed_paths=seeds,
            type_names=type_names,
            limit=lim,
        )

    conn.close()
    return {
        "hits": hits,
        "symbols": symbols,
        "related_files": related,
        "imported_by": imported_by,
        "imports": imports,
        "internal_ref_users": ref_users,
        "type_supertypes": type_supertypes,
        "type_subtypes": type_subtypes,
        "semantic_hits": semantic_hits,
        "query": q,
        "search_terms": terms,
        "path_prefix": _normalize_path_prefix(path_prefix),
        "path_scope_relaxed": path_scope_relaxed,
        "path_scope_empty_hint": path_scope_empty_hint,
        "fts_combine_mode": "or" if synonym_mode else fts_mode,
        "semantic_enabled": cfg.semantic_search_enabled,
        "root": root,
        "db_path": str(_db_path(root)),
        "rebuild_in_progress": rebuild_in_progress,
        # 【self-evolution-bot · 2026-11-17 · 第33轮】索引新鲜度随结果返回（见 index_freshness）
        **index_freshness(root),
    }
