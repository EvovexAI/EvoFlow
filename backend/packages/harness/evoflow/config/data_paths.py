"""Canonical paths under ``{base_dir}/data/`` — one subdirectory per SQLite database."""

from __future__ import annotations

import os
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
        return (Path.home() / ".evoflow").resolve()


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
