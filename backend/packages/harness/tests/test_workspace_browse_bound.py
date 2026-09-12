"""Bound local root path resolution (no extra workspace/ layer)."""

from __future__ import annotations

import os
import tempfile

from evoflow.utils.workspace_browse import resolve_bound_workspace_file, strip_bound_workspace_prefix


def test_strip_bound_workspace_prefix():
    assert strip_bound_workspace_prefix("workspace/foo.py") == "foo.py"
    assert strip_bound_workspace_prefix("outputs/out.txt") == "outputs/out.txt"
    assert strip_bound_workspace_prefix("uploads/x.png") == "uploads/x.png"


def test_workspace_prefix_resolves_flat_under_root():
    with tempfile.TemporaryDirectory() as tmp:
        root = os.path.join(tmp, "proj")
        os.makedirs(root)
        flat = os.path.join(root, "notes.md")
        with open(flat, "w", encoding="utf-8") as f:
            f.write("ok")
        nested = os.path.join(root, "workspace", "notes.md")
        os.makedirs(os.path.dirname(nested), exist_ok=True)
        with open(nested, "w", encoding="utf-8") as f:
            f.write("wrong")
        target = resolve_bound_workspace_file(root, "workspace/notes.md")
        assert target.resolve() == os.path.realpath(flat)


def test_uploads_subdir():
    with tempfile.TemporaryDirectory() as tmp:
        root = os.path.join(tmp, "proj")
        up = os.path.join(root, "uploads")
        os.makedirs(up)
        f = os.path.join(up, "a.png")
        open(f, "wb").close()
        target = resolve_bound_workspace_file(root, "uploads/a.png")
        assert target.resolve() == os.path.realpath(f)
