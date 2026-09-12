"""read_file accepts absolute paths outside the bound workspace (IDE-like)."""

from __future__ import annotations

import os
import tempfile

from evoflow.tools.host_direct.read_file import _resolve_read_target
from evoflow.tools.host_direct.read_logic import read_file_content
from evoflow.tools.host_direct.workspace_path_guard import runtime_with_workspace


def test_read_file_absolute_path_outside_workspace() -> None:
    with tempfile.TemporaryDirectory() as workspace, tempfile.TemporaryDirectory() as outside:
        outside_file = os.path.join(outside, "secret.txt")
        with open(outside_file, "w", encoding="utf-8") as f:
            f.write("outside workspace\n")

        rt = runtime_with_workspace(workspace, "read_abs_test")
        resolved = _resolve_read_target(outside_file, runtime=rt)
        assert not isinstance(resolved, str)
        out = read_file_content(str(resolved))
        assert "outside workspace" in out
