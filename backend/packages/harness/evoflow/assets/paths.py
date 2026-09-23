"""Path conventions for the Entity Asset Hub vault (``{EVOFLOW_HOME}/assets/``).

Workspace (project) memory is **not** under ``assets/workspaces/`` — it lives in the
bound project at ``<workspace>/.evoflow/`` (same standing/facts/craft tree).
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

BUILTIN_ASSET_VAULT_ID = "evoflow-assets"
BUILTIN_ASSET_VAULT_NAME = "EvoFlow 资产中心"

EntityType = Literal["user", "agent", "employee", "workspace"]

# Project-local SoT for workspace entity trees (same layout as Asset Hub memory/craft).
WORKSPACE_ASSET_REL = Path(".evoflow")

_USER_PROFILE_FILES = ("basic-info.md", "preferences.md", "persona.md", "README.md")
_AGENT_PROFILE_FILES = ("identity.md", "SOUL.md", "system.md", "soul-summary.md")

_SAFE_SEGMENT = re.compile(r"^[a-z0-9][a-z0-9_-]*$", re.I)
# Relative asset paths may contain CJK / other Unicode word characters: craft
# slugs, memory note filenames and workspace docs are routinely written in
# Chinese by ``_slug`` (craft.py) and ``assets_tool._SLUG_RE``. Restricting this
# to ASCII made every non-ASCII asset unreadable even though the write succeeded.
# ``\w`` (Unicode-aware) still rejects separators, control chars and the
# Windows-reserved set ``<>:"|?*``, and traversal is checked separately below.
_SAFE_REL_PATH = re.compile(r"^[\w./\-]+$", re.UNICODE)

# Best-effort cache: ws-{hash} -> absolute workspace path (filled by workspace_entity_ref).
_WS_PATH_BY_ID: dict[str, str] = {}


def sanitize_user_asset_id(principal_or_id: str) -> str:
    """Map a principal id (or alias) to a filesystem-safe user asset bucket id.

    Legacy shared bucket is ``user``. Multi-user installs use ``users/<id>/``.
    """
    raw = str(principal_or_id or "").strip()
    if not raw or raw.lower() in ("user", "me", "self"):
        return "user"
    if _SAFE_SEGMENT.match(raw):
        return raw.lower()
    cleaned = re.sub(r"[^a-zA-Z0-9_-]+", "_", raw).strip("_").lower()
    if cleaned and _SAFE_SEGMENT.match(cleaned):
        return cleaned
    return "p_" + hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


@dataclass(frozen=True)
class EntityRef:
    entity_type: EntityType
    entity_id: str

    def normalized(self) -> EntityRef:
        et = str(self.entity_type or "").strip().lower()
        eid = str(self.entity_id or "").strip()
        if et == "user":
            eid = sanitize_user_asset_id(eid)
        else:
            eid = eid.lower()
        if et not in ("user", "agent", "employee", "workspace"):
            raise ValueError(f"invalid entity_type: {et!r}")
        if et == "user":
            if eid != "user" and not _SAFE_SEGMENT.match(eid):
                raise ValueError(f"invalid entity_id: {eid!r}")
        elif not _SAFE_SEGMENT.match(eid):
            raise ValueError(f"invalid entity_id: {eid!r}")
        return EntityRef(entity_type=et, entity_id=eid)  # type: ignore[arg-type]


def _paths():
    from evoflow.config.paths import get_paths

    return get_paths()


def assets_root() -> Path:
    return _paths().base_dir / "assets"


def workspace_asset_root(workspace_path: str | Path) -> Path:
    """Absolute ``<workspace>/.evoflow`` for a bound project root."""
    from evoflow.persistence.workspace_repositories import normalize_workspace_path

    normalized = normalize_workspace_path(str(workspace_path or ""))
    if not normalized:
        raise ValueError("workspace_path is required")
    return Path(normalized).resolve() / WORKSPACE_ASSET_REL


# Back-compat alias
workspace_wiki_root = workspace_asset_root


def resolve_workspace_path_for_entity_id(entity_id: str) -> str | None:
    """Reverse ``ws-{hash}`` → workspace path (cache, then ``evoflow_workspaces``)."""
    eid = str(entity_id or "").strip().lower()
    if not eid.startswith("ws-"):
        return None
    cached = _WS_PATH_BY_ID.get(eid)
    if cached:
        return cached
    digest = eid[3:]
    try:
        from evoflow.persistence.db import get_db
        from evoflow.persistence.workspace_repositories import normalize_workspace_path

        rows = get_db().execute("SELECT workspace_path FROM evoflow_workspaces").fetchall()
    except Exception:
        return None
    for row in rows:
        wp = normalize_workspace_path(str(row[0] or ""))
        if not wp:
            continue
        resolved = str(Path(wp).resolve())
        if hashlib.sha256(resolved.encode("utf-8")).hexdigest()[:32] == digest:
            _WS_PATH_BY_ID[eid] = resolved
            return resolved
    return None


def entity_relative_dir(entity: EntityRef) -> str:
    e = entity.normalized()
    if e.entity_type == "user":
        # Legacy single-bucket: assets/user. Per-principal: assets/users/<id>.
        if e.entity_id == "user":
            return "user"
        return f"users/{e.entity_id}"
    if e.entity_type == "agent":
        return f"agents/{e.entity_id}"
    if e.entity_type == "workspace":
        # Project-relative label (not under ~/.evoflow/assets/).
        if resolve_workspace_path_for_entity_id(e.entity_id):
            return WORKSPACE_ASSET_REL.as_posix()
        return f"workspaces/{e.entity_id}"
    return f"employees/{e.entity_id}"


def entity_prompt_root(entity: EntityRef) -> str:
    """Root string shown in Tier-0 read_path prompts."""
    e = entity.normalized()
    if e.entity_type == "workspace":
        rel = entity_relative_dir(e)
        if rel == WORKSPACE_ASSET_REL.as_posix():
            return rel
        return f"assets/{rel}"
    return f"assets/{entity_relative_dir(e)}"


def entity_root(entity: EntityRef) -> Path:
    e = entity.normalized()
    if e.entity_type == "workspace":
        wp = resolve_workspace_path_for_entity_id(e.entity_id)
        if wp:
            return Path(wp).resolve() / WORKSPACE_ASSET_REL
        # Orphan id (no bound path yet): legacy home bucket so tools don't crash.
        return assets_root() / f"workspaces/{e.entity_id}"
    return assets_root() / entity_relative_dir(e)


def profile_dir(entity: EntityRef) -> Path:
    return entity_root(entity) / "profile"


def profile_path(entity: EntityRef, name: str) -> Path:
    e = entity.normalized()
    fname = str(name or "").strip()
    if e.entity_type == "user":
        allowed = set(_USER_PROFILE_FILES)
        if fname not in allowed:
            raise ValueError(f"unsupported user profile file: {fname}")
    elif e.entity_type == "workspace":
        raise ValueError("workspace has no profile files")
    else:
        allowed = set(_AGENT_PROFILE_FILES)
        if fname not in allowed:
            raise ValueError(f"unsupported profile file: {fname}")
    return profile_dir(e) / fname


def profile_field_names(entity: EntityRef) -> tuple[str, ...]:
    e = entity.normalized()
    if e.entity_type == "user":
        return _USER_PROFILE_FILES
    if e.entity_type == "workspace":
        return ()
    return _AGENT_PROFILE_FILES


def resolve_entity_file(entity: EntityRef, rel_path: str) -> Path:
    """Resolve ``rel_path`` under the entity root; reject traversal."""
    e = entity.normalized()
    rel = str(rel_path or "").strip().replace("\\", "/").lstrip("/")
    if not rel or rel.startswith("..") or "/../" in f"/{rel}/":
        raise ValueError("invalid relative path")
    if not _SAFE_REL_PATH.match(rel):
        raise ValueError("invalid characters in path")
    root = entity_root(e).resolve()
    target = (root / rel).resolve()
    if target != root and root not in target.parents:
        raise ValueError("path escapes entity root")
    return target


def default_user_profile_md() -> str:
    from evoflow.assets.user_profile_dims import default_profile_readme_md

    return default_profile_readme_md()


def default_index_md() -> str:
    return (
        "# 资产中心索引\n\n"
        "本目录由 EvoFlow 资产中心管理。画像、记忆、专长均以 Markdown 存放，可直接复制导出。\n\n"
        "- `user/` — 用户资产\n"
        "- `agents/` — 智能体资产\n"
        "- `employees/` — 智能体员工资产\n"
        "- 项目知识 — 绑定工作区下的 `.evoflow/`（standing / facts / episodic / craft）\n"
    )


def workspace_entity_ref(workspace_path: str) -> EntityRef:
    """Map a bound project root to ``EntityRef(workspace, ws-{hash})`` and cache the path."""
    from evoflow.persistence.workspace_repositories import normalize_workspace_path

    normalized = normalize_workspace_path(workspace_path)
    if not normalized:
        raise ValueError("workspace_path is required")
    resolved = str(Path(normalized).resolve())
    digest = hashlib.sha256(resolved.encode("utf-8")).hexdigest()[:32]
    ref = EntityRef("workspace", f"ws-{digest}").normalized()
    _WS_PATH_BY_ID[ref.entity_id] = resolved
    return ref
