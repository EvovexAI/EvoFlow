"""Gateway / session startup: scan Asset Hub inboxes and run Phase2.

runtime aligns Phase2 with root-session start; we schedule a background scan when
the Gateway comes up so overnight notes / unfinished Phase1 drafts consolidate
without waiting for the next chat debounce.
"""

from __future__ import annotations

import logging
from typing import Any

from evoflow.assets.pipeline_config import asset_startup_phase2_enabled

logger = logging.getLogger(__name__)


def scan_and_run_phase2_on_startup(
    *,
    max_entities: int = 24,
    principal_id: str = "",
) -> dict[str, Any]:
    """Run Phase2 for every entity that has pending inbox files.

    Safe to call from a background thread. Skips when Phase2 or this hook is off.

    ``principal_id``: optional 操作人 (runtime identity). Empty for boot scan;
    Asset Center 「全库扫描」应传入当前登录用户.
    """
    if not asset_startup_phase2_enabled():
        return {"ok": False, "skipped": "disabled"}
    operator = str(principal_id or "").strip()

    from evoflow.assets.hub import list_entities
    from evoflow.assets.paths import EntityRef
    from evoflow.assets.phase2 import asset_phase2_enabled, list_inbox_pending, run_phase2_consolidate

    if not asset_phase2_enabled():
        return {"ok": False, "skipped": "phase2_disabled"}

    try:
        payload = list_entities()
    except Exception as exc:
        logger.warning("startup phase2: list_entities failed: %s", exc)
        return {"ok": False, "error": str(exc)}

    entities = list(payload.get("entities") or [])[: max(1, int(max_entities))]
    # Multi-user installs: per-principal buckets ``assets/users/<id>/`` are not
    # in list_entities() (Asset Center rewrites user→caller bucket per request).
    # Scan them too so personal-bucket inboxes get consolidated on startup.
    try:
        from evoflow.assets.hub import assets_root

        users_root = assets_root() / "users"
        if users_root.is_dir():
            for user_dir in sorted(users_root.iterdir()):
                if user_dir.is_dir() and not user_dir.name.startswith("."):
                    entities.append({"entityType": "user", "entityId": user_dir.name})
    except Exception:
        logger.debug("startup phase2: users/* scan skipped", exc_info=True)

    results: list[dict[str, Any]] = []
    ran = 0
    for row in entities:
        et = str(row.get("entityType") or "").strip()
        eid = str(row.get("entityId") or "").strip()
        if et == "agent":
            continue
        if not et or not eid:
            continue
        try:
            ent = EntityRef(entity_type=et, entity_id=eid).normalized()
        except ValueError:
            continue
        try:
            pending = list_inbox_pending(ent)
        except Exception:
            logger.debug("startup phase2: inbox list failed %s:%s", et, eid, exc_info=True)
            continue
        if not pending:
            continue
        try:
            out = run_phase2_consolidate(entity=ent)
            ran += 1
            try:
                from evoflow.assets.memory_runs import record_asset_phase_run

                record_asset_phase_run(
                    phase="phase2",
                    trigger="startup_scan",
                    result=out,
                    entity=ent,
                    principal_id=operator,
                    detail={"pending": len(pending)},
                )
            except Exception:
                logger.debug("startup phase2: run log skipped", exc_info=True)
            results.append(
                {
                    "entityType": et,
                    "entityId": eid,
                    "pending": len(pending),
                    "ok": bool(out.get("ok")),
                    "skipped": out.get("skipped"),
                    "paths": out.get("paths") or [],
                }
            )
            logger.info(
                "[资产Phase2] 启动扫描 entity=%s:%s pending=%d ok=%s skipped=%s",
                et,
                eid,
                len(pending),
                out.get("ok"),
                out.get("skipped"),
            )
        except Exception as exc:
            logger.exception("[资产Phase2] 启动扫描失败 entity=%s:%s", et, eid)
            try:
                from evoflow.assets.memory_runs import record_asset_phase_run

                record_asset_phase_run(
                    phase="phase2",
                    trigger="startup_scan",
                    result=None,
                    entity=ent,
                    principal_id=operator,
                    error=str(exc),
                    detail={"pending": len(pending)},
                )
            except Exception:
                pass
            results.append(
                {
                    "entityType": et,
                    "entityId": eid,
                    "pending": len(pending),
                    "ok": False,
                    "error": str(exc),
                }
            )

    return {"ok": True, "scanned": len(entities), "ran": ran, "results": results}
