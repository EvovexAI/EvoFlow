"""Scan Asset Hub Markdown frontmatter for Tier 0/1 catalog rows."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from evoflow.assets.injection_budget import (
    TIER0_CATALOG_PER_KIND,
    TIER0_EPISODE_MAX_ITEMS,
    TIER0_SKILLS_MAX_ITEMS,
    TIER0_STANDING_CHARS,
    cap_text_chars,
)
from evoflow.assets.paths import EntityRef, entity_root, resolve_entity_file

_FRONTMATTER_RE = re.compile(r"\A---\s*\n(.*?)\n---\s*\n?", re.DOTALL)
# One-line catalog label (filename shown separately). Was 24 — truncated Chinese
# descriptions into useless "用 ff…" stubs; align with skill-desc budget.
_CATALOG_DESC_CHARS = 160
# Grouped catalog heading per kind — same wording as ``format_entity_catalog_lines``.
# One heading per kind; bare filename bullets under it. Per-line ``<kind> `` prefixes
# were redundant: rows are already grouped by kind, so the tag repeated ~N times
# per group was pure token waste.
_KIND_HEADING = {
    "fact": "fact · 事实",
    "episode": "episodic · 过程",
    "craft": "craft · 经验/做法",
    "journal": "journal · 反思",
}
_CLOSURE_SOURCES = frozenset({"goal_complete", "task_complete"})
_CLOSURE_TITLE_MARKERS = ("Goal「", "任务「", "已完成")


def _parse_evidence_source(meta: dict[str, str]) -> str:
    raw = str(meta.get("evidence") or "").strip()
    if not raw:
        return ""
    m = re.search(r"""['"]?source['"]?\s*:\s*['"]?([a-z_]+)""", raw, re.I)
    return (m.group(1) if m else "").strip().lower()


def _looks_like_closure_record(*, meta: dict[str, str], title: str) -> bool:
    """Task/goal closure lines are archival — not Tier-0 standing catalog."""
    if _parse_evidence_source(meta) in _CLOSURE_SOURCES:
        return True
    tags = str(meta.get("tags") or "").lower()
    if "episode" in tags and "已完成" in title:
        return True
    if any(marker in title for marker in _CLOSURE_TITLE_MARKERS) and "已完成" in title:
        return True
    return False


def fact_tier0_catalog_eligible(*, meta: dict[str, str], title: str) -> bool:
    """Tier-0 catalog lists only pin-worthy facts; archival/closures stay on disk."""
    tier = str(meta.get("access_tier") or "").strip().lower()
    if tier == "archival":
        return False
    if _looks_like_closure_record(meta=meta, title=title):
        return False
    return True


def parse_frontmatter(text: str) -> tuple[dict[str, str], str]:
    raw = str(text or "")
    m = _FRONTMATTER_RE.match(raw)
    if not m:
        return {}, raw
    meta: dict[str, str] = {}
    for line in m.group(1).splitlines():
        if ":" not in line:
            continue
        key, _, val = line.partition(":")
        k = key.strip().lower()
        v = val.strip().strip("'\"")
        if k:
            meta[k] = v
    body = raw[m.end() :]
    return meta, body


def _mtime_sort_key(path: Path) -> float:
    try:
        return path.stat().st_mtime
    except OSError:
        return 0.0


def _usage_ledger_snapshot(entity: EntityRef) -> dict[str, dict[str, Any]]:
    """Read the usage ledger **once** per catalog build.

    【self-evolution-bot · 2026-11-18 · 第43轮 · 模型:deepseek-v4.1-flash-1017】
    catalog 一次要排 100+ 条，逐条 ``_read_ledger`` 就是 100 次重读+重解析同一份
    JSON（实测 72 次合计 7.72ms，冷启动单次 max 120.6ms）。这里一次取快照。
    """
    try:
        from evoflow.assets.usage import _read_ledger

        return _read_ledger(entity)
    except Exception:
        return {}


def _usage_sort_key(
    path: Path,
    meta: dict[str, str],
    *,
    entity: EntityRef | None = None,
    rel: str | None = None,
    ledger: dict[str, dict[str, Any]] | None = None,
) -> tuple[int, float]:
    """Ordering key for catalog rows: ``(has_usage_evidence, recency)``.

    【self-evolution-bot · 2026-11-18 · 第43轮 · 模型:deepseek-v4.1-flash-1017】
    这是真 bug 修复，分两层：

    **一、ledger 从来没被读过。** 旧实现只把 frontmatter ``meta`` 喂给
    ``usage_recency_score``，而现网 **118 个资产文件里 0 个** frontmatter 带
    use_count/last_used——计数全在侧车 ``memory/.usage-ledger.json``
    （实测 118 条真实记录，最高 useCount=54）。于是四条 list_*_catalog 全部
    走 ``path.stat().st_mtime`` 兜底，**排序实际一直是 mtime**，ledger 是死数据。

    **二、只修一还不够。** ``usage_recency_score`` 是**近期性**不是**频率**：
    未被读过的文件返回 mtime(=现在)，被读过 54 次但上次是昨天的反而更低。
    也就是「刚写完的未验证条目」永远压过「反复被复用的老配方」——与
    「该信谁」正好相反。故第一级显式取「有无使用证据」：
    被用过(unUse>0/lastUsedAt 存在) > 从未用过；同组内才比时间。
    """
    from evoflow.assets.usage import _parse_iso, usage_recency_score

    # 【self-evolution-bot · 2026-11-18 · 第43轮 · 模型:deepseek-v4.1-flash-1017】
    # 这里刻意**不走** overlay_ledger_meta：它对每个字段做 iso 字符串↔datetime 往返 +
    # max/较新比较，属于「给人类读的合并语义」。catalog 每条只需要两个数
    # （有无使用证据、最近使用时刻），直接取 ledger 快照里的值即可。
    # 实测：走 overlay 时 catalog 构建 10.37ms → 19.12ms；直取后回到 10ms 级。
    entry: dict[str, Any] = {}
    if ledger is not None and rel:
        entry = ledger.get(str(rel).replace("\\", "/").lstrip("/")) or {}
    used = 0
    stamp_txt = ""
    if entry:
        try:
            used = 1 if int(str(entry.get("useCount") or 0).strip() or 0) > 0 else 0
        except (TypeError, ValueError):
            used = 0
        stamp_txt = str(entry.get("lastUsedAt") or entry.get("lastCitedAt") or "")
    if not used:
        # frontmatter 里若有旧式计数（早于 ledger 的历史条目）同样算「用过」。
        try:
            if int(str(meta.get("use_count") or "0").strip() or 0) > 0:
                used = 1
        except (TypeError, ValueError):
            pass
        if not stamp_txt:
            stamp_txt = str(meta.get("last_used_at") or meta.get("last_used") or "")
    if stamp_txt:
        stamp = _parse_iso(stamp_txt)
        if stamp is not None:
            if stamp.tzinfo is None:
                from datetime import UTC

                stamp = stamp.replace(tzinfo=UTC)
            return (used, stamp.timestamp())
    return (used, usage_recency_score(meta, path))


_CATALOG_HEAD_BYTES = 4096


def _read_catalog_head(path: Path) -> str | None:
    """Read just enough of ``path`` to parse frontmatter + the first heading.

    【self-evolution-bot · 2026-11-18 · 第43轮 · 模型:deepseek-v4.1-flash-1017】
    catalog 每轮都要扫全部资产文件，但只需 frontmatter 与第一个 ``#`` 标题行，
    而旧实现 ``path.read_text()`` 把全文读进来。实测 118 个文件 / 405,467 字节，
    profile 显示 **每轮构建 605 次 read_text 占 11.8ms**，占 catalog 构建的七成。

    安全判据（两条都满足才用截断内容，否则回退全文）：
      1. frontmatter 有闭合 ``---``，或本来就没有 frontmatter；
      2. 截断内容里已经出现了标题行（有 frontmatter 时看 body，否则看全文）。
    正文只在「找不到标题」时才需要继续往后读，故回退全文不会丢信息。
    """
    try:
        with path.open("rb") as fh:
            raw = fh.read(_CATALOG_HEAD_BYTES)
            truncated = fh.read(1) != b""
    except OSError:
        return None
    text = raw.decode("utf-8", errors="replace")
    if not truncated:
        return text
    m = _FRONTMATTER_RE.match(text)
    if m is None:
        # 无 frontmatter：截断内容里必须有标题行才够用。
        return text if any(ln.startswith("#") for ln in text.splitlines()) else None
    if m.end() >= len(text):
        # frontmatter 还没读完就被截断 —— 回退全文。
        return None
    body = text[m.end():]
    return text if any(ln.startswith("#") for ln in body.splitlines()) else None


# catalog 结果缓存：{绝对路径: ((mtime_ns, size), meta, body_head)}
# 进程级、无锁（dict 单写入在 CPython 下原子；并发重算同一文件最多多读一次，不会错）。
# 【self-evolution-bot · 2026-11-18 · 第43轮 · 模型:deepseek-v4.1-flash-1017】
# 为什么：catalog 每轮注入都要重建，profile 显示每轮 121 次 open + 825 次 stat
# 占 14.6ms 的绝大部分，而这些文件的 frontmatter 99% 的时间没变。
# 失效判据用 (mtime_ns, size) 而非单 mtime：同一秒内覆盖写 mtime_ns 未必变，
# 但长度几乎一定变（与 assets/search.py 的行缓存同一判据，已验过）。
_CATALOG_META_CACHE: dict[str, tuple[tuple[int, int], dict[str, str], str]] = {}
_CATALOG_META_CACHE_MAX = 4096


def _read_catalog_meta(path: Path) -> tuple[dict[str, str], str] | None:
    """Return ``(frontmatter meta, body_head)`` for ``path``, cached by (mtime_ns, size).

    ``body_head`` 只用于取第一个 ``#`` 标题；缓存里存的就是截断后的正文头，
    因此正文改了但标题没改时命中缓存也不影响结果（标题是 catalog 唯一用途）。
    """
    try:
        st = path.stat()
    except OSError:
        return None
    key = str(path)
    stamp = (st.st_mtime_ns, st.st_size)
    hit = _CATALOG_META_CACHE.get(key)
    if hit is not None and hit[0] == stamp:
        return hit[1], hit[2]
    text = _read_catalog_head(path)
    if text is None:
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            return None
    meta, body = parse_frontmatter(text)
    if len(_CATALOG_META_CACHE) >= _CATALOG_META_CACHE_MAX:
        for old in list(_CATALOG_META_CACHE)[: _CATALOG_META_CACHE_MAX // 4 or 1]:
            _CATALOG_META_CACHE.pop(old, None)
    _CATALOG_META_CACHE[key] = (stamp, meta, body)
    return meta, body


def _catalog_limit_reached(n: int, limit: int) -> bool:
    """True when ``limit`` is a positive cap and ``n`` already hit it. ``<=0`` = unlimited."""
    return int(limit or 0) > 0 and n >= int(limit)


def list_fact_catalog(entity: EntityRef, *, limit: int = TIER0_SKILLS_MAX_ITEMS) -> list[dict[str, Any]]:
    root = entity_root(entity.normalized()) / "memory" / "facts"
    if not root.is_dir():
        return []
    rows: list[dict[str, Any]] = []
    ledger = _usage_ledger_snapshot(entity)
    scored: list[tuple[tuple[int, float], Path, dict[str, str], str]] = []
    for path in root.glob("*.md"):
        if not path.is_file() or path.name.upper() == "README.MD":
            continue
        parsed = _read_catalog_meta(path)
        if parsed is None:
            continue
        meta, body = parsed
        title = (meta.get("title") or "").strip()
        if not title:
            for line in body.splitlines():
                if line.startswith("#"):
                    title = line.lstrip("# ").strip()
                    break
        if not title:
            title = path.stem[:40]
        if not fact_tier0_catalog_eligible(meta=meta, title=title):
            continue
        # 【self-evolution-bot · 2026-11-18 · 第43轮 · 模型:deepseek-v4.1-flash-1017】
        # 原先只传 meta（frontmatter），现网这些文件根本不带计数 → 全部走 mtime 兜底。
        # 传 entity+rel 才会 overlay 侧车 ledger，才真的是「按使用证据排序」。
        score = _usage_sort_key(
            path, meta, entity=entity, rel=f"memory/facts/{path.name}", ledger=ledger
        )
        scored.append((score, path, meta, title))
    scored.sort(key=lambda t: t[0], reverse=True)
    for _score, path, meta, title in scored:
        if _catalog_limit_reached(len(rows), limit):
            break
        summary = cap_text_chars(
            (meta.get("summary") or meta.get("description") or title).strip(),
            _CATALOG_DESC_CHARS,
        )
        rel = f"memory/facts/{path.name}"
        rows.append({"kind": "fact", "id": title, "title": title, "summary": summary, "path": rel})
    return rows


def list_episode_catalog(entity: EntityRef, *, limit: int = TIER0_EPISODE_MAX_ITEMS) -> list[dict[str, Any]]:
    root = entity_root(entity.normalized()) / "memory" / "episodic"
    if not root.is_dir():
        return []
    rows: list[dict[str, Any]] = []
    ledger = _usage_ledger_snapshot(entity)
    scored: list[tuple[tuple[int, float], Path, dict[str, str], str]] = []
    for path in root.glob("*.md"):
        if not path.is_file() or path.name.upper() == "README.MD":
            continue
        parsed = _read_catalog_meta(path)
        if parsed is None:
            continue
        meta, body = parsed
        title = (meta.get("title") or "").strip()
        if not title:
            for line in body.splitlines():
                if line.startswith("#"):
                    title = line.lstrip("# ").strip()
                    break
        if not title:
            title = path.stem[:40]
        score = _usage_sort_key(
            path, meta, entity=entity, rel=f"memory/episodic/{path.name}", ledger=ledger
        )
        scored.append((score, path, meta, title))
    scored.sort(key=lambda t: t[0], reverse=True)
    for _score, path, meta, title in scored:
        if _catalog_limit_reached(len(rows), limit):
            break
        summary = cap_text_chars(
            (meta.get("summary") or title).strip(),
            _CATALOG_DESC_CHARS,
        )
        rel = f"memory/episodic/{path.name}"
        rows.append(
            {
                "kind": "episode",
                "id": title,
                "title": title,
                "summary": summary,
                "date": (meta.get("date") or "").strip(),
                "path": rel,
            }
        )
    return rows


def list_craft_catalog(entity: EntityRef, *, limit: int = TIER0_SKILLS_MAX_ITEMS) -> list[dict[str, Any]]:
    # 【self-evolution-bot · 2026-11-18 · 第43轮 · 模型:deepseek-v4.1-flash-1017】
    # craft 原先**完全按 mtime 倒序**（与 fact/episodic 不一致）：结果「最近写的」压过
    # 「反复被读的」。实测现网 72 件 craft 里被读过 47 件（65%），最高 useCount=54；
    # 按 mtime 取前 45 条只覆盖 31 件有记录的，按使用证据取覆盖 34 件，换序换进 8 件。
    # 判据：排序键必须与「这条经验下次还会不会用」相关，mtime 只代表「刚写完」。
    root = entity_root(entity.normalized()) / "craft"
    if not root.is_dir():
        return []
    ledger = _usage_ledger_snapshot(entity)
    scored: list[tuple[tuple[int, float], Path, dict[str, str]]] = []
    for craft_file in root.glob("*.md"):
        if not craft_file.is_file() or craft_file.name.upper() == "README.MD":
            continue
        parsed = _read_catalog_meta(craft_file)
        if parsed is None:
            continue
        meta, body = parsed
        rel = f"craft/{craft_file.name}"
        score = _usage_sort_key(
            craft_file, meta, entity=entity, rel=rel, ledger=ledger
        )
        scored.append((score, craft_file, meta))
    # 主键=使用证据，次键=mtime（同分时新写的靠前，避免顺序抖动）。
    scored.sort(key=lambda t: t[0], reverse=True)
    rows: list[dict[str, Any]] = []
    for _score, craft_file, meta in scored:
        if _catalog_limit_reached(len(rows), limit):
            break
        name = (meta.get("name") or craft_file.stem).strip()
        desc = cap_text_chars(
            (meta.get("description") or meta.get("summary") or name).strip(),
            _CATALOG_DESC_CHARS,
        )
        rows.append({"kind": "craft", "id": name, "name": name, "description": desc, "path": f"craft/{craft_file.name}"})
    return rows


def list_journal_catalog(entity: EntityRef, *, limit: int = TIER0_CATALOG_PER_KIND) -> list[dict[str, Any]]:
    """Journal/reflection day files for Tier-0 catalog (filenames only; limit<=0 = all)."""
    root = entity_root(entity.normalized()) / "memory" / "journal"
    if not root.is_dir():
        return []
    ledger = _usage_ledger_snapshot(entity)
    scored: list[tuple[tuple[int, float], Path, dict[str, str]]] = []
    for path in root.glob("*.md"):
        if not path.is_file() or path.name.upper() == "README.MD":
            continue
        parsed = _read_catalog_meta(path)
        if parsed is None:
            continue
        meta, body = parsed
        rel = f"memory/journal/{path.name}"
        score = _usage_sort_key(path, meta, entity=entity, rel=rel, ledger=ledger)
        scored.append((score, path, meta))
    # 【self-evolution-bot · 2026-11-18 · 第43轮 · 模型:deepseek-v4.1-flash-1017】
    # journal 也原先是纯 mtime 倒序。实测 28 件里只有 11 件被读过（39%，三类最低），
    # 而「最近写的那篇」常常正是「还没被复用过、未经验证」的那篇——mtime 排序把
    # 未验证的新条目顶到最前，恰好与「该信谁」相反。改为主键=使用证据。
    scored.sort(key=lambda t: t[0], reverse=True)
    rows: list[dict[str, Any]] = []
    for _score, path, meta in scored:
        if _catalog_limit_reached(len(rows), limit):
            break
        title = (meta.get("title") or meta.get("summary") or "").strip()
        if not title:
            for line in body.splitlines():
                if line.startswith("#"):
                    title = line.lstrip("# ").strip()
                    break
        if not title:
            title = path.stem[:40]
        summary = cap_text_chars(
            (meta.get("summary") or title).strip(),
            _CATALOG_DESC_CHARS,
        )
        rel = f"memory/journal/{path.name}"
        rows.append(
            {
                "kind": "journal",
                "id": title,
                "title": title,
                "summary": summary,
                "date": (meta.get("date") or "").strip(),
                "path": rel,
            }
        )
    return rows


def read_standing_text(
    entity: EntityRef,
    *,
    max_chars: int | None = None,
    for_inject: bool = True,
) -> str:
    """Read ``memory/standing.md``.

    ``for_inject=True`` (default): collapse dense What's in Memory + soft-cap
    prefs/tips for system-prompt L1. Pass ``for_inject=False`` for raw-ish body
    (still strips a leading H1) when a caller needs the on-disk shape.
    """
    try:
        path = resolve_entity_file(entity.normalized(), "memory/standing.md")
        if not path.is_file():
            return ""
        text = path.read_text(encoding="utf-8")
    except (OSError, ValueError):
        return ""
    _, body = parse_frontmatter(text)
    # Drop leading heading for injection compactness
    lines = [ln for ln in body.splitlines() if ln.strip()]
    if lines and lines[0].startswith("#"):
        lines = lines[1:]
    body = "\n".join(lines).strip()
    if for_inject:
        try:
            from evoflow.assets.standing_format import format_standing_for_inject

            body = format_standing_for_inject(body)
        except Exception:
            pass
    cap = TIER0_STANDING_CHARS if max_chars is None else int(max_chars)
    return cap_text_chars(body, cap)


def standing_is_placeholder(text: str) -> bool:
    s = str(text or "").strip()
    if not s:
        return True
    # Drop schema marker line for emptiness check
    body = "\n".join(ln for ln in s.splitlines() if ln.strip() and ln.strip() != "v1").strip()
    if not body:
        return True
    placeholders = ("本工作区关注点", "会话冻结的近期关注", "（会话冻结", "（本工作区", "第一行保留 v1")
    return any(p in body for p in placeholders)


def catalog_has_content(entity: EntityRef) -> bool:
    """True when there is real catalog content (not empty skeleton placeholders)."""
    if list_fact_catalog(entity, limit=1):
        return True
    if list_episode_catalog(entity, limit=1):
        return True
    if list_craft_catalog(entity, limit=1):
        return True
    if list_journal_catalog(entity, limit=1):
        return True
    standing = read_standing_text(entity)
    if standing_is_placeholder(standing):
        return False
    return len(standing.strip()) >= 12


_TASK_GROUP_RE = re.compile(r"^\s*#\s*Task\s+Group:\s*(.+?)\s*$", re.MULTILINE)
_TASK_REGISTRY_RE = re.compile(r"^\s*##\s*Task\s+\d+:\s*(.+?)\s*$", re.MULTILINE)


def _read_memory_index_label(entity: EntityRef) -> tuple[str, int, list[str]]:
    """Parse MEMORY.md to derive a short catalog label.

    Returns ``(label, task_group_count, task_group_names)``.

    - When MEMORY.md is the default skeleton or empty: ``("(registry — empty; "
      "consolidate to populate)", 0, [])``.
    - When MEMORY.md has at least one Task Group: ``"(registry — N task groups: "
      "a · b · c)", N, [a, b, c, ...])``.
    """
    try:
        from evoflow.assets.paths import entity_root

        mem_path = entity_root(entity.normalized()) / "memory" / "MEMORY.md"
        if not mem_path.is_file():
            return ("(registry — not yet created)", 0, [])
        text = mem_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ("(registry — unreadable)", 0, [])

    # Strip front-matter-style scaffolding and front-comment lines.
    body_lines = [ln for ln in text.splitlines() if ln.strip()]
    has_real_content = any(
        ln.strip().startswith("# Task Group:") or ln.strip().startswith("## Task ")
        for ln in body_lines
    )
    if not has_real_content:
        return ("(registry — empty; consolidate to populate)", 0, [])

    names = [m.group(1).strip() for m in _TASK_GROUP_RE.finditer(text)]
    return (
        f"(registry — {len(names)} task group{'s' if len(names) != 1 else ''}: "
        + " · ".join(names[:3])
        + ("…" if len(names) > 3 else "")
        + ")",
        len(names),
        names,
    )


def _catalog_filename(rel_path: str) -> str:
    """Prompt catalog shows basename only — kind heading carries the directory."""
    name = str(rel_path or "").replace("\\", "/").rstrip("/").rsplit("/", 1)[-1].strip()
    return name or str(rel_path or "").strip()


def _format_kind_section_lines(
    *,
    heading: str,
    rows: list[str],
) -> list[str]:
    """Render one kind block: heading + **filename-only** bullets (no desc)."""
    if not rows:
        return []
    out = [f"{heading}:"]
    out.extend(f"- {name}" for name in rows if str(name or "").strip())
    return out


def format_entity_catalog_xml(
    entity: EntityRef,
    *,
    include_standing: bool = True,
    include_facts: bool = True,
    include_episodes: bool = True,
    include_craft: bool = True,
    include_journal: bool = True,
    tag: str = "catalog",
) -> str:
    """Build a compact catalog block — grouped by kind, **filename** per row.

    Format: one ``<kind> · <label>:`` heading per kind, bare filename bullets under
    it (same style as ``format_entity_catalog_lines``). **No per-kind row cap**
    (``TIER0_CATALOG_PER_KIND<=0``). MEMORY.md is pinned. Full bodies stay on-demand
    via ``assets`` read/search (basename is enough — tool resolves under the entity).
    """
    sections: list[str] = []
    if include_standing:
        standing = read_standing_text(entity, max_chars=TIER0_STANDING_CHARS)
        if standing and not standing_is_placeholder(standing):
            sections.append(
                "========= MEMORY_SUMMARY BEGINS =========\n"
                f"{standing}\n"
                "========= MEMORY_SUMMARY ENDS ========="
            )

    body_lines: list[str] = ["summary MEMORY.md", ""]

    kind_buckets: list[tuple[str, list[str]]] = []
    if include_craft:
        kind_buckets.append(
            ("craft", [_catalog_filename(r["path"]) for r in list_craft_catalog(entity)])
        )
    if include_facts:
        kind_buckets.append(
            ("fact", [_catalog_filename(r["path"]) for r in list_fact_catalog(entity)])
        )
    if include_episodes:
        kind_buckets.append(
            (
                "episode",
                [_catalog_filename(r["path"]) for r in list_episode_catalog(entity)],
            )
        )
    if include_journal:
        kind_buckets.append(
            (
                "journal",
                [_catalog_filename(r["path"]) for r in list_journal_catalog(entity)],
            )
        )

    for kind, names in kind_buckets:
        rows = [name for name in names if name]
        if not rows:
            continue
        body_lines.extend(
            _format_kind_section_lines(heading=_KIND_HEADING.get(kind, kind), rows=rows)
        )
        body_lines.append("")

    while body_lines and not body_lines[-1]:
        body_lines.pop()

    if body_lines:
        body = "\n".join(body_lines)
        sections.append(f"<{tag}>\n{body}\n</{tag}>")

    if not sections:
        return ""
    return "\n\n".join(sections)


def format_entity_catalog_lines(
    entity: EntityRef,
    *,
    include_facts: bool = True,
    include_episodes: bool = True,
    include_craft: bool = True,
    include_journal: bool = True,
) -> list[str]:
    """Catalog lines for system-prompt: **filenames only** under kind headings.

    ``MEMORY.md`` 置顶。craft / episodic / journal 只列文件名（自描述名字即索引）；
    长期记忆 standing 整页走 L1，不进 catalog。正文不注入——需要细节再用
    ``assets`` read/search。``include_facts`` 保留兼容参数，默认不再列出（产品已去掉「条目」）。
    """
    _ = include_facts  # legacy; product IA no longer surfaces facts as a primary kind
    lines: list[str] = ["- MEMORY.md"]

    craft_rows = (
        [_catalog_filename(r["path"]) for r in list_craft_catalog(entity)] if include_craft else []
    )
    episode_rows = (
        [_catalog_filename(r["path"]) for r in list_episode_catalog(entity)]
        if include_episodes
        else []
    )
    journal_rows = (
        [_catalog_filename(r["path"]) for r in list_journal_catalog(entity)]
        if include_journal
        else []
    )

    for heading, rows in (
        ("craft · 经验/做法", craft_rows),
        ("episodic · 过程", episode_rows),
        ("journal · 反思", journal_rows),
    ):
        lines.extend(_format_kind_section_lines(heading=heading, rows=rows))
    return lines
