"""Asset system self-audit — scan + 3-dim score + Markdown report.

Statische Analyse (kein LLM). Liefert Zahlen + Markdown-Report.
Score-Logik (siehe ``compute_scores``):

- **closure**: hat das System alle Loops geschlossen (write → index → load)?
- **density**: genug Material in facts / episodic / journal / craft?
- **freshness**: gibt es aktuelle Inbox + laufende Reflections?

Output: Markdown-Report (``memory/audit/YYYY-MM-DD-audit.md``) + Summary-JSON
am Anfang des Reports. Audit-Dateien werden **nie** von der Asset-Pipeline
geparst (kein Asset ist Audit).

CLI: ``python -m evoflow.assets.audit [user_id]``
"""

from __future__ import annotations

import json
import re
import sys
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from evoflow.assets.paths import EntityRef, entity_root, sanitize_user_asset_id

AUDIT_DIRNAME = "audit"
_MAX_AUDIT_FILES = 30  # 历史保留 30 份
_REPORT_HEADER = "# 资产体系审计"


# ── Score model ────────────────────────────────────────────────────────────


@dataclass
class AuditScore:
    closure: int            # 0-100 闭环度
    density: int            # 0-100 沉淀密度
    freshness: int          # 0-100 时效性
    overall: int            # 0-100 综合
    grade: str              # A/B/C/D
    rationale: list[str] = field(default_factory=list)


# ── Data collection ────────────────────────────────────────────────────────


@dataclass
class _AuditData:
    counts: dict[str, int]
    broken_refs: list[str]
    unreferenced_files: list[str]
    inbox_pending: list[str]
    inbox_done_recent: int
    last_standing_update: str | None
    last_journal_update: str | None
    profile_gaps: list[str]
    journal_vs_episodic_ratio: float


def _list_md(p: Path) -> list[Path]:
    if not p.exists():
        return []
    return [f for f in p.iterdir() if f.is_file() and f.suffix.lower() == ".md"]


# README files are 说明文档（directory-level orientation docs），按设计不进入 MEMORY.md。
# 这是与 evoflow-assets skill §2「四类资产布局」一致的设计选择，不算「孤立资产」。
_README_NAMES = frozenset({"README.md", "readme.md"})


def _is_indexable(path: Path) -> bool:
    """README.md 不进入索引；其余文件都应被 MEMORY.md 引用。"""
    return path.name not in _README_NAMES


def _profile_gaps(root: Path) -> list[str]:
    """检查 profile 三件套是否齐全"""
    gaps = []
    for f in ["basic-info.md", "preferences.md", "persona.md"]:
        p = root / "profile" / f
        if not p.exists() or p.stat().st_size < 80:
            gaps.append(f"profile/{f}")
    return gaps


def _gather(entity: EntityRef) -> _AuditData:
    root = entity_root(entity)

    # 1. counts
    counts: dict[str, int] = {}
    for sub, key in [
        ("profile", "profile"),
        ("memory/facts", "facts"),
        ("memory/episodic", "episodic"),
        ("memory/journal", "journal"),
        ("memory/_inbox/notes", "inbox_pending"),
        ("memory/_inbox/_done", "inbox_done"),
        ("memory/archive/completed-goals", "archive_goals"),
        ("craft", "craft"),
    ]:
        counts[key] = len(_list_md(root / sub))

    # 2. MEMORY.md 引用一致性
    mem = root / "memory" / "MEMORY.md"
    refs: set[str] = set()
    if mem.exists():
        text = mem.read_text(encoding="utf-8", errors="replace")
        # Task Group 格式: "- memory/episodic/foo.md (..." 或 "- craft/foo.md"
        for m in re.finditer(
            r"^\s*-\s+(memory/(?:facts|episodic|journal)/[^\s)]+\.md|craft/[^\s)]+\.md)\b",
            text,
            re.M,
        ):
            refs.add(m.group(1))

    # 3. broken refs vs disk
    broken: list[str] = []
    for r in refs:
        fp = root / r
        if not fp.exists():
            broken.append(r)

    # 4. on-disk files but not in MEMORY.md (README docs are exempt by design)
    on_disk_facts = {
        f"memory/facts/{f.name}"
        for f in _list_md(root / "memory" / "facts")
        if _is_indexable(f)
    }
    on_disk_ep = {
        f"memory/episodic/{f.name}"
        for f in _list_md(root / "memory" / "episodic")
        if _is_indexable(f)
    }
    on_disk_jour = {
        f"memory/journal/{f.name}"
        for f in _list_md(root / "memory" / "journal")
        if _is_indexable(f)
    }
    on_disk_craft = {
        f"craft/{f.name}"
        for f in _list_md(root / "craft")
        if _is_indexable(f)
    }
    on_disk_all = on_disk_facts | on_disk_ep | on_disk_jour | on_disk_craft
    unreferenced = sorted(on_disk_all - refs)

    # 5. inbox pending + done recency
    inbox_pending = sorted(
        f.name for f in _list_md(root / "memory" / "_inbox" / "notes")
    )
    inbox_done = _list_md(root / "memory" / "_inbox" / "_done")
    cutoff = datetime.now(UTC) - timedelta(days=7)
    recent_done = 0
    for f in inbox_done:
        try:
            ts = datetime.fromtimestamp(f.stat().st_mtime, UTC)
            if ts >= cutoff:
                recent_done += 1
        except OSError:
            continue

    # 6. standing / journal 最新更新时间
    def _mtime(rel: str) -> str | None:
        p = root / rel
        if not p.exists():
            return None
        try:
            ts = datetime.fromtimestamp(p.stat().st_mtime, UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
            return ts
        except OSError:
            return None

    last_standing = _mtime("memory/standing.md")
    last_journal = _mtime("memory/journal")

    # 7. journal vs episodic 比例
    j = counts.get("journal", 0)
    e = counts.get("episodic", 0)
    ratio = j / max(e, 1)

    return _AuditData(
        counts=counts,
        broken_refs=broken,
        unreferenced_files=unreferenced,
        inbox_pending=inbox_pending,
        inbox_done_recent=recent_done,
        last_standing_update=last_standing,
        last_journal_update=last_journal,
        profile_gaps=_profile_gaps(root),
        journal_vs_episodic_ratio=ratio,
    )


# ── Scoring ────────────────────────────────────────────────────────────────


def _score_closure(d: _AuditData) -> tuple[int, list[str]]:
    """write → MEMORY.md 引用 → 文件存在（write/read 闭环）"""
    score = 100
    notes: list[str] = []
    n_broken = len(d.broken_refs)
    n_unref = len(d.unreferenced_files)
    if n_broken > 0:
        score -= min(50, n_broken * 10)
        notes.append(f"⚠️ {n_broken} 条 MEMORY.md 索引引用了不存在的文件")
    if n_unref > 0:
        score -= min(30, n_unref * 5)
        notes.append(f"⚠️ {n_unref} 个文件未被 MEMORY.md 索引（孤立资产）")
    if n_broken == 0 and n_unref == 0:
        notes.append("✅ 索引与磁盘一致（write ↔ index 闭环）")
    return max(score, 0), notes


def _score_density(d: _AuditData) -> tuple[int, list[str]]:
    """profile/facts/craft 维度是否够厚"""
    score = 100
    notes: list[str] = []
    c = d.counts
    gaps = []

    if c.get("profile", 0) < 3:
        gaps.append(f"profile ({c.get('profile', 0)}/3)")
    if c.get("facts", 0) < 1:
        gaps.append("facts (0)")
    if c.get("craft", 0) < 1:
        gaps.append("craft (0)")
    if c.get("episodic", 0) < 1:
        gaps.append("episodic (0)")
    if c.get("journal", 0) < 1:
        gaps.append("journal (0)")

    score -= min(70, len(gaps) * 18)
    if gaps:
        notes.append(f"⚠️ 沉淀稀薄：{', '.join(gaps)} 维度为空或不足")
    else:
        notes.append("✅ 五维度（profile/facts/craft/episodic/journal）皆有材料")

    if d.profile_gaps:
        score -= min(20, len(d.profile_gaps) * 7)
        notes.append(f"⚠️ profile 缺口：{', '.join(d.profile_gaps)}")

    return max(score, 0), notes


def _score_freshness(d: _AuditData) -> tuple[int, list[str]]:
    """系统是否在持续运转"""
    score = 100
    notes: list[str] = []
    n_inbox = len(d.inbox_pending)
    n_done = d.inbox_done_recent
    has_recent_standing = False
    if d.last_standing_update:
        try:
            ts = datetime.strptime(d.last_standing_update, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)
            has_recent_standing = (datetime.now(UTC) - ts) < timedelta(days=14)
        except ValueError:
            pass

    if n_inbox == 0 and n_done == 0 and not has_recent_standing:
        score -= 40
        notes.append("⚠️ 系统已停转：inbox 为空、Phase2 7 天内未跑、standing 超 14 天未更新")
    elif n_inbox == 0 and n_done > 0:
        notes.append(f"✅ Phase2 7 天内合并 {n_done} 条；inbox 当前为空")
    elif n_inbox > 0:
        notes.append(f"✅ inbox 有 {n_inbox} 条待处理")
    else:
        notes.append("ℹ️ 系统稳态（无待办）")

    # journal 反思密度（每个 episodic 至少 0.15 个反思算健康）
    if d.journal_vs_episodic_ratio < 0.15 and d.counts.get("episodic", 0) >= 3:
        score -= 15
        notes.append(f"⚠️ 反思稀薄：journal/episodic = {d.journal_vs_episodic_ratio:.2f} < 0.15")

    return max(score, 0), notes


def _grade(overall: int) -> str:
    if overall >= 85:
        return "A"
    if overall >= 70:
        return "B"
    if overall >= 50:
        return "C"
    return "D"


def compute_scores(d: _AuditData) -> AuditScore:
    closure, n1 = _score_closure(d)
    density, n2 = _score_density(d)
    freshness, n3 = _score_freshness(d)
    overall = round((closure + density + freshness) / 3)
    rationale = n1 + n2 + n3
    return AuditScore(
        closure=closure,
        density=density,
        freshness=freshness,
        overall=overall,
        grade=_grade(overall),
        rationale=rationale,
    )


# ── Reporting ──────────────────────────────────────────────────────────────


def _advantages(score: AuditScore, d: _AuditData) -> list[str]:
    """基于数据归纳「体系的优势」"""
    out: list[str] = []
    if score.closure >= 90:
        out.append("**索引一致**：MEMORY.md 与磁盘文件 100% 对齐；write/read 闭环健康。")
    if d.counts.get("episodic", 0) >= 5:
        out.append(f"**复盘资产丰富**：{d.counts['episodic']} 个 episodic 文件，过程知识沉淀良好。")
    if d.counts.get("facts", 0) >= 3:
        out.append(f"**稳定事实有底**：{d.counts['facts']} 个 fact，命名/约定/配置可被下次会话直接复用。")
    if d.inbox_done_recent >= 2:
        out.append(f"**Phase2 活跃**：近 7 天已合并 {d.inbox_done_recent} 条原始材料。")
    if d.counts.get("craft", 0) >= 3:
        out.append(f"**可复用做法库成型**：{d.counts['craft']} 个 craft。")
    if not out:
        out.append("（体系尚薄，无突出优势）")
    return out


def _problems(score: AuditScore, d: _AuditData) -> list[str]:
    """基于数据归纳「体系的问题」"""
    out: list[str] = []
    if d.broken_refs:
        out.append(
            f"**索引断裂**（{len(d.broken_refs)} 条）：MEMORY.md 引用的文件不存在。"
            "Phase2 重命名了路径但未同步更新 MEMORY.md。"
        )
    if d.unreferenced_files:
        out.append(
            f"**孤立资产**（{len(d.unreferenced_files)} 个）：磁盘上有文件但 MEMORY.md 未索引，"
            "下次会话不会加载。"
        )
    if d.profile_gaps:
        out.append(
            f"**profile 缺口**：{', '.join(d.profile_gaps)} 内容为空或过短，"
            "需在下次对话主动询问用户补齐。"
        )
    if d.counts.get("journal", 0) == 0 and d.counts.get("episodic", 0) > 0:
        out.append("**反思为 0**：有复盘但没反思，沉淀只能复用过程不能改进下次判断。")
    if d.journal_vs_episodic_ratio < 0.15 and d.counts.get("episodic", 0) >= 3:
        out.append(
            f"**反思/复盘比仅 {d.journal_vs_episodic_ratio:.2f}**："
            "建议每完成 5 个 episodic 至少写 1 个 reflection。"
        )
    if score.freshness < 60:
        out.append("**系统怠速**：长期无 inbox 与 Phase2 产出，资产已停止演化。")
    if not out:
        out.append("（未发现问题；当前是健康稳态）")
    return out


def _recommendations(d: _AuditData) -> list[str]:
    """基于数据给可执行的下一步"""
    out: list[str] = []
    if d.broken_refs:
        out.append(
            "1. **修复索引断裂** — 用 `replace("
            '"memory/MEMORY.md", ...)` 把失效路径替换为新路径（或删除该指针行）。'
        )
    if d.unreferenced_files:
        out.append(
            "2. **为孤立资产补指针** — 在 MEMORY.md 末尾追加 `- <path>` 指针行，"
            "或在 `<path>` 首行加 frontmatter `source:` 触发 Phase2 索引。"
        )
    if d.profile_gaps:
        out.append(
            f"3. **补 profile 缺口** — 在下次对话问用户 1~2 句关于 {d.profile_gaps[0]} 的问题。"
        )
    if d.journal_vs_episodic_ratio < 0.15 and d.counts.get("episodic", 0) >= 3:
        out.append(
            "4. **从最新 episodic 提炼 1 个 reflection** — "
            "读最新 episodic 提炼「踩坑 → 教训」写到 `memory/journal/reflection-YYYY-MM-DD.md`。"
        )
    if d.inbox_pending:
        out.append(
            f"5. **处理 inbox** — 有 {len(d.inbox_pending)} 条 pending；"
            "Phase2 会自动合并，但用户可主动读 + 早提升。"
        )
    if not out:
        out.append("（无需修复；继续对话自然沉淀）")
    return out


def render_report(entity: EntityRef, data: _AuditData, score: AuditScore) -> str:
    """生成 Markdown 人话版审计报告"""
    now = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    summary_json = json.dumps(
        {
            "as_of": now,
            "entity": f"{entity.entity_type}:{entity.entity_id}",
            "counts": data.counts,
            "broken_refs_count": len(data.broken_refs),
            "unreferenced_count": len(data.unreferenced_files),
            "profile_gaps": data.profile_gaps,
            "scores": asdict(score),
        },
        ensure_ascii=False,
        indent=2,
    )

    lines: list[str] = []
    lines.append(_REPORT_HEADER)
    lines.append("")
    lines.append(f"_生成时间: {now} · 主体: {entity.entity_type}:{entity.entity_id}_")
    lines.append("")
    lines.append("## 评分")
    lines.append("")
    lines.append("| 维度 | 分数 |")
    lines.append("|------|------|")
    lines.append(f"| **综合** | **{score.overall} / 100 ({score.grade})** |")
    lines.append(f"| 闭环度（write ↔ index ↔ load） | {score.closure} |")
    lines.append(f"| 沉淀密度（profile/facts/craft/episodic/journal） | {score.density} |")
    lines.append(f"| 时效性（inbox / Phase2 / journal） | {score.freshness} |")
    lines.append("")
    lines.append("### 评分依据")
    lines.append("")
    for r in score.rationale:
        lines.append(f"- {r}")
    lines.append("")
    lines.append("## 数据快照")
    lines.append("")
    lines.append("| 维度 | 数量 |")
    lines.append("|------|------|")
    for k, v in data.counts.items():
        lines.append(f"| {k} | {v} |")
    lines.append("")
    lines.append(
        f"- 最近 standing 更新: `{data.last_standing_update or '—'}`"
    )
    lines.append(
        f"- 最近 journal 更新: `{data.last_journal_update or '—'}`"
    )
    lines.append(
        f"- journal/episodic 比例: `{data.journal_vs_episodic_ratio:.2f}`"
    )
    lines.append("")
    lines.append("## 体系的优势（数据说话）")
    lines.append("")
    for s in _advantages(score, data):
        lines.append(f"- {s}")
    lines.append("")
    lines.append("## 体系的问题（数据说话）")
    lines.append("")
    for p in _problems(score, data):
        lines.append(f"- {p}")
    if data.broken_refs:
        lines.append("")
        lines.append("**断裂索引明细**：")
        for r in data.broken_refs:
            lines.append(f"  - `{r}`")
    if data.unreferenced_files:
        lines.append("")
        lines.append("**孤立资产明细**：")
        for r in data.unreferenced_files:
            lines.append(f"  - `{r}`")
    lines.append("")
    lines.append("## 下一步建议（可执行）")
    lines.append("")
    for r in _recommendations(data):
        lines.append(r)
    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("```json")
    lines.append(summary_json)
    lines.append("```")
    lines.append("")
    return "\n".join(lines)


# ── Public entry ───────────────────────────────────────────────────────────


def run_audit(user_id: str = "webui_1", *, repair: bool = False) -> dict[str, Any]:
    """运行一次审计；落盘到 ``memory/audit/YYYY-MM-DD-audit.md``。

    Args:
        user_id: 用户 ID。
        repair: 若为 True，先尝试把孤立资产指针追加到 MEMORY.md
                （追加到 ``## Audit-Trail`` 段；若段不存在则新建）。

    Returns:
        summary dict（包含分数、落盘路径、可选的 repair 统计）。
    """
    entity = EntityRef("user", sanitize_user_asset_id(user_id))
    root = entity_root(entity)

    repair_info: dict[str, Any] = {}
    if repair:
        repair_info = repair_unreferenced_files(entity)

    data = _gather(entity)
    score = compute_scores(data)
    report = render_report(entity, data, score)

    audit_dir = root / "memory" / AUDIT_DIRNAME
    audit_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(UTC).strftime("%Y-%m-%d-%H%M%SZ")
    report_path = audit_dir / f"{stamp}-audit.md"
    report_path.write_text(report, encoding="utf-8")

    # Rotate: 保留最近 _MAX_AUDIT_FILES 份
    existing = sorted(audit_dir.glob("*-audit.md"), reverse=True)
    for old in existing[_MAX_AUDIT_FILES:]:
        try:
            old.unlink()
        except OSError:
            pass

    return {
        "ok": True,
        "path": str(report_path),
        "scores": asdict(score),
        "counts": data.counts,
        "broken_refs": data.broken_refs,
        "unreferenced": data.unreferenced_files,
        "repair": repair_info,
    }


def repair_unreferenced_files(entity: EntityRef) -> dict[str, Any]:
    """为孤立资产追加指针行到 MEMORY.md 的 ``## Audit-Trail`` 段。

    不修改既有 Task Group 结构；只在末尾追加。

    Returns:
        {"appended": int, "skipped_existing": int, "new_section": bool}
    """
    root = entity_root(entity)
    data = _gather(entity)
    mem_path = root / "memory" / "MEMORY.md"

    if not data.unreferenced_files:
        return {"appended": 0, "skipped_existing": 0, "new_section": False}

    # Ensure MEMORY.md exists
    if not mem_path.exists():
        mem_path.write_text(
            "# MEMORY\n\n"
            "## Audit-Trail\n\n"
            "auto-generated by `audit.repair_unreferenced_files`\n\n",
            encoding="utf-8",
        )

    text = mem_path.read_text(encoding="utf-8", errors="replace")

    # Find or create ## Audit-Trail section
    section_marker = "## Audit-Trail"
    if section_marker in text:
        # extract existing pointer lines under this section
        section_start = text.index(section_marker)
        next_section = re.search(r"^## ", text[section_start + len(section_marker):], re.M)
        if next_section:
            section_end = section_start + len(section_marker) + next_section.start()
        else:
            section_end = len(text)
        section_body = text[section_start:section_end]
        existing_refs = set(
            re.findall(
                r"^\s*-\s+(memory/(?:facts|episodic|journal)/[^\s)\|]+\.md|craft/[^\s)\|]+\.md)\b",
                section_body,
                re.M,
            )
        )
        new_section_created = False
    else:
        # create new section
        if not text.endswith("\n"):
            text += "\n"
        text += "\n## Audit-Trail\n\n"
        text += "auto-generated by `audit.repair_unreferenced_files` "
        text += "— files below were not in any Task Group; "
        text += "move them into the proper Task or leave here for review.\n\n"
        existing_refs = set()
        new_section_created = True

    # Append pointer lines for unreferenced files (skip those already in this section)
    appended = 0
    skipped_existing = 0
    for path in data.unreferenced_files:
        if path in existing_refs:
            skipped_existing += 1
            continue
        text += f"- {path}\n"
        appended += 1

    if appended > 0:
        mem_path.write_text(text, encoding="utf-8")

    return {
        "appended": appended,
        "skipped_existing": skipped_existing,
        "new_section": new_section_created,
    }


def list_audit_reports(user_id: str = "webui_1") -> list[str]:
    """列出所有历史审计报告路径（最新在前）"""
    entity = EntityRef("user", sanitize_user_asset_id(user_id))
    audit_dir = entity_root(entity) / "memory" / AUDIT_DIRNAME
    if not audit_dir.exists():
        return []
    return [str(p) for p in sorted(audit_dir.glob("*-audit.md"), reverse=True)]


# ── CLI ───────────────────────────────────────────────────────────────────


def _cli(argv: list[str]) -> int:
    user_id = "webui_1"
    repair = False
    for arg in argv[1:]:
        if arg == "--repair":
            repair = True
        elif not arg.startswith("-"):
            user_id = arg
    result = run_audit(user_id, repair=repair)
    if not result.get("ok"):
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 1
    s = result["scores"]
    print(f"[audit] {user_id}  grade={s['grade']}  overall={s['overall']}  "
          f"closure={s['closure']}  density={s['density']}  freshness={s['freshness']}")
    if result["broken_refs"]:
        print(f"  broken refs: {len(result['broken_refs'])}")
    if result["unreferenced"]:
        print(f"  unreferenced files: {len(result['unreferenced'])}")
    if repair:
        r = result.get("repair", {})
        print(f"  repair: appended={r.get('appended', 0)} "
              f"skipped={r.get('skipped_existing', 0)} "
              f"new_section={r.get('new_section', False)}")
    print(f"  report: {result['path']}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(_cli(sys.argv))
