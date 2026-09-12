"""High-level Knowledge Vault service used by Gateway and Agent tools."""

from __future__ import annotations

import logging
from typing import Any

from evoflow.knowledge.vault import secrets as vault_secrets
from evoflow.knowledge.vault import store as vault_store
from evoflow.knowledge.vault.errors import KnowledgeError, VaultNotFoundError, map_exception
from evoflow.knowledge.vault.mcp_runtime import drop_session, ensure_session, probe_node_runtime
from evoflow.knowledge.vault.models import (
    AccessMode,
    KnowledgeVaultConfig,
    LaunchMode,
)
from evoflow.knowledge.vault.paths import has_obsidian_marker, is_localhost_url, iter_markdown_notes, vault_root_exists
from evoflow.knowledge.vault.provider import get_knowledge_provider, obsidian_open_uri
from evoflow.knowledge.vault.sanitize import sanitize_obj
from evoflow.knowledge.vault.secrets import default_embedding_key_ref, default_obsidian_key_ref
from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)


def list_vaults(
    *,
    is_admin: bool = False,
    personal_scope: str | None = None,
    org_scope: str | None = None,
    principal: Any = None,
    filter_visibility: bool = False,
) -> list[dict[str, Any]]:
    from evoflow.authz.resource_visibility import owner_scope_visible_to_principal
    from evoflow.knowledge.vault.builtin import is_builtin_vault_id

    configs = vault_store.list_vault_configs()
    # Stable sort: createdAt asc → name asc → id asc.
    configs.sort(key=lambda c: (c.created_at or "", c.name or "", c.id or ""))
    out: list[dict[str, Any]] = []
    for c in configs:
        if filter_visibility and not is_admin:
            if is_builtin_vault_id(c.id) or bool(c.builtin):
                pass
            elif not owner_scope_visible_to_principal(
                getattr(c, "owner_scope_id", None),
                principal,
                is_admin=False,
                personal_scope=personal_scope,
                org_scope=org_scope,
            ):
                continue
        out.append(vault_store.public_vault_dict(c))
    return out


def get_vault(vault_id: str) -> dict[str, Any]:
    cfg = vault_store.require_vault_config(vault_id)
    return vault_store.public_vault_dict(cfg)


def create_vault(
    payload: dict[str, Any],
    *,
    obsidian_api_key: str | None = None,
    embedding_api_key: str | None = None,
    org_id: str | None = None,
    owner_scope_id: str | None = None,
    created_by: str | None = None,
) -> dict[str, Any]:
    data = dict(payload)
    vault_id = str(data.get("id") or "").strip()
    if not vault_id:
        # Derive from name
        import re
        import uuid

        base = re.sub(r"[^a-zA-Z0-9_-]+", "-", str(data.get("name") or "vault").strip()).strip("-").lower()
        vault_id = (base or "vault")[:40] + "-" + uuid.uuid4().hex[:6]
        data["id"] = vault_id

    from evoflow.knowledge.vault.builtin import is_builtin_vault_id

    if is_builtin_vault_id(vault_id) or bool(data.get("builtin")):
        raise ValueError("系统内置知识库由产品自动注册，不能手动创建同名连接")

    if vault_store.get_vault_config(vault_id) is not None:
        raise ValueError(f"vault id already exists: {vault_id}")

    if not vault_root_exists(str(data.get("vaultPath") or data.get("vault_path") or "")):
        raise ValueError("vaultPath does not exist or is not a directory")

    # Secret refs
    if obsidian_api_key:
        ref = default_obsidian_key_ref(vault_id)
        vault_secrets.put_secret(ref, obsidian_api_key)
        data["obsidianApiKeySecretRef"] = ref
    if embedding_api_key:
        ref = default_embedding_key_ref(vault_id)
        vault_secrets.put_secret(ref, embedding_api_key)
        data["embeddingApiKeySecretRef"] = ref

    data.setdefault("createdAt", utc_now_iso_z())
    data["updatedAt"] = utc_now_iso_z()
    if org_id:
        data.setdefault("orgId", org_id)
    if owner_scope_id:
        data.setdefault("ownerScopeId", owner_scope_id)
    if created_by:
        data.setdefault("createdBy", created_by)
    cfg = KnowledgeVaultConfig.model_validate(data)
    if cfg.launch_mode == LaunchMode.external_http:
        for url in (cfg.search_server_url, cfg.write_server_url):
            if url and not is_localhost_url(url) and not cfg.allow_remote_http:
                raise ValueError("非本机 MCP URL 需要显式确认 allowRemoteHttp=true")
    saved = vault_store.upsert_vault_config(cfg)
    _invalidate_tools_cache()
    out = vault_store.public_vault_dict(saved)
    out["hasObsidianMarker"] = has_obsidian_marker(saved.vault_path)
    return out


def _invalidate_tools_cache() -> None:
    try:
        from evoflow.tools.tools import invalidate_available_tools_cache

        invalidate_available_tools_cache()
    except Exception:
        logger.debug("tools cache invalidate skipped", exc_info=True)


def update_vault(
    vault_id: str,
    payload: dict[str, Any],
    *,
    obsidian_api_key: str | None = None,
    embedding_api_key: str | None = None,
    clear_obsidian_api_key: bool = False,
) -> dict[str, Any]:
    existing = vault_store.require_vault_config(vault_id)
    data = existing.model_dump(by_alias=True, mode="json")
    for k, v in payload.items():
        if k in ("id", "createdAt", "created_at"):
            continue
        if k in ("obsidianApiKey", "embeddingApiKey"):
            continue
        # Builtin product vault: path / builtin flag / access mode are system-managed.
        if existing.builtin and k in (
            "builtin",
            "vaultPath",
            "vault_path",
            "accessMode",
            "access_mode",
            "providerType",
            "provider_type",
        ):
            continue
        data[k] = v
    if existing.builtin:
        data["builtin"] = True
        data["accessMode"] = AccessMode.read_only.value
        data["vaultPath"] = existing.vault_path

    if obsidian_api_key is not None and obsidian_api_key != "":
        ref = data.get("obsidianApiKeySecretRef") or default_obsidian_key_ref(vault_id)
        vault_secrets.put_secret(ref, obsidian_api_key)
        data["obsidianApiKeySecretRef"] = ref
    if clear_obsidian_api_key:
        ref = data.get("obsidianApiKeySecretRef") or ""
        if ref:
            vault_secrets.delete_secret(ref)
        data["obsidianApiKeySecretRef"] = ""
    if embedding_api_key is not None and embedding_api_key != "":
        ref = data.get("embeddingApiKeySecretRef") or default_embedding_key_ref(vault_id)
        vault_secrets.put_secret(ref, embedding_api_key)
        data["embeddingApiKeySecretRef"] = ref

    data["updatedAt"] = utc_now_iso_z()
    cfg = KnowledgeVaultConfig.model_validate(data)
    saved = vault_store.upsert_vault_config(cfg)
    # Reload MCP session on config change (best-effort)
    try:
        import asyncio

        try:
            loop = asyncio.get_running_loop()
            loop.create_task(drop_session(vault_id))
        except RuntimeError:
            asyncio.run(drop_session(vault_id))
    except Exception:
        logger.debug("drop_session after update failed", exc_info=True)
    _invalidate_tools_cache()
    return vault_store.public_vault_dict(saved)


async def delete_vault(vault_id: str) -> dict[str, Any]:
    """Delete EvoFlow config + stop MCP — never delete vault files."""
    cfg = vault_store.get_vault_config(vault_id)
    if cfg is None:
        raise VaultNotFoundError(f"vault not found: {vault_id}")
    if cfg.builtin:
        raise ValueError("系统内置知识库不可删除（可在设置中停用）")
    await drop_session(vault_id)
    vault_store.delete_vault_config(vault_id)
    try:
        from evoflow.knowledge.vault import secrets as vault_secrets

        vault_secrets.delete_secrets_for_vault(vault_id)
    except Exception:
        logger.debug("delete vault secrets failed", exc_info=True)
    _invalidate_tools_cache()
    return {
        "success": True,
        "vaultId": vault_id,
        "deletedConfigOnly": True,
        "message": "已删除 EvoFlow 中的知识库连接配置，未删除 Obsidian Vault 内任何文件。",
    }


async def test_vault(vault_id: str) -> dict[str, Any]:
    cfg = vault_store.require_vault_config(vault_id)
    probe = probe_node_runtime()
    provider = get_knowledge_provider()
    result: dict[str, Any] = {
        "vaultId": vault_id,
        "nodeRuntime": probe.__dict__,
        "vaultPathValid": vault_root_exists(cfg.vault_path),
        "hasObsidianMarker": has_obsidian_marker(cfg.vault_path),
    }
    try:
        await ensure_session(cfg, need_write=cfg.access_mode == AccessMode.read_write, force_reload=True)
        status = await provider.status(vault_id)
        result["status"] = status.model_dump(by_alias=True, mode="json")
        result["ok"] = bool(status.search_ready)
    except KnowledgeError as exc:
        result["ok"] = False
        result["error"] = exc.to_dict()
    except Exception as exc:
        result["ok"] = False
        result["error"] = map_exception(exc).to_dict()
    return sanitize_obj(result)


async def install_vault(vault_id: str) -> dict[str, Any]:
    """Enqueue first-time setup: install kb-mcp packages (if needed) + reindex.

    Returns immediately with a pollable job. Does **not** block the HTTP request on
    ``npm install`` (that previously froze the panel and flashed a console window).
    """
    cfg = vault_store.require_vault_config(vault_id)
    from evoflow.knowledge.vault.reindex_jobs import start_reindex_job

    job = await start_reindex_job(
        vault_id,
        vault_path=cfg.vault_path,
        path=None,
        force=True,
        run_install=True,
    )
    return sanitize_obj(
        {
            "accepted": True,
            "reindexJob": job.to_dict(),
            "message": "已开始后台安装检索组件并建索引（obsidian-hybrid-search，非 Obsidian 应用）",
        }
    )


async def vault_status(vault_id: str) -> dict[str, Any]:
    status = await get_knowledge_provider().status(vault_id)
    data = status.model_dump(by_alias=True, mode="json")
    # Ensure runtime status is always present even if provider omitted it
    if not data.get("runtimeStatus"):
        from evoflow.knowledge.vault.runtime_resolve import runtime_status_dict

        data["runtimeStatus"] = runtime_status_dict()
    from evoflow.knowledge.vault.reindex_jobs import get_job_dict

    job = get_job_dict(vault_id)
    if job:
        data["reindexJob"] = job
    return data


async def reindex_vault(
    vault_id: str,
    path: str | None = None,
    *,
    force: bool = True,
    wait: bool = False,
) -> dict[str, Any]:
    """Start (or await) a vault reindex job.

    Default is async: returns a job payload immediately so the UI can poll.
    ``wait=True`` blocks until the job finishes (tests / scripts).
    """
    from evoflow.knowledge.vault.reindex_jobs import get_job_dict, start_reindex_job

    cfg = vault_store.require_vault_config(vault_id)
    job = await start_reindex_job(
        vault_id,
        vault_path=cfg.vault_path,
        path=path,
        force=force if not path else False,
    )
    if wait:
        import asyncio

        while True:
            cur = get_job_dict(vault_id) or job.to_dict()
            if cur.get("state") in ("done", "error"):
                return cur
            await asyncio.sleep(0.4)
    return job.to_dict()


async def reindex_job_status(vault_id: str) -> dict[str, Any]:
    from evoflow.knowledge.vault.reindex_jobs import get_job_dict

    vault_store.require_vault_config(vault_id)
    job = get_job_dict(vault_id)
    if not job:
        return {"vaultId": vault_id, "state": "idle", "message": "当前没有重建任务"}
    return job


async def search_vault(vault_id: str, body: dict[str, Any]) -> dict[str, Any]:
    provider = get_knowledge_provider()
    results = await provider.search(
        vault_id,
        query=str(body.get("query") or ""),
        mode=str(body.get("mode") or "hybrid"),
        top_k=int(body.get("topK") or body.get("top_k") or 8),
        tags=body.get("tags") or [],
        scopes=body.get("scopes") or [],
        threshold=body.get("threshold"),
        rerank=bool(body.get("rerank") or False),
    )
    return {
        "vaultId": vault_id,
        "items": [r.model_dump(by_alias=True, mode="json") for r in results],
        "count": len(results),
    }


async def read_vault(vault_id: str, body: dict[str, Any]) -> dict[str, Any]:
    provider = get_knowledge_provider()
    paths = body.get("paths") or []
    if isinstance(paths, str):
        paths = [paths]
    notes = await provider.read(
        vault_id,
        list(paths),
        max_content_chars=body.get("maxContentChars") or body.get("max_content_chars"),
    )
    return {
        "vaultId": vault_id,
        "items": [n.model_dump(by_alias=True, mode="json") for n in notes],
    }


async def save_vault(vault_id: str, body: dict[str, Any]) -> dict[str, Any]:
    provider = get_knowledge_provider()
    note = await provider.save_note(
        vault_id,
        path=str(body.get("path") or ""),
        content=str(body.get("content") if body.get("content") is not None else ""),
    )
    return {
        "vaultId": vault_id,
        "item": note.model_dump(by_alias=True, mode="json"),
    }


async def graph_vault(vault_id: str, body: dict[str, Any]) -> dict[str, Any]:
    provider = get_knowledge_provider()
    g = await provider.graph(
        vault_id,
        path=str(body.get("path") or ""),
        depth=int(body.get("depth") or 1),
        direction=str(body.get("direction") or "both"),
    )
    return g.model_dump(by_alias=True, mode="json")


async def full_graph_vault(vault_id: str, *, max_nodes: int | None = None, max_edges: int | None = None) -> dict[str, Any]:
    provider = get_knowledge_provider()
    g = await provider.full_graph(vault_id, max_nodes=max_nodes, max_edges=max_edges)
    return g.model_dump(by_alias=True, mode="json")


async def ingest_vault(vault_id: str, body: dict[str, Any]) -> dict[str, Any]:
    provider = get_knowledge_provider()
    return await provider.ingest(
        vault_id,
        title=str(body.get("title") or "Untitled"),
        content=str(body.get("content") or ""),
        summary=str(body.get("summary") or ""),
        source=str(body.get("source") or "evoflow"),
        source_description=str(body.get("sourceDescription") or body.get("source_description") or ""),
        confidence=float(body.get("confidence") if body.get("confidence") is not None else 0.7),
        tags=list(body.get("tags") or []),
        related_paths=list(body.get("relatedPaths") or body.get("related_paths") or []),
        inbox_path=body.get("inboxPath") or body.get("inbox_path"),
    )


def list_notes(vault_id: str, *, limit: int = 80, prefix: str = "") -> dict[str, Any]:
    """Browse Markdown notes under the vault (filesystem), for panel document list."""
    cfg = vault_store.require_vault_config(vault_id)
    limit_n = max(1, min(int(limit or 80), 500))
    notes = iter_markdown_notes(
        cfg.vault_path,
        ignore_patterns=cfg.ignore_patterns,
        limit=None,
    )
    prefix_s = str(prefix or "").strip().replace("\\", "/").strip("/")
    if prefix_s:
        notes = [n for n in notes if n["path"] == prefix_s or n["path"].startswith(prefix_s + "/")]
    total = len(notes)
    items = notes[:limit_n]
    return {
        "vaultId": vault_id,
        "total": total,
        "count": len(items),
        "truncated": total > len(items),
        "items": [
            {
                "path": n["path"],
                "title": n["title"],
                "score": None,
                "snippet": n["path"],
                "tags": [],
            }
            for n in items
        ],
    }


def open_in_obsidian(vault_id: str, path: str) -> dict[str, str]:
    cfg = vault_store.require_vault_config(vault_id)
    uri = obsidian_open_uri(cfg.name, path)
    return {"uri": uri, "vaultName": cfg.name, "path": path}
