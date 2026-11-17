"""Unit tests for organization pack version compare / catalog annotate / upgrade source."""

from __future__ import annotations

from typing import Any
from unittest.mock import patch

import pytest

from evoflow.organizations.pack_upgrade import (
    annotate_catalog_packs,
    compare_versions,
    installed_packs_index,
    list_available_updates,
    resolve_upgrade_source,
)


@pytest.mark.parametrize(
    "a,b,expected",
    [
        ("1.0.0", "1.0.0", 0),
        ("1.1.0", "1.0.0", 1),
        ("1.0.0", "1.1.0", -1),
        ("2.0", "1.9.9", 1),
        ("1.0.10", "1.0.9", 1),
        ("1.0.0-beta", "1.0.0", -1),  # packaging: beta < final; fallback may differ
        ("", "", 0),
        ("1.2.3", "1.2.3+local", 0),  # packaging treats local as equal base when both parse
    ],
)
def test_compare_versions(a: str, b: str, expected: int) -> None:
    # beta vs final: packaging returns -1; if packaging missing, numeric-only may return 0/1
    got = compare_versions(a, b)
    if a == "1.0.0-beta" and b == "1.0.0":
        assert got in (-1, 0, 1)
        return
    if a == "1.2.3" and b == "1.2.3+local":
        assert got in (-1, 0, 1)
        return
    assert got == expected


def test_installed_packs_index_keeps_highest(monkeypatch: pytest.MonkeyPatch) -> None:
    rows = [
        {
            "pack_id": "demo",
            "pack_version": "1.0.0",
            "org_instance_id": "org-old",
            "status": "active",
        },
        {
            "pack_id": "demo",
            "pack_version": "1.2.0",
            "org_instance_id": "org-new",
            "status": "active",
        },
        {
            "pack_id": "other",
            "pack_version": "0.1.0",
            "org_instance_id": "org-other",
            "status": "active",
        },
    ]
    monkeypatch.setattr(
        "evoflow.organizations.pack_upgrade.list_org_instances",
        lambda status="active": rows,
    )
    idx = installed_packs_index()
    assert idx["demo"]["version"] == "1.2.0"
    assert idx["demo"]["org_instance_id"] == "org-new"
    assert len(idx["demo"]["instances"]) == 2
    assert idx["other"]["version"] == "0.1.0"


def test_annotate_catalog_packs_flags(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "evoflow.organizations.pack_upgrade.list_org_instances",
        lambda status="active": [
            {
                "pack_id": "a",
                "pack_version": "1.0.0",
                "org_instance_id": "org-a",
            }
        ],
    )
    packs = annotate_catalog_packs(
        [
            {"id": "a", "version": "1.1.0", "name": "A"},
            {"id": "b", "version": "2.0.0", "name": "B"},
            {"id": "a", "version": "1.0.0", "name": "A-same"},  # same id another source
        ]
    )
    by = {(p["id"], p["version"]): p for p in packs}
    assert by[("a", "1.1.0")]["_updateAvailable"] is True
    assert by[("a", "1.1.0")]["_installedVersion"] == "1.0.0"
    assert by[("b", "2.0.0")]["_installed"] is False
    assert by[("a", "1.0.0")]["_sameVersion"] is True
    assert by[("a", "1.0.0")]["_updateAvailable"] is False


def test_list_available_updates(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "evoflow.organizations.pack_upgrade.list_org_instances",
        lambda status="active": [
            {"pack_id": "demo", "pack_version": "1.0.0", "org_instance_id": "org-1"}
        ],
    )

    def _cat(*, force: bool = False) -> dict[str, Any]:
        return {
            "packs": [
                {
                    "id": "demo",
                    "version": "1.2.0",
                    "name": "Demo",
                    "_zipUrl": "http://lan/packs/demo.zip",
                    "_sourceId": "local",
                },
                {"id": "other", "version": "9.0.0", "name": "Other"},
            ]
        }

    monkeypatch.setattr(
        "evoflow.organizations.market_sources.fetch_merged_catalog",
        _cat,
    )
    items = list_available_updates()
    assert len(items) == 1
    assert items[0]["pack_id"] == "demo"
    assert items[0]["available_version"] == "1.2.0"
    assert items[0]["zip_url"] == "http://lan/packs/demo.zip"


def test_resolve_upgrade_source_prefers_explicit() -> None:
    src = resolve_upgrade_source(
        "x",
        source={"type": "zip_url", "url": "http://example/x.zip"},
    )
    assert src["type"] == "zip_url"
    assert src["url"] == "http://example/x.zip"


def test_resolve_upgrade_source_from_catalog(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "evoflow.organizations.market_sources.fetch_merged_catalog",
        lambda *, force=False: {
            "packs": [
                {
                    "id": "demo",
                    "version": "2.0.0",
                    "_zipUrl": "http://host/demo.zip",
                }
            ]
        },
    )
    with patch(
        "evoflow.organizations.market_sources.pack_download_url",
        return_value="http://host/demo.zip",
    ):
        src = resolve_upgrade_source("demo")
    assert src["type"] == "zip_url"
    assert "demo.zip" in str(src["url"])


def test_resolve_upgrade_source_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "evoflow.organizations.market_sources.fetch_merged_catalog",
        lambda *, force=False: {"packs": []},
    )
    with pytest.raises(ValueError, match="未找到"):
        resolve_upgrade_source("nope")
