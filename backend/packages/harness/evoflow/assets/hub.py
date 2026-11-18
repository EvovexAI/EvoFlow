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


# 【self-evolution-bot · 2026-11-17 · 第32轮】新增进程级"已建好骨架"缓存（按路径记）。
# 为什么：obs 实测 delete P50=349ms、并发 11 次时 P90=15.7s，而删除本体只是一个 unlink()。
#   大头在每次写动作都全量重跑目录骨架 ensure（assets 树 + 实体树：约 8 次 mkdir、
#   5 次 is_file、affect 默认文件、_migrate_craft_dirs_to_files 目录扫描、standing/MEMORY 检查）。
#   Windows 上这些元数据操作打在同一批目录上会互相串行排队——并发写越多排得越久。
# 缓存语义：首次调用照常建骨架并记下该路径；之后同路径重复调用 = set 查找 + 一次 is_dir()。
# 边界：键用未 resolve 的 str(path)，只会"多跑一次"（大小写不同的同一路径 miss 后重新 ensure），
#   不会假命中；测试换 vault（不同 tmp_path）天然不同键。ent_root 被外部整删时 is_dir()
#   不过 → 自动重新 ensure。注意一条**行为变化**：用 delete 删掉的 standing.md/MEMORY.md
#   不再被下次写入"复活"——删除即真删除，与本工具"删除不可撤销"的回执口径一致。
_ENSURED_ASSET_ROOTS: set[str] = set()
_ENSURED_ENTITY_ROOTS: set[str] = set()


def ensure_assets_tree() -> Path:
    """Create ``assets/`` skeleton if missing (process-cached per root path)."""
    root = assets_root()
    if str(root) in _ENSURED_ASSET_ROOTS and root.is_dir():
        return root
    root.mkdir(parents=True, exist_ok=True)

    index = root / "index.md"
    if not index.is_file():
        index.write_text(default_index_md(), encoding="utf-8")

    user_profile_parent = profile_dir(EntityRef("user", "user"))
    user_profile_parent.mkdir(parents=True, exist_ok=True)

    for sub in ("memory", "craft"):
        (entity_root(EntityRef("user", "user")) / sub).mkdir(parents=True, exist_ok=True)

    _ensure_obsidian_marker(root)
    _ENSURED_ASSET_ROOTS.add(str(root))
    return root


def _ensure_obsidian_marker(dest: Path) -> None:
    obsidian = dest / ".obsidian"
    obsidian.mkdir(parents=True, exist_ok=True)
    app = obsidian / "app.json"
    if not app.is_file():
        app.write_text('{"legacyEditor": false, "livePreview": true}\n', encoding="utf-8")


def ensure_entity_tree(entity: EntityRef) -> Path:
    # 【self-evolution-bot · 2026-11-17 · 第32轮】命中进程缓存即早退（见 _ENSURED_ASSET_ROOTS 注释）。
    #   delete/note/write 每次都全量走这里，实测单次约 15~20 个文件系统元数据操作，
    #   并发写全挤在同一批目录上互相排队——这是 delete P90=15.7s 的主要构成。
    #   行为变化：删掉的 standing.md/MEMORY.md 不再被下次写入复活（删除即真删除）。
    ent_root = entity_root(entity.normalized())
    if str(ent_root) in _ENSURED_ENTITY_ROOTS and ent_root.is_dir():
        return ensure_assets_tree()
    root = ensure_assets_tree()
    e = entity.normalized()
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
        _ENSURED_ENTITY_ROOTS.add(str(ent_root))
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
    _ENSURED_ENTITY_ROOTS.add(str(ent_root))
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
        # 【self-evolution-bot · 2026-11-18 · 第56轮 · 模型:deepseek-v4.1-flash-1017】
        # 改了什么：报错从一句无信息量的「only text assets can be written via API」改成点名
        #   具体文件名、它当前的后缀、以及允许的后缀清单。
        # 为什么：原文案不带文件名也不带后缀，导致 2026-11-17 那条
        #   `kind='reflection'` + 裸名 的 14 次写入失败在观测库里挂了整整两天没人归因——
        #   看报错根本不知道被拒的是哪个文件、缺的是什么。留着原文案还会继续吞掉同类问题。
        _allowed = ", ".join(sorted(_TEXT_SUFFIXES))
        raise ValueError(
            f"only text assets can be written via API: {rel_path!r} has suffix "
            f"{target.suffix.lower() or '(none)'} , allowed suffixes are {_allowed}"
        )
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

    from evoflow.assets.ad_hoc_note import strip_md_ext

    global _SLUG_CJK_RE
    if _SLUG_CJK_RE is None:
        _SLUG_CJK_RE = re.compile(r"[^a-zA-Z0-9\u4e00-\u9fff_-]+")
    # A title that already carries the extension ("runbook.md") must not become
    # "runbook-md.md": the dot folds into a separator below.
    s = strip_md_ext(text)
    s = _SLUG_CJK_RE.sub("-", str(s or "").strip()).strip("-_")
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

    Dialogue ``kind=preference`` notes land here. Updating outdated prefs is the
    **model's** job: read standing, then ``assets note`` with ``kind=preference``
    + ``mode=replace`` (or ``write`` the path) — no heuristic replace here.
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
    # as_bullet_block: first line stays the bullet, the rest must indent —
    # otherwise a "## xyz" inside the note becomes a real section of standing.md.
    from evoflow.assets.ad_hoc_note import as_bullet_block

    bullet = as_bullet_block(raw)
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
    from evoflow.assets.ad_hoc_note import ensure_body_recorded_at, title_from_body
    from datetime import datetime

    body = ensure_body_recorded_at(str(content or "").strip()).strip()
    if not body:
        raise ValueError("content is required")
    ensure_entity_tree(entity)

    heading = str(title or "").strip() or title_from_body(body)
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
    from evoflow.assets.ad_hoc_note import ensure_body_recorded_at, title_from_body
    from datetime import datetime

    body = ensure_body_recorded_at(str(content or "").strip()).strip()
    if not body:
        raise ValueError("content is required")
    ensure_entity_tree(entity)

    heading = str(title or "").strip() or title_from_body(body)
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
    # Models routinely write their own ``# 标题`` first line, and ``heading`` was
    # derived from it — prepending the template H1 printed the title twice.
    content = body if body.lstrip().startswith("#") else f"# {heading}\n\n{body}"
    md = f"---\ntitle: {heading}\nsummary: {one_liner}\ndate: {day}\nentity: {e.entity_type}\nentity_id: {e.entity_id}\ncreated_at: {created}\n---\n\n{content}\n"
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
    from evoflow.assets.ad_hoc_note import ensure_body_recorded_at, title_from_body
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
        or title_from_body(body)
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
        else:
            # Same double-H1 trap as write_episode: ``heading`` is usually taken
            # from the body's own first line, so prepending it printed the title
            # twice. _with_frontmatter already adds one only when missing.
            text = _with_frontmatter(body)
            updated = bool(existing)
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
    mode: str = "",
) -> dict[str, Any]:
    """Write ``craft/{slug}.md``. ``update_path`` now **appends**; pass ``mode=replace`` to overwrite."""
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
        # 【fullstack-dev · 2026-11-15 · 第13轮增量二】改：新建时展示标题优先取**正文首个标题行**
        # （与 ad_hoc_note.title_from_body 同一口径）。为什么：note 路径把 path stem 当 title、
        # 正文首行是用户写的「## 小节名」，两者字面不同文 → craft.py 的同文去重判据永远不命中，
        # 实测落盘三层重复（# stem → ## 解决方案 → ## 小节名）。文件名仍用 stem（不动命名规则），
        # 只把渲染/比对用的标题对齐到正文。
        body_first_heading = ""
        for _ln in body.splitlines():
            _s = _ln.strip()
            if _s.startswith("#"):
                body_first_heading = _s.lstrip("#").strip()
                break
            if _s:
                break
        t = body_first_heading or t
        # 【self-evolution-bot · 2026-11-17 · 第31轮】改：slug 撞名且**标题同文**时，不再加随机后缀
        #   另存新文件，而是命中已有文件走下面的追加分支。为什么：wrap-up 镜像同题重跑时
        #   `_unique_rel_name` 造出 `X.md` + `X-a137.md`（H1 完全同文）两份——"防撞=防覆盖"是
        #   第12轮追加语义落地前的老前提，现在同题追加不丢内容，同题另存反而制造重复配方。
        #   判据用 `_h1_norm`（同文归一化，与第12轮双标题判据同一口径）：frontmatter name 或正文
        #   首个 H1 任一与新标题同文 → 视为同一配方。
        # 边界：撞 slug 但标题**不同文**（48 字截断致撞、或改名）→ 仍走 _unique_rel_name 另存，
        #   不吞另一篇配方；mode=replace 显式覆盖的语义不变。
        slug = _slug_cjk(t, fallback="craft")
        rel = f"craft/{slug}.md"
        updated = False
        candidate = resolve_entity_file(e, rel)
        if candidate.is_file():
            from evoflow.assets.craft import _h1_norm

            try:
                _existing_txt = candidate.read_text(encoding="utf-8")
            except OSError:
                _existing_txt = ""
            _fm_name = ""
            if _existing_txt.startswith("---"):
                _blocks = _existing_txt.split("---", 2)
                if len(_blocks) >= 3:
                    _fm_m = re.search(r"^name:\s*(.+)$", _blocks[1], re.M)
                    _fm_name = _fm_m.group(1).strip() if _fm_m else ""
            _h1_m = re.search(r"^# +(.+)$", _existing_txt, re.M)
            _norm_new = _h1_norm(t)
            if _norm_new and (
                (_fm_name and _h1_norm(_fm_name) == _norm_new)
                or (_h1_m and _h1_norm(_h1_m.group(1)) == _norm_new)
            ):
                updated = True  # 同文命中 → 下面走追加
            else:
                rel = _unique_rel_name(e, "craft", slug)
        skill_name = Path(rel).stem
    # 【fullstack-dev · 2026-11-15 · 第12轮】改：update_path 命中已有文件时，从"整篇重建覆盖"改为追加一节。
    # 为什么：我按工具自己写的规矩（``note`` 默认追加、``write`` 才要 mode=replace）用 note 更新 craft 配方，
    # 结果 ``save_craft_from_experience`` 把文件**整份重写**，上一轮写的两段分析直接没了，回执还是 ``ok:true``
    # —— 这就是本岗判据里的"静默丢数据还说成功"，比双标题严重得多（双标题只多占篇幅，这个吞内容）。
    # 边界：只有显式 ``mode=replace`` 才走整篇重建（保留原行为）；新建（无 update_path / 文件不存在）仍整篇写。
    # 追加时不动 frontmatter 的 description/experience_id：那是列表预览与外部引用用的，不该被每次追加改写。
    if updated and str(mode or "").strip().lower() != "replace":
        from datetime import datetime

        target = resolve_entity_file(e, rel)
        with lock_for(target):
            try:
                existing = target.read_text(encoding="utf-8") if target.is_file() else ""
            except OSError:
                existing = ""
            # frontmatter 原样保留（name/description/experience_id 是列表预览与外部引用键，
            # 不该被每次追加改写），只在正文尾部接一节 —— 与 write_journal 的追加写法同一口径。
            head, old_body = existing, ""
            if existing.startswith("---"):
                blocks = existing.split("---", 2)
                if len(blocks) >= 3:
                    head, old_body = blocks[0] + "---" + blocks[1] + "---\n", blocks[2].lstrip("\n")
            stamp = datetime.now(UTC).astimezone().strftime("%H:%M")
            # 【第13轮增量二】补：追加路径同样会带进与文件 H1 同文的标题行（assets note 的
            # content 习惯以标题起笔）。这里只对**本次新增的 body**剥一次同名标题，
            # 不动 old_body —— 那是存量数据，订正属另一回事。
            from evoflow.assets.craft import strip_duplicate_leading_heading

            body = strip_duplicate_leading_heading(body, old_body)
            merged = (old_body.rstrip() + f"\n\n## 补充（{stamp}）\n\n{body}\n") if old_body else f"{body}\n"
            atomic_write_text(target, (head.rstrip("\n") + "\n\n" + merged).rstrip() + "\n")
        data = read_text_file(e, rel)
        return {**data, "updated": True, "path": rel, "appended": True}
    data = save_craft_from_experience(
        {
            "title": t,
            "description": desc,
            # 【fullstack-dev · 2026-11-15 · 第14轮】改：note 路径显式走 ``body_md``（verbatim 通道），
            #   不再复用 ``solution`` 字段。为什么：craft.py 上一版靠「solution 非空就当整篇正文」猜
            #   note 路径，把所有结构化调用方一起卷进 verbatim，读侧分节预览全空；verbatim 入口
            #   收窄为只认 body_md 后，本处必须自己传对，否则 note 落回分节拼装、双标题又回来。
            # 边界：空正文时仍传 title 兜底（保持原 ``body or t`` 语义，避免落盘空文件）。
            # 【fullstack-dev · 2026-11-15 · 第14轮】补：显式带 ``note_body=True``——craft 侧
            #   据此走 verbatim；solution 复用通道已删，结构化调用方不再被误伤。
            "body_md": body or t,
            "note_body": True,
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
        # 【self-evolution-bot · 2026-11-18 · 第56轮 · 模型:deepseek-v4.1-flash-1017】同 write 分支的文案缺陷：不点名文件与后缀。
        raise ValueError(
            f"only text assets can be deleted via API: {rel!r} has suffix "
            f"{target.suffix.lower() or '(none)'} , allowed suffixes are "
            f"{', '.join(sorted(_TEXT_SUFFIXES))}"
        )
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


# Profile core files that must not be renamed away (identity anchors).
_RENAME_PROTECTED = frozenset(
    {
        "profile/USER.md",
        "profile/SOUL.md",
        "profile/identity.md",
        "profile/system.md",
        "profile/soul-summary.md",
        "profile/affect.md",
    }
)


def rename_text_file(entity: EntityRef, rel_path: str, new_name: str) -> dict[str, Any]:
    """Rename a text asset inside the same directory (basename only).

    ``new_name`` may carry a ``.md`` suffix or not; it must stay inside the
    asset's own directory — moving between kinds is a delete + write.
    """
    ensure_entity_tree(entity)
    e = entity.normalized()
    rel = str(rel_path or "").replace("\\", "/").lstrip("/")
    if not rel:
        raise ValueError("path is required")
    if rel in _RENAME_PROTECTED:
        raise ValueError(f"protected profile file cannot be renamed: {rel}")
    target = resolve_entity_file(e, rel)
    if not target.is_file():
        raise FileNotFoundError(rel)
    if target.suffix.lower() not in _TEXT_SUFFIXES:
        # 【self-evolution-bot · 2026-11-18 · 第56轮 · 模型:deepseek-v4.1-flash-1017】同 write 分支的文案缺陷：不点名文件与后缀。
        raise ValueError(
            f"only text assets can be renamed via API: {rel!r} has suffix "
            f"{target.suffix.lower() or '(none)'} , allowed suffixes are "
            f"{', '.join(sorted(_TEXT_SUFFIXES))}"
        )

    raw_new = str(new_name or "").strip().replace("\\", "/").lstrip("/")
    if not raw_new:
        raise ValueError("new_name is required")
    if "/" in raw_new:
        raise ValueError("new_name must be a basename (same directory); move = delete + write")
    if not raw_new.lower().endswith(".md"):
        raw_new += ".md"
    if raw_new.lower() == target.name.lower():
        return {
            "ok": True,
            "entityType": e.entity_type,
            "entityId": e.entity_id,
            "path": rel,
            "renamed": False,
        }

    dest = target.with_name(raw_new)
    if dest.exists():
        raise FileExistsError(f"target already exists: {dest.name}")
    old_stem = target.stem
    with lock_for(target):
        target.rename(dest)
    synced, synced_keys = _sync_frontmatter_name(dest, old_stem)
    new_rel = dest.relative_to(entity_root(e)).as_posix()
    result = {
        "ok": True,
        "entityType": e.entity_type,
        "entityId": e.entity_id,
        "path": rel,
        "newPath": new_rel,
        "renamed": True,
        "frontmatterSynced": synced,
        "syncedKeys": list(synced_keys),
    }
    if synced:
        result["hint"] = (
            f"已重命名为 {new_rel}，frontmatter 的 {'/'.join(synced_keys)} 已同步为新文件名。"
        )
    return result


def _sync_frontmatter_name(path: Path, old_stem: str = "") -> bool:
    """Keep the file's frontmatter identity aligned with its new filename.

    Two shapes exist and both were broken by a rename:
    - craft/skill files: ``name: <slug>`` mirrors the filename.
    - memory notes (episodic/journal/facts): ``title:`` — and the catalog prefers
      ``title`` over the body H1, so a stale title keeps showing the OLD label
      under the new file.

    Prose stays untouched: ``description``/``summary`` are only rewritten when
    their value *was* the old stem. ``title`` only when it slug-matches the old
    stem (i.e. machine-generated from it) — a hand-written Chinese title is the
    author's and must survive a rename.
    Returns ``(changed, synced_keys)`` — the keys are reported back so the hint
    can name what actually moved (saying "name 已同步" on a journal note, which
    has no ``name:`` at all, made the result look wrong even when it was right).
    """
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return False, ()
    if not text.startswith("---"):
        return False, ()
    parts = text.split("---", 2)
    if len(parts) < 3:
        return False, ()
    head, body = parts[1], parts[2]
    new_head = head
    synced: list[str] = []
    if re.search(r"(?m)^name\s*:", new_head):
        new_head = re.sub(r"(?m)^name\s*:.*$", f"name: {path.stem}", new_head, count=1)
        synced.append("name")
    title_m = re.search(r"(?m)^title\s*:\s*(.+?)\s*$", new_head)
    if title_m:
        old_title = title_m.group(1).strip().strip("'\"")
        comparable = (old_stem or "").lower()
        # ``title`` reaches here as prose ("资产自检 TESTONLY") while the stem is its
        # slug, so compare on the slug form and ignore case.
        if old_title and comparable and _slug_cjk(old_title).lower() == comparable:
            new_head = re.sub(r"(?m)^title\s*:.*$", f"title: {path.stem}", new_head, count=1)
            synced.append("title")
    if old_stem and old_stem != path.stem:
        for key in ("description", "summary"):
            replaced = re.sub(
                rf'(?m)^{key}\s*:\s*["\']?{re.escape(old_stem)}["\']?\s*$',
                f"{key}: {path.stem}",
                new_head,
                count=1,
            )
            if replaced != new_head:
                new_head = replaced
                synced.append(key)
    if new_head == head:
        return False, ()
    with lock_for(path):
        atomic_write_text(path, f"---{new_head}---{body}")
    return True, tuple(synced)
