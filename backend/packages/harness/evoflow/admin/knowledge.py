"""Knowledge admin CLI — owned KB by default; Obsidian vault as legacy.

When ``knowledge.primary=owned`` (default) and any owned base exists, list/get/recall/remember
use the local owned knowledge base. Pass ``--vault kb_…`` to target one base, or omit to
search/list across all owned bases. Set primary=vault to force the Obsidian connector.
"""

from __future__ import annotations

import asyncio
from typing import Any

from evoflow.admin.errors import NotFoundError, ValidationError
from evoflow.knowledge.vault.builtin import (
    BUILTIN_USER_GUIDE_VAULT_ID,
    ensure_builtin_knowledge_vaults,
)
from evoflow.knowledge.vault import service as vault_service
from evoflow.knowledge.vault import store as vault_store
from evoflow.knowledge.vault.models import AccessMode


def _ensure_vaults_ready() -> None:
    try:
        ensure_builtin_knowledge_vaults()
    except Exception:
        # Dev/tests without package assets should still work against user vaults.
        pass


def _run_async(coro: Any) -> Any:
    return asyncio.run(coro)


def _use_owned(vault_id: str | None = None) -> bool:
    """CLI follows the same primary switch as Agent knowledge tools.

    Explicit Obsidian vault ids always route to the vault connector, even when
    primary=owned — otherwise ``vaultId=evoflow-docs`` silently searches all
    owned bases and ignores the requested vault.
    """
    try:
        from evoflow.knowledge.owned import service as owned_service
        from evoflow.knowledge.owned import settings as owned_settings

        bases = owned_service.list_bases()
        if not bases:
            return False
        vid = str(vault_id or "").strip()
        if vid.startswith("kb_"):
            return True
        if vid and vault_store.get_vault_config(vid) is not None:
            return False
        mode = owned_settings.get_primary()
        if mode == "owned":
            return True
        if mode == "vault":
            return False
        return True
    except Exception:
        return False


def _owned_target_ids(vault_id: str | None = None) -> list[str]:
    from evoflow.knowledge.owned import service as owned_service

    vid = str(vault_id or "").strip()
    if vid.startswith("kb_"):
        if not owned_service.get_base(vid):
            raise NotFoundError(f"Owned knowledge base '{vid}' not found")
        return [vid]
    bases = owned_service.list_bases()
    if not bases:
        raise ValidationError("还没有自有知识库。请先在面板「自有知识库」创建或导入。")
    return [str(b["id"]) for b in bases]


def _enabled_vaults() -> list[Any]:
    _ensure_vaults_ready()
    return [c for c in vault_store.list_vault_configs() if c.enabled]


def resolve_vault_id(vault_id: str | None = None) -> str:
    """Pick an enabled vault: explicit id → builtin → sole enabled → first enabled."""
    _ensure_vaults_ready()
    enabled = _enabled_vaults()
    if not enabled:
        raise ValidationError(
            "还没有可用的知识库 Vault。请先在面板「知识库」连接并启用，或确认内置用户指南已注册。"
        )

    if vault_id:
        vid = str(vault_id).strip()
        cfg = vault_store.get_vault_config(vid)
        if cfg is None:
            raise NotFoundError(f"Vault '{vid}' not found")
        if not cfg.enabled:
            raise ValidationError(f"Vault '{vid}' 已停用")
        return cfg.id

    for cfg in enabled:
        if cfg.id == BUILTIN_USER_GUIDE_VAULT_ID:
            return cfg.id
    if len(enabled) == 1:
        return enabled[0].id
    return enabled[0].id


def list_vaults() -> dict[str, Any]:
    _ensure_vaults_ready()
    items = vault_service.list_vaults()
    return {"items": items, "count": len(items), "provider": "vault"}


def list_bases() -> dict[str, Any]:
    """List platform-owned knowledge bases (primary knowledge system)."""
    from evoflow.knowledge.owned import service as owned_service

    items = owned_service.list_bases()
    return {"provider": "owned", "items": items, "count": len(items)}


def create_owned_base(
    *,
    name: str,
    description: str = "",
    embedding_model_ref: str | None = None,
) -> dict[str, Any]:
    """Create a platform-owned knowledge base (not Obsidian).

    Returns both ``base`` / ``kbId`` and compat aliases ``vault`` / ``vaultId``
    so existing platform callers that pass vaultId keep working.
    """
    from evoflow.knowledge.owned import service as owned_service

    title = str(name or "").strip()
    if not title:
        raise ValidationError("name is required")

    payload: dict[str, Any] = {
        "name": title,
        "description": str(description or "").strip(),
    }
    ref = str(embedding_model_ref or "").strip()
    if ref:
        payload["embeddingModelRef"] = ref

    try:
        created = owned_service.create_base(payload)
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc

    kb_id = str(created.get("id") or "").strip()
    # Compat shape: older platform/UI paths expect vault / vaultId
    compat = {
        "id": kb_id,
        "name": created.get("name") or title,
        "enabled": True,
        "provider": "owned",
        "providerType": "owned",
    }
    return {
        "provider": "owned",
        "base": created,
        "kbId": kb_id,
        "vaultId": kb_id,
        "vault": compat,
    }


def create_managed_vault(
    *,
    name: str,
    vault_path: str | None = None,
    enabled: bool = True,
    access_mode: str = "read_write",
) -> dict[str, Any]:
    """Legacy: create a local Obsidian vault connection.

    Prefer :func:`create_owned_base` for platform/CLI defaults. Auto-mkdir under
    EVOFLOW_HOME when path omitted.
    """
    from pathlib import Path

    from evoflow.config.paths import get_paths

    title = str(name or "").strip()
    if not title:
        raise ValidationError("name is required")

    path_s = str(vault_path or "").strip()
    if not path_s:
        import re
        import uuid

        slug = re.sub(r"[^a-zA-Z0-9_-]+", "-", title).strip("-").lower() or "vault"
        root = get_paths().base_dir / "knowledge-vaults" / f"{slug[:40]}-{uuid.uuid4().hex[:6]}"
        root.mkdir(parents=True, exist_ok=True)
        # Minimal markdown so the folder is a usable vault root
        readme = root / "README.md"
        if not readme.exists():
            readme.write_text(f"# {title}\n\n由小V平台行政创建。\n", encoding="utf-8")
        path_s = str(root)

    path = Path(path_s).expanduser()
    if not path.exists():
        path.mkdir(parents=True, exist_ok=True)
    if not path.is_dir():
        raise ValidationError(f"vaultPath is not a directory: {path}")

    mode = str(access_mode or "read_write").strip() or "read_write"
    try:
        am = AccessMode(mode)
    except Exception as exc:
        raise ValidationError(f"invalid accessMode: {mode}") from exc

    created = vault_service.create_vault(
        {
            "name": title,
            "vaultPath": str(path.resolve()),
            "enabled": bool(enabled),
            "accessMode": am.value,
            "providerType": "obsidian",
            "launchMode": "managed_stdio",
        }
    )
    return {
        "provider": "vault",
        "vault": created,
        "vaultPath": str(path.resolve()),
        "vaultId": str((created or {}).get("id") or ""),
    }


def set_vault_enabled(vault_id: str, enabled: bool) -> dict[str, Any]:
    vid = str(vault_id or "").strip()
    if not vid:
        raise ValidationError("vaultId is required")
    cfg = vault_store.get_vault_config(vid)
    if cfg is None:
        raise NotFoundError(f"Vault '{vid}' not found")
    updated = vault_service.update_vault(vid, {"enabled": bool(enabled)})
    return {"vault": updated, "enabled": bool(enabled)}


def reindex_owned_base(
    kb_id: str,
    *,
    embedding_model_ref: str | None = None,
    force: bool = True,
) -> dict[str, Any]:
    from evoflow.knowledge.owned import service as owned_service

    kid = str(kb_id or "").strip()
    if not kid.startswith("kb_"):
        raise ValidationError("kbId must be an owned knowledge base id (kb_…)")
    if not owned_service.get_base(kid):
        raise NotFoundError(f"Owned knowledge base '{kid}' not found")
    try:
        return owned_service.reindex_base(
            kid,
            embedding_model_ref=embedding_model_ref,
            force=force,
        )
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc


def requeue_owned_orphans(kb_id: str | None = None, *, limit: int = 200) -> dict[str, Any]:
    from evoflow.knowledge.owned import service as owned_service

    kid = str(kb_id or "").strip() or None
    if kid and not kid.startswith("kb_"):
        raise ValidationError("kbId must be an owned knowledge base id (kb_…)")
    if kid and not owned_service.get_base(kid):
        raise NotFoundError(f"Owned knowledge base '{kid}' not found")
    return owned_service.requeue_orphan_parse_docs(kid, limit=limit)


def list_knowledge(
    *,
    vault_id: str | None = None,
    prefix: str = "",
    limit: int = 80,
    # Legacy kwargs kept so old callers don't crash; ignored for Obsidian.
    thread_id: str | None = None,
    global_only: bool = False,
) -> dict[str, Any]:
    del thread_id, global_only
    if _use_owned(vault_id):
        from evoflow.knowledge.owned import service as owned_service

        kids = _owned_target_ids(vault_id)
        pref = (prefix or "").strip().lstrip("/")
        limit_n = max(1, min(int(limit or 80), 200))
        entries: list[dict[str, Any]] = []
        total = 0
        for kid in kids:
            docs = owned_service.list_documents(kid)
            total += len(docs)
            base = owned_service.get_base(kid) or {}
            for d in docs:
                path = (
                    (d.get("folderPath") and f'{d["folderPath"]}/{d["fileName"]}')
                    or d.get("fileName")
                    or d["id"]
                )
                if pref and not path.startswith(pref) and not str(d.get("title") or "").startswith(pref):
                    continue
                entries.append(
                    {
                        "path": path,
                        "docId": d["id"],
                        "kbId": kid,
                        "kbName": base.get("name"),
                        "title": d.get("title"),
                        "parseStatus": d.get("parseStatus"),
                    }
                )
                if len(entries) >= limit_n:
                    break
            if len(entries) >= limit_n:
                break
        return {
            "provider": "owned",
            "kbIds": kids,
            "query": None,
            "prefix": pref or None,
            "total": total,
            "count": len(entries),
            "truncated": len(entries) < total,
            "entries": entries,
        }

    vid = resolve_vault_id(vault_id)
    data = vault_service.list_notes(vid, limit=limit, prefix=prefix)
    return {
        "provider": "vault",
        "vaultId": vid,
        "query": None,
        "prefix": prefix or None,
        "total": data.get("total", 0),
        "count": data.get("count", 0),
        "truncated": data.get("truncated", False),
        "entries": data.get("items") or [],
    }


def get_knowledge(path: str, *, vault_id: str | None = None) -> dict[str, Any]:
    note_path = str(path or "").strip()
    if not note_path:
        raise ValidationError("path is required")
    if _use_owned(vault_id):
        from evoflow.knowledge.owned import service as owned_service

        kids = _owned_target_ids(vault_id)
        for kid in kids:
            doc = owned_service.resolve_document(kid, note_path)
            if not doc:
                continue
            content = owned_service.get_document_content(doc["id"]) or {}
            return {
                "provider": "owned",
                "kbId": kid,
                "item": {
                    "docId": doc["id"],
                    "path": note_path,
                    "title": doc.get("title"),
                    "content": content.get("content") or "",
                    "parseStatus": doc.get("parseStatus"),
                },
            }
        raise NotFoundError(f"Document '{note_path}' not found in owned knowledge bases")

    vid = resolve_vault_id(vault_id)
    data = _run_async(vault_service.read_vault(vid, {"paths": [note_path]}))
    items = data.get("items") or []
    if not items:
        raise NotFoundError(f"Note '{note_path}' not found in vault '{vid}'")
    return {"provider": "vault", "vaultId": vid, "item": items[0]}


def remember(data: dict[str, Any], *, vault_id: str | None = None) -> dict[str, Any]:
    """Ingest a note into owned KB (default) or a read_write Obsidian vault."""
    if not isinstance(data, dict):
        raise ValidationError("Knowledge payload must be a JSON object")
    title = str(data.get("title") or "").strip()
    content = str(data.get("knowledge") or data.get("content") or "").strip()
    if not title:
        raise ValidationError("title is required")
    if not content:
        raise ValidationError("knowledge/content is required")

    explicit = vault_id or data.get("vaultId") or data.get("vault_id")
    explicit_s = str(explicit).strip() if explicit else None

    if _use_owned(explicit_s):
        from evoflow.knowledge.owned import service as owned_service

        kids = _owned_target_ids(explicit_s)
        kid = kids[0]
        doc = owned_service.upload_manual_markdown(
            kid,
            title=title,
            content=content,
            folder_path=str(data.get("inboxPath") or data.get("inbox_path") or "00-Inbox"),
        )
        return {
            "provider": "owned",
            "kbId": kid,
            "ok": True,
            "result": doc,
            "via": "owned",
        }

    vid = resolve_vault_id(explicit_s)
    cfg = vault_store.require_vault_config(vid)
    if cfg.access_mode != AccessMode.read_write:
        raise ValidationError(
            f"Vault '{vid}' 为只读，无法写入。请指定 --vault 到可写 Vault，或在面板改为读写。"
        )

    payload = {
        "title": title,
        "content": content,
        "summary": str(data.get("summary") or ""),
        "source": str(data.get("source") or "evoflow-cli"),
        "sourceDescription": str(
            data.get("sourceDescription") or data.get("source_description") or "evoflow knowledge remember"
        ),
        "confidence": data.get("confidence", 0.7),
        "tags": list(data.get("tags") or ([data["category"]] if data.get("category") else [])),
        "relatedPaths": list(data.get("relatedPaths") or data.get("related_paths") or []),
        "inboxPath": data.get("inboxPath") or data.get("inbox_path"),
    }
    try:
        result = _run_async(vault_service.ingest_vault(vid, payload))
        return {"provider": "vault", "vaultId": vid, "ok": True, "result": result, "via": "obsidian"}
    except Exception as exc:
        # Headless / no Local REST API — still allow 小V 平台行政写入本地目录
        fs = _remember_filesystem(vid, cfg, title=title, content=content, summary=str(payload.get("summary") or ""))
        fs["fallback_error"] = str(exc)
        return fs


def _remember_filesystem(
    vault_id: str,
    cfg: Any,
    *,
    title: str,
    content: str,
    summary: str = "",
) -> dict[str, Any]:
    import re

    from evoflow.knowledge.vault.constants import DEFAULT_INBOX_PATH
    from evoflow.knowledge.vault.paths import resolve_inside_vault

    inbox = str(getattr(cfg, "default_inbox_path", None) or DEFAULT_INBOX_PATH).strip() or DEFAULT_INBOX_PATH
    slug = re.sub(r"[^\w\u4e00-\u9fff-]+", "-", title).strip("-") or "note"
    rel = f"{inbox.rstrip('/')}/{slug}.md"
    abs_path = resolve_inside_vault(cfg.vault_path, rel)
    abs_path.parent.mkdir(parents=True, exist_ok=True)
    body_parts = [f"# {title}", ""]
    if summary:
        body_parts.extend([summary, ""])
    body_parts.append(content.rstrip() + "\n")
    if abs_path.exists():
        # Avoid clobber: append timestamp suffix
        from evoflow.timeutil import utc_now_iso_z

        stamp = utc_now_iso_z().replace(":", "").replace("-", "")[:15]
        rel = f"{inbox.rstrip('/')}/{slug}-{stamp}.md"
        abs_path = resolve_inside_vault(cfg.vault_path, rel)
        abs_path.parent.mkdir(parents=True, exist_ok=True)
    abs_path.write_text("\n".join(body_parts), encoding="utf-8")
    return {
        "vaultId": vault_id,
        "ok": True,
        "via": "filesystem",
        "result": {"path": rel, "title": title},
    }


def recall(
    query: str,
    *,
    vault_id: str | None = None,
    category: str | None = None,
    limit: int = 8,
    mode: str = "fulltext",
    thread_id: str | None = None,
) -> dict[str, Any]:
    """Search owned knowledge bases (default) or an Obsidian vault (legacy)."""
    del thread_id
    q = str(query or "").strip()
    if not q:
        raise ValidationError("query is required")
    mode_s = str(mode or "fulltext").strip().lower() or "fulltext"
    top_k = max(1, min(int(limit or 8), 20))

    if _use_owned(vault_id):
        from evoflow.knowledge.owned import service as owned_service

        kids = _owned_target_ids(vault_id)
        # Map CLI modes onto owned search modes
        owned_mode = {
            "fulltext": "keyword",
            "fs": "keyword",
            "filesystem": "keyword",
            "title": "title",
            "hybrid": "hybrid",
            "semantic": "semantic",
            "vector": "semantic",
            "keyword": "keyword",
        }.get(mode_s, "hybrid")
        tags = [str(category).strip()] if category else None
        merged: list[dict[str, Any]] = []
        for kid in kids:
            result = _run_async(
                owned_service.search(kid, q, mode=owned_mode, top_k=top_k, tags=tags)
            )
            base = owned_service.get_base(kid) or {}
            for item in result.get("items") or []:
                merged.append(
                    {
                        **item,
                        "kbId": kid,
                        "kbName": base.get("name"),
                        "provider": "owned",
                    }
                )
        merged.sort(
            key=lambda x: float(x.get("rrfScore") or x.get("vectorScore") or x.get("score") or 0),
            reverse=True,
        )
        entries = merged[:top_k]
        return {
            "provider": "owned",
            "query": q,
            "kbIds": kids,
            "mode": owned_mode,
            "category": category,
            "total": len(entries),
            "entries": entries,
        }

    vid = resolve_vault_id(vault_id)

    if mode_s in {"fulltext", "title", "fs", "filesystem"}:
        from evoflow.knowledge.vault.fs_search import filesystem_keyword_search

        cfg = vault_store.require_vault_config(vid)
        results = filesystem_keyword_search(
            vault_id=cfg.id,
            vault_path=cfg.vault_path,
            query=q,
            top_k=top_k,
            ignore_patterns=cfg.ignore_patterns or "",
        )
        if mode_s == "title":
            ql = q.lower()
            results = [r for r in results if ql in str(r.title or "").lower() or ql in str(r.path or "").lower()]
        if category:
            tag = str(category).strip().lower()
            results = [r for r in results if tag in [str(t).lower() for t in (r.tags or [])]]
        items = [r.model_dump(by_alias=True, mode="json") for r in results[:top_k]]
        return {
            "provider": "vault",
            "query": q,
            "vaultId": vid,
            "mode": mode_s,
            "category": category,
            "total": len(items),
            "entries": items,
        }

    tags = [str(category).strip()] if category else []
    data = _run_async(
        vault_service.search_vault(
            vid,
            {
                "query": q,
                "mode": mode_s,
                "topK": top_k,
                "tags": tags,
            },
        )
    )
    items = data.get("items") or []
    return {
        "provider": "vault",
        "query": q,
        "vaultId": vid,
        "mode": mode_s,
        "category": category,
        "total": len(items),
        "entries": items,
    }


def delete_knowledge(path: str, *, vault_id: str | None = None) -> dict[str, Any]:
    """Delete a Markdown note under a read_write vault (filesystem)."""
    from pathlib import Path

    from evoflow.knowledge.vault.paths import resolve_inside_vault

    note_path = str(path or "").strip()
    if not note_path:
        raise ValidationError("path is required")
    vid = resolve_vault_id(vault_id)
    cfg = vault_store.require_vault_config(vid)
    if cfg.access_mode != AccessMode.read_write:
        raise ValidationError(f"Vault '{vid}' 为只读，无法删除笔记")
    if cfg.builtin:
        raise ValidationError("系统内置知识库不可删除笔记")

    target = resolve_inside_vault(cfg.vault_path, note_path)
    if not target.is_file():
        raise NotFoundError(f"Note '{note_path}' not found in vault '{vid}'")
    target.unlink()
    # Drop empty parent dirs up to vault root (best-effort).
    parent = target.parent
    root = Path(cfg.vault_path).expanduser().resolve()
    while parent != root and parent.is_dir():
        try:
            parent.rmdir()
        except OSError:
            break
        parent = parent.parent
    return {"vaultId": vid, "ok": True, "deleted": note_path}
