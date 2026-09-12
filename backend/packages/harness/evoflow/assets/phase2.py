"""Phase 2 Asset Hub consolidation — inbox → standing / MEMORY / craft.

runtime-aligned semantics without a tool-calling git workspace agent:
mechanically merge Phase1 ``raw_*`` + notes, then one LLM JSON rewrite of
durable artifacts. Triggered from the memory debounce queue after Phase1.
"""

from __future__ import annotations

import json
import logging
import re
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from evoflow.assets.catalog import parse_frontmatter
from evoflow.assets.guidance import resolve_session_entity
from evoflow.assets.pipeline_config import asset_phase2_enabled, max_inbox_for_consolidation
from evoflow.assets.usage import usage_recency_score
from evoflow.assets.hub import ensure_entity_tree, write_text_file
from evoflow.assets.paths import EntityRef, entity_relative_dir, entity_root, resolve_entity_file
from evoflow.assets.prompt_templates import load_memory_prompt, render_memory_prompt

logger = logging.getLogger(__name__)

_SLUG_SAFE = re.compile(r"[^a-z0-9_-]+")
_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()

_PHASE2_JSON_CONTRACT = """
============================================================
EVOFLOW OUTPUT CONTRACT (STRICT — no tools / no apply_patch)
============================================================

You cannot edit files directly. Return exactly ONE JSON object (no markdown fence,
no prose outside JSON) with these keys:

- `noop` (boolean): true when there is no meaningful durable update worth writing
- `standing_md` (string): full contents of memory/standing.md; first line MUST be exactly `v1`
- `memory_md` (string): full contents of memory/MEMORY.md following the Task Group format
- `craft` (array, optional): zero or more reusable procedures
  - each item: `{"slug":"kebab-name","title":"...","skill_md":"..."}`
  - `skill_md` is the full SKILL.md body (frontmatter optional; will be normalized)
- `facts` (array, optional): zero or more fact files under memory/facts/
  - each item: `{"filename":"short-slug.md","content":"..."}` (include YAML frontmatter
    with title + summary when possible)

When `noop` is true, still return empty strings / empty arrays for the file fields.
Follow all format rules from the consolidation system prompt for standing and MEMORY.
Redact secrets as [REDACTED_SECRET].
"""


def _entity_key(entity: EntityRef) -> str:
    e = entity.normalized()
    return f"{e.entity_type}:{e.entity_id}"


@contextmanager
def entity_phase2_lock(entity: EntityRef) -> Iterator[None]:
    key = _entity_key(entity)
    with _locks_guard:
        lock = _locks.setdefault(key, threading.Lock())
    acquired = lock.acquire(timeout=120)
    if not acquired:
        raise TimeoutError(f"phase2 lock timeout for {key}")
    try:
        yield
    finally:
        lock.release()


def _extract_text(content: Any) -> str | None:
    if content is None:
        return None
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict) and block.get("type") == "text":
                parts.append(str(block.get("text") or ""))
            else:
                text = getattr(block, "text", None)
                if text:
                    parts.append(str(text))
        joined = "".join(parts).strip()
        return joined or None
    text = getattr(content, "text", None)
    if isinstance(text, str) and text.strip():
        return text
    return None


def _read_rel(entity: EntityRef, rel: str, *, max_chars: int = 24_000) -> str:
    path = resolve_entity_file(entity, rel)
    if not path.is_file():
        return ""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return ""
    if len(text) > max_chars:
        return text[: max_chars - 1] + "…"
    return text


def list_inbox_pending(entity: EntityRef, *, limit: int | None = None) -> list[Path]:
    """Pending Phase1 raw_* and ad-hoc notes (not README / not _done).

    Ranked by recency (native-style usage ordering) and capped for Phase2 input.
    """
    ensure_entity_tree(entity)
    root = entity_root(entity)
    inbox = root / "memory" / "_inbox"
    pending: list[Path] = []
    if not inbox.is_dir():
        return pending
    for p in sorted(inbox.glob("raw_*.md")):
        if not p.is_file():
            continue
        # Merge artifact, not a Phase1 source
        if p.name.lower() == "raw_memories.md":
            continue
        pending.append(p)
    notes = inbox / "notes"
    if notes.is_dir():
        for p in sorted(notes.glob("*.md")):
            if p.is_file() and p.name.lower() != "readme.md":
                pending.append(p)
    cap = max(1, int(limit if limit is not None else max_inbox_for_consolidation()))
    scored: list[tuple[float, Path]] = []
    for path in pending:
        try:
            text = path.read_text(encoding="utf-8")
            meta, _ = parse_frontmatter(text)
        except OSError:
            meta = {}
        scored.append((usage_recency_score(meta, path), path))
    scored.sort(key=lambda row: row[0], reverse=True)
    return [path for _, path in scored[:cap]]


def rebuild_raw_memories_file(entity: EntityRef) -> tuple[str, list[str]]:
    """Mechanically merge pending inbox into ``memory/_inbox/raw_memories.md``.

    Returns (merged_text, relative_paths_consumed).
    """
    ensure_entity_tree(entity)
    pending = list_inbox_pending(entity)
    chunks: list[str] = []
    rels: list[str] = []
    root = entity_root(entity)
    for path in pending:
        try:
            body = path.read_text(encoding="utf-8").strip()
        except OSError:
            continue
        if not body:
            continue
        rel = path.relative_to(root).as_posix()
        rels.append(rel)
        chunks.append(f"<!-- source: {rel} -->\n{body}\n")
    merged = "\n---\n\n".join(chunks).strip()
    write_text_file(entity, "memory/_inbox/raw_memories.md", merged + ("\n" if merged else ""))
    return merged, rels


def _write_phase2_diff_stub(entity: EntityRef, pending_rels: list[str]) -> str:
    """Synthetic diff artifact (runtime uses git; we list pending inbox paths)."""
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    lines = [
        "# phase2_workspace_diff",
        "",
        "Generated by EvoFlow before Phase 2 memory consolidation. Read this first; do not edit it.",
        "",
        f"generated_at: {now}",
        "mode: inbox_pending (no git baseline)",
        "",
        "## Added or modified (ingestion queue)",
        "",
    ]
    if pending_rels:
        for rel in pending_rels:
            lines.append(f"- {rel}")
    else:
        lines.append("- (none)")
    lines.append("")
    text = "\n".join(lines)
    write_text_file(entity, "memory/_inbox/phase2_workspace_diff.md", text)
    return text


def _list_craft_snippets(entity: EntityRef, *, max_files: int = 12, max_chars: int = 1500) -> str:
    craft_dir = entity_root(entity) / "craft"
    if not craft_dir.is_dir():
        return "(no craft yet)"
    parts: list[str] = []
    count = 0
    for skill in sorted(craft_dir.rglob("SKILL.md")):
        if count >= max_files:
            parts.append("…(truncated)")
            break
        try:
            text = skill.read_text(encoding="utf-8")
        except OSError:
            continue
        rel = skill.relative_to(entity_root(entity)).as_posix()
        parts.append(f"### {rel}\n{text[:max_chars]}")
        count += 1
    return "\n\n".join(parts) if parts else "(no craft yet)"


def _list_recent_episodic(entity: EntityRef, *, limit: int = 8, max_chars: int = 1200) -> str:
    ep_dir = entity_root(entity) / "memory" / "episodic"
    if not ep_dir.is_dir():
        return "(none)"
    files = sorted(
        [p for p in ep_dir.glob("*.md") if p.is_file()],
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    parts: list[str] = []
    try:
        from evoflow.assets.usage import asset_is_stale
    except Exception:
        asset_is_stale = None  # type: ignore[assignment]
    for path in files:
        if len(parts) >= limit:
            break
        rel = path.relative_to(entity_root(entity)).as_posix()
        if asset_is_stale is not None:
            try:
                if asset_is_stale(entity, rel):
                    continue
            except Exception:
                pass
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            continue
        parts.append(f"### {rel}\n{text[:max_chars]}")
    return "\n\n".join(parts) if parts else "(none)"


def _parse_phase2_json(raw: str) -> dict[str, Any]:
    text = str(raw or "").strip()
    if text.startswith("```"):
        lines = text.split("\n")
        text = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        raise json.JSONDecodeError("no json object", text, 0)
    data = json.loads(text[start : end + 1])
    if not isinstance(data, dict):
        raise ValueError("phase2 response must be a JSON object")
    return data


def _normalize_standing(text: str) -> str:
    body = str(text or "").strip()
    if not body:
        return "v1\n\n# 站立摘要\n\n（暂无高密度摘要）\n"
    if not body.startswith("v1"):
        body = "v1\n\n" + body.lstrip()
    lines = body.splitlines()
    if lines[0].strip() != "v1":
        lines[0] = "v1"
        body = "\n".join(lines)
    return body if body.endswith("\n") else body + "\n"


def _slug(name: str) -> str:
    s = _SLUG_SAFE.sub("-", str(name or "").strip().lower()).strip("-")
    return (s[:48].strip("-") or "craft")


def _archive_pending(entity: EntityRef, pending_rels: list[str]) -> list[str]:
    """Move consumed inbox files under ``_inbox/_done/`` (never destroy notes permanently)."""
    ensure_entity_tree(entity)
    root = entity_root(entity)
    done_root = root / "memory" / "_inbox" / "_done"
    done_root.mkdir(parents=True, exist_ok=True)
    moved: list[str] = []
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    for rel in pending_rels:
        src = resolve_entity_file(entity, rel)
        if not src.is_file():
            continue
        if "/notes/" in rel.replace("\\", "/"):
            dest_dir = done_root / "notes"
        else:
            dest_dir = done_root
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / f"{stamp}-{src.name}"
        try:
            src.replace(dest)
            moved.append(dest.relative_to(root).as_posix())
        except OSError as exc:
            logger.warning("phase2 archive failed %s: %s", rel, exc)
    return moved


def _apply_phase2_writes(
    entity: EntityRef,
    data: dict[str, Any],
    *,
    pending_rels: list[str],
) -> dict[str, Any]:
    paths: list[str] = []
    noop = bool(data.get("noop"))

    if not noop:
        standing = _normalize_standing(str(data.get("standing_md") or ""))
        memory_md = str(data.get("memory_md") or "").strip()
        if not memory_md:
            memory_md = _read_rel(entity, "memory/MEMORY.md") or "# MEMORY\n\n（暂无手册条目）\n"

        write_text_file(entity, "memory/standing.md", standing)
        paths.append("memory/standing.md")
        write_text_file(
            entity,
            "memory/MEMORY.md",
            memory_md if memory_md.endswith("\n") else memory_md + "\n",
        )
        paths.append("memory/MEMORY.md")

        craft_items = data.get("craft") or []
        if isinstance(craft_items, list):
            for item in craft_items:
                if not isinstance(item, dict):
                    continue
                slug = _slug(str(item.get("slug") or item.get("title") or "craft"))
                title = str(item.get("title") or slug).strip() or slug
                skill = str(item.get("skill_md") or "").strip()
                if not skill:
                    continue
                if not skill.lstrip().startswith("---"):
                    skill = (
                        f"---\nname: {title}\ndescription: {title[:80]}\n"
                        f"summary: {title[:30]}\nsource: phase2\n---\n\n{skill}\n"
                    )
                rel = f"craft/{slug}/SKILL.md"
                write_text_file(entity, rel, skill if skill.endswith("\n") else skill + "\n")
                paths.append(rel)

        fact_items = data.get("facts") or []
        if isinstance(fact_items, list):
            for item in fact_items:
                if not isinstance(item, dict):
                    continue
                fname = str(item.get("filename") or "").strip().replace("\\", "/")
                content = str(item.get("content") or "").strip()
                if not fname or not content:
                    continue
                fname = Path(fname).name
                if not fname.endswith(".md"):
                    fname = f"{fname}.md"
                if not re.match(r"^[a-zA-Z0-9_.-]+$", fname):
                    continue
                rel = f"memory/facts/{fname}"
                write_text_file(entity, rel, content if content.endswith("\n") else content + "\n")
                paths.append(rel)

    # Always archive consumed inbox so the queue does not re-fire forever.
    archived = _archive_pending(entity, pending_rels)
    rebuild_raw_memories_file(entity)

    if noop:
        return {"ok": True, "skipped": "no_signal", "paths": paths, "archived": archived}
    return {
        "ok": True,
        "paths": paths,
        "archived": archived,
    }


def run_phase2_consolidate(
    *,
    agent_name: str | None = None,
    model_name: str | None = None,
    entity: EntityRef | None = None,
) -> dict[str, Any]:
    """Consolidate pending inbox into durable standing / MEMORY / craft.

    Returns ``{ok, skipped?, paths?, error?}``.
    """
    if not asset_phase2_enabled():
        return {"ok": False, "skipped": "disabled"}

    try:
        from evoflow.config.memory_config import get_memory_config

        if not get_memory_config().enabled:
            return {"ok": False, "skipped": "memory_disabled"}
    except Exception:
        pass

    try:
        ent = entity or resolve_session_entity(agent_name=agent_name)
        ensure_entity_tree(ent)
    except Exception as exc:
        return {"ok": False, "error": f"entity:{exc}"}

    pending = list_inbox_pending(ent)
    if not pending:
        return {"ok": False, "skipped": "inbox_empty"}

    with entity_phase2_lock(ent):
        pending = list_inbox_pending(ent)
        if not pending:
            return {"ok": False, "skipped": "inbox_empty"}

        merged, pending_rels = rebuild_raw_memories_file(ent)
        if not merged.strip():
            return {"ok": False, "skipped": "inbox_empty"}

        diff_text = _write_phase2_diff_stub(ent, pending_rels)
        entity_rel = entity_relative_dir(ent)
        system = render_memory_prompt(
            "consolidation",
            entity_root=f"assets/{entity_rel}",
            phase2_workspace_diff_file="memory/_inbox/phase2_workspace_diff.md",
            memory_extensions_folder_structure="",
            memory_extensions_primary_inputs="",
        )
        ad_hoc = load_memory_prompt("ad_hoc_instructions")
        standing = _read_rel(ent, "memory/standing.md")
        memory_md = _read_rel(ent, "memory/MEMORY.md")
        user = "\n\n".join(
            [
                _PHASE2_JSON_CONTRACT.strip(),
                ad_hoc.strip(),
                "## Current phase2_workspace_diff.md",
                diff_text[:8000],
                "## Current memory/_inbox/raw_memories.md",
                merged[:40_000],
                "## Current memory/standing.md",
                standing or "(missing)",
                "## Current memory/MEMORY.md",
                memory_md or "(missing)",
                "## Existing craft (snippets)",
                _list_craft_snippets(ent),
                "## Recent episodic (snippets)",
                _list_recent_episodic(ent),
            ]
        )

        try:
            from evoflow.config.memory_config import get_memory_config
            from evoflow.models import create_chat_model

            config = get_memory_config()
            name = config.model_name or model_name or None
            model = create_chat_model(name=name, thinking_enabled=False, invocation_kind="memory")
            logger.info(
                "[资产Phase2] 整合 entity=%s:%s pending=%d chars=%d",
                ent.entity_type,
                ent.entity_id,
                len(pending_rels),
                len(merged),
            )
            try:
                from langchain_core.messages import HumanMessage, SystemMessage

                response = model.invoke(
                    [SystemMessage(content=system), HumanMessage(content=user)]
                )
            except Exception:
                response = model.invoke(f"{system}\n\n---\n\n{user}")
            response_text = (_extract_text(getattr(response, "content", response)) or "").strip()
            parsed = _parse_phase2_json(response_text)
        except json.JSONDecodeError as exc:
            logger.warning(
                "[资产Phase2] JSON 解析失败 entity=%s:%s: %s",
                ent.entity_type,
                ent.entity_id,
                exc,
            )
            return {"ok": False, "error": "json_parse"}
        except Exception as exc:
            logger.exception(
                "[资产Phase2] LLM 失败 entity=%s:%s: %s",
                ent.entity_type,
                ent.entity_id,
                exc,
            )
            return {"ok": False, "error": str(exc)}

        try:
            result = _apply_phase2_writes(ent, parsed, pending_rels=pending_rels)
        except Exception as exc:
            logger.exception(
                "[资产Phase2] 写文件失败 entity=%s:%s: %s",
                ent.entity_type,
                ent.entity_id,
                exc,
            )
            return {"ok": False, "error": f"write:{exc}"}

        result["entityType"] = ent.entity_type
        result["entityId"] = ent.entity_id
        try:
            from evoflow.assets.usage import prune_done_inbox

            pruned = prune_done_inbox(ent)
            if pruned.get("deleted"):
                result["prunedDone"] = pruned.get("deleted")
        except Exception:
            logger.debug("phase2 prune_done_inbox skipped", exc_info=True)
        if result.get("skipped"):
            logger.info(
                "[资产Phase2] no-op entity=%s:%s",
                ent.entity_type,
                ent.entity_id,
            )
        else:
            logger.info(
                "[资产Phase2] 已写入 entity=%s:%s paths=%s archived=%s",
                ent.entity_type,
                ent.entity_id,
                result.get("paths"),
                result.get("archived"),
            )
        return result
