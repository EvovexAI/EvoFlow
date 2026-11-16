"""Serve EvoPanel static assets from the Gateway when WebUI remote access is enabled."""

from __future__ import annotations

import logging
import os
import sys
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from starlette.responses import FileResponse

from evoflow.webui.auth import is_webui_enabled

logger = logging.getLogger(__name__)

_STATIC_MOUNTED = False


def _frozen_base_dir() -> Path | None:
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        return Path(meipass)
    return None


def resolve_evopanel_dist_dir() -> Path | None:
    """Locate the built EvoPanel ``dist`` directory.

    Search order:
    1. ``EVOFLOW_EVOPANEL_DIST`` environment variable
    2. PyInstaller bundle ``evopanel-dist/``
    3. Sibling ``evopanel-dist/`` next to the gateway executable
    4. Dev checkout ``evopanel/dist`` (relative to repo layout)
    """
    env = os.environ.get("EVOFLOW_EVOPANEL_DIST", "").strip()
    if env:
        p = Path(env).expanduser().resolve()
        if (p / "index.html").is_file():
            return p

    frozen = _frozen_base_dir()
    if frozen:
        bundled = frozen / "evopanel-dist"
        if (bundled / "index.html").is_file():
            return bundled

    exe = Path(getattr(sys, "executable", "") or "").resolve()
    if exe.is_file():
        sibling = exe.parent / "evopanel-dist"
        if (sibling / "index.html").is_file():
            return sibling
        # evopanel/src-tauri/binaries/evoflow-gateway/*.exe → evopanel/dist
        dev_dist = exe.parent.parent.parent / "dist"
        if (dev_dist / "index.html").is_file():
            return dev_dist

    # Repo dev: …/packages/harness/evoflow/webui/static.py → <repo>/evopanel/dist
    here = Path(__file__).resolve()
    for ancestor in here.parents:
        candidate = ancestor / "evopanel" / "dist"
        if (candidate / "index.html").is_file():
            return candidate
        # Stop at a real checkout root (has both trees). Do NOT stop on the
        # Python package dir ``…/harness/evoflow`` — that used to make WebUI
        # log "dist was not found" while ``<repo>/evopanel/dist`` existed,
        # so LAN ``http://<ip>:8382/`` returned 404.
        if (ancestor / "evopanel").is_dir() and (ancestor / "backend").is_dir():
            break
        if ancestor.name in {"EvoFlow", "github"}:
            break

    return None


def mount_evopanel_static(app: FastAPI) -> bool:
    """Mount EvoPanel SPA static files at ``/`` when WebUI is enabled.

    API routes registered earlier take precedence. Unmatched GET requests fall
    back to ``index.html`` for hash-router SPA navigation.

    Returns:
        ``True`` if static files were mounted.
    """
    global _STATIC_MOUNTED
    if _STATIC_MOUNTED:
        return True
    if not is_webui_enabled():
        logger.debug("Skip EvoPanel static mount — WebUI remote access is disabled")
        return False

    dist = resolve_evopanel_dist_dir()
    if dist is None:
        logger.warning(
            "WebUI is enabled but EvoPanel dist was not found — build evopanel "
            "(npm run build) or set EVOFLOW_EVOPANEL_DIST"
        )
        return False

    dist_str = str(dist)
    logger.info("Mounting EvoPanel static files from %s", dist_str)

    # Assets with real files on disk (js/css/images).
    # Vite emits hashed bundles under dist/assets/, so the StaticFiles mount
    # root must be the "assets" subdirectory. Mounting dist/ itself would make
    # /assets/main-xxx.js resolve to <dist>/main-xxx.js (which doesn't exist),
    # causing every hashed chunk to 404 on remote WebUI access.
    assets_dir = dist / "assets"
    if assets_dir.is_dir():
        app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="evopanel-assets")
    else:
        logger.warning("EvoPanel dist/assets not found under %s — hashed JS/CSS will 404", dist_str)

    icons_dir = dist / "icons"
    if icons_dir.is_dir():
        app.mount("/icons", StaticFiles(directory=str(icons_dir)), name="evopanel-icons")

    images_dir = dist / "images"
    if images_dir.is_dir():
        app.mount("/images", StaticFiles(directory=str(images_dir)), name="evopanel-images")

    index_html = str(dist / "index.html")

    # Explicit SPA entry routes only — never ``/{full_path:path}``.
    # A catch-all registered during deferred WebUI load was matching
    # ``/api/webui/*`` first and breaking remote login/status.
    # Hash-router navigation stays on ``/`` / ``/login`` after first paint.
    async def _spa_index() -> FileResponse:
        return FileResponse(index_html)

    for spa_path in ("/", "/login", "/qr-login", "/index.html"):
        app.add_api_route(
            spa_path,
            _spa_index,
            methods=["GET", "HEAD"],
            include_in_schema=False,
            name=f"evopanel_spa_{spa_path.strip('/') or 'root'}",
        )

    _STATIC_MOUNTED = True
    return True
