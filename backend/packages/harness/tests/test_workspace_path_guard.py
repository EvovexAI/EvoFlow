"""Workspace path guard — confine host-direct tools to session-bound root."""

from __future__ import annotations

import os
import tempfile

from evoflow.tools.host_direct.workspace_path_guard import (
    resolve_tool_path,
    resolve_tool_workdir,
    runtime_with_workspace,
)
from evoflow.utils.workspace_browse import strip_bound_workspace_prefix


def test_strip_bound_workspace_prefix():
    assert strip_bound_workspace_prefix("workspace/foo.py") == "foo.py"
    assert strip_bound_workspace_prefix("outputs/out.txt") == "outputs/out.txt"
    assert strip_bound_workspace_prefix("./workspace") == ""


def test_resolve_relative_under_root():
    with tempfile.TemporaryDirectory() as tmp:
        root = os.path.join(tmp, "proj")
        os.makedirs(root)
        f = os.path.join(root, "a.txt")
        with open(f, "w", encoding="utf-8") as fh:
            fh.write("x")
        rt = runtime_with_workspace(root)
        got = resolve_tool_path("a.txt", runtime=rt, must_exist=True, must_be_file=True)
        assert not isinstance(got, str)
        assert got.read_text(encoding="utf-8") == "x"


def test_resolve_workspace_prefix():
    with tempfile.TemporaryDirectory() as tmp:
        root = os.path.join(tmp, "proj")
        os.makedirs(root)
        f = os.path.join(root, "b.txt")
        open(f, "w").close()
        rt = runtime_with_workspace(root)
        got = resolve_tool_path("workspace/b.txt", runtime=rt, must_exist=True, must_be_file=True)
        assert not isinstance(got, str)
        assert got.name == "b.txt"


def test_resolve_absolute_strips_workspace_segment():
    with tempfile.TemporaryDirectory() as tmp:
        root = os.path.join(tmp, "proj")
        os.makedirs(root)
        nested = os.path.join(root, "workspace")
        os.makedirs(nested)
        flat = os.path.join(root, "demo_crud.md")
        with open(flat, "w", encoding="utf-8") as fh:
            fh.write("ok")
        abs_nested = os.path.join(nested, "demo_crud.md")
        rt = runtime_with_workspace(root)
        got = resolve_tool_path(abs_nested, runtime=rt, must_exist=True, must_be_file=True)
        assert not isinstance(got, str)
        assert os.path.normcase(str(got)) == os.path.normcase(flat)


def test_allow_relative_outside_workspace():
    with tempfile.TemporaryDirectory() as tmp:
        root = os.path.join(tmp, "proj")
        os.makedirs(root)
        outside = os.path.join(tmp, "outside.txt")
        with open(outside, "w", encoding="utf-8") as fh:
            fh.write("escaped")
        rt = runtime_with_workspace(root)
        got = resolve_tool_path("../outside.txt", runtime=rt, must_exist=True, must_be_file=True)
        assert not isinstance(got, str)
        assert got.read_text(encoding="utf-8") == "escaped"


def test_allow_absolute_outside_workspace():
    with tempfile.TemporaryDirectory() as tmp:
        root = os.path.join(tmp, "proj")
        os.makedirs(root)
        outside = os.path.join(tmp, "other.txt")
        with open(outside, "w", encoding="utf-8") as fh:
            fh.write("abs")
        rt = runtime_with_workspace(root)
        got = resolve_tool_path(outside, runtime=rt, must_exist=True, must_be_file=True)
        assert not isinstance(got, str)
        assert got.read_text(encoding="utf-8") == "abs"


def test_allow_skills_install_absolute_read(monkeypatch):
    with tempfile.TemporaryDirectory() as tmp:
        skills_root = os.path.join(tmp, "skills")
        skill_dir = os.path.join(skills_root, "public", "pdfkit-py")
        os.makedirs(skill_dir)
        skill_md = os.path.join(skill_dir, "SKILL.md")
        with open(skill_md, "w", encoding="utf-8") as fh:
            fh.write("# pdfkit-py\n")
        ws = os.path.join(tmp, "proj")
        os.makedirs(ws)
        rt = runtime_with_workspace(ws)

        import evoflow.skills.loader as loader_mod

        monkeypatch.setattr(loader_mod, "get_skills_root_path", lambda: __import__("pathlib").Path(skills_root))

        got = resolve_tool_path(
            skill_md,
            runtime=rt,
            must_exist=True,
            must_be_file=True,
            allow_skills_install=True,
        )
        assert not isinstance(got, str)
        assert got.read_text(encoding="utf-8").startswith("# pdfkit-py")


def test_no_workspace_bound_relative_uses_cwd():
    with tempfile.TemporaryDirectory() as tmp:
        prev = os.getcwd()
        try:
            os.chdir(tmp)
            f = os.path.join(tmp, "foo.txt")
            with open(f, "w", encoding="utf-8") as fh:
                fh.write("cwd")
            got = resolve_tool_path("foo.txt", runtime=None, must_exist=True, must_be_file=True)
            assert not isinstance(got, str)
            assert got.read_text(encoding="utf-8") == "cwd"
        finally:
            os.chdir(prev)


def test_workdir_defaults_to_root():
    with tempfile.TemporaryDirectory() as tmp:
        root = os.path.join(tmp, "proj")
        os.makedirs(root)
        rt = runtime_with_workspace(root)
        got = resolve_tool_workdir(None, runtime=rt)
        assert not isinstance(got, str)
        assert got.resolve() == os.path.realpath(root)


def test_workdir_absolute_outside_workspace():
    with tempfile.TemporaryDirectory() as tmp:
        root = os.path.join(tmp, "proj")
        os.makedirs(root)
        outside = os.path.join(tmp, "other")
        os.makedirs(outside)
        rt = runtime_with_workspace(root)
        got = resolve_tool_workdir(outside, runtime=rt)
        assert not isinstance(got, str)
        assert got.resolve() == os.path.realpath(outside)
