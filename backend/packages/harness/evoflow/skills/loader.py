import logging
import os
import sys
import threading
from pathlib import Path

from .parser import parse_skill_file
from .types import Skill

logger = logging.getLogger(__name__)


# Cache: (mtime_map, skills_list, cached_at_mono)
# mtime_map: {relative_skill_path: (mtime_ns, file_size)}
_skills_cache: tuple[dict[str, tuple[int, int]], list[Skill], float] | None = None
_skills_cache_ttl: float = 300  # seconds before re-checking mtimes
# Rendered <skill_system> section cache (avoids rebuild on every turn).
_skills_prompt_section_cache: dict[tuple, str] = {}
_skills_prompt_section_lock = threading.Lock()


def clear_skills_cache() -> None:
    """Clear the skills cache to force reload on next load_skills call."""
    global _skills_cache
    _skills_cache = None
    with _skills_prompt_section_lock:
        _skills_prompt_section_cache.clear()
    logger.debug("Skills cache cleared")


def get_cached_skills_prompt_section(cache_key: tuple, builder) -> str:
    """Return a cached skills prompt section, building it once per key."""
    with _skills_prompt_section_lock:
        hit = _skills_prompt_section_cache.get(cache_key)
        if hit is not None:
            return hit
    section = builder()
    with _skills_prompt_section_lock:
        _skills_prompt_section_cache[cache_key] = section
    return section

def _build_mtime_map(skills_path: Path) -> dict[str, tuple[int, int]]:
    """Build an mtime/size map of all SKILL.md files under public/ and custom/."""
    mtime_map: dict[str, tuple[int, int]] = {}
    for category in ("public", "custom"):
        category_path = skills_path / category
        if not category_path.is_dir():
            continue
        for current_root, dir_names, file_names in os.walk(category_path, followlinks=True):
            dir_names[:] = sorted(name for name in dir_names if not name.startswith("."))
            if "SKILL.md" not in file_names:
                continue
            skill_file = Path(current_root) / "SKILL.md"
            try:
                st = skill_file.stat()
                rel = str(skill_file.relative_to(skills_path))
                mtime_map[rel] = (st.st_mtime_ns, st.st_size)
            except OSError:
                continue
    return mtime_map


def _skills_root_from_source_tree() -> Path | None:
    """Resolve ``<repo>/skills`` when running from a checkout (not venv-only installs).

    ``loader.py`` path: ``packages/harness/evoflow/skills/loader.py`` → five parents up is ``backend/``.
    """
    backend_dir = Path(__file__).resolve().parent.parent.parent.parent.parent
    candidate = (backend_dir.parent / "skills").resolve()
    if not candidate.is_dir():
        return None
    # Typical EvoFlow tree has at least one of these; avoids false positives if parent walk lands wrong.
    if (candidate / "public").is_dir() or (candidate / "custom").is_dir():
        return candidate
    return None


def get_skills_root_path() -> Path:
    """
    Get the root path of the skills directory.

    Returns:
        Path to the skills directory (typically ``~/.evoflow/skills``).
    """
    # 1) Explicit override (set by gateway bootstrap via ensure_user_skills_install).
    env_path = os.getenv("EVOFLOW_SKILLS_PATH", "").strip()
    if env_path:
        p = Path(env_path).expanduser()
        if p.exists():
            return p.resolve()

    # 2) User install dir — canonical store (public synced from system, custom user-only).
    user_skills = (Path.home() / ".evoflow" / "skills").resolve()
    if user_skills.is_dir() and (
        (user_skills / "public").is_dir() or (user_skills / "custom").is_dir()
    ):
        return user_skills

    # 3) Frozen executable layout (PyInstaller onedir) — before first user sync.
    if getattr(sys, "frozen", False):
        exe_dir = Path(sys.executable).resolve().parent
        for candidate in (exe_dir / "skills", exe_dir.parent / "skills"):
            if candidate.exists():
                return candidate.resolve()

    # 4) Monorepo checkout (dev fallback when gateway bootstrap has not run yet).
    src_skills = _skills_root_from_source_tree()
    if src_skills is not None:
        return src_skills

    # 5) Working-directory-relative fallback (local dev).
    cwd_skills = (Path.cwd() / "skills").resolve()
    if cwd_skills.exists():
        return cwd_skills

    # 6) Last resort: same parent walk as (4) even if directory missing (caller may create / error).
    backend_dir = Path(__file__).resolve().parent.parent.parent.parent.parent
    return (backend_dir.parent / "skills").resolve()


def _dedupe_skills_by_name(skills: list[Skill]) -> list[Skill]:
    """Keep one Skill per frontmatter ``name`` when the repo has duplicate trees (e.g. ``public/x`` and ``public/mbb-skills/x``).

    Prefers directories outside ``mbb-skills``, then shallower paths, for stable UI/API lists.
    """
    if len(skills) < 2:
        return skills
    buckets: dict[str, list[Skill]] = {}
    for s in skills:
        buckets.setdefault(s.name, []).append(s)

    def rank(s: Skill) -> tuple[int, int, str]:
        p = str(s.skill_dir.resolve()).replace("\\", "/")
        in_mbb = 1 if "mbb-skills" in p else 0
        depth = len(s.skill_dir.parts)
        return (in_mbb, depth, p)

    out: list[Skill] = []
    for name, group in buckets.items():
        if len(group) == 1:
            out.append(group[0])
            continue
        group_sorted = sorted(group, key=rank)
        chosen = group_sorted[0]
        out.append(chosen)
        dropped = [g.skill_dir for g in group_sorted[1:]]
        logger.debug(
            "Deduped skill name %r: kept %s, dropped %s",
            name,
            chosen.skill_dir,
            dropped,
        )
    return out


def load_skills(
    skills_path: Path | None = None,
    use_config: bool = True,
    enabled_only: bool = False,
    *,
    workspace_root: str | None = None,
    scope_skill_roots: list | None = None,
) -> list[Skill]:
    """
    Load all skills from the skills directory.

    Uses mtime-based incremental caching: a lightweight stat scan first checks
    if any SKILL.md has changed; if not, returns the cached list. When changes
    are detected, does a full parse and rebuilds the cache.

    Scans both public and custom skill directories, parsing SKILL.md files
    to extract metadata. The enabled state is determined by the skills_state_config.json file.

    Args:
        skills_path: Optional custom path to skills directory.
                     If not provided and use_config is True, uses path from config.
                     Otherwise defaults to evo-flow/skills
        use_config: Whether to load skills path from config (default: True)
        enabled_only: If True, only return enabled skills (default: False)
        scope_skill_roots: Optional ``[(Path, SkillScope), ...]`` for org/personal/group layers.

    Returns:
        List of Skill objects, sorted by name
    """
    global _skills_cache
    import time as _time

    if skills_path is None:
        if use_config:
            try:
                from evoflow.config import get_app_config

                config = get_app_config()
                skills_path = config.skills.get_skills_path()
            except Exception:
                # Fallback to default if config fails
                skills_path = get_skills_root_path()
        else:
            skills_path = get_skills_root_path()

    if not skills_path.exists() and not scope_skill_roots:
        return []

    use_simple_cache = not scope_skill_roots

    # ── Check cache: TTL first, then lightweight mtime scan ───────────
    if use_simple_cache and _skills_cache is not None:
        cached_mtime_map, cached_skills, cached_at = _skills_cache
        age = _time.monotonic() - float(cached_at)
        if age < _skills_cache_ttl:
            skills = list(cached_skills)  # return a copy
            if enabled_only:
                skills = [s for s in skills if s.enabled]
            return skills
        try:
            current_mtime_map = _build_mtime_map(skills_path)
            if current_mtime_map == cached_mtime_map:
                # Refresh TTL stamp without reparsing.
                _skills_cache = (cached_mtime_map, cached_skills, _time.monotonic())
                skills = list(cached_skills)
                if enabled_only:
                    skills = [s for s in skills if s.enabled]
                return skills
            logger.info("Skills changed on disk (%d entries differ), reloading", len(cached_mtime_map))
        except Exception:
            pass

    # ── Full scan ─────────────────────────────────────────────────────
    if workspace_root is None:
        try:
            from evoflow.tools.host_direct.workspace_context import resolve_tool_workspace_root

            ws, _ = resolve_tool_workspace_root(runtime=None)
            workspace_root = ws
        except Exception:
            workspace_root = None

    try:
        from evoflow.skills.index import SkillIndex

        index = SkillIndex.load(
            skills_path=skills_path,
            workspace_root=workspace_root,
            scope_skill_roots=scope_skill_roots,
        )
        skills = index.skills
    except Exception:
        logger.warning("SkillIndex.load failed; falling back to legacy scan", exc_info=True)
        skills = _legacy_scan_skills(skills_path) if skills_path.exists() else []

    try:
        from evoflow.persistence import config_repositories as cfg_repo
        from evoflow.persistence.bootstrap import sync_skills_from_filesystem

        sync_skills_from_filesystem()
        registry = cfg_repo.list_skill_registry()
        for skill in skills:
            reg = registry.get(skill.name)
            if reg is not None:
                skill.enabled = bool(reg.get("enabled", True))
            else:
                from evoflow.config.extensions_config import ExtensionsConfig

                skill.enabled = ExtensionsConfig.from_db().is_skill_enabled(skill.name, skill.category)
    except Exception as e:
        logger.warning("Failed to load skill enablement from SQLite: %s", e)

    # Sort by name for consistent ordering (cache stores the full list).
    skills.sort(key=lambda s: s.name)

    # ── Update cache ──────────────────────────────────────────────────
    if use_simple_cache:
        try:
            mtime_map = _build_mtime_map(skills_path)
            _skills_cache = (mtime_map, list(skills), _time.monotonic())
        except Exception:
            pass

    if enabled_only:
        return [skill for skill in skills if skill.enabled]
    return skills


def _legacy_scan_skills(skills_path: Path) -> list[Skill]:
    skills: list[Skill] = []
    for category in ["public", "custom"]:
        category_path = skills_path / category
        if not category_path.exists() or not category_path.is_dir():
            continue
        for current_root, dir_names, file_names in os.walk(category_path, followlinks=True):
            dir_names[:] = sorted(name for name in dir_names if not name.startswith("."))
            if "SKILL.md" not in file_names:
                continue
            skill_file = Path(current_root) / "SKILL.md"
            relative_path = skill_file.parent.relative_to(category_path)
            skill = parse_skill_file(skill_file, category=category, relative_path=relative_path)
            if skill:
                skills.append(skill)
    return _dedupe_skills_by_name(skills)


def find_skill_directory(skill_key: str, *, require_enabled: bool = False) -> Path | None:
    """Resolve a skill install directory by frontmatter ``name`` or by folder name on disk.

    Used by ``skill:`` URIs, ``skill_manager``, and host tools. When ``require_enabled`` is True,
    only skills that appear in ``load_skills(enabled_only=True)`` are returned (by directory match).
    """
    key = (skill_key or "").strip().lower()
    if not key:
        return None

    all_skills = load_skills(enabled_only=False, use_config=True)
    for skill in all_skills:
        if skill.name.strip().lower() == key:
            if require_enabled and not skill.enabled:
                return None
            return skill.skill_dir

    try:
        from evoflow.skills.index import SkillIndex

        index = SkillIndex.load()
        hit = index.get(key)
        if hit is not None:
            if require_enabled and not hit.enabled:
                return None
            return hit.skill_dir
    except Exception:
        pass

    root = get_skills_root_path()
    if not root.is_dir():
        return None

    disk: Path | None = None
    for sub in ("public", "custom"):
        p = root / sub / key
        if (p / "SKILL.md").is_file():
            disk = p
            break
    if disk is None:
        for skill_md in root.rglob("SKILL.md"):
            if skill_md.parent.name.lower() == key:
                disk = skill_md.parent
                break
    if disk is None:
        return None

    if not require_enabled:
        return disk

    try:
        resolved = disk.resolve()
    except OSError:
        return None
    for skill in all_skills:
        if not skill.enabled:
            continue
        try:
            if skill.skill_dir.resolve() == resolved:
                return disk
        except OSError:
            continue
    return None
