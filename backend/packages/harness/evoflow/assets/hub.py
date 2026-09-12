"""Asset Hub facade — list entities, browse tree, read/write text files."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from evoflow.assets.paths import (
    EntityRef,
    assets_root,
    default_index_md,
    entity_root,
    profile_dir,
    profile_field_names,
    profile_path,
    resolve_entity_file,
)

logger = logging.getLogger(__name__)

_TEXT_SUFFIXES = {".md", ".markdown", ".mdx", ".txt", ".yaml", ".yml", ".json"}


def ensure_assets_tree() -> Path:
    """Create ``assets/`` skeleton if missing."""
    root = assets_root()
    root.mkdir(parents=True, exist_ok=True)

    index = root / "index.md"
    if not index.is_file():
        index.write_text(default_index_md(), encoding="utf-8")

    user_profile = profile_path(EntityRef("user", "user"), "README.md")
    user_profile.parent.mkdir(parents=True, exist_ok=True)

    for sub in ("memory", "craft"):
        (entity_root(EntityRef("user", "user")) / sub).mkdir(parents=True, exist_ok=True)

    _ensure_obsidian_marker(root)
    return root


def _ensure_obsidian_marker(dest: Path) -> None:
    obsidian = dest / ".obsidian"
    obsidian.mkdir(parents=True, exist_ok=True)
    app = obsidian / "app.json"
    if not app.is_file():
        app.write_text('{"legacyEditor": false, "livePreview": true}\n', encoding="utf-8")


def ensure_entity_tree(entity: EntityRef) -> Path:
    root = ensure_assets_tree()
    e = entity.normalized()
    ent_root = entity_root(e)
    ent_root.mkdir(parents=True, exist_ok=True)
    profile_dir(e).mkdir(parents=True, exist_ok=True)

    # Agents are config shells — no memory/craft tree (dialogue memory lives under user/).
    if e.entity_type == "agent":
        return root

    for sub in ("memory", "craft"):
        (ent_root / sub).mkdir(parents=True, exist_ok=True)
    for mem_sub in ("facts", "episodic", "journal", "_inbox", "_inbox/notes"):
        (ent_root / "memory" / mem_sub).mkdir(parents=True, exist_ok=True)
    standing = ent_root / "memory" / "standing.md"
    if not standing.is_file():
        if e.entity_type == "workspace":
            standing.write_text(
                "# 项目站立摘要\n\n（本工作区关注点，≤400 字；覆盖写）\n",
                encoding="utf-8",
            )
        else:
            standing.write_text(
                "v1\n\n# 站立摘要\n\n（会话冻结的近期关注，≤400 字；第一行保留 v1 以与原生运行时一致 summary schema）\n",
                encoding="utf-8",
            )
    memory_md = ent_root / "memory" / "MEMORY.md"
    if not memory_md.is_file():
        memory_md.write_text(
            "# MEMORY\n\n（手册层：按 Task Group 聚合的可检索记忆；由 Phase2 整合写入）\n",
            encoding="utf-8",
        )
    inbox_readme = ent_root / "memory" / "_inbox" / "README.md"
    if not inbox_readme.is_file():
        inbox_readme.write_text(
            "# _inbox\n\nPhase1 草稿与 ad-hoc notes。对话 Agent **只许**写 `notes/`；"
            "不要直接改 `standing.md` / `MEMORY.md`。\n\n"
            "Phase2 整合后，已处理的 `raw_*` / notes 会移到 `_done/`。\n",
            encoding="utf-8",
        )
    journal_readme = ent_root / "memory" / "journal" / "README.md"
    if not journal_readme.is_file():
        journal_readme.write_text(
            "# 反思日志\n\n按日期记录日反思 / wrap-up，例如 `2026-08-25.md`。\n",
            encoding="utf-8",
        )
    craft_readme = ent_root / "craft" / "README.md"
    if not craft_readme.is_file():
        craft_readme.write_text(
            "# 经验与专长\n\n每个子目录一份 `SKILL.md`（原经验库沉淀到此）。\n",
            encoding="utf-8",
        )

    if e.entity_type == "user":
        from evoflow.assets.user_profile_dims import ensure_user_profile_files

        ensure_user_profile_files(e)
    return root


def _agent_display_label(code: str) -> str:
    """Prefer Chinese/display ``agent_name`` over raw agent_code."""
    key = str(code or "").strip().lower()
    if not key:
        return code
    try:
        from evoflow.persistence import config_repositories as cfg_repo

        cfg = cfg_repo.get_agent_config(key)
        name = str((cfg or {}).get("agent_name") or "").strip()
        if name:
            return name
    except Exception:
        logger.debug("agent label: config_repo failed code=%s", key, exc_info=True)
    try:
        from evoflow.config.agents_config import load_agent_config

        cfg = load_agent_config(key)
        name = str(getattr(cfg, "agent_name", "") or "").strip() if cfg else ""
        if name:
            return name
    except Exception:
        logger.debug("agent label: load_agent_config failed code=%s", key, exc_info=True)
    return key


def _employee_display_label(code: str) -> str:
    """Prefer 中文智能体名 / 岗位名 over English or raw agent_code."""
    key = str(code or "").strip().lower()
    if not key:
        return code
    agent_name = _agent_display_label(key)
    role_name = ""
    try:
        from evoflow.proactive.repositories import ProactiveRepository

        role = ProactiveRepository.get_role(key)
        role_name = str((role.role_name if role else "") or "").strip()
    except Exception:
        logger.debug("employee label: get_role failed code=%s", key, exc_info=True)
    return _pick_human_label(key, agent_name, role_name)


def _has_cjk(text: str) -> bool:
    return any("\u4e00" <= ch <= "\u9fff" for ch in str(text or ""))


def _is_code_like_label(label: str, code: str) -> bool:
    s = str(label or "").strip()
    c = str(code or "").strip()
    if not s:
        return True
    if c and s.lower() == c.lower():
        return True
    return False


def _pick_human_label(code: str, *names: str) -> str:
    """Prefer CJK display names, then any non-code name, else code."""
    key = str(code or "").strip()
    cleaned = [str(n or "").strip() for n in names if str(n or "").strip()]
    human = [n for n in cleaned if not _is_code_like_label(n, key)]
    for n in human:
        if _has_cjk(n):
            return n
    if human:
        return human[0]
    return cleaned[0] if cleaned else key


def _prefer_display_label(current: str, candidate: str, code: str) -> str:
    """Prefer a human display name over raw agent/employee code."""
    return _pick_human_label(code, candidate, current)

def _upsert_entity(
    entities: list[dict[str, Any]],
    *,
    entity_type: str,
    entity_id: str,
    label: str,
    root: str,
) -> None:
    eid = str(entity_id or "").strip()
    if not eid:
        return
    nice = str(label or "").strip() or eid
    for e in entities:
        if e.get("entityType") == entity_type and str(e.get("entityId") or "").lower() == eid.lower():
            e["label"] = _prefer_display_label(str(e.get("label") or ""), nice, eid)
            return
    entities.append(
        {
            "entityType": entity_type,
            "entityId": eid,
            "label": nice,
            "root": root,
        }
    )


def list_entities() -> dict[str, Any]:
    """Discover user + employees + workspaces with asset directories or config.

    Employees match the 智能体员工 roster: proactive roles with ``status != archived``.
    Do **not** scan ``assets/employees/*`` — leftover dirs after解雇 would clutter the
    Asset Center dropdown and diverge from the employee list.

    Bare ``agent`` entities are omitted from Asset Center listings (use employee /
    user). Explicit ``entityType=agent`` API reads remain available for legacy paths.
    """
    ensure_assets_tree()
    entities: list[dict[str, Any]] = [
        {
            "entityType": "user",
            "entityId": "user",
            "label": "我",
            "root": entity_relative_path(EntityRef("user", "user")),
        }
    ]

    try:
        from evoflow.proactive.repositories import ProactiveRepository

        # Same SoT as `#/proactive`: GET /proactive/roles, drop archived.
        for role in ProactiveRepository.list_roles() or []:
            status = str(getattr(role, "status", "") or "").strip().lower()
            if status == "archived":
                continue
            code = str(role.agent_code or "").strip().lower()
            if not code:
                continue
            label = _employee_display_label(code)
            _upsert_entity(
                entities,
                entity_type="employee",
                entity_id=code,
                label=label,
                root=f"employees/{code}",
            )
    except Exception:
        logger.debug("list_entities: proactive roles scan skipped", exc_info=True)

    seen_workspace_ids: set[str] = set()
    workspaces_root = assets_root() / "workspaces"
    if workspaces_root.is_dir():
        for p in sorted(workspaces_root.iterdir()):
            if not p.is_dir() or not p.name.startswith("ws-"):
                continue
            eid = p.name.strip().lower()
            seen_workspace_ids.add(eid)
            label = eid
            _upsert_entity(
                entities,
                entity_type="workspace",
                entity_id=eid,
                label=label,
                root=f"workspaces/{eid}",
            )

    try:
        from evoflow.persistence.db import get_db
        from evoflow.assets.paths import workspace_entity_ref

        rows = get_db().execute("SELECT workspace_path FROM evoflow_workspaces").fetchall()
        for row in rows:
            wp = str(row[0] or "").strip()
            if not wp:
                continue
            try:
                ref = workspace_entity_ref(wp)
            except ValueError:
                continue
            eid = ref.entity_id
            if eid in seen_workspace_ids:
                for ent in entities:
                    if ent.get("entityType") == "workspace" and ent.get("entityId") == eid:
                        ent["label"] = Path(wp).name or wp
                        ent["workspacePath"] = wp
                        break
                continue
            seen_workspace_ids.add(eid)
            _upsert_entity(
                entities,
                entity_type="workspace",
                entity_id=eid,
                label=Path(wp).name or wp,
                root=f"workspaces/{eid}",
            )
            for ent in entities:
                if ent.get("entityType") == "workspace" and ent.get("entityId") == eid:
                    ent["workspacePath"] = wp
                    break
    except Exception:
        logger.debug("list_entities: workspace registry scan skipped", exc_info=True)

    return {
        "vaultId": "evoflow-assets",
        "root": str(assets_root().resolve()),
        "entities": entities,
    }


def entity_relative_path(entity: EntityRef) -> str:
    from evoflow.assets.paths import entity_relative_dir

    return entity_relative_dir(entity.normalized())


def list_tree(entity: EntityRef, subpath: str = "") -> dict[str, Any]:
    ensure_entity_tree(entity)
    e = entity.normalized()
    rel = str(subpath or "").strip().replace("\\", "/").lstrip("/")
    base = entity_root(e)
    target = resolve_entity_file(e, rel) if rel else base
    if not target.is_dir():
        raise FileNotFoundError(rel or ".")

    entries: list[dict[str, Any]] = []
    try:
        children = sorted(target.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
    except OSError as exc:
        raise FileNotFoundError(rel) from exc

    for child in children:
        if child.name.startswith(".") or child.name == ".obsidian":
            continue
        rel_child = child.relative_to(base).as_posix()
        if child.is_dir():
            entries.append({"name": child.name, "path": rel_child, "kind": "dir"})
        elif child.is_file() and child.suffix.lower() in _TEXT_SUFFIXES:
            entries.append({"name": child.name, "path": rel_child, "kind": "file"})
    return {
        "entityType": e.entity_type,
        "entityId": e.entity_id,
        "path": rel,
        "entries": entries,
    }


def read_text_file(entity: EntityRef, rel_path: str) -> dict[str, Any]:
    ensure_entity_tree(entity)
    target = resolve_entity_file(entity, rel_path)
    if not target.is_file():
        raise FileNotFoundError(rel_path)
    if target.suffix.lower() not in _TEXT_SUFFIXES:
        raise ValueError("only text assets can be read via API")
    try:
        content = target.read_text(encoding="utf-8")
    except OSError as exc:
        raise OSError(f"read failed: {rel_path}") from exc
    return {
        "entityType": entity.normalized().entity_type,
        "entityId": entity.normalized().entity_id,
        "path": str(rel_path).replace("\\", "/").lstrip("/"),
        "content": content,
        "size": len(content.encode("utf-8")),
    }


def write_text_file(entity: EntityRef, rel_path: str, content: str) -> dict[str, Any]:
    ensure_entity_tree(entity)
    target = resolve_entity_file(entity, rel_path)
    if target.suffix.lower() not in _TEXT_SUFFIXES:
        raise ValueError("only text assets can be written via API")
    target.parent.mkdir(parents=True, exist_ok=True)
    text = content if content is not None else ""
    tmp = target.with_suffix(target.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(target)
    try:
        from evoflow.assets.memory_mirror import schedule_asset_vault_reindex_delayed

        schedule_asset_vault_reindex_delayed()
    except Exception:
        logger.debug("asset reindex schedule skipped", exc_info=True)
    return read_text_file(entity, rel_path)


def read_profile(entity: EntityRef) -> dict[str, Any]:
    ensure_entity_tree(entity)
    e = entity.normalized()
    fields: dict[str, str | None] = {}
    for name in profile_field_names(e):
        p = profile_path(e, name)
        if p.is_file():
            try:
                fields[name] = p.read_text(encoding="utf-8")
            except OSError:
                fields[name] = None
        else:
            fields[name] = None
    return {
        "entityType": e.entity_type,
        "entityId": e.entity_id,
        "fields": fields,
    }


def write_profile_field(entity: EntityRef, field: str, content: str) -> dict[str, Any]:
    e = entity.normalized()
    fname = str(field or "").strip()
    p = profile_path(e, fname)
    rel = p.relative_to(entity_root(e)).as_posix()
    write_text_file(e, rel, content or "")
    if fname == "SOUL.md" and e.entity_type in ("agent", "employee"):
        try:
            from evoflow.person_kernel import ensure_agent_identity

            code = e.entity_id
            ensure_agent_identity(code, content or "")
        except Exception:
            logger.debug("write_profile_field: identity ensure skipped", exc_info=True)
        try:
            from evoflow.assets.soul_summary import schedule_soul_summary_consolidate

            schedule_soul_summary_consolidate(e)
        except Exception:
            logger.debug("write_profile_field: soul-summary schedule skipped", exc_info=True)
    return read_profile(e)


def materialized_assets_vault_dir() -> Path:
    return assets_root().resolve()


def _slug_ascii(text: str, *, max_len: int = 48, fallback: str = "note") -> str:
    import re

    s = re.sub(r"[^a-z0-9_-]+", "-", str(text or "").strip().lower()).strip("-")
    if not s:
        s = fallback
    return (s[:max_len].strip("-") or fallback)


def record_fact(
    entity: EntityRef,
    content: str,
    *,
    title: str = "",
    summary: str = "",
    category: str = "",
    slug_hint: str = "",
) -> dict[str, Any]:
    """Write a fact note to ``memory/facts/{slug}.md`` with catalog frontmatter.

    Catalog disclosure uses ``title`` + ``summary`` (same model as craft/journal).
    """
    body = str(content or "").strip()
    if not body:
        raise ValueError("content is required")
    ensure_entity_tree(entity)
    from datetime import datetime, timezone

    heading = str(title or "").strip() or body.split("\n", 1)[0].lstrip("# ").strip()[:60]
    one_liner = (str(summary or "").strip() or heading)[:30]
    slug = _slug_ascii(str(slug_hint or "").strip() or heading, fallback="fact")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S%f")
    facts_dir = entity_root(entity.normalized()) / "memory" / "facts"
    fname = f"{slug}-{stamp[-8:]}.md"
    n = 0
    while (facts_dir / fname).exists():
        n += 1
        fname = f"{slug}-{stamp[-8:]}-{n}.md"
    rel = f"memory/facts/{fname}"
    created = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    e = entity.normalized()
    cat_line = ""
    if category.strip() and e.entity_type == "workspace":
        from evoflow.assets.workspace_memory_policy import normalize_workspace_fact_category

        cat_line = f"category: {normalize_workspace_fact_category(category)}\n"
    md = (
        f"---\n"
        f"title: {heading}\n"
        f"summary: {one_liner}\n"
        f"{cat_line}"
        f"entity: {e.entity_type}\n"
        f"entity_id: {e.entity_id}\n"
        f"created_at: {created}\n"
        f"---\n\n"
        f"# {heading}\n\n"
        f"{body}\n"
    )
    return write_text_file(entity, rel, md)


def write_episode(
    entity: EntityRef,
    content: str,
    *,
    title: str = "",
    summary: str = "",
) -> dict[str, Any]:
    """Write a conversation-process note to ``memory/episodic/{date}-{slug}.md``.

    Product intent: record this dialogue's process so a human can review it later.
    Not 「沉淀记忆」— catalog uses ``title`` + ``summary`` (10–30 chars).
    """
    body = str(content or "").strip()
    if not body:
        raise ValueError("content is required")
    ensure_entity_tree(entity)
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc).astimezone()
    day = now.date().isoformat()
    heading = str(title or "").strip() or body.split("\n", 1)[0].lstrip("# ").strip()[:60]
    one_liner = (str(summary or "").strip() or heading)[:30]
    slug = _slug_ascii(heading, fallback="episode")
    stamp = now.strftime("%H%M%S")
    fname = f"{day}-{slug}-{stamp[-4:]}.md"
    rel = f"memory/episodic/{fname}"
    created = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    e = entity.normalized()
    md = (
        f"---\n"
        f"title: {heading}\n"
        f"summary: {one_liner}\n"
        f"date: {day}\n"
        f"entity: {e.entity_type}\n"
        f"entity_id: {e.entity_id}\n"
        f"created_at: {created}\n"
        f"---\n\n"
        f"# {heading}\n\n"
        f"{body}\n"
    )
    return write_text_file(entity, rel, md)


def write_journal(
    entity: EntityRef,
    content: str,
    *,
    date: str = "",
    append: bool = True,
    summary: str = "",
) -> dict[str, Any]:
    """Create or append ``memory/journal/{YYYY-MM-DD}.md`` with catalog frontmatter.

    Always keeps/updates YAML ``summary`` so Tier0/1 can list journals without full text.
    """
    body = str(content or "").strip()
    if not body:
        raise ValueError("content is required")
    from datetime import date as date_cls, datetime, timezone

    day = str(date or "").strip()
    if not day:
        day = datetime.now(timezone.utc).astimezone().date().isoformat()
    else:
        date_cls.fromisoformat(day)

    one_liner = (
        str(summary or "").strip() or body.split("\n", 1)[0].lstrip("# ").strip()
    )[:30]
    ensure_entity_tree(entity)
    rel = f"memory/journal/{day}.md"
    e = entity.normalized()
    target = resolve_entity_file(e, rel)
    existing = ""
    if target.is_file():
        try:
            existing = target.read_text(encoding="utf-8")
        except OSError:
            existing = ""

    def _with_frontmatter(body_md: str) -> str:
        # strip old frontmatter if present
        raw = body_md
        if raw.startswith("---"):
            parts = raw.split("---", 2)
            if len(parts) >= 3:
                raw = parts[2].lstrip("\n")
        fm = f"---\ndate: {day}\nsummary: {one_liner}\n---\n\n"
        if not raw.lstrip().startswith("#"):
            raw = f"# {day} 反思\n\n{raw}"
        return fm + raw.rstrip() + "\n"

    if existing and append:
        stamp = datetime.now(timezone.utc).astimezone().strftime("%H:%M")
        # drop old fm, append section, rewrite fm with latest summary
        raw = existing
        if raw.startswith("---"):
            parts = raw.split("---", 2)
            if len(parts) >= 3:
                raw = parts[2].lstrip("\n")
        merged = raw.rstrip() + f"\n\n## {stamp}\n\n{body}\n"
        text = _with_frontmatter(merged)
    elif existing and not append:
        text = _with_frontmatter(body if body.lstrip().startswith("#") else f"# {day} 反思\n\n{body}\n")
    else:
        text = _with_frontmatter(f"# {day} 反思\n\n{body}\n")
    return write_text_file(e, rel, text)


def save_craft_note(
    entity: EntityRef,
    *,
    title: str,
    content: str = "",
    description: str = "",
) -> dict[str, Any]:
    """Write ``craft/{slug}/SKILL.md`` directly (no experience DB)."""
    from evoflow.assets.craft import save_craft_from_experience

    t = str(title or "").strip()
    if not t:
        raise ValueError("title is required")
    body = str(content or "").strip()
    e = entity.normalized()
    desc = (str(description or "").strip() or t)[:30]
    return save_craft_from_experience(
        {
            "title": t,
            "description": desc,
            "solution": body or t,
            "origin": "manual",
            "entity_type": e.entity_type,
            "entity_id": e.entity_id,
            "category": "general",
        }
    )


def delete_text_file(entity: EntityRef, rel_path: str) -> dict[str, Any]:
    """Delete a text asset under the entity tree."""
    ensure_entity_tree(entity)
    e = entity.normalized()
    rel = str(rel_path or "").replace("\\", "/").lstrip("/")
    if not rel:
        raise ValueError("path is required")
    # Protect core profile files from casual delete
    protected = {
        "profile/README.md",
        "profile/basic-info.md",
        "profile/preferences.md",
        "profile/persona.md",
        "profile/SOUL.md",
        "profile/identity.md",
        "profile/system.md",
        "profile/soul-summary.md",
    }
    if rel in protected:
        raise ValueError(f"protected profile file cannot be deleted: {rel}")
    target = resolve_entity_file(e, rel)
    if not target.is_file():
        raise FileNotFoundError(rel)
    if target.suffix.lower() not in _TEXT_SUFFIXES:
        raise ValueError("only text assets can be deleted via API")
    target.unlink()
    # clean empty parent if under craft/{name}/
    parent = target.parent
    try:
        if parent.is_dir() and not any(parent.iterdir()):
            parent.rmdir()
    except OSError:
        pass
    try:
        from evoflow.assets.memory_mirror import schedule_asset_vault_reindex_delayed

        schedule_asset_vault_reindex_delayed()
    except Exception:
        logger.debug("asset reindex schedule skipped", exc_info=True)
    return {
        "ok": True,
        "entityType": e.entity_type,
        "entityId": e.entity_id,
        "path": rel,
        "deleted": True,
    }
