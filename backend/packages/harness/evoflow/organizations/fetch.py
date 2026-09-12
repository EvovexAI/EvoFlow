"""Download Organization Packs from zip URL or GitHub market repo."""

from __future__ import annotations

import logging
import os
import re
import shutil
import tempfile
import zipfile
from pathlib import Path
from typing import Any
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from evoflow.organizations.manifest import LoadedPack, PackManifestError, load_pack_from_zip, load_pack_manifest

logger = logging.getLogger(__name__)

# Official public market index (override with EVOFLOW_RESOURCE_MARKET_CATALOG_URL;
# set the env to empty string to disable remote market).
DEFAULT_MARKET_CATALOG_URL = (
    "https://raw.githubusercontent.com/EvovexAI/evoflow-resource-market/main/catalog.json"
)

_RAW_GH = re.compile(
    r"^https?://raw\.githubusercontent\.com/(?P<owner>[^/]+)/(?P<repo>[^/]+)/(?P<rest>.+)$",
    re.I,
)


def market_catalog_url() -> str:
    if "EVOFLOW_RESOURCE_MARKET_CATALOG_URL" in os.environ:
        return str(os.environ.get("EVOFLOW_RESOURCE_MARKET_CATALOG_URL") or "").strip()
    return DEFAULT_MARKET_CATALOG_URL


def parse_github_raw_repo(catalog_url: str) -> dict[str, str] | None:
    """Parse owner/repo/branch from a raw.githubusercontent.com catalog URL."""
    m = _RAW_GH.match(str(catalog_url or "").strip())
    if not m:
        return None
    owner, repo, rest = m.group("owner"), m.group("repo"), m.group("rest")
    parts = rest.strip("/").split("/")
    if not parts:
        return None
    # refs/heads/<branch>/...  or  <branch>/...
    if len(parts) >= 3 and parts[0] == "refs" and parts[1] == "heads":
        branch = parts[2]
    else:
        branch = parts[0]
    return {"owner": owner, "repo": repo, "branch": branch}


def _download_bytes(url: str, *, timeout: int = 60) -> bytes:
    req = Request(url, headers={"User-Agent": "EvoFlow-OrgPack/1.0"})
    with urlopen(req, timeout=timeout) as resp:  # noqa: S310 — caller-controlled market/zip URL
        return resp.read()


def load_pack_from_zip_url(url: str) -> LoadedPack:
    u = str(url or "").strip()
    if not u:
        raise PackManifestError("zip_url is required")
    parsed = urlparse(u)
    if parsed.scheme not in ("http", "https"):
        raise PackManifestError("zip_url must be http(s)")
    tmp = Path(tempfile.mkdtemp(prefix="evoflow_org_zipurl_"))
    zip_path = tmp / "pack.zip"
    try:
        zip_path.write_bytes(_download_bytes(u))
        loaded = load_pack_from_zip(zip_path)
        loaded.cleanup_dirs.append(tmp)
        return loaded
    except Exception:
        shutil.rmtree(tmp, ignore_errors=True)
        raise


def load_pack_from_market_path(
    rel_path: str,
    *,
    repo: str | None = None,
    catalog_url: str | None = None,
) -> LoadedPack:
    """Download a pack subfolder from the configured GitHub market repo.

    Uses GitHub codeload zipball, then extracts ``rel_path`` (e.g. ``packs/content-ops-org``).
    """
    path = str(rel_path or "").strip().replace("\\", "/").lstrip("/")
    if not path or ".." in Path(path).parts:
        raise PackManifestError(f"Invalid market path: {rel_path!r}")

    cat = str(catalog_url or market_catalog_url() or "").strip()
    info = parse_github_raw_repo(cat) if cat else None
    if repo:
        # optional override "owner/repo@branch"
        m = re.match(r"^([^/]+)/([^@]+)(?:@(.+))?$", str(repo).strip())
        if m:
            info = {
                "owner": m.group(1),
                "repo": m.group(2),
                "branch": m.group(3) or (info or {}).get("branch") or "main",
            }
    if not info:
        raise PackManifestError(
            "market_path requires a GitHub raw catalog URL "
            "(default EvovexAI/evoflow-resource-market, or EVOFLOW_RESOURCE_MARKET_CATALOG_URL / source.repo=owner/repo@branch)"
        )

    zip_url = (
        f"https://codeload.github.com/{info['owner']}/{info['repo']}"
        f"/zip/refs/heads/{info['branch']}"
    )
    tmp = Path(tempfile.mkdtemp(prefix="evoflow_org_market_"))
    zip_path = tmp / "repo.zip"
    try:
        logger.info("Downloading market repo zip %s", zip_url)
        zip_path.write_bytes(_download_bytes(zip_url, timeout=120))
        extract_root = tmp / "extract"
        extract_root.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(zip_path, "r") as zf:
            zf.extractall(extract_root)
        # GitHub zipball top folder: repo-branch/
        children = [p for p in extract_root.iterdir() if p.is_dir()]
        if len(children) != 1:
            raise PackManifestError("Unexpected GitHub zipball layout")
        pack_root = children[0] / path
        if not pack_root.is_dir():
            raise PackManifestError(f"Market path not found in repo: {path}")
        loaded = load_pack_manifest(pack_root)
        loaded.cleanup_dirs.append(tmp)
        return loaded
    except PackManifestError:
        shutil.rmtree(tmp, ignore_errors=True)
        raise
    except Exception as e:
        shutil.rmtree(tmp, ignore_errors=True)
        raise PackManifestError(f"Failed to fetch market pack: {e}") from e


def resolve_remote_source(
    *,
    source_type: str,
    path: str | None = None,
    url: str | None = None,
    repo: str | None = None,
) -> LoadedPack | None:
    """Return LoadedPack for remote types, or None if not a remote type."""
    st = str(source_type or "").strip().lower()
    if st == "zip_url":
        return load_pack_from_zip_url(url or path or "")
    if st == "market_path":
        return load_pack_from_market_path(path or "", repo=repo)
    return None
