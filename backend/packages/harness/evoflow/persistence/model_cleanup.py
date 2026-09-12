"""Cleanup helpers for Panel model rows and connection links."""

from __future__ import annotations

from collections import defaultdict
from typing import Any

from evoflow.persistence.db import run_db_transaction
from evoflow.persistence.model_connections import delete_model_connection, use_to_api_type


def _normalize_base_url(base_url: str) -> str:
    return str(base_url or "").strip().rstrip("/").lower()


def connection_scope_fingerprint(base_url: str, api_type: str) -> str:
    """Match connections by endpoint scope (ignores vendor key renames like aliyun → aliyun-2)."""
    return f"{_normalize_base_url(base_url)}|{str(api_type or 'openai-completions').strip().lower()}"


def _is_embedding_row(row: dict[str, Any]) -> bool:
    vendor = str(row.get("vendor") or "").strip().lower()
    name = str(row.get("name") or "").lower()
    model = str(row.get("model") or "").lower()
    if vendor in {"local", "openai-embedding"}:
        return True
    return (
        "embedding" in name
        or "embedding" in model
        or "bge" in model
        or "e5-" in model
        or "nomic-embed" in model
    )


def _model_dedup_identity(row: dict[str, Any]) -> tuple[str, str]:
    """Identity for legacy duplicate removal (ignores vendor key renames)."""
    model_id = str(row.get("model") or "").strip()
    scope = connection_scope_fingerprint(str(row.get("base_url") or ""), use_to_api_type(str(row.get("use") or "")))
    return model_id, scope


def cleanup_legacy_duplicate_models() -> list[str]:
    """Remove legacy ``provider/modelId`` name rows when a valid replacement exists."""
    from evoflow.persistence import config_repositories as cfg_repo

    rows = cfg_repo.list_models()
    groups: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        if _is_embedding_row(row):
            continue
        groups[_model_dedup_identity(row)].append(row)

    deleted: list[str] = []
    for group in groups.values():
        if len(group) < 2:
            continue
        valid = [r for r in group if "/" not in str(r.get("name") or "")]
        legacy = [r for r in group if "/" in str(r.get("name") or "")]
        if not valid or not legacy:
            continue
        for row in legacy:
            name = str(row.get("name") or "").strip()
            if name and cfg_repo.delete_model(name):
                deleted.append(name)
    return deleted


def cleanup_stale_model_connections() -> list[str]:
    """Delete connection rows superseded by another key with the same endpoint scope."""
    from evoflow.persistence import config_repositories as cfg_repo
    from evoflow.persistence.model_connections import list_model_connections

    models = [m for m in cfg_repo.list_models() if not _is_embedding_row(m)]
    connections = list_model_connections()
    if not connections:
        return []

    scopes_with_models: set[str] = set()
    for row in models:
        scopes_with_models.add(
            connection_scope_fingerprint(str(row.get("base_url") or ""), use_to_api_type(str(row.get("use") or "")))
        )

    deleted: list[str] = []
    for key, conn in connections.items():
        scope = connection_scope_fingerprint(str(conn.get("base_url") or ""), str(conn.get("api_type") or ""))
        if scope not in scopes_with_models:
            continue
        has_models_for_key = any(str(m.get("vendor") or "").strip() == key for m in models)
        if has_models_for_key:
            continue
        if delete_model_connection(key):
            deleted.append(key)
    return deleted


def cleanup_stale_panel_models() -> dict[str, list[str]]:
    """Run all Panel stale-data cleanups (legacy duplicates + superseded connections)."""
    return {
        "legacy_models": cleanup_legacy_duplicate_models(),
        "stale_connections": cleanup_stale_model_connections(),
    }


def delete_connection_if_no_models(vendor: str) -> bool:
    """Remove a connection link when no model rows remain for *vendor*."""
    key = str(vendor or "").strip()
    if not key:
        return False

    def _write(db: Any) -> bool:
        row = db.execute("SELECT COUNT(*) FROM evoflow_models WHERE vendor = ?", (key,)).fetchone()
        if row and int(row[0] or 0) > 0:
            return False
        cur = db.execute("DELETE FROM evoflow_model_connections WHERE key = ?", (key,))
        return cur.rowcount > 0

    return run_db_transaction(_write)


def _delete_model_row(name: str) -> bool:
    """Delete a single model row without touching connection cleanup.

    Used by scoped deletes so we never accidentally trigger
    ``delete_connection_if_no_models`` for an unrelated vendor key.
    Mirrors the side effects of ``config_repositories.delete_model``
    (primary model setting + chat session references).
    """
    name = str(name or "").strip()
    if not name:
        return False

    def _write(db: Any) -> bool:
        cur = db.execute("DELETE FROM evoflow_models WHERE name = ?", (name,))
        if cur.rowcount <= 0:
            return False
        primary = db.execute(
            "SELECT value_text FROM evoflow_app_settings WHERE key = 'primary_model'",
        ).fetchone()
        if primary and str(primary[0] or "").strip() == name:
            db.execute("DELETE FROM evoflow_app_settings WHERE key = 'primary_model'")
        db.execute(
            "UPDATE evoflow_chat_sessions SET model_name = NULL WHERE model_name = ?",
            (name,),
        )
        db.execute(
            "UPDATE evoflow_chat_sessions SET primary_model_name = NULL WHERE primary_model_name = ?",
            (name,),
        )
        return True

    return run_db_transaction(_write)


def delete_models_for_connection(
    key: str,
    base_url: str = "",
    api_type: str = "openai-completions",
) -> list[str]:
    """Delete model rows owned by a connection.

    Deletion rule (safe, never crosses into another connection's models):

    1. **Exact** — rows whose ``vendor == key`` are unambiguously owned by this
       connection and are always removed.
    2. **Scope fallback** (legacy dirty data where a row's ``vendor`` still holds the
       root vendor name, e.g. ``aliyun`` while the live key is ``aliyun-2``): only
       when **no other live connection** shares the same endpoint scope do we also
       delete rows in that scope. If another connection shares the scope, those rows
       are presumed owned by it and left untouched.

    Embedding rows are never removed here (their vendor is ``local`` /
    ``openai-embedding`` and they are not connection-bound).

    Returns the names of deleted models.
    """
    from evoflow.persistence import config_repositories as cfg_repo
    from evoflow.persistence.model_connections import list_model_connections

    key = str(key or "").strip()
    if not key:
        return []
    base_url = str(base_url or "").strip()
    api_type = str(api_type or "openai-completions").strip().lower()

    models = [m for m in cfg_repo.list_models() if not _is_embedding_row(m)]

    exact_names = {
        str(m.get("name") or "").strip()
        for m in models
        if str(m.get("vendor") or "").strip() == key
    }

    deleted: list[str] = []
    for name in exact_names:
        if _delete_model_row(name):
            deleted.append(name)

    # Scope fallback only when this scope is unique among live connections.
    if base_url:
        scope = connection_scope_fingerprint(base_url, api_type)
        other_live = [
            ck
            for ck, c in list_model_connections().items()
            if ck != key
            and connection_scope_fingerprint(
                str(c.get("base_url") or ""), str(c.get("api_type") or "")
            )
            == scope
        ]
        if not other_live:
            for m in models:
                name = str(m.get("name") or "").strip()
                if not name or name in exact_names:
                    continue
                m_scope = connection_scope_fingerprint(
                    str(m.get("base_url") or ""),
                    use_to_api_type(str(m.get("use") or "")),
                )
                if m_scope == scope and _delete_model_row(name):
                    deleted.append(name)

    return deleted
