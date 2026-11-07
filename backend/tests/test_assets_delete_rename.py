"""``assets`` must support delete and rename — stale assets need cleanup."""

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


def _call(runtime, **kwargs):
    raw = assets_mod.assets_tool.func(
        runtime=runtime,
        tool_call_id="t1",
        **kwargs,
    )
    return json.loads(raw)


def _craft_dir(asset_home: Path) -> Path:
    return asset_home / "assets" / "users" / "yin-tai" / "craft"


def test_delete_removes_stale_asset(asset_home: Path):
    rt = _runtime()
    created = _call(
        rt,
        action="note",
        content="[experience]\n旧做法：直接覆盖",
        path="旧做法-直接覆盖",
    )
    assert created.get("ok") is True, created
    rel = str(created.get("path") or "").replace("\\", "/")
    assert rel.startswith("craft/"), rel
    assert list(_craft_dir(asset_home).glob("*.md"))

    out = _call(rt, action="delete", path=rel)
    assert out.get("ok") is True, out
    assert out.get("deleted") is True, out
    assert not list(_craft_dir(asset_home).glob("*.md")), list(_craft_dir(asset_home).glob("*.md"))


def test_delete_missing_file_reports_not_found(asset_home: Path):
    rt = _runtime()
    out = _call(rt, action="delete", path="craft/does-not-exist.md")
    assert out.get("ok") is False, out
    assert "not_found" in str(out.get("error")), out


def test_delete_protected_profile_file_is_rejected(asset_home: Path):
    rt = _runtime()
    out = _call(rt, action="delete", path="profile/USER.md")
    assert out.get("ok") is False, out
    assert "protected" in str(out.get("error")), out


def test_rename_changes_filename(asset_home: Path):
    rt = _runtime()
    created = _call(
        rt,
        action="note",
        content="[experience]\n新做法：先搜再改",
        path="新做法-先搜再改",
    )
    assert created.get("ok") is True, created
    rel = str(created.get("path") or "").replace("\\", "/")

    out = _call(rt, action="rename", path=rel, content="资产维护-先搜再改")
    assert out.get("ok") is True, out
    assert out.get("renamed") is True, out
    new_rel = str(out.get("newPath") or "").replace("\\", "/")
    assert new_rel.endswith("资产维护-先搜再改.md"), new_rel
    assert (_craft_dir(asset_home) / "资产维护-先搜再改.md").is_file()


def test_rename_rejects_path_traversal(asset_home: Path):
    rt = _runtime()
    created = _call(rt, action="note", content="[experience]\nx", path="rename-guard")
    rel = str(created.get("path") or "").replace("\\", "/")
    out = _call(rt, action="rename", path=rel, content="../escaped")
    assert out.get("ok") is False, out
    assert "basename" in str(out.get("error")), out


def test_rename_onto_existing_file_is_rejected(asset_home: Path):
    rt = _runtime()
    a = _call(rt, action="note", content="[experience]\nA", path="rename-a")
    b = _call(rt, action="note", content="[experience]\nB", path="rename-b")
    rel_a = str(a.get("path") or "").replace("\\", "/")
    rel_b = str(b.get("path") or "").replace("\\", "/")
    target = Path(rel_b).name

    out = _call(rt, action="rename", path=rel_a, content=target)
    assert out.get("ok") is False, out
    assert "target_exists" in str(out.get("error")), out
