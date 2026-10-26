"""Mirror memory atoms / documents into Asset Hub Markdown files."""

from __future__ import annotations

import logging
import re
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from evoflow.assets.locks import atomic_write_text
from evoflow.assets.paths import EntityRef

logger = logging.getLogger(__name__)

_SLUG_RE = re.compile(r"[^a-z0-9]+")
_reindex_timer: threading.Timer | None = None
_reindex_lock = threading.Lock()


def _parse_ts(value: str) -> datetime | None:
    s = str(value or "").strip()
    if not s:
        return None
    try:
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        return datetime.fromisoformat(s)
    except ValueError:
        return None


def _should_overwrite(path: Path, updated_at: str) -> bool:
    """Legacy 镜像新者胜：目标文件比 legacy 块的 ``updatedAt`` 新 → 跳过。

    legacy 同步曾整文件覆盖 profile/standing，会冲掉面板里更新的手工编辑；
    文件不存在时照常写入（迁移场景）。legacy 块缺时间戳时不覆盖已存在文件
    （fail-closed）。
    """
    if not path.is_file():
        return True
    doc_ts = _parse_ts(updated_at)
    if doc_ts is None:
        return False
    try:
        mtime = datetime.fromtimestamp(path.stat().st_mtime, tz=UTC)
    except OSError:
        return True
    return mtime <= doc_ts


def namespace_to_entity(namespace: str) -> EntityRef | None:
    ns = str(namespace or "").strip()
    if not ns:
        return None
    kind, _, owner = ns.partition(":")
    kind = kind.strip().lower()
    owner = owner.strip().lower()
    if kind in ("user", "") or ns.startswith("user:"):
        return EntityRef("user", "user")
    if kind == "agent" and owner:
        return EntityRef("user", "user")
    if kind == "person" and owner:
        return EntityRef("employee", owner)
    # workspace:* — file mirror deferred (Phase D)
    return None


def _slug(text: str, *, max_len: int = 48) -> str:
    s = _SLUG_RE.sub("-", str(text or "").strip().lower()).strip("-")
    if not s:
        s = "item"
    return s[:max_len].strip("-") or "item"


def _atomic_write(path: Path, content: str) -> None:
    atomic_write_text(path, content)


def _yaml_escape(value: str) -> str:
    v = str(value or "")
    if not v:
        return ""
    if any(c in v for c in ":{}[]#&*!|>\"'"):
        return json_quote_yaml(v)
    return v


def json_quote_yaml(value: str) -> str:
    import json

    return json.dumps(value, ensure_ascii=False)


def mirror_memory_document(namespace: str, document: dict[str, Any]) -> int:
    """Write legacy memory document sections + facts to entity asset files."""
    entity = namespace_to_entity(namespace)
    if entity is None or not isinstance(document, dict):
        return 0
    from evoflow.assets.hub import ensure_entity_tree, entity_root

    ensure_entity_tree(entity)
    root = entity_root(entity)
    written = 0

    user = document.get("user") or {}
    if isinstance(user, dict):
        top = user.get("topOfMind")
        standing = ""
        top_updated = ""
        if isinstance(top, dict):
            standing = str(top.get("summary") or "").strip()[:400]
            top_updated = str(top.get("updatedAt") or "").strip()
        if standing:
            target = root / "memory" / "standing.md"
            if _should_overwrite(target, top_updated):
                _atomic_write(target, standing + "\n")
                written += 1

    if entity.entity_type == "user":
        mapping = [
            ("工作背景", "workContext"),
            ("个人偏好", "personalContext"),
            ("近期关注", "topOfMind"),
        ]
        from evoflow.assets.paths import EntityRef
        from evoflow.assets.user_profile_dims import ensure_user_profile_files

        ensure_user_profile_files(EntityRef("user", "user"))
        basic_parts: list[str] = []
        pref_parts: list[str] = []
        persona_parts: list[str] = []
        for heading, key in mapping:
            block = user.get(key) if isinstance(user, dict) else None
            summary = ""
            if isinstance(block, dict):
                summary = str(block.get("summary") or "").strip()
            if not summary:
                continue
            if key == "workContext":
                basic_parts.append(f"## {heading}\n{summary}")
            elif key == "personalContext":
                pref_parts.append(f"## {heading}\n{summary}")
            else:
                persona_parts.append(f"## {heading}\n{summary}")
        history = document.get("history") or {}
        if isinstance(history, dict):
            for heading, key in [
                ("近期几个月", "recentMonths"),
                ("更早上下文", "earlierContext"),
                ("长期背景", "longTermBackground"),
            ]:
                block = history.get(key)
                if isinstance(block, dict) and str(block.get("summary") or "").strip():
                    persona_parts.append(f"## {heading}\n{str(block.get('summary') or '').strip()}")
        prof = root / "profile"
        # 新者胜：legacy 摘要不覆盖面板里更新的手工编辑（无 updatedAt 的块不覆盖）
        if basic_parts:
            target = prof / "basic-info.md"
            if _should_overwrite(target, str((user.get("workContext") or {}).get("updatedAt") or "")):
                _atomic_write(target, "\n".join(basic_parts).strip() + "\n")
                written += 1
        if pref_parts:
            target = prof / "preferences.md"
            if _should_overwrite(target, str((user.get("personalContext") or {}).get("updatedAt") or "")):
                _atomic_write(target, "\n".join(pref_parts).strip() + "\n")
                written += 1
        if persona_parts:
            target = prof / "persona.md"
            block_ts = str((user.get("topOfMind") or {}).get("updatedAt") or "")
            if _should_overwrite(target, block_ts):
                _atomic_write(target, "\n".join(persona_parts).strip() + "\n")
                written += 1

    facts = document.get("facts") or []
    if isinstance(facts, list):
        for fact in facts:
            if not isinstance(fact, dict):
                continue
            content = str(fact.get("content") or "").strip()
            if not content:
                continue
            fid = str(fact.get("id") or "").strip() or _slug(content[:32])
            fname = _slug(fid) if fid.startswith("fact_") else _slug(content[:40])
            src = str(fact.get("source") or "").strip().lower()
            is_closure = src in {"goal_complete", "task_complete"} or ("已完成" in content and ("Goal「" in content or "任务「" in content))
            if is_closure:
                episodic_dir = root / "memory" / "episodic"
                episodic_dir.mkdir(parents=True, exist_ok=True)
                from datetime import datetime

                day = datetime.now(UTC).strftime("%Y%m%d")
                path = episodic_dir / f"{day}-{fname}.md"
                layer = "episodic"
            else:
                facts_dir = root / "memory" / "facts"
                facts_dir.mkdir(parents=True, exist_ok=True)
                path = facts_dir / f"{fname}.md"
                layer = "semantic"
            front = _atom_frontmatter(
                atom_id=fid,
                layer=layer,
                entity=entity,
                access_tier="archival",
                tags=[str(fact.get("category") or "fact")],
                confidence=float(fact.get("confidence") or 0.7),
                evidence={"source": str(fact.get("source") or "")},
            )
            body = f"# {content[:80]}\n\n{content}\n"
            _atomic_write(path, front + body)
            written += 1

    return written


def mirror_atom_file(
    namespace: str,
    *,
    atom_id: str,
    content: str,
    layer: str = "semantic",
    kind: str = "fact",
    summary: str = "",
    confidence: float = 0.7,
    evidence: dict[str, Any] | None = None,
    tags: list[Any] | None = None,
    source: str = "",
) -> bool:
    """Mirror a single mem atom to a markdown file (non-updater path)."""
    if str(source or "") == "updater":
        return False
    entity = namespace_to_entity(namespace)
    text = str(content or "").strip()
    if entity is None or not text:
        return False
    from evoflow.assets.hub import ensure_entity_tree, entity_root

    ensure_entity_tree(entity)
    root = entity_root(entity)
    layer_n = str(layer or "semantic").strip().lower()
    subdir = "episodic" if layer_n == "episodic" else "facts"
    if layer_n == "procedural":
        subdir = "craft"
    slug = _slug(summary or text[:48])
    aid = str(atom_id or "").strip() or slug
    if subdir == "facts" and aid:
        fname = _slug(aid) if aid.startswith("fact_") else slug
    else:
        date = datetime.now(UTC).strftime("%Y%m%d")
        fname = f"{date}-{slug}"
    rel_dir = root / "memory" / subdir
    path = rel_dir / f"{fname}.md"
    front = _atom_frontmatter(
        atom_id=aid,
        layer=layer_n,
        entity=entity,
        access_tier="core" if layer_n == "semantic" and kind.startswith("section:") else "archival",
        tags=tags,
        confidence=confidence,
        evidence=evidence,
    )
    title = (summary or text)[:120]
    body = f"# {title}\n\n{text}\n"
    _atomic_write(path, front + body)
    return True


def _atom_frontmatter(
    *,
    atom_id: str,
    layer: str,
    entity: EntityRef,
    access_tier: str,
    tags: list[Any] | None,
    confidence: float,
    evidence: dict[str, Any] | None,
) -> str:
    import json

    now = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    tag_list = [str(t) for t in (tags or []) if str(t).strip()]
    ev = evidence or {}
    lines = [
        "---",
        f"id: {atom_id}",
        f"layer: {layer}",
        f"entity: {entity.entity_type}",
        f"entity_id: {entity.entity_id}",
        f"access_tier: {access_tier}",
        f"confidence: {confidence}",
        f"created_at: {now}",
        f"tags: {json.dumps(tag_list, ensure_ascii=False)}",
    ]
    if ev:
        lines.append(f"evidence: {json.dumps(ev, ensure_ascii=False)}")
    lines.append("---\n\n")
    return "\n".join(lines)


def schedule_asset_vault_reindex_delayed(delay_s: float = 20.0) -> None:
    """Deprecated no-op — Obsidian vault indexing was removed.

    Historically every asset write "scheduled a reindex" here; there is no
    index anymore (asset search is a file substring scan), so this exists only
    for backward-compatible imports. Do not add new call sites.
    """
    return None
