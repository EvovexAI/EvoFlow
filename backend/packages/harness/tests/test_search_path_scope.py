"""Tests for search_code_index path: scope and polluted path filtering."""

from __future__ import annotations

from evoflow.code_index.store import (
    _filter_index_rows,
    _path_has_skipped_segment,
    _path_under_prefix,
    search_index,
)


def test_path_has_skipped_segment_excludes_bundled_deps() -> None:
    assert _path_has_skipped_segment("evopanel/src-tauri/binaries/evoflow-gateway/_internal/aiohttp/x.py")
    assert _path_has_skipped_segment("vendor/foo/_internal/bar.js")
    assert not _path_has_skipped_segment("evopanel/src/react/components/MessageRow.tsx")


def test_path_under_prefix() -> None:
    assert _path_under_prefix("evopanel/src/react/components/X.tsx", "evopanel/src/react")
    assert not _path_under_prefix("backend/app/main.py", "evopanel/src/react")


def test_filter_index_rows_drops_binaries_and_applies_scope() -> None:
    rows = [
        {"path": "evopanel/src-tauri/binaries/pkg/_internal/aiohttp/x.py"},
        {"path": "evopanel/src/react/components/MessageRow.tsx"},
        {"path": "backend/app/main.py"},
    ]
    scoped = _filter_index_rows(rows, path_prefix="evopanel/src/react", limit=5)
    assert [r["path"] for r in scoped] == ["evopanel/src/react/components/MessageRow.tsx"]


def test_search_index_path_scope_prefers_react_hits() -> None:
    data = search_index(
        r"d:\github\EvoFlow",
        "path:evopanel/src/react MessageRow",
        limit=8,
    )
    paths = [str(s.get("path") or "") for s in (data.get("symbols") or [])]
    paths += [str(h.get("path") or "") for h in (data.get("hits") or [])]
    assert paths
    assert all("evopanel/src/react" in p for p in paths)
    assert not any("binaries" in p or "_internal" in p for p in paths)
    assert data.get("path_prefix") == "evopanel/src/react"
