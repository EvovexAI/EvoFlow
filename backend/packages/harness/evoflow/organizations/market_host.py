"""Local resource-market host: serve catalog + pack zips for LAN friends."""

from __future__ import annotations

import json
import logging
import re
import secrets
import shutil
import zipfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from evoflow.admin.ui_extensions_registry import config_dir
from evoflow.persistence import config_repositories as cfg_repo

logger = logging.getLogger(__name__)

_ENABLED_KEY = "resource_market.host.enabled"
_TOKEN_KEY = "resource_market.host.token"
_NAME_KEY = "resource_market.host.name"
_ID_RE = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")


def host_root() -> Path:
    root = config_dir() / "resource-market"
    root.mkdir(parents=True, exist_ok=True)
    (root / "packs").mkdir(parents=True, exist_ok=True)
    return root


def catalog_path() -> Path:
    return host_root() / "catalog.json"


def packs_dir() -> Path:
    return host_root() / "packs"


def is_host_enabled() -> bool:
    try:
        return str(cfg_repo.get_app_setting(_ENABLED_KEY) or "").strip() in ("1", "true", "True", "yes", "on")
    except Exception:
        return False


def set_host_enabled(enabled: bool) -> None:
    cfg_repo.set_app_setting(_ENABLED_KEY, "1" if enabled else "0")


def get_host_token() -> str:
    try:
        return str(cfg_repo.get_app_setting(_TOKEN_KEY) or "").strip()
    except Exception:
        return ""


def set_host_token(token: str | None) -> str:
    """Set token; empty clears. ``None`` generates a new random token."""
    if token is None:
        tok = secrets.token_urlsafe(18)
    else:
        tok = str(token).strip()
    cfg_repo.set_app_setting(_TOKEN_KEY, tok)
    return tok


def get_host_name() -> str:
    try:
        name = str(cfg_repo.get_app_setting(_NAME_KEY) or "").strip()
    except Exception:
        name = ""
    return name or "本机资源市场"


def set_host_name(name: str) -> str:
    n = str(name or "").strip() or "本机资源市场"
    cfg_repo.set_app_setting(_NAME_KEY, n)
    return n


def _utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _read_catalog() -> dict[str, Any]:
    path = catalog_path()
    if not path.is_file():
        return {
            "schema": 1,
            "marketId": "local-host",
            "name": get_host_name(),
            "updatedAt": None,
            "packs": [],
        }
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        data = {}
    if not isinstance(data, dict):
        data = {}
    data.setdefault("schema", 1)
    data.setdefault("marketId", "local-host")
    data.setdefault("name", get_host_name())
    if not isinstance(data.get("packs"), list):
        data["packs"] = []
    return data


def _write_catalog(data: dict[str, Any]) -> dict[str, Any]:
    data = dict(data)
    data["schema"] = 1
    data["marketId"] = str(data.get("marketId") or "local-host")
    data["name"] = get_host_name()
    data["updatedAt"] = _utc_now()
    if not isinstance(data.get("packs"), list):
        data["packs"] = []
    path = catalog_path()
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)
    return data


def public_catalog(*, base_url: str) -> dict[str, Any]:
    """Catalog with absolute download.zip_url for each pack."""
    base = str(base_url or "").rstrip("/")
    data = _read_catalog()
    packs_out: list[dict[str, Any]] = []
    for raw in data.get("packs") or []:
        if not isinstance(raw, dict):
            continue
        p = dict(raw)
        pid = str(p.get("id") or "").strip()
        if not pid:
            continue
        zip_name = f"{pid}.zip"
        zip_path = packs_dir() / zip_name
        if not zip_path.is_file():
            # Skip unpublished / missing artifacts
            continue
        p["path"] = p.get("path") or f"packs/{pid}"
        zip_url = f"{base}/api/resource-market/packs/{pid}.zip"
        # If host has a token, embed it so catalog consumers can download without
        # a separate Authorization header (share-link / browser / curl friendly).
        tok = get_host_token()
        if tok:
            zip_url = f"{zip_url}?token={tok}"
        p["download"] = {
            "type": "zip_url",
            "url": zip_url,
        }
        packs_out.append(p)
    data["packs"] = packs_out
    data["source"] = f"{base}/api/resource-market/catalog.json"
    data["configured"] = True
    return data


def list_local_packs() -> list[dict[str, Any]]:
    data = _read_catalog()
    out = []
    for raw in data.get("packs") or []:
        if not isinstance(raw, dict):
            continue
        p = dict(raw)
        pid = str(p.get("id") or "").strip()
        zip_path = packs_dir() / f"{pid}.zip"
        p["zip_exists"] = zip_path.is_file()
        if zip_path.is_file():
            p["zip_bytes"] = zip_path.stat().st_size
        out.append(p)
    return out


def resolve_pack_zip(pack_id: str) -> Path | None:
    pid = str(pack_id or "").strip()
    if not pid or ".." in pid or "/" in pid or "\\" in pid:
        return None
    if not _ID_RE.match(pid) and not re.match(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$", pid):
        return None
    path = packs_dir() / f"{pid}.zip"
    return path if path.is_file() else None


def _zip_directory(src_dir: Path, dest_zip: Path) -> None:
    """Zip pack source for market publish, applying :mod:`pack_zip_ignore` rules."""
    from evoflow.organizations.pack_zip_ignore import iter_pack_files

    dest_zip.parent.mkdir(parents=True, exist_ok=True)
    # Unique tmp avoids WinError 32 when a prior publish left a locked .zip.tmp
    import time
    import uuid

    tmp = dest_zip.parent / f"{dest_zip.stem}.{uuid.uuid4().hex[:8]}.zip.tmp"
    stale = dest_zip.with_suffix(".zip.tmp")
    if stale.exists():
        try:
            stale.unlink()
        except OSError:
            logger.debug("could not remove stale zip.tmp: %s", stale, exc_info=True)
    files = iter_pack_files(src_dir)
    with zipfile.ZipFile(tmp, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for path in files:
            zf.write(path, path.relative_to(src_dir).as_posix())
    logger.info(
        "pack zip wrote files=%s src=%s dest=%s",
        len(files),
        src_dir,
        dest_zip.name,
    )
    last_err: OSError | None = None
    for attempt in range(5):
        try:
            tmp.replace(dest_zip)
            return
        except OSError as e:
            last_err = e
            time.sleep(0.4 * (attempt + 1))
    if last_err:
        raise last_err


def publish_pack(
    *,
    source_path: str,
    pack_meta: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Publish a local org pack dir or zip into the host catalog.

    ``source_path``: directory containing ``evoflow.organization.json``, or a ``.zip``.
    """
    src = Path(str(source_path or "")).expanduser()
    if not src.exists():
        raise ValueError(f"source not found: {src}")

    meta = dict(pack_meta or {})
    manifest: dict[str, Any] = {}
    work_zip: Path | None = None

    if src.is_file() and src.suffix.lower() == ".zip":
        work_zip = src
        # Try read pack id/name from zip root manifest
        try:
            with zipfile.ZipFile(src, "r") as zf:
                names = zf.namelist()
                cand = None
                for n in names:
                    if n.replace("\\", "/").endswith("evoflow.organization.json"):
                        cand = n
                        break
                if cand:
                    manifest = json.loads(zf.read(cand).decode("utf-8"))
        except Exception as e:
            logger.debug("publish: could not read zip manifest: %s", e)
    elif src.is_dir():
        man = src / "evoflow.organization.json"
        if not man.is_file():
            raise ValueError("directory must contain evoflow.organization.json")
        manifest = json.loads(man.read_text(encoding="utf-8"))
    else:
        raise ValueError("source_path must be a pack directory or .zip")

    pack_block = manifest.get("pack") if isinstance(manifest.get("pack"), dict) else {}
    pid = str(meta.get("id") or pack_block.get("id") or manifest.get("id") or "").strip()
    if not pid:
        raise ValueError("pack id is required")
    if not _ID_RE.match(pid):
        # allow slightly looser ids from existing exports
        if not re.match(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$", pid):
            raise ValueError(f"invalid pack id: {pid}")

    # Prefer nested pack{} (exports), then top-level fields (showcase org manifests).
    name = str(
        meta.get("name") or pack_block.get("name") or manifest.get("name") or pid
    ).strip() or pid
    version = str(
        meta.get("version") or pack_block.get("version") or manifest.get("version") or "1.0.0"
    ).strip() or "1.0.0"
    description = str(
        meta.get("description")
        or pack_block.get("description")
        or manifest.get("description")
        or ""
    ).strip()
    kind = str(
        meta.get("kind") or pack_block.get("kind") or manifest.get("kind") or ""
    ).strip() or None
    tags = meta.get("tags") if isinstance(meta.get("tags"), list) else None
    if tags is None:
        tags = pack_block.get("tags") if isinstance(pack_block.get("tags"), list) else manifest.get("tags")
    if not isinstance(tags, list):
        tags = []

    dest = packs_dir() / f"{pid}.zip"
    if work_zip is not None:
        shutil.copy2(work_zip, dest)
    else:
        _zip_directory(src, dest)

    entry = {
        "id": pid,
        "name": name,
        "version": version,
        "description": description,
        "kind": kind,
        "tags": [str(t) for t in tags if str(t).strip()],
        "path": f"packs/{pid}",
        "updatedAt": _utc_now(),
        "author": str(meta.get("author") or "").strip() or None,
    }
    # Drop null author
    if not entry["author"]:
        entry.pop("author", None)
    if not entry["kind"]:
        entry.pop("kind", None)

    catalog = _read_catalog()
    packs = [p for p in (catalog.get("packs") or []) if isinstance(p, dict) and str(p.get("id")) != pid]
    packs.insert(0, entry)
    catalog["packs"] = packs
    _write_catalog(catalog)

    # Auto-enable host so publish is immediately shareable
    if not is_host_enabled():
        set_host_enabled(True)

    return {
        "ok": True,
        "pack": entry,
        "zip_path": str(dest),
        "zip_bytes": dest.stat().st_size if dest.is_file() else 0,
        "host_enabled": is_host_enabled(),
    }


def unpublish_pack(pack_id: str) -> dict[str, Any]:
    pid = str(pack_id or "").strip()
    if not pid:
        raise ValueError("pack id required")
    catalog = _read_catalog()
    before = len(catalog.get("packs") or [])
    catalog["packs"] = [
        p for p in (catalog.get("packs") or []) if not (isinstance(p, dict) and str(p.get("id")) == pid)
    ]
    _write_catalog(catalog)
    zip_path = packs_dir() / f"{pid}.zip"
    removed_zip = False
    if zip_path.is_file():
        zip_path.unlink()
        removed_zip = True
    return {
        "ok": True,
        "removed": before - len(catalog.get("packs") or []),
        "removed_zip": removed_zip,
    }


def host_status(*, gateway_port: int | None = None, request_base: str | None = None) -> dict[str, Any]:
    from evoflow.webui.auth import get_lan_access_urls, get_webui_access_port

    enabled = is_host_enabled()
    token = get_host_token()
    port = gateway_port
    if port is None:
        try:
            port = get_webui_access_port()
        except Exception:
            port = 8382
    bases = []
    if request_base:
        bases.append(str(request_base).rstrip("/"))
    try:
        for u in get_lan_access_urls(int(port or 8382)):
            bases.append(str(u).rstrip("/"))
    except Exception:
        pass
    # de-dupe
    seen: set[str] = set()
    uniq_bases: list[str] = []
    for b in bases:
        if b and b not in seen:
            seen.add(b)
            uniq_bases.append(b)

    share_urls = []
    for b in uniq_bases:
        cat = f"{b}/api/resource-market/catalog.json"
        if token:
            cat = f"{cat}?token={token}"
        share_urls.append(cat)

    return {
        "enabled": enabled,
        "name": get_host_name(),
        "token_set": bool(token),
        "token": token if token else None,
        "packs": list_local_packs(),
        "catalog_path": str(catalog_path()),
        "share_urls": share_urls,
        "gateway_port": port,
    }


def check_host_token(provided: str | None) -> bool:
    """Return True if request is allowed. Empty host token → open access."""
    expected = get_host_token()
    if not expected:
        return True
    got = str(provided or "").strip()
    return bool(got) and secrets.compare_digest(got, expected)
