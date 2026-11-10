"""Gateway 直接 serve 内置 UI 扩展应用的静态文件。

背景：面板扩展壳用 ``<iframe src=manifest.ui.entry>`` 打开应用。WebView2 拒绝
``file://`` 作为 iframe src，外置扩展因此都要自起本地 HTTP 服务（managed 模式，
依赖 Node/Python 运行时）。系统内置演示应用是纯静态单页，没必要让用户机器
再跑一个进程——由网关自己把 ``<ui-extensions>/<id>/`` 下的文件 serve 出去，
entry 直接指向本路由。

安全边界：

- 仅放行 manifest 声明 ``ui.serve == "gateway"`` 的注册行（目前只有内置安装器
  会写入该标记，外置 folder-link 扩展一律 404，杜绝任意目录被 serve）。
- install_path 必须位于 ui-extensions 根目录之下（复制安装形态）。
- 请求路径 resolve 后必须仍在 install_path 内（防 ``..`` 穿越）。
"""

from __future__ import annotations

import logging
import mimetypes
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/ui-ext-apps", tags=["ui-ext-apps"])

_MEDIA_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
}

_SERVABLE_SUFFIXES = set(_MEDIA_TYPES)


def _load_servable_row(ext_id: str) -> tuple[dict[str, Any], Path]:
    from evoflow.admin.ui_extensions_registry import (
        ExtensionIOError,
        get_row,
        ui_extensions_root,
    )

    try:
        row = get_row(ext_id)
    except ExtensionIOError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    if row is None:
        raise HTTPException(status_code=404, detail=f"UI extension not found: {ext_id}")
    manifest = row.get("manifest") or {}
    if str((manifest.get("ui") or {}).get("serve") or "") != "gateway":
        raise HTTPException(status_code=404, detail=f"UI extension not servable: {ext_id}")
    root = ui_extensions_root().resolve()
    install_path = Path(str(row.get("install_path") or "")).resolve()
    if not install_path.is_dir() or install_path.parent != root:
        raise HTTPException(status_code=404, detail=f"UI extension files missing: {ext_id}")
    return row, install_path


def _resolve_under(install_path: Path, rel: str) -> Path:
    candidate = (install_path / rel).resolve()
    if candidate != install_path and install_path not in candidate.parents:
        raise HTTPException(status_code=404, detail="Not found")
    return candidate


def _file_response(path: Path) -> FileResponse:
    suffix = path.suffix.lower()
    if suffix not in _SERVABLE_SUFFIXES:
        raise HTTPException(status_code=404, detail="Unsupported file type")
    media_type = _MEDIA_TYPES.get(suffix) or mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return FileResponse(path, media_type=media_type)


@router.get("/{ext_id}")
@router.get("/{ext_id}/")
async def ui_ext_app_index(request: Request, ext_id: str):
    """默认入口 = 应用目录下的 index.html（manifest.ui.entry 指向这里）。"""
    _, install_path = _load_servable_row(ext_id)
    index = _resolve_under(install_path, "index.html")
    if not index.is_file():
        raise HTTPException(status_code=404, detail=f"index.html missing for {ext_id}")
    return _file_response(index)


@router.get("/{ext_id}/{file_path:path}")
async def ui_ext_app_file(request: Request, ext_id: str, file_path: str):
    _, install_path = _load_servable_row(ext_id)
    rel = (file_path or "").strip().replace("\\", "/").lstrip("/")
    if not rel:
        raise HTTPException(status_code=404, detail="Not found")
    candidate = _resolve_under(install_path, rel)
    if not candidate.is_file():
        raise HTTPException(status_code=404, detail="Not found")
    return _file_response(candidate)
