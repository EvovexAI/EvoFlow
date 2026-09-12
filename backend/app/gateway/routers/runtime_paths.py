"""Gateway router for runtime path diagnostics and config updates.

This exists primarily for local development and EvoPanel integration:
- Make it easy to verify which data directory is currently effective.
- Allow updating ``paths.base_dir`` via SQLite ``evoflow_app_settings`` from the UI.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter(prefix="/api/runtime/paths", tags=["runtime"])


class RuntimePathsResponse(BaseModel):
    cwd: str
    evoflow_home_env: str
    evoflow_config_path_env: str
    config_path_resolved: str
    base_dir: str
    checkpointer_type: str | None = None
    checkpointer_connection_string: str | None = None
    checkpointer_sqlite_path: str | None = None


class UpdatePathsRequest(BaseModel):
    base_dir: str = Field(..., description="Absolute path for EvoFlow base_dir (data root)")


@router.get("", response_model=RuntimePathsResponse)
def get_runtime_paths() -> RuntimePathsResponse:
    from evoflow.config.app_config import AppConfig, get_app_config
    from evoflow.config.paths import get_paths, resolve_path

    cfg = get_app_config()
    p = get_paths()

    cp_type = None
    cp_conn = None
    cp_sqlite = None
    if getattr(cfg, "checkpointer", None) is not None:
        cp_type = getattr(cfg.checkpointer, "type", None)
        cp_conn = getattr(cfg.checkpointer, "connection_string", None)
        if cp_type == "sqlite":
            raw = (cp_conn or "store.db").strip()
            if raw == ":memory:" or raw.startswith("file:"):
                cp_sqlite = raw
            else:
                cp_sqlite = str(resolve_path(raw))

    env_home = (os.getenv("EVOFLOW_HOME") or "").strip()
    env_cfg = (os.getenv("EVOFLOW_CONFIG_PATH") or "").strip()

    try:
        config_path_resolved = str(AppConfig.resolve_config_path(env_cfg or None))
    except Exception:
        config_path_resolved = ""

    return RuntimePathsResponse(
        cwd=str(Path.cwd()),
        evoflow_home_env=env_home,
        evoflow_config_path_env=env_cfg,
        config_path_resolved=config_path_resolved,
        base_dir=str(p.base_dir),
        checkpointer_type=cp_type,
        checkpointer_connection_string=cp_conn,
        checkpointer_sqlite_path=cp_sqlite,
    )


@router.put("", response_model=dict[str, Any])
def update_paths(body: UpdatePathsRequest) -> dict[str, Any]:
    """Persist paths.base_dir to SQLite and reload config in-process."""
    from evoflow.config.app_config import reload_app_config, update_paths_section_and_save

    base = body.base_dir.strip()
    if not base:
        raise HTTPException(status_code=400, detail="base_dir 不能为空")

    update_paths_section_and_save({"base_dir": base})
    reload_app_config()
    return {"ok": True, "base_dir": base}
