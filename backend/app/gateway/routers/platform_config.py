"""CRUD for platform configuration stored in ``evoflow.db`` (models, tools, channels, skills, MCP)."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import Request, APIRouter, Body, HTTPException
from evoflow.authz.http_guard import require_org_admin
from pydantic import BaseModel, Field

from evoflow.config.app_config import get_app_config, reload_app_config
from evoflow.config.extensions_config import reload_extensions_config
from evoflow.persistence import config_repositories as cfg_repo
from evoflow.persistence.db import get_db, resolve_evolflow_db_path

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/config", tags=["config"])


def _reload_runtime_caches() -> None:
    from evoflow.config.paths import reset_paths_cache

    reset_paths_cache()
    reload_app_config()
    reload_extensions_config()


@router.get("/storage")
async def get_storage_info(request: Request) -> dict[str, Any]:
    require_org_admin(request)
    cfg = get_app_config()
    storage = getattr(cfg, "storage", None)
    return {
        "backend": getattr(storage, "backend", "sqlite") if storage else "sqlite",
        "sqlite_path": str(resolve_evolflow_db_path()),
        "checkpointer": (cfg.checkpointer.model_dump() if cfg.checkpointer else None),
    }


@router.post("/reload")
async def reload_config_caches(request: Request) -> dict[str, str]:
    require_org_admin(request)
    _reload_runtime_caches()
    return {"success": True, "message": "Reloaded AppConfig and ExtensionsConfig from SQLite"}


# --- Models ---


@router.get("/models")
async def list_config_models(request: Request) -> dict[str, Any]:
    require_org_admin(request)
    get_db()
    return {"models": cfg_repo.list_models()}


@router.get("/models/{name}")
async def get_config_model(request: Request, name: str) -> dict[str, Any]:
    require_org_admin(request)
    doc = cfg_repo.get_model(name.strip())
    if doc is None:
        raise HTTPException(status_code=404, detail=f"Model {name!r} not found")
    return doc


@router.put("/models/{name}")
async def put_config_model(request: Request, name: str, body: dict[str, Any] = Body(default_factory=dict)) -> dict[str, Any]:
    require_org_admin(request)
    doc = {**body, "name": name.strip()}
    cfg_repo.upsert_model(doc)
    _reload_runtime_caches()
    return {"success": True, "model": doc}


@router.delete("/models/{name}")
async def delete_config_model(request: Request, name: str) -> dict[str, Any]:
    require_org_admin(request)
    if not cfg_repo.delete_model(name.strip()):
        raise HTTPException(status_code=404, detail=f"Model {name!r} not found")
    _reload_runtime_caches()
    return {"success": True}


# --- Tools ---


@router.get("/tools")
async def list_config_tools(request: Request) -> dict[str, Any]:
    require_org_admin(request)
    get_db()
    return {"tools": cfg_repo.list_tools()}


@router.put("/tools/{name}")
async def put_config_tool(request: Request, name: str, body: dict[str, Any] = Body(default_factory=dict)) -> dict[str, Any]:
    require_org_admin(request)
    doc = {**body, "name": name.strip()}
    cfg_repo.upsert_tool(doc)
    _reload_runtime_caches()
    return {"success": True, "tool": doc}


@router.delete("/tools/{name}")
async def delete_config_tool(request: Request, name: str) -> dict[str, Any]:
    require_org_admin(request)
    if not cfg_repo.delete_tool(name.strip()):
        raise HTTPException(status_code=404, detail=f"Tool {name!r} not found")
    _reload_runtime_caches()
    return {"success": True}


# --- Tool groups ---


@router.get("/tool-groups")
async def list_config_tool_groups(request: Request) -> dict[str, Any]:
    require_org_admin(request)
    return {"tool_groups": cfg_repo.list_tool_groups()}


@router.put("/tool-groups/{name}")
async def put_config_tool_group(request: Request, name: str, body: dict[str, Any] = Body(default_factory=dict)) -> dict[str, Any]:
    require_org_admin(request)
    doc = {**body, "name": name.strip()}
    cfg_repo.upsert_tool_group(doc)
    _reload_runtime_caches()
    return {"success": True, "tool_group": doc}


@router.delete("/tool-groups/{name}")
async def delete_config_tool_group(request: Request, name: str) -> dict[str, Any]:
    require_org_admin(request)
    if not cfg_repo.delete_tool_group(name.strip()):
        raise HTTPException(status_code=404, detail=f"Tool group {name!r} not found")
    _reload_runtime_caches()
    return {"success": True}


# --- Channels (feishu, weixin, …) ---


@router.get("/channels")
async def list_config_channels(request: Request) -> dict[str, Any]:
    require_org_admin(request)
    return {"channels": cfg_repo.get_all_channel_configs()}


@router.get("/channels/{platform}")
async def get_config_channel(request: Request, platform: str) -> dict[str, Any]:
    require_org_admin(request)
    ch = cfg_repo.get_all_channel_configs().get(platform.strip())
    if ch is None:
        raise HTTPException(status_code=404, detail=f"Channel platform {platform!r} not found")
    return {"platform": platform.strip(), "config": ch}


class ChannelUpdateBody(BaseModel):
    config: dict[str, Any] = Field(default_factory=dict)
    merge: bool = Field(default=True, description="Merge into existing config when true")


@router.put("/channels/{platform}")
async def put_config_channel(request: Request, platform: str, body: ChannelUpdateBody) -> dict[str, Any]:
    require_org_admin(request)
    plat = platform.strip()
    existing = cfg_repo.get_all_channel_configs().get(plat) or {}
    doc = {**existing, **body.config} if body.merge else dict(body.config)
    cfg_repo.upsert_channel_config(plat, doc)
    _reload_runtime_caches()
    return {"success": True, "platform": plat, "config": doc}


@router.delete("/channels/{platform}")
async def delete_config_channel(request: Request, platform: str) -> dict[str, Any]:
    require_org_admin(request)
    plat = platform.strip()
    all_ch = cfg_repo.get_all_channel_configs()
    if plat not in all_ch:
        raise HTTPException(status_code=404, detail=f"Channel platform {plat!r} not found")
    cfg_repo.replace_channel_configs({k: v for k, v in all_ch.items() if k != plat})
    _reload_runtime_caches()
    return {"success": True}


# --- Skills registry ---


@router.get("/skills")
async def list_config_skills(request: Request) -> dict[str, Any]:
    require_org_admin(request)
    return {"skills": cfg_repo.list_skill_registry()}


class SkillEnableBody(BaseModel):
    enabled: bool = True


@router.put("/skills/{name}")
async def put_config_skill(request: Request, name: str, body: SkillEnableBody) -> dict[str, Any]:
    require_org_admin(request)
    reg = cfg_repo.get_skill_registry(name.strip()) or {}
    cfg_repo.upsert_skill_registry(
        name.strip(),
        enabled=body.enabled,
        skill_md=reg.get("skill_md"),
        source_path=reg.get("source_path"),
        category=reg.get("category"),
        meta=reg.get("meta") if isinstance(reg.get("meta"), dict) else {},
    )
    reload_extensions_config()
    return {"success": True, "name": name.strip(), "enabled": body.enabled}


# --- MCP ---


@router.get("/mcp-servers")
async def list_config_mcp(request: Request) -> dict[str, Any]:
    require_org_admin(request)
    return {"mcp_servers": cfg_repo.list_mcp_servers()}


@router.put("/mcp-servers/{name}")
async def put_config_mcp(request: Request, name: str, body: dict[str, Any] = Body(default_factory=dict)) -> dict[str, Any]:
    require_org_admin(request)
    cfg_repo.upsert_mcp_server(name.strip(), body)
    _reload_runtime_caches()
    return {"success": True, "name": name.strip()}


@router.delete("/mcp-servers/{name}")
async def delete_config_mcp(request: Request, name: str) -> dict[str, Any]:
    require_org_admin(request)
    if not cfg_repo.delete_mcp_server(name.strip()):
        raise HTTPException(status_code=404, detail=f"MCP server {name!r} not found")
    _reload_runtime_caches()
    return {"success": True}


# --- App settings (primary_model, feishu learned chat_id, …) ---


@router.get("/app-settings")
async def list_config_app_settings(request: Request) -> dict[str, Any]:
    require_org_admin(request)
    return {"settings": cfg_repo.list_app_settings()}


@router.put("/app-settings/{key}")
async def put_config_app_setting(request: Request, key: str, body: Any = Body(...)) -> dict[str, Any]:
    require_org_admin(request)
    setting_key = key.strip()
    cfg_repo.set_app_setting(setting_key, body)
    if setting_key in ("primary_model", "tools_mode", "channels.global") or setting_key.startswith("runtime."):
        _reload_runtime_caches()
    return {"success": True, "key": setting_key}


@router.get("/primary-model")
async def get_primary_model(request: Request) -> dict[str, Any]:
    require_org_admin(request)
    pm = cfg_repo.get_app_setting("primary_model")
    if pm is None:
        pm = get_app_config().primary_model
    return {"primary_model": pm}


@router.put("/primary-model")
async def put_primary_model(request: Request, body: dict[str, Any] = Body(...)) -> dict[str, Any]:
    require_org_admin(request)
    name = body.get("primary_model") if isinstance(body, dict) else body
    if not str(name or "").strip():
        raise HTTPException(status_code=400, detail="primary_model required")
    cfg_repo.set_app_setting("primary_model", str(name).strip())
    _reload_runtime_caches()
    return {"success": True, "primary_model": str(name).strip()}
