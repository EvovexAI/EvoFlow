"""Owned KB ``knowledge`` tool — unified search/read/list for the in-house RAG knowledge base.

Replaces the old Obsidian vault MCP ``knowledge`` tool. Provides a consistent interface
(search / read / list) against ``owned_service``.

Access control (agent-facing)::

    - ``main`` / 小V (``xiaomi``): platform admins — may list / search / read all KBs.
    - Ordinary employees: only ``knowledge_vault_ids`` bound to that agent.
      Empty binding → empty list / denied search / denied read.
    - Missing agent context fails closed (no full-catalog access).
"""

from __future__ import annotations

from typing import Any

from langchain.tools import ToolRuntime, tool
from langgraph.typing import ContextT

from evoflow.knowledge.owned import service as owned_service


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _hit_doc_id(h: dict[str, Any]) -> str:
    """Document id carried by a search hit, normalized across service shapes.

    ``search_all`` / kb-scoped search use camelCase (``docId``), the rerank path
    also sets ``doc_id``. Titles such as ``product-overview`` are display names,
    NOT valid ``action=read`` ids — only this value is, so it must stay visible
    in the model-facing output or read becomes unreachable from search.
    """
    for key in ("docId", "doc_id"):
        v = str(h.get(key) or "").strip()
        if v:
            return v
    return ""


def _format_hit(h: dict[str, Any], index: int) -> str:
    title = h.get("title") or h.get("fileName") or h.get("docId") or f"文档{index + 1}"
    score = h.get("rrfScore") or h.get("score") or 0
    score_str = f"{float(score):.3f}" if score else "—"
    snippet = (str(h.get("content") or "")[:400]).strip()
    chunk_kind = h.get("chunkKind") or h.get("chunk_kind") or "text"
    doc_id = _hit_doc_id(h)
    parts = [
        f"[{index + 1}] {title}",
        f"   分数: {score_str} | 类型: {chunk_kind}",
        # read 只认这个 ID；标题拿去 read 必然「未找到文档」。
        f"   docId: {doc_id}" if doc_id else "   docId: （未提供，无法 read）",
    ]
    tags = h.get("tags") or []
    if tags:
        parts.append(f"   标签: {' '.join(str(t) for t in tags[:6])}")
    if snippet:
        parts.append(f"   {snippet}")
    return "\n".join(parts)


def _format_doc(doc: dict[str, Any]) -> str:
    title = doc.get("title") or doc.get("fileName") or doc.get("id", "未知文档")
    status = doc.get("parseStatus") or doc.get("parse_status") or "unknown"
    tags = doc.get("tags") or []
    lines = [
        f"标题: {title}",
        f"ID: {doc.get('id')}",
        f"状态: {status}",
        f"标签: {', '.join(str(t) for t in tags[:10]) or '无'}",
        f"路径: {doc.get('folderPath') or '/'} / {doc.get('fileName') or ''}",
    ]
    summary = doc.get("summaryText") or doc.get("summary_text") or ""
    if summary:
        lines.append(f"摘要: {summary[:300]}")
    return "\n".join(lines)


def _resolve_doc_ref(doc_ref: str, kb_ids: list[str]) -> str:
    """Resolve a doc reference to a real ``kb_documents.id`` (``doc_…``).

    Search results only show titles, and models naturally pass the title back to
    ``action=read``. The registry lookup is keyed on the internal id, so a bare
    title used to fail with "未找到文档" even though the doc exists. Callers must
    pass the KB ids the current agent is allowed to read (ACL stays outside);
    exact title / file_name wins, substring is a fallback.
    Returns the input unchanged when nothing resolves.
    """
    raw = str(doc_ref or "").strip()
    if not raw or raw.startswith("doc_") or not kb_ids:
        return raw

    def norm(s: str) -> str:
        s = str(s or "").strip().casefold()
        for suf in (".md", ".txt", ".markdown"):
            if s.endswith(suf):
                s = s[: -len(suf)]
        # Models retype these ids with different separators/case; treat them alike.
        for ch in (" ", "/", "\\", "-", "_", "."):
            s = s.replace(ch, "")
        return s

    want = norm(raw)
    if not want:
        return raw

    partial: str | None = None
    for kb_id in kb_ids:
        try:
            docs = owned_service.list_documents(kb_id)
        except Exception:
            continue
        for d in docs or []:
            did = str(d.get("id") or "").strip()
            if not did:
                continue
            candidates = {norm(d.get("title")), norm(d.get("fileName"))}
            if want in candidates:
                return did
            if partial is None and any(c and want in c for c in candidates):
                partial = did
    return partial or raw


def _agent_code_from_runtime(runtime: ToolRuntime[ContextT, dict] | None) -> str:
    if runtime is None:
        return ""
    ctx = getattr(runtime, "context", None) or {}
    if isinstance(ctx, dict):
        for key in ("agent_name", "agent_id", "proactive_agent_code", "agent_code"):
            v = str(ctx.get(key) or "").strip()
            if v:
                return v
    cfg = getattr(runtime, "config", None) or {}
    if isinstance(cfg, dict):
        conf = cfg.get("configurable") if isinstance(cfg.get("configurable"), dict) else {}
        for key in ("agent_name", "agent_id", "proactive_agent_code", "agent_code"):
            v = str(conf.get(key) or "").strip()
            if v:
                return v
    return ""


def _is_platform_kb_admin(agent_code: str | None) -> bool:
    """主智能体 / 小V — only these may see the full KB catalog via the tool."""
    code = str(agent_code or "").strip()
    if not code:
        return False
    low = code.lower()
    if low in {"main", "lead_agent"}:
        return True
    try:
        from evoflow.agents.xiaomi.identity import is_xiaomi_agent

        return bool(is_xiaomi_agent(code))
    except Exception:
        return low in {"xiaomi", "小v", "小蜜", "xiaov"}


def _resolve_bound_kb_id(vault_or_kb_id: str) -> str | None:
    """Map a bound vault alias / KB id to a concrete ``kb_bases.id``."""
    vid = str(vault_or_kb_id or "").strip()
    if not vid:
        return None
    try:
        base = owned_service.get_base(vid)
        if base is not None and base.get("id"):
            return str(base["id"])
    except Exception:
        pass
    try:
        from evoflow.knowledge.owned.db import db as _own_db

        with _own_db() as conn:
            row = conn.execute(
                "SELECT id FROM kb_bases WHERE sync_vault_id=? AND deleted_at IS NULL LIMIT 1",
                (vid,),
            ).fetchone()
            if row and row["id"]:
                return str(row["id"])
    except Exception:
        pass
    return None


def _vault_ids_from_runtime(runtime: ToolRuntime[ContextT, dict] | None) -> list[str] | None:
    """WorkerProfile / step ``knowledge_vault_ids`` override from runtime context, if present."""
    if runtime is None:
        return None
    raw = None
    ctx = getattr(runtime, "context", None)
    if ctx is not None:
        if isinstance(ctx, dict):
            if "knowledge_vault_ids" in ctx:
                raw = ctx.get("knowledge_vault_ids")
        else:
            getter = getattr(ctx, "get", None)
            if callable(getter) and (
                "knowledge_vault_ids" in ctx
                or (hasattr(ctx, "_EXTRA") and "knowledge_vault_ids" in getattr(ctx, "_EXTRA", {}))
            ):
                raw = getter("knowledge_vault_ids")
            elif hasattr(ctx, "knowledge_vault_ids"):
                raw = getattr(ctx, "knowledge_vault_ids", None)
    if raw is None:
        cfg = getattr(runtime, "config", None) or {}
        if isinstance(cfg, dict):
            conf = cfg.get("configurable") if isinstance(cfg.get("configurable"), dict) else {}
            if isinstance(conf, dict) and "knowledge_vault_ids" in conf:
                raw = conf.get("knowledge_vault_ids")
    if raw is None:
        return None
    if not isinstance(raw, (list, tuple)):
        return []
    return [str(x).strip() for x in raw if str(x).strip()]


def resolve_knowledge_tool_scope(
    agent_code: str | None,
    *,
    vault_ids_override: list[str] | None = None,
) -> tuple[bool, list[str]]:
    """Return ``(is_admin, allowed_kb_ids)``.

    ``is_admin=True`` → unrestricted (main / 小V).
    Otherwise ``allowed_kb_ids`` is the concrete owned-KB id allowlist (may be empty).
    When ``vault_ids_override`` is provided (worker step binding), it replaces agent binding
    and never elevates to platform admin.
    """
    if vault_ids_override is not None:
        seen: set[str] = set()
        out: list[str] = []
        for vid in vault_ids_override:
            kid = _resolve_bound_kb_id(vid)
            if kid and kid not in seen:
                seen.add(kid)
                out.append(kid)
        return False, out
    if _is_platform_kb_admin(agent_code):
        return True, []
    from evoflow.config.agents_config import get_agent_kb_vault_ids

    seen = set()
    out = []
    for vid in get_agent_kb_vault_ids(agent_code):
        kid = _resolve_bound_kb_id(vid)
        if kid and kid not in seen:
            seen.add(kid)
            out.append(kid)
    return False, out


def _kb_allowed(kb_id: str, *, is_admin: bool, allowed: list[str]) -> bool:
    if is_admin:
        return True
    kid = str(kb_id or "").strip()
    if not kid:
        return False
    if kid in allowed:
        return True
    # Caller may pass a sync_vault_id alias — resolve then re-check.
    resolved = _resolve_bound_kb_id(kid)
    return bool(resolved and resolved in allowed)


# ---------------------------------------------------------------------------
# Tool
# ---------------------------------------------------------------------------

_TOOL_DESCRIPTION = """**自研知识库**：在您有权限的知识库中搜索、阅读与列出文档。

**action=search** — 检索知识库（推荐默认操作）
- 搜索已索引的文档（关键词 + 向量混合检索）
- 知识库：留空仅搜索本岗绑定的知识库；也可指定具体 KB ID（须在权限范围内）
- 模式：hybrid（默认，兼顾关键词与语义）/ keyword / semantic
- topK：返回条数，默认 8
- 每条结果会给出一行 `docId: doc_…`，那是 read 唯一可用的 ID

**action=read** — 读取文档正文
- doc_id 必填，取 search 结果里的 `docId`（形如 `doc_…`）
- 也可以传文档标题，工具会在本岗有权的库内反查 ID
- 仅可读取权限范围内知识库的文档

**action=docs** — 列出某库的文档及其 ID
- knowledge_base 必填（KB ID）；query 可按标题过滤
- 想读某篇但手上没有 docId 时用它

**action=list** — 列出可用的知识库
- 普通员工：仅本岗绑定的知识库
- 主智能体 / 小V：可见全部知识库

**注意**：写入/导入需在面板「知识库」页面操作，不在此工具范围内。
"""


@tool("knowledge", description=_TOOL_DESCRIPTION, parse_docstring=False)
async def knowledge_tool(
    runtime: ToolRuntime[ContextT, dict],
    action: str = "search",
    *,
    query: str = "",
    doc_id: str = "",
    knowledge_base: str = "",
    mode: str = "hybrid",
    top_k: int = 8,
) -> str:
    """自研知识库 — 搜索 / 阅读 / 列文档 / 列出知识库（按员工绑定范围隔离）。

Args:
    action: 操作类型。search（默认）| read | docs | list
    query: 搜索关键词（search 必填；docs 可作标题过滤）
    doc_id: 文档 ID（read 必填；search 结果的 docId，也可传标题）
    knowledge_base: 知识库 ID，留空仅搜本岗绑定库（search / docs）
    mode: 检索模式。hybrid（默认）| keyword | semantic | title
    top_k: 返回条数，默认 8，上限 20
"""
    action = (action or "search").strip().lower()
    agent_code = _agent_code_from_runtime(runtime)
    is_admin, allowed = resolve_knowledge_tool_scope(
        agent_code,
        vault_ids_override=_vault_ids_from_runtime(runtime),
    )

    # ── list ──────────────────────────────────────────────────────────────
    if action == "list":
        try:
            bases = owned_service.list_bases()
        except Exception as exc:
            return f"列出知识库失败: {exc}"

        if not is_admin:
            allow_set = set(allowed)
            bases = [b for b in bases if str(b.get("id") or "") in allow_set]

        if not bases:
            if is_admin:
                return "当前没有可用的知识库。请在「知识库」页面创建一个知识库并导入文档。"
            return (
                "当前岗位未绑定任何知识库，无法列出。"
                "请管理员在员工能力里绑定 knowledge_vault_ids，或改用主智能体 / 小V。"
            )

        lines = [f"共 {len(bases)} 个知识库（{'平台全量' if is_admin else '本岗已绑定'}）：\n"]
        for b in bases:
            lines.append(
                f"  • [{b['id']}] {b.get('name') or '未命名'}"
                f"  | 文档 {b.get('documentCount', 0)} 篇"
                f"  | 向量 {'✅' if b.get('embeddingDim') else '❌'}"
            )
            desc = b.get("description") or ""
            if desc:
                lines.append(f"    说明: {desc[:120]}")
        lines.append("\n可用 action=search&knowledge_base=<id> 指定具体知识库。")
        return "\n".join(lines)

    # ── docs ──────────────────────────────────────────────────────────
    if action == "docs":
        kb_id = (knowledge_base or "").strip()
        if not kb_id:
            return (
                "action=docs 需要提供 knowledge_base 参数（知识库 ID）。"
                "先用 action=list 看有哪些库。"
            )
        if not _kb_allowed(kb_id, is_admin=is_admin, allowed=allowed):
            return f"无权访问知识库 `{kb_id}`（不在本岗绑定范围内）。"
        resolved = _resolve_bound_kb_id(kb_id) or kb_id
        try:
            docs = owned_service.list_documents(resolved)
        except Exception as exc:
            return f"列出文档失败: {exc}"
        if not docs:
            return f"知识库 `{resolved}` 暂无可读取的文档。"
        filt = str(query or "").strip().casefold()
        shown = [
            d
            for d in docs
            if not filt
            or filt in str(d.get("title") or "").casefold()
            or filt in str(d.get("fileName") or "").casefold()
        ]
        if not shown:
            return f"知识库 `{resolved}` 内没有标题匹配「{query}」的文档。"
        lines = [
            f"知识库 `{resolved}` 共 {len(docs)} 篇，匹配 {len(shown)} 篇"
            "（read 用下面这个 ID，不是标题）：\n"
        ]
        for d in shown[:100]:
            lines.append(
                f"  • {d.get('id')}  |  {d.get('title') or d.get('fileName') or '未命名'}"
                f"  |  {d.get('parseStatus') or d.get('parse_status') or '?'}"
            )
        if len(shown) > 100:
            lines.append(f"  …（其余 {len(shown) - 100} 篇未列出，可用 query 收窄）")
        return "\n".join(lines)

    # ── search ─────────────────────────────────────────────────────────
    if action == "search":
        q = (query or "").strip()
        if not q:
            return "action=search 需要提供 query 参数（搜索关键词）。"

        if not is_admin and not allowed:
            return (
                "当前岗位未绑定知识库，无法检索。"
                "请管理员绑定 knowledge_vault_ids，或改用主智能体 / 小V。"
            )

        top_k = max(1, min(int(top_k or 8), 20))
        mode = (mode or "hybrid").lower()
        if mode not in {"hybrid", "keyword", "semantic", "title"}:
            mode = "hybrid"

        kb_id = (knowledge_base or "").strip()

        try:
            if kb_id:
                if not _kb_allowed(kb_id, is_admin=is_admin, allowed=allowed):
                    return f"无权访问知识库 `{kb_id}`（不在本岗绑定范围内）。"
                resolved = _resolve_bound_kb_id(kb_id) or kb_id
                result = await owned_service.search(
                    resolved,
                    q,
                    mode=mode,
                    top_k=top_k,
                )
                base = owned_service.get_base(resolved)
                scope_label = f"知识库「{(base or {}).get('name') or resolved}」"
            else:
                result = await owned_service.search_all(
                    q,
                    mode=mode,
                    top_k=top_k,
                    kb_ids=None if is_admin else allowed,
                )
                scope_label = "平台全部知识库" if is_admin else f"本岗绑定的 {len(allowed)} 个知识库"
        except ValueError as exc:
            return f"搜索失败: {exc}"
        except Exception as exc:
            return f"搜索出错: {exc}"

        items = result.get("items") or []
        degraded = bool(result.get("degraded"))
        # A KB with no embedding model is keyword-only *by design* (lean installs,
        # skip_embedding publishing) — say so instead of implying it is broken.
        vector_configured = result.get("vectorConfigured", True)
        notes: list[str] = []
        if not vector_configured and mode != "keyword":
            note = "ℹ️ 该知识库未启用向量，本次按关键词检索（正常配置，不是故障）。"
            if mode in ("semantic", "vector"):
                note += "想要语义召回，请在知识库设置里绑定 embedding 模型后重建索引。"
            notes.append(note)
        elif degraded:
            # Configured for vectors but nothing came back: either the embedding
            # call failed or the index was never built. Say both, don't blame one.
            notes.append(
                "⚠️ 该库已启用向量但本次无向量召回（调用失败或未建索引），结果仅来自关键词检索。"
            )

        if not items:
            hints = [
                "没有找到相关结果。",
                "提示: 可换关键词、去掉 knowledge_base 限定范围，或用 action=docs 先确认库内有哪些文档。",
                "可在知识库详情页检查文档状态；PDF/Office 文档需先解析完成才能被检索。",
            ]
            return "\n".join(notes + hints) if notes else "\n".join(hints)

        lines = [f"在 {scope_label} 中找到 {len(items)} 条结果（{mode} 模式）：\n"]
        for i, h in enumerate(items):
            lines.append(_format_hit(h, i))
        lines.extend(f"\n{n}" for n in notes)
        return "\n".join(lines)

    # ── read ────────────────────────────────────────────────────────────
    if action == "read":
        did = (doc_id or "").strip()
        if not did:
            return "action=read 需要提供 doc_id 参数（文档 ID）。"

        if not is_admin and not allowed:
            return (
                "当前岗位未绑定知识库，无法读取文档。"
                "请管理员绑定 knowledge_vault_ids，或改用主智能体 / 小V。"
            )

        # Accept the title returned by search: models naturally pass it back, and
        # without this resolution read always failed with "未找到文档".
        try:
            if is_admin:
                scope_kb_ids = [str(b.get("id") or "") for b in owned_service.list_bases()]
            else:
                scope_kb_ids = list(allowed)
        except Exception:
            scope_kb_ids = list(allowed)
        did = _resolve_doc_ref(did, scope_kb_ids)

        try:
            owner_kb = owned_service._kb_id_for_doc(did)  # noqa: SLF001 — shared registry lookup
            if owner_kb and not _kb_allowed(owner_kb, is_admin=is_admin, allowed=allowed):
                return f"无权读取文档 doc_id={did}（所属知识库不在本岗绑定范围内）。"
            content = owned_service.get_document_content(did)
        except Exception as exc:
            return f"读取文档失败: {exc}"

        if not content:
            return (
                f"未找到文档 doc_id={did}，或文档已被删除。\n"
                "提示: read 只认 ``doc_…`` 形式的文档 ID —— 用 search 结果里每行的 "
                "``docId:`` 值；或 action=docs&knowledge_base=<库ID> 先列文档拿 ID。"
            )

        # Defense in depth: content may surface kb id under several keys.
        content_kb = str(
            content.get("kbId") or content.get("kb_id") or content.get("datasetId") or owner_kb or ""
        ).strip()
        if content_kb and not _kb_allowed(content_kb, is_admin=is_admin, allowed=allowed):
            return f"无权读取文档 doc_id={did}（所属知识库不在本岗绑定范围内）。"

        title = content.get("title") or content.get("fileName") or did
        lines = [
            f"=== {title} ===",
            f"ID: {did}",
            f"来源: {content.get('source', 'unknown')}",
            f"标签: {', '.join(str(t) for t in (content.get('tags') or [])[:12]) or '无'}",
        ]
        summary = content.get("summaryText") or ""
        if summary:
            lines.append(f"摘要: {summary[:300]}")
        body = content.get("content") or ""
        if body:
            lines.append(f"\n--- 正文（前 6000 字）---\n{body[:6000]}")
            if len(body) > 6000:
                lines.append(f"\n...（正文共 {len(body)} 字，已截断）")
        else:
            lines.append("\n（正文为空：文档可能还在解析中，或来源类型不支持预览）")
        return "\n".join(lines)

    # ── unknown action ────────────────────────────────────────────────
    return (
        f"未知 action={action}。支持的 action：search / read / list。"
        "\n示例: knowledge(action='search', query='项目架构', top_k=5)"
        "\n示例: knowledge(action='list')"
        "\n示例: knowledge(action='read', doc_id='doc_xxx')"
    )
