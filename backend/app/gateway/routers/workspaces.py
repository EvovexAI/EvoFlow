import os
import re
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from evoflow.authz.http_guard import require_workspace_root_access, require_workspace_path_visible
from evoflow.authz.resource_visibility import stamp_kwargs_from_request
from evoflow.config.paths import VIRTUAL_PATH_PREFIX, get_paths
from evoflow.persistence import workspace_repositories as ws_repo
from evoflow.tools.host_direct.workspace_context import resolve_host_workspace_root_for_files
from evoflow.utils.workspace_browse import (
    flatten_bound_workspace_absolute,
    list_workspace_entries,
    resolve_bound_workspace_file,
    resolve_under_workspace,
    strip_bound_workspace_prefix,
)

router = APIRouter(prefix="/api/workspaces", tags=["workspaces"])


def _visible_history_paths(request: Request | None) -> list[str]:
    from evoflow.authz.http_guard import resolve_authz_from_request
    from evoflow.authz.workspace_visibility import filter_visible_workspace_paths

    authz = resolve_authz_from_request(request)
    return filter_visible_workspace_paths(
        ws_repo.list_global_workspace_paths(),
        authz.get("principal"),
        is_admin=bool(authz.get("is_admin")),
        personal_scope_id=authz.get("personal_scope"),
        org_scope_id=authz.get("org_scope"),
    )


def _stamp_from_request(request: Request | None) -> dict[str, Any]:
    return stamp_kwargs_from_request(request)


class ResolveWorkspaceRequest(BaseModel):
    path: str


class ResolveWorkspaceResponse(BaseModel):
    input: str
    resolved: str
    exists: bool
    is_dir: bool


class WorkspaceSummary(BaseModel):
    thread_id: str
    path: str
    exists: bool


class ListWorkspacesResponse(BaseModel):
    workspaces: list[WorkspaceSummary]


class UserWorkspaceHistoryResponse(BaseModel):
    paths: list[str] = Field(default_factory=list)


class UserWorkspaceHistoryPutBody(BaseModel):
    paths: list[str] = Field(default_factory=list)


class RemoveWorkspacePathBody(BaseModel):
    path: str


class WorkspaceBrowseEntry(BaseModel):
    name: str
    path: str
    is_dir: bool
    size: int | None = None
    mtime: float | None = None


class WorkspaceBrowseResponse(BaseModel):
    root: str
    path: str
    resolved: str
    entries: list[WorkspaceBrowseEntry]


class ResolveWorkspaceTargetResponse(BaseModel):
    path: str
    resolved: str
    exists: bool
    is_dir: bool


class IndexBuildRequest(BaseModel):
    root: str | None = None
    thread_id: str | None = None
    force: bool = False


class IndexBuildResponse(BaseModel):
    ok: bool
    root: str | None = None
    db_path: str | None = None
    files: int | None = None
    symbols: int | None = None
    symbol_parsers: dict[str, int] | None = None
    skipped: bool | None = None
    reason: str | None = None
    status: str | None = None
    ready: bool | None = None
    building: bool | None = None
    build_total_files: int | None = None
    build_indexed_files: int | None = None
    build_progress_pct: float | None = None
    build_phase: str | None = None
    updated_at: str | None = None


class IndexSearchHit(BaseModel):
    path: str
    snippet: str | None = None
    kind: str | None = None


class IndexSymbolHit(BaseModel):
    path: str
    name: str
    kind: str
    line: int


class IndexRelationHit(BaseModel):
    from_path: str
    to_path: str
    kind: str
    symbol: str | None = None
    spec: str | None = None
    line: int | None = None


class WorkspaceFindFileEntry(BaseModel):
    path: str
    name: str


class WorkspaceFindFilesResponse(BaseModel):
    query: str
    files: list[WorkspaceFindFileEntry] = Field(default_factory=list)


class IndexSearchResponse(BaseModel):
    query: str
    hits: list[IndexSearchHit] = Field(default_factory=list)
    symbols: list[IndexSymbolHit] = Field(default_factory=list)
    related_files: list[IndexSearchHit] = Field(default_factory=list)
    imported_by: list[IndexRelationHit] = Field(default_factory=list)
    imports: list[IndexRelationHit] = Field(default_factory=list)
    internal_ref_users: list[IndexRelationHit] = Field(default_factory=list)
    type_supertypes: list[IndexRelationHit] = Field(default_factory=list)
    type_subtypes: list[IndexRelationHit] = Field(default_factory=list)
    ready: bool | None = None
    building: bool | None = None
    rebuild_in_progress: bool | None = None
    message: str | None = None


class IndexFileRequest(BaseModel):
    root: str | None = None
    thread_id: str | None = None
    path: str
    deleted: bool = False


class IndexFileResponse(BaseModel):
    ok: bool
    action: str | None = None
    path: str | None = None
    symbols: int | None = None
    root: str | None = None
    db_path: str | None = None
    reason: str | None = None


class IndexWatchRequest(BaseModel):
    root: str | None = None
    thread_id: str | None = None


class IndexWatchResponse(BaseModel):
    ok: bool
    root: str | None = None
    watching: bool | None = None
    started: bool | None = None
    stopped: bool | None = None
    ref_count: int | None = None
    reason: str | None = None


class WorkspaceReadResponse(BaseModel):
    ok: bool
    path: str
    content: str | None = None
    size: int | None = None
    truncated: bool | None = None
    binary: bool | None = None
    encoding: str | None = None


class WorkspaceReadFileRequest(BaseModel):
    root: str | None = None
    thread_id: str | None = None
    path: str


class WorkspaceDeleteFileRequest(BaseModel):
    root: str | None = None
    thread_id: str | None = None
    path: str


class WorkspaceDeleteFileResponse(BaseModel):
    ok: bool
    path: str | None = None


class WorkspaceWriteFileRequest(BaseModel):
    root: str | None = None
    thread_id: str | None = None
    path: str
    content: str = ""


class WorkspaceWriteFileResponse(BaseModel):
    ok: bool
    path: str


class WorkspaceMkdirRequest(BaseModel):
    root: str | None = None
    thread_id: str | None = None
    path: str


class WorkspaceMkdirResponse(BaseModel):
    ok: bool
    path: str


_MAX_WORKSPACE_READ_BYTES = 524_288


def _is_host_absolute(path: str) -> bool:
    """True for Windows ``D:/…`` or POSIX ``/…`` even when the gateway OS differs."""
    s = str(path or "").strip().replace("\\", "/")
    if re.match(r"^[a-zA-Z]:/", s):
        return True
    if s.startswith("/") and not s.startswith("//"):
        return True
    try:
        return Path(s).is_absolute()
    except (OSError, ValueError):
        return False


def _normalize_rel_path(path: str) -> str:
    rel = str(path or "").strip().replace("\\", "/")
    while rel.startswith("./"):
        rel = rel[2:]
    if _is_host_absolute(rel):
        return rel
    return rel.lstrip("/")


def _heal_stripped_posix_absolute(key: str, root_s: str) -> str | None:
    """Restore a leading ``/`` when the model cited a POSIX abs path without it.

    Example: root ``/Users/a/.evoflow``, key ``Users/a/.evoflow/x.md`` →
    ``/Users/a/.evoflow/x.md``.
    """
    root_posix = str(Path(root_s).expanduser().resolve()).replace("\\", "/")
    if not root_posix.startswith("/"):
        return None
    key_norm = str(key or "").replace("\\", "/").lstrip("/")
    root_noslash = root_posix.lstrip("/")
    if key_norm == root_noslash or key_norm.startswith(root_noslash + "/"):
        return "/" + key_norm
    return None


def _fuzzy_match_sibling_file(target: Path) -> Path | None:
    """When the cited basename is slightly wrong, pick a unique sibling match.

    Example: cite ``问题挖掘报告.md`` while disk has ``深度问题挖掘报告.md``.
    Prefer names that *end with* the cited basename; otherwise a unique stem containment.
    """
    try:
        if target.exists():
            return target
    except OSError:
        return None
    parent = target.parent
    want = target.name
    if not want or not parent.is_dir():
        return None
    want_l = want.lower()
    want_stem = Path(want).stem
    try:
        children = [p for p in parent.iterdir() if p.is_file()]
    except OSError:
        return None

    for child in children:
        if child.name.lower() == want_l:
            return child

    ending = [p for p in children if p.name.lower().endswith(want_l)]
    if len(ending) == 1:
        return ending[0]
    if ending:
        ending.sort(key=lambda p: (len(p.name), p.name.lower()))
        return ending[0]

    if want_stem and len(want_stem) >= 2:
        stem_hits = [p for p in children if want_stem.lower() in p.stem.lower()]
        if len(stem_hits) == 1:
            return stem_hits[0]
    return None


def _strip_embedded_workspace_root_prefix(key: str, root_s: str) -> str:
    """Peel a relative key that wrongly re-embeds the bound root's trailing segments.

    Example: root ``D:/proj/outputs/app/workspace/role``,
    key ``outputs/app/workspace/role/docs/a.md`` → ``docs/a.md``.
    """
    key_norm = str(key or "").replace("\\", "/").lstrip("/")
    if not key_norm:
        return key_norm
    root_posix = str(Path(root_s).expanduser().resolve()).replace("\\", "/").rstrip("/")
    parts = [p for p in root_posix.split("/") if p]
    start = 1 if parts and re.match(r"^[a-zA-Z]:$", parts[0]) else 0
    for i in range(start, len(parts)):
        suffix = "/".join(parts[i:])
        if not suffix:
            continue
        if key_norm == suffix:
            return ""
        if key_norm.startswith(suffix + "/"):
            return key_norm[len(suffix) + 1 :]
    return key_norm


def _heal_stripped_windows_absolute(key: str, root_s: str) -> str | None:
    """Restore a Windows drive letter when the frontend/URL layer stripped it.

    Examples (root ``D:/dev/proj``):
    - ``:/dev/proj/out`` → ``D:/dev/proj/out``
    - ``/dev/proj/out`` → ``D:/dev/proj/out``
    - ``dev/proj/out`` → ``D:/dev/proj/out``
    """
    root_posix = str(Path(root_s).expanduser().resolve()).replace("\\", "/")
    m = re.match(r"^([a-zA-Z]):/", root_posix)
    if not m:
        return None
    drive = m.group(1)
    key_norm = str(key or "").replace("\\", "/")
    if key_norm.startswith(":/"):
        restored = f"{drive}{key_norm}"
    elif key_norm.startswith("/") and not key_norm.startswith("//"):
        restored = f"{drive}:{key_norm}"
    else:
        root_no_drive = root_posix[2:].lstrip("/") if root_posix[1:2] == ":" else root_posix.lstrip("/")
        key_stripped = key_norm.lstrip("/")
        if key_stripped == root_no_drive or key_stripped.startswith(root_no_drive + "/"):
            restored = f"{drive}:/{key_stripped}"
        else:
            return None
    if restored == root_posix or restored.startswith(root_posix + "/"):
        return restored
    return None


def _resolve_workspace_root(root: str | None, thread_id: str | None) -> str:
    """Same resolution as code index (validated absolute workspace directory)."""
    from evoflow.code_index.store import resolve_index_root

    root_s = str(root or "").strip() or None
    tid = str(thread_id or "").strip() or None
    if not root_s and tid:
        host = resolve_host_workspace_root_for_files(thread_id=tid)
        if host:
            root_s = host
            tid = None
    try:
        return resolve_index_root(workspace_root=root_s, thread_id=tid)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


def _resolve_workspace_file_target(
    *,
    root: str | None,
    thread_id: str | None,
    rel: str,
) -> Path:
    """Resolve read/delete target for EvoPanel file open.

    - ``outputs/…`` / ``uploads/…`` with bound ``root``: ``{root}/outputs/…``,
      ``{root}/uploads/…`` (legacy nested ``workspace/outputs`` only if flat missing).
    - ``workspace/…`` or other relatives: under ``{root}/`` directly (no extra
      ``{root}/workspace/`` directory layer).
    - Same prefixes with only ``thread_id``: thread sandbox ``…/user-data/…``.
    - Absolute paths: honored as given (same as host-direct tools). Prefer under
      bound ``root`` / thread dirs when they match; otherwise still return the host path
      so chat ``@@绝对路径@@`` previews work when the model wrote outside the bound root.
    - Otherwise: relative path under bound ``root`` (or thread workspace dir if only thread).
    """
    norm = _normalize_rel_path(rel)
    if not norm:
        raise ValueError("path must name a file")

    # Heal drive-stripped Windows / slash-stripped POSIX *before* absolute handling.
    # Otherwise ``/dev/proj/x`` is treated as POSIX-abs and never restored to ``D:/dev/proj/x``.
    if root:
        root_resolved = str(Path(root).expanduser().resolve())
        healed = _heal_stripped_windows_absolute(norm, root_resolved) or _heal_stripped_posix_absolute(
            norm, root_resolved
        )
        if healed and healed.replace("\\", "/") != norm.replace("\\", "/"):
            return _resolve_workspace_file_target(root=root, thread_id=thread_id, rel=healed)
    elif thread_id:
        host_root = resolve_host_workspace_root_for_files(thread_id=thread_id)
        if host_root:
            host_resolved = str(Path(host_root).expanduser().resolve())
            healed = _heal_stripped_windows_absolute(
                norm, host_resolved
            ) or _heal_stripped_posix_absolute(norm, host_resolved)
            if healed and healed.replace("\\", "/") != norm.replace("\\", "/"):
                return _resolve_workspace_file_target(root=host_root, thread_id=None, rel=healed)

    if _is_host_absolute(norm):
        # Windows abs must stay absolute even if gateway runs on POSIX (Path.is_absolute false).
        target = Path(norm).expanduser()
        try:
            target = target.resolve()
        except (OSError, ValueError):
            target = Path(norm)
        if root:
            r = Path(root).expanduser().resolve()
            target = flatten_bound_workspace_absolute(target, r)
        bases: list[Path] = []
        if root:
            r = Path(root).expanduser().resolve()
            bases.append(r)
            for sub in ("outputs",):
                d = r / sub
                if d.is_dir():
                    bases.append(d.resolve())
        if thread_id:
            host_root = resolve_host_workspace_root_for_files(thread_id=thread_id)
            if host_root:
                r = Path(host_root).expanduser().resolve()
                bases.append(r)
                for sub in ("outputs",):
                    d = r / sub
                    if d.is_dir():
                        bases.append(d.resolve())
            else:
                tid = str(thread_id).strip()
                paths = get_paths()
                bases.append(paths.sandbox_user_data_dir(tid).resolve())
                bases.append(paths.sandbox_work_dir(tid).resolve())
                bases.append(paths.sandbox_outputs_dir(tid).resolve())
        seen: set[Path] = set()
        for base in bases:
            if base in seen:
                continue
            seen.add(base)
            try:
                target.relative_to(base)
                return target
            except ValueError:
                continue
        # Absolute host path outside bound roots: still allow (preview / reveal parity with tools).
        return target

    key = norm.replace("\\", "/")
    if root:
        root_s = str(Path(root).expanduser().resolve())
        stripped = _strip_embedded_workspace_root_prefix(key, root_s)
        if stripped != key:
            return _resolve_workspace_file_target(root=root, thread_id=thread_id, rel=stripped)
    head = key.split("/", 1)[0] if key else ""

    if root and head in ("outputs", "uploads", "workspace"):
        root_s = str(Path(root).expanduser().resolve())
        return resolve_bound_workspace_file(root_s, key)

    if thread_id and head in ("outputs", "uploads", "workspace"):
        host_root = resolve_host_workspace_root_for_files(thread_id=thread_id)
        if host_root:
            host_s = str(Path(host_root).expanduser().resolve())
            if head in ("outputs", "uploads"):
                return resolve_bound_workspace_file(host_s, key)
            return resolve_under_workspace(host_s, strip_bound_workspace_prefix(key))
        # Explicit virtual-path sessions without a bound folder: per-thread sandbox.
        return get_paths().resolve_virtual_path(
            thread_id,
            f"{VIRTUAL_PATH_PREFIX}/{key}",
        )

    if root:
        root_s = str(Path(root).expanduser().resolve())
        return resolve_under_workspace(root_s, key)

    if thread_id:
        host_root = resolve_host_workspace_root_for_files(thread_id=thread_id)
        if host_root:
            host_s = str(Path(host_root).expanduser().resolve())
            return resolve_under_workspace(host_s, key)
        raise ValueError(f"Workspace root not found for thread {thread_id}")

    raise ValueError("workspace_root or thread_id is required")


def _read_workspace_file_impl(
    *,
    root: str | None,
    thread_id: str | None,
    rel: str,
) -> WorkspaceReadResponse:
    rel = _normalize_rel_path(rel)
    if not rel:
        raise HTTPException(status_code=400, detail="path must name a file")
    try:
        target = _resolve_workspace_file_target(root=root, thread_id=thread_id, rel=rel)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    fuzzy_matched = False
    if not target.exists():
        healed = _fuzzy_match_sibling_file(target)
        if healed is not None:
            target = healed
            fuzzy_matched = True
    if not target.exists():
        scope = f"thread={thread_id}" if thread_id else f"root={root}"
        raise HTTPException(
            status_code=404,
            detail=f"file not found: {rel} ({scope}, resolved={target})",
        )
    if target.is_dir():
        raise HTTPException(status_code=400, detail="path is a directory")
    try:
        size = int(target.stat().st_size)
        raw = target.read_bytes()[:_MAX_WORKSPACE_READ_BYTES]
    except OSError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
    truncated = size > len(raw)
    out_path = rel
    if fuzzy_matched:
        out_path = str(target).replace("\\", "/")
        if root and not _is_host_absolute(rel):
            try:
                out_path = str(target.resolve().relative_to(Path(root).expanduser().resolve())).replace(
                    "\\", "/"
                )
            except ValueError:
                pass
    try:
        content = raw.decode("utf-8")
    except UnicodeDecodeError:
        return WorkspaceReadResponse(ok=True, path=out_path, size=size, binary=True, content=None)
    return WorkspaceReadResponse(
        ok=True,
        path=out_path,
        content=content,
        size=size,
        truncated=truncated,
        binary=False,
        encoding="utf-8",
    )


@router.get("/browse", response_model=WorkspaceBrowseResponse)
async def browse_workspace(
    request: Request,
    root: str | None = Query(None, description="Bound local workspace root (absolute path)"),
    thread_id: str | None = Query(None, description="LangGraph thread id (virtual sandbox workspace)"),
    path: str = Query(".", description="Relative path under root"),
    show_hidden: bool = Query(False, description="Include dotfiles"),
) -> WorkspaceBrowseResponse:
    """List one directory level under a validated workspace root (for EvoPanel file tree)."""
    require_workspace_root_access(request, root=root, thread_id=thread_id)
    root_s = _resolve_workspace_root(root, thread_id)
    try:
        resolved_dir, raw_entries = list_workspace_entries(root_s, path, show_hidden=show_hidden)
        base = resolve_under_workspace(root_s, ".")
        rel = "."
        if path.strip() not in {"", "."}:
            rel = str(resolve_under_workspace(root_s, path).relative_to(base)).replace("\\", "/")
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except NotADirectoryError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    entries = [WorkspaceBrowseEntry(**e) for e in raw_entries]
    return WorkspaceBrowseResponse(
        root=str(base),
        path=rel,
        resolved=resolved_dir,
        entries=entries,
    )


@router.get("/resolve-target", response_model=ResolveWorkspaceTargetResponse)
async def resolve_workspace_target(
    request: Request,
    root: str | None = Query(None, description="Bound local workspace root (absolute path)"),
    thread_id: str | None = Query(None, description="LangGraph thread id (virtual sandbox workspace)"),
    path: str = Query(..., description="Relative path under workspace"),
) -> ResolveWorkspaceTargetResponse:
    """Resolve a workspace-relative path to an absolute host path (EvoPanel reveal in file manager)."""
    require_workspace_root_access(request, root=root, thread_id=thread_id)
    rel = _normalize_rel_path(path)
    if not rel:
        raise HTTPException(status_code=400, detail="path is required")
    try:
        target = _resolve_workspace_file_target(root=root, thread_id=thread_id, rel=rel)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    if not target.exists():
        healed = _fuzzy_match_sibling_file(target)
        if healed is not None:
            target = healed
    try:
        resolved = str(target.resolve(strict=False))
    except Exception:
        resolved = str(target.absolute())
    return ResolveWorkspaceTargetResponse(
        path=rel,
        resolved=resolved,
        exists=target.exists(),
        is_dir=target.is_dir() if target.exists() else False,
    )


@router.get("/serve-file")
async def serve_workspace_file(
    request: Request,
    root: str = Query(..., description="Bound workspace root directory"),
    path: str = Query(..., description="Absolute or relative file path under workspace"),
    thread_id: str | None = Query(None),
) -> FileResponse:
    """Serve a workspace binary (e.g. generated images) for EvoPanel inline preview."""
    require_workspace_root_access(request, root=root, thread_id=thread_id)
    try:
        target = _resolve_workspace_file_target(root=root, thread_id=thread_id, rel=path)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    if not target.is_file():
        raise HTTPException(status_code=404, detail="file not found")
    return FileResponse(target)


@router.get("/read", response_model=WorkspaceReadResponse)
async def read_workspace_file(
    request: Request,
    root: str | None = Query(None),
    thread_id: str | None = Query(None),
    path: str = Query(..., description="Relative file path under workspace root"),
) -> WorkspaceReadResponse:
    """Read a text file under the workspace for EvoPanel preview (size-capped)."""
    require_workspace_root_access(request, root=root, thread_id=thread_id)
    return _read_workspace_file_impl(root=root, thread_id=thread_id, rel=path)


@router.post("/read-file", response_model=WorkspaceReadResponse)
async def read_workspace_file_post(
    request: Request, body: WorkspaceReadFileRequest
) -> WorkspaceReadResponse:
    """Read workspace file (POST avoids URL encoding issues with paths)."""
    require_workspace_root_access(request, root=body.root, thread_id=body.thread_id)
    return _read_workspace_file_impl(
        root=body.root,
        thread_id=body.thread_id,
        rel=body.path,
    )


@router.post("/delete-file", response_model=WorkspaceDeleteFileResponse)
async def delete_workspace_file(
    request: Request, body: WorkspaceDeleteFileRequest
) -> WorkspaceDeleteFileResponse:
    """Delete one file under the workspace (EvoPanel context menu)."""
    require_workspace_root_access(request, root=body.root, thread_id=body.thread_id)
    rel = _normalize_rel_path(body.path)
    if not rel:
        raise HTTPException(status_code=400, detail="path must name a file")
    try:
        target = _resolve_workspace_file_target(
            root=body.root,
            thread_id=body.thread_id,
            rel=rel,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    if not target.exists():
        raise HTTPException(status_code=404, detail="file not found")
    if target.is_dir():
        raise HTTPException(status_code=400, detail="cannot delete a directory")
    try:
        target.unlink()
    except OSError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
    try:
        from evoflow.code_index.store import index_file

        index_root = _resolve_workspace_root(body.root, body.thread_id)
        index_file(
            index_root,
            relative_path=rel,
            thread_id=str(body.thread_id or "").strip() or None,
            deleted=True,
        )
    except Exception:
        pass
    return WorkspaceDeleteFileResponse(ok=True, path=rel)


@router.post("/write-file", response_model=WorkspaceWriteFileResponse)
async def write_workspace_file(
    request: Request, body: WorkspaceWriteFileRequest
) -> WorkspaceWriteFileResponse:
    """Write/create a file under the workspace (EvoPanel create file)."""
    require_workspace_root_access(request, root=body.root, thread_id=body.thread_id)
    rel = _normalize_rel_path(body.path)
    if not rel:
        raise HTTPException(status_code=400, detail="path must name a file")
    try:
        target = _resolve_workspace_file_target(
            root=body.root,
            thread_id=body.thread_id,
            rel=rel,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    if target.exists() and target.is_dir():
        raise HTTPException(status_code=400, detail="path is a directory")
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(body.content, encoding="utf-8")
    except OSError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
    try:
        from evoflow.code_index.store import index_file

        index_root = _resolve_workspace_root(body.root, body.thread_id)
        index_file(
            index_root,
            relative_path=rel,
            thread_id=str(body.thread_id or "").strip() or None,
        )
    except Exception:
        pass
    return WorkspaceWriteFileResponse(ok=True, path=rel)


@router.post("/mkdir", response_model=WorkspaceMkdirResponse)
async def create_workspace_dir(
    request: Request, body: WorkspaceMkdirRequest
) -> WorkspaceMkdirResponse:
    """Create a directory under the workspace (EvoPanel create folder)."""
    require_workspace_root_access(request, root=body.root, thread_id=body.thread_id)
    rel = _normalize_rel_path(body.path)
    if not rel:
        raise HTTPException(status_code=400, detail="path must name a directory")
    try:
        target = _resolve_workspace_file_target(
            root=body.root,
            thread_id=body.thread_id,
            rel=rel,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    if target.exists() and target.is_file():
        raise HTTPException(status_code=400, detail="path is a file")
    try:
        target.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
    return WorkspaceMkdirResponse(ok=True, path=rel)


def _index_build_response(data: dict) -> IndexBuildResponse:
    return IndexBuildResponse(
        ok=bool(data.get("ok")),
        root=data.get("root"),
        db_path=data.get("db_path"),
        files=data.get("files"),
        symbols=data.get("symbols"),
        symbol_parsers=data.get("symbol_parsers"),
        skipped=data.get("skipped"),
        reason=data.get("reason"),
        status=data.get("status"),
        ready=data.get("ready"),
        building=data.get("building"),
        build_total_files=data.get("build_total_files"),
        build_indexed_files=data.get("build_indexed_files"),
        build_progress_pct=data.get("build_progress_pct"),
        build_phase=data.get("build_phase"),
        updated_at=data.get("updated_at"),
    )


def _relation_hits(rows: list[dict] | None) -> list[IndexRelationHit]:
    out: list[IndexRelationHit] = []
    for r in rows or []:
        if not isinstance(r, dict):
            continue
        fp = str(r.get("from_path") or r.get("path") or "").strip()
        tp = str(r.get("to_path") or r.get("super_path") or r.get("sub_path") or "").strip()
        if not fp and not tp:
            continue
        out.append(
            IndexRelationHit(
                from_path=fp or tp,
                to_path=tp or fp,
                kind=str(r.get("kind") or r.get("relation") or "relation"),
                symbol=str(r.get("symbol") or r.get("name") or "").strip() or None,
                spec=str(r.get("spec") or "").strip() or None,
                line=int(r["line"]) if r.get("line") is not None else None,
            )
        )
    return out


@router.get("/index-status", response_model=IndexBuildResponse)
async def workspace_index_status(
    root: str | None = Query(None),
    thread_id: str | None = Query(None),
) -> IndexBuildResponse:
    """Whether a shared code index is ready for this workspace root (not per chat session)."""
    root_s = str(root or "").strip() or None
    tid = str(thread_id or "").strip() or None
    if not root_s and not tid:
        raise HTTPException(status_code=400, detail="root or thread_id is required")
    try:
        from evoflow.code_index.store import index_status

        data = index_status(root_s, thread_id=tid)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return _index_build_response(data)


@router.post("/index-warm", response_model=IndexBuildResponse)
async def warm_workspace_index(body: IndexBuildRequest) -> IndexBuildResponse:
    """Schedule index build in the background; returns immediately (shared DB per workspace root)."""
    root_s = str(body.root or "").strip() or None
    thread_id = str(body.thread_id or "").strip() or None
    if not root_s and not thread_id:
        raise HTTPException(status_code=400, detail="root or thread_id is required")
    try:
        from evoflow.code_index.store import schedule_build_index

        data = schedule_build_index(root_s, thread_id=thread_id, force=bool(body.force))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except OSError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
    return _index_build_response(data)


@router.post("/index-build", response_model=IndexBuildResponse)
async def build_workspace_index(body: IndexBuildRequest) -> IndexBuildResponse:
    """Build or refresh FTS5 code index for a local workspace root or thread sandbox.

    Runs ``build_index`` in a worker thread so the gateway event loop stays responsive
    during large rebuilds (minutes). Prefer ``/index-warm`` when the client only needs
    to schedule work and poll ``/index-status``.
    """
    import asyncio

    root_s = str(body.root or "").strip() or None
    thread_id = str(body.thread_id or "").strip() or None
    if not root_s and not thread_id:
        raise HTTPException(status_code=400, detail="root or thread_id is required")
    try:
        from evoflow.code_index.store import build_index

        data = await asyncio.to_thread(
            build_index,
            root_s,
            thread_id=thread_id,
            force=bool(body.force),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except OSError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
    return _index_build_response(data)


@router.post("/index-file", response_model=IndexFileResponse)
async def index_workspace_file(body: IndexFileRequest) -> IndexFileResponse:
    """Incrementally update or remove one file in the workspace code index."""
    root_s = str(body.root or "").strip() or None
    thread_id = str(body.thread_id or "").strip() or None
    rel = str(body.path or "").strip()
    if not root_s and not thread_id:
        raise HTTPException(status_code=400, detail="root or thread_id is required")
    if not rel:
        raise HTTPException(status_code=400, detail="path is required")
    try:
        from evoflow.code_index.store import index_file

        data = index_file(
            root_s,
            relative_path=rel,
            thread_id=thread_id,
            deleted=bool(body.deleted),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except OSError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
    if not data.get("ok"):
        raise HTTPException(status_code=400, detail=str(data.get("reason") or "index_file failed"))
    return IndexFileResponse(**{k: data.get(k) for k in IndexFileResponse.model_fields})


@router.post("/index-watch", response_model=IndexWatchResponse)
async def start_workspace_index_watch(body: IndexWatchRequest) -> IndexWatchResponse:
    """Start background filesystem watcher → incremental index updates."""
    root_s = str(body.root or "").strip() or None
    thread_id = str(body.thread_id or "").strip() or None
    if not root_s and not thread_id:
        raise HTTPException(status_code=400, detail="root or thread_id is required")
    try:
        from evoflow.code_index.watcher import start_index_watch

        data = start_index_watch(workspace_root=root_s, thread_id=thread_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return IndexWatchResponse(**{k: data.get(k) for k in IndexWatchResponse.model_fields})


@router.post("/index-watch/stop", response_model=IndexWatchResponse)
async def stop_workspace_index_watch(body: IndexWatchRequest) -> IndexWatchResponse:
    """Stop background index watcher (reference-counted per workspace root)."""
    root_s = str(body.root or "").strip() or None
    thread_id = str(body.thread_id or "").strip() or None
    if not root_s and not thread_id:
        raise HTTPException(status_code=400, detail="root or thread_id is required")
    try:
        from evoflow.code_index.watcher import stop_index_watch

        data = stop_index_watch(workspace_root=root_s, thread_id=thread_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return IndexWatchResponse(**{k: data.get(k) for k in IndexWatchResponse.model_fields})


@router.get("/index-watch", response_model=IndexWatchResponse)
async def workspace_index_watch_status(
    root: str | None = Query(None),
    thread_id: str | None = Query(None),
) -> IndexWatchResponse:
    root_s = str(root or "").strip() or None
    tid = str(thread_id or "").strip() or None
    if not root_s and not tid:
        raise HTTPException(status_code=400, detail="root or thread_id is required")
    try:
        from evoflow.code_index.watcher import index_watch_status

        data = index_watch_status(workspace_root=root_s, thread_id=tid)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return IndexWatchResponse(**{k: data.get(k) for k in IndexWatchResponse.model_fields})


@router.get("/find-files", response_model=WorkspaceFindFilesResponse)
async def find_workspace_files(
    request: Request,
    q: str = Query(..., description="Filename or path fragment"),
    root: str | None = Query(None, description="Absolute workspace root"),
    thread_id: str | None = Query(None, description="LangGraph thread id (virtual sandbox)"),
    limit: int = Query(40, ge=1, le=100),
) -> WorkspaceFindFilesResponse:
    """Find workspace files by name/path (bounded filesystem scan; no code index required)."""
    require_workspace_root_access(request, root=root, thread_id=thread_id)
    query = str(q or "").strip()
    if not query:
        raise HTTPException(status_code=400, detail="q is required")
    try:
        root_s = _resolve_workspace_root(root, thread_id)
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    try:
        from evoflow.tools.host_direct.find_file import find_workspace_files as _find_files

        files = _find_files(root_s, query, limit=limit)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except OSError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
    return WorkspaceFindFilesResponse(
        query=query,
        files=[WorkspaceFindFileEntry(**f) for f in files],
    )


@router.get("/search", response_model=IndexSearchResponse)
async def search_workspace_index(
    request: Request,
    q: str = Query(..., description="Search query"),
    root: str | None = Query(None, description="Absolute workspace root"),
    thread_id: str | None = Query(None, description="LangGraph thread id (virtual sandbox)"),
    limit: int = Query(20, ge=1, le=100),
) -> IndexSearchResponse:
    """Search indexed workspace (FTS content + symbol names)."""
    require_workspace_root_access(request, root=root, thread_id=thread_id)
    root_s = str(root or "").strip() or None
    tid = str(thread_id or "").strip() or None
    query = str(q or "").strip()
    if not root_s and not tid:
        raise HTTPException(status_code=400, detail="root or thread_id is required")
    if not query:
        raise HTTPException(status_code=400, detail="q is required")
    try:
        from evoflow.code_index.store import index_status, search_index

        data = search_index(root_s, query, thread_id=tid, limit=limit)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    hits = [IndexSearchHit(**h) for h in (data.get("hits") or [])]
    symbols = [IndexSymbolHit(**s) for s in (data.get("symbols") or [])]
    related = [IndexSearchHit(**h) for h in (data.get("related_files") or []) if isinstance(h, dict)]
    st = index_status(workspace_root=root_s, thread_id=tid)
    ready = bool(data.get("ready")) if data.get("ready") is not None else bool(st.get("ready"))
    building = bool(data.get("building")) if data.get("building") is not None else bool(st.get("building"))
    rebuild_in_progress = bool(data.get("rebuild_in_progress"))
    message: str | None = None
    if building and not ready and not hits and not symbols:
        message = "索引正在构建，请稍后重试"
    elif not ready and not hits and not symbols:
        message = "索引尚未就绪，请等待后台索引完成"
    return IndexSearchResponse(
        query=str(data.get("query") or query),
        hits=hits,
        symbols=symbols,
        related_files=related,
        imported_by=_relation_hits(data.get("imported_by")),
        imports=_relation_hits(data.get("imports")),
        internal_ref_users=_relation_hits(data.get("internal_ref_users")),
        type_supertypes=_relation_hits(data.get("type_supertypes")),
        type_subtypes=_relation_hits(data.get("type_subtypes")),
        ready=ready,
        building=building,
        rebuild_in_progress=rebuild_in_progress,
        message=message,
    )


@router.get("/user-history", response_model=UserWorkspaceHistoryResponse)
async def get_user_workspace_history(request: Request) -> UserWorkspaceHistoryResponse:
    """Cross-session workspace path history (for picker / reuse)."""
    return UserWorkspaceHistoryResponse(paths=_visible_history_paths(request))


@router.put("/user-history", response_model=UserWorkspaceHistoryResponse)
async def put_user_workspace_history(
    request: Request, body: UserWorkspaceHistoryPutBody
) -> UserWorkspaceHistoryResponse:
    stamp = _stamp_from_request(request)
    for p in body.paths or []:
        ps = str(p or "").strip()
        if ps:
            require_workspace_path_visible(request, ps)
    ws_repo.set_global_workspace_paths(body.paths or [], stamp=stamp or None)
    return UserWorkspaceHistoryResponse(paths=_visible_history_paths(request))


@router.post("/user-history/remove", response_model=UserWorkspaceHistoryResponse)
async def remove_user_workspace_path(
    request: Request, body: RemoveWorkspacePathBody
) -> UserWorkspaceHistoryResponse:
    path = str(body.path or "").strip()
    if path:
        require_workspace_path_visible(request, path)
        ws_repo.remove_workspace_path_everywhere(path)
    return UserWorkspaceHistoryResponse(paths=_visible_history_paths(request))


@router.post("/resolve", response_model=ResolveWorkspaceResponse)
async def resolve_workspace(
    request: Request, req: ResolveWorkspaceRequest
) -> ResolveWorkspaceResponse:
    """
    Resolve and validate a local workspace path (frontend-selected directory).

    - Normalizes user input (expands env vars and ~).
    - Resolves to an absolute path where possible.
    - Returns existence and directory flags for UI validation.
    """
    raw = (req.path or "").strip()
    expanded = os.path.expanduser(os.path.expandvars(raw))
    p = Path(expanded)
    try:
        resolved = str(p.resolve(strict=False))
    except Exception:
        resolved = str(p.absolute())
    # Block leaking foreign personal files via resolve existence checks.
    require_workspace_path_visible(request, resolved)
    rp = Path(resolved)
    return ResolveWorkspaceResponse(
        input=raw,
        resolved=resolved,
        exists=rp.exists(),
        is_dir=rp.is_dir(),
    )


@router.get("", response_model=ListWorkspacesResponse)
async def list_workspaces() -> ListWorkspacesResponse:
    """List thread-bound workspace directories managed by EvoFlow."""
    paths = get_paths()
    threads_dir = paths.base_dir / "threads"
    if not threads_dir.exists():
        return ListWorkspacesResponse(workspaces=[])

    items: list[WorkspaceSummary] = []
    for entry in threads_dir.iterdir():
        if not entry.is_dir():
            continue
        thread_id = entry.name
        try:
            workspace_path = paths.sandbox_work_dir(thread_id)
        except ValueError:
            continue
        items.append(
            WorkspaceSummary(
                thread_id=thread_id,
                path=str(workspace_path),
                exists=workspace_path.exists(),
            )
        )
    items.sort(key=lambda x: x.thread_id)
    return ListWorkspacesResponse(workspaces=items)
