"""Bootstrap a private Node.js runtime for Knowledge Vault (production installs).

Packaged desktop builds do not ship Node or kb-mcp (~700MB). First-time
「安装检索组件」downloads a portable Node into ``{EVOFLOW_HOME}/runtime/node``
so ordinary users without a system Node can still initialize vaults.
"""

from __future__ import annotations

import logging
import os
import platform
import shutil
import tarfile
import tempfile
import zipfile
from pathlib import Path
from typing import Any, Callable

logger = logging.getLogger(__name__)

# Pin LTS for reproducible better-sqlite3 native builds.
DEFAULT_NODE_VERSION = "20.18.1"

ProgressCb = Callable[[str], Any]


def private_node_home() -> Path:
    """``{EVOFLOW_HOME}/runtime/node`` — matches resolve_node_binary candidates."""
    from evoflow.config.data_paths import resolve_data_base_dir

    return (resolve_data_base_dir() / "runtime" / "node").resolve()


def pinned_node_version() -> str:
    raw = (os.getenv("EVOFLOW_KB_NODE_VERSION") or "").strip()
    if raw.startswith("v"):
        raw = raw[1:]
    return raw or DEFAULT_NODE_VERSION


def _arch_tag() -> str:
    machine = (platform.machine() or "").lower()
    if machine in ("arm64", "aarch64"):
        return "arm64"
    return "x64"


def _dist_slug(version: str) -> str:
    arch = _arch_tag()
    if sys_platform() == "win32":
        return f"node-v{version}-win-{arch}"
    if sys_platform() == "darwin":
        return f"node-v{version}-darwin-{arch}"
    return f"node-v{version}-linux-{arch}"


def sys_platform() -> str:
    import sys

    return sys.platform


def _archive_name(version: str) -> str:
    slug = _dist_slug(version)
    if sys_platform() == "win32":
        return f"{slug}.zip"
    return f"{slug}.tar.gz"


def node_dist_urls(version: str | None = None) -> list[str]:
    """Official + CN mirror URLs (first success wins)."""
    ver = version or pinned_node_version()
    name = _archive_name(ver)
    override = (os.getenv("EVOFLOW_KB_NODE_DIST_URL") or "").strip()
    if override:
        return [override]
    base_override = (os.getenv("EVOFLOW_KB_NODE_DIST_BASE") or "").strip().rstrip("/")
    urls: list[str] = []
    if base_override:
        urls.append(f"{base_override}/v{ver}/{name}")
    # npmmirror first — many CN desktop users cannot reach nodejs.org reliably
    urls.append(f"https://npmmirror.com/mirrors/node/v{ver}/{name}")
    urls.append(f"https://nodejs.org/dist/v{ver}/{name}")
    # de-dupe preserve order
    seen: set[str] = set()
    out: list[str] = []
    for u in urls:
        if u not in seen:
            seen.add(u)
            out.append(u)
    return out


def expected_node_binary(home: Path | None = None) -> Path:
    root = home or private_node_home()
    if sys_platform() == "win32":
        return root / "node.exe"
    return root / "bin" / "node"


def private_node_ready(home: Path | None = None) -> bool:
    node = expected_node_binary(home)
    try:
        return node.is_file()
    except OSError:
        return False


def _download_file(url: str, dest: Path, *, progress_cb: ProgressCb | None = None) -> None:
    import httpx

    dest.parent.mkdir(parents=True, exist_ok=True)
    if progress_cb:
        progress_cb(f"downloading_node:{url}")
    timeout = httpx.Timeout(connect=30.0, read=300.0, write=60.0, pool=30.0)
    with httpx.Client(timeout=timeout, follow_redirects=True) as client:
        with client.stream("GET", url) as resp:
            resp.raise_for_status()
            with dest.open("wb") as f:
                for chunk in resp.iter_bytes(chunk_size=1024 * 256):
                    if chunk:
                        f.write(chunk)


def _extract_archive(archive: Path, dest_dir: Path) -> Path:
    """Extract archive; return the top-level extracted folder (node-v…-…)."""
    dest_dir.mkdir(parents=True, exist_ok=True)
    if archive.suffix == ".zip" or archive.name.endswith(".zip"):
        with zipfile.ZipFile(archive, "r") as zf:
            zf.extractall(dest_dir)
    else:
        with tarfile.open(archive, "r:gz") as tf:
            tf.extractall(dest_dir)

    # Official distro unpacks to a single top-level directory
    children = [p for p in dest_dir.iterdir() if p.is_dir()]
    if len(children) == 1:
        return children[0]
    # Already flat (unexpected) — use dest_dir
    return dest_dir


def _install_extracted_tree(extracted: Path, target: Path) -> None:
    """Move extracted Node tree into ``target`` (atomic replace when possible)."""
    target.parent.mkdir(parents=True, exist_ok=True)
    staging = target.parent / f".node-install-{os.getpid()}"
    if staging.exists():
        shutil.rmtree(staging, ignore_errors=True)
    shutil.move(str(extracted), str(staging))

    # Ensure unix binaries are executable
    if sys_platform() != "win32":
        for rel in ("bin/node", "bin/npm", "bin/npx"):
            bin_path = staging / rel
            if bin_path.is_file():
                try:
                    bin_path.chmod(bin_path.stat().st_mode | 0o111)
                except OSError:
                    pass

    backup = target.parent / f".node-backup-{os.getpid()}"
    try:
        if target.exists():
            if backup.exists():
                shutil.rmtree(backup, ignore_errors=True)
            shutil.move(str(target), str(backup))
        shutil.move(str(staging), str(target))
    finally:
        if backup.exists():
            shutil.rmtree(backup, ignore_errors=True)
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)


def ensure_private_node(*, progress_cb: ProgressCb | None = None, force: bool = False) -> str:
    """Return a usable Node path, downloading a private runtime when needed.

    Prefer existing ``resolve_node_binary()`` (env / system / already-bootstrapped).
    When missing, download portable Node into ``private_node_home()``.
    """
    from evoflow.knowledge.vault.errors import NodeRuntimeMissingError
    from evoflow.knowledge.vault.runtime_resolve import resolve_node_binary

    existing = resolve_node_binary()
    if existing and not force:
        return existing

    home = private_node_home()
    if private_node_ready(home) and not force:
        return str(expected_node_binary(home))

    version = pinned_node_version()
    urls = node_dist_urls(version)
    if progress_cb:
        progress_cb("ensuring_private_node")

    last_err: Exception | None = None
    with tempfile.TemporaryDirectory(prefix="evoflow-node-") as tmp:
        tmp_path = Path(tmp)
        archive_path = tmp_path / _archive_name(version)
        for url in urls:
            try:
                logger.info("downloading private Node from %s", url)
                _download_file(url, archive_path, progress_cb=progress_cb)
                extract_root = tmp_path / "extract"
                if extract_root.exists():
                    shutil.rmtree(extract_root, ignore_errors=True)
                extracted = _extract_archive(archive_path, extract_root)
                if progress_cb:
                    progress_cb("installing_private_node")
                _install_extracted_tree(extracted, home)
                node = expected_node_binary(home)
                if not node.is_file():
                    raise NodeRuntimeMissingError(
                        f"Node 下载完成但未找到可执行文件：{node}",
                        details={"home": str(home), "url": url},
                    )
                logger.info("private Node ready at %s", node)
                return str(node.resolve())
            except Exception as exc:  # noqa: BLE001 — try next mirror
                last_err = exc
                logger.warning("private Node download failed (%s): %s", url, exc)
                continue

    raise NodeRuntimeMissingError(
        "无法自动下载 Node 运行时。请检查网络后重试，"
        "或手动安装 Node.js 18+，或将 Node 放到 {EVOFLOW_HOME}/runtime/node。",
        details={"tried": urls, "cause": str(last_err) if last_err else ""},
        cause=last_err,
    )
