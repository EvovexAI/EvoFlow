"""Migrate an owned KB's data from the central DB into its own index DB.

Before the per-KB split every KB shared ``{knowledge_root}/owned.sqlite``. This
module moves one KB's KB-owned rows (documents, chunks, embeddings, FTS, assets,
folders, doc links, wiki, KB-scoped graph) into
``<kb_dir>/.evoflow/kb/index.db`` and backfills the central ``kb_doc_index`` /
``kb_asset_index`` maps plus ``kb_bases.storage_dir``.

Design constraints:

* **Non-destructive by default.** Rows are *copied*; the central copies are only
  removed by an explicit :func:`purge_central_rows` call after verification.
* **Idempotent.** Re-running copies with ``INSERT OR REPLACE`` and re-checks
  counts, so a partial failure can simply be retried.
* **Verifiable.** :func:`verify_kb` compares row counts per table before the
  caller decides to purge.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from evoflow.knowledge.owned import store_paths
from evoflow.knowledge.owned.db import db
from evoflow.knowledge.owned.ids import utc_now
from evoflow.knowledge.owned.kb_conn import close_all, db_for_dir

logger = logging.getLogger(__name__)

# table -> (columns, where clause using kb_id)
_KB_TABLES: dict[str, tuple[tuple[str, ...], str]] = {
    "kb_documents": (
        (
            "id", "kb_id", "title", "source_type", "file_name", "mime", "size_bytes",
            "content_hash", "blob_path", "folder_path", "sort_order", "parse_status",
            "error_message", "chunk_count", "summary_status", "summary_text",
            "tags_json", "frontmatter_json", "source_rel_path", "latest_job_id",
            "created_at", "updated_at", "deleted_at",
        ),
        "kb_id=?",
    ),
    "kb_folders": (("id", "kb_id", "path", "created_at", "updated_at"), "kb_id=?"),
    "kb_chunks": (
        (
            "id", "kb_id", "doc_id", "ordinal", "content", "context_header",
            "token_estimate", "heading_path", "chunk_kind", "enabled",
            "created_at", "updated_at",
        ),
        "kb_id=?",
    ),
    "kb_chunk_embeddings": (
        ("chunk_id", "kb_id", "doc_id", "dim", "embedding", "model", "created_at"),
        "kb_id=?",
    ),
    "kb_assets": (
        (
            "id", "kb_id", "doc_id", "chunk_id", "kind", "blob_path", "alt_text",
            "caption_status", "caption_text", "width", "height", "created_at",
        ),
        "kb_id=?",
    ),
    "kb_doc_links": (
        ("id", "kb_id", "src_doc_id", "target_raw", "target_doc_id", "created_at"),
        "kb_id=?",
    ),
    "wiki_folders": (
        ("id", "kb_id", "parent_id", "name", "path", "sort_order", "created_at", "updated_at", "deleted_at"),
        "kb_id=?",
    ),
    "wiki_pages": (
        (
            "id", "kb_id", "slug", "title", "page_type", "status", "folder_id",
            "body_md", "summary", "aliases_json", "source_refs_json",
            "chunk_refs_json", "in_links_json", "out_links_json", "version",
            "last_edit_source", "last_editor_id", "created_at", "updated_at", "deleted_at",
        ),
        "kb_id=?",
    ),
    "kg_nodes": (
        ("id", "kb_id", "name", "attrs_json", "chunk_ids_json", "created_at", "updated_at"),
        "kb_id=?",
    ),
    "kg_edges": (
        ("id", "kb_id", "src_node_id", "dst_node_id", "rel_type", "created_at"),
        "kb_id=?",
    ),
}

# FTS virtual table needs its own handling.
_FTS_TABLE = "kb_chunks_fts"
_FTS_COLS = ("chunk_id", "kb_id", "doc_id", "content")


def _existing_columns(conn: Any, table: str) -> set[str]:
    try:
        return {str(r[1]) for r in conn.execute(f'PRAGMA table_info("{table}")').fetchall()}
    except Exception:
        return set()


def _copy_table(src: Any, dst: Any, table: str, cols: tuple[str, ...], where: str, kb_id: str) -> int:
    """Copy rows of *table* for *kb_id* from src to dst. Returns rows copied."""
    dst_cols = _existing_columns(dst, table)
    if not dst_cols:
        return 0
    use = tuple(c for c in cols if c in dst_cols)
    if not use:
        return 0
    try:
        rows = src.execute(
            f'SELECT {",".join(use)} FROM "{table}" WHERE {where}',
            (kb_id,),
        ).fetchall()
    except Exception:
        logger.debug("table %s not present in central db", table, exc_info=True)
        return 0
    if not rows:
        return 0
    placeholders = ",".join("?" * len(use))
    dst.executemany(
        f'INSERT OR REPLACE INTO "{table}" ({",".join(use)}) VALUES ({placeholders})',
        [tuple(r[c] for c in use) for r in rows],
    )
    return len(rows)


def _copy_fts(src: Any, dst: Any, kb_id: str) -> int:
    if not _existing_columns(dst, _FTS_TABLE):
        return 0
    try:
        rows = src.execute(
            f'SELECT {",".join(_FTS_COLS)} FROM "{_FTS_TABLE}" WHERE kb_id=?',
            (kb_id,),
        ).fetchall()
    except Exception:
        logger.debug("FTS table absent in central db", exc_info=True)
        return 0
    if not rows:
        return 0
    dst.execute(f'DELETE FROM "{_FTS_TABLE}" WHERE kb_id=?', (kb_id,))
    dst.executemany(
        f'INSERT INTO "{_FTS_TABLE}" ({",".join(_FTS_COLS)}) VALUES (?,?,?,?)',
        [tuple(r[c] for c in _FTS_COLS) for r in rows],
    )
    return len(rows)


def count_kb_rows(conn: Any, kb_id: str, table: str) -> int:
    try:
        return int(conn.execute(f'SELECT COUNT(*) FROM "{table}" WHERE kb_id=?', (kb_id,)).fetchone()[0])
    except Exception:
        return -1


def _normalize_blob_paths(conn: Any, kb_id: str) -> int:
    """Rewrite legacy ``files/{kb_id}/{doc_id}/...`` blob paths to ``blobs/...``."""
    try:
        rows = conn.execute(
            "SELECT id, blob_path FROM kb_documents WHERE kb_id=? AND blob_path LIKE 'files/%'",
            (kb_id,),
        ).fetchall()
    except Exception:
        return 0
    n = 0
    prefix = f"files/{kb_id}/"
    for r in rows:
        old = str(r["blob_path"] or "")
        new = "blobs/" + old[len(prefix):] if old.startswith(prefix) else old.replace("files/", "blobs/", 1)
        conn.execute("UPDATE kb_documents SET blob_path=? WHERE id=?", (new, r["id"]))
        n += 1
    # kb_assets carries its own blob_path column.
    try:
        arows = conn.execute(
            "SELECT id, blob_path FROM kb_assets WHERE kb_id=? AND blob_path LIKE 'files/%'",
            (kb_id,),
        ).fetchall()
        for r in arows:
            old = str(r["blob_path"] or "")
            new = "blobs/" + old[len(prefix):] if old.startswith(prefix) else old.replace("files/", "blobs/", 1)
            conn.execute("UPDATE kb_assets SET blob_path=? WHERE id=?", (new, r["id"]))
            n += 1
    except Exception:
        pass
    return n


def _migrate_blobs(kb_id: str, target_dir: str | Path) -> dict[str, int]:
    """Move legacy ``files/{kb_id}/{doc_id}/`` blobs into the KB's own layout.

    Pre-split installs copied originals under ``{knowledge_root}/files/``. The new
    layout keeps them in ``<kb_dir>/.evoflow/kb/blobs/``. Files are *copied* (the
    legacy tree is left intact for rollback) and only counted when present.
    """
    import shutil

    from evoflow.knowledge.owned.paths import knowledge_root

    src_root = knowledge_root() / "files" / str(kb_id)
    if not src_root.is_dir():
        return {}
    dst_root = store_paths.blobs_dir(target_dir)

    copied = 0
    skipped = 0
    for doc_dir in sorted(src_root.iterdir()):
        if not doc_dir.is_dir():
            continue
        target = dst_root / doc_dir.name
        if target.exists() and any(target.rglob("*")):
            skipped += 1
            continue
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(doc_dir, target, dirs_exist_ok=True)
            copied += 1
        except OSError:
            logger.warning("blob copy failed for %s", doc_dir, exc_info=True)
            skipped += 1
    out: dict[str, int] = {}
    if copied:
        out["blobsCopied"] = copied
    if skipped:
        out["blobsSkipped"] = skipped
    return out


def migrate_kb(
    kb_id: str,
    *,
    kb_dir: str | None = None,
    verify: bool = True,
    move_blobs: bool = True,
) -> dict[str, Any]:
    """Copy one KB's rows from the central DB into its own index DB.

    Returns a summary with per-table counts. Never deletes central rows — call
    :func:`purge_central_rows` afterwards once satisfied.
    """
    kid = str(kb_id or "").strip()
    if not kid:
        raise ValueError("kb_id is required")

    target_dir = store_paths.resolve_kb_dir(kid, storage_dir=kb_dir)
    store_paths.ensure_kb_layout(target_dir)

    copied: dict[str, int] = {}
    with db() as src:
        cols = {str(r[1]) for r in src.execute("PRAGMA table_info(kb_bases)").fetchall()}
        if not cols:
            raise ValueError("central kb_bases missing")
        base = src.execute("SELECT * FROM kb_bases WHERE id=?", (kid,)).fetchone()
        if not base:
            raise ValueError(f"knowledge base not found: {kid}")

        with db_for_dir(target_dir) as dst:
            for table, (tcols, where) in _KB_TABLES.items():
                n = _copy_table(src, dst, table, tcols, where, kid)
                if n:
                    copied[table] = n
            n = _copy_fts(src, dst, kid)
            if n:
                copied[_FTS_TABLE] = n
            normalized = _normalize_blob_paths(dst, kid)
            if normalized:
                copied["blobPathNormalized"] = normalized
            dst.commit()

    # Backfill central maps + storage_dir.
    now = utc_now()
    with db() as conn:
        conn.execute(
            "UPDATE kb_bases SET storage_dir=?, updated_at=? WHERE id=?",
            (str(target_dir), now, kid),
        )
        try:
            conn.execute(
                """
                INSERT INTO kb_doc_index(doc_id, kb_id, created_at)
                SELECT id, kb_id, ? FROM kb_documents WHERE kb_id=?
                ON CONFLICT(doc_id) DO UPDATE SET kb_id=excluded.kb_id
                """,
                (now, kid),
            )
        except Exception:
            logger.debug("kb_doc_index backfill skipped for kb=%s", kid, exc_info=True)
        try:
            conn.execute(
                """
                INSERT INTO kb_asset_index(asset_id, kb_id, created_at)
                SELECT id, kb_id, ? FROM kb_assets WHERE kb_id=?
                ON CONFLICT(asset_id) DO UPDATE SET kb_id=excluded.kb_id
                """,
                (now, kid),
            )
        except Exception:
            logger.debug("kb_asset_index backfill skipped for kb=%s", kid, exc_info=True)

    out: dict[str, Any] = {
        "kbId": kid,
        "kbDir": str(target_dir),
        "copied": copied,
        "totalRows": sum(copied.values()),
    }
    if move_blobs:
        blob_stats = _migrate_blobs(kid, target_dir)
        if blob_stats:
            out.update(blob_stats)
    if verify:
        out["verify"] = verify_kb(kid, kb_dir=str(target_dir))
    return out


def verify_kb(kb_id: str, *, kb_dir: str | None = None) -> dict[str, Any]:
    """Compare per-table row counts between central DB and the KB's index DB."""
    kid = str(kb_id or "").strip()
    target_dir = store_paths.resolve_kb_dir(kid, storage_dir=kb_dir)

    mismatches: dict[str, dict[str, int]] = {}
    checked: dict[str, int] = {}
    with db() as src, db_for_dir(target_dir) as dst:
        for table in list(_KB_TABLES) + [_FTS_TABLE]:
            a = count_kb_rows(src, kid, table)
            b = count_kb_rows(dst, kid, table)
            if a < 0 and b < 0:
                continue
            checked[table] = b
            if a > 0 and b != a:
                mismatches[table] = {"central": a, "kb": b}

    return {
        "kbId": kid,
        "kbDir": str(target_dir),
        "ok": not mismatches,
        "checked": checked,
        "mismatches": mismatches,
    }


def purge_central_rows(kb_id: str) -> dict[str, int]:
    """Delete a KB's rows from the central DB after a verified migration.

    Only call this once :func:`verify_kb` reports ``ok`` — the KB's own index DB
    becomes the sole copy.
    """
    kid = str(kb_id or "").strip()
    if not kid:
        raise ValueError("kb_id is required")
    removed: dict[str, int] = {}
    with db() as conn:
        for table in list(_KB_TABLES) + [_FTS_TABLE]:
            if not _existing_columns(conn, table):
                continue
            try:
                cur = conn.execute(f'DELETE FROM "{table}" WHERE kb_id=?', (kid,))
                if cur.rowcount:
                    removed[table] = int(cur.rowcount)
            except Exception:
                logger.debug("purge skipped for %s", table, exc_info=True)
        # ``kb_doc_index`` / ``kb_asset_index`` are NOT purged: they are the maps
        # that let ``get_document(doc_id)`` / ``get_asset(asset_id)`` find which
        # KB owns a row. Removing them would break those lookups.
    return removed


def purge_deleted_bases(*, vacuum: bool = True) -> dict[str, Any]:
    """Remove orphan rows of soft-deleted bases from the central DB.

    ``delete_base`` only stamps ``kb_bases.deleted_at``; historically it left all
    chunks/embeddings/FTS behind (24 MB on the dev machine). This cleans them.
    """
    removed: dict[str, dict[str, int]] = {}
    with db() as conn:
        rows = conn.execute(
            "SELECT id, name FROM kb_bases WHERE deleted_at IS NOT NULL"
        ).fetchall()
        dead = [(str(r["id"]), str(r["name"] or "")) for r in rows]

        for kb_id, name in dead:
            per: dict[str, int] = {}
            for table in list(_KB_TABLES) + [_FTS_TABLE]:
                if not _existing_columns(conn, table):
                    continue
                try:
                    cur = conn.execute(f'DELETE FROM "{table}" WHERE kb_id=?', (kb_id,))
                    if cur.rowcount:
                        per[table] = int(cur.rowcount)
                except Exception:
                    logger.debug("orphan purge skipped for %s", table, exc_info=True)
            try:
                conn.execute("DELETE FROM kb_doc_index WHERE kb_id=?", (kb_id,))
                conn.execute("DELETE FROM kb_asset_index WHERE kb_id=?", (kb_id,))
            except Exception:
                pass
            if per:
                removed[f"{kb_id} ({name})"] = per
        conn.commit()

    # VACUUM cannot run inside a transaction — do it on a dedicated connection
    # after the deletes above are committed.
    vacuumed = False
    if vacuum and removed:
        vacuumed = vacuum_central()

    close_all()
    return {"purged": removed, "vacuumed": vacuumed}


def vacuum_central() -> bool:
    """Reclaim free pages in the central DB. Returns True on success."""
    import sqlite3

    from evoflow.knowledge.owned.paths import owned_db_path

    path = owned_db_path()
    if not path.is_file():
        return False
    conn: sqlite3.Connection | None = None
    try:
        conn = sqlite3.connect(str(path), timeout=60.0, isolation_level=None)
        conn.execute("PRAGMA busy_timeout=30000")
        conn.execute("VACUUM")
        return True
    except Exception:
        logger.warning("VACUUM failed for %s", path, exc_info=True)
        return False
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass


def migrate_all(*, skip_builtin: bool = False, verify: bool = True, move_blobs: bool = True) -> dict[str, Any]:
    """Migrate every active KB that has not been migrated yet."""
    from evoflow.knowledge.owned.service import list_bases

    results: list[dict[str, Any]] = []
    for b in list_bases():
        kid = str(b.get("id") or "").strip()
        if not kid:
            continue
        if skip_builtin and b.get("builtin"):
            continue
        if str(b.get("storageDir") or "").strip():
            results.append({"kbId": kid, "skipped": "already_migrated"})
            continue
        try:
            results.append(migrate_kb(kid, verify=verify, move_blobs=move_blobs))
        except Exception as exc:
            logger.exception("migration failed for kb=%s", kid)
            results.append({"kbId": kid, "error": f"{type(exc).__name__}: {exc}"})
    return {"count": len(results), "results": results}
