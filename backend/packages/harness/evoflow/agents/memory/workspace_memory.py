"""Workspace-scoped project memory — Asset Hub Markdown (same form as user assets).

SoT: ``~/.evoflow/assets/workspaces/{ws-hash}/`` with standing / facts / episodic / craft.
Injection: catalog only (title + 10–30字 summary); full text via read tools.
Legacy JSON memory-storage structure is no longer written or injected.
"""

from __future__ import annotations

import hashlib
import json
import logging
import shutil
import threading
from pathlib import Path
from typing import Any

from evoflow.agents.memory.updater import _extract_text
from evoflow.agents.memory.workspace_prompt import (
    WORKSPACE_BOOTSTRAP_PROMPT,
    WORKSPACE_UPDATE_PROMPT,
    collect_repository_context,
    format_conversation_for_workspace_update,
    format_workspace_module_index_for_update,
)
from evoflow.assets.catalog import (
    catalog_has_content,
    format_entity_catalog_xml,
    list_craft_catalog,
    list_episode_catalog,
    list_fact_catalog,
    read_standing_text,
)
from evoflow.assets.hub import (
    ensure_entity_tree,
    record_fact,
    save_craft_note,
    write_episode,
    write_text_file,
)
from evoflow.assets.injection_budget import TIER0_STANDING_CHARS, cap_text_chars
from evoflow.assets.paths import EntityRef, entity_root, workspace_entity_ref
from evoflow.config.memory_config import get_memory_config
from evoflow.models import create_chat_model
from evoflow.persistence.workspace_repositories import get_or_create_workspace, normalize_workspace_path
from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)


def workspace_scope_id(workspace_path: str) -> str:
    """Stable id ``ws-{hash}`` (also the Asset Hub ``entity_id``)."""
    return workspace_entity_ref(workspace_path).entity_id


def workspace_ref(workspace_path: str) -> EntityRef:
    return workspace_entity_ref(workspace_path)


def create_empty_workspace_memory(workspace_path: str) -> dict[str, Any]:
    """Ensure MD tree exists; return catalog snapshot (not legacy JSON schema)."""
    ref = workspace_ref(workspace_path)
    ensure_entity_tree(ref)
    return get_workspace_memory_data(workspace_path)


def get_workspace_memory_data(workspace_path: str) -> dict[str, Any]:
    """Catalog-oriented snapshot for admin/UI (replaces old project/layout/facts JSON)."""
    normalized = normalize_workspace_path(workspace_path)
    if not normalized:
        raise ValueError("workspace_path is required")
    ref = workspace_ref(normalized)
    ensure_entity_tree(ref)
    return {
        "version": "2.0",
        "format": "asset_catalog",
        "lastUpdated": utc_now_iso_z(),
        "workspacePath": str(Path(normalized).resolve()),
        "entityType": "workspace",
        "entityId": ref.entity_id,
        "root": str(entity_root(ref).resolve()),
        "standing": read_standing_text(ref, max_chars=TIER0_STANDING_CHARS),
        "facts": list_fact_catalog(ref, limit=50),
        "episodes": list_episode_catalog(ref, limit=50),
        "craft": list_craft_catalog(ref, limit=50),
    }


def save_workspace_memory_data(workspace_path: str, memory_data: dict[str, Any]) -> bool:
    """Deprecated no-op for old JSON writers — workspace memory is file-backed now."""
    del memory_data
    try:
        ensure_entity_tree(workspace_ref(workspace_path))
        return True
    except Exception:
        logger.debug("save_workspace_memory_data ensure failed", exc_info=True)
        return False


def clear_workspace_memory(workspace_path: str) -> dict[str, Any]:
    """Remove workspace asset tree and recreate empty skeleton."""
    ref = workspace_ref(workspace_path)
    root = entity_root(ref)
    if root.is_dir():
        shutil.rmtree(root, ignore_errors=True)
    ensure_entity_tree(ref)
    return get_workspace_memory_data(workspace_path)


_STANDING_PLACEHOLDER_MARKERS = ("本工作区关注点", "（本工作区", "覆盖写")


def _fact_body_from_md(meta: dict[str, str], body: str) -> str:
    lines = [ln for ln in str(body or "").splitlines() if ln.strip()]
    if lines and lines[0].startswith("#"):
        lines = lines[1:]
    return "\n".join(lines).strip()


def _standing_is_placeholder(text: str) -> bool:
    body = str(text or "").strip()
    if not body:
        return True
    if any(m in body for m in _STANDING_PLACEHOLDER_MARKERS):
        return True
    return len(body) < 24


def prune_workspace_memory(workspace_path: str, *, dry_run: bool = False) -> dict[str, Any]:
    """Remove low-quality / ephemeral workspace assets; keep durable project knowledge."""
    from evoflow.assets.catalog import parse_frontmatter
    from evoflow.assets.workspace_memory_policy import should_persist_workspace_asset

    normalized = normalize_workspace_path(workspace_path)
    if not normalized:
        raise ValueError("workspace_path is required")
    ref = workspace_ref(normalized)
    ensure_entity_tree(ref)
    root = entity_root(ref)

    deleted: dict[str, list[str]] = {"facts": [], "episodes": [], "craft": []}
    kept = {"facts": 0, "episodes": 0, "craft": 0}
    standing_reset = False

    facts_dir = root / "memory" / "facts"
    if facts_dir.is_dir():
        for path in sorted(facts_dir.glob("*.md")):
            if not path.is_file() or path.name.upper() == "README.MD":
                continue
            try:
                text = path.read_text(encoding="utf-8")
            except OSError:
                continue
            meta, body = parse_frontmatter(text)
            title = (meta.get("title") or "").strip()
            if not title:
                for line in body.splitlines():
                    if line.startswith("#"):
                        title = line.lstrip("# ").strip()
                        break
            content = _fact_body_from_md(meta, body)
            category = str(meta.get("category") or "module").strip()
            if should_persist_workspace_asset(
                title=title or path.stem,
                content=content,
                category=category,
                source="prune",
            ):
                kept["facts"] += 1
                continue
            deleted["facts"].append(path.name)
            if not dry_run:
                path.unlink(missing_ok=True)

    episodic_dir = root / "memory" / "episodic"
    if episodic_dir.is_dir():
        from evoflow.assets.workspace_memory_policy import is_workspace_ephemeral_content

        for path in sorted(episodic_dir.glob("*.md")):
            if not path.is_file() or path.name.upper() == "README.MD":
                continue
            try:
                text = path.read_text(encoding="utf-8")
            except OSError:
                continue
            meta, body = parse_frontmatter(text)
            content = _fact_body_from_md(meta, body)
            title = (meta.get("title") or path.stem).strip()
            if content and not is_workspace_ephemeral_content(content):
                kept["episodes"] += 1
                continue
            deleted["episodes"].append(path.name)
            if not dry_run:
                path.unlink(missing_ok=True)

    craft_dir = root / "craft"
    if craft_dir.is_dir():
        for path in sorted(craft_dir.glob("*.md")):
            if not path.is_file() or path.name.upper() == "README.MD":
                continue
            try:
                text = path.read_text(encoding="utf-8")
            except OSError:
                continue
            meta, body = parse_frontmatter(text)
            title = (meta.get("title") or meta.get("name") or path.stem).strip()
            content = _fact_body_from_md(meta, body)
            if should_persist_workspace_asset(
                title=title,
                content=content,
                category="convention",
                source="prune",
            ):
                kept["craft"] += 1
                continue
            deleted["craft"].append(path.name)
            if not dry_run:
                path.unlink(missing_ok=True)

    standing_path = root / "memory" / "standing.md"
    if standing_path.is_file():
        try:
            standing_text = standing_path.read_text(encoding="utf-8")
        except OSError:
            standing_text = ""
        _, standing_body = parse_frontmatter(standing_text) if standing_text.startswith("---") else ({}, standing_text)
        if _standing_is_placeholder(standing_body):
            standing_reset = True
            if not dry_run:
                write_text_file(
                    ref,
                    "memory/standing.md",
                    "# 项目站立摘要\n\n（本工作区关注点，≤400 字；覆盖写）\n",
                )

    return {
        "status": "dry_run" if dry_run else "ok",
        "scope_id": ref.entity_id,
        "workspace_path": str(Path(normalized).resolve()),
        "deleted": deleted,
        "kept": kept,
        "standing_reset": standing_reset,
        "memory": get_workspace_memory_data(normalized) if not dry_run else None,
    }


def seed_workspace_memory(workspace_path: str, *, force: bool = False) -> dict[str, Any]:
    """Write curated project knowledge without LLM (known repo layouts only)."""
    from evoflow.agents.memory.workspace_seeds import resolve_workspace_seed

    normalized = normalize_workspace_path(workspace_path)
    if not normalized:
        raise ValueError("workspace_path is required")
    root = Path(normalized).resolve()
    if not root.is_dir():
        raise ValueError(f"Workspace path is not a directory: {root}")

    seed = resolve_workspace_seed(str(root))
    if not seed:
        raise ValueError(
            f"No curated seed for {root}; use `workspace memory bootstrap` for LLM scan"
        )

    get_or_create_workspace(str(root))
    ref = workspace_ref(str(root))
    ensure_entity_tree(ref)

    if not force and _workspace_memory_has_content(str(root)):
        return {
            "status": "skipped",
            "reason": "workspace assets already have content (use --force to replace)",
            "scope_id": ref.entity_id,
            "workspace_path": str(root),
            "memory": get_workspace_memory_data(str(root)),
        }

    if force:
        clear_workspace_memory(str(root))

    written = _apply_workspace_asset_updates(ref, seed, source="seed")
    return {
        "status": "ok",
        "scope_id": ref.entity_id,
        "workspace_path": str(root),
        "written": written,
        "memory": get_workspace_memory_data(str(root)),
    }


def _workspace_memory_has_content(workspace_path: str | dict[str, Any]) -> bool:
    if isinstance(workspace_path, dict):
        # legacy callers passed memory dict — treat asset snapshot
        if workspace_path.get("format") == "asset_catalog":
            facts = workspace_path.get("facts") or []
            eps = workspace_path.get("episodes") or []
            craft = workspace_path.get("craft") or []
            standing = str(workspace_path.get("standing") or "").strip()
            if facts or eps or craft:
                return True
            return bool(standing) and "本工作区关注点" not in standing and "（" not in standing[:8]
        # old JSON
        layout = workspace_path.get("layout")
        if isinstance(layout, dict):
            for block in layout.values():
                if isinstance(block, dict) and str(block.get("summary") or "").strip():
                    return True
        project = workspace_path.get("project")
        if isinstance(project, dict):
            for block in project.values():
                if isinstance(block, dict) and str(block.get("summary") or "").strip():
                    return True
        facts = workspace_path.get("facts")
        if isinstance(facts, list) and facts:
            return True
        return False
    try:
        return catalog_has_content(workspace_ref(workspace_path))
    except Exception:
        return False


def format_workspace_memory_context(
    workspace_path: str | None,
    *,
    injection_profile: str = "full",
    include_procedure: bool = True,
) -> str:
    """Build ``<workspace_memory>`` catalog block (same disclosure as user assets).

    ``include_procedure``: in asset-hub mode, when False only emit the per-root
    MEMORY_SUMMARY (shared read_path already injected once this turn).
    """
    del injection_profile  # catalog form is always compact
    config = get_memory_config()
    if not config.enabled or not config.injection_enabled:
        return ""

    normalized = normalize_workspace_path(workspace_path or "")
    if not normalized:
        return ""

    try:
        ref = workspace_ref(normalized)
        ensure_entity_tree(ref)
        if not catalog_has_content(ref):
            return ""
        from evoflow.assets.memory_injection import asset_hub_memory_injection

        if asset_hub_memory_injection():
            try:
                from evoflow.assets.guidance import build_read_path_guidance

                body = build_read_path_guidance(
                    ref, include_procedure=include_procedure
                ).strip()
            except Exception:
                logger.debug("workspace read_path guidance skipped", exc_info=True)
                body = ""
        else:
            body = format_entity_catalog_xml(
                ref,
                include_standing=False,
                include_facts=True,
                include_episodes=True,
                include_craft=True,
                tag="catalog",
            )
            try:
                from evoflow.assets.guidance import build_read_path_guidance

                guide = build_read_path_guidance(
                    ref, include_procedure=include_procedure
                )
                if guide.strip():
                    body = f"{guide.strip()}\n\n{body}" if body.strip() else guide.strip()
            except Exception:
                logger.debug("workspace read_path guidance skipped", exc_info=True)
    except Exception as exc:
        logger.debug("workspace catalog inject skipped: %s", exc)
        return ""

    if not body.strip():
        return ""

    return f"<workspace_memory>\n{body}\n</workspace_memory>\n"


_BOOTSTRAP_IN_FLIGHT: set[str] = set()
_BOOTSTRAP_LOCK = threading.Lock()


def schedule_workspace_memory_bootstrap_if_needed(workspace_path: str) -> bool:
    """Background-bootstrap empty workspace asset tree when a session binds a project root."""
    config = get_memory_config()
    if not config.enabled:
        return False

    normalized = normalize_workspace_path(workspace_path)
    if not normalized:
        return False
    root = Path(normalized).resolve()
    if not root.is_dir():
        logger.info("[记忆] 工作区 bootstrap 跳过：路径不是目录 path=%s", root)
        return False

    with _BOOTSTRAP_LOCK:
        key = str(root)
        if key in _BOOTSTRAP_IN_FLIGHT:
            return False
        _BOOTSTRAP_IN_FLIGHT.add(key)

    def _run() -> None:
        try:
            if _workspace_memory_has_content(str(root)):
                return
            result = bootstrap_workspace_memory(str(root))
            logger.info(
                "[记忆] 工作区 bootstrap 完成 path=%s status=%s",
                root,
                result.get("status"),
            )
        except Exception as exc:
            logger.warning("[记忆] 工作区 bootstrap 失败 path=%s: %s", root, exc)
        finally:
            with _BOOTSTRAP_LOCK:
                _BOOTSTRAP_IN_FLIGHT.discard(str(root))

    threading.Thread(
        target=_run,
        daemon=True,
        name=f"ws-mem-bootstrap-{hashlib.sha256(str(root).encode()).hexdigest()[:8]}",
    ).start()
    logger.info("[记忆] 工作区 bootstrap 已调度（后台）path=%s", root)
    return True


def resolve_workspace_path_for_memory(*, runtime: Any = None, thread_id: str | None = None) -> str | None:
    """Resolve bound workspace root from runtime context or session row."""
    from evoflow.agents.lead_agent.runtime_context import runtime_context_mapping

    ctx = runtime_context_mapping(runtime)
    ws = normalize_workspace_path(str(ctx.get("local_workspace_root") or ""))
    if ws:
        return ws
    tid = str(thread_id or ctx.get("thread_id") or "").strip()
    if tid:
        try:
            from evoflow.tools.host_direct.workspace_context import load_local_workspace_root_for_thread

            bound = load_local_workspace_root_for_thread(tid)
            if bound:
                return normalize_workspace_path(bound)
        except Exception as exc:
            logger.debug("Workspace path lookup failed for thread %s: %s", tid, exc)
    return None


def bootstrap_workspace_memory(
    workspace_path: str,
    *,
    model_name: str | None = None,
    force: bool = False,
) -> dict[str, Any]:
    """Scan repository and write Asset Hub MD (standing + facts + optional craft)."""
    config = get_memory_config()
    if not config.enabled:
        raise RuntimeError("Memory is disabled in config (memory.enabled=false)")

    normalized = normalize_workspace_path(workspace_path)
    if not normalized:
        raise ValueError("workspace_path is required")
    root = Path(normalized).resolve()
    if not root.is_dir():
        raise ValueError(f"Workspace path is not a directory: {root}")

    get_or_create_workspace(str(root))
    ref = workspace_ref(str(root))
    ensure_entity_tree(ref)

    if not force and _workspace_memory_has_content(str(root)):
        return {
            "status": "skipped",
            "reason": "workspace assets already have content (use --force to rebuild)",
            "scope_id": ref.entity_id,
            "workspace_path": str(root),
            "memory": get_workspace_memory_data(str(root)),
        }

    if force:
        clear_workspace_memory(str(root))

    repo_context = collect_repository_context(str(root))
    if not repo_context.strip():
        raise ValueError(f"No bootstrap context collected from {root}")

    prompt = WORKSPACE_BOOTSTRAP_PROMPT.format(repository_context=repo_context)
    model_name_resolved = config.model_name or model_name
    model = create_chat_model(name=model_name_resolved, thinking_enabled=False, invocation_kind="memory")
    response = model.invoke(prompt)
    response_text = _extract_text(response.content).strip()

    if response_text.startswith("```"):
        lines = response_text.split("\n")
        response_text = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])

    update_data = json.loads(response_text)
    written = _apply_workspace_asset_updates(ref, update_data, source="bootstrap")

    return {
        "status": "ok",
        "scope_id": ref.entity_id,
        "workspace_path": str(root),
        "written": written,
        "memory": get_workspace_memory_data(str(root)),
    }


def _apply_workspace_asset_updates(
    entity: EntityRef,
    update_data: dict[str, Any],
    *,
    source: str = "conversation",
) -> dict[str, int]:
    """Write standing / facts / craft / episodes from LLM JSON into Asset Hub files."""
    del source
    written = {"standing": 0, "facts": 0, "craft": 0, "episodes": 0}
    ensure_entity_tree(entity)

    standing = str(update_data.get("standing") or "").strip()
    if standing:
        body = cap_text_chars(standing, TIER0_STANDING_CHARS)
        write_text_file(
            entity,
            "memory/standing.md",
            f"# 项目站立摘要\n\n{body}\n",
        )
        written["standing"] = 1

    for fact in update_data.get("facts") or update_data.get("newFacts") or []:
        if not isinstance(fact, dict):
            continue
        title = str(fact.get("title") or "").strip()
        summary = cap_text_chars(str(fact.get("summary") or title).strip(), 30)
        content = str(fact.get("content") or fact.get("body") or "").strip()
        if not content and not title:
            continue
        if not title:
            title = content.split("\n", 1)[0][:40]
        if not content:
            content = title
        category = str(fact.get("category") or "module").strip()
        slug_hint = str(fact.get("slug") or "").strip()
        try:
            from evoflow.assets.workspace_memory_policy import should_persist_workspace_asset

            if not should_persist_workspace_asset(
                title=title, content=content, category=category, source=source
            ):
                continue
        except Exception:
            pass
        try:
            record_fact(
                entity,
                content,
                title=title,
                summary=summary or title[:30],
                category=category,
                slug_hint=slug_hint,
            )
            written["facts"] += 1
        except Exception:
            logger.debug("workspace fact write skipped", exc_info=True)

    for craft in update_data.get("craft") or []:
        if not isinstance(craft, dict):
            continue
        title = str(craft.get("title") or craft.get("name") or "").strip()
        if not title:
            continue
        description = cap_text_chars(
            str(craft.get("description") or craft.get("summary") or title).strip(),
            30,
        )
        content = str(craft.get("content") or craft.get("body") or title).strip()
        try:
            save_craft_note(entity, title=title, content=content, description=description)
            written["craft"] += 1
        except Exception:
            logger.debug("workspace craft write skipped", exc_info=True)

    for ep in update_data.get("episodes") or []:
        if not isinstance(ep, dict):
            continue
        title = str(ep.get("title") or "").strip()
        summary = cap_text_chars(str(ep.get("summary") or title).strip(), 30)
        content = str(ep.get("content") or ep.get("body") or "").strip()
        if not content:
            continue
        try:
            write_episode(entity, content, title=title or content[:40], summary=summary)
            written["episodes"] += 1
        except Exception:
            logger.debug("workspace episode write skipped", exc_info=True)

    return written


class WorkspaceMemoryUpdater:
    """Updates workspace Asset Hub files from conversation via LLM."""

    def __init__(self, model_name: str | None = None):
        self._model_name = model_name

    def _get_model(self):
        config = get_memory_config()
        model_name = config.model_name or self._model_name
        return create_chat_model(name=model_name, thinking_enabled=False, invocation_kind="memory")

    def update_memory(
        self,
        messages: list[Any],
        workspace_path: str,
        thread_id: str | None = None,
    ) -> bool:
        config = get_memory_config()
        if not config.enabled:
            return False
        if not messages:
            return False

        normalized = normalize_workspace_path(workspace_path)
        if not normalized:
            return False
        root = Path(normalized).resolve()
        if not root.is_dir():
            logger.info("[记忆] 工作区记忆：路径不是目录，跳过 path=%s", root)
            return False

        try:
            get_or_create_workspace(str(root))
            ref = workspace_ref(str(root))
            ensure_entity_tree(ref)
            current = get_workspace_memory_data(str(root))
            conversation_text = format_conversation_for_workspace_update(messages, str(root))
            if not conversation_text.strip():
                logger.info("[记忆] 工作区记忆：对话文本为空，跳过 LLM path=%s", root)
                return False

            layout_outline = format_workspace_module_index_for_update(str(root))
            prompt = WORKSPACE_UPDATE_PROMPT.format(
                workspace_root=str(root),
                module_index=layout_outline,
                current_memory=json.dumps(
                    {
                        "standing": current.get("standing"),
                        "facts": [
                            {"title": r.get("title"), "summary": r.get("summary"), "path": r.get("path")}
                            for r in (current.get("facts") or [])[:20]
                        ],
                        "craft": [
                            {"name": r.get("name"), "description": r.get("description"), "path": r.get("path")}
                            for r in (current.get("craft") or [])[:15]
                        ],
                        "episodes": [
                            {"title": r.get("title"), "summary": r.get("summary"), "path": r.get("path")}
                            for r in (current.get("episodes") or [])[:10]
                        ],
                    },
                    indent=2,
                    ensure_ascii=False,
                ),
                conversation=conversation_text,
            )
            model = self._get_model()
            logger.info(
                "[记忆] 工作区记忆：调用 LLM 整理 path=%s thread=%s 对话字符数=%d",
                root,
                thread_id or "?",
                len(conversation_text),
            )
            response = model.invoke(prompt)
            response_text = _extract_text(response.content).strip()
            if response_text.startswith("```"):
                lines = response_text.split("\n")
                response_text = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])

            update_data = json.loads(response_text)
            _apply_workspace_asset_updates(ref, update_data, source=thread_id or "conversation")
            return True
        except json.JSONDecodeError as e:
            logger.warning("[记忆] 工作区记忆：LLM 返回 JSON 解析失败 path=%s: %s", root, e)
            return False
        except Exception as e:
            logger.exception("[记忆] 工作区记忆：整理失败 path=%s: %s", root, e)
            return False


def update_workspace_memory_from_conversation(
    messages: list[Any],
    workspace_path: str,
    thread_id: str | None = None,
) -> bool:
    return WorkspaceMemoryUpdater().update_memory(messages, workspace_path, thread_id=thread_id)
