"""``assets action="write"`` must not silently wipe a file.

Regression: a model that wanted to tweak one paragraph of ``standing.md``
sent ``path=standing.md`` without ``mode=replace``; the old code overwrote the
whole 9KB file with just the new paragraph. Write is now append-by-default.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import importlib
import pytest

assets_mod = importlib.import_module("evoflow.tools.builtins.assets_tool")
from evoflow.config.paths import reset_paths_cache


@pytest.fixture()
def asset_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path))
    reset_paths_cache()
    monkeypatch.setattr(assets_mod, "_principal_from_runtime", lambda _rt: "yin-tai")
    yield tmp_path
    reset_paths_cache()


def _runtime(*, agent: str = "main"):
    return SimpleNamespace(context={"agent_name": agent, "principal_id": "yin-tai"}, config={})


def _write(runtime, **kwargs):
    raw = assets_mod.assets_tool.func(
        action="write",
        runtime=runtime,
        tool_call_id="t1",
        **kwargs,
    )
    return json.loads(raw)


def _standing_path(asset_home: Path) -> Path:
    return asset_home / "assets" / "users" / "yin-tai" / "memory" / "standing.md"


def test_write_appends_by_default(asset_home: Path):
    rt = _runtime()
    first = _write(rt, path="memory/standing.md", content="v1\n\n## Tips\n\n- 第一条经验")
    assert first.get("ok") is True, first
    assert first.get("mode") == "append", first

    second = _write(rt, path="memory/standing.md", content="- 第二条经验")
    assert second.get("ok") is True, second
    assert second.get("mode") == "append", second

    body = _standing_path(asset_home).read_text(encoding="utf-8")
    assert "第一条经验" in body, body
    assert "第二条经验" in body, body


def test_write_replace_overwrites_only_when_explicit(asset_home: Path):
    rt = _runtime()
    _write(rt, path="memory/standing.md", content="v1\n\n- 旧内容")
    out = _write(rt, path="memory/standing.md", content="v1\n\n- 新内容", mode="replace")
    assert out.get("ok") is True, out
    assert out.get("mode") == "replace", out

    body = _standing_path(asset_home).read_text(encoding="utf-8")
    assert "新内容" in body
    assert "旧内容" not in body


def test_write_append_does_not_duplicate_identical_tail(asset_home: Path):
    """Re-sending the same body must not stack it forever."""
    rt = _runtime()
    _write(rt, path="memory/standing.md", content="- 同一条")
    _write(rt, path="memory/standing.md", content="- 同一条")
    body = _standing_path(asset_home).read_text(encoding="utf-8")
    assert body.count("- 同一条") == 1, body
