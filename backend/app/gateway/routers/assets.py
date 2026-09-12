"""Entity Asset Hub Gateway API."""

from __future__ import annotations

import asyncio
import logging
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from evoflow.authz.http_guard import (
    filter_asset_entities_for_request,
    require_org_admin,
    resolve_asset_entity_for_request,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/assets", tags=["assets"])


class ProfileFieldUpdate(BaseModel):
    field: str = Field(..., min_length=1, max_length=64)
    content: str = ""


class FileWriteBody(BaseModel):
    entityType: Literal["user", "agent", "employee", "workspace"]
    entityId: str = Field(..., min_length=1, max_length=128)
    path: str = Field(..., min_length=1, max_length=512)
    content: str = ""


def _entity(request: Request, entity_type: str, entity_id: str):
    try:
        return resolve_asset_entity_for_request(request, entity_type, entity_id)
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/entities")
async def get_entities(request: Request):
    from evoflow.assets.hub import list_entities

    try:
        payload = list_entities()
        entities = payload.get("entities") if isinstance(payload, dict) else payload
        filtered = filter_asset_entities_for_request(
            request, entities if isinstance(entities, list) else []
        )
        if isinstance(payload, dict):
            return {**payload, "entities": filtered}
        return {"entities": filtered}
    except Exception as exc:
        logger.error("assets list_entities failed", exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.get("/search")
async def search_assets(
    request: Request,
    entityType: Literal["user", "agent", "employee", "workspace"] = Query(...),
    entityId: str = Query(...),
    q: str = Query(..., min_length=1, description="Comma-separated or single query"),
    path: str = Query(default="", description="Optional subpath under entity root"),
    kinds: str = Query(
        default="",
        description="Comma-separated: facts,episodic,journal,craft,standing,handbook,all",
    ),
    matchMode: Literal["any", "all_on_same_line", "all_within_lines"] = Query(default="any"),
    maxResults: int = Query(default=20, ge=1, le=50),
    contextLines: int = Query(default=1, ge=0, le=5),
    includeInbox: bool = Query(default=False),
):
    """Substring search over entity Markdown (runtime local memory search)."""
    from evoflow.assets.search import search_entity_assets

    entity = _entity(request, entityType, entityId)
    try:
        queries = [p.strip() for p in q.split(",") if p.strip()] or [q.strip()]
        return search_entity_assets(
            entity,
            queries,
            path=path or None,
            kinds=kinds or None,
            match_mode=matchMode,
            context_lines=contextLines,
            max_results=maxResults,
            include_inbox=includeInbox,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.error("assets search failed", exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.get("/tree")
async def get_tree(
    request: Request,
    entityType: Literal["user", "agent", "employee", "workspace"] = Query(...),
    entityId: str = Query(...),
    path: str = Query(default=""),
):
    from evoflow.assets.hub import list_tree

    entity = _entity(request, entityType, entityId)
    try:
        return list_tree(entity, path)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.error("assets list_tree failed", exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.get("/file")
async def get_file(
    request: Request,
    entityType: Literal["user", "agent", "employee", "workspace"] = Query(...),
    entityId: str = Query(...),
    path: str = Query(...),
):
    from evoflow.assets.hub import read_text_file

    entity = _entity(request, entityType, entityId)
    try:
        return read_text_file(entity, path)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.error("assets read file failed", exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.put("/file")
async def put_file(request: Request, body: FileWriteBody):
    from evoflow.assets.hub import write_text_file

    entity = _entity(request, body.entityType, body.entityId)
    try:
        return write_text_file(entity, body.path, body.content)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.error("assets write file failed", exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.delete("/file")
async def delete_file(
    request: Request,
    entityType: Literal["user", "agent", "employee", "workspace"] = Query(...),
    entityId: str = Query(...),
    path: str = Query(...),
):
    """Delete a text asset file under the entity tree (profile core files protected)."""
    from evoflow.assets.hub import delete_text_file

    entity = _entity(request, entityType, entityId)
    try:
        return delete_text_file(entity, path)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.error("assets delete file failed", exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


class RecordFactBody(BaseModel):
    entityType: Literal["user", "agent", "employee", "workspace"] = "user"
    entityId: str = Field(default="user", min_length=1, max_length=128)
    content: str = Field(..., min_length=1)
    title: str = ""
    summary: str = ""


class EpisodeBody(BaseModel):
    entityType: Literal["user", "agent", "employee", "workspace"] = "user"
    entityId: str = Field(default="user", min_length=1, max_length=128)
    content: str = Field(..., min_length=1)
    title: str = ""
    summary: str = ""


class JournalBody(BaseModel):
    entityType: Literal["user", "agent", "employee", "workspace"] = "user"
    entityId: str = Field(default="user", min_length=1, max_length=128)
    content: str = Field(..., min_length=1)
    date: str = ""
    append: bool = True
    summary: str = ""


class CraftSaveBody(BaseModel):
    entityType: Literal["user", "agent", "employee", "workspace"] = "user"
    entityId: str = Field(default="user", min_length=1, max_length=128)
    title: str = Field(..., min_length=1, max_length=200)
    content: str = ""
    description: str = ""


@router.post("/record")
async def record_fact(request: Request, body: RecordFactBody):
    """Direct-write a short fact to ``memory/facts/*.md`` (title + summary catalog)."""
    from evoflow.assets.hub import record_fact as hub_record_fact

    entity = _entity(request, body.entityType, body.entityId)
    try:
        return hub_record_fact(
            entity,
            body.content,
            title=body.title,
            summary=body.summary,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.error("assets record failed", exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/episode")
async def write_episode(request: Request, body: EpisodeBody):
    """Record this dialogue's process → ``memory/episodic/*.md`` (for human review)."""
    from evoflow.assets.hub import write_episode as hub_write_episode

    entity = _entity(request, body.entityType, body.entityId)
    try:
        return hub_write_episode(
            entity,
            body.content,
            title=body.title,
            summary=body.summary,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.error("assets episode failed", exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/journal")
async def write_journal(request: Request, body: JournalBody):
    """Create or append ``memory/journal/{date}.md`` (with catalog ``summary``)."""
    from evoflow.assets.hub import write_journal as hub_write_journal

    entity = _entity(request, body.entityType, body.entityId)
    try:
        return hub_write_journal(
            entity,
            body.content,
            date=body.date,
            append=body.append,
            summary=body.summary,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.error("assets journal failed", exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/craft/save")
async def save_craft(request: Request, body: CraftSaveBody):
    """Direct-write ``craft/{slug}/SKILL.md`` (no experience DB)."""
    from evoflow.assets.hub import save_craft_note

    entity = _entity(request, body.entityType, body.entityId)
    try:
        return save_craft_note(
            entity,
            title=body.title,
            content=body.content,
            description=body.description,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.error("assets craft save failed", exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.get("/profile")
async def get_profile(
    request: Request,
    entityType: Literal["user", "agent", "employee", "workspace"] = Query(...),
    entityId: str = Query(...),
):
    from evoflow.assets.hub import read_profile

    entity = _entity(request, entityType, entityId)
    try:
        return read_profile(entity)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.error("assets read profile failed", exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.put("/profile")
async def put_profile_field(
    request: Request,
    entityType: Literal["user", "agent", "employee", "workspace"] = Query(...),
    entityId: str = Query(...),
    body: ProfileFieldUpdate = ...,
):
    from evoflow.assets.hub import write_profile_field

    entity = _entity(request, entityType, entityId)
    try:
        return write_profile_field(entity, body.field, body.content)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.error("assets write profile failed", exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/migrate")
async def migrate_assets(
    request: Request,
    scope: str = Query(default="all", pattern="^(all|experience|memory|slim|agent-memory)$"),
    dryRun: bool = Query(default=False),
):
    """Migrate legacy SQLite experience / mem atoms into asset files (or slim index rows)."""
    require_org_admin(request)
    from evoflow.assets.migrate import (
        migrate_all,
        migrate_experiences,
        migrate_memory_namespaces,
        migrate_slim_atoms,
    )

    try:
        if scope == "experience":
            return migrate_experiences(dry_run=dryRun)
        if scope == "memory":
            return migrate_memory_namespaces(dry_run=dryRun)
        if scope == "slim":
            return migrate_slim_atoms(dry_run=dryRun)
        if scope == "agent-memory":
            from evoflow.assets.migrate_agent_memory import migrate_agent_memory_to_user

            return migrate_agent_memory_to_user(dry_run=dryRun)
        return migrate_all(dry_run=dryRun)
    except Exception as exc:
        logger.error("assets migrate failed", exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


class PackExportBody(BaseModel):
    entityType: Literal["user", "agent", "employee", "workspace"] = "user"
    entityId: str = Field(default="user", min_length=1, max_length=128)


class PackImportBody(BaseModel):
    entityType: Literal["user", "agent", "employee", "workspace"]
    entityId: str = Field(..., min_length=1, max_length=128)
    packPath: str = Field(..., min_length=1, max_length=1024)
    conflict: Literal["skip", "rename", "overwrite"] = "skip"


@router.post("/pack/export")
async def export_pack(request: Request, body: PackExportBody):
    from evoflow.assets.pack import export_entity_pack

    entity = _entity(request, body.entityType, body.entityId)
    try:
        return export_entity_pack(entity)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        logger.error("assets pack export failed", exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/pack/import")
async def import_pack(request: Request, body: PackImportBody):
    from evoflow.assets.pack import import_entity_pack

    entity = _entity(request, body.entityType, body.entityId)
    try:
        return import_entity_pack(body.packPath, entity, conflict=body.conflict)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.error("assets pack import failed", exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


class PromoteCraftBody(BaseModel):
    entityType: Literal["user", "agent", "employee", "workspace"]
    entityId: str = Field(..., min_length=1, max_length=128)
    craftName: str = Field(..., min_length=1, max_length=128)
    overwrite: bool = False


class ApplyAssetsBody(BaseModel):
    sourceType: Literal["user", "agent", "employee", "workspace"]
    sourceId: str = Field(..., min_length=1, max_length=128)
    targetType: Literal["user", "agent", "employee", "workspace"] = "employee"
    targetId: str = Field(..., min_length=1, max_length=128)
    scopes: list[str] = Field(default_factory=lambda: ["profile", "craft"])
    conflict: Literal["skip", "rename", "overwrite"] = "skip"


@router.get("/craft")
async def list_craft(
    request: Request,
    entityType: Literal["user", "agent", "employee", "workspace"] = Query(...),
    entityId: str = Query(...),
):
    """List promotable craft/*/SKILL.md under an entity."""
    from evoflow.assets.promote import list_promotable_crafts

    entity = _entity(request, entityType, entityId)
    try:
        items = list_promotable_crafts(entity)
        return {
            "entityType": entity.entity_type,
            "entityId": entity.entity_id,
            "items": items,
        }
    except Exception as exc:
        logger.error("assets list craft failed", exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/craft/promote")
async def promote_craft(request: Request, body: PromoteCraftBody):
    """Promote craft/{name} → ~/.evoflow/skills/custom/{name}."""
    from evoflow.assets.promote import promote_craft_to_custom
    from evoflow.skills.installer import SkillAlreadyExistsError

    entity = _entity(request, body.entityType, body.entityId)
    try:
        return promote_craft_to_custom(entity, body.craftName, overwrite=body.overwrite)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except SkillAlreadyExistsError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.error("assets craft promote failed", exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/apply")
async def apply_assets(request: Request, body: ApplyAssetsBody):
    """Copy selected asset scopes from source entity to target (e.g. apply to employee)."""
    from evoflow.assets.apply import apply_assets_to_entity

    source = _entity(request, body.sourceType, body.sourceId)
    target = _entity(request, body.targetType, body.targetId)
    try:
        return apply_assets_to_entity(
            source,
            target,
            scopes=body.scopes,
            conflict=body.conflict,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.error("assets apply failed", exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.get("/stats")
async def get_asset_usage_stats(
    request: Request,
    entityType: Literal["user", "agent", "employee", "workspace"] = Query(...),
    entityId: str = Query(...),
    topN: int = Query(default=12, ge=1, le=50),
):
    """Usage / freshness aggregate for Asset Center stats tab (KB-style dashboard)."""
    from evoflow.assets.usage import collect_entity_usage_stats

    entity = _entity(request, entityType, entityId)
    try:
        return collect_entity_usage_stats(entity, top_n=topN)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.error("assets stats failed", exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/phase2/consolidate")
async def post_phase2_consolidate_entity(
    request: Request,
    entityType: Literal["user", "agent", "employee", "workspace"] = Query(...),
    entityId: str = Query(...),
):
    """Run Phase2 for one entity (manual / stats panel)."""
    from evoflow.assets.phase2 import run_phase2_consolidate

    entity = _entity(request, entityType, entityId)
    try:
        return await asyncio.to_thread(run_phase2_consolidate, entity=entity)
    except Exception as exc:
        logger.error("assets phase2 consolidate failed", exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/phase2/scan")
async def post_phase2_startup_scan(
    request: Request,
    maxEntities: int = Query(default=24, ge=1, le=100),
):
    """Manually trigger inbox → Phase2 scan (same as Gateway startup hook)."""
    require_org_admin(request)
    from evoflow.assets.startup import scan_and_run_phase2_on_startup

    try:
        return await asyncio.to_thread(scan_and_run_phase2_on_startup, max_entities=maxEntities)
    except Exception as exc:
        logger.error("assets phase2 scan failed", exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/init")
async def init_assets_tree(request: Request):
    """Ensure ``~/.evoflow/assets/`` skeleton and builtin vault registration."""
    from evoflow.assets.hub import ensure_assets_tree, list_entities
    from evoflow.knowledge.vault.builtin import ensure_builtin_asset_vault

    try:
        root = ensure_assets_tree()
        vault = ensure_builtin_asset_vault()
        payload = list_entities()
        entities = payload.get("entities") if isinstance(payload, dict) else payload
        filtered = filter_asset_entities_for_request(
            request, entities if isinstance(entities, list) else []
        )
        return {
            "ok": True,
            "root": str(
                (payload.get("root") if isinstance(payload, dict) else None) or root.resolve()
            ),
            "vault": vault,
            "vaultId": (payload.get("vaultId") if isinstance(payload, dict) else None)
            or "evoflow-assets",
            # Flat list (not nested list_entities dict) so clients can paint in one round-trip.
            "entities": filtered,
        }
    except Exception as exc:
        logger.error("assets init failed", exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc)) from exc
