import logging
import os
import sys
import threading
from pathlib import Path
from typing import Any

from .parser import parse_skill_file
from .skill_scope import SkillScope
from .types import Skill

logger = logging.getLogger(__name__)


# Cache: (mtime_map, skills_list, cached_at_mono)
# mtime_map: {relative_skill_path: (mtime_ns, file_size)}
_skills_cache: tuple[dict[str, tuple[int, int]], list[Skill], float] | None = None
_skills_cache_ttl: float = 300  # seconds before re-checking mtimes
_plugin_state_sig: str | None = None
# Scoped cache: 带 scope_skill_roots 的请求原本完全绕过缓存，每次全量解析
# （实测 335 项 ~0.5–4s）。按键（roots 签名）缓存，同样用 mtime 校验。
_scoped_skills_cache: dict[str, tuple[dict[str, tuple[int, int]], list[Skill], float]] = {}
# Rendered <skill_system> section cache (avoids rebuild on every turn).
_skills_prompt_section_cache: dict[tuple, str] = {}
_skills_prompt_section_lock = threading.Lock()


def clear_skills_cache() -> None:
    """Clear the skills cache to force reload on next load_skills call."""
    global _skills_cache
    _skills_cache = None
    _scoped_skills_cache.clear()
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


def _build_mtime_map(
    skills_path: Path,
    extra_roots: list[Path] | None = None,
    scope_roots: list[tuple[Path, int]] | None = None,
) -> dict[str, tuple[int, int]]:
    """Build an mtime/size map of all SKILL.md files under public/ and custom/.

    Extra discovery roots (``skills.extra_roots``) are included too, otherwise edits
    inside them would never invalidate the TTL cache and the stale list would be served.
    Scope roots (org/personal/group) are included with a ``@scope:`` prefix for the
    scoped cache.
    """
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

    for root in extra_roots or []:
        try:
            root_resolved = Path(root).expanduser().resolve()
        except OSError:
            continue
        if not root_resolved.is_dir():
            continue
        for current_root, dir_names, file_names in os.walk(root_resolved, followlinks=True):
            dir_names[:] = sorted(name for name in dir_names if not name.startswith("."))
            if "SKILL.md" not in file_names:
                continue
            skill_file = Path(current_root) / "SKILL.md"
            try:
                st = skill_file.stat()
                mtime_map[f"@extra:{skill_file.resolve()}"] = (st.st_mtime_ns, st.st_size)
            except OSError:
                continue
    for idx, (root, _scope) in enumerate(scope_roots or []):
        try:
            root_resolved = Path(root).expanduser().resolve()
        except OSError:
            continue
        if not root_resolved.is_dir():
            continue
        for current_root, dir_names, file_names in os.walk(root_resolved, followlinks=True):
            dir_names[:] = sorted(name for name in dir_names if not name.startswith("."))
            if "SKILL.md" not in file_names:
                continue
            skill_file = Path(current_root) / "SKILL.md"
            try:
                st = skill_file.stat()
                mtime_map[f"@scope:{idx}:{skill_file.resolve()}"] = (st.st_mtime_ns, st.st_size)
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

    # 2) EVOFLOW_HOME → skills follows the home dir (dev/prod isolation).
    evoflow_home = os.getenv("EVOFLOW_HOME", "").strip()
    if evoflow_home:
        home = Path(evoflow_home).expanduser().resolve()
        user_skills = home / "skills"
        if user_skills.is_dir() and (
            (user_skills / "public").is_dir() or (user_skills / "custom").is_dir()
        ):
            return user_skills
        # Also accept when EVOFLOW_HOME points directly at the root (no data/ subdir).
        user_skills = home.parent / ".evoflow" / "skills"
        if user_skills.is_dir() and (
            (user_skills / "public").is_dir() or (user_skills / "custom").is_dir()
        ):
            return user_skills

    # 3) Default user install dir (production fallback).
    user_skills = (Path.home() / ".evoflow" / "skills").resolve()
    if user_skills.is_dir() and ((user_skills / "public").is_dir() or (user_skills / "custom").is_dir()):
        return user_skills

    # 4) Frozen executable layout (PyInstaller onedir) — before first user sync.
    if getattr(sys, "frozen", False):
        exe_dir = Path(sys.executable).resolve().parent
        for candidate in (exe_dir / "skills", exe_dir.parent / "skills"):
            if candidate.exists():
                return candidate.resolve()

    # 5) Monorepo checkout (dev fallback when gateway bootstrap has not run yet).
    src_skills = _skills_root_from_source_tree()
    if src_skills is not None:
        return src_skills

    # 6) Working-directory-relative fallback (local dev).
    cwd_skills = (Path.cwd() / "skills").resolve()
    if cwd_skills.exists():
        return cwd_skills

    # 7) Last resort: same parent walk as (4) even if directory missing (caller may create / error).
    backend_dir = Path(__file__).resolve().parent.parent.parent.parent.parent
    return (backend_dir.parent / "skills").resolve()


def _count_custom_skills(skills_root: Path) -> int:
    """Count ``custom/<dir>/SKILL.md`` entries under one skills root (best-effort)."""
    return len(_list_custom_skill_names(skills_root))


def _list_custom_skill_names(skills_root: Path) -> set[str]:
    """Directory names under ``custom/`` that contain ``SKILL.md``."""
    custom = skills_root / "custom"
    if not custom.is_dir():
        return set()
    try:
        return {
            d.name
            for d in custom.iterdir()
            if d.is_dir() and (d / "SKILL.md").is_file()
        }
    except OSError:
        return set()


def _candidate_profile_roots() -> list[Path]:
    """``~/.evoflow{,-dev}/profiles/<id>/skills`` for every existing profile."""
    home = Path.home()
    out: list[Path] = []
    for base in (home / ".evoflow", home / ".evoflow-dev"):
        profiles = base / "profiles"
        if not profiles.is_dir():
            continue
        try:
            for profile in sorted(profiles.iterdir()):
                if profile.is_dir():
                    out.append(profile / "skills")
        except OSError:
            continue
    return out


def describe_skills_root_context() -> dict[str, Any]:
    """Describe which skills root is active and which other candidate roots exist.

    背景：面板拉起的 gateway 经 ``EVOFLOW_HOME`` → ``bootstrap_user_skills_path``
    把 ``EVOFLOW_SKILLS_PATH`` 指向 ``~/.evoflow[-dev]/profiles/<id>/skills``，而
    裸跑 CLI 在无环境变量时回退 ``~/.evoflow/skills``。两个根不同时，「把技能复制
    到另一个 skills/custom」表现为装了但不生效。此处枚举机器上真实存在的候选根，
    供 ``evoflow doctor`` 与 ``skills list`` 直接给出可行动的告警。
    """
    active = get_skills_root_path()
    env_skills = os.getenv("EVOFLOW_SKILLS_PATH", "").strip()
    evoflow_home = os.getenv("EVOFLOW_HOME", "").strip()
    home = Path.home()

    try:
        active_resolved = active.resolve()
    except OSError:
        active_resolved = active

    candidates: dict[str, dict[str, Any]] = {}

    def _add(path: Path, source: str) -> None:
        try:
            resolved = path.expanduser().resolve()
        except OSError:
            resolved = path
        key = str(resolved)
        if key in candidates:
            candidates[key]["sources"].append(source)
            return
        candidates[key] = {
            "path": key,
            "sources": [source],
            "exists": resolved.is_dir(),
            "custom_skills": _count_custom_skills(resolved),
            "custom_names": sorted(_list_custom_skill_names(resolved)),
            "active": resolved == active_resolved,
        }

    if env_skills:
        _add(Path(env_skills), "EVOFLOW_SKILLS_PATH")
    if evoflow_home:
        _add(Path(evoflow_home) / "skills", "EVOFLOW_HOME/skills")
    _add(home / ".evoflow" / "skills", "默认 ~/.evoflow/skills（CLI 裸跑回退）")
    _add(home / ".evoflow-dev" / "skills", "~/.evoflow-dev/skills（debug 构建 / 开发隔离）")
    for profile_root in _candidate_profile_roots():
        _add(profile_root, "profiles/<id>/skills（面板 profile）")
    src_skills = _skills_root_from_source_tree()
    if src_skills is not None:
        _add(src_skills, "仓库 checkout skills/")

    if env_skills:
        source = "EVOFLOW_SKILLS_PATH"
    elif evoflow_home:
        source = "EVOFLOW_HOME"
    else:
        source = (
            "默认回退 ~/.evoflow/skills（未设置 EVOFLOW_SKILLS_PATH / EVOFLOW_HOME；"
            "面板拉起的 gateway 走 profiles/<id>/skills，两者可能不是同一目录）"
        )

    active_custom = _list_custom_skill_names(active_resolved)
    warnings: list[str] = []
    for cand in candidates.values():
        if cand["active"] or not cand["exists"] or not cand["custom_skills"]:
            continue
        orphan_names = set(cand.get("custom_names") or []) - active_custom
        # Already mirrored into the active root → no user action needed; keep count for doctor.
        cand["orphan_only_custom"] = len(orphan_names)
        cand["orphan_only_names"] = sorted(orphan_names)
        if not orphan_names:
            continue
        warnings.append(
            f"发现非生效技能根 {cand['path']}（{'/'.join(cand['sources'])}）有 "
            f"{len(orphan_names)} 个 custom 技能未出现在生效根 {active_resolved}；"
            "这些技能不会被加载。请用 skills.import_orphans（confirm=true）复制进生效根，"
            "或把安装目标改到面板当前的 skills_root（勿装到裸 ~/.evoflow/skills）"
        )

    return {
        "active": str(active_resolved),
        "active_source": source,
        "candidates": list(candidates.values()),
        "warnings": warnings,
    }


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


def enabled_plugin_skill_names(plugin_names: tuple[str, ...] | frozenset[str] | None = None) -> set[str]:
    """Names of skills contributed by installed + enabled plugins.

    Mirrors the ``from_plugin`` classification in :func:`load_skills`: the
    plugin enable switch is the sole authority for these skills, so they
    bypass the per-agent ``skills`` allowlist and are always offered in
    ``<available_skills>`` (ZCode parity — bundled browser-use /
    computer-use skills stay discoverable without per-agent opt-in).

    ``plugin_names`` restricts the auto-include to plugins' short names
    (the part before ``@`` in the plugin id); None keeps every enabled
    plugin's skills.
    """
    try:
        from evoflow.plugins.runtime import enabled_plugin_roots

        pairs = enabled_plugin_roots()
        if plugin_names:
            wanted = {str(n).strip().lower() for n in plugin_names}
            pairs = [
                (pid, root)
                for pid, root in pairs
                if str(pid).split("@", 1)[0].strip().lower() in wanted
            ]
        # Skill.source_root points at the plugin's ``skills/`` subdir (same
        # convention as plugin_skill_roots), not the plugin root itself.
        plugin_roots = {str((root / "skills").resolve()) for _pid, root in pairs}
    except Exception:
        return set()
    if not plugin_roots:
        return set()
    return {
        s.name
        for s in load_skills(enabled_only=True)
        if s.source_root is not None and str(Path(s.source_root).resolve()) in plugin_roots
    }


def load_skills(
    skills_path: Path | None = None,
    use_config: bool = True,
    enabled_only: bool = False,
    *,
    workspace_root: str | None = None,
    scope_skill_roots: list | None = None,
    extra_roots: list[Path] | None = None,
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
        extra_roots: Optional override for ``skills.extra_roots``; when None the configured
                     extra discovery roots are read from config (``use_config`` only).

    Returns:
        List of Skill objects, sorted by name
    """
    global _skills_cache
    import time as _time

    cfg_extra_roots: list[Path] = []
    if use_config:
        try:
            from evoflow.config import get_app_config

            config = get_app_config()
            if skills_path is None:
                skills_path = config.skills.get_skills_path()
            cfg_extra_roots = config.skills.get_extra_root_paths()
        except Exception:
            # Fallback to default if config fails
            if skills_path is None:
                skills_path = get_skills_root_path()
    elif skills_path is None:
        skills_path = get_skills_root_path()

    if extra_roots is None:
        extra_roots = cfg_extra_roots

    # Plugin contributed skills (ZCode parity): enabled plugins' skills/ roots
    # join discovery so their skills flow through the same directory / $mention /
    # skill:<name> URI machinery. Merge happens before the cache key is built,
    # so installing/uninstalling a plugin invalidates the scan cache.
    try:
        from evoflow.plugins.runtime import plugin_skill_roots

        plugin_roots = plugin_skill_roots()
        if plugin_roots:
            extra_roots = [*(extra_roots or []), *plugin_roots]
    except Exception:
        logger.debug("Plugin skill roots unavailable", exc_info=True)

    # In-place (bound) registrations: absolute dirs from evoflow_skills, not under custom/.
    try:
        from evoflow.skills.bound import list_bound_skill_dirs

        bound_roots = list_bound_skill_dirs()
        if bound_roots:
            extra_roots = [*(extra_roots or []), *bound_roots]
    except Exception:
        logger.debug("Bound skill roots unavailable", exc_info=True)

    if not skills_path.exists() and not scope_skill_roots and not extra_roots:
        return []

    use_simple_cache = not scope_skill_roots

    # Plugin enable/disable toggles don't touch skill files, so the mtime cache
    # can't see them; invalidate on installed-plugins state signature change.
    try:
        from evoflow.plugins.runtime import plugin_state_signature

        global _plugin_state_sig
        sig = plugin_state_signature()
        if sig != _plugin_state_sig:
            if _plugin_state_sig is not None:
                logger.info("Plugin enablement changed, invalidating skills cache")
            _plugin_state_sig = sig
            _skills_cache = None
            _scoped_skills_cache.clear()
    except Exception:
        pass

    # 带作用域根的请求：按 roots 签名走带键缓存（否则每次全量解析 335 项）。
    scoped_cache_key: str | None = None
    if not use_simple_cache:
        if workspace_root is None:
            try:
                from evoflow.tools.host_direct.workspace_context import resolve_tool_workspace_root

                ws, _ = resolve_tool_workspace_root(runtime=None)
                workspace_root = ws
            except Exception:
                workspace_root = None
        try:
            key_parts = [str(Path(skills_path).resolve())]
            key_parts += sorted(f"{p}@{s}" for p, s in (scope_skill_roots or []))
            key_parts += sorted(str(Path(p).resolve()) for p in (extra_roots or []))
            scoped_cache_key = "|".join(key_parts)
        except Exception:
            scoped_cache_key = None

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
            current_mtime_map = _build_mtime_map(skills_path, extra_roots)
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
    if not use_simple_cache and scoped_cache_key:
        cached = _scoped_skills_cache.get(scoped_cache_key)
        if cached is not None:
            cached_mtime_map, cached_skills, cached_at = cached
            age = _time.monotonic() - float(cached_at)
            current_mtime_map = None
            if age >= _skills_cache_ttl:
                try:
                    current_mtime_map = _build_mtime_map(skills_path, extra_roots, scope_skill_roots)
                except Exception:
                    current_mtime_map = None
            if age < _skills_cache_ttl or (current_mtime_map is not None and current_mtime_map == cached_mtime_map):
                _scoped_skills_cache[scoped_cache_key] = (cached_mtime_map, cached_skills, _time.monotonic())
                skills = list(cached_skills)
                if enabled_only:
                    skills = [s for s in skills if s.enabled]
                return skills
            if current_mtime_map is not None:
                logger.info("Scoped skills changed on disk, reloading (key=%s...)", scoped_cache_key[:60])

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
            extra_roots=extra_roots,
        )
        skills = index.skills
    except Exception:
        logger.warning("SkillIndex.load failed; falling back to legacy scan", exc_info=True)
        skills = _legacy_scan_skills(skills_path) if skills_path.exists() else []

    try:
        from evoflow.skills.bound import merge_bound_skills

        skills = merge_bound_skills(skills)
    except Exception:
        logger.debug("merge_bound_skills failed", exc_info=True)

    try:
        from evoflow.persistence import config_repositories as cfg_repo
        from evoflow.persistence.bootstrap import sync_skills_from_filesystem

        sync_skills_from_filesystem()
        registry = cfg_repo.list_skill_registry()
        plugin_root_strings: set[str] = set()
        try:
            from evoflow.plugins.runtime import plugin_skill_roots

            plugin_root_strings = {str(p.resolve()) for p in plugin_skill_roots()}
        except Exception:
            plugin_root_strings = set()
        for skill in skills:
            from_plugin = (
                bool(plugin_root_strings)
                and skill.source_root is not None
                and str(Path(skill.source_root).resolve()) in plugin_root_strings
            )
            if from_plugin:
                # Plugin-contributed skills: installing + enabling the plugin
                # (plugin store semantics) is the enablement authority. A stale
                # registry row for a same-named skill from another root (e.g. a
                # removed custom skill) must not disable the plugin instance —
                # otherwise ``skill:<name>`` URIs fail with "exists but is
                # disabled" while the plugin is switched on.
                skill.enabled = True
            elif (reg := registry.get(skill.name)) is not None:
                skill.enabled = bool(reg.get("enabled", True))
            else:
                from evoflow.config.extensions_config import ExtensionsConfig

                skill.enabled = ExtensionsConfig.from_db().is_skill_enabled(skill.name, skill.category)
    except Exception as e:
        logger.warning("Failed to load skill enablement from SQLite: %s", e)

    # ── Cross-scope shadowing (after enablement) ──────────────────────
    # SkillIndex only dedupes within the same scope, so same-named instances
    # from different scopes (user custom vs plugin vs system) all arrive here.
    # Resolve each name to ONE instance: the highest-precedence *enabled* one
    # (user-defined > plugin > system). A disabled user instance must not
    # permanently hide an enabled plugin instance; when every instance is
    # disabled, keep the highest-precedence one so existence/errors stay
    # accurate. Plugin-sourced instances are gated by the plugin switch itself
    # (see enablement above), not by same-named registry rows.
    skills = _resolve_scope_shadowing(skills)

    # Sort by name for consistent ordering (cache stores the full list).
    skills.sort(key=lambda s: s.name)

    # ── Update cache ──────────────────────────────────────────────────
    if use_simple_cache:
        try:
            mtime_map = _build_mtime_map(skills_path, extra_roots)
            _skills_cache = (mtime_map, list(skills), _time.monotonic())
        except Exception:
            pass
    elif scoped_cache_key:
        try:
            mtime_map = _build_mtime_map(skills_path, extra_roots, scope_skill_roots)
            _scoped_skills_cache[scoped_cache_key] = (mtime_map, list(skills), _time.monotonic())
        except Exception:
            pass

    if enabled_only:
        return [skill for skill in skills if skill.enabled]
    return skills


def _resolve_scope_shadowing(skills: list[Skill]) -> list[Skill]:
    """Collapse same-named instances across scopes to one survivor per name.

    Precedence (highest first): user-defined scopes (personal/custom/...) >
    plugin (EXTERNAL) > system (public/system). Within that order an *enabled*
    instance always beats a disabled one, so a disabled user skill falls
    through to an enabled plugin instance instead of dead-ending the name.
    """
    if not skills:
        return skills
    if len(skills) == 1:
        return skills

    def rank(s: Skill) -> tuple[int, int, int, str]:
        scope_val = int(getattr(s, "scope", SkillScope.PUBLIC))
        enabled_rank = 0 if s.enabled else 1
        depth = len(s.skill_dir.parts)
        path = str(s.skill_dir.resolve()).replace("\\", "/")
        return (enabled_rank, -scope_val, depth, path)

    buckets: dict[str, list[Skill]] = {}
    for skill in skills:
        buckets.setdefault(skill.name, []).append(skill)

    if all(len(group) == 1 for group in buckets.values()):
        return skills

    out: list[Skill] = []
    for _name, group in buckets.items():
        if len(group) == 1:
            out.append(group[0])
            continue
        chosen = sorted(group, key=rank)[0]
        dropped = [g.skill_dir for g in group if g is not chosen]
        if dropped:
            logger.debug(
                "Scope shadowing %r: kept %s (enabled=%s) dropped %s",
                chosen.name,
                chosen.skill_dir,
                chosen.enabled,
                dropped,
            )
        out.append(chosen)
    return out


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

    # Same-named skills can exist in multiple roots (e.g. a stale custom skill
    # plus an enabled plugin skill). Prefer an enabled instance; only fall back
    # to a disabled one when ``require_enabled`` is False (existence checks).
    all_skills = load_skills(enabled_only=False, use_config=True)
    fallback_dir: Path | None = None
    for skill in all_skills:
        if skill.name.strip().lower() != key:
            continue
        if skill.enabled:
            return skill.skill_dir
        if fallback_dir is None:
            fallback_dir = skill.skill_dir
    if fallback_dir is not None and not require_enabled:
        return fallback_dir

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
