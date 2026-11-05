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


def _call(runtime, *, action: str, **kwargs):
    raw = assets_mod.assets_tool.func(
        action=action,
        runtime=runtime,
        tool_call_id="t1",
        **kwargs,
    )
    return json.loads(raw)


def test_employee_note_lands_under_employee_tree(asset_home: Path):
    rt = _runtime(agent="douyin-analyst", principal="yin-tai")
    out = _call_note(rt, content="[experience]\npipeline cookie refresh", path="pipeline-cookie")
    assert out.get("ok") is True, out
    rel = str(out.get("path") or "").replace("\\", "/")
    assert rel.startswith("craft/"), rel
    assert out.get("kind") == "craft"

    craft = asset_home / "assets" / "employees" / "douyin-analyst" / "craft"
    assert craft.is_dir(), craft
    assert any(craft.glob("*.md")), list(craft.glob("*"))

    user_craft = asset_home / "assets" / "users" / "yin-tai" / "craft"
    shared = asset_home / "assets" / "user" / "craft"
    assert not list(user_craft.glob("*.md")) if user_craft.exists() else True
    assert not list(shared.glob("*.md")) if shared.exists() else True


def test_two_employees_do_not_cross_write(asset_home: Path):
    a = _runtime(agent="douyin-analyst", principal="yin-tai")
    b = _runtime(agent="ops-bot", principal="yin-tai")
    assert _call_note(a, content="[experience]\nA only", path="note-a")["ok"]
    assert _call_note(b, content="[experience]\nB only", path="note-b")["ok"]

    root_a = asset_home / "assets" / "employees" / "douyin-analyst" / "craft"
    root_b = asset_home / "assets" / "employees" / "ops-bot" / "craft"
    files_a = list(root_a.glob("*.md")) if root_a.exists() else []
    files_b = list(root_b.glob("*.md")) if root_b.exists() else []
    assert files_a, root_a
    assert files_b, root_b
    assert any("A only" in p.read_text(encoding="utf-8") for p in files_a)
    assert any("B only" in p.read_text(encoding="utf-8") for p in files_b)
    assert not any("B only" in p.read_text(encoding="utf-8") for p in files_a)
    assert not any("A only" in p.read_text(encoding="utf-8") for p in files_b)


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
    root_ops = asset_home / "assets" / "employees" / "ops-bot" / "craft"
    root_dy = asset_home / "assets" / "employees" / "douyin-analyst" / "craft"
    assert not (root_ops.exists() and any(root_ops.glob("*.md")))
    assert root_dy.exists() and any(root_dy.glob("*.md"))


def test_main_chat_note_goes_to_user_bucket(asset_home: Path):
    rt = _runtime(agent="main", principal="yin-tai")
    out = _call_note(rt, content="[preference]\nprefer short answers", path="pref-short")
    assert out.get("ok") is True, out
    assert out.get("kind") == "standing"
    standing = asset_home / "assets" / "users" / "yin-tai" / "memory" / "standing.md"
    assert standing.is_file()
    assert "prefer short answers" in standing.read_text(encoding="utf-8")
    emp = asset_home / "assets" / "employees"
    if emp.exists():
        leaked = [p for p in emp.rglob("standing.md") if "prefer short answers" in p.read_text(encoding="utf-8")]
        assert not leaked, leaked


def test_employee_profile_still_writes_user_bucket(asset_home: Path):
    rt = _runtime(agent="douyin-analyst", principal="yin-tai")
    out = _call_profile(rt, content="称呼：银泰")
    assert out.get("ok") is True, out
    assert out.get("entityType") == "user"
    user_md = asset_home / "assets" / "users" / "yin-tai" / "profile" / "USER.md"
    assert user_md.is_file()
    assert "银泰" in user_md.read_text(encoding="utf-8")
    emp_md = asset_home / "assets" / "employees" / "douyin-analyst" / "profile" / "USER.md"
    if emp_md.is_file():
        assert "银泰" not in emp_md.read_text(encoding="utf-8")


def test_resolve_matrix_quick(asset_home: Path):
    """Routing table sanity without disk writes."""
    cases = [
        (_runtime(agent="douyin-analyst"), "note", ("employee", "douyin-analyst")),
        (_runtime(agent="douyin-analyst"), "read", ("employee", "douyin-analyst")),
        (_runtime(agent="douyin-analyst"), "search", ("employee", "douyin-analyst")),
        (_runtime(agent="douyin-analyst"), "list", ("employee", "douyin-analyst")),
        (_runtime(agent="ops-bot"), "note", ("employee", "ops-bot")),
        (_runtime(agent="main"), "note", ("user", "yin-tai")),
        (_runtime(agent="main"), "read", ("user", "yin-tai")),
        (_runtime(agent="douyin-analyst"), "profile", ("user", "yin-tai")),
        (_runtime(agent="main"), "profile", ("user", "yin-tai")),
    ]
    for rt, act, expected in cases:
        ent = assets_mod._resolve_entity(rt, action=act)
        assert (ent.entity_type, ent.entity_id) == expected, (act, rt.context, ent)


def test_employee_note_then_read_same_bucket(asset_home: Path):
    """Authenticated employee: note write + immediate read must hit the same tree."""
    rt = _runtime(agent="douyin-analyst", principal="yin-tai")
    written = _call(
        rt,
        action="note",
        content="[experience] 漫剧编剧岗本机资料路径与知识库噪声",
        path="experience-漫剧编剧岗-本机资料路径与知识库噪声-2026-10",
    )
    assert written.get("ok") is True, written
    rel = str(written.get("path") or "").replace("\\", "/")
    assert rel.startswith("craft/"), rel

    read_full = _call(rt, action="read", path=rel)
    assert read_full.get("ok") is True, read_full
    assert "漫剧编剧岗" in str(read_full.get("content") or "")

    # Basename-only read should still resolve under employee craft.
    read_short = _call(rt, action="read", path=Path(rel).name)
    assert read_short.get("ok") is True, read_short

    # Must land under employee tree, not users/<pid>.
    emp_file = asset_home / "assets" / "employees" / "douyin-analyst" / Path(rel)
    assert emp_file.is_file(), emp_file
    user_file = asset_home / "assets" / "users" / "yin-tai" / Path(rel)
    assert not user_file.is_file(), user_file
