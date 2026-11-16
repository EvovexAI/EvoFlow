"""Local resource-market host + multi-source catalog helpers."""

from __future__ import annotations

import json
from pathlib import Path

import pytest


def test_publish_and_public_catalog(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("EVOFLOW_CONFIG_DIR", str(tmp_path))
    from evoflow.organizations import market_host as host

    pack = tmp_path / "sample-pack"
    pack.mkdir()
    (pack / "evoflow.organization.json").write_text(
        json.dumps(
            {
                "schema": 1,
                "kind": "extensions",
                "id": "demo-app-pack",
                "pack": {
                    "id": "demo-app-pack",
                    "name": "Demo App Pack",
                    "version": "1.2.0",
                    "description": "test",
                },
                "primitives": {"extensions": []},
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    (pack / "README.md").write_text("# demo\n", encoding="utf-8")

    result = host.publish_pack(source_path=str(pack))
    assert result["ok"] is True
    assert result["pack"]["id"] == "demo-app-pack"
    assert host.is_host_enabled() is True
    zip_path = host.resolve_pack_zip("demo-app-pack")
    assert zip_path is not None and zip_path.is_file()

    cat = host.public_catalog(base_url="http://192.168.1.17:8382")
    assert len(cat["packs"]) == 1
    assert cat["packs"][0]["download"]["type"] == "zip_url"
    assert cat["packs"][0]["download"]["url"].endswith("/api/resource-market/packs/demo-app-pack.zip")


def test_host_token_gate(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("EVOFLOW_CONFIG_DIR", str(tmp_path))
    from evoflow.organizations import market_host as host

    host.set_host_token("")
    assert host.check_host_token(None) is True
    tok = host.set_host_token(None)
    assert tok
    assert host.check_host_token("") is False
    assert host.check_host_token(tok) is True


def test_market_sources_add_and_zip_annotate(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("EVOFLOW_CONFIG_DIR", str(tmp_path))
    # Avoid touching real SQLite home — stub app settings in-memory
    store: dict[str, object] = {}

    def _get(key: str):
        return store.get(key)

    def _set(key: str, value):
        store[key] = value

    monkeypatch.setattr(
        "evoflow.organizations.market_sources.cfg_repo.get_app_setting",
        _get,
    )
    monkeypatch.setattr(
        "evoflow.organizations.market_sources.cfg_repo.set_app_setting",
        _set,
    )

    from evoflow.organizations import market_sources as sources

    row = sources.add_source(
        catalog_url="http://192.168.1.17:8382/api/resource-market/catalog.json",
        name="Haze LAN",
        source_id="haze-lan",
        token="secret",
    )
    assert row["id"] == "haze-lan"
    assert row["token"] == "secret"
    all_src = sources.list_sources()
    assert all_src[0]["id"] == "official"
    assert any(s["id"] == "haze-lan" for s in all_src)

    packs = sources.annotate_packs(
        [
            {
                "id": "x",
                "name": "X",
                "version": "1",
                "download": {"type": "zip_url", "url": "http://192.168.1.17:8382/api/resource-market/packs/x.zip"},
            }
        ],
        source=row,
    )
    assert packs[0]["_zipUrl"].endswith("token=secret") or "token=secret" in packs[0]["_zipUrl"]


def test_pack_download_url_helpers() -> None:
    from evoflow.organizations.market_sources import pack_download_url

    assert (
        pack_download_url({"download": {"type": "zip_url", "url": "https://example.com/a.zip"}})
        == "https://example.com/a.zip"
    )
    assert pack_download_url({"zip_url": "https://example.com/b.zip"}) == "https://example.com/b.zip"
    assert pack_download_url({"path": "packs/foo"}) == ""
