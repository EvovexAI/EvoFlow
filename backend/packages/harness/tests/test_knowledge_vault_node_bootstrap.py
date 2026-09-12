"""Tests for private Node bootstrap used by Knowledge Vault first-time install."""

from __future__ import annotations

import io
import zipfile
from pathlib import Path
from unittest.mock import patch

import pytest

from evoflow.knowledge.vault import node_bootstrap as nb


def test_node_dist_urls_include_mirror_and_official(monkeypatch):
    monkeypatch.delenv("EVOFLOW_KB_NODE_DIST_URL", raising=False)
    monkeypatch.delenv("EVOFLOW_KB_NODE_DIST_BASE", raising=False)
    monkeypatch.setenv("EVOFLOW_KB_NODE_VERSION", "20.18.1")
    urls = nb.node_dist_urls()
    assert any("npmmirror.com" in u for u in urls)
    assert any("nodejs.org/dist" in u for u in urls)
    assert all("v20.18.1" in u for u in urls)


def test_node_dist_url_override(monkeypatch):
    monkeypatch.setenv("EVOFLOW_KB_NODE_DIST_URL", "https://example.test/node.zip")
    assert nb.node_dist_urls() == ["https://example.test/node.zip"]


def test_ensure_private_node_reuses_existing(monkeypatch, tmp_path: Path):
    existing = tmp_path / "system-node.exe"
    existing.write_text("x", encoding="utf-8")
    monkeypatch.setattr(nb, "private_node_home", lambda: tmp_path / "runtime" / "node")
    with patch("evoflow.knowledge.vault.runtime_resolve.resolve_node_binary", return_value=str(existing)):
        path = nb.ensure_private_node()
    assert Path(path) == existing


def test_ensure_private_node_installs_from_zip(monkeypatch, tmp_path: Path):
    home = tmp_path / "runtime" / "node"
    monkeypatch.setattr(nb, "private_node_home", lambda: home)
    monkeypatch.setattr(nb, "sys_platform", lambda: "win32")
    monkeypatch.setattr(nb, "pinned_node_version", lambda: "20.18.1")
    monkeypatch.setattr(nb, "_arch_tag", lambda: "x64")

    # Fake official zip layout: node-v20.18.1-win-x64/node.exe (+ npm-cli.js)
    slug = "node-v20.18.1-win-x64"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr(f"{slug}/node.exe", b"MZ-fake-node")
        zf.writestr(f"{slug}/node_modules/npm/bin/npm-cli.js", b"// npm")
    archive_bytes = buf.getvalue()

    def _fake_download(url: str, dest: Path, *, progress_cb=None) -> None:
        if progress_cb:
            progress_cb(f"downloading_node:{url}")
        dest.write_bytes(archive_bytes)

    stages: list[str] = []

    with (
        patch("evoflow.knowledge.vault.runtime_resolve.resolve_node_binary", return_value=""),
        patch.object(nb, "_download_file", side_effect=_fake_download),
    ):
        path = nb.ensure_private_node(progress_cb=stages.append)

    assert Path(path).resolve() == (home / "node.exe").resolve()
    assert (home / "node.exe").is_file()
    assert (home / "node_modules" / "npm" / "bin" / "npm-cli.js").is_file()
    assert "ensuring_private_node" in stages
    assert any(s.startswith("downloading_node:") for s in stages)
    assert "installing_private_node" in stages


def test_ensure_private_node_raises_when_all_mirrors_fail(monkeypatch, tmp_path: Path):
    from evoflow.knowledge.vault.errors import NodeRuntimeMissingError

    home = tmp_path / "runtime" / "node"
    monkeypatch.setattr(nb, "private_node_home", lambda: home)
    monkeypatch.setattr(nb, "node_dist_urls", lambda _v=None: ["https://example.test/fail.zip"])

    with (
        patch("evoflow.knowledge.vault.runtime_resolve.resolve_node_binary", return_value=""),
        patch.object(nb, "_download_file", side_effect=RuntimeError("network down")),
        pytest.raises(NodeRuntimeMissingError) as ei,
    ):
        nb.ensure_private_node()
    assert "无法自动下载" in ei.value.message
