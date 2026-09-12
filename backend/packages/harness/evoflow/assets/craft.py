"""Craft skills under Asset Hub ``craft/*/SKILL.md`` (replaces experience library)."""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any

from evoflow.assets.paths import EntityRef

logger = logging.getLogger(__name__)

_SLUG_RE = re.compile(r"[^a-z0-9_\u4e00-\u9fff-]+")


def _slug(name: str, *, max_len: int = 48) -> str:
    s = _SLUG_RE.sub("-", str(name or "").strip().lower()).strip("-")
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
    ctx = data.get("context") if isinstance(data.get("context"), dict) else {}
    problem = str(data.get("problem") or ctx.get("problem") or "").strip()
    solution = str(data.get("solution") or ctx.get("solution") or "").strip()
    outcome = str(data.get("outcome") or ctx.get("outcome") or "").strip()
    applicable = str(data.get("applicable_to") or ctx.get("applicable_to") or "").strip()
    steps = data.get("steps") or []
    if not isinstance(steps, list):
        steps = []
    parts: list[str] = [f"# {str(data.get('title') or '专长').strip()}\n"]
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
    title = str(data.get("title") or "").strip()
    if not title:
        raise ValueError("title is required")
    entity = _entity_from_data(data)
    exp_id = str(data.get("id") or data.get("experience_id") or "").strip()
    if not exp_id:
        import uuid

        exp_id = f"exp_{uuid.uuid4().hex[:12]}"
    slug = _slug(data.get("skill_name") or title)
    craft_root = _craft_root(entity)
    skill_dir = craft_root / slug
    skill_dir.mkdir(parents=True, exist_ok=True)
    skill_path = skill_dir / "SKILL.md"
    ctx = data.get("context") if isinstance(data.get("context"), dict) else {}
    tags = data.get("tags") or []
    if not isinstance(tags, list):
        tags = []
    body = experience_to_skill_body(data)
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
    ctx = data.get("context") if isinstance(data.get("context"), dict) else {}
    return str(data.get("problem") or ctx.get("solution") or data.get("title") or "")[:200]


def list_craft_experiences(
    *,
    category: str = "",
    query: str = "",
    max_results: int = 10,
    entity: EntityRef | None = None,
) -> list[dict[str, Any]]:
    from evoflow.assets.hub import assets_root

    root = assets_root()
    patterns = []
    if entity is not None:
        from evoflow.assets.paths import entity_relative_dir

        patterns.append(root / entity_relative_dir(entity) / "craft")
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
        for skill_md in craft_dir.rglob("SKILL.md"):
            try:
                text = skill_md.read_text(encoding="utf-8")
            except OSError:
                continue
            meta, body = _parse_skill_frontmatter(text)
            title = str(meta.get("name") or skill_md.parent.name).replace("-", " ")
            exp_id = str(meta.get("experience_id") or meta.get("id") or skill_md.parent.name)
            cat = str(meta.get("category") or "general")
            if cat_prefix and not cat.lower().startswith(cat_prefix):
                continue
            blob = f"{title}\n{body}\n{meta.get('description', '')}".lower()
            if q and q not in blob:
                continue
            hits.append(
                {
                    "id": exp_id,
                    "title": str(meta.get("description") or title)[:120],
                    "category": cat,
                    "tags": meta.get("tags") if isinstance(meta.get("tags"), list) else [],
                    "problem": body[:200],
                    "solution": "",
                    "outcome": "",
                    "step_count": body.count("\n## 步骤"),
                    "confidence": float(meta.get("confidence") or 1.0),
                    "use_count": 0,
                    "storage": "craft",
                    "path": skill_md.relative_to(root).as_posix(),
                    "entityType": str(meta.get("entity") or entity_type),
                    "entityId": str(meta.get("entity_id") or entity_id),
                }
            )

    if entity is not None:
        from evoflow.assets.paths import entity_relative_dir

        _scan_craft_dir(root / entity_relative_dir(entity) / "craft", entity.entity_type, entity.entity_id)
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
    return hits[: max(1, min(max_results, 30))]


def get_craft_experience(experience_id: str) -> dict[str, Any] | None:
    eid = str(experience_id or "").strip()
    if not eid:
        return None
    for row in list_craft_experiences(max_results=500):
        if str(row.get("id") or "") != eid:
            continue
        from evoflow.assets.hub import assets_root, entity_root, read_text_file
        from evoflow.assets.paths import EntityRef

        ent = EntityRef(str(row["entityType"]), str(row["entityId"]))
        root = assets_root()
        rel_from_root = str(row.get("path") or "")
        try:
            full = (root / rel_from_root).resolve()
            entity_rel = full.relative_to(entity_root(ent)).as_posix()
        except Exception:
            entity_rel = rel_from_root.split("/", 2)[-1] if rel_from_root.count("/") >= 2 else rel_from_root
        try:
            file_data = read_text_file(ent, entity_rel)
        except Exception:
            return None
        meta, body = _parse_skill_frontmatter(file_data.get("content") or "")
        steps: list[str] = []
        if "## 步骤" in body:
            section = body.split("## 步骤", 1)[1]
            for line in section.splitlines():
                m = re.match(r"^\s*\d+\.\s+(.*)", line.strip())
                if m:
                    steps.append(m.group(1).strip())
        return {
            "id": eid,
            "title": str(meta.get("description") or row.get("title") or eid),
            "category": str(meta.get("category") or "general"),
            "tags": meta.get("tags") if isinstance(meta.get("tags"), list) else [],
            "context": {
                "problem": _section_text(body, "问题"),
                "solution": _section_text(body, "解决方案"),
                "outcome": _section_text(body, "结果"),
                "applicable_to": _section_text(body, "适用场景"),
            },
            "steps": steps,
            "source_sessions": [],
            "related_ids": [],
            "confidence": float(meta.get("confidence") or 1.0),
            "use_count": 0,
            "superseded_by": None,
            "deprecated": False,
            "storage": "craft",
            "path": rel_from_root,
        }
    return None


def delete_craft_experience(experience_id: str) -> bool:
    row = get_craft_experience(experience_id)
    if not row:
        return False
    from evoflow.assets.hub import assets_root
    import shutil

    path = assets_root() / str(row.get("path") or "")
    skill_dir = path.parent
    if skill_dir.is_dir():
        shutil.rmtree(skill_dir, ignore_errors=True)
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
