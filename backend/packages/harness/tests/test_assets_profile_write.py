"""assets(action=profile) — agent-maintained user profile dimensions."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

import pytest

from evoflow.assets.paths import EntityRef, profile_path
from evoflow.assets.user_profile_dims import ensure_user_profile_files, read_user_profile_dimensions
from evoflow.tools.builtins.assets_tool import assets_tool


@pytest.fixture
def profile_home(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        yield Path(tmp)


def _invoke_profile(*, path: str, content: str, query: str = "append", **extra) -> dict:
    runtime = type("R", (), {"context": {"agent_name": "main"}, "config": {}})()
    raw = assets_tool.func(
        action="profile",
        path=path,
        content=content,
        query=query,
        runtime=runtime,
        tool_call_id="t1",
        entity_type=extra.get("entity_type", ""),
        entity_id=extra.get("entity_id", ""),
    )
    return json.loads(raw)


def test_profile_append_basic_info(profile_home: Path) -> None:
    ensure_user_profile_files()
    out = _invoke_profile(path="basic-info", content="称呼：Alex；语言：中文")
    assert out["ok"] is True
    assert out["path"] == "profile/basic-info.md"
    text = profile_path(EntityRef("user", "user"), "basic-info.md").read_text(encoding="utf-8")
    assert "Alex" in text
    assert "Agent 补充" in text
    dims = read_user_profile_dimensions(max_chars_per_dim=8000)
    assert "Alex" in dims["basic-info.md"]


def test_profile_replace_preferences(profile_home: Path) -> None:
    ensure_user_profile_files()
    body = "# 偏好与爱好\n\n## 回复风格\n\n简洁中文\n"
    _invoke_profile(path="preferences.md", content=body, query="replace")
    text = profile_path(EntityRef("user", "user"), "preferences.md").read_text(encoding="utf-8")
    assert "简洁中文" in text


def test_profile_always_writes_user_entity(profile_home: Path) -> None:
    """Even if the tool call names an agent, profile updates go to user assets."""
    ensure_user_profile_files()
    out = _invoke_profile(
        path="basic-info",
        content="称呼：资产中心用户",
        entity_type="agent",
        entity_id="main",
    )
    assert out["ok"] is True
    text = profile_path(EntityRef("user", "user"), "basic-info.md").read_text(encoding="utf-8")
    assert "资产中心用户" in text
