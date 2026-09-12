"""Path conventions for the Entity Asset Hub vault (``{EVOFLOW_HOME}/assets/``)."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

BUILTIN_ASSET_VAULT_ID = "evoflow-assets"
BUILTIN_ASSET_VAULT_NAME = "EvoFlow 资产中心"

EntityType = Literal["user", "agent", "employee", "workspace"]

_USER_PROFILE_FILES = ("basic-info.md", "preferences.md", "persona.md", "README.md")
_AGENT_PROFILE_FILES = ("identity.md", "SOUL.md", "system.md", "soul-summary.md")

_SAFE_SEGMENT = re.compile(r"^[a-z0-9][a-z0-9_-]*$", re.I)
_SAFE_REL_PATH = re.compile(r"^[a-zA-Z0-9_./\-]+$")


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
    import hashlib

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
        return f"workspaces/{e.entity_id}"
    return f"employees/{e.entity_id}"


def entity_root(entity: EntityRef) -> Path:
    return assets_root() / entity_relative_dir(entity.normalized())


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
        "- `workspaces/` — 工作区（项目）资产：standing / facts / episodic / craft\n"
    )


def workspace_entity_ref(workspace_path: str) -> EntityRef:
    """Map a bound project root to ``EntityRef(workspace, ws-{hash})``."""
    import hashlib

    from evoflow.persistence.workspace_repositories import normalize_workspace_path

    normalized = normalize_workspace_path(workspace_path)
    if not normalized:
        raise ValueError("workspace_path is required")
    resolved = str(Path(normalized).resolve())
    digest = hashlib.sha256(resolved.encode("utf-8")).hexdigest()[:32]
    return EntityRef("workspace", f"ws-{digest}").normalized()
