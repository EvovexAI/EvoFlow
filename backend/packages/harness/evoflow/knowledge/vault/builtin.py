"""System-builtin Obsidian Knowledge Vaults.

1. **用户指南** — SSOT EvoFlow ``docs/user/`` (packaged under ``user-guide/``), read-only.
2. **运营知识库** — SSOT ContentOS ``docs/智能内容运营平台/知识库/``
   (optional packaged snapshot under ``ops-knowledge/``), read-write.

On Gateway startup we register both so 小V / ``knowledge`` tools can search them.
Dev checkouts point 运营知识库 at the live ContentOS tree (sibling checkout).
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import shutil
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

BUILTIN_USER_GUIDE_VAULT_ID = "evoflow-user-guide"
BUILTIN_USER_GUIDE_VAULT_NAME = "EvoFlow 用户指南"

BUILTIN_OPS_KNOWLEDGE_VAULT_ID = "evoflow-ops-knowledge"
BUILTIN_OPS_KNOWLEDGE_VAULT_NAME = "运营知识库"

BUILTIN_ASSET_VAULT_ID = "evoflow-assets"
BUILTIN_ASSET_VAULT_NAME = "EvoFlow 资产中心"

_SOURCE_MARKER = ".vault_source"
_ASSET_USER_GUIDE = Path("assets") / "builtin_knowledge_vaults" / "user-guide"
_ASSET_OPS_KNOWLEDGE = Path("assets") / "builtin_knowledge_vaults" / "ops-knowledge"
_SKIP_COPY_NAMES = {
    ".obsidian-hybrid-search.db",
    ".obsidian-hybrid-search.db-shm",
    ".obsidian-hybrid-search.db-wal",
    ".vault_source",
    ".DS_Store",
    "Thumbs.db",
}
_COPY_SUFFIXES = {
    ".md",
    ".markdown",
    ".mdx",
    ".txt",
    ".json",
    ".yml",
    ".yaml",
    ".svg",
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".gif",
}


def _paths():
    from evoflow.config.paths import get_paths

    return get_paths()


def builtin_vault_ids() -> frozenset[str]:
    return frozenset(
        {
            BUILTIN_USER_GUIDE_VAULT_ID,
            BUILTIN_OPS_KNOWLEDGE_VAULT_ID,
            BUILTIN_ASSET_VAULT_ID,
        }
    )


def is_builtin_vault_id(vault_id: str | None) -> bool:
    return str(vault_id or "").strip() in builtin_vault_ids()


def _package_asset_root() -> Path:
    # evoflow/knowledge/vault/builtin.py → evoflow/
    return Path(__file__).resolve().parent.parent.parent


def _repo_docs_subdir(name: str) -> Path | None:
    """Dev checkout fallback: locate ``docs/<name>`` next to the monorepo root."""
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "docs" / name
        if candidate.is_dir() and _tree_has_notes(candidate):
            return candidate
        if (parent / "mkdocs.yml").is_file() and candidate.is_dir():
            return candidate if _tree_has_notes(candidate) else None
    return None


def _repo_docs_user() -> Path | None:
    return _repo_docs_subdir("user")


def _evoflow_repo_root() -> Path | None:
    """Locate EvoFlow repo root (has ``docs/user`` + ``backend``)."""
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / "docs" / "user").is_dir() and (parent / "backend").is_dir():
            return parent
    return None


def _contentos_ops_knowledge_rel() -> Path:
    return Path("docs") / "智能内容运营平台" / "知识库"


def contentos_ops_knowledge_src() -> Path | None:
    """Live ContentOS 运营知识库 SSOT (preferred for editing + reading).

    Resolution order:
    1. ``EVOFLOW_OPS_KNOWLEDGE_ROOT`` or ``CONTENTOS_KNOWLEDGE_ROOT``
    2. Sibling ``../ContentOS/...`` or ``../evo/ContentOS/...`` next to EvoFlow
    3. ``CONTENTOS_ROOT`` / docs/...
    """
    for key in ("EVOFLOW_OPS_KNOWLEDGE_ROOT", "CONTENTOS_KNOWLEDGE_ROOT"):
        raw = (os.environ.get(key) or "").strip()
        if raw:
            candidate = Path(raw).expanduser()
            if _tree_has_notes(candidate):
                return candidate.resolve()

    evo = _evoflow_repo_root()
    if evo is not None:
        # Prefer sibling checkout; also accept evo/ContentOS (gradual workspace layout).
        for cos in (
            evo.parent / "ContentOS",
            evo.parent / "evo" / "ContentOS",
        ):
            sibling = cos / _contentos_ops_knowledge_rel()
            if _tree_has_notes(sibling):
                return sibling.resolve()

    cos_root = (os.environ.get("CONTENTOS_ROOT") or "").strip()
    if cos_root:
        candidate = Path(cos_root).expanduser() / _contentos_ops_knowledge_rel()
        if _tree_has_notes(candidate):
            return candidate.resolve()

    return None


def bundled_user_guide_src() -> Path | None:
    """Return the packaged (or repo) markdown tree used as the product vault source."""
    packaged = _package_asset_root() / _ASSET_USER_GUIDE
    if _tree_has_notes(packaged):
        return packaged
    repo = _repo_docs_user()
    if repo is not None and _tree_has_notes(repo):
        return repo
    return None


def bundled_ops_knowledge_src() -> Path | None:
    """Packaged snapshot of 运营知识库 (shipped builds), else ContentOS live tree."""
    packaged = _package_asset_root() / _ASSET_OPS_KNOWLEDGE
    if _tree_has_notes(packaged):
        return packaged
    return contentos_ops_knowledge_src()


def _tree_has_notes(root: Path) -> bool:
    if not root.is_dir():
        return False
    try:
        for p in root.rglob("*.md"):
            if p.is_file():
                return True
    except OSError:
        return False
    return False


def materialized_user_guide_dir() -> Path:
    return _paths().base_dir / "knowledge" / "vaults" / BUILTIN_USER_GUIDE_VAULT_ID


def materialized_ops_knowledge_dir() -> Path:
    return _paths().base_dir / "knowledge" / "vaults" / BUILTIN_OPS_KNOWLEDGE_VAULT_ID


def _iter_source_files(src: Path) -> list[Path]:
    out: list[Path] = []
    for p in src.rglob("*"):
        if not p.is_file():
            continue
        if p.name in _SKIP_COPY_NAMES:
            continue
        if ".obsidian" in p.parts:
            continue
        if p.suffix.lower() not in _COPY_SUFFIXES and p.name.lower() != "license":
            continue
        out.append(p)
    return sorted(out)


def _content_fingerprint(src: Path) -> str:
    h = hashlib.sha256()
    for p in _iter_source_files(src):
        rel = p.relative_to(src).as_posix().encode("utf-8")
        h.update(rel)
        h.update(b"\0")
        try:
            h.update(p.read_bytes())
        except OSError:
            continue
        h.update(b"\0")
    return h.hexdigest()


def _read_source_marker(dest: Path) -> str | None:
    marker = dest / _SOURCE_MARKER
    if not marker.is_file():
        return None
    try:
        return marker.read_text(encoding="utf-8").strip() or None
    except OSError:
        return None


def _write_source_marker(dest: Path, fingerprint: str) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    tmp = dest / f".{_SOURCE_MARKER}.tmp"
    tmp.write_text(f"bundled:{fingerprint}\n", encoding="utf-8")
    tmp.replace(dest / _SOURCE_MARKER)


def _ensure_obsidian_marker(dest: Path) -> None:
    obsidian = dest / ".obsidian"
    obsidian.mkdir(parents=True, exist_ok=True)
    app = obsidian / "app.json"
    if not app.is_file():
        app.write_text(
            json.dumps({"legacyEditor": False, "livePreview": True}, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    cfg = obsidian / "appearance.json"
    if not cfg.is_file():
        cfg.write_text("{}\n", encoding="utf-8")


def _sync_tree(src: Path, dest: Path) -> int:
    """Copy product notes into dest. Returns number of files written/updated."""
    dest.mkdir(parents=True, exist_ok=True)
    written = 0
    keep: set[Path] = set()
    for src_file in _iter_source_files(src):
        rel = src_file.relative_to(src)
        target = dest / rel
        keep.add(target.resolve())
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            if target.is_file() and target.stat().st_size == src_file.stat().st_size:
                if target.read_bytes() == src_file.read_bytes():
                    continue
        except OSError:
            pass
        shutil.copy2(src_file, target)
        written += 1

    for existing in dest.rglob("*"):
        if not existing.is_file():
            continue
        if ".obsidian" in existing.parts:
            continue
        if existing.name in _SKIP_COPY_NAMES or existing.name == _SOURCE_MARKER:
            continue
        if existing.resolve() not in keep:
            try:
                existing.unlink()
            except OSError:
                logger.debug("failed to remove stale vault file %s", existing, exc_info=True)
    return written


def materialize_user_guide_vault(*, force: bool = False) -> Path | None:
    """Copy packaged ``docs/user`` into EVOFLOW_HOME and stamp a source marker.

    Returns the destination path, or ``None`` if the bundled source is missing.
    When the source fingerprint changes (new app version with updated docs),
    files are re-synced so existing installs pick up guide updates.
    """
    result = materialize_user_guide_vault_result(force=force)
    return result.get("path")


def materialize_user_guide_vault_result(*, force: bool = False) -> dict[str, Any]:
    """Like ``materialize_user_guide_vault`` but also reports whether content changed."""
    src = bundled_user_guide_src()
    if src is None:
        logger.warning("builtin user-guide vault source missing (docs/user not packaged)")
        return {"path": None, "contentUpdated": False, "filesUpdated": 0, "reason": "source_missing"}
    dest = materialized_user_guide_dir()
    fingerprint = _content_fingerprint(src)
    marker = _read_source_marker(dest)
    if not force and marker == f"bundled:{fingerprint}" and _tree_has_notes(dest):
        _ensure_obsidian_marker(dest)
        return {
            "path": dest,
            "contentUpdated": False,
            "filesUpdated": 0,
            "fingerprint": fingerprint,
        }

    written = _sync_tree(src, dest)
    _ensure_obsidian_marker(dest)
    _write_source_marker(dest, fingerprint)
    logger.info(
        "materialized builtin user-guide vault dest=%s files_updated=%s src=%s",
        dest,
        written,
        src,
    )
    return {
        "path": dest,
        "contentUpdated": True,
        "filesUpdated": written,
        "fingerprint": fingerprint,
    }


def resolve_ops_knowledge_vault_path(*, force_materialize: bool = False) -> Path | None:
    result = resolve_ops_knowledge_vault_path_result(force_materialize=force_materialize)
    return result.get("path")


def resolve_ops_knowledge_vault_path_result(*, force_materialize: bool = False) -> dict[str, Any]:
    """Prefer live ContentOS 知识库; else materialize packaged snapshot.

    Writing stays in ContentOS; EvoFlow only mounts the path as builtin Vault.
    Live ContentOS trees are never copied — ``contentUpdated`` is False (index
    freshness is the operator's responsibility / write-path auto-reindex).
    """
    if not force_materialize:
        live = contentos_ops_knowledge_src()
        if live is not None:
            _ensure_obsidian_marker(live)
            return {
                "path": live.resolve(),
                "contentUpdated": False,
                "filesUpdated": 0,
                "live": True,
            }

    src = bundled_ops_knowledge_src()
    if src is None:
        logger.warning(
            "builtin ops-knowledge vault source missing "
            "(ContentOS 知识库 not found; set EVOFLOW_OPS_KNOWLEDGE_ROOT)"
        )
        return {"path": None, "contentUpdated": False, "filesUpdated": 0, "reason": "source_missing"}

    dest = materialized_ops_knowledge_dir()
    try:
        if src.resolve() == dest.resolve():
            _ensure_obsidian_marker(dest)
            return {"path": dest, "contentUpdated": False, "filesUpdated": 0, "live": False}
        # Live ContentOS path returned above; if bundled_ops still points at live, use it.
        live = contentos_ops_knowledge_src()
        if live is not None and src.resolve() == live.resolve():
            _ensure_obsidian_marker(live)
            return {
                "path": live.resolve(),
                "contentUpdated": False,
                "filesUpdated": 0,
                "live": True,
            }
    except OSError:
        pass

    fingerprint = _content_fingerprint(src)
    marker = _read_source_marker(dest)
    if marker == f"bundled:{fingerprint}" and _tree_has_notes(dest):
        _ensure_obsidian_marker(dest)
        return {
            "path": dest,
            "contentUpdated": False,
            "filesUpdated": 0,
            "fingerprint": fingerprint,
            "live": False,
        }

    written = _sync_tree(src, dest)
    _ensure_obsidian_marker(dest)
    _write_source_marker(dest, fingerprint)
    logger.info(
        "materialized builtin ops-knowledge vault dest=%s files_updated=%s src=%s",
        dest,
        written,
        src,
    )
    return {
        "path": dest,
        "contentUpdated": True,
        "filesUpdated": written,
        "fingerprint": fingerprint,
        "live": False,
    }


def _ignore_patterns() -> str:
    from evoflow.knowledge.vault.constants import DEFAULT_IGNORE_PATTERNS

    ignore = DEFAULT_IGNORE_PATTERNS
    if "*.db" not in ignore:
        ignore = f"{ignore},*.db,*.db-*"
    return ignore


def _builtin_assets_config(vault_path: str) -> dict[str, Any]:
    from evoflow.knowledge.vault.models import AccessMode, EmbeddingMode, LaunchMode, ProviderType

    return {
        "id": BUILTIN_ASSET_VAULT_ID,
        "name": BUILTIN_ASSET_VAULT_NAME,
        "enabled": True,
        "builtin": True,
        "providerType": ProviderType.obsidian.value,
        "vaultPath": vault_path,
        "accessMode": AccessMode.read_write.value,
        "launchMode": LaunchMode.managed_stdio.value,
        "embeddingMode": EmbeddingMode.local.value,
        "ignorePatterns": _ignore_patterns(),
        "allowedReadPaths": ["*"],
        "allowedWritePaths": ["*"],
        "autoReindex": True,
        "respectGitignore": True,
    }


def ensure_builtin_asset_vault() -> dict[str, Any]:
    """Register the Entity Asset Hub tree as a builtin read-write vault."""
    from evoflow.assets.hub import ensure_assets_tree, materialized_assets_vault_dir
    from evoflow.knowledge.vault.models import AccessMode

    ensure_assets_tree()
    vault_path = str(materialized_assets_vault_dir())
    return _upsert_builtin_vault(
        vault_id=BUILTIN_ASSET_VAULT_ID,
        vault_name=BUILTIN_ASSET_VAULT_NAME,
        vault_path=vault_path,
        desired=_builtin_assets_config(vault_path),
        forced_access_mode=AccessMode.read_write.value,
    )


def _builtin_user_guide_config(vault_path: str) -> dict[str, Any]:
    from evoflow.knowledge.vault.models import AccessMode, EmbeddingMode, LaunchMode, ProviderType

    return {
        "id": BUILTIN_USER_GUIDE_VAULT_ID,
        "name": BUILTIN_USER_GUIDE_VAULT_NAME,
        "enabled": True,
        "builtin": True,
        "providerType": ProviderType.obsidian.value,
        "vaultPath": vault_path,
        "accessMode": AccessMode.read_only.value,
        "launchMode": LaunchMode.managed_stdio.value,
        "embeddingMode": EmbeddingMode.local.value,
        "ignorePatterns": _ignore_patterns(),
        "allowedReadPaths": ["*"],
        "allowedWritePaths": [],
        "autoReindex": True,
        "respectGitignore": True,
    }


def _builtin_ops_knowledge_config(vault_path: str) -> dict[str, Any]:
    from evoflow.knowledge.vault.models import AccessMode, EmbeddingMode, LaunchMode, ProviderType

    return {
        "id": BUILTIN_OPS_KNOWLEDGE_VAULT_ID,
        "name": BUILTIN_OPS_KNOWLEDGE_VAULT_NAME,
        "enabled": True,
        "builtin": True,
        "providerType": ProviderType.obsidian.value,
        "vaultPath": vault_path,
        "accessMode": AccessMode.read_write.value,
        "launchMode": LaunchMode.managed_stdio.value,
        "embeddingMode": EmbeddingMode.local.value,
        "ignorePatterns": _ignore_patterns(),
        "allowedReadPaths": ["*"],
        "allowedWritePaths": ["*"],
        "autoReindex": True,
        "respectGitignore": True,
    }


def _upsert_builtin_vault(
    *,
    vault_id: str,
    vault_name: str,
    vault_path: str,
    desired: dict[str, Any],
    forced_access_mode: str,
) -> dict[str, Any]:
    from evoflow.knowledge.vault import store as vault_store
    from evoflow.knowledge.vault.models import KnowledgeVaultConfig

    existing = vault_store.get_vault_config(vault_id)
    if existing is None:
        cfg = KnowledgeVaultConfig.model_validate(desired)
        vault_store.upsert_vault_config(cfg)
        logger.info("registered builtin knowledge vault id=%s path=%s", vault_id, vault_path)
        return {"ok": True, "action": "created", "vaultId": vault_id, "vaultPath": vault_path}

    data = existing.model_dump(by_alias=True, mode="json")
    changed = False
    if not bool(data.get("builtin")):
        data["builtin"] = True
        changed = True
    if str(data.get("vaultPath") or "").strip() != vault_path:
        data["vaultPath"] = vault_path
        changed = True
    if str(data.get("accessMode") or "") != forced_access_mode:
        data["accessMode"] = forced_access_mode
        changed = True
    if str(data.get("name") or "").strip() != vault_name:
        data["name"] = vault_name
        changed = True
    if "enabled" not in data:
        data["enabled"] = True
        changed = True
    if forced_access_mode == "read_write":
        writes = data.get("allowedWritePaths")
        if not isinstance(writes, list) or not writes:
            data["allowedWritePaths"] = ["*"]
            changed = True
    if changed:
        vault_store.upsert_vault_config(KnowledgeVaultConfig.model_validate(data))
        logger.info("healed builtin knowledge vault id=%s", vault_id)
        return {"ok": True, "action": "healed", "vaultId": vault_id, "vaultPath": vault_path}

    return {"ok": True, "action": "unchanged", "vaultId": vault_id, "vaultPath": vault_path}


def ensure_builtin_knowledge_vaults() -> dict[str, Any]:
    """Idempotent: register user-guide (read-only) + 运营知识库 (read-write).

    When packaged guide content changes (new app version), markdown under
    ``EVOFLOW_HOME`` is re-synced. Callers should reindex vaults listed in
    ``needsReindex`` so search reflects the update.
    """
    from evoflow.knowledge.vault.models import AccessMode

    results: list[dict[str, Any]] = []
    needs_reindex: list[str] = []

    user_mat = materialize_user_guide_vault_result()
    dest = user_mat.get("path")
    if dest is None:
        user = {"ok": False, "reason": "source_missing", "vaultId": BUILTIN_USER_GUIDE_VAULT_ID}
    else:
        vault_path = str(Path(dest).resolve())
        user = _upsert_builtin_vault(
            vault_id=BUILTIN_USER_GUIDE_VAULT_ID,
            vault_name=BUILTIN_USER_GUIDE_VAULT_NAME,
            vault_path=vault_path,
            desired=_builtin_user_guide_config(vault_path),
            forced_access_mode=AccessMode.read_only.value,
        )
        user["contentUpdated"] = bool(user_mat.get("contentUpdated"))
        user["filesUpdated"] = int(user_mat.get("filesUpdated") or 0)
        # First create or content sync → search index must refresh.
        if user.get("action") == "created" or user_mat.get("contentUpdated"):
            needs_reindex.append(BUILTIN_USER_GUIDE_VAULT_ID)
    results.append(user)

    ops_mat = resolve_ops_knowledge_vault_path_result()
    ops_dest = ops_mat.get("path")
    if ops_dest is None:
        ops = {"ok": False, "reason": "source_missing", "vaultId": BUILTIN_OPS_KNOWLEDGE_VAULT_ID}
    else:
        ops_path = str(Path(ops_dest).resolve())
        ops = _upsert_builtin_vault(
            vault_id=BUILTIN_OPS_KNOWLEDGE_VAULT_ID,
            vault_name=BUILTIN_OPS_KNOWLEDGE_VAULT_NAME,
            vault_path=ops_path,
            desired=_builtin_ops_knowledge_config(ops_path),
            forced_access_mode=AccessMode.read_write.value,
        )
        ops["contentUpdated"] = bool(ops_mat.get("contentUpdated"))
        ops["filesUpdated"] = int(ops_mat.get("filesUpdated") or 0)
        ops["live"] = bool(ops_mat.get("live"))
        if ops.get("action") == "created" or ops_mat.get("contentUpdated"):
            needs_reindex.append(BUILTIN_OPS_KNOWLEDGE_VAULT_ID)
    results.append(ops)

    assets_result = ensure_builtin_asset_vault()
    assets_result["contentUpdated"] = False
    assets_result["filesUpdated"] = 0
    results.append(assets_result)
    if assets_result.get("action") == "created":
        needs_reindex.append(BUILTIN_ASSET_VAULT_ID)

    any_ok = any(bool(r.get("ok")) for r in results)
    # Backward-compatible top-level fields still describe the user-guide vault.
    out: dict[str, Any] = {
        "ok": any_ok,
        "vaults": results,
        "needsReindex": needs_reindex,
        "action": user.get("action") or user.get("reason") or "missing",
        "vaultId": BUILTIN_USER_GUIDE_VAULT_ID,
        "vaultPath": user.get("vaultPath"),
        "contentUpdated": bool(user.get("contentUpdated")),
    }
    if not any_ok:
        out["reason"] = "source_missing"
    return out


async def schedule_builtin_vault_reindex(vault_ids: list[str] | None = None) -> list[dict[str, Any]]:
    """Start background reindex jobs for builtin vaults whose content just changed."""
    from evoflow.knowledge.vault import store as vault_store
    from evoflow.knowledge.vault.reindex_jobs import start_reindex_job

    ids = [str(x).strip() for x in (vault_ids or []) if str(x).strip()]
    started: list[dict[str, Any]] = []
    for vault_id in ids:
        if not is_builtin_vault_id(vault_id):
            continue
        cfg = vault_store.get_vault_config(vault_id)
        if cfg is None or not cfg.enabled:
            continue
        try:
            job = await start_reindex_job(
                vault_id,
                vault_path=cfg.vault_path,
                path=None,
                force=True,
                # Packaged desktop builds do not embed kb-mcp; always allow install
                # when missing (start_reindex_job also auto-enables if not ready).
                run_install=True,
            )
            started.append({"vaultId": vault_id, "jobId": job.job_id, "ok": True})
            logger.info("scheduled reindex for updated builtin vault id=%s job=%s", vault_id, job.job_id)
        except Exception as exc:
            logger.warning("failed to schedule builtin vault reindex id=%s: %s", vault_id, exc)
            started.append({"vaultId": vault_id, "ok": False, "error": str(exc)})
    return started
