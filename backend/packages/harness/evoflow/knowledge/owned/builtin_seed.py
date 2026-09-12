"""Seed packaged product docs into owned knowledge bases on Gateway startup.

Mirrors vault ``ensure_builtin_knowledge_vaults`` for the primary knowledge path:
install / upgrade materializes the user guide into a stable owned KB and
re-imports when the bundled fingerprint changes.

If an older migration already created an owned KB for the user-guide vault,
we **adopt** that base instead of creating a second one, and soft-delete
true duplicates (same name / same sync_vault_id).
"""

from __future__ import annotations

import logging
from typing import Any

from evoflow.knowledge.owned import service as owned_service
from evoflow.knowledge.owned.db import db
from evoflow.knowledge.owned.embedding_bind import resolve_create_binding
from evoflow.knowledge.owned.ids import utc_now
from evoflow.knowledge.vault.builtin import (
    BUILTIN_USER_GUIDE_VAULT_ID,
    BUILTIN_USER_GUIDE_VAULT_NAME,
    materialize_user_guide_vault_result,
)

logger = logging.getLogger(__name__)

# Stable id so Agent / UI can rely on it across fresh installs.
BUILTIN_OWNED_USER_GUIDE_KB_ID = "kb_builtin_user_guide"
_FP_META_KEY = f"builtin_owned:{BUILTIN_USER_GUIDE_VAULT_ID}:fingerprint"


def is_builtin_owned_kb_id(kb_id: str | None) -> bool:
    kid = str(kb_id or "").strip()
    if not kid:
        return False
    if kid == BUILTIN_OWNED_USER_GUIDE_KB_ID:
        return True
    base = owned_service.get_base(kid)
    if not base:
        return False
    return str(base.get("syncVaultId") or "") == BUILTIN_USER_GUIDE_VAULT_ID


def _meta_get(key: str) -> str | None:
    with db() as conn:
        row = conn.execute(
            "SELECT value FROM kb_schema_meta WHERE key=?", (key,)
        ).fetchone()
    if not row:
        return None
    return str(row["value"] or "") or None


def _meta_set(key: str, value: str) -> None:
    with db() as conn:
        conn.execute(
            """
            INSERT INTO kb_schema_meta(key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value
            """,
            (key, value),
        )


def _row_exists_including_deleted(kb_id: str) -> dict[str, Any] | None:
    with db() as conn:
        row = conn.execute("SELECT * FROM kb_bases WHERE id=?", (kb_id,)).fetchone()
    return dict(row) if row else None


def _list_user_guide_candidates() -> list[dict[str, Any]]:
    """Active bases that already represent the packaged user guide."""
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for base in owned_service.list_bases():
        bid = str(base.get("id") or "")
        if not bid or bid in seen:
            continue
        name = str(base.get("name") or "").strip()
        sync_vid = str(base.get("syncVaultId") or "").strip()
        if (
            bid == BUILTIN_OWNED_USER_GUIDE_KB_ID
            or sync_vid == BUILTIN_USER_GUIDE_VAULT_ID
            or name == BUILTIN_USER_GUIDE_VAULT_NAME
        ):
            seen.add(bid)
            out.append(base)
    return out


def _pick_canonical(candidates: list[dict[str, Any]]) -> dict[str, Any]:
    """Prefer stable builtin id, else the one with most docs, else oldest."""
    by_id = {str(c.get("id")): c for c in candidates}
    if BUILTIN_OWNED_USER_GUIDE_KB_ID in by_id:
        return by_id[BUILTIN_OWNED_USER_GUIDE_KB_ID]

    def _key(base: dict[str, Any]) -> tuple[int, str]:
        docs = owned_service.list_documents(str(base["id"]))
        # More docs first; then earlier createdAt.
        return (-len(docs), str(base.get("createdAt") or ""))

    return sorted(candidates, key=_key)[0]


def _soft_delete_duplicate_base(kb_id: str) -> None:
    """Soft-delete a duplicate user-guide base (bypasses builtin delete guard)."""
    from evoflow.knowledge.owned import activity as owned_activity
    from evoflow.knowledge.owned import blob_store
    from evoflow.knowledge.owned.retrieve import purge_document_index

    now = utc_now()
    title = kb_id
    with db() as conn:
        row = conn.execute(
            "SELECT name FROM kb_bases WHERE id=? AND deleted_at IS NULL", (kb_id,)
        ).fetchone()
        if not row:
            return
        title = str(row["name"] or kb_id)
        conn.execute(
            "UPDATE kb_bases SET deleted_at=?, updated_at=? WHERE id=?",
            (now, now, kb_id),
        )
        doc_ids = [
            r["id"]
            for r in conn.execute(
                "SELECT id FROM kb_documents WHERE kb_id=? AND deleted_at IS NULL",
                (kb_id,),
            ).fetchall()
        ]
        for doc_id in doc_ids:
            conn.execute(
                "UPDATE kb_documents SET deleted_at=?, updated_at=? WHERE id=?",
                (now, now, doc_id),
            )
            purge_document_index(conn, doc_id)
    try:
        blob_store.delete_kb_blobs(kb_id)
    except Exception:
        logger.debug("duplicate kb blob cleanup skipped id=%s", kb_id, exc_info=True)
    owned_activity.record(
        kb_id,
        "base.delete",
        title=title,
        detail={"name": title, "reason": "dedupe_builtin_user_guide"},
    )
    logger.info("soft-deleted duplicate user-guide owned KB id=%s name=%s", kb_id, title)


def _promote_as_builtin(kb_id: str) -> dict[str, Any] | None:
    now = utc_now()
    with db() as conn:
        conn.execute(
            """
            UPDATE kb_bases SET
              name=?,
              description=?,
              sync_vault_id=?,
              updated_at=?
            WHERE id=? AND deleted_at IS NULL
            """,
            (
                BUILTIN_USER_GUIDE_VAULT_NAME,
                "系统内置 · 随版本自动同步产品文档",
                BUILTIN_USER_GUIDE_VAULT_ID,
                now,
                kb_id,
            ),
        )
    return owned_service.get_base(kb_id)


def _create_fresh_builtin_base() -> dict[str, Any] | None:
    raw = _row_exists_including_deleted(BUILTIN_OWNED_USER_GUIDE_KB_ID)
    if raw and raw.get("deleted_at"):
        logger.info(
            "builtin owned user-guide KB was deleted by user; skip re-seed id=%s",
            BUILTIN_OWNED_USER_GUIDE_KB_ID,
        )
        return None

    binding = resolve_create_binding({})
    now = utc_now()
    name = BUILTIN_USER_GUIDE_VAULT_NAME
    description = "系统内置 · 随版本自动同步产品文档"
    with db() as conn:
        conn.execute(
            """
            INSERT INTO kb_bases(
              id, name, description, chunk_size, chunk_overlap, chunk_strategy,
              embedding_mode, embedding_model, embedding_base_url, embedding_api_key_ref,
              embedding_model_ref,
              vector_enabled, keyword_enabled, wiki_enabled, graph_enabled,
              summary_enabled, image_caption_enabled,
              sync_source_type, sync_source_path, sync_vault_id,
              created_at, updated_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,1,0,0,0,0,?,?,?,?,?)
            """,
            (
                BUILTIN_OWNED_USER_GUIDE_KB_ID,
                name,
                description,
                512,
                80,
                "auto",
                str(binding["embedding_mode"]),
                str(binding["embedding_model"]),
                str(binding.get("embedding_base_url") or ""),
                "",
                str(binding.get("embedding_model_ref") or ""),
                "folder",
                "",
                BUILTIN_USER_GUIDE_VAULT_ID,
                now,
                now,
            ),
        )
    out = owned_service.get_base(BUILTIN_OWNED_USER_GUIDE_KB_ID)
    if out:
        from evoflow.knowledge.owned import activity as owned_activity

        owned_activity.record(
            BUILTIN_OWNED_USER_GUIDE_KB_ID,
            "base.create",
            title=name,
            detail={"name": name, "builtin": True},
        )
    return out


def _ensure_user_guide_base() -> dict[str, Any] | None:
    """Return the single active user-guide base; adopt migration copies; dedupe."""
    candidates = _list_user_guide_candidates()
    if candidates:
        canonical = _pick_canonical(candidates)
        canon_id = str(canonical["id"])
        for c in candidates:
            cid = str(c.get("id") or "")
            if cid and cid != canon_id:
                _soft_delete_duplicate_base(cid)
        promoted = _promote_as_builtin(canon_id)
        return promoted or owned_service.get_base(canon_id)

    return _create_fresh_builtin_base()


def ensure_builtin_owned_knowledge(*, force: bool = False) -> dict[str, Any]:
    """Idempotent: ensure user-guide owned KB exists and is synced from packaged docs.

    Returns a summary dict (never raises for missing assets — logs and reports).
    """
    mat = materialize_user_guide_vault_result(force=force)
    path = mat.get("path")
    fingerprint = str(mat.get("fingerprint") or "")
    if path is None:
        return {
            "ok": False,
            "action": "skipped",
            "reason": mat.get("reason") or "source_missing",
            "kbId": BUILTIN_OWNED_USER_GUIDE_KB_ID,
        }

    base = _ensure_user_guide_base()
    if base is None:
        return {
            "ok": True,
            "action": "skipped",
            "reason": "user_deleted",
            "kbId": BUILTIN_OWNED_USER_GUIDE_KB_ID,
        }

    kb_id = base["id"]
    prev_fp = _meta_get(_FP_META_KEY)
    docs = owned_service.list_documents(kb_id)
    content_changed = bool(mat.get("contentUpdated")) or force
    needs_import = (
        force
        or content_changed
        or not docs
        or (fingerprint and fingerprint != prev_fp)
        or str(base.get("syncSourcePath") or "") != str(path)
    )

    if not needs_import:
        return {
            "ok": True,
            "action": "unchanged",
            "kbId": kb_id,
            "name": base.get("name"),
            "fingerprint": fingerprint,
            "docCount": len(docs),
            "contentUpdated": False,
        }

    result = owned_service.import_local_folder(
        kb_id,
        path,
        upsert=True,
        prune_missing=True,
        folder_prefix="",
        remember_source=False,
        activity_action="import.folder",
    )
    owned_service.remember_sync_source(
        kb_id,
        source_type="folder",
        source_path=str(path),
        vault_id=BUILTIN_USER_GUIDE_VAULT_ID,
    )
    if fingerprint:
        _meta_set(_FP_META_KEY, fingerprint)

    logger.info(
        "seeded builtin owned user-guide kb=%s created=%s updated=%s unchanged=%s pruned=%s",
        kb_id,
        result.get("created"),
        result.get("updated"),
        result.get("unchanged"),
        result.get("pruned"),
    )
    return {
        "ok": True,
        "action": "synced",
        "kbId": kb_id,
        "name": base.get("name"),
        "fingerprint": fingerprint,
        "contentUpdated": True,
        "created": result.get("created"),
        "updated": result.get("updated"),
        "unchanged": result.get("unchanged"),
        "pruned": result.get("pruned"),
        "path": str(path),
    }
