"""Public service API for owned knowledge bases."""

from __future__ import annotations

import logging
import mimetypes
from pathlib import Path
from typing import Any

from evoflow.knowledge.embedding import get_embedding
from evoflow.knowledge.owned import blob_store, jobs
from evoflow.knowledge.owned import activity as owned_activity
from evoflow.knowledge.owned.db import db
from evoflow.knowledge.owned.embedding_bind import resolve_create_binding
from evoflow.knowledge.owned.formats import (
    MAX_FILE_BYTES,
    is_supported_file,
    should_skip_dir,
    should_skip_file,
)
from evoflow.knowledge.owned.ids import new_id, utc_now
from evoflow.knowledge.owned.pipeline import _model_config_for_base
from evoflow.knowledge.owned.retrieve import (
    enrich_hits,
    purge_document_index,
    rrf_fuse,
    search_keyword,
    search_title,
    search_vector,
)
from evoflow.knowledge.owned.worker import ensure_owned_kb_worker_started
from evoflow.knowledge.owned import kg as kg_store

logger = logging.getLogger(__name__)

_CHUNK_SIZE_MIN = 64
_CHUNK_SIZE_MAX = 8192
_CHUNK_OVERLAP_MIN = 0
_CHUNK_OVERLAP_MAX = 4096


def _parse_int_field(raw: Any, *, field: str) -> int:
    try:
        return int(raw)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field} must be an integer") from exc


def _validate_chunk_size(raw: Any) -> int:
    n = _parse_int_field(raw, field="chunkSize")
    if n < _CHUNK_SIZE_MIN or n > _CHUNK_SIZE_MAX:
        raise ValueError(f"chunkSize must be between {_CHUNK_SIZE_MIN} and {_CHUNK_SIZE_MAX}")
    return n


def _validate_chunk_overlap(raw: Any, *, chunk_size: int) -> int:
    n = _parse_int_field(raw, field="chunkOverlap")
    if n < _CHUNK_OVERLAP_MIN or n > _CHUNK_OVERLAP_MAX:
        raise ValueError(
            f"chunkOverlap must be between {_CHUNK_OVERLAP_MIN} and {_CHUNK_OVERLAP_MAX}"
        )
    if n >= chunk_size:
        raise ValueError("chunkOverlap must be less than chunkSize")
    return n


def _row_base(row: Any) -> dict[str, Any]:
    d = dict(row)
    ref = str(d.get("embedding_api_key_ref") or "")
    has_key = False
    if ref:
        try:
            from evoflow.knowledge.vault import secrets as vault_secrets

            has_key = vault_secrets.has_secret(ref)
        except Exception:
            has_key = False
    # Registry-bound cloud models keep the key on the model row, not per-KB secret.
    if not has_key and str(d.get("embedding_mode") or "").lower() != "local":
        try:
            from evoflow.knowledge.owned.embedding_bind import embedding_runtime_ready_for_base_row

            ready, _ = embedding_runtime_ready_for_base_row(dict(d))
            has_key = bool(ready)
        except Exception:
            pass
    return {
        "id": d["id"],
        "name": d["name"],
        "description": d.get("description") or "",
        "chunkSize": d.get("chunk_size"),
        "chunkOverlap": d.get("chunk_overlap"),
        "chunkStrategy": d.get("chunk_strategy"),
        "embeddingMode": d.get("embedding_mode"),
        "embeddingModel": d.get("embedding_model"),
        "embeddingModelRef": d.get("embedding_model_ref") or "",
        "embeddingBaseUrl": d.get("embedding_base_url") or "",
        "embeddingDim": d.get("embedding_dim"),
        "hasEmbeddingApiKey": has_key,
        "vectorEnabled": bool(d.get("vector_enabled")),
        "keywordEnabled": bool(d.get("keyword_enabled")),
        "wikiEnabled": bool(d.get("wiki_enabled")),
        "graphEnabled": bool(d.get("graph_enabled")),
        "summaryEnabled": bool(d.get("summary_enabled")),
        "imageCaptionEnabled": bool(d.get("image_caption_enabled")),
        "syncSourceType": d.get("sync_source_type") or "",
        "syncSourcePath": d.get("sync_source_path") or "",
        "syncVaultId": d.get("sync_vault_id") or "",
        "lastSyncedAt": d.get("last_synced_at"),
        "createdAt": d.get("created_at"),
        "updatedAt": d.get("updated_at"),
        "orgId": d.get("org_id") or "",
        "ownerScopeId": d.get("owner_scope_id") or "",
        "createdBy": d.get("created_by") or "",
        "builtin": str(d.get("id") or "") == "kb_builtin_user_guide"
        or str(d.get("sync_vault_id") or "") == "evoflow-user-guide",
    }


def _row_doc(row: Any) -> dict[str, Any]:
    d = dict(row)
    tags = []
    frontmatter: dict[str, Any] = {}
    try:
        import json

        tags = json.loads(d.get("tags_json") or "[]") or []
        if not isinstance(tags, list):
            tags = []
        frontmatter = json.loads(d.get("frontmatter_json") or "{}") or {}
        if not isinstance(frontmatter, dict):
            frontmatter = {}
    except Exception:
        tags = []
        frontmatter = {}
    return {
        "id": d["id"],
        "kbId": d["kb_id"],
        "title": d.get("title") or "",
        "sourceType": d.get("source_type"),
        "fileName": d.get("file_name") or "",
        "mime": d.get("mime") or "",
        "sizeBytes": d.get("size_bytes") or 0,
        "contentHash": d.get("content_hash") or "",
        "folderPath": d.get("folder_path") or "",
        "sourceRelPath": d.get("source_rel_path") or "",
        "sortOrder": int(d.get("sort_order") or 0),
        "parseStatus": d.get("parse_status"),
        "errorMessage": d.get("error_message") or "",
        "chunkCount": d.get("chunk_count") or 0,
        "summaryStatus": d.get("summary_status"),
        "summaryText": d.get("summary_text") or "",
        "tags": [str(t) for t in tags],
        "frontmatter": frontmatter,
        "latestJobId": d.get("latest_job_id"),
        "createdAt": d.get("created_at"),
        "updatedAt": d.get("updated_at"),
    }


def list_bases(
    *,
    is_admin: bool = False,
    personal_scope: str | None = None,
    org_scope: str | None = None,
    principal: Any = None,
    filter_visibility: bool = False,
) -> list[dict[str, Any]]:
    ensure_owned_kb_worker_started()
    with db() as conn:
        rows = conn.execute(
            "SELECT * FROM kb_bases WHERE deleted_at IS NULL ORDER BY updated_at DESC"
        ).fetchall()
        counts = {
            str(r[0]): int(r[1] or 0)
            for r in conn.execute(
                """
                SELECT kb_id, COUNT(*) FROM kb_documents
                WHERE deleted_at IS NULL
                GROUP BY kb_id
                """
            ).fetchall()
        }
    out: list[dict[str, Any]] = []
    for r in rows:
        item = _row_base(r)
        if filter_visibility and not kb_visible_to_principal(
            str(item["id"]),
            is_admin=is_admin,
            personal_scope=personal_scope,
            org_scope=org_scope,
            principal=principal,
            owner_scope_id=str(item.get("ownerScopeId") or "") or None,
        ):
            continue
        item["documentCount"] = counts.get(str(item["id"]), 0)
        out.append(item)
    return out


def set_kb_owner_scope(
    kb_id: str,
    *,
    org_id: str,
    owner_scope_id: str,
    created_by: str | None = None,
) -> None:
    kid = str(kb_id or "").strip()
    if not kid or not owner_scope_id:
        return
    with db() as conn:
        cols = {str(r[1]) for r in conn.execute("PRAGMA table_info(kb_bases)").fetchall()}
        if "owner_scope_id" not in cols:
            return
        if "created_by" in cols and created_by:
            conn.execute(
                """
                UPDATE kb_bases
                SET org_id = COALESCE(NULLIF(org_id, ''), ?),
                    owner_scope_id = COALESCE(NULLIF(owner_scope_id, ''), ?),
                    created_by = COALESCE(NULLIF(created_by, ''), ?)
                WHERE id = ?
                """,
                (org_id, owner_scope_id, created_by, kid),
            )
        else:
            conn.execute(
                """
                UPDATE kb_bases
                SET org_id = COALESCE(NULLIF(org_id, ''), ?),
                    owner_scope_id = COALESCE(NULLIF(owner_scope_id, ''), ?)
                WHERE id = ?
                """,
                (org_id, owner_scope_id, kid),
            )


def kb_visible_to_principal(
    kb_id: str,
    *,
    is_admin: bool = False,
    personal_scope: str | None = None,
    org_scope: str | None = None,
    principal: Any = None,
    owner_scope_id: str | None = None,
) -> bool:
    from evoflow.authz.resource_visibility import owner_scope_visible_to_principal

    owner = owner_scope_id
    if owner is None:
        with db() as conn:
            cols = {str(r[1]) for r in conn.execute("PRAGMA table_info(kb_bases)").fetchall()}
            if "owner_scope_id" not in cols:
                return is_admin
            row = conn.execute(
                "SELECT owner_scope_id FROM kb_bases WHERE id=? AND deleted_at IS NULL",
                (str(kb_id or "").strip(),),
            ).fetchone()
            if not row:
                return False
            owner = str(row[0] or "").strip() or None
    # Built-in user guide: visible to everyone with a principal (shared product doc).
    if str(kb_id or "") == "kb_builtin_user_guide":
        return True
    return owner_scope_visible_to_principal(
        owner,
        principal,
        is_admin=is_admin,
        personal_scope=personal_scope,
        org_scope=org_scope,
    )

def create_base(payload: dict[str, Any]) -> dict[str, Any]:
    ensure_owned_kb_worker_started()
    kb_id = new_id("kb_")
    now = utc_now()
    name = str(payload.get("name") or "").strip() or "未命名知识库"
    binding = resolve_create_binding(payload)
    mode = str(binding["embedding_mode"])
    model = str(binding["embedding_model"])
    base_url = str(binding.get("embedding_base_url") or "")
    model_ref = str(binding.get("embedding_model_ref") or "")
    key_ref = ""
    api_key = binding.get("embedding_api_key") or ""
    raw_chunk_size = payload.get("chunkSize", payload.get("chunk_size", None))
    chunk_size = 512 if raw_chunk_size is None else _validate_chunk_size(raw_chunk_size)
    raw_chunk_overlap = payload.get("chunkOverlap", payload.get("chunk_overlap", None))
    chunk_overlap = (
        80 if raw_chunk_overlap is None else _validate_chunk_overlap(raw_chunk_overlap, chunk_size=chunk_size)
    )
    # Registry-bound models keep credentials on the models page; only legacy
    # inline keys are stored per-KB.
    if (
        not binding.get("from_registry")
        and api_key
        and str(api_key).strip()
        and mode != "local"
    ):
        from evoflow.knowledge.vault import secrets as vault_secrets

        key_ref = f"owned_{kb_id}_embedding_api_key"
        vault_secrets.put_secret(key_ref, str(api_key).strip())
    with db() as conn:
        conn.execute(
            """
            INSERT INTO kb_bases(
              id, name, description, chunk_size, chunk_overlap, chunk_strategy,
              embedding_mode, embedding_model, embedding_base_url, embedding_api_key_ref,
              embedding_model_ref,
              vector_enabled, keyword_enabled, wiki_enabled, graph_enabled,
              summary_enabled, image_caption_enabled, created_at, updated_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,1,0,0,?,?,?,?)
            """,
            (
                kb_id,
                name,
                str(payload.get("description") or ""),
                chunk_size,
                chunk_overlap,
                str(payload.get("chunkStrategy") or payload.get("chunk_strategy") or "auto"),
                mode,
                model,
                base_url,
                key_ref,
                model_ref,
                1 if payload.get("summaryEnabled", True) else 0,
                1 if payload.get("imageCaptionEnabled") else 0,
                now,
                now,
            ),
        )
    out = get_base(kb_id)  # type: ignore[return-value]
    owned_activity.record(
        kb_id,
        "base.create",
        title=name,
        detail={"name": name},
    )
    return out


def update_base(kb_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Update KB metadata and optionally rebind embedding (triggers full reindex)."""
    ensure_owned_kb_worker_started()
    existing = get_base(kb_id)
    if not existing:
        raise ValueError("knowledge base not found")

    now = utc_now()
    name = payload.get("name")
    description = payload.get("description")
    chunk_size = payload.get("chunkSize", payload.get("chunk_size"))
    chunk_overlap = payload.get("chunkOverlap", payload.get("chunk_overlap"))
    chunk_strategy = payload.get("chunkStrategy", payload.get("chunk_strategy"))
    summary_enabled = payload.get("summaryEnabled", payload.get("summary_enabled"))
    image_caption = payload.get("imageCaptionEnabled", payload.get("image_caption_enabled"))

    embedding_touch = any(
        k in payload
        for k in (
            "embeddingModelRef",
            "embedding_model_ref",
            "embeddingMode",
            "embedding_mode",
            "embeddingModel",
            "embedding_model",
            "embeddingBaseUrl",
            "embedding_base_url",
            "embeddingApiKey",
            "embedding_api_key",
        )
    )

    reindex_doc_ids: list[str] = []
    with db() as conn:
        row = conn.execute(
            "SELECT * FROM kb_bases WHERE id=? AND deleted_at IS NULL", (kb_id,)
        ).fetchone()
        if not row:
            raise ValueError("knowledge base not found")

        sets: list[str] = ["updated_at=?"]
        vals: list[Any] = [now]

        if name is not None:
            sets.append("name=?")
            vals.append(str(name).strip() or existing["name"])
        if description is not None:
            sets.append("description=?")
            vals.append(str(description))
        if chunk_size is not None:
            sets.append("chunk_size=?")
            vals.append(_validate_chunk_size(chunk_size))
        if chunk_overlap is not None:
            effective_size = (
                _validate_chunk_size(chunk_size)
                if chunk_size is not None
                else int(existing.get("chunkSize") or 512)
            )
            sets.append("chunk_overlap=?")
            vals.append(_validate_chunk_overlap(chunk_overlap, chunk_size=effective_size))
        if chunk_strategy is not None:
            sets.append("chunk_strategy=?")
            vals.append(str(chunk_strategy))
        if summary_enabled is not None:
            sets.append("summary_enabled=?")
            vals.append(1 if summary_enabled else 0)
        if image_caption is not None:
            sets.append("image_caption_enabled=?")
            vals.append(1 if image_caption else 0)

        embedding_changed = False
        if embedding_touch:
            binding = resolve_create_binding(payload)
            new_mode = str(binding["embedding_mode"])
            new_model = str(binding["embedding_model"])
            new_base = str(binding.get("embedding_base_url") or "")
            new_ref = str(binding.get("embedding_model_ref") or "")
            old_mode = str(row["embedding_mode"] or "")
            old_model = str(row["embedding_model"] or "")
            old_base = str(row["embedding_base_url"] or "")
            old_ref = str(row["embedding_model_ref"] or "") if "embedding_model_ref" in row.keys() else ""
            embedding_changed = (
                new_mode != old_mode
                or new_model != old_model
                or new_base != old_base
                or new_ref != old_ref
            )
            sets.extend(
                [
                    "embedding_mode=?",
                    "embedding_model=?",
                    "embedding_base_url=?",
                    "embedding_model_ref=?",
                ]
            )
            vals.extend([new_mode, new_model, new_base, new_ref])

            api_key = binding.get("embedding_api_key") or ""
            key_ref = str(row["embedding_api_key_ref"] or "")
            if new_mode == "local" or binding.get("from_registry"):
                if key_ref:
                    try:
                        from evoflow.knowledge.vault import secrets as vault_secrets

                        vault_secrets.delete_secret(key_ref)
                    except Exception:
                        pass
                sets.append("embedding_api_key_ref=?")
                vals.append("")
            elif api_key and str(api_key).strip():
                from evoflow.knowledge.vault import secrets as vault_secrets

                if not key_ref:
                    key_ref = f"owned_{kb_id}_embedding_api_key"
                vault_secrets.put_secret(key_ref, str(api_key).strip())
                sets.append("embedding_api_key_ref=?")
                vals.append(key_ref)

            if embedding_changed:
                sets.append("embedding_dim=?")
                vals.append(None)
                conn.execute("DELETE FROM kb_chunk_embeddings WHERE kb_id=?", (kb_id,))
                doc_rows = conn.execute(
                    """
                    SELECT id FROM kb_documents
                    WHERE kb_id=? AND deleted_at IS NULL
                    """,
                    (kb_id,),
                ).fetchall()
                reindex_doc_ids = [str(r["id"]) for r in doc_rows]
            elif row["embedding_dim"] is None:
                # Same model but never vectorized (or dim cleared) — still enqueue.
                doc_rows = conn.execute(
                    """
                    SELECT id FROM kb_documents
                    WHERE kb_id=? AND deleted_at IS NULL
                    """,
                    (kb_id,),
                ).fetchall()
                reindex_doc_ids = [str(r["id"]) for r in doc_rows]

        vals.append(kb_id)
        conn.execute(
            f"UPDATE kb_bases SET {', '.join(sets)} WHERE id=?",
            tuple(vals),
        )

    for doc_id in reindex_doc_ids:
        try:
            jobs.enqueue(kb_id=kb_id, doc_id=doc_id, type="reindex", priority=80)
        except Exception:
            logger.debug("reindex enqueue failed for %s", doc_id, exc_info=True)

    out = get_base(kb_id)
    if out is None:
        raise ValueError("knowledge base not found")
    if reindex_doc_ids:
        out = {**out, "reindexQueued": len(reindex_doc_ids)}
    return out


def reindex_base(
    kb_id: str,
    *,
    embedding_model_ref: str | None = None,
    force: bool = True,
) -> dict[str, Any]:
    """Enqueue full-base vector rebuild; optionally rebind embedding first.

    Use when a KB already exists but ``embedding_dim`` is null / vectors missing,
    or the user wants to rebuild with the current (or a new) Agent Plan embedding.
    """
    ensure_owned_kb_worker_started()
    existing = get_base(kb_id)
    if not existing:
        raise ValueError("knowledge base not found")

    ref = str(embedding_model_ref or "").strip()
    if ref:
        # Rebind then rebuild (update_base clears vectors when model changes,
        # and also queues when dim is still null).
        return update_base(kb_id, {"embeddingModelRef": ref})

    now = utc_now()
    reindex_doc_ids: list[str] = []
    with db() as conn:
        row = conn.execute(
            "SELECT id, embedding_dim FROM kb_bases WHERE id=? AND deleted_at IS NULL",
            (kb_id,),
        ).fetchone()
        if not row:
            raise ValueError("knowledge base not found")
        if force or row["embedding_dim"] is None:
            conn.execute("DELETE FROM kb_chunk_embeddings WHERE kb_id=?", (kb_id,))
            conn.execute(
                "UPDATE kb_bases SET embedding_dim=?, updated_at=? WHERE id=?",
                (None, now, kb_id),
            )
            conn.execute(
                """
                UPDATE kb_documents
                SET parse_status='pending', error_message='', updated_at=?
                WHERE kb_id=? AND deleted_at IS NULL
                """,
                (now, kb_id),
            )
        doc_rows = conn.execute(
            """
            SELECT id FROM kb_documents
            WHERE kb_id=? AND deleted_at IS NULL
            """,
            (kb_id,),
        ).fetchall()
        reindex_doc_ids = [str(r["id"]) for r in doc_rows]

    for doc_id in reindex_doc_ids:
        try:
            jobs.enqueue(kb_id=kb_id, doc_id=doc_id, type="reindex", priority=80)
        except Exception:
            logger.debug("reindex enqueue failed for %s", doc_id, exc_info=True)

    out = get_base(kb_id)
    if out is None:
        raise ValueError("knowledge base not found")
    return {**out, "reindexQueued": len(reindex_doc_ids)}


def requeue_orphan_parse_docs(
    kb_id: str | None = None,
    *,
    limit: int = 200,
    include_failed: bool = True,
) -> dict[str, Any]:
    """Re-enqueue parse_index for docs stuck without an active job.

    Typical after worker crash, gateway restart mid-embed, or deleting the only
    completed duplicate while leaving a processing shell behind.
    """
    ensure_owned_kb_worker_started()
    jobs.reclaim_stale_running()
    statuses = ("pending", "processing", "failed") if include_failed else ("pending", "processing")
    orphans = jobs.list_orphan_parse_docs(kb_id, limit=limit, statuses=statuses)
    queued = 0
    now = utc_now()
    for row in orphans:
        doc_id = str(row.get("doc_id") or "").strip()
        kid = str(row.get("kb_id") or "").strip()
        if not doc_id or not kid:
            continue
        with db() as conn:
            conn.execute(
                """
                UPDATE kb_documents
                SET parse_status='pending', error_message='', updated_at=?
                WHERE id=? AND deleted_at IS NULL
                """,
                (now, doc_id),
            )
        try:
            jobs.enqueue(kb_id=kid, doc_id=doc_id, type="parse_index", priority=90)
            queued += 1
        except Exception:
            logger.debug("orphan requeue failed for %s", doc_id, exc_info=True)
    return {
        "ok": True,
        "orphanCount": len(orphans),
        "requeued": queued,
        "kbId": kb_id,
    }


def get_base(kb_id: str) -> dict[str, Any] | None:
    with db() as conn:
        row = conn.execute(
            "SELECT * FROM kb_bases WHERE id=? AND deleted_at IS NULL", (kb_id,)
        ).fetchone()
    return _row_base(row) if row else None


def delete_base(kb_id: str) -> None:
    from evoflow.knowledge.owned.builtin_seed import is_builtin_owned_kb_id

    if is_builtin_owned_kb_id(kb_id):
        raise ValueError("系统内置知识库不可删除，可在库设置中停用或忽略")
    now = utc_now()
    base = get_base(kb_id)
    name = (base or {}).get("name") or kb_id
    with db() as conn:
        row = conn.execute(
            "SELECT embedding_api_key_ref FROM kb_bases WHERE id=?", (kb_id,)
        ).fetchone()
        conn.execute(
            "UPDATE kb_bases SET deleted_at=?, updated_at=? WHERE id=?",
            (now, now, kb_id),
        )
    if row:
        ref = str(row["embedding_api_key_ref"] or "")
        if ref:
            try:
                from evoflow.knowledge.vault import secrets as vault_secrets

                vault_secrets.delete_secret(ref)
            except Exception:
                pass
    blob_store.delete_kb_blobs(kb_id)
    owned_activity.record(kb_id, "base.delete", title=str(name), detail={"name": name})


def list_documents(kb_id: str) -> list[dict[str, Any]]:
    with db() as conn:
        rows = conn.execute(
            """
            SELECT * FROM kb_documents
            WHERE kb_id=? AND deleted_at IS NULL
            ORDER BY folder_path ASC, sort_order ASC, file_name ASC
            """,
            (kb_id,),
        ).fetchall()
    return [_row_doc(r) for r in rows]


def _norm_folder_path(path: str | None) -> str:
    return str(path or "").replace("\\", "/").strip().strip("/")


def _resolve_folder_path(path: str | None) -> str:
    folder = _norm_folder_path(path)
    if folder and any(part in (".", "..") or not part.strip() for part in folder.split("/")):
        raise ValueError("invalid folder path")
    return folder


def list_folders(kb_id: str) -> list[dict[str, Any]]:
    """Explicit empty folders + distinct folder_path prefixes from documents."""
    with db() as conn:
        rows = conn.execute(
            "SELECT path, created_at, updated_at FROM kb_folders WHERE kb_id=? ORDER BY path",
            (kb_id,),
        ).fetchall()
        doc_paths = conn.execute(
            """
            SELECT DISTINCT folder_path FROM kb_documents
            WHERE kb_id=? AND deleted_at IS NULL AND folder_path != ''
            """,
            (kb_id,),
        ).fetchall()
    paths: set[str] = set()
    explicit: dict[str, dict[str, Any]] = {}
    for r in rows:
        p = _norm_folder_path(r["path"])
        if not p:
            continue
        paths.add(p)
        explicit[p] = {
            "path": p,
            "name": p.split("/")[-1],
            "explicit": True,
            "createdAt": r["created_at"],
            "updatedAt": r["updated_at"],
        }
    for r in doc_paths:
        raw = _norm_folder_path(r["folder_path"])
        if not raw:
            continue
        parts = raw.split("/")
        acc = ""
        for part in parts:
            acc = f"{acc}/{part}" if acc else part
            paths.add(acc)
    out: list[dict[str, Any]] = []
    for p in sorted(paths):
        if p in explicit:
            out.append(explicit[p])
        else:
            out.append({"path": p, "name": p.split("/")[-1], "explicit": False})
    return out


def create_folder(kb_id: str, path: str) -> dict[str, Any]:
    if not get_base(kb_id):
        raise ValueError("knowledge base not found")
    folder = _resolve_folder_path(path)
    if not folder:
        raise ValueError("folder path required")
    now = utc_now()
    fid = new_id("fld_")
    with db() as conn:
        existing = conn.execute(
            "SELECT path FROM kb_folders WHERE kb_id=? AND path=?",
            (kb_id, folder),
        ).fetchone()
        if existing:
            return {"path": folder, "name": folder.split("/")[-1], "explicit": True, "created": False}
        # ensure parents exist as explicit rows too
        parts = folder.split("/")
        acc = ""
        for part in parts:
            acc = f"{acc}/{part}" if acc else part
            conn.execute(
                """
                INSERT OR IGNORE INTO kb_folders(id, kb_id, path, created_at, updated_at)
                VALUES (?,?,?,?,?)
                """,
                (new_id("fld_") if acc != folder else fid, kb_id, acc, now, now),
            )
    out = {"path": folder, "name": folder.split("/")[-1], "explicit": True, "created": True}
    owned_activity.record(
        kb_id,
        "folder.create",
        title=folder,
        detail={"path": folder},
    )
    return out


def rename_folder(
    kb_id: str,
    from_path: str,
    to_path: str,
    *,
    record_activity: bool = True,
) -> dict[str, Any]:
    if not get_base(kb_id):
        raise ValueError("knowledge base not found")
    src = _norm_folder_path(from_path)
    dst = _norm_folder_path(to_path)
    if not src or not dst:
        raise ValueError("fromPath and toPath required")
    if src == dst:
        return {"fromPath": src, "toPath": dst, "movedDocs": 0}
    if dst == src or dst.startswith(src + "/"):
        raise ValueError("cannot rename folder into its own child")
    now = utc_now()
    moved = 0
    with db() as conn:
        rows = conn.execute(
            """
            SELECT id, folder_path FROM kb_documents
            WHERE kb_id=? AND deleted_at IS NULL
              AND (folder_path=? OR folder_path LIKE ?)
            """,
            (kb_id, src, f"{src}/%"),
        ).fetchall()
        for r in rows:
            old = _norm_folder_path(r["folder_path"])
            new = dst if old == src else dst + old[len(src) :]
            conn.execute(
                "UPDATE kb_documents SET folder_path=?, updated_at=? WHERE id=?",
                (new, now, r["id"]),
            )
            moved += 1
        folds = conn.execute(
            """
            SELECT path FROM kb_folders
            WHERE kb_id=? AND (path=? OR path LIKE ?)
            """,
            (kb_id, src, f"{src}/%"),
        ).fetchall()
        old_paths = [_norm_folder_path(r["path"]) for r in folds]
        conn.execute(
            "DELETE FROM kb_folders WHERE kb_id=? AND (path=? OR path LIKE ?)",
            (kb_id, src, f"{src}/%"),
        )
        new_paths = set()
        if not old_paths:
            new_paths.add(dst)
        for old in old_paths:
            new = dst if old == src else dst + old[len(src) :]
            new_paths.add(new)
        # also ensure parent chain for dst
        parts = dst.split("/")
        acc = ""
        for part in parts:
            acc = f"{acc}/{part}" if acc else part
            new_paths.add(acc)
        for p in sorted(new_paths):
            conn.execute(
                """
                INSERT OR IGNORE INTO kb_folders(id, kb_id, path, created_at, updated_at)
                VALUES (?,?,?,?,?)
                """,
                (new_id("fld_"), kb_id, p, now, now),
            )
    if record_activity:
        owned_activity.record(
            kb_id,
            "folder.rename",
            title=f"{src} → {dst}",
            detail={"fromPath": src, "toPath": dst, "movedDocs": moved},
        )
    return {"fromPath": src, "toPath": dst, "movedDocs": moved}


def move_folder(kb_id: str, from_path: str, parent_path: str = "") -> dict[str, Any]:
    """Move folder under a new parent (keep leaf name). parent_path='' → root."""
    src = _norm_folder_path(from_path)
    parent = _norm_folder_path(parent_path)
    if not src:
        raise ValueError("fromPath required")
    leaf = src.split("/")[-1]
    if parent == src or parent.startswith(src + "/"):
        raise ValueError("cannot move folder into itself or its child")
    dst = f"{parent}/{leaf}" if parent else leaf
    if dst == src:
        return {"fromPath": src, "toPath": dst, "movedDocs": 0, "unchanged": True}
    out = rename_folder(kb_id, src, dst, record_activity=False)
    owned_activity.record(
        kb_id,
        "folder.move",
        title=f"{src} → {dst}",
        detail={"fromPath": src, "toPath": dst, "parentPath": parent, "movedDocs": out.get("movedDocs")},
    )
    out["parentPath"] = parent
    return out


def delete_folder(
    kb_id: str,
    path: str,
    *,
    mode: str = "move_up",
) -> dict[str, Any]:
    """Delete folder metadata; docs either move to parent (default) or soft-delete."""
    if not get_base(kb_id):
        raise ValueError("knowledge base not found")
    folder = _norm_folder_path(path)
    if not folder:
        raise ValueError("folder path required")
    mode = (mode or "move_up").lower()
    if mode not in ("move_up", "delete_docs"):
        raise ValueError("mode must be move_up or delete_docs")
    parent = "/".join(folder.split("/")[:-1])
    now = utc_now()
    affected = 0
    with db() as conn:
        rows = conn.execute(
            """
            SELECT id, folder_path FROM kb_documents
            WHERE kb_id=? AND deleted_at IS NULL
              AND (folder_path=? OR folder_path LIKE ?)
            """,
            (kb_id, folder, f"{folder}/%"),
        ).fetchall()
        for r in rows:
            old = _norm_folder_path(r["folder_path"])
            if mode == "delete_docs":
                conn.execute(
                    "UPDATE kb_documents SET deleted_at=?, updated_at=? WHERE id=?",
                    (now, now, r["id"]),
                )
            else:
                if old == folder:
                    new = parent
                else:
                    rest = old[len(folder) :].lstrip("/")
                    new = f"{parent}/{rest}" if parent and rest else (rest or parent)
                conn.execute(
                    "UPDATE kb_documents SET folder_path=?, updated_at=? WHERE id=?",
                    (_norm_folder_path(new), now, r["id"]),
                )
            affected += 1
        conn.execute(
            "DELETE FROM kb_folders WHERE kb_id=? AND (path=? OR path LIKE ?)",
            (kb_id, folder, f"{folder}/%"),
        )
    owned_activity.record(
        kb_id,
        "folder.delete",
        title=folder,
        detail={"path": folder, "mode": mode, "affectedDocs": affected},
    )
    return {"path": folder, "mode": mode, "affectedDocs": affected}


def move_document(
    doc_id: str,
    folder_path: str | None = None,
    *,
    before_doc_id: str | None = None,
    sort_order: int | None = None,
) -> dict[str, Any]:
    """Move a document into a folder; optionally insert before a sibling (drag reorder)."""
    doc = get_document(doc_id)
    if not doc:
        raise ValueError("document not found")
    kb_id = doc["kbId"]
    now = utc_now()
    with db() as conn:
        folder = _resolve_folder_path(folder_path if folder_path is not None else doc.get("folderPath"))
        target_order = sort_order

        if before_doc_id:
            if before_doc_id == doc_id:
                return doc
            before = conn.execute(
                """
                SELECT id, folder_path, sort_order FROM kb_documents
                WHERE id=? AND kb_id=? AND deleted_at IS NULL
                """,
                (before_doc_id, kb_id),
            ).fetchone()
            if not before:
                raise ValueError("before document not found")
            folder = _norm_folder_path(before["folder_path"])
            target_order = int(before["sort_order"] or 0)
            conn.execute(
                """
                UPDATE kb_documents
                SET sort_order = sort_order + 1, updated_at=?
                WHERE kb_id=? AND deleted_at IS NULL AND folder_path=? AND sort_order >= ?
                  AND id != ?
                """,
                (now, kb_id, folder, target_order, doc_id),
            )

        if folder:
            parts = folder.split("/")
            acc = ""
            for part in parts:
                acc = f"{acc}/{part}" if acc else part
                conn.execute(
                    """
                    INSERT OR IGNORE INTO kb_folders(id, kb_id, path, created_at, updated_at)
                    VALUES (?,?,?,?,?)
                    """,
                    (new_id("fld_"), kb_id, acc, now, now),
                )

        if target_order is None:
            row = conn.execute(
                """
                SELECT COALESCE(MAX(sort_order), -1) AS m FROM kb_documents
                WHERE kb_id=? AND deleted_at IS NULL AND folder_path=? AND id != ?
                """,
                (kb_id, folder, doc_id),
            ).fetchone()
            target_order = int(row["m"] if row else -1) + 1

        conn.execute(
            """
            UPDATE kb_documents
            SET folder_path=?, sort_order=?, updated_at=?
            WHERE id=?
            """,
            (folder, int(target_order), now, doc_id),
        )
    out = get_document(doc_id) or {}
    owned_activity.record(
        kb_id,
        "doc.move",
        doc_id=doc_id,
        title=str(out.get("title") or out.get("fileName") or doc_id),
        detail={"folderPath": folder, "beforeDocId": before_doc_id or ""},
    )
    return out


def get_document(doc_id: str) -> dict[str, Any] | None:
    with db() as conn:
        row = conn.execute(
            "SELECT * FROM kb_documents WHERE id=? AND deleted_at IS NULL", (doc_id,)
        ).fetchone()
    return _row_doc(row) if row else None


def resolve_document(kb_id: str, key: str) -> dict[str, Any] | None:
    """Resolve by doc id, file name, folder/file path, or exact title."""
    key = str(key or "").strip()
    if not key:
        return None
    doc = get_document(key)
    if doc and doc.get("kbId") == kb_id:
        return doc
    with db() as conn:
        rows = conn.execute(
            """
            SELECT * FROM kb_documents
            WHERE kb_id=? AND deleted_at IS NULL
            """,
            (kb_id,),
        ).fetchall()
    for row in rows:
        d = _row_doc(row)
        path = (d.get("folderPath") and f'{d["folderPath"]}/{d["fileName"]}') or d.get("fileName") or ""
        if key in (d.get("fileName"), path, d.get("title")):
            return d
        if path.endswith("/" + key) or path == key:
            return d
    return None


def get_document_text(doc_id: str, *, max_chars: int = 12000) -> str:
    """Reconstruct document text from indexed chunks (preferred) or empty."""
    chunks = list_chunks(doc_id)
    if not chunks:
        doc = get_document(doc_id)
        return str((doc or {}).get("summaryText") or "")
    parts = []
    total = 0
    cap = max(500, int(max_chars or 12000))
    for c in chunks:
        if not c.get("enabled", True):
            continue
        piece = str(c.get("content") or "")
        if not piece:
            continue
        if total + len(piece) > cap:
            parts.append(piece[: max(0, cap - total)])
            break
        parts.append(piece)
        total += len(piece)
    return "\n\n".join(parts)


_TEXT_SUFFIXES = {
    ".md",
    ".markdown",
    ".mdx",
    ".txt",
    ".log",
    ".csv",
    ".json",
    ".yaml",
    ".yml",
    ".toml",
    ".xml",
    ".html",
    ".htm",
    ".py",
    ".js",
    ".ts",
    ".java",
    ".go",
    ".rs",
    ".c",
    ".cpp",
    ".h",
    ".ini",
    ".cfg",
}


def get_document_content(doc_id: str, *, max_chars: int = 500_000) -> dict[str, Any] | None:
    """Return viewable content for panel: raw text blob when possible, else parsed chunks.

    Lexiang opens `/pages/{id}` with the document body; we mirror that with
    ``source=raw`` (original text files) or ``source=parsed`` (PDF/Office via pipeline).
    """
    with db() as conn:
        row = conn.execute(
            "SELECT * FROM kb_documents WHERE id=? AND deleted_at IS NULL", (doc_id,)
        ).fetchone()
    if not row:
        return None
    doc = _row_doc(row)
    blob_path = str(row["blob_path"] or "")
    file_name = str(doc.get("fileName") or "")
    suffix = Path(file_name).suffix.lower()
    cap = max(1000, int(max_chars or 500_000))
    content = ""
    source = "empty"
    truncated = False

    if blob_path and suffix in _TEXT_SUFFIXES:
        try:
            path = blob_store.resolve_blob(blob_path)
            if path.is_file():
                raw = path.read_bytes()
                for enc in ("utf-8", "utf-8-sig", "gb18030", "latin-1"):
                    try:
                        content = raw.decode(enc)
                        break
                    except UnicodeDecodeError:
                        continue
                else:
                    content = raw.decode("utf-8", errors="replace")
                source = "raw"
        except Exception:
            content = ""

    if not content.strip():
        # PDF / Office / failed raw: show pipeline Markdown from chunks (no char cap for UI;
        # still guard with max_chars).
        chunks = list_chunks(doc_id)
        if chunks:
            parts = [str(c.get("content") or "") for c in chunks if c.get("enabled", True)]
            content = "\n\n".join(p for p in parts if p)
            source = "parsed"
        elif doc.get("summaryText"):
            content = str(doc["summaryText"])
            source = "summary"

    if len(content) > cap:
        content = content[:cap]
        truncated = True

    return {
        **doc,
        "content": content,
        "source": source,  # raw | parsed | summary | empty
        "truncated": truncated,
        "blobPath": blob_path,
    }


def resolve_document_file(doc_id: str) -> dict[str, Any] | None:
    """Resolve original blob path + Content-Type for panel file preview (PDF etc.)."""
    with db() as conn:
        row = conn.execute(
            "SELECT * FROM kb_documents WHERE id=? AND deleted_at IS NULL", (doc_id,)
        ).fetchone()
    if not row:
        return None
    blob_path = str(row["blob_path"] or "")
    if not blob_path:
        return None
    try:
        path = blob_store.resolve_blob(blob_path)
    except ValueError:
        return None
    if not path.is_file():
        return None
    file_name = str(row["file_name"] or path.name)
    mime = str(row["mime"] or "") or (mimetypes.guess_type(file_name)[0] or "")
    suffix = Path(file_name).suffix.lower()
    if not mime or mime == "application/octet-stream":
        mime_map = {
            ".pdf": "application/pdf",
            ".md": "text/markdown; charset=utf-8",
            ".txt": "text/plain; charset=utf-8",
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".gif": "image/gif",
            ".webp": "image/webp",
        }
        mime = mime_map.get(suffix, "application/octet-stream")
    return {
        "path": path,
        "mediaType": mime,
        "fileName": file_name,
        "docId": doc_id,
        "kbId": row["kb_id"],
    }


def enqueue_document_summary(doc_id: str, *, force: bool = False) -> dict[str, Any]:
    """Enqueue ``summary_doc`` job; optionally force rebuild when summary already exists."""
    ensure_owned_kb_worker_started()
    doc = get_document(doc_id)
    if not doc:
        raise ValueError("document not found")
    base = get_base(doc["kbId"])
    if not base:
        raise ValueError("knowledge base not found")
    if not base.get("summaryEnabled", True):
        raise ValueError("summary disabled for this knowledge base")
    status = str(doc.get("summaryStatus") or "")
    has_text = bool(str(doc.get("summaryText") or "").strip())
    if status == "processing" and not force:
        return {"ok": True, "jobId": doc.get("latestJobId"), "status": status, "queued": False}
    if has_text and not force:
        return {
            "ok": True,
            "jobId": None,
            "status": status or "completed",
            "queued": False,
            "summaryText": doc.get("summaryText") or "",
        }
    now = utc_now()
    with db() as conn:
        if force:
            conn.execute(
                """
                UPDATE kb_documents
                SET summary_status='pending', summary_text='', updated_at=?
                WHERE id=?
                """,
                (now, doc_id),
            )
        else:
            conn.execute(
                "UPDATE kb_documents SET summary_status='pending', updated_at=? WHERE id=?",
                (now, doc_id),
            )
    job = jobs.enqueue(
        kb_id=doc["kbId"],
        doc_id=doc_id,
        type="summary_doc",
        priority=150,
        payload={"force": bool(force)},
    )
    owned_activity.record(
        doc["kbId"],
        "summary.generate",
        doc_id=doc_id,
        title=str(doc.get("title") or doc.get("fileName") or doc_id),
        detail={"force": bool(force)},
    )
    return {"ok": True, "jobId": job["id"], "status": "pending", "queued": True, "job": job}


async def ask(
    kb_id: str,
    query: str,
    *,
    doc_id: str | None = None,
    top_k: int = 6,
) -> dict[str, Any]:
    """One-shot RAG Q&A over an owned base; returns answer + citations (non-streaming)."""
    ensure_owned_kb_worker_started()
    q = (query or "").strip()
    if not q:
        raise ValueError("query required")
    if not get_base(kb_id):
        raise ValueError("knowledge base not found")
    k = max(1, min(int(top_k or 6), 20))
    fetch_k = max(k * 2, 12) if doc_id else k

    result = await search(kb_id, q, mode="hybrid", top_k=fetch_k, record_activity=False)
    items = list(result.get("items") or [])
    degraded = bool(result.get("degraded"))

    # Hybrid can return empty when vectors are cold; keyword still powers Ask AI.
    if not items:
        result = await search(kb_id, q, mode="keyword", top_k=fetch_k, record_activity=False)
        items = list(result.get("items") or [])
        degraded = True

    preferred: list[dict[str, Any]] = []
    rest: list[dict[str, Any]] = []
    if doc_id:
        for it in items:
            if it.get("docId") == doc_id:
                preferred.append(it)
            else:
                rest.append(it)
        # If current-doc filter yields nothing, pull keyword hits for that doc only.
        if not preferred:
            scoped = await search(kb_id, q, mode="keyword", top_k=max(fetch_k, 20))
            for it in scoped.get("items") or []:
                if it.get("docId") == doc_id:
                    preferred.append(it)
            if scoped.get("degraded"):
                degraded = True
        items = (preferred + rest)[:k]
    else:
        items = items[:k]

    citations = [
        {
            "docId": it.get("docId"),
            "title": it.get("title") or it.get("fileName") or "",
            "chunkId": it.get("chunkId"),
            "snippet": (str(it.get("content") or "")[:280]).strip(),
        }
        for it in items
        if it.get("chunkId")
    ]

    if not items:
        return {
            "answer": "知识库中未检索到与问题相关的内容，请换个问法或先完成文档索引。",
            "citations": [],
            "degraded": degraded,
            "mode": result.get("mode") or "hybrid",
        }

    ctx_parts: list[str] = []
    for i, it in enumerate(items, start=1):
        title = it.get("title") or it.get("fileName") or "文档"
        header = it.get("contextHeader") or ""
        body = str(it.get("content") or "").strip()
        if len(body) > 1200:
            body = body[:1199] + "…"
        block = f"[{i}] 标题：{title}"
        if header:
            block += f"\n章节：{header}"
        block += f"\n{body}"
        ctx_parts.append(block)
    context = "\n\n---\n\n".join(ctx_parts)
    focus = ""
    if doc_id:
        doc = get_document(doc_id)
        if doc:
            focus = f"用户当前正在阅读「{doc.get('title') or doc.get('fileName') or doc_id}」，请优先依据该文档作答；不足时再引用其它片段。\n\n"

    prompt = (
        "你是企业知识库助手。仅根据下列检索片段回答用户问题，使用简洁中文。"
        "禁止臆造片段中未出现的事实；若信息不足请明确说明。"
        "回答末尾用「引用：」列出用到的编号（如 [1][3]）。\n\n"
        f"{focus}"
        f"问题：{q}\n\n"
        f"检索片段：\n{context}"
    )

    answer = ""
    try:
        from evoflow.context.internal_model_invoke import ainvoke_internal_chat_model
        from evoflow.models import create_chat_model

        model = create_chat_model(thinking_enabled=False, invocation_kind="kb_ask")
        resp = await ainvoke_internal_chat_model(model, [{"role": "user", "content": prompt}])
        answer = str(getattr(resp, "content", "") or resp).strip()
    except Exception as exc:
        degraded = True
        logger.info("owned ask LLM failed, falling back to snippets: %s", exc)
        lines = ["（模型暂不可用，以下为相关片段摘录）", ""]
        for i, it in enumerate(items[:3], start=1):
            title = it.get("title") or it.get("fileName") or "文档"
            snip = (str(it.get("content") or "")[:200]).strip()
            lines.append(f"[{i}] {title}：{snip}")
        answer = "\n".join(lines)

    if not answer:
        answer = "未能生成回答，请稍后重试。"

    owned_activity.record(
        kb_id,
        "ask",
        doc_id=doc_id,
        title=_preview_title(q),
        detail={"query": q, "citationCount": len(citations), "degraded": degraded},
    )
    return {
        "answer": answer,
        "citations": citations,
        "degraded": degraded,
        "mode": result.get("mode") or "hybrid",
    }


def _preview_title(text: str, limit: int = 48) -> str:
    s = " ".join(str(text or "").split())
    return s if len(s) <= limit else s[: limit - 1] + "…"


def _create_doc_record(
    *,
    kb_id: str,
    title: str,
    file_name: str,
    folder_path: str,
    source_type: str,
    data: bytes | None = None,
    src_path: Path | None = None,
) -> dict[str, Any]:
    if not get_base(kb_id):
        raise ValueError("knowledge base not found")
    doc_id = new_id("doc_")
    now = utc_now()
    if data is not None:
        if len(data) > MAX_FILE_BYTES:
            raise ValueError(f"file too large (max {MAX_FILE_BYTES} bytes)")
        import hashlib

        digest = hashlib.sha256(data).hexdigest()
        blob_path = blob_store.put_bytes(kb_id, doc_id, file_name, data)
        size = len(data)
    elif src_path is not None:
        blob_path, size, digest = blob_store.put_file(kb_id, doc_id, src_path, file_name)
    else:
        raise ValueError("no file content")

    folder = _resolve_folder_path(folder_path)
    rel = f"{folder}/{file_name}".strip("/") if folder else file_name
    mime = mimetypes.guess_type(file_name)[0] or "application/octet-stream"
    with db() as conn:
        conn.execute(
            """
            INSERT INTO kb_documents(
              id, kb_id, title, source_type, file_name, mime, size_bytes, content_hash,
              blob_path, folder_path, source_rel_path, parse_status, created_at, updated_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)
            """,
            (
                doc_id,
                kb_id,
                title or Path(file_name).stem,
                source_type,
                file_name,
                mime,
                size,
                digest,
                blob_path,
                folder,
                rel,
                now,
                now,
            ),
        )
    job = jobs.enqueue(kb_id=kb_id, doc_id=doc_id, type="parse_index", priority=100)
    ensure_owned_kb_worker_started()
    doc = get_document(doc_id) or {}
    doc["job"] = job
    return doc


def _find_doc_by_rel_path(kb_id: str, folder_path: str, file_name: str) -> dict[str, Any] | None:
    folder = folder_path.replace("\\", "/").strip("/")
    with db() as conn:
        row = conn.execute(
            """
            SELECT * FROM kb_documents
            WHERE kb_id=? AND deleted_at IS NULL AND folder_path=? AND file_name=?
            ORDER BY updated_at DESC LIMIT 1
            """,
            (kb_id, folder, file_name),
        ).fetchone()
    return dict(row) if row else None


def _update_doc_from_file(
    *,
    existing: dict[str, Any],
    src_path: Path,
    source_type: str,
) -> dict[str, Any]:
    """Replace blob when content hash changed; re-enqueue parse_index."""
    import hashlib

    doc_id = existing["id"]
    kb_id = existing["kb_id"]
    file_name = str(existing.get("file_name") or src_path.name)
    data = src_path.read_bytes()
    if len(data) > MAX_FILE_BYTES:
        raise ValueError(f"file too large (max {MAX_FILE_BYTES} bytes)")
    digest = hashlib.sha256(data).hexdigest()
    if digest and digest == str(existing.get("content_hash") or ""):
        doc = get_document(doc_id) or _row_doc(existing)
        doc["syncStatus"] = "unchanged"
        return doc

    blob_path = blob_store.put_bytes(kb_id, doc_id, file_name, data)
    now = utc_now()
    mime = mimetypes.guess_type(file_name)[0] or "application/octet-stream"
    with db() as conn:
        conn.execute(
            """
            UPDATE kb_documents SET
              size_bytes=?, content_hash=?, blob_path=?, mime=?,
              source_type=?, parse_status='pending', error_message='',
              updated_at=?
            WHERE id=?
            """,
            (len(data), digest, blob_path, mime, source_type, now, doc_id),
        )
    job = jobs.enqueue(kb_id=kb_id, doc_id=doc_id, type="parse_index", priority=100)
    ensure_owned_kb_worker_started()
    doc = get_document(doc_id) or {}
    doc["job"] = job
    doc["syncStatus"] = "updated"
    return doc


def upload_bytes(
    kb_id: str,
    *,
    file_name: str,
    data: bytes,
    folder_path: str = "",
    title: str = "",
) -> dict[str, Any]:
    if not is_supported_file(file_name):
        raise ValueError(f"unsupported file type: {file_name}")
    doc = _create_doc_record(
        kb_id=kb_id,
        title=title,
        file_name=Path(file_name).name,
        folder_path=folder_path,
        source_type="upload",
        data=data,
    )
    owned_activity.record(
        kb_id,
        "doc.upload",
        doc_id=doc.get("id"),
        title=str(doc.get("title") or file_name),
        detail={"fileName": Path(file_name).name},
    )
    return doc


def upload_manual_markdown(kb_id: str, *, title: str, content: str, folder_path: str = "") -> dict[str, Any]:
    name = f"{(title or 'note').strip() or 'note'}.md"
    data = (content or "").encode("utf-8")
    doc = _create_doc_record(
        kb_id=kb_id,
        title=title or "note",
        file_name=name,
        folder_path=folder_path,
        source_type="manual",
        data=data,
    )
    owned_activity.record(
        kb_id,
        "doc.manual",
        doc_id=doc.get("id"),
        title=str(doc.get("title") or name),
        detail={"fileName": name},
    )
    return doc


def replace_document_content(doc_id: str, content: str, *, title: str | None = None) -> dict[str, Any]:
    """Overwrite a document's blob and re-enqueue parse_index (owned write/append)."""
    doc = get_document(doc_id)
    if not doc:
        raise ValueError("document not found")
    kb_id = doc["kbId"]
    data = str(content or "").encode("utf-8")
    if len(data) > MAX_FILE_BYTES:
        raise ValueError(f"file too large (max {MAX_FILE_BYTES} bytes)")
    import hashlib

    digest = hashlib.sha256(data).hexdigest()
    file_name = doc.get("fileName") or f"{Path(title or doc.get('title') or 'note').stem}.md"
    blob_path = blob_store.put_bytes(kb_id, doc_id, file_name, data)
    now = utc_now()
    with db() as conn:
        conn.execute(
            """
            UPDATE kb_documents SET
              title=COALESCE(?, title),
              file_name=?,
              size_bytes=?,
              content_hash=?,
              blob_path=?,
              parse_status='pending',
              error_message='',
              updated_at=?
            WHERE id=?
            """,
            (
                title.strip() if title and str(title).strip() else None,
                file_name,
                len(data),
                digest,
                blob_path,
                now,
                doc_id,
            ),
        )
    job = jobs.enqueue(kb_id=kb_id, doc_id=doc_id, type="parse_index", priority=100)
    ensure_owned_kb_worker_started()
    out = get_document(doc_id) or {}
    out["job"] = job
    owned_activity.record(
        kb_id,
        "doc.save",
        doc_id=doc_id,
        title=str(out.get("title") or out.get("fileName") or doc_id),
    )
    return out


def append_document_content(doc_id: str, content: str, *, section: str | None = None) -> dict[str, Any]:
    existing = ""
    with db() as conn:
        row = conn.execute(
            "SELECT blob_path FROM kb_documents WHERE id=? AND deleted_at IS NULL", (doc_id,)
        ).fetchone()
    if row and row["blob_path"]:
        try:
            path = blob_store.resolve_blob(row["blob_path"])
            if path.is_file():
                existing = path.read_text(encoding="utf-8", errors="replace")
        except Exception:
            existing = get_document_text(doc_id, max_chars=500_000)
    else:
        existing = get_document_text(doc_id, max_chars=500_000)
    addition = str(content or "")
    if section and str(section).strip():
        addition = f"\n\n## {str(section).strip()}\n\n{addition}"
    else:
        addition = f"\n\n{addition}" if existing.strip() else addition
    return replace_document_content(doc_id, existing + addition)


def remember_sync_source(
    kb_id: str,
    *,
    source_type: str,
    source_path: str = "",
    vault_id: str = "",
) -> None:
    with db() as conn:
        conn.execute(
            """
            UPDATE kb_bases SET
              sync_source_type=?, sync_source_path=?, sync_vault_id=?,
              last_synced_at=?, updated_at=?
            WHERE id=?
            """,
            (
                str(source_type or ""),
                str(source_path or ""),
                str(vault_id or ""),
                utc_now(),
                utc_now(),
                kb_id,
            ),
        )


def import_local_folder(
    kb_id: str,
    root: str | Path,
    *,
    upsert: bool = True,
    prune_missing: bool = False,
    folder_prefix: str = "",
    remember_source: bool = True,
    activity_action: str | None = "import.folder",
) -> dict[str, Any]:
    """Copy supported files from a local folder into the owned KB.

    When upsert=True (default), same folder_path+file_name is updated only if
    content hash changed; unchanged files are skipped without re-index.
    ``folder_prefix`` nests imported paths under a virtual root folder.
    """
    root_path = Path(root).expanduser().resolve()
    if not root_path.is_dir():
        raise ValueError("folder does not exist")
    prefix = _resolve_folder_path(folder_prefix)
    created: list[dict[str, Any]] = []
    updated: list[dict[str, Any]] = []
    unchanged = 0
    skipped = 0
    seen_keys: set[tuple[str, str]] = set()
    for path in sorted(root_path.rglob("*")):
        if path.is_dir():
            if should_skip_dir(path.name):
                continue
            continue
        rel = path.relative_to(root_path).as_posix()
        parts = rel.split("/")
        if any(should_skip_dir(p) for p in parts[:-1]):
            skipped += 1
            continue
        if should_skip_file(path.name):
            skipped += 1
            continue
        try:
            if path.stat().st_size > MAX_FILE_BYTES:
                skipped += 1
                continue
            folder = "/".join(parts[:-1])
            if prefix:
                folder = f"{prefix}/{folder}".strip("/") if folder else prefix
            key = (folder, path.name)
            seen_keys.add(key)
            if upsert:
                existing = _find_doc_by_rel_path(kb_id, folder, path.name)
                if existing:
                    doc = _update_doc_from_file(
                        existing=existing,
                        src_path=path,
                        source_type="import_folder",
                    )
                    if doc.get("syncStatus") == "unchanged":
                        unchanged += 1
                    else:
                        updated.append(doc)
                    continue
            doc = _create_doc_record(
                kb_id=kb_id,
                title=path.stem,
                file_name=path.name,
                folder_path=folder,
                source_type="import_folder",
                src_path=path,
            )
            doc["syncStatus"] = "created"
            created.append(doc)
        except Exception:
            skipped += 1

    pruned = 0
    if prune_missing and upsert:
        with db() as conn:
            if prefix:
                rows = conn.execute(
                    """
                    SELECT id, folder_path, file_name FROM kb_documents
                    WHERE kb_id=? AND deleted_at IS NULL
                      AND source_type IN ('import_folder', 'import_vault')
                      AND (folder_path=? OR folder_path LIKE ?)
                    """,
                    (kb_id, prefix, f"{prefix}/%"),
                ).fetchall()
            else:
                rows = conn.execute(
                    """
                    SELECT id, folder_path, file_name FROM kb_documents
                    WHERE kb_id=? AND deleted_at IS NULL AND source_type IN ('import_folder', 'import_vault')
                    """,
                    (kb_id,),
                ).fetchall()
        for r in rows:
            key = (str(r["folder_path"] or ""), str(r["file_name"] or ""))
            if key not in seen_keys:
                delete_document(r["id"], record_activity=False)
                pruned += 1

    if remember_source and not prefix:
        remember_sync_source(
            kb_id,
            source_type="folder",
            source_path=str(root_path),
        )

    result = {
        "items": created + updated,
        "created": len(created),
        "updated": len(updated),
        "unchanged": unchanged,
        "skipped": skipped,
        "pruned": pruned,
        "upsert": upsert,
        "folderPrefix": prefix,
    }
    if activity_action:
        owned_activity.record(
            kb_id,
            activity_action,
            title=str(root_path.name if hasattr(root_path, "name") else root_path),
            detail={
                "created": len(created),
                "updated": len(updated),
                "unchanged": unchanged,
                "skipped": skipped,
                "pruned": pruned,
            },
        )
    return result


def import_from_vault(
    kb_id: str,
    vault_id: str,
    *,
    upsert: bool = True,
    prune_missing: bool = False,
    folder_prefix: str | None = None,
    activity_action: str | None = "import.vault",
) -> dict[str, Any]:
    """Import a connected Obsidian vault directory into an owned knowledge base."""
    from evoflow.knowledge.vault import service as vault_service
    from evoflow.knowledge.vault.errors import VaultNotFoundError

    vid = str(vault_id or "").strip()
    try:
        vault = vault_service.get_vault(vid)
    except VaultNotFoundError as exc:
        raise ValueError(f"vault not found: {vid}") from exc
    if not vault:
        raise ValueError(f"vault not found: {vid}")
    root = str(vault.get("vaultPath") or vault.get("vault_path") or "").strip()
    if not root:
        raise ValueError("vault has no vaultPath")
    prefix = folder_prefix
    if prefix is None:
        prefix = str(vault.get("id") or vault_id)
    result = import_local_folder(
        kb_id,
        root,
        upsert=upsert,
        prune_missing=prune_missing,
        folder_prefix=prefix or "",
        remember_source=False,
        activity_action=None,
    )
    for doc in result.get("items") or []:
        doc_id = doc.get("id")
        if not doc_id:
            continue
        with db() as conn:
            conn.execute(
                "UPDATE kb_documents SET source_type='import_vault', updated_at=? WHERE id=?",
                (utc_now(), doc_id),
            )
    remember_sync_source(
        kb_id,
        source_type="vault",
        source_path=root,
        vault_id=str(vault.get("id") or vault_id),
    )
    result["vaultId"] = vault.get("id") or vault_id
    result["vaultName"] = vault.get("name") or ""
    result["vaultPath"] = root
    result["source"] = "import_vault"
    if activity_action:
        owned_activity.record(
            kb_id,
            activity_action,
            title=str(result.get("vaultName") or vault_id),
            detail={
                "created": result.get("created"),
                "updated": result.get("updated"),
                "unchanged": result.get("unchanged"),
                "pruned": result.get("pruned"),
                "vaultId": result.get("vaultId"),
            },
        )
    return result


def resync_base(kb_id: str, *, prune_missing: bool = False) -> dict[str, Any]:
    """Re-run last remembered folder/vault sync for a knowledge base."""
    base = get_base(kb_id)
    if not base:
        raise ValueError("knowledge base not found")
    kind = str(base.get("syncSourceType") or "")
    path = str(base.get("syncSourcePath") or "")
    vault_id = str(base.get("syncVaultId") or "")
    if kind == "vault" and vault_id:
        return import_from_vault(
            kb_id,
            vault_id,
            upsert=True,
            prune_missing=prune_missing,
            activity_action="sync.resync",
        )
    if kind == "folder" and path:
        return import_local_folder(
            kb_id,
            path,
            upsert=True,
            prune_missing=prune_missing,
            remember_source=True,
            activity_action="sync.resync",
        )
    raise ValueError("no sync source remembered; import a folder or vault first")


def delete_document(doc_id: str, *, record_activity: bool = True) -> None:
    title = ""
    kb_id = ""
    with db() as conn:
        row = conn.execute(
            "SELECT kb_id, title, file_name FROM kb_documents WHERE id=? AND deleted_at IS NULL",
            (doc_id,),
        ).fetchone()
        if not row:
            raise ValueError("document not found")
        kb_id = row["kb_id"]
        title = str(row["title"] or row["file_name"] or doc_id)
        now = utc_now()
        conn.execute(
            "UPDATE kb_documents SET deleted_at=?, updated_at=? WHERE id=?",
            (now, now, doc_id),
        )
        purge_document_index(conn, doc_id)
    blob_store.delete_doc_blobs(kb_id, doc_id)
    if record_activity:
        owned_activity.record(
            kb_id,
            "doc.delete",
            doc_id=doc_id,
            title=title,
        )


async def search(
    kb_id: str,
    query: str,
    *,
    mode: str = "hybrid",
    top_k: int = 8,
    tags: list[str] | None = None,
    record_activity: bool = True,
) -> dict[str, Any]:
    ensure_owned_kb_worker_started()
    base = get_base(kb_id)
    if not base:
        raise ValueError("knowledge base not found")
    mode = (mode or "hybrid").lower()
    degraded = False
    keyword_hits: list[dict[str, Any]] = []
    vector_hits: list[dict[str, Any]] = []
    tag_filters = [str(t).strip().lstrip("#") for t in (tags or []) if str(t).strip()]
    fetch_k = 20 if not tag_filters else 60

    if mode == "title":
        fused = search_title(kb_id, query, top_k=max(top_k * 3, fetch_k))
        items = enrich_hits(fused)
        if tag_filters:
            items = _filter_hits_by_tags(items, tag_filters)
        items = items[:top_k]
        out = {
            "items": items,
            "total": len(items),
            "mode": mode,
            "degraded": False,
            "tags": tag_filters,
        }
        if record_activity:
            owned_activity.record(
                kb_id,
                "search",
                title=_preview_title(query),
                detail={"query": query, "mode": mode, "hitCount": len(items)},
            )
        return out

    if mode in ("keyword", "hybrid", "fulltext"):
        keyword_hits = search_keyword(kb_id, query, top_k=fetch_k)

    if mode in ("semantic", "vector", "hybrid"):
        if base.get("embeddingDim") and base.get("vectorEnabled", True):
            try:
                with db() as conn:
                    row = conn.execute("SELECT * FROM kb_bases WHERE id=?", (kb_id,)).fetchone()
                mc = _model_config_for_base(dict(row))
                qvec = await get_embedding(query, mc, expected_dim=int(base["embeddingDim"]))
                vector_hits = search_vector(kb_id, qvec, top_k=fetch_k)
            except Exception:
                degraded = True
                if mode != "hybrid":
                    raise
        else:
            degraded = True

    if mode in ("keyword", "fulltext") or (mode == "hybrid" and not vector_hits):
        fused = keyword_hits[:fetch_k]
        for i, h in enumerate(fused):
            h["rank"] = i + 1
            h["rrf_score"] = 1.0 / (60 + i + 1)
        if mode == "hybrid" and not vector_hits:
            degraded = True
    elif mode in ("semantic", "vector"):
        fused = vector_hits[:fetch_k]
        for i, h in enumerate(fused):
            h["rank"] = i + 1
            h["rrf_score"] = h.get("score") or 0
    else:
        fused = rrf_fuse(keyword_hits, vector_hits, top_k=fetch_k)

    kg_boosted = False
    if base.get("graphEnabled") and mode in ("hybrid", "keyword", "fulltext", "semantic", "vector"):
        try:
            kg_hits = kg_store.search_graph_chunks(kb_id, query, top_k=12)
            if kg_hits:
                # Soft-merge: prepend missing kg chunks, keep fetch_k
                seen = {h["chunk_id"] for h in fused}
                merged = list(fused)
                for h in kg_hits:
                    if h["chunk_id"] in seen:
                        continue
                    h["rrf_score"] = 0.015 + 1.0 / (60 + int(h.get("rank") or 1))
                    merged.append(h)
                    seen.add(h["chunk_id"])
                merged.sort(key=lambda x: float(x.get("rrf_score") or 0), reverse=True)
                fused = merged[:fetch_k]
                kg_boosted = True
        except Exception:
            pass

    items = enrich_hits(fused)
    if tag_filters:
        items = _filter_hits_by_tags(items, tag_filters)
    items = items[:top_k]
    out = {
        "items": items,
        "total": len(items),
        "mode": mode,
        "degraded": degraded,
        "kgBoosted": kg_boosted,
        "tags": tag_filters,
    }
    if record_activity:
        owned_activity.record(
            kb_id,
            "search",
            title=_preview_title(query),
            detail={"query": query, "mode": mode, "hitCount": len(items)},
        )
    return out


def _filter_hits_by_tags(items: list[dict[str, Any]], tag_filters: list[str]) -> list[dict[str, Any]]:
    want = {t.lower() for t in tag_filters}
    out: list[dict[str, Any]] = []
    for it in items:
        have = {str(t).lower().lstrip("#") for t in (it.get("tags") or [])}
        if want & have:
            out.append(it)
    return out


def list_tags(kb_id: str) -> list[dict[str, Any]]:
    import json

    counts: dict[str, int] = {}
    with db() as conn:
        rows = conn.execute(
            """
            SELECT tags_json FROM kb_documents
            WHERE kb_id=? AND deleted_at IS NULL AND IFNULL(tags_json,'') NOT IN ('', '[]')
            """,
            (kb_id,),
        ).fetchall()
    for r in rows:
        try:
            tags = json.loads(r["tags_json"] or "[]") or []
        except Exception:
            continue
        if not isinstance(tags, list):
            continue
        for t in tags:
            s = str(t).strip().lstrip("#")
            if not s:
                continue
            counts[s] = counts.get(s, 0) + 1
    return [{"tag": k, "count": v} for k, v in sorted(counts.items(), key=lambda x: (-x[1], x[0]))]


def get_document_links(doc_id: str) -> dict[str, Any] | None:
    from evoflow.knowledge.owned import doc_links as doc_links_mod

    return doc_links_mod.get_document_links(doc_id)


def doc_graph(kb_id: str, *, center_doc_id: str | None = None, depth: int = 1) -> dict[str, Any]:
    from evoflow.knowledge.owned import doc_links as doc_links_mod

    return doc_links_mod.doc_graph_payload(kb_id, center_doc_id=center_doc_id, depth=depth)


def get_job(job_id: str) -> dict[str, Any] | None:
    return jobs.get_job(job_id)


def list_jobs(kb_id: str, *, limit: int = 50, states: list[str] | None = None) -> list[dict[str, Any]]:
    return jobs.list_jobs(kb_id, limit=limit, states=states)


def list_activities(
    *,
    kb_id: str | None = None,
    doc_id: str | None = None,
    limit: int = 50,
    before: str | None = None,
) -> list[dict[str, Any]]:
    return owned_activity.list_activities(
        kb_id=kb_id, doc_id=doc_id, limit=limit, before=before
    )


def job_stats(kb_id: str) -> dict[str, Any]:
    return jobs.job_stats(kb_id)


def list_chunks(doc_id: str) -> list[dict[str, Any]]:
    with db() as conn:
        rows = conn.execute(
            "SELECT * FROM kb_chunks WHERE doc_id=? ORDER BY ordinal",
            (doc_id,),
        ).fetchall()
    return [
        {
            "id": r["id"],
            "ordinal": r["ordinal"],
            "content": r["content"],
            "contextHeader": r["context_header"],
            "chunkKind": r["chunk_kind"],
            "tokenEstimate": r["token_estimate"],
            "enabled": bool(r["enabled"]),
        }
        for r in rows
    ]
