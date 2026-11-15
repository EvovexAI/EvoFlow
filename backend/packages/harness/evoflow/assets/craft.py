"""Craft skills under Asset Hub ``craft/*.md`` (replaces experience library)."""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any

from evoflow.assets.paths import EntityRef

logger = logging.getLogger(__name__)

_SLUG_RE = re.compile(r"[^a-z0-9_\u4e00-\u9fff-]+")

# 【fullstack-dev · 2026-11-15 · 第12轮】新建：标题同文判据要用到的归一化。
_H1_KEEP_RE = re.compile(r"[^0-9a-z\u4e00-\u9fff]+")
_H1_MARK_RE = re.compile(r"^#+\s*")
# 连接词与分隔符：title 与正文 H1 常常只差这些（slug 化会丢标点、并把连接处换成"与"）。
_H1_CONNECTOR_RE = re.compile(r"[-_·—…+/与和及或而、]+")


def _h1_norm(line: str) -> str:
    """把一行标题折成可比较的骨架：去 ``#``、去尾 ``.md``、只留汉字与字母数字。

    为什么：第11轮用字面相等判"重复标题"，但 hub 侧的 title 经过了 slug（``+``/``：`` 变 ``-``、
    标点丢失）和 ``title_from_body`` 的 60 字截断，正文 H1 是原话，两者只差标点或长度 → 判不出同文。
    实测最脏一例：title ``会话通知面板-状态中文化与压缩`` vs 正文 ``# 会话通知面板：状态中文化 + 压缩``
    —— slug 把 ``+`` 写成 ``-``，又把连接处补成 ``与``，第11轮的字面相等与前缀判断全都不命中。
    故这里连单字连接词一起吃掉：只用于"是不是同一句标题"的判断，不产出任何写入文本。
    边界：实词不同的仍不相等，不会被误删。
    """
    raw = str(line or "").strip()
    raw = _H1_MARK_RE.sub("", raw)
    if raw.lower().endswith(".md"):
        raw = raw[:-3]
    raw = _H1_CONNECTOR_RE.sub("", raw)
    return _H1_KEEP_RE.sub("", raw.lower())


def _title_text(data: dict[str, Any]) -> str:
    """取展示用标题：一律去掉模型粘来的 ``.md`` 后缀。

    【fullstack-dev · 2026-11-15 · 第12轮】新建。
    为什么：``strip_md_ext`` 此前只接在 ``_slug``（craft.py:19）上，文件名是干净了，
    **标题本身的渲染路径没接** —— 存量 ``craft/信息条类需求先确认面板归属.md`` 的第 13 行
    就是 ``# 信息条类需求先确认面板归属.md``，把人写的文件名当标题显示。同一条规则的读写两侧
    只修一侧，等于没修（这是本岗第 N 次撞"改一处漏一处"，见 standing）。
    """
    from evoflow.assets.ad_hoc_note import strip_md_ext

    return strip_md_ext(str(data.get("title") or "").strip())


def _same_heading(a: str, b: str) -> bool:
    """两个归一化标题是否视为同一句：短侧是长侧前缀，且短侧 ≥12 字符（防短公共前缀误判）。"""
    if not a or not b:
        return False
    short, long_ = (a, b) if len(a) <= len(b) else (b, a)
    return len(short) >= 12 and long_.startswith(short)


def _slug(name: str, *, max_len: int = 48) -> str:
    from evoflow.assets.ad_hoc_note import strip_md_ext

    # Same trap as _slug_cjk: a pasted "runbook.md" title slugged to runbook-md.md.
    s = _SLUG_RE.sub("-", strip_md_ext(str(name or "")).strip().lower()).strip("-")
    if not s:
        s = "craft"
    return s[:max_len].strip("-") or "craft"


def _entity_from_data(data: dict[str, Any]) -> EntityRef:
    et = str(data.get("entity_type") or data.get("entity") or "user").strip().lower()
    eid = str(data.get("entity_id") or data.get("entityId") or "user").strip()
    if et == "user":
        # Respect a caller-supplied bucket id (per-principal ``users/<id>``);
        # legacy callers without an id keep the shared ``user`` bucket.
        from evoflow.assets.paths import sanitize_user_asset_id

        return EntityRef("user", sanitize_user_asset_id(eid or "user"))
    if et == "employee":
        return EntityRef("employee", eid.lower())
    return EntityRef("agent", eid.lower())


def _craft_root(entity: EntityRef) -> Path:
    from evoflow.assets.hub import ensure_entity_tree, entity_root

    ensure_entity_tree(entity)
    root = entity_root(entity) / "craft"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _parse_skill_frontmatter(text: str) -> tuple[dict[str, Any], str]:
    raw = str(text or "")
    if not raw.startswith("---"):
        return {}, raw
    parts = raw.split("---", 2)
    if len(parts) < 3:
        return {}, raw
    meta: dict[str, Any] = {}
    for line in parts[1].strip().splitlines():
        if ":" not in line:
            continue
        k, v = line.split(":", 1)
        key = k.strip()
        val = v.strip()
        if val.startswith("[") or val.startswith("{") or val.startswith('"'):
            try:
                meta[key] = json.loads(val)
            except json.JSONDecodeError:
                meta[key] = val
        else:
            meta[key] = val
    return meta, parts[2].lstrip()


def _build_skill_md(
    *,
    name: str,
    description: str,
    entity: EntityRef,
    body_md: str,
    meta: dict[str, Any],
) -> str:
    import yaml

    front: dict[str, Any] = {
        "name": name,
        "description": description[:500],
        "origin": str(meta.get("origin") or "distilled"),
        "entity": entity.entity_type,
        "entity_id": entity.entity_id,
    }
    for key in ("experience_id", "tags", "confidence", "category"):
        if meta.get(key) is not None:
            front[key] = meta.get(key)
    header = yaml.safe_dump(front, allow_unicode=True, sort_keys=False).strip()
    return f"---\n{header}\n---\n\n{body_md.strip()}\n"


def experience_to_skill_body(data: dict[str, Any]) -> str:
    # A caller-supplied ``body_md`` is already a full Markdown body (it may
    # carry its own ``## 问题`` / ``## 解决方案`` sections) — use it verbatim
    # instead of nesting it under a generated heading.
    raw_body = str(data.get("body_md") or "").strip()
    if raw_body:
        # 【fullstack-dev · 2026-11-15 · 第12轮】改：两个分支的标题取值统一走 _title_text（顺带去 .md 后缀）。
        title = _title_text(data)
        if not raw_body.startswith("# "):
            head = f"# {title or '专长'}"
            return f"{head}\n\n{raw_body}\n"
        return raw_body + "\n"

    ctx = data.get("context") if isinstance(data.get("context"), dict) else {}
    problem = str(data.get("problem") or ctx.get("problem") or "").strip()
    solution = str(data.get("solution") or ctx.get("solution") or "").strip()
    # 【fullstack-dev · 2026-11-15 · 第11轮】改：正文首行若是与标题同文的 H1，去掉这一行重复标题。
    # 为什么：assets note(kind=experience) 走 hub.py:784 把**整篇正文**当 solution 传进来，而正文首行本身就是
    # ``# 标题``，于是套出「# 标题 … ## 解决方案 … # 标题 …」的双份标题（实测 craft/ 31 个文件里 5 个中招，
    # 其中就有我本轮刚写的 ci-local 配方）—— 白占注入篇幅，读起来像两份文档粘在一起。
    # 【fullstack-dev · 2026-11-15 · 第12轮】改：判据从「与 title 完全同文」换成**归一化同文 + 截断前缀**。
    # 为什么：第11轮那条只在字面完全相等时生效，实测 5 个中招文件里 **2 个根本不命中**——
    #   · ``会话通知面板-状态中文化与压缩`` vs 正文 ``# 会话通知面板：状态中文化 + 压缩``（标点/空格被 slug 化过）
    #   · title 是 ``title_from_body`` 截到 60 字的版本，正文 H1 更长（前缀相同、字面不等）
    # 即"同一句话被换了分隔符/截了尾"，第11轮的等值判断把它们放过了，等于没修好。
    # 边界：归一化只去掉空白与中英标点，**词不同的仍是两个标题**，不删（宁可留重复也不吞措辞）；
    #   前缀匹配要求短的一侧归一化后 ≥ 12 字，避免把「某某面板」这类短公共前缀误判成同文。
    # 不动 ``## 解决方案`` 这个段落名本身：craft.py:270/392 按它取列表/详情的 solution 字段，
    # 若改成传 body_md（verbatim 分支）虽去掉重复，却会让那两处的预览变空 —— 那是更坏的取舍。
    if solution.startswith("# "):
        _first = _h1_norm(solution.splitlines()[0])
        _want = _h1_norm(str(data.get("title") or ""))
        if _first and _want and (_first == _want or _same_heading(_first, _want)):
            solution = "\n".join(solution.splitlines()[1:]).strip()
    outcome = str(data.get("outcome") or ctx.get("outcome") or "").strip()
    applicable = str(data.get("applicable_to") or ctx.get("applicable_to") or "").strip()
    steps = data.get("steps") or []
    if not isinstance(steps, list):
        steps = []
    parts: list[str] = [f"# {_title_text(data) or '专长'}\n"]
    if applicable:
        parts.append(f"\n## 适用场景\n{applicable}\n")
    if problem:
        parts.append(f"\n## 问题\n{problem}\n")
    if solution:
        parts.append(f"\n## 解决方案\n{solution}\n")
    if outcome:
        parts.append(f"\n## 结果\n{outcome}\n")
    if steps:
        parts.append("\n## 步骤\n")
        for i, step in enumerate(steps, 1):
            parts.append(f"{i}. {str(step).strip()}\n")
    return "\n".join(parts).strip() + "\n"


def save_craft_from_experience(data: dict[str, Any]) -> dict[str, Any]:
    # 【fullstack-dev · 2026-11-15 · 第12轮】改：入口标题先去 .md 后缀，frontmatter 的 name/description
    # 与正文 H1 才会一致（此前只有文件名干净，标题带着 .md 显示）。
    title = _title_text(data)
    if not title:
        raise ValueError("title is required")
    entity = _entity_from_data(data)
    exp_id = str(data.get("id") or data.get("experience_id") or "").strip()
    if not exp_id:
        import uuid

        exp_id = f"exp_{uuid.uuid4().hex[:12]}"
    slug = _slug(data.get("skill_name") or title)
    craft_root = _craft_root(entity)
    skill_path = craft_root / f"{slug}.md"
    tags = data.get("tags") or []
    if not isinstance(tags, list):
        tags = []
    from evoflow.assets.ad_hoc_note import ensure_body_recorded_at

    body = ensure_body_recorded_at(experience_to_skill_body(data)).strip()
    description = str(data.get("description") or problem_summary(data) or title)[:500]
    meta = {
        "origin": str(data.get("origin") or "migrated_experience"),
        "experience_id": exp_id,
        "tags": tags,
        "confidence": float(data.get("confidence") or 1.0),
        "category": str(data.get("category") or "general"),
    }
    content = _build_skill_md(
        name=slug,
        description=description,
        entity=entity,
        body_md=body,
        meta=meta,
    )
    tmp = skill_path.with_suffix(".md.tmp")
    tmp.write_text(content, encoding="utf-8")
    tmp.replace(skill_path)
    rel = skill_path.relative_to(craft_root.parent).as_posix()
    try:
        from evoflow.assets.memory_mirror import schedule_asset_vault_reindex_delayed

        schedule_asset_vault_reindex_delayed()
    except Exception:
        logger.debug("craft reindex schedule skipped", exc_info=True)
    return {
        "success": True,
        "id": exp_id,
        "title": title,
        "skill_name": slug,
        "path": rel,
        "entityType": entity.entity_type,
        "entityId": entity.entity_id,
        "storage": "craft",
    }


def problem_summary(data: dict[str, Any]) -> str:
    """One-line description for the SKILL.md frontmatter.

    Prefers an explicit ``description``; otherwise derives a concise first line
    from problem/solution/title. Keeping this short matters because the front
    matter ``description`` is what list views surface.
    """
    explicit = str(data.get("description") or "").strip()
    if explicit:
        return explicit[:200]
    ctx = data.get("context") if isinstance(data.get("context"), dict) else {}
    raw = str(data.get("problem") or ctx.get("problem") or data.get("solution") or ctx.get("solution") or "")
    if not raw.strip():
        # A verbatim body: use its first real line, skipping the H1/## headings.
        raw = str(data.get("body_md") or "")
        for line in raw.splitlines():
            s = line.strip()
            if s and not s.startswith("#"):
                return s[:160]
    first_line = next((ln.strip() for ln in raw.splitlines() if ln.strip()), "")
    return (first_line or str(data.get("title") or ""))[:160]


def list_craft_experiences(
    *,
    category: str = "",
    query: str = "",
    max_results: int = 50,
    entity: EntityRef | None = None,
) -> dict[str, Any]:
    from evoflow.assets.hub import assets_root

    root = assets_root()
    patterns = []
    if entity is not None:
        from evoflow.assets.paths import entity_root

        patterns.append(entity_root(entity) / "craft")
    else:
        patterns.extend(
            [
                root / "user" / "craft",
                root / "agents",
                root / "employees",
            ]
        )
    hits: list[dict[str, Any]] = []
    q = str(query or "").strip().lower()
    cat_prefix = str(category or "").strip().lower()

    def _scan_craft_dir(craft_dir: Path, entity_type: str, entity_id: str) -> None:
        if not craft_dir.is_dir():
            return
        for skill_md in sorted(craft_dir.glob("*.md")):
            if skill_md.name.upper() == "README.MD":
                continue
            try:
                text = skill_md.read_text(encoding="utf-8")
            except OSError:
                continue
            meta, body = _parse_skill_frontmatter(text)
            title = str(meta.get("name") or skill_md.stem).replace("-", " ")
            exp_id = str(meta.get("experience_id") or meta.get("id") or skill_md.stem)
            cat = str(meta.get("category") or "general")
            if cat_prefix and not cat.lower().startswith(cat_prefix):
                continue
            blob = f"{title}\n{body}\n{meta.get('description', '')}".lower()
            if q and q not in blob:
                continue
            sections = _sections_from_body(body)
            # The H1 in the body is the real title; ``description`` is a summary.
            display_title = _body_title(body) or str(meta.get("description") or title)
            hits.append(
                {
                    "id": exp_id,
                    "title": display_title[:120],
                    "category": cat,
                    "tags": meta.get("tags") if isinstance(meta.get("tags"), list) else [],
                    "problem": sections["problem"][:200],
                    "solution": sections["solution"][:200],
                    "outcome": sections["outcome"][:100],
                    "step_count": len(sections["steps"]),
                    "confidence": float(meta.get("confidence") or 1.0),
                    "use_count": 0,
                    "storage": "craft",
                    "path": (skill_md.relative_to(root).as_posix() if root in skill_md.resolve().parents or skill_md.resolve() == root.resolve() else skill_md.as_posix()),
                    "entityType": str(meta.get("entity") or entity_type),
                    "entityId": str(meta.get("entity_id") or entity_id),
                }
            )

    if entity is not None:
        from evoflow.assets.paths import entity_root as _entity_root

        craft_base = _entity_root(entity)
        _scan_craft_dir(craft_base / "craft", entity.entity_type, entity.entity_id)
    else:
        _scan_craft_dir(root / "user" / "craft", "user", "user")
        # Multi-user installs: per-principal buckets ``assets/users/<id>/craft``.
        # Asset Center shows the caller's personal bucket, so experiences saved
        # with a principal_id must be discoverable from the shared listing too.
        users_root = root / "users"
        if users_root.is_dir():
            for user_dir in sorted(users_root.iterdir()):
                if user_dir.is_dir() and not user_dir.name.startswith("."):
                    _scan_craft_dir(user_dir / "craft", "user", user_dir.name)
        agents_root = root / "agents"
        if agents_root.is_dir():
            for agent_dir in agents_root.iterdir():
                if agent_dir.is_dir():
                    _scan_craft_dir(agent_dir / "craft", "agent", agent_dir.name)
        emp_root = root / "employees"
        if emp_root.is_dir():
            for emp_dir in emp_root.iterdir():
                if emp_dir.is_dir():
                    _scan_craft_dir(emp_dir / "craft", "employee", emp_dir.name)

    hits.sort(key=lambda h: (h.get("confidence", 0), h.get("title", "")), reverse=True)
    # Respect caller max_results; soft cap 500 to avoid unbounded scans (DEF-02).
    # Always expose full matched ``total`` so callers are not fooled by page size (CORE-ASSET-03).
    limit = max(1, min(int(max_results or 50), 500))
    total = len(hits)
    page = hits[:limit]
    return {
        "items": page,
        "count": len(page),
        "total": total,
        "limit": limit,
        "has_more": total > limit,
        "query": q or None,
        "category": cat_prefix or None,
    }


def _iter_craft_skill_files() -> list[tuple[Path, str, str]]:
    """Yield ``(skill_md, entity_type, entity_id)`` under Asset Hub craft trees."""
    from evoflow.assets.hub import assets_root

    root = assets_root()
    out: list[tuple[Path, str, str]] = []

    def _collect(craft_dir: Path, entity_type: str, entity_id: str) -> None:
        if not craft_dir.is_dir():
            return
        for skill_md in craft_dir.glob("*.md"):
            if skill_md.name.upper() == "README.MD":
                continue
            out.append((skill_md, entity_type, entity_id))

    _collect(root / "user" / "craft", "user", "user")
    users_root = root / "users"
    if users_root.is_dir():
        for user_dir in users_root.iterdir():
            if user_dir.is_dir() and not user_dir.name.startswith("."):
                _collect(user_dir / "craft", "user", user_dir.name)
    agents_root = root / "agents"
    if agents_root.is_dir():
        for agent_dir in agents_root.iterdir():
            if agent_dir.is_dir():
                _collect(agent_dir / "craft", "agent", agent_dir.name)
    emp_root = root / "employees"
    if emp_root.is_dir():
        for emp_dir in emp_root.iterdir():
            if emp_dir.is_dir():
                _collect(emp_dir / "craft", "employee", emp_dir.name)
    return out


def get_craft_experience(experience_id: str) -> dict[str, Any] | None:
    """Load one craft entry by id — direct file scan, not truncated list (DEF-02)."""
    eid = str(experience_id or "").strip()
    if not eid:
        return None
    from evoflow.assets.hub import assets_root, entity_root, read_text_file
    from evoflow.assets.paths import EntityRef

    root = assets_root()
    for skill_md, entity_type, entity_id in _iter_craft_skill_files():
        try:
            text = skill_md.read_text(encoding="utf-8")
        except OSError:
            continue
        meta, body = _parse_skill_frontmatter(text)
        exp_id = str(meta.get("experience_id") or meta.get("id") or skill_md.stem)
        if exp_id != eid and skill_md.stem != eid:
            continue
        ent = EntityRef(entity_type, entity_id)
        try:
            rel_from_root = skill_md.resolve().relative_to(root.resolve()).as_posix()
        except Exception:
            rel_from_root = skill_md.as_posix()
        try:
            entity_rel = skill_md.resolve().relative_to(entity_root(ent).resolve()).as_posix()
        except Exception:
            entity_rel = f"craft/{skill_md.name}"
        try:
            file_data = read_text_file(ent, entity_rel)
            body_src = file_data.get("content") or text
        except Exception:
            body_src = text
        meta, body = _parse_skill_frontmatter(body_src)
        sections = _sections_from_body(body)
        return {
            "id": eid,
            "title": _body_title(body) or str(meta.get("description") or skill_md.stem),
            "category": str(meta.get("category") or "general"),
            "tags": meta.get("tags") if isinstance(meta.get("tags"), list) else [],
            "context": {
                "problem": sections["problem"],
                "solution": sections["solution"],
                "outcome": sections["outcome"],
                "applicable_to": sections["applicable_to"],
            },
            "steps": sections["steps"],
            "source_sessions": [],
            "related_ids": [],
            "confidence": float(meta.get("confidence") or 1.0),
            "use_count": 0,
            "superseded_by": None,
            "deprecated": False,
            "storage": "craft",
            "path": rel_from_root,
            "entityType": entity_type,
            "entityId": entity_id,
        }
    return None


def delete_craft_experience(experience_id: str) -> bool:
    row = get_craft_experience(experience_id)
    if not row:
        return False
    from evoflow.assets.hub import assets_root

    path = assets_root() / str(row.get("path") or "")
    if path.is_file():
        path.unlink()
        try:
            from evoflow.assets.memory_mirror import schedule_asset_vault_reindex_delayed

            schedule_asset_vault_reindex_delayed()
        except Exception:
            pass
        return True
    return False


def _section_text(body: str, heading: str) -> str:
    marker = f"## {heading}"
    if marker not in body:
        return ""
    part = body.split(marker, 1)[1]
    if "##" in part:
        part = part.split("##", 1)[0]
    return part.strip()


def _body_title(body: str) -> str:
    """First ``# heading`` of a SKILL.md body — the human title."""
    for line in str(body or "").splitlines():
        s = line.strip()
        if s.startswith("# "):
            return s[2:].strip()
    return ""


def _sections_from_body(body: str) -> dict[str, Any]:
    """Extract the standard experience sections from a craft SKILL.md body.

    Single source of truth for both the list summary and the detail view, so
    the two can never disagree about what a stored experience contains.
    """
    steps: list[str] = []
    if "## 步骤" in body:
        section = body.split("## 步骤", 1)[1]
        for line in section.splitlines():
            m = re.match(r"^\s*\d+\.\s+(.*)", line.strip())
            if m:
                steps.append(m.group(1).strip())
    return {
        "applicable_to": _section_text(body, "适用场景"),
        "problem": _section_text(body, "问题"),
        "solution": _section_text(body, "解决方案"),
        "outcome": _section_text(body, "结果"),
        "steps": steps,
    }
