"""Bootstrap EvoFlow imports for media-production skill scripts."""

from __future__ import annotations

import os
import sys
from pathlib import Path


def _insert_path(path: Path) -> None:
    s = str(path.resolve())
    if path.is_dir() and s not in sys.path:
        sys.path.insert(0, s)


def _repo_root_from_script() -> Path | None:
    here = Path(__file__).resolve()
    # skills/public/media-production/scripts -> repo root is 4 levels up from media-production
    candidate = here.parents[4]
    if (candidate / "backend" / "packages" / "harness").is_dir():
        return candidate
    return None


def ensure_evoflow_importable() -> None:
    try:
        import evoflow  # noqa: F401
    except ImportError:
        repo = _repo_root_from_script()
        if repo is not None:
            _insert_path(repo / "backend" / "packages" / "harness")
            _insert_path(repo / "backend")
        home = os.getenv("EVOFLOW_HOME", "").strip()
        if home:
            p = Path(home).expanduser()
            for sub in ("backend/packages/harness", "backend", "packages/harness"):
                cand = p / sub
                if cand.is_dir():
                    _insert_path(cand)
        try:
            import evoflow  # noqa: F401
        except ImportError as e:
            raise SystemExit(
                "Cannot import evoflow. Run from EvoFlow workspace with PYTHONPATH including "
                "backend/packages/harness, or set EVOFLOW_HOME."
            ) from e

    from evoflow.persistence.runtime_env import apply_runtime_env_to_environ

    apply_runtime_env_to_environ()


def skill_scripts_dir() -> Path:
    return Path(__file__).resolve().parent
