"""Multi-root skill discovery and name-index lookup."""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from pathlib import Path

from .parser import parse_skill_file
from .skill_scope import SkillScope
from .types import Skill

logger = logging.getLogger(__name__)

_MAX_SCAN_DEPTH = 6


@dataclass(frozen=True)
class SkillRootSpec:
    path: Path
    scope: SkillScope
    categories: tuple[str, ...] = ("public", "custom")
    label: str = ""


def _iter_skill_md_files(root: Path, *, max_depth: int = _MAX_SCAN_DEPTH) -> list[tuple[Path, str]]:
    """Return ``(skill_md_path, category_label)`` under *root*."""
    root = root.resolve()
    if not root.is_dir():
        return []

    out: list[tuple[Path, str]] = []

    def _walk_tree(base: Path, category: str, depth: int) -> None:
        if depth > max_depth:
            return
        try:
            for current_root, dir_names, file_names in os.walk(base, followlinks=True):
                dir_names[:] = sorted(n for n in dir_names if not n.startswith("."))
                if "SKILL.md" not in file_names:
                    continue
                out.append((Path(current_root) / "SKILL.md", category))
        except OSError:
            return

    has_categories = any((root / cat).is_dir() for cat in ("public", "custom"))
    if has_categories:
        for category in ("public", "custom"):
            cat_path = root / category
            if cat_path.is_dir():
                _walk_tree(cat_path, category, 0)
        return out

    if (root / "SKILL.md").is_file():
        out.append((root / "SKILL.md", "repo"))
        return out

    # Flat / nested external tree.
    try:
        for current_root, dir_names, file_names in os.walk(root, followlinks=True):
            dir_names[:] = sorted(n for n in dir_names if not n.startswith("."))
            rel_parts = Path(current_root).relative_to(root).parts
            if len(rel_parts) > max_depth:
                dir_names[:] = []
                continue
            if "SKILL.md" in file_names:
                out.append((Path(current_root) / "SKILL.md", "external"))
    except OSError:
        pass
    return out


def _dedupe_skills(skills: list[Skill]) -> list[Skill]:
    """Keep the highest-precedence skill per ``name``."""
    if len(skills) < 2:
        return skills

    def rank(s: Skill) -> tuple[int, int, int, str]:
        scope_val = int(getattr(s, "scope", SkillScope.PUBLIC))
        depth = len(s.skill_dir.parts)
        path = str(s.skill_dir.resolve()).replace("\\", "/")
        in_mbb = 1 if "mbb-skills" in path else 0
        return (-scope_val, in_mbb, depth, path)

    buckets: dict[str, list[Skill]] = {}
    for skill in skills:
        buckets.setdefault(skill.name, []).append(skill)

    out: list[Skill] = []
    for name, group in buckets.items():
        if len(group) == 1:
            out.append(group[0])
            continue
        chosen = sorted(group, key=rank)[0]
        out.append(chosen)
        dropped = [g.skill_dir for g in group if g is not chosen]
        if dropped:
            logger.debug("SkillIndex deduped %r: kept %s dropped %s", name, chosen.skill_dir, dropped)
    return out


def build_skill_roots(
    *,
    primary_root: Path,
    extra_roots: list[Path] | None = None,
    workspace_root: str | None = None,
    repo_skills_subdir: str = ".evoflow/skills",
    scope_skill_roots: list[tuple[Path, SkillScope]] | None = None,
) -> list[SkillRootSpec]:
    """Ordered discovery roots (scan order; dedupe uses scope precedence)."""
    roots: list[SkillRootSpec] = []

    for p in extra_roots or []:
        try:
            resolved = Path(p).expanduser().resolve()
        except OSError:
            continue
        if resolved.is_dir():
            roots.append(SkillRootSpec(path=resolved, scope=SkillScope.EXTERNAL, label=str(resolved)))

    if primary_root.is_dir():
        roots.append(SkillRootSpec(path=primary_root.resolve(), scope=SkillScope.PUBLIC, label="primary"))

    for path, scope in scope_skill_roots or []:
        try:
            resolved = Path(path).expanduser().resolve()
        except OSError:
            continue
        if not resolved.is_dir():
            continue
        if resolved in {r.path for r in roots}:
            continue
        roots.append(SkillRootSpec(path=resolved, scope=scope, label=scope.name.lower()))

    ws = str(workspace_root or "").strip()
    if ws:
        rel = str(repo_skills_subdir or ".evoflow/skills").strip().strip("/\\")
        repo_skills = (Path(ws).expanduser().resolve() / rel.replace("/", os.sep))
        if repo_skills.is_dir() and repo_skills not in {r.path for r in roots}:
            roots.append(SkillRootSpec(path=repo_skills, scope=SkillScope.REPO, label="repo"))

    return roots


def discover_skills_from_roots(roots: list[SkillRootSpec]) -> list[Skill]:
    skills: list[Skill] = []
    for spec in roots:
        scope = spec.scope
        for skill_file, category in _iter_skill_md_files(spec.path):
            rel_parent = skill_file.parent
            try:
                if category in ("public", "custom"):
                    rel = rel_parent.relative_to(spec.path / category)
                else:
                    rel = rel_parent.relative_to(spec.path)
            except ValueError:
                rel = Path(rel_parent.name)

            parsed = parse_skill_file(skill_file, category=category, relative_path=rel)
            if parsed is None:
                continue
            cat = parsed.category
            if scope == SkillScope.EXTERNAL:
                cat = "custom"
            elif scope == SkillScope.REPO:
                cat = "repo"
            elif scope == SkillScope.ORG:
                cat = "org" if category not in ("public", "custom") else category
            elif scope == SkillScope.PERSONAL:
                cat = "personal" if category not in ("public", "custom") else category
            elif scope == SkillScope.GROUP:
                cat = "group" if category not in ("public", "custom") else category
            skills.append(
                Skill(
                    name=parsed.name,
                    description=parsed.description,
                    license=parsed.license,
                    skill_dir=parsed.skill_dir,
                    skill_file=parsed.skill_file,
                    relative_path=parsed.relative_path,
                    category=cat,
                    enabled=parsed.enabled,
                    scope=scope,
                    source_root=spec.path,
                )
            )

    return _dedupe_skills(skills)


class SkillIndex:
    """In-memory index keyed by skill ``name``."""

    def __init__(self, skills: list[Skill]) -> None:
        self._skills = sorted(skills, key=lambda s: s.name.lower())
        self._by_name: dict[str, Skill] = {}
        for skill in self._skills:
            key = skill.name.strip().lower()
            if key and key not in self._by_name:
                self._by_name[key] = skill

    @property
    def skills(self) -> list[Skill]:
        return list(self._skills)

    def get(self, name: str) -> Skill | None:
        return self._by_name.get(str(name or "").strip().lower())

    @classmethod
    def load(
        cls,
        *,
        skills_path: Path | None = None,
        workspace_root: str | None = None,
        scope_skill_roots: list[tuple[Path, SkillScope]] | None = None,
    ) -> SkillIndex:
        if skills_path is None:
            try:
                from evoflow.config import get_app_config

                cfg = get_app_config().skills
                skills_path = cfg.get_skills_path()
                extra = cfg.get_extra_root_paths()
                repo_dir = str(cfg.repo_skills_dir or ".evoflow/skills").strip().strip("/\\")
            except Exception:
                from evoflow.skills.loader import get_skills_root_path

                skills_path = get_skills_root_path()
                extra = []
                repo_dir = ".evoflow/skills"
        else:
            extra = []
            repo_dir = ".evoflow/skills"

        roots = build_skill_roots(
            primary_root=skills_path,
            extra_roots=extra,
            workspace_root=workspace_root,
            repo_skills_subdir=repo_dir,
            scope_skill_roots=scope_skill_roots,
        )
        return cls(discover_skills_from_roots(roots))
