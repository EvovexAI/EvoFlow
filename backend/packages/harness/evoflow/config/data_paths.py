"""Canonical paths under ``{base_dir}/data/`` — one subdirectory per SQLite database.

Development Environment:
    Set EVOFLOW_HOME environment variable to use a separate data directory
    for development (e.g., ~/.evoflow-dev while production uses ~/.evoflow).

    This is useful for developers who want to keep production data separate
    from development experiments and testing.

    See :func:`evoflow.config.paths.Paths` for full documentation.

Desktop vs CLI:
    The installed panel always sets ``EVOFLOW_HOME`` to
    ``~/.evoflow/profiles/<id>`` (or a workspace ``data/profiles/<id>``).
    Bare CLI with no env used to fall back to ``~/.evoflow`` itself — a
    different SQLite DB — so panel settings (e.g. MiniMax media keys) looked
    "configured but not working". When ``EVOFLOW_HOME`` is unset we now
    auto-resolve the active profile directory when ``profiles/`` exists.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

# Relative config defaults (resolved under base_dir).
DEFAULT_APP_DB_REL = "data/app/evoflow.db"
DEFAULT_OBS_DB_REL = "data/observability/evoflow_observability.db"
DEFAULT_CHECKPOINTS_DB_REL = "data/checkpoints/checkpoints.db"
DEFAULT_LOGS_REL = "data/logs"

# Legacy flat filenames at base_dir root (pre-layout).
LEGACY_APP_DB = "evoflow.db"
LEGACY_OBS_DB = "evoflow_observability.db"
LEGACY_CHECKPOINTS_DB = "checkpoints.db"

_SAFE_PROFILE_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")


def is_safe_profile_id(profile_id: str) -> bool:
    return bool(_SAFE_PROFILE_ID_RE.match(str(profile_id or "").strip()))


def shared_evoflow_roots() -> list[Path]:
    """Candidate install-wide roots (not per-profile).

    Prefer ``~/.evoflow`` (installed panel). ``~/.evoflow-dev`` is only used when
    ``~/.evoflow`` is absent — set ``EVOFLOW_HOME`` explicitly for day-to-day dev.
    """
    home = Path.home()
    roots: list[Path] = []
    for name in (".evoflow", ".evoflow-dev"):
        p = (home / name).resolve()
        if p.is_dir() and p not in roots:
            roots.append(p)
    return roots


def resolve_active_profile_id(shared_home: Path) -> str:
    """Match desktop profile selection when ``EVOFLOW_HOME`` is unset.

    Order: ``EVOFLOW_PROFILE`` → ``{shared}/current-profile`` → sole profile dir
    → ``default`` if present → ``default``.
    """
    env = (os.getenv("EVOFLOW_PROFILE") or "").strip()
    if env and is_safe_profile_id(env):
        return env
    persisted = shared_home / "current-profile"
    try:
        if persisted.is_file():
            raw = persisted.read_text(encoding="utf-8").strip()
            if raw and is_safe_profile_id(raw):
                return raw
    except OSError:
        pass
    profiles = shared_home / "profiles"
    if profiles.is_dir():
        try:
            names = sorted(
                p.name
                for p in profiles.iterdir()
                if p.is_dir() and is_safe_profile_id(p.name) and not p.name.startswith(".")
            )
        except OSError:
            names = []
        if len(names) == 1:
            return names[0]
        if "default" in names:
            return "default"
    return "default"


def resolve_profile_home(shared_home: Path | None = None) -> Path | None:
    """Return ``{shared}/profiles/<active>`` when the desktop profile layout exists."""
    if shared_home is None:
        roots = shared_evoflow_roots()
        shared_home = roots[0] if roots else (Path.home() / ".evoflow")
    root = Path(shared_home).resolve()
    profiles_root = root / "profiles"
    if not profiles_root.is_dir():
        return None
    pid = resolve_active_profile_id(root)
    candidate = profiles_root / pid
    if candidate.is_dir():
        return candidate.resolve()
    return None


def prefer_profile_base_dir(shared_home: Path) -> Path:
    """Prefer active profile dir over the shared install root (CLI/panel parity)."""
    profile = resolve_profile_home(shared_home)
    return profile if profile is not None else Path(shared_home).resolve()


def data_root(base_dir: Path) -> Path:
    return base_dir / "data"


def app_db_dir(base_dir: Path) -> Path:
    return data_root(base_dir) / "app"


def observability_db_dir(base_dir: Path) -> Path:
    return data_root(base_dir) / "observability"


def checkpoints_db_dir(base_dir: Path) -> Path:
    return data_root(base_dir) / "checkpoints"


def app_db_path(base_dir: Path) -> Path:
    return app_db_dir(base_dir) / "evoflow.db"


def observability_db_path(base_dir: Path) -> Path:
    return observability_db_dir(base_dir) / "evoflow_observability.db"


def checkpoints_db_path(base_dir: Path) -> Path:
    return checkpoints_db_dir(base_dir) / "checkpoints.db"


def logs_dir(base_dir: Path) -> Path:
    return data_root(base_dir) / "logs"


def resolve_data_base_dir() -> Path:
    if os.getenv("EVOFLOW_HOME"):
        return normalize_evoflow_base_dir(Path(os.getenv("EVOFLOW_HOME")).resolve())
    try:
        from evoflow.config.paths import get_paths

        return get_paths().base_dir
    except Exception:
        shared = Path.home() / ".evoflow"
        return prefer_profile_base_dir(shared)


def normalize_evoflow_base_dir(home: Path) -> Path:
    """Map ``EVOFLOW_HOME`` env to canonical ``base_dir`` (parent of ``data/``).

    Desktop sets ``EVOFLOW_HOME`` to ``<userWorkspaceRoot>/data``.
    Legacy installs used ``<userWorkspaceRoot>/workspace/data``.
    """
    p = home.resolve()
    if p.name.lower() == "data":
        if p.parent.name.lower() == "workspace":
            return p.parent.parent
        return p.parent
    return p


def resolve_data_root() -> Path:
    """Directory that directly contains ``app/``, ``logs/``, etc."""
    if os.getenv("EVOFLOW_HOME"):
        return data_root(normalize_evoflow_base_dir(Path(os.getenv("EVOFLOW_HOME")).resolve()))
    return data_root(resolve_data_base_dir())


def _normalize_rel(raw: str, base_dir: Path) -> Path:
    p = Path(str(raw or "").strip())
    if not str(p).strip():
        return base_dir
    if p.is_absolute():
        return p.resolve()
    return (base_dir / p).resolve()


def is_legacy_flat_app_path(path: Path, base_dir: Path) -> bool:
    return path.resolve() == (base_dir / LEGACY_APP_DB).resolve()


def is_legacy_flat_obs_path(path: Path, base_dir: Path) -> bool:
    return path.resolve() == (base_dir / LEGACY_OBS_DB).resolve()


def is_legacy_flat_checkpoints_path(path: Path, base_dir: Path) -> bool:
    return path.resolve() == (base_dir / LEGACY_CHECKPOINTS_DB).resolve()


def resolve_app_db_config_path(raw: str | None, *, base_dir: Path | None = None) -> Path:
    """Map storage ``sqlite_path`` to canonical ``data/app/evoflow.db`` when using legacy names."""
    base = base_dir or resolve_data_base_dir()
    name = str(raw or "").strip() or LEGACY_APP_DB
    resolved = _normalize_rel(name, base)
    canonical = app_db_path(base)
    if is_legacy_flat_app_path(resolved, base) or name in (LEGACY_APP_DB, DEFAULT_APP_DB_REL):
        if canonical.exists() or not resolved.exists():
            return canonical
    return resolved


def resolve_observability_db_config_path(raw: str | None, *, base_dir: Path | None = None) -> Path:
    base = base_dir or resolve_data_base_dir()
    name = str(raw or "").strip()
    if not name:
        canonical = observability_db_path(base)
        legacy = base / LEGACY_OBS_DB
        if canonical.exists() or not legacy.exists():
            return canonical
        return legacy.resolve()
    resolved = _normalize_rel(name, base)
    canonical = observability_db_path(base)
    if is_legacy_flat_obs_path(resolved, base) or name in (LEGACY_OBS_DB, DEFAULT_OBS_DB_REL):
        if canonical.exists() or not resolved.exists():
            return canonical
    return resolved


def resolve_checkpoints_config_path(raw: str | None, *, base_dir: Path | None = None) -> Path:
    if raw == ":memory:" or (raw or "").startswith("file:"):
        return Path(str(raw))
    base = base_dir or resolve_data_base_dir()
    name = str(raw or "").strip() or LEGACY_CHECKPOINTS_DB
    resolved = _normalize_rel(name, base)
    canonical = checkpoints_db_path(base)
    if is_legacy_flat_checkpoints_path(resolved, base) or name in (
        LEGACY_CHECKPOINTS_DB,
        DEFAULT_CHECKPOINTS_DB_REL,
    ):
        if canonical.exists() or not resolved.exists():
            return canonical
    return resolved
