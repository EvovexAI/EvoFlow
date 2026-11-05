"""Asset Hub facade — list entities, browse tree, read/write text files."""

from __future__ import annotations

import logging
import re
import secrets
from datetime import UTC
from pathlib import Path
from typing import Any

from evoflow.assets.locks import atomic_write_text, lock_for
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

    user_profile_parent = profile_dir(EntityRef("user", "user"))
    user_profile_parent.mkdir(parents=True, exist_ok=True)

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
    # Workspace project assets have no profile/; user/agent/employee keep profile under entity root.
    if e.entity_type != "workspace":
        profile_dir(e).mkdir(parents=True, exist_ok=True)

    # Affect SoT: user (= main agent 心境) + employee/agent.
    if e.entity_type in ("agent", "employee", "user"):
        try:
            from evoflow.assets.affect_mirror import ensure_default_affect_md

            ensure_default_affect_md(e)
        except Exception:
            logger.debug("ensure affect.md skipped", exc_info=True)

    # Agents are config shells — no memory/craft tree (dialogue memory lives under user/).
    if e.entity_type == "agent":
        return root

    for sub in ("memory", "craft"):
        (ent_root / sub).mkdir(parents=True, exist_ok=True)
    for mem_sub in ("episodic", "journal"):
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
            "# MEMORY\n\n（手册层索引；对话用 assets note 直写 standing / episodic / craft / journal）\n",
            encoding="utf-8",
        )
    _migrate_craft_dirs_to_files(ent_root)

    if e.entity_type == "user":
        from evoflow.assets.user_profile_dims import ensure_user_profile_files

        ensure_user_profile_files(e)
    return root


def _migrate_craft_dirs_to_files(ent_root: Path) -> None:
    """Flatten legacy ``craft/{name}/SKILL.md`` into ``craft/{name}.md``.

    Older asset trees nested each craft under its own directory; the current
    layout keeps one Markdown file per craft. Migration is in place + idempotent.
    """
    craft_dir = ent_root / "craft"
    if not craft_dir.is_dir():
        return
    try:
        children = list(craft_dir.iterdir())
    except OSError:
        return
    for child in children:
        if not child.is_dir() or child.name.startswith("."):
            continue
        skill_md = child / "SKILL.md"
        if not skill_md.is_file():
            continue
        target = craft_dir / f"{child.name}.md"
        if target.exists():
            continue
        try:
            skill_md.replace(target)
            # Drop the now-empty legacy directory; keep it if it holds other files.
            if not any(child.iterdir()):
                child.rmdir()
        except OSError:
            logger.debug("craft layout migration skipped: %s", child, exc_info=True)


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

        # Same SoT as `#/proactive`: GET /proactive/roles.
        for role in ProactiveRepository.list_roles() or []:
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
    # Prefer bound projects from registry — SoT is ``<project>/.evoflow/``.
    try:
        from evoflow.assets.paths import entity_root, workspace_entity_ref
        from evoflow.persistence.db import get_db

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
            seen_workspace_ids.add(eid)
            wiki = entity_root(ref)
            _upsert_entity(
                entities,
                entity_type="workspace",
                entity_id=eid,
                label=Path(wp).name or wp,
                root=".evoflow",
            )
            for ent in entities:
                if ent.get("entityType") == "workspace" and ent.get("entityId") == eid:
                    ent["workspacePath"] = wp
                    ent["absRoot"] = str(wiki.resolve())
                    break
    except Exception:
        logger.debug("list_entities: workspace registry scan skipped", exc_info=True)

    # Legacy leftover under ~/.evoflow/assets/workspaces/ (pre-relocation).
    workspaces_root = assets_root() / "workspaces"
    if workspaces_root.is_dir():
        for p in sorted(workspaces_root.iterdir()):
            if not p.is_dir() or not p.name.startswith("ws-"):
                continue
            eid = p.name.strip().lower()
            if eid in seen_workspace_ids:
                continue
            seen_workspace_ids.add(eid)
            _upsert_entity(
                entities,
                entity_type="workspace",
                entity_id=eid,
                label=eid,
                root=f"workspaces/{eid}",
            )

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
    target = resolve_entity_file(entity, rel_path)
    # 已存在的文件不必每次点击都重建目录树 / 迁移 craft。
    if not target.is_file():
        ensure_entity_tree(entity)
        target = resolve_entity_file(entity, rel_path)
    if not target.is_file():
        raise FileNotFoundError(rel_path)
    rel = str(rel_path).replace("\\", "/").lstrip("/")
    abs_path = str(target.resolve())
    # 图片/音视频：只回 absolutePath，供桌面 PreviewPane convertFileSrc；
    # 勿强制走文本读（否则右栏「打开」直接失败 / 报不支持播放）。
    if target.suffix.lower() not in _TEXT_SUFFIXES:
        try:
            size = int(target.stat().st_size)
        except OSError:
            size = 0
        return {
            "entityType": entity.normalized().entity_type,
            "entityId": entity.normalized().entity_id,
            "path": rel,
            "absolutePath": abs_path,
            "content": "",
            "binary": True,
            "size": size,
        }
    try:
        content = target.read_text(encoding="utf-8")
    except OSError as exc:
        raise OSError(f"read failed: {rel_path}") from exc
    return {
        "entityType": entity.normalized().entity_type,
        "entityId": entity.normalized().entity_id,
        "path": rel,
        # Desktop reveal / open-in-explorer needs a real filesystem path.
        "absolutePath": abs_path,
        "content": content,
        "size": len(content.encode("utf-8")),
    }


def write_text_file(entity: EntityRef, rel_path: str, content: str) -> dict[str, Any]:
    ensure_entity_tree(entity)
    target = resolve_entity_file(entity, rel_path)
    if target.suffix.lower() not in _TEXT_SUFFIXES:
        raise ValueError("only text assets can be written via API")
    text = content if content is not None else ""
    # 路径锁：UI 保存 / 对话写入 / Phase2 对同一文件的写相互串行，
    # 原子写走唯一 tmp + fsync + replace（不再共用固定 .tmp 名）。
    with lock_for(target):
        atomic_write_text(target, text)
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


_SLUG_CJK_RE = None


def _slug_cjk(text: str, *, max_len: int = 48, fallback: str = "note") -> str:
    """CJK-aware slug — 记忆标题多为中文，文件名保持可读。

    仅用于**内容文件**名（facts/episodic/journal/craft 的 .md）；实体桶与目录名仍是
    ASCII 约定。非法字符折叠为 ``-``，ASCII 保留小写。
    """
    import re

    global _SLUG_CJK_RE
    if _SLUG_CJK_RE is None:
        _SLUG_CJK_RE = re.compile(r"[^a-zA-Z0-9\u4e00-\u9fff_-]+")
    s = _SLUG_CJK_RE.sub("-", str(text or "").strip()).strip("-_")
    if not s:
        s = fallback
    return s[:max_len].strip("-_") or fallback


def _unique_rel_name(entity: EntityRef, rel_dir: str, base: str, *, ext: str = ".md") -> str:
    """``{rel_dir}/{base}{ext}``，已存在时追加短随机后缀。

    随机后缀替代旧的 ``-2/-3`` 计数循环：计数是 TOCTOU——并发写同标题的两条
    记忆会看到同一个“未占用”名，后写者整文件覆盖前者（记忆静默消失）。
    """
    rel = f"{rel_dir}/{base}{ext}"
    if not resolve_entity_file(entity, rel).exists():
        return rel
    for _ in range(6):
        rel = f"{rel_dir}/{base}-{secrets.token_hex(2)}{ext}"
        if not resolve_entity_file(entity, rel).exists():
            return rel
    raise ValueError(f"file name collision under {rel_dir}")


def append_standing_long_term(
    entity: EntityRef,
    content: str,
    *,
    section: str = "User preferences",
) -> dict[str, Any]:
    """Append a bullet into ``memory/standing.md`` (长期记忆).

    Dialogue ``[preference]`` notes land here. Updating outdated prefs is the
    **model's** job: read standing, edit, then ``assets write`` / note with
    ``path=memory/standing.md`` + ``query=replace`` — no heuristic replace here.
    """
    from evoflow.assets.ad_hoc_note import ensure_body_recorded_at

    raw = ensure_body_recorded_at(str(content or "").strip()).strip()
    if not raw:
        raise ValueError("content is required")
    lines = raw.splitlines()
    if lines and re.match(r"^\[preference\]\s*", lines[0], re.I):
        raw = "\n".join(lines[1:]).strip() or raw
    stamp = ""
    stamp_m = re.match(r"^记录时间[:：]\s*(.+?)\s*(?:\n+|$)", raw)
    if stamp_m:
        stamp = stamp_m.group(1).strip()
        raw = raw[stamp_m.end() :].strip()
    if not raw:
        raise ValueError("content is required")
    if raw.lstrip().startswith(("- ", "* ", "+ ")):
        bullet = raw
    else:
        bullet = f"- {raw}"
    if stamp and "记录时间" not in bullet:
        bullet = bullet.rstrip() + f"\n  记录时间：{stamp}"
    ensure_entity_tree(entity)
    rel = "memory/standing.md"
    path = resolve_entity_file(entity, rel)
    try:
        existing = path.read_text(encoding="utf-8") if path.is_file() else ""
    except OSError:
        existing = ""
    body = str(existing or "").strip()
    if not body:
        body = "v1\n\n## User Profile\n\n## User preferences\n\n## General Tips\n\n## What's in Memory\n"
    elif not body.startswith("v1"):
        body = "v1\n\n" + body.lstrip()

    heading = f"## {section.strip() or 'User preferences'}"
    if heading in body:
        idx = body.find(heading)
        after = idx + len(heading)
        rest = body[after:]
        next_h = re.search(r"\n##\s+", rest)
        if next_h:
            insert_at = after + next_h.start()
            new_body = body[:insert_at].rstrip() + f"\n{bullet}\n" + body[insert_at:].lstrip("\n")
        else:
            new_body = body.rstrip() + f"\n{bullet}\n"
    else:
        marker = "## What's in Memory"
        if marker in body:
            new_body = body.replace(marker, f"{heading}\n{bullet}\n\n{marker}", 1)
        else:
            new_body = body.rstrip() + f"\n\n{heading}\n{bullet}\n"
    if not new_body.endswith("\n"):
        new_body += "\n"
    return write_text_file(entity, rel, new_body)


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

    Legacy/internal: product IA no longer promotes 「条目」; dialogue prefs go to
    standing via ``append_standing_long_term``. Gateway ``/record`` may still use this.
    Catalog uses ``title`` + ``summary`` (same model as craft/journal).
    """
    from evoflow.assets.ad_hoc_note import ensure_body_recorded_at
    from datetime import datetime

    body = ensure_body_recorded_at(str(content or "").strip()).strip()
    if not body:
        raise ValueError("content is required")
    ensure_entity_tree(entity)

    heading = str(title or "").strip() or body.split("\n", 1)[0].lstrip("# ").strip()[:60]
    one_liner = (str(summary or "").strip() or heading)[:30]
    slug = _slug_cjk(str(slug_hint or "").strip() or heading, fallback="fact")
    rel = _unique_rel_name(entity, "memory/facts", slug)
    created = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    e = entity.normalized()
    cat_line = ""
    if category.strip() and e.entity_type == "workspace":
        from evoflow.assets.workspace_memory_policy import normalize_workspace_fact_category

        cat_line = f"category: {normalize_workspace_fact_category(category)}\n"
    md = f"---\ntitle: {heading}\nsummary: {one_liner}\n{cat_line}entity: {e.entity_type}\nentity_id: {e.entity_id}\ncreated_at: {created}\n---\n\n# {heading}\n\n{body}\n"
    return write_text_file(entity, rel, md)


def write_episode(
    entity: EntityRef,
    content: str,
    *,
    title: str = "",
    summary: str = "",
    update_path: str = "",
) -> dict[str, Any]:
    """Write a process note under ``memory/episodic/``.

    Pass ``update_path`` (model-chosen) to overwrite that file; otherwise create new.
    """
    from evoflow.assets.ad_hoc_note import ensure_body_recorded_at
    from datetime import datetime

    body = ensure_body_recorded_at(str(content or "").strip()).strip()
    if not body:
        raise ValueError("content is required")
    ensure_entity_tree(entity)

    heading = str(title or "").strip() or body.split("\n", 1)[0].lstrip("# ").strip()[:60]
    one_liner = (str(summary or "").strip() or heading)[:30]
    slug = _slug_cjk(heading, fallback="episode")
    now = datetime.now(UTC).astimezone()
    day = now.date().isoformat()
    upd = str(update_path or "").replace("\\", "/").lstrip("/")
    updated = False
    if upd.startswith("memory/episodic/") and upd.endswith(".md"):
        rel = upd
        updated = resolve_entity_file(entity, rel).is_file()
    else:
        rel = _unique_rel_name(entity, "memory/episodic", slug)
    created = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    e = entity.normalized()
    md = f"---\ntitle: {heading}\nsummary: {one_liner}\ndate: {day}\nentity: {e.entity_type}\nentity_id: {e.entity_id}\ncreated_at: {created}\n---\n\n# {heading}\n\n{body}\n"
    data = write_text_file(entity, rel, md)
    return {**data, "updated": updated}


def write_journal(
    entity: EntityRef,
    content: str,
    *,
    title: str = "",
    date: str = "",
    append: bool = True,
    summary: str = "",
    update_path: str = "",
) -> dict[str, Any]:
    """Create / append / overwrite ``memory/journal/{slug}.md``.

    ``update_path`` (model-chosen) forces overwrite of that file.
    """
    from evoflow.assets.ad_hoc_note import ensure_body_recorded_at
    from datetime import date as date_cls
    from datetime import datetime

    body = ensure_body_recorded_at(str(content or "").strip()).strip()
    if not body:
        raise ValueError("content is required")

    day = str(date or "").strip()
    if not day:
        day = datetime.now(UTC).astimezone().date().isoformat()
    else:
        date_cls.fromisoformat(day)

    heading = (
        str(title or "").strip()
        or str(summary or "").strip()
        or body.split("\n", 1)[0].lstrip("# ").strip()[:60]
    )
    one_liner = (str(summary or "").strip() or heading)[:30]
    slug = _slug_cjk(heading, fallback="reflection")

    ensure_entity_tree(entity)
    upd = str(update_path or "").replace("\\", "/").lstrip("/")
    if upd.startswith("memory/journal/") and upd.endswith(".md"):
        rel = upd
        append = False
    else:
        rel = f"memory/journal/{slug}.md"
    e = entity.normalized()
    target = resolve_entity_file(e, rel)
    updated = False
    with lock_for(target):
        existing = ""
        if target.is_file():
            try:
                existing = target.read_text(encoding="utf-8")
            except OSError:
                existing = ""

        def _with_frontmatter(body_md: str) -> str:
            raw = body_md
            if raw.startswith("---"):
                parts = raw.split("---", 2)
                if len(parts) >= 3:
                    raw = parts[2].lstrip("\n")
            fm = f"---\ntitle: {heading}\ndate: {day}\nsummary: {one_liner}\n---\n\n"
            if not raw.lstrip().startswith("#"):
                raw = f"# {heading}\n\n{raw}"
            return fm + raw.rstrip() + "\n"

        if existing and append:
            stamp = datetime.now(UTC).astimezone().strftime("%H:%M")
            raw = existing
            if raw.startswith("---"):
                parts = raw.split("---", 2)
                if len(parts) >= 3:
                    raw = parts[2].lstrip("\n")
            merged = raw.rstrip() + f"\n\n## {stamp}\n\n{body}\n"
            text = _with_frontmatter(merged)
            updated = True
        elif existing:
            text = _with_frontmatter(body if body.lstrip().startswith("#") else f"# {heading}\n\n{body}\n")
            updated = True
        else:
            text = _with_frontmatter(f"# {heading}\n\n{body}\n")
        atomic_write_text(target, text)
    data = read_text_file(e, rel)
    return {**data, "updated": updated}


def save_craft_note(
    entity: EntityRef,
    *,
    title: str,
    content: str = "",
    description: str = "",
    update_path: str = "",
) -> dict[str, Any]:
    """Write ``craft/{slug}.md``. Pass ``update_path`` to overwrite a model-chosen file."""
    from evoflow.assets.craft import save_craft_from_experience

    t = str(title or "").strip()
    if not t:
        raise ValueError("title is required")
    body = str(content or "").strip()
    e = entity.normalized()
    desc = (str(description or "").strip() or t)[:30]
    upd = str(update_path or "").replace("\\", "/").lstrip("/")
    if upd.startswith("craft/") and upd.endswith(".md"):
        skill_name = Path(upd).stem
        updated = resolve_entity_file(entity, upd).is_file()
        rel = upd
    else:
        # New craft: unique name if slug taken (do not silently clobber another craft).
        slug = _slug_cjk(t, fallback="craft")
        rel = _unique_rel_name(entity, "craft", slug)
        skill_name = Path(rel).stem
        updated = False
    data = save_craft_from_experience(
        {
            "title": t,
            "description": desc,
            "solution": body or t,
            "origin": "manual",
            "entity_type": e.entity_type,
            "entity_id": e.entity_id,
            "category": "general",
            "skill_name": skill_name,
        }
    )
    return {**data, "updated": updated, "path": rel}


def delete_text_file(entity: EntityRef, rel_path: str) -> dict[str, Any]:
    """Delete a text asset under the entity tree."""
    ensure_entity_tree(entity)
    e = entity.normalized()
    rel = str(rel_path or "").replace("\\", "/").lstrip("/")
    if not rel:
        raise ValueError("path is required")
    # Protect core profile files from casual delete
    protected = {
        "profile/USER.md",
        "profile/SOUL.md",
        "profile/identity.md",
        "profile/system.md",
        "profile/soul-summary.md",
        "profile/affect.md",
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
    return {
        "ok": True,
        "entityType": e.entity_type,
        "entityId": e.entity_id,
        "path": rel,
        "deleted": True,
    }
