"""Load and validate Organization Pack manifests."""

from __future__ import annotations

import json
import logging
import re
import shutil
import tempfile
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

logger = logging.getLogger(__name__)

_MANIFEST_NAME = "evoflow.organization.json"
_ID_RE = re.compile(r"^[a-z][a-z0-9-]{1,63}$")
_KIND = frozenset({"team", "pipeline", "full"})


class PackManifestError(ValueError):
    """Invalid pack layout or manifest."""


@dataclass
class LoadedPack:
    root: Path
    manifest: dict[str, Any]
    cleanup_dirs: list[Path] = field(default_factory=list)

    @property
    def pack_id(self) -> str:
        return str(self.manifest.get("id") or "")

    @property
    def pack_version(self) -> str:
        return str(self.manifest.get("version") or "")

    @property
    def kind(self) -> str:
        return str(self.manifest.get("kind") or "")

    def cleanup(self) -> None:
        for d in self.cleanup_dirs:
            try:
                shutil.rmtree(d, ignore_errors=True)
            except Exception:
                logger.debug("pack cleanup failed path=%s", d, exc_info=True)


def _require_str(obj: dict[str, Any], key: str) -> str:
    val = str(obj.get(key) or "").strip()
    if not val:
        raise PackManifestError(f"manifest.{key} is required")
    return val


def validate_manifest(manifest: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(manifest, dict):
        raise PackManifestError("manifest must be a JSON object")
    if manifest.get("schema") != 1:
        raise PackManifestError("manifest.schema must be 1")
    kind = _require_str(manifest, "kind")
    if kind not in _KIND:
        raise PackManifestError(f"manifest.kind must be one of {sorted(_KIND)}")
    pack_id = _require_str(manifest, "id")
    if not _ID_RE.match(pack_id):
        raise PackManifestError(f"manifest.id invalid: {pack_id!r}")
    _require_str(manifest, "name")
    _require_str(manifest, "version")
    primitives = manifest.get("primitives")
    if not isinstance(primitives, dict):
        raise PackManifestError("manifest.primitives is required (object)")
    if kind in ("team", "full"):
        team = manifest.get("team")
        if not isinstance(team, dict) or not list(team.get("employees") or []):
            raise PackManifestError("kind team|full requires team.employees[]")
    if kind in ("pipeline", "full"):
        pipes = manifest.get("pipelines")
        if not isinstance(pipes, dict) or not list(pipes.get("apps") or []):
            raise PackManifestError("kind pipeline|full requires pipelines.apps[]")
    return manifest


def load_pack_manifest(pack_root: str | Path) -> LoadedPack:
    root = Path(pack_root).expanduser().resolve()
    if not root.is_dir():
        raise PackManifestError(f"Pack directory not found: {root}")
    path = root / _MANIFEST_NAME
    if not path.is_file():
        raise PackManifestError(f"Missing {_MANIFEST_NAME} under {root}")
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise PackManifestError(f"Invalid JSON in {_MANIFEST_NAME}: {e}") from e
    manifest = validate_manifest(raw)
    return LoadedPack(root=root, manifest=manifest)


def _find_manifest_root(extracted: Path) -> Path:
    direct = extracted / _MANIFEST_NAME
    if direct.is_file():
        return extracted
    candidates = [
        p.parent
        for p in extracted.rglob(_MANIFEST_NAME)
        if p.is_file() and ".obsidian" not in p.parts
    ]
    if len(candidates) == 1:
        return candidates[0]
    if not candidates:
        raise PackManifestError(f"Zip has no {_MANIFEST_NAME}")
    raise PackManifestError(f"Zip has multiple {_MANIFEST_NAME}; refuse to guess")


def load_pack_from_zip(zip_path: str | Path) -> LoadedPack:
    zp = Path(zip_path).expanduser().resolve()
    if not zp.is_file():
        raise PackManifestError(f"Zip not found: {zp}")
    tmp = Path(tempfile.mkdtemp(prefix="evoflow_org_pack_"))
    try:
        with zipfile.ZipFile(zp, "r") as zf:
            zf.extractall(tmp)
    except zipfile.BadZipFile as e:
        shutil.rmtree(tmp, ignore_errors=True)
        raise PackManifestError(f"Invalid zip: {e}") from e
    root = _find_manifest_root(tmp)
    loaded = load_pack_manifest(root)
    loaded.cleanup_dirs.append(tmp)
    return loaded


def load_pack_from_source(
    *,
    source_type: str,
    path: str | None = None,
    url: str | None = None,
    repo: str | None = None,
) -> LoadedPack:
    """Resolve install/preflight source: path | zip_path | zip_url | market_path."""
    st = str(source_type or "").strip().lower()
    if st == "path":
        if not path:
            raise PackManifestError("source.path is required for type=path")
        return load_pack_manifest(path)
    if st in ("zip_path", "zip"):
        if not path:
            raise PackManifestError("source.path is required for type=zip_path")
        return load_pack_from_zip(path)
    from evoflow.organizations.fetch import resolve_remote_source

    remote = resolve_remote_source(source_type=st, path=path, url=url, repo=repo)
    if remote is not None:
        return remote
    raise PackManifestError(f"Unknown source.type: {source_type!r}")


def resolve_pack_rel(pack: LoadedPack, rel: str) -> Path:
    text = str(rel or "").strip().replace("\\", "/")
    if not text or text.startswith("/") or ".." in Path(text).parts:
        raise PackManifestError(f"Unsafe relative path: {rel!r}")
    target = (pack.root / text).resolve()
    try:
        target.relative_to(pack.root.resolve())
    except ValueError as e:
        raise PackManifestError(f"Path escapes pack root: {rel}") from e
    return target


def load_agent_definition(pack: LoadedPack, from_path: str) -> dict[str, Any]:
    path = resolve_pack_rel(pack, from_path)
    if not path.is_file():
        raise PackManifestError(f"Agent file not found: {from_path}")
    if path.suffix.lower() in (".yaml", ".yml"):
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    elif path.suffix.lower() == ".json":
        data = json.loads(path.read_text(encoding="utf-8"))
    else:
        raise PackManifestError(f"Unsupported agent file type: {path.suffix}")
    if not isinstance(data, dict):
        raise PackManifestError(f"Agent definition must be an object: {from_path}")
    soul_file = str(data.get("system_prompt_file") or data.get("soul_file") or "").strip()
    if soul_file:
        soul_path = (path.parent / soul_file).resolve()
        try:
            soul_path.relative_to(pack.root.resolve())
        except ValueError as e:
            raise PackManifestError(f"soul file escapes pack: {soul_file}") from e
        if soul_path.is_file():
            data = {**data, "soul": soul_path.read_text(encoding="utf-8")}
            data.pop("system_prompt_file", None)
            data.pop("soul_file", None)
    return data


def load_json_ref(pack: LoadedPack, from_path: str) -> dict[str, Any]:
    path = resolve_pack_rel(pack, from_path)
    if not path.is_file():
        raise PackManifestError(f"File not found: {from_path}")
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise PackManifestError(f"Expected JSON object: {from_path}")
    return data


def apply_placeholders(text: str, *, org_workspace: str, org_root: str) -> str:
    s = str(text or "")
    return (
        s.replace("${ORG_WORKSPACE}", org_workspace or "")
        .replace("${ORG_ROOT}", org_root or "")
        .replace("${EVOFLOW_HOME}", str(Path.home() / ".evoflow"))
    )


def deep_apply_placeholders(obj: Any, *, org_workspace: str, org_root: str) -> Any:
    if isinstance(obj, str):
        return apply_placeholders(obj, org_workspace=org_workspace, org_root=org_root)
    if isinstance(obj, list):
        return [
            deep_apply_placeholders(x, org_workspace=org_workspace, org_root=org_root)
            for x in obj
        ]
    if isinstance(obj, dict):
        return {
            k: deep_apply_placeholders(v, org_workspace=org_workspace, org_root=org_root)
            for k, v in obj.items()
        }
    return obj
