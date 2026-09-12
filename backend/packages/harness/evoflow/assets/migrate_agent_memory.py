"""One-time migration: ``assets/agents/{code}/memory|craft`` → ``assets/user/``."""

from __future__ import annotations

import logging
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from evoflow.assets.paths import EntityRef, assets_root, entity_root

logger = logging.getLogger(__name__)

_TEXT_SUFFIXES = {".md", ".markdown", ".mdx", ".txt", ".yaml", ".yml", ".json"}


@dataclass
class AgentMemoryMigrationReport:
    agents_scanned: int = 0
    files_moved: int = 0
    files_skipped: int = 0
    conflicts_renamed: int = 0
    backups: list[str] = field(default_factory=list)
    details: list[str] = field(default_factory=list)


def _unique_target(target: Path, *, prefix: str) -> Path:
    if not target.exists():
        return target
    stem = target.stem
    suffix = target.suffix
    parent = target.parent
    cand = parent / f"{prefix}__{stem}{suffix}"
    n = 2
    while cand.exists():
        cand = parent / f"{prefix}__{stem}-{n}{suffix}"
        n += 1
    return cand


def _relocate_file(src: Path, dst: Path, *, conflict_prefix: str, report: AgentMemoryMigrationReport) -> None:
    if not src.is_file():
        return
    dst.parent.mkdir(parents=True, exist_ok=True)
    final = dst
    if final.exists():
        final = _unique_target(final, prefix=conflict_prefix)
        report.conflicts_renamed += 1
    shutil.copy2(src, final)
    report.files_moved += 1
    report.details.append(f"copied {src.relative_to(assets_root())} → {final.relative_to(assets_root())}")


def migrate_agent_memory_to_user(*, dry_run: bool = True) -> dict[str, Any]:
    """Copy agent memory/craft into user tree; optionally archive agent subtrees."""
    report = AgentMemoryMigrationReport()
    root = assets_root()
    user_root = entity_root(EntityRef("user", "user"))
    agents_root = root / "agents"
    if not agents_root.is_dir():
        return {"ok": True, "dryRun": dry_run, **report.__dict__}

    for agent_dir in sorted(agents_root.iterdir()):
        if not agent_dir.is_dir() or agent_dir.name.startswith("."):
            continue
        code = agent_dir.name.strip().lower() or agent_dir.name
        report.agents_scanned += 1
        for subtree in ("memory", "craft"):
            src_tree = agent_dir / subtree
            if not src_tree.is_dir():
                continue
            for src in sorted(src_tree.rglob("*")):
                if not src.is_file():
                    continue
                if src.suffix.lower() not in _TEXT_SUFFIXES and src.name != "MEMORY.md":
                    continue
                rel = src.relative_to(src_tree)
                dst = user_root / subtree / rel
                if dry_run:
                    if dst.exists():
                        report.conflicts_renamed += 1
                    report.files_moved += 1
                    report.details.append(
                        f"would copy agents/{code}/{subtree}/{rel.as_posix()} → user/{subtree}/{rel.as_posix()}"
                    )
                    continue
                _relocate_file(src, dst, conflict_prefix=code, report=report)

        if not dry_run:
            deprecated = root / "_deprecated" / "agents" / code
            for subtree in ("memory", "craft"):
                src_tree = agent_dir / subtree
                if src_tree.is_dir():
                    deprecated_sub = deprecated / subtree
                    deprecated_sub.parent.mkdir(parents=True, exist_ok=True)
                    if deprecated_sub.exists():
                        shutil.rmtree(deprecated_sub, ignore_errors=True)
                    shutil.move(str(src_tree), str(deprecated_sub))
                    report.backups.append(str(deprecated_sub.relative_to(root)))

    return {
        "ok": True,
        "dryRun": dry_run,
        "agentsScanned": report.agents_scanned,
        "filesMoved": report.files_moved,
        "filesSkipped": report.files_skipped,
        "conflictsRenamed": report.conflicts_renamed,
        "backups": report.backups,
        "details": report.details[:200],
    }
