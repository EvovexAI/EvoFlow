"""SQLite FTS5 workspace index.

When indexing runs
------------------
- **Full rebuild (blocking API)**: ``POST /api/workspaces/index-build`` — runs in a worker thread on the gateway (HTTP waits until done).
- **Background rebuild (preferred for UI)**: ``POST /api/workspaces/index-warm`` — returns immediately; poll ``GET /api/workspaces/index-status``.
- **Incremental**: ``POST /api/workspaces/index-file`` or the background watcher after file changes.
- **Watcher**: ``POST /api/workspaces/index-watch`` (EvoPanel starts after initial build).
- **Lazy**: first search if no DB exists.
- **Throttle**: full rebuild skipped if indexed within ``reindex_min_interval_seconds``.

Where data is stored
--------------------
- Directory: ``$EVOFLOW_DATA_DIR/code_index/`` (default ``~/.evoflow/code_index/``).
- One SQLite file per workspace root: ``{sha256(root)[:16]}.db``.
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
import threading
import time
from collections import defaultdict
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any, TypeVar

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

_SKIP_DIRS = {
    ".git",
    "node_modules",
    "__pycache__",
    ".venv",
    "venv",
    "dist",
    "build",
    ".next",
    "target",
    "binaries",
    "_internal",
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
    """Public helper: path to the SQLite index file for a resolved workspace root."""
    base = Path(os.environ.get("EVOFLOW_DATA_DIR", Path.home() / ".evoflow")) / "code_index"
    base.mkdir(parents=True, exist_ok=True)
    return base / f"{_workspace_hash(workspace_root)}.db"


def _db_path(root: str) -> Path:
    return index_db_path(root)


def _configure_sqlite_connection(conn: sqlite3.Connection) -> None:
    """Match main app DB pragmas so searches survive background index builds."""
    conn.execute("PRAGMA busy_timeout=60000")
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    _load_sqlite_vec_extension(conn)


def _load_sqlite_vec_extension(conn: sqlite3.Connection) -> None:
    """Best-effort load of the ``sqlite-vec`` extension for vec0 vector table."""
    try:
        import sqlite_vec

        conn.enable_load_extension(True)
        conn.load_extension(sqlite_vec.loadable_path())
    except Exception as exc:  # noqa: BLE001 - optional, must never block
        logger.debug("code_index: sqlite-vec extension not loaded: %s", exc)


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
    sql_row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='fts_content'"
    ).fetchone()
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


def _ensure_vec_table(conn: sqlite3.Connection) -> None:
    """Create the ``code_vec`` vec0 virtual table for semantic search.

    Best-effort: if sqlite-vec is not loaded, the table is skipped and
    semantic search degrades to FTS5-only.
    """
    cfg = get_code_index_config()
    if not cfg.semantic_search_enabled:
        return
    dim = cfg.semantic_embedding_dim
    try:
        conn.execute(
            f"CREATE VIRTUAL TABLE IF NOT EXISTS code_vec "
            f"USING vec0(path TEXT PRIMARY KEY, embedding FLOAT[{dim}])"
        )
        conn.commit()
    except sqlite3.OperationalError as exc:
        if "vec0" in str(exc).lower() or "no such module" in str(exc).lower():
            logger.debug("code_index: vec0 module not available, semantic search disabled")
        else:
            raise


def _path_has_skipped_segment(rel: str) -> bool:
    parts = Path(rel).as_posix().split("/")
    return any(p in _SKIP_DIRS or p.startswith(".") for p in parts if p)


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
                if segments[i:i + len(pref_segs)] == pref_segs:
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
    elif t.isascii() and t.islower() and len(t) >= 5 and "-" not in t and "_" not in t:
        out.append(f"{t[:-1]}-{t[-1]}")
        out.append(f"{t[:-1]}_{t[-1]}")
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
    "function": 10.0, "def": 10.0, "method": 10.0, "async_function": 10.0,
    "class": 8.0, "class_definition": 8.0,
    "interface": 9.0,
    "constructor": 8.0, "enum": 5.0,
    "type": 6.0, "type_alias": 6.0,
    "variable": 2.0, "constant": 3.0, "property": 3.0, "field": 3.0,
    "import": 1.0, "module": 4.0,
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

        if match_rank >= 3:
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
    """Drop polluted paths (bundled deps) and apply optional path scope."""
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

        return await get_embeddings(texts)
    except Exception as exc:
        logger.warning("code_index: batch embedding failed: %s: %s", type(exc).__name__, exc)
        return None


async def _embed_query(text: str) -> list[float] | None:
    """Embed a search query. Returns ``None`` on failure."""
    try:
        from evoflow.knowledge.embedding import get_embedding

        return await get_embedding(text)
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

        mc = get_embedding_config()
        provider = _resolve_provider(mc)
        if isinstance(provider, LocalEmbeddingProvider):
            return provider.embed_batch_sync(texts)
        return _run_async_in_thread(lambda: _embed_texts_batch(texts))
    except Exception as exc:
        logger.warning(
            "code_index: sync batch embedding failed: %s: %s",
            type(exc).__name__,
            exc,
        )
        return None


def _embed_query_sync(text: str) -> list[float] | None:
    """Synchronous query embedding — bypasses ``asyncio.to_thread``."""
    try:
        from evoflow.knowledge.embedding.local_provider import LocalEmbeddingProvider
        from evoflow.knowledge.embedding.registry import (
            _resolve_provider,
            get_embedding_config,
        )

        mc = get_embedding_config()
        provider = _resolve_provider(mc)
        if isinstance(provider, LocalEmbeddingProvider):
            return provider.embed_sync(text)
        return _run_async_in_thread(lambda: _embed_query(text))
    except Exception as exc:
        logger.warning(
            "code_index: sync query embedding failed: %s: %s",
            type(exc).__name__,
            exc,
        )
        return None


def _run_async_in_thread(coro_factory: Callable[[], Any]) -> Any:
    """Run an async coroutine in a separate thread with its own event loop.

    This avoids ``Cannot run the event loop while another loop is running``
    when :func:`build_index` / :func:`search_index` are called from within an
    async context (e.g. tests using ``asyncio.run``).
    """
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
    t.join()

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
    pairs: list[tuple[str, str]] = []
    for fp in files:
        try:
            rel = fp.relative_to(root_path).as_posix()
            text = fp.read_text(encoding="utf-8", errors="replace")[: cfg.max_chars_per_file]
            pairs.append((rel, text))
        except OSError:
            continue

    if not pairs:
        return 0

    # Batch embed (sync path avoids asyncio.to_thread issues in background threads)
    texts = [p[1] for p in pairs]
    try:
        embeddings = _embed_texts_sync(texts)
    except Exception as exc:
        logger.warning("code_index: embedding failed: %s: %s", type(exc).__name__, exc)
        return 0

    if not embeddings or len(embeddings) != len(pairs):
        logger.warning("code_index: embedding count mismatch (%d vs %d), skipping vectors",
                       len(embeddings or []), len(pairs))
        return 0

    # Store vectors
    dim = cfg.semantic_embedding_dim
    conn = _connect(root)
    try:
        _ensure_schema(conn)
        count = 0
        for (rel, _), vec in zip(pairs, embeddings, strict=True):
            if len(vec) != dim:
                logger.debug("code_index: dim mismatch for %s: %d != %d", rel, len(vec), dim)
                continue
            conn.execute(
                "INSERT OR REPLACE INTO code_vec (path, embedding) VALUES (?, ?)",
                (rel, _pack_vec(vec)),
            )
            count += 1
        conn.commit()
        logger.info("code_index: embedded %d/%d files into code_vec", count, len(pairs))
        return count
    except sqlite3.OperationalError as exc:
        logger.debug("code_index: code_vec insert failed (vec0 not available?): %s", exc)
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

    dim = cfg.semantic_embedding_dim
    if len(query_vec) != dim:
        logger.debug("code_index: query dim mismatch: %d != %d", len(query_vec), dim)
        return []

    blob = _pack_vec(query_vec)
    try:
        rows = conn.execute(
            "SELECT path, distance FROM code_vec "
            "WHERE embedding MATCH ? AND k = ? ORDER BY distance",
            (blob, top_k),
        ).fetchall()
    except sqlite3.OperationalError:
        return []

    return [
        {
            "path": str(r["path"]),
            "distance": round(float(r["distance"]), 4),
            "score": round(1.0 - float(r["distance"]), 4),
            "kind": "semantic",
        }
        for r in rows
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
    conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES ('fts_needs_rebuild', '1')")
    conn.commit()


def _delete_path_from_index(conn: sqlite3.Connection, rel: str) -> None:
    conn.execute("DELETE FROM fts_content WHERE path = ?", (rel,))
    conn.execute("DELETE FROM symbols WHERE path = ?", (rel,))
    conn.execute("DELETE FROM file_deps WHERE from_path = ? OR to_path = ?", (rel, rel))
    conn.execute("DELETE FROM internal_refs WHERE from_path = ? OR to_path = ?", (rel, rel))
    conn.execute("DELETE FROM type_relations WHERE from_path = ? OR to_path = ?", (rel, rel))
    try:
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
                    inc_text = abs_path.read_text(encoding="utf-8", errors="replace")[: cfg.max_chars_per_file]
                    vec = _run_async_in_thread(lambda: _embed_query(inc_text))
                    if vec and len(vec) == cfg.semantic_embedding_dim:
                        conn.execute(
                            "INSERT OR REPLACE INTO code_vec (path, embedding) VALUES (?, ?)",
                            (rel, _pack_vec(vec)),
                        )
                except Exception as exc:
                    logger.debug("code_index: incremental embedding failed for %s: %s", rel, exc)

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
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in _SKIP_DIRS and not d.startswith(".")]
        for name in filenames:
            p = Path(dirpath) / name
            if p.suffix.lower() not in _TEXT_SUFFIXES:
                continue
            if p.stat().st_size > 512_000:
                continue
            found.append(p)
            if len(found) >= max_files:
                return found
    return found


def _read_index_status_unlocked(root: str, dbp: Path, *, building: bool) -> dict:
    """Lock-free read of index readiness (WAL allows concurrent reads during rebuild)."""
    try:
        conn = _connect(root)
        try:
            _ensure_schema(conn)
            row = conn.execute("SELECT value FROM meta WHERE key='root'").fetchone()
            n = int(conn.execute("SELECT COUNT(*) FROM fts_content").fetchone()[0])
            sym_n = int(conn.execute("SELECT COUNT(*) FROM symbols").fetchone()[0])
            ready = bool(row and str(row[0]) == root and n > 0)
        finally:
            conn.close()
        updated_at = None
        try:
            updated_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(dbp.stat().st_mtime))
        except OSError:
            pass
        return {
            "ok": True,
            "ready": ready,
            "building": building,
            "root": root,
            "db_path": str(dbp),
            "files": n,
            "symbols": sym_n,
            "updated_at": updated_at,
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


_build_jobs: dict[str, threading.Thread] = {}
_build_progress: dict[str, dict] = {}
_jobs_lock = threading.Lock()


def _update_build_progress(root: str, **fields: object) -> None:
    key = _workspace_hash(root)
    with _jobs_lock:
        cur = dict(_build_progress.get(key) or {})
        cur.update(fields)
        _build_progress[key] = cur


def _get_build_progress(root: str) -> dict:
    key = _workspace_hash(root)
    with _jobs_lock:
        return dict(_build_progress.get(key) or {})


def _clear_build_progress(root: str) -> None:
    key = _workspace_hash(root)
    with _jobs_lock:
        _build_progress.pop(key, None)


def _merge_build_progress(status: dict, root: str) -> dict:
    prog = _get_build_progress(root)
    if not prog and not status.get("building"):
        return status
    total = int(prog.get("total_files") or status.get("build_total_files") or 0)
    done = int(prog.get("indexed_files") or status.get("build_indexed_files") or 0)
    pct = round(100.0 * done / total, 1) if total > 0 else None
    out = dict(status)
    if prog or status.get("building"):
        out.update(
            {
                "build_total_files": total or None,
                "build_indexed_files": done or None,
                "build_progress_pct": pct,
                "build_phase": prog.get("phase") or status.get("build_phase"),
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
    """Enqueue a full index build on a background thread (one job per workspace root)."""
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
                "status": "ready",
                "root": root,
                "db_path": str(dbp),
                "files": st.get("files"),
            }
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

        def _run() -> None:
            try:
                build_index(workspace_root=workspace_root, thread_id=thread_id, force=force)
            except Exception:
                logger.exception("background code_index build failed for %s", root)
            finally:
                with _jobs_lock:
                    _build_jobs.pop(key, None)

        t = threading.Thread(target=_run, name=f"code-index-build-{key[:8]}", daemon=True)
        _build_jobs[key] = t
        t.start()
    return {"ok": True, "status": "scheduled", "root": root, "db_path": str(dbp)}


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
    _update_build_progress(
        root,
        phase="indexing",
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

    try:
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

        run_index_db(root, _clear_tables)

        for batch_start in range(0, len(source_files), _BUILD_BATCH_SIZE):
            batch = source_files[batch_start : batch_start + _BUILD_BATCH_SIZE]

            def _index_batch(files: list[Path] = batch) -> None:
                nonlocal indexed, sym_count, dep_count, ref_count, type_rel_count
                conn = _connect(root)
                try:
                    _ensure_schema(conn)
                    for fp in files:
                        try:
                            rel = fp.relative_to(root_path).as_posix()
                            text = fp.read_text(encoding="utf-8", errors="replace")
                        except OSError:
                            continue
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
        vec_count = _index_embeddings_sync(root, root_path, source_files, cfg)

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
        "code_index: indexed %d files (%d symbols, %d deps, %d refs, %d type_rels, %d vecs) under %s -> %s parsers=%s",
        indexed,
        sym_count,
        dep_count,
        ref_count,
        type_rel_count,
        vec_count,
        root,
        dbp,
        dict(parser_stats),
    )
    return {
        "ok": True,
        "files": indexed,
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


def _search_symbols(conn: sqlite3.Connection, terms: list[str], lim: int) -> list[dict]:
    """Symbol lookup: exact → prefix → substring (substring only for terms ≥5 chars)."""
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
) -> dict:
    """Poll until index is ready or timeout (only while a build job is active)."""
    wait_s = float(cfg.search_wait_seconds or 0)
    if wait_s <= 0:
        return index_status(workspace_root=workspace_root, thread_id=thread_id)
    deadline = time.time() + wait_s
    st = index_status(workspace_root=workspace_root, thread_id=thread_id)
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
        st = _wait_index_ready(workspace_root, thread_id=thread_id, cfg=cfg)
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
    try:
        rows = conn.execute(
            "SELECT path, snippet(fts_content, 1, '<b>', '</b>', '…', 8) AS snip FROM fts_content WHERE fts_content MATCH ? LIMIT ?",
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

    raw_symbols = _search_symbols(conn, terms, fetch_lim)

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
        path_scope_empty_hint = (
            f"No matches under path:{_normalize_path_prefix(path_prefix)} "
            f"({len(raw_hits)} content / {len(raw_symbols)} symbol hits elsewhere). "
            "Drop path: prefix or use a broader subdirectory."
        )

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
            imported_by = [
                r
                for r in imported_by
                if _path_under_prefix(str(r.get("from_path") or ""), path_prefix)
                or _path_under_prefix(str(r.get("to_path") or ""), path_prefix)
            ]
            imports = [
                r
                for r in imports
                if _path_under_prefix(str(r.get("from_path") or ""), path_prefix)
                or _path_under_prefix(str(r.get("to_path") or ""), path_prefix)
            ]

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
            ref_users = [
                r for r in ref_users if _path_under_prefix(str(r.get("from_path") or ""), path_prefix)
            ]

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
    }
