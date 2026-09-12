"""KnowledgeProvider protocol and Obsidian implementation over MCP."""

from __future__ import annotations

import logging
from typing import Any, Protocol, runtime_checkable
from urllib.parse import quote

import httpx

from evoflow.knowledge.vault import store as vault_store
from evoflow.knowledge.vault.capability import (
    build_read_arguments,
    build_related_graph_arguments,
    build_search_arguments,
)
from evoflow.knowledge.vault.constants import (
    FULLTEXT_SEARCH_TIMEOUT_SEC,
    INTERACTIVE_MCP_WAIT_SEC,
    MAX_CONTENT_CHARS_DEFAULT,
    MAX_GRAPH_DEPTH,
    MAX_GRAPH_EDGES,
    MAX_GRAPH_NODES,
    MAX_READ_PATHS,
    VECTOR_SEARCH_TIMEOUT_SEC,
)
from evoflow.knowledge.vault.errors import (
    KnowledgeDisabledError,
    NoteConflictError,
    ObsidianNotRunningError,
    ToolTimeoutError,
    WriteDisabledError,
    map_exception,
)
from evoflow.knowledge.vault.fs_search import filesystem_keyword_search
from evoflow.knowledge.vault.mcp_runtime import (
    call_tool,
    drop_session,
    ensure_session,
    get_ready_session,
    get_session,
    is_session_warming,
    probe_node_runtime,
    schedule_session_warmup,
)
from evoflow.knowledge.vault.models import (
    AccessMode,
    KnowledgeGraph,
    KnowledgeGraphEdge,
    KnowledgeGraphNode,
    KnowledgeNote,
    KnowledgeProviderStatus,
    KnowledgeSearchResult,
    KnowledgeVaultConfig,
)
from evoflow.knowledge.vault.normalize import (
    _title_from_path,
    build_graph_from_related_search,
    normalize_notes,
    normalize_search_results,
)
from evoflow.knowledge.vault.paths import (
    assert_read_allowed,
    assert_write_allowed,
    has_obsidian_marker,
    normalize_vault_relative_path,
    resolve_inside_vault,
    vault_root_exists,
)
from evoflow.knowledge.vault.runtime_resolve import runtime_status_dict
from evoflow.knowledge.vault.sanitize import sanitize_text
from evoflow.knowledge.vault.template import inbox_filename, render_inbox_note

logger = logging.getLogger(__name__)


@runtime_checkable
class KnowledgeProvider(Protocol):
    async def status(self, vault_id: str) -> KnowledgeProviderStatus: ...

    async def search(
        self,
        vault_id: str,
        query: str,
        mode: str = "hybrid",
        top_k: int = 8,
        tags: list[str] | None = None,
        scopes: list[str] | None = None,
        threshold: float | None = None,
        rerank: bool = False,
    ) -> list[KnowledgeSearchResult]: ...

    async def read(
        self,
        vault_id: str,
        paths: list[str],
        max_content_chars: int | None = None,
    ) -> list[KnowledgeNote]: ...

    async def graph(
        self,
        vault_id: str,
        path: str,
        depth: int = 1,
        direction: str = "both",
    ) -> KnowledgeGraph: ...

    async def full_graph(
        self,
        vault_id: str,
        *,
        max_nodes: int | None = None,
        max_edges: int | None = None,
    ) -> KnowledgeGraph: ...

    async def create_note(self, vault_id: str, path: str, content: str) -> KnowledgeNote: ...

    async def save_note(self, vault_id: str, path: str, content: str) -> KnowledgeNote: ...

    async def patch_note(
        self,
        vault_id: str,
        path: str,
        target: str,
        operation: str,
        content: str,
    ) -> KnowledgeNote: ...

    async def append_note(
        self,
        vault_id: str,
        path: str,
        content: str,
        section: str | None = None,
    ) -> KnowledgeNote: ...

    async def set_frontmatter(
        self,
        vault_id: str,
        path: str,
        key: str,
        value: object,
    ) -> KnowledgeNote: ...

    async def update_tags(
        self,
        vault_id: str,
        path: str,
        add: list[str] | None = None,
        remove: list[str] | None = None,
    ) -> KnowledgeNote: ...

    async def reindex(self, vault_id: str, path: str | None = None) -> KnowledgeProviderStatus: ...


def _cfg(vault_id: str) -> KnowledgeVaultConfig:
    cfg = vault_store.require_vault_config(vault_id)
    if not cfg.enabled:
        raise KnowledgeDisabledError(f"vault disabled: {vault_id}")
    return cfg


def _truncate(content: str, max_chars: int | None) -> str:
    limit = max_chars if max_chars is not None else MAX_CONTENT_CHARS_DEFAULT
    if limit <= 0 or len(content) <= limit:
        return content
    return content[: limit - 3] + "..."


def _is_stale_mcp_session_error(exc: BaseException) -> bool:
    text = f"{type(exc).__name__} {exc}".lower()
    return any(
        token in text
        for token in (
            "closedresource",
            "broken pipe",
            "connection reset",
            "connection aborted",
            "eof",
            "stream closed",
        )
    )


async def _call_search_tool(
    cfg: Any,
    sess: Any,
    tool_name: str,
    args: dict[str, Any],
    *,
    timeout_sec: float = 60.0,
) -> Any:
    try:
        return await call_tool(sess.search_tools, tool_name, args, timeout_sec=timeout_sec)
    except Exception as exc:
        if not _is_stale_mcp_session_error(exc):
            raise
        logger.warning("search MCP session stale for vault %s, restarting: %s", cfg.id, exc)
        await drop_session(cfg.id)
        fresh = await ensure_session(cfg, force_reload=True)
        tool_name = _search_tool_name(fresh)
        return await call_tool(fresh.search_tools, tool_name, args, timeout_sec=timeout_sec)


def _parse_ohs_status(raw: Any) -> dict[str, Any]:
    from evoflow.knowledge.vault.normalize import _as_dict

    data = _as_dict(raw)
    return data if isinstance(data, dict) else {}


def _apply_ohs_status_fields(data: dict[str, Any], sess: Any | None) -> tuple[int | None, str | None, bool | None, bool | None]:
    """Return (note_count, last_indexed, index_initialized, semantic_ready)."""
    note_count = data.get("total") or data.get("noteCount") or data.get("notes") or data.get("count")
    if isinstance(note_count, str) and note_count.isdigit():
        note_count = int(note_count)
    last_indexed = data.get("last_indexed") or data.get("lastIndexedAt")
    indexed = data.get("indexed")
    pending = data.get("pending")
    index_initialized = None
    if indexed is not None or pending is not None:
        try:
            index_initialized = int(indexed or 0) > 0 and int(pending or 0) == 0
        except (TypeError, ValueError):
            index_initialized = bool(indexed)
    embedding_dim = data.get("embedding_dim") or data.get("embeddingDim")
    try:
        embedding_dim = int(embedding_dim) if embedding_dim is not None else None
    except (TypeError, ValueError):
        embedding_dim = None
    semantic_ready = bool(embedding_dim and embedding_dim > 0)
    if sess is not None:
        sess.embedding_dim = embedding_dim
        sess.embedding_model = str(data.get("model") or "") or None
        sess.semantic_ready = semantic_ready
    return (
        int(note_count) if isinstance(note_count, int) else None,
        str(last_indexed) if last_indexed else None,
        index_initialized,
        semantic_ready,
    )


async def _probe_obsidian(base_url: str, api_key: str | None) -> bool:
    url = base_url.rstrip("/") + "/"
    headers = {}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            resp = await client.get(url, headers=headers)
            return resp.status_code < 500
    except Exception:
        return False


def _search_tool_name(sess: Any) -> str:
    caps = getattr(sess, "search_capabilities", None)
    if caps is not None and caps.search_tool:
        return caps.search_tool
    # Fallbacks when caps missing (tests / degraded)
    for name in ("evo_kb_search", "search"):
        if name in sess.search_tools:
            return name
    raise RuntimeError("search tool not discovered")


def _read_tool_name(sess: Any) -> str:
    caps = getattr(sess, "search_capabilities", None)
    if caps is not None and caps.read_tool:
        return caps.read_tool
    for name in ("evo_kb_read", "read"):
        if name in sess.search_tools:
            return name
    raise RuntimeError("read tool not discovered")


def _reindex_tool_name(sess: Any) -> str:
    caps = getattr(sess, "search_capabilities", None)
    if caps is not None and caps.reindex_tool:
        return caps.reindex_tool
    for name in ("evo_kb_reindex", "reindex"):
        if name in sess.search_tools:
            return name
    raise RuntimeError("reindex tool not discovered")


def _status_tool_name(sess: Any) -> str:
    caps = getattr(sess, "search_capabilities", None)
    if caps is not None and caps.status_tool:
        return caps.status_tool
    for name in ("evo_kb_status", "status"):
        if name in sess.search_tools:
            return name
    raise RuntimeError("status tool not discovered")


def _write_tool_name(sess: Any, attr: str, candidates: tuple[str, ...]) -> str:
    caps = getattr(sess, "write_capabilities", None)
    if caps is not None:
        name = getattr(caps, attr, None)
        if name:
            return name
    for name in candidates:
        if name in sess.write_tools:
            return name
    raise RuntimeError(f"write tool not discovered: {attr}")


def _schema_for(sess: Any, tool_name: str) -> dict[str, Any] | None:
    caps = getattr(sess, "search_capabilities", None) or getattr(sess, "write_capabilities", None)
    if caps is None:
        return None
    return caps.schemas.get(tool_name)


class ObsidianKnowledgeProvider:
    """Obsidian vault provider via hybrid-search + write MCP servers."""

    async def status(self, vault_id: str) -> KnowledgeProviderStatus:
        cfg = vault_store.require_vault_config(vault_id)
        probe = probe_node_runtime()
        path_ok = vault_root_exists(cfg.vault_path)
        sess = get_ready_session(cfg.id) or get_session(cfg.id)
        mcp_ready = bool(sess and sess.search_tools and not getattr(sess, "search_unavailable", False))
        search_unavailable = bool(getattr(sess, "search_unavailable", False)) if sess else False
        write_ready = bool(sess and sess.write_tools and not getattr(sess, "write_unavailable", False))
        write_err = sess.write_error if sess else None
        search_err = sess.search_error if sess else None
        warming = False

        # Never block status on cold MCP boot — kick warmup and report filesystem readiness.
        if cfg.enabled and path_ok and not mcp_ready and not search_unavailable:
            warming = True
            schedule_session_warmup(cfg)
            # Do NOT put warmup copy into searchError — the panel treats searchError as a hard fault.
        else:
            warming = is_session_warming(cfg.id)

        from evoflow.knowledge.vault import secrets as vault_secrets
        from evoflow.knowledge.vault.paths import count_markdown_notes

        api_key = vault_secrets.get_secret(cfg.obsidian_api_key_secret_ref)
        obsidian_ok: bool | None = None
        if cfg.access_mode == AccessMode.read_write:
            obsidian_ok = await _probe_obsidian(cfg.obsidian_base_url, api_key)

        note_count: int | None = None
        last_indexed: str | None = None
        index_initialized: bool | None = None
        semantic_ready: bool | None = None
        embedding_model: str | None = None
        if mcp_ready and sess:
            try:
                status_name = _status_tool_name(sess)
                raw = await call_tool(sess.search_tools, status_name, {}, timeout_sec=15.0)
                data = _parse_ohs_status(raw)
                if data:
                    note_count, last_indexed, index_initialized, semantic_ready = _apply_ohs_status_fields(data, sess)
                    embedding_model = sess.embedding_model
                elif isinstance(raw, str) and "not" in raw.lower() and "index" in raw.lower():
                    index_initialized = False
                    semantic_ready = False
            except Exception as exc:
                search_err = sanitize_text(str(exc))

        if note_count is None and path_ok:
            try:
                note_count = count_markdown_notes(cfg.vault_path, ignore_patterns=cfg.ignore_patterns)
            except Exception:
                note_count = None
        if index_initialized is None and path_ok:
            index_initialized = bool(note_count)

        msg = ""
        if not cfg.enabled:
            msg = "Vault 已禁用"
        elif not path_ok:
            msg = "Vault 路径无效"
        elif warming and not mcp_ready:
            msg = "检索服务启动中；搜索会先走本地全文，就绪后自动加速"
        elif search_unavailable and search_err:
            msg = "检索加速服务暂不可用，已回退本地全文搜索"
        elif write_err and cfg.access_mode == AccessMode.read_write:
            msg = "知识检索仍然可用。写入功能需要启动 Obsidian 并启用 Local REST API。"

        rt = runtime_status_dict()
        return KnowledgeProviderStatus(
            vaultId=cfg.id,
            enabled=cfg.enabled,
            accessMode=cfg.access_mode,
            launchMode=cfg.launch_mode,
            vaultPathValid=path_ok,
            # Filesystem browse/search always works when path is valid — don't wait for MCP.
            searchReady=mcp_ready or (cfg.enabled and path_ok),
            writeReady=write_ready and cfg.access_mode == AccessMode.read_write,
            writeDegraded=bool(write_err) and cfg.access_mode == AccessMode.read_write,
            mcpReady=mcp_ready,
            mcpWarming=bool(warming and not mcp_ready),
            noteCount=int(note_count) if isinstance(note_count, int) else None,
            lastIndexedAt=str(last_indexed) if last_indexed else None,
            obsidianReachable=obsidian_ok,
            allowedReadPaths=list(cfg.allowed_read_paths),
            allowedWritePaths=list(cfg.allowed_write_paths),
            searchError=search_err,
            writeError=write_err,
            nodeRuntimeOk=bool(probe.node_ok),
            indexInitialized=index_initialized,
            semanticReady=semantic_ready if semantic_ready is not None else sess.semantic_ready if sess else None,
            embeddingModel=embedding_model or (sess.embedding_model if sess else None),
            runtimeStatus=rt,
            message=msg,
        )

    def _filesystem_search(
        self,
        cfg: KnowledgeVaultConfig,
        query: str,
        top_k: int,
    ) -> list[KnowledgeSearchResult]:
        results = filesystem_keyword_search(
            vault_id=cfg.id,
            vault_path=cfg.vault_path,
            query=query,
            top_k=top_k,
            ignore_patterns=cfg.ignore_patterns or "",
        )
        filtered: list[KnowledgeSearchResult] = []
        for r in results:
            if not r.path:
                filtered.append(r)
                continue
            try:
                assert_read_allowed(r.path, cfg.allowed_read_paths)
            except Exception:
                continue
            filtered.append(r)
        return filtered[:top_k]

    async def search(
        self,
        vault_id: str,
        query: str,
        mode: str = "hybrid",
        top_k: int = 8,
        tags: list[str] | None = None,
        scopes: list[str] | None = None,
        threshold: float | None = None,
        rerank: bool = False,
    ) -> list[KnowledgeSearchResult]:
        cfg = _cfg(vault_id)
        # Prefer warm MCP; never block the user for a long cold start.
        sess = None
        try:
            sess = await ensure_session(cfg, wait_sec=INTERACTIVE_MCP_WAIT_SEC)
        except Exception as exc:
            schedule_session_warmup(cfg)
            logger.info(
                "vault %s MCP not ready (%s); using filesystem search",
                vault_id,
                sanitize_text(str(exc)),
            )
            return self._filesystem_search(cfg, query, top_k)

        if mode in ("hybrid", "semantic") and sess.semantic_ready is None:
            try:
                status_name = _status_tool_name(sess)
                raw = await call_tool(sess.search_tools, status_name, {}, timeout_sec=8.0)
                _apply_ohs_status_fields(_parse_ohs_status(raw), sess)
            except Exception:
                sess.semantic_ready = False
        tool_name = _search_tool_name(sess)
        schema = _schema_for(sess, tool_name)
        effective_mode = mode
        vector_timeout = VECTOR_SEARCH_TIMEOUT_SEC
        if mode in ("hybrid", "semantic") and sess.semantic_ready is False:
            logger.info("vault %s semantic index unavailable, using fulltext instead of %s", vault_id, mode)
            effective_mode = "fulltext"
        args = build_search_arguments(
            query=query,
            mode=effective_mode,
            top_k=top_k,
            tags=tags,
            scopes=scopes,
            threshold=threshold,
            rerank=rerank if effective_mode == "hybrid" else False,
            schema=schema,
        )
        timeout_sec = vector_timeout if effective_mode in ("hybrid", "semantic") else FULLTEXT_SEARCH_TIMEOUT_SEC
        try:
            raw = await _call_search_tool(cfg, sess, tool_name, args, timeout_sec=timeout_sec)
        except Exception as exc:
            if mode in ("hybrid", "semantic") and effective_mode != "fulltext":
                logger.warning("search mode=%s failed, falling back to fulltext: %s", mode, exc)
                args = build_search_arguments(
                    query=query,
                    mode="fulltext",
                    top_k=top_k,
                    tags=tags,
                    scopes=scopes,
                    threshold=threshold,
                    rerank=False,
                    schema=schema,
                )
                try:
                    raw = await _call_search_tool(
                        cfg, sess, tool_name, args, timeout_sec=FULLTEXT_SEARCH_TIMEOUT_SEC
                    )
                except Exception as exc2:
                    logger.warning("MCP fulltext failed, filesystem fallback: %s", exc2)
                    return self._filesystem_search(cfg, query, top_k)
            elif isinstance(exc, ToolTimeoutError) or "timeout" in str(exc).lower():
                logger.warning("MCP search timed out, filesystem fallback: %s", exc)
                return self._filesystem_search(cfg, query, top_k)
            else:
                logger.warning("MCP search failed, filesystem fallback: %s", exc)
                return self._filesystem_search(cfg, query, top_k)
        results = normalize_search_results(vault_id, raw)
        filtered: list[KnowledgeSearchResult] = []
        for r in results:
            if not r.path:
                filtered.append(r)
                continue
            try:
                assert_read_allowed(r.path, cfg.allowed_read_paths)
            except Exception:
                continue
            if scopes:
                ok = any(r.path == s or r.path.startswith(s.rstrip("/") + "/") for s in scopes)
                if not ok:
                    continue
            filtered.append(r)
        filtered = filtered[:top_k]
        if filtered:
            return filtered
        # MCP empty (index not ready) → local keyword scan so answers still work.
        fb = self._filesystem_search(cfg, query, top_k)
        if fb:
            logger.info("vault %s MCP returned empty; filesystem fallback hits=%s", vault_id, len(fb))
        return fb

    async def read(
        self,
        vault_id: str,
        paths: list[str],
        max_content_chars: int | None = None,
    ) -> list[KnowledgeNote]:
        cfg = _cfg(vault_id)
        if not paths:
            return []
        if len(paths) > MAX_READ_PATHS:
            paths = paths[:MAX_READ_PATHS]
        safe_paths = [assert_read_allowed(p, cfg.allowed_read_paths) for p in paths]
        for p in safe_paths:
            resolve_inside_vault(cfg.vault_path, p)

        # Disk is the source of truth for note body (matches save_note).
        # MCP read often returns metadata-only / empty content depending on tool version.
        notes_by_path: dict[str, KnowledgeNote] = {}
        for p in safe_paths:
            abs_path = resolve_inside_vault(cfg.vault_path, p)
            try:
                text = abs_path.read_text(encoding="utf-8")
            except OSError:
                logger.debug("vault read: filesystem miss for %s/%s", vault_id, p, exc_info=True)
                continue
            parsed = normalize_notes(vault_id, {"path": p, "content": text})
            if parsed:
                notes_by_path[p] = parsed[0]

        # Optional MCP enrichment (backlinks / frontmatter) — never overwrite disk content.
        # Skip cold boot: enrichment is optional and must not stall reads.
        try:
            sess = get_ready_session(cfg.id)
            if sess is None:
                schedule_session_warmup(cfg)
            else:
                tool_name = _read_tool_name(sess)
                schema = _schema_for(sess, tool_name)
                args = build_read_arguments(safe_paths, related=True, schema=schema)
                raw = await call_tool(sess.search_tools, tool_name, args, timeout_sec=12.0)
                for mcp_note in normalize_notes(vault_id, raw):
                    key = str(mcp_note.path or "").strip()
                    if not key:
                        continue
                    existing = notes_by_path.get(key)
                    if existing is None:
                        # Only accept MCP note when it actually has body text.
                        if (mcp_note.content or "").strip():
                            notes_by_path[key] = mcp_note
                        continue
                    if mcp_note.backlinks and not existing.backlinks:
                        existing.backlinks = list(mcp_note.backlinks)
                    if mcp_note.frontmatter and not existing.frontmatter:
                        existing.frontmatter = dict(mcp_note.frontmatter)
                    if mcp_note.tags and not existing.tags:
                        existing.tags = list(mcp_note.tags)
                    if mcp_note.aliases and not existing.aliases:
                        existing.aliases = list(mcp_note.aliases)
                    if mcp_note.links and not existing.links:
                        existing.links = list(mcp_note.links)
        except Exception:
            logger.debug("vault read: MCP enrichment skipped for %s", vault_id, exc_info=True)

        notes = [notes_by_path[p] for p in safe_paths if p in notes_by_path]
        for n in notes:
            n.content = _truncate(n.content, max_content_chars)
        return notes

    async def graph(
        self,
        vault_id: str,
        path: str,
        depth: int = 1,
        direction: str = "both",
    ) -> KnowledgeGraph:
        """Local graph via related search — never semantic search for edges."""
        depth = max(1, min(int(depth or 1), MAX_GRAPH_DEPTH))
        rel = normalize_vault_relative_path(path)
        cfg = _cfg(vault_id)
        assert_read_allowed(rel, cfg.allowed_read_paths)
        sess = await ensure_session(cfg)
        tool_name = _search_tool_name(sess)
        schema = _schema_for(sess, tool_name)
        args = build_related_graph_arguments(
            path=rel,
            depth=depth,
            direction=direction,
            schema=schema,
        )
        raw = await call_tool(sess.search_tools, tool_name, args)
        return build_graph_from_related_search(
            vault_id,
            rel,
            raw,
            depth=depth,
            direction=direction,
            max_nodes=MAX_GRAPH_NODES,
            max_edges=MAX_GRAPH_EDGES,
        )

    async def full_graph(self, vault_id: str, *, max_nodes: int | None = None, max_edges: int | None = None) -> KnowledgeGraph:
        """Full vault graph built directly from the OHS SQLite index.

        Returns every note as a node and every wikilink as an edge, capped by
        MAX_FULL_GRAPH_NODES / MAX_FULL_GRAPH_EDGES to avoid rendering blowups.
        No center path — this is the whole-vault bird's-eye view.
        """
        import sqlite3
        from pathlib import Path

        from evoflow.knowledge.vault.constants import MAX_FULL_GRAPH_EDGES, MAX_FULL_GRAPH_NODES

        cfg = _cfg(vault_id)
        vault_path = Path(cfg.vault_path)
        db_path = vault_path / ".obsidian-hybrid-search.db"
        if not db_path.is_file():
            return KnowledgeGraph(centerPath="", depth=0, nodes=[], edges=[], unresolved=[], truncated=False)

        max_n = int(max_nodes or MAX_FULL_GRAPH_NODES)
        max_e = int(max_edges or MAX_FULL_GRAPH_EDGES)
        truncated = False

        conn = sqlite3.connect(str(db_path))
        try:
            conn.row_factory = sqlite3.Row
            cur = conn.cursor()

            cur.execute("SELECT path, title, tags FROM notes ORDER BY path LIMIT ?", (max_n + 1,))
            note_rows = cur.fetchall()
            if len(note_rows) > max_n:
                truncated = True
                note_rows = note_rows[:max_n]

            nodes_by_path: dict[str, KnowledgeGraphNode] = {}
            for row in note_rows:
                path = row["path"]
                tags_raw = row["tags"] or ""
                tags = [t.strip() for t in tags_raw.split(",") if t.strip()] if isinstance(tags_raw, str) else []
                nodes_by_path[path] = KnowledgeGraphNode(
                    id=path,
                    path=path,
                    title=row["title"] or _title_from_path(path),
                    tags=tags,
                )

            cur.execute(
                "SELECT from_path, to_path FROM links WHERE from_path IN ({seq}) AND to_path IN ({seq}) LIMIT ?".format(
                    seq=",".join("?" * len(nodes_by_path))
                ),
                list(nodes_by_path.keys()) + list(nodes_by_path.keys()) + [max_e + 1],
            )
            link_rows = cur.fetchall()
            if len(link_rows) > max_e:
                truncated = True
                link_rows = link_rows[:max_e]

            edges: list[KnowledgeGraphEdge] = []
            unresolved: list[str] = []
            for row in link_rows:
                src = row["from_path"]
                tgt = row["to_path"]
                if src not in nodes_by_path or tgt not in nodes_by_path:
                    if src not in nodes_by_path and src not in unresolved:
                        unresolved.append(src)
                    if tgt not in nodes_by_path and tgt not in unresolved:
                        unresolved.append(tgt)
                    continue
                edges.append(KnowledgeGraphEdge(source=src, target=tgt, type="wikilink"))

        finally:
            conn.close()

        return KnowledgeGraph(
            centerPath="",
            depth=0,
            nodes=list(nodes_by_path.values()),
            edges=edges,
            unresolved=unresolved,
            truncated=truncated,
        )

    async def _require_write(self, vault_id: str) -> tuple[KnowledgeVaultConfig, Any]:
        cfg = _cfg(vault_id)
        if cfg.access_mode != AccessMode.read_write:
            raise WriteDisabledError("vault is read-only; enable read_write in settings")
        sess = await ensure_session(cfg, need_write=True)
        if not sess.write_tools:
            raise ObsidianNotRunningError(
                "写入服务不可用。请启动 Obsidian 并启用 Local REST API。知识检索仍然可用。"
            )
        return cfg, sess

    async def create_note(self, vault_id: str, path: str, content: str) -> KnowledgeNote:
        cfg, sess = await self._require_write(vault_id)
        rel = assert_write_allowed(path, cfg.allowed_write_paths)
        abs_path = resolve_inside_vault(cfg.vault_path, rel)
        if abs_path.exists():
            raise NoteConflictError(f"note already exists: {rel}", code="note_conflict")

        tool_name = _write_tool_name(sess, "write_note_tool", ("obsidian_write_note", "write_note"))
        raw = await call_tool(
            sess.write_tools,
            tool_name,
            {"path": rel, "content": content, "mode": "create"},
        )
        notes = normalize_notes(vault_id, raw if raw else {"path": rel, "content": content})
        if cfg.auto_reindex:
            try:
                await self.reindex(vault_id, path=rel)
            except Exception:
                logger.debug("reindex after create failed", exc_info=True)
        return notes[0] if notes else KnowledgeNote(vaultId=vault_id, path=rel, content=content)

    async def save_note(self, vault_id: str, path: str, content: str) -> KnowledgeNote:
        """Overwrite an existing note on disk (read_write vaults)."""
        cfg = _cfg(vault_id)
        if cfg.access_mode != AccessMode.read_write:
            raise WriteDisabledError("vault is read-only; enable read_write in settings")
        rel = assert_write_allowed(path, cfg.allowed_write_paths)
        abs_path = resolve_inside_vault(cfg.vault_path, rel)
        if not abs_path.is_file():
            raise NoteConflictError(f"note not found: {rel}", code="note_not_found")
        abs_path.write_text(content, encoding="utf-8")
        if cfg.auto_reindex:
            try:
                await self.reindex(vault_id, path=rel)
            except Exception:
                logger.debug("reindex after save failed", exc_info=True)

        return KnowledgeNote(
            vaultId=vault_id,
            path=rel,
            title=_title_from_path(rel),
            content=content,
        )

    async def patch_note(
        self,
        vault_id: str,
        path: str,
        target: str,
        operation: str,
        content: str,
    ) -> KnowledgeNote:
        cfg, sess = await self._require_write(vault_id)
        rel = assert_write_allowed(path, cfg.allowed_write_paths)
        resolve_inside_vault(cfg.vault_path, rel)
        tool_name = _write_tool_name(sess, "patch_tool", ("obsidian_patch_note", "patch_note"))
        raw = await call_tool(
            sess.write_tools,
            tool_name,
            {
                "path": rel,
                "target": target,
                "operation": operation,
                "content": content,
            },
        )
        if cfg.auto_reindex:
            try:
                await self.reindex(vault_id, path=rel)
            except Exception:
                logger.debug("reindex after patch failed", exc_info=True)
        notes = normalize_notes(vault_id, raw)
        return notes[0] if notes else KnowledgeNote(vaultId=vault_id, path=rel, content=content)

    async def append_note(
        self,
        vault_id: str,
        path: str,
        content: str,
        section: str | None = None,
    ) -> KnowledgeNote:
        cfg, sess = await self._require_write(vault_id)
        rel = assert_write_allowed(path, cfg.allowed_write_paths)
        args: dict[str, Any] = {"path": rel, "content": content}
        if section:
            args["section"] = section
        tool_name = _write_tool_name(sess, "append_tool", ("obsidian_append_to_note", "append_to_note"))
        raw = await call_tool(sess.write_tools, tool_name, args)
        if cfg.auto_reindex:
            try:
                await self.reindex(vault_id, path=rel)
            except Exception:
                logger.debug("reindex after append failed", exc_info=True)
        notes = normalize_notes(vault_id, raw)
        return notes[0] if notes else KnowledgeNote(vaultId=vault_id, path=rel, content=content)

    async def set_frontmatter(
        self,
        vault_id: str,
        path: str,
        key: str,
        value: object,
    ) -> KnowledgeNote:
        cfg, sess = await self._require_write(vault_id)
        rel = assert_write_allowed(path, cfg.allowed_write_paths)
        tool_name = _write_tool_name(
            sess, "frontmatter_tool", ("obsidian_manage_frontmatter", "manage_frontmatter")
        )
        raw = await call_tool(
            sess.write_tools,
            tool_name,
            {"path": rel, "key": key, "value": value, "operation": "set"},
        )
        notes = normalize_notes(vault_id, raw)
        return notes[0] if notes else KnowledgeNote(vaultId=vault_id, path=rel)

    async def update_tags(
        self,
        vault_id: str,
        path: str,
        add: list[str] | None = None,
        remove: list[str] | None = None,
    ) -> KnowledgeNote:
        cfg, sess = await self._require_write(vault_id)
        rel = assert_write_allowed(path, cfg.allowed_write_paths)
        tool_name = _write_tool_name(sess, "tags_tool", ("obsidian_manage_tags", "manage_tags"))
        raw = await call_tool(
            sess.write_tools,
            tool_name,
            {"path": rel, "add": add or [], "remove": remove or []},
        )
        notes = normalize_notes(vault_id, raw)
        return notes[0] if notes else KnowledgeNote(vaultId=vault_id, path=rel)

    async def reindex(self, vault_id: str, path: str | None = None) -> KnowledgeProviderStatus:
        cfg = _cfg(vault_id)
        sess = await ensure_session(cfg)
        tool_name = _reindex_tool_name(sess)
        args: dict[str, Any] = {}
        if path:
            args["path"] = normalize_vault_relative_path(path)
        # Full vault reindex can exceed the default 60s tool timeout (esp. cold start).
        await call_tool(sess.search_tools, tool_name, args, timeout_sec=600.0)
        return await self.status(vault_id)

    async def ingest(
        self,
        vault_id: str,
        *,
        title: str,
        content: str,
        summary: str = "",
        source: str = "evoflow",
        source_description: str = "",
        confidence: float = 0.7,
        tags: list[str] | None = None,
        related_paths: list[str] | None = None,
        inbox_path: str | None = None,
    ) -> dict[str, Any]:
        """Search duplicates then create into Inbox (no auto-merge)."""
        cfg = _cfg(vault_id)
        duplicates = await self.search(vault_id, title, mode="hybrid", top_k=5)
        dup_candidates = [
            {"path": d.path, "title": d.title, "score": d.score, "snippet": d.snippet}
            for d in duplicates
            if d.path
        ]
        folder = (inbox_path or cfg.default_inbox_path or "00-Inbox").strip().strip("/")
        filename = inbox_filename(title)
        rel = f"{folder}/{filename}"
        body = render_inbox_note(
            title=title,
            content=content,
            summary=summary,
            source=source,
            source_description=source_description or f"Ingested by EvoFlow from {source}",
            confidence=confidence,
            tags=tags,
            related_paths=related_paths,
        )
        note = await self.create_note(vault_id, rel, body)
        return {
            "note": note.model_dump(by_alias=True, mode="json"),
            "duplicates": dup_candidates,
            "path": rel,
        }


def obsidian_open_uri(vault_name: str, file_path: str) -> str:
    """Build obsidian://open URI."""
    return f"obsidian://open?vault={quote(vault_name)}&file={quote(file_path)}"


def vault_has_obsidian_config(vault_path: str) -> bool:
    return has_obsidian_marker(vault_path)


_PROVIDER: ObsidianKnowledgeProvider | None = None


def get_knowledge_provider() -> ObsidianKnowledgeProvider:
    global _PROVIDER
    if _PROVIDER is None:
        _PROVIDER = ObsidianKnowledgeProvider()
    return _PROVIDER
