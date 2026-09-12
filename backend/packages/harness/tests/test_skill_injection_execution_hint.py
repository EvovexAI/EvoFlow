"""Skill injection should teach script execution (skill: URI + workdir)."""

from __future__ import annotations

import os
import tempfile

import pytest

from evoflow.skills.injection import build_skill_injection_message, skill_injection_execution_hint
from evoflow.skills.loader import clear_skills_cache
from evoflow.skills.parser import parse_skill_file


def _write_skill(base: str, name: str) -> None:
    d = os.path.join(base, "public", name)
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "SKILL.md"), "w", encoding="utf-8") as fh:
        fh.write(f"---\nname: {name}\ndescription: Skill {name}\n---\n# body\n")


@pytest.fixture
def skill_obj(monkeypatch):
    with tempfile.TemporaryDirectory() as tmp:
        root = os.path.join(tmp, "skills")
        _write_skill(root, "demo-skill")
        import evoflow.skills.loader as loader_mod

        monkeypatch.setattr(loader_mod, "get_skills_root_path", lambda: __import__("pathlib").Path(root))
        clear_skills_cache()
        skill_file = __import__("pathlib").Path(root) / "public" / "demo-skill" / "SKILL.md"
        skill = parse_skill_file(skill_file, category="public", relative_path=__import__("pathlib").Path("demo-skill"))
        assert skill is not None
        yield skill


def test_execution_hint_zh_mentions_workdir() -> None:
    hint = skill_injection_execution_hint(prompt_language="zh")
    assert "workdir" in hint
    assert "skill:" in hint


def test_injection_message_includes_execution_block(skill_obj) -> None:
    body = build_skill_injection_message([skill_obj], prompt_language="zh")
    assert "<skill_injection>" in body
    assert "workdir" in body
    assert "demo-skill" in body
    assert "勿搜工作区" in body or "workspace" in body
