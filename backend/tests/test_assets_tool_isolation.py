"""End-to-end: assets note/profile land in the correct entity tree."""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

import importlib

assets_mod = importlib.import_module("evoflow.tools.builtins.assets_tool")
from evoflow.config.paths import reset_paths_cache


@pytest.fixture()
def asset_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path))
    reset_paths_cache()
    monkeypatch.setattr(
        "evoflow.assets.guidance.is_employee_agent_name",
        lambda name: str(name or "").strip().lower() in {"douyin-analyst", "ops-bot"},
    )
    monkeypatch.setattr(assets_mod, "_principal_from_runtime", lambda _rt: "yin-tai")
    yield tmp_path
    reset_paths_cache()


def _runtime(*, agent: str = "", principal: str = "", workspace: str = ""):
    ctx: dict = {}
    if agent:
        ctx["agent_name"] = agent
    if principal:
        ctx["principal_id"] = principal
    if workspace:
        ctx["local_workspace_root"] = workspace
    return SimpleNamespace(context=ctx, config={})


def _call_note(runtime, *, content: str, path: str = "", entity_type: str = "", entity_id: str = ""):
    # Call underlying function — StructuredTool.invoke may drop InjectedToolRuntime.
    raw = assets_mod.assets_tool.func(
        action="note",
        runtime=runtime,
        tool_call_id="t1",
        content=content,
        path=path,
        entity_type=entity_type,
        entity_id=entity_id,
    )
    return json.loads(raw)


def _call_profile(runtime, *, content: str):
    raw = assets_mod.assets_tool.func(
        action="profile",
        runtime=runtime,
        tool_call_id="t1",
        path="preferences",
        content=content,
        query="append",
    )
    return json.loads(raw)


def test_employee_note_lands_under_employee_tree(asset_home: Path):
    rt = _runtime(agent="douyin-analyst", principal="yin-tai")
    out = _call_note(rt, content="[experience]\npipeline cookie refresh", path="pipeline-cookie")
    assert out.get("ok") is True, out
    assert out.get("path", "").replace("\\", "/").endswith(
        "memory/_inbox/notes/pipeline-cookie.md"
    ) or "pipeline-cookie" in str(out.get("path"))

    notes = asset_home / "assets" / "employees" / "douyin-analyst" / "memory" / "_inbox" / "notes"
    assert notes.is_dir(), notes
    assert any(p.name.startswith("pipeline-cookie") for p in notes.glob("*.md")), list(notes.glob("*"))

    user_notes = asset_home / "assets" / "users" / "yin-tai" / "memory" / "_inbox" / "notes"
    shared = asset_home / "assets" / "user" / "memory" / "_inbox" / "notes"
    assert not list(user_notes.glob("pipeline-cookie*.md")) if user_notes.exists() else True
    assert not list(shared.glob("pipeline-cookie*.md")) if shared.exists() else True


def test_two_employees_do_not_cross_write(asset_home: Path):
    a = _runtime(agent="douyin-analyst", principal="yin-tai")
    b = _runtime(agent="ops-bot", principal="yin-tai")
    assert _call_note(a, content="[experience]\nA only", path="note-a")["ok"]
    assert _call_note(b, content="[experience]\nB only", path="note-b")["ok"]

    root_a = asset_home / "assets" / "employees" / "douyin-analyst" / "memory" / "_inbox" / "notes"
    root_b = asset_home / "assets" / "employees" / "ops-bot" / "memory" / "_inbox" / "notes"
    names_a = {p.name for p in root_a.glob("*.md")}
    names_b = {p.name for p in root_b.glob("*.md")}
    assert any(n.startswith("note-a") for n in names_a)
    assert any(n.startswith("note-b") for n in names_b)
    assert not any(n.startswith("note-b") for n in names_a)
    assert not any(n.startswith("note-a") for n in names_b)


def test_employee_cannot_spoof_other_employee_on_note(asset_home: Path):
    rt = _runtime(agent="douyin-analyst", principal="yin-tai")
    out = _call_note(
        rt,
        content="[experience]\nspoof attempt",
        path="spoof",
        entity_type="employee",
        entity_id="ops-bot",
    )
    assert out.get("ok") is True, out
    root_ops = asset_home / "assets" / "employees" / "ops-bot" / "memory" / "_inbox" / "notes"
    root_dy = asset_home / "assets" / "employees" / "douyin-analyst" / "memory" / "_inbox" / "notes"
    assert not (root_ops.exists() and any(root_ops.glob("spoof*.md")))
    assert root_dy.exists() and any(root_dy.glob("spoof*.md"))


def test_main_chat_note_goes_to_user_bucket(asset_home: Path):
    rt = _runtime(agent="main", principal="yin-tai")
    out = _call_note(rt, content="[preference]\nprefer short answers", path="pref-short")
    assert out.get("ok") is True, out
    user_notes = asset_home / "assets" / "users" / "yin-tai" / "memory" / "_inbox" / "notes"
    assert user_notes.exists() and any(user_notes.glob("pref-short*.md"))
    emp = asset_home / "assets" / "employees"
    if emp.exists():
        leaked = list(emp.rglob("pref-short*.md"))
        assert not leaked, leaked


def test_employee_profile_still_writes_user_bucket(asset_home: Path):
    rt = _runtime(agent="douyin-analyst", principal="yin-tai")
    out = _call_profile(rt, content="称呼：银泰")
    assert out.get("ok") is True, out
    assert out.get("entityType") == "user"
    pref = asset_home / "assets" / "users" / "yin-tai" / "profile" / "preferences.md"
    assert pref.is_file()
    assert "银泰" in pref.read_text(encoding="utf-8")
    emp_pref = asset_home / "assets" / "employees" / "douyin-analyst" / "profile" / "preferences.md"
    if emp_pref.is_file():
        assert "银泰" not in emp_pref.read_text(encoding="utf-8")


def test_resolve_matrix_quick(asset_home: Path):
    """Routing table sanity without disk writes."""
    cases = [
        (_runtime(agent="douyin-analyst"), "note", ("employee", "douyin-analyst")),
        (_runtime(agent="ops-bot"), "note", ("employee", "ops-bot")),
        (_runtime(agent="main"), "note", ("user", "yin-tai")),
        (_runtime(agent="douyin-analyst"), "profile", ("user", "yin-tai")),
        (_runtime(agent="main"), "profile", ("user", "yin-tai")),
    ]
    for rt, act, expected in cases:
        ent = assets_mod._resolve_entity(rt, action=act)
        assert (ent.entity_type, ent.entity_id) == expected, (act, rt.context, ent)
