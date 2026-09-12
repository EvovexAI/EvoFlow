"""Default local workspace file root (no threads/{id} for outputs/)."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path
from unittest.mock import patch

from evoflow.tools.host_direct.workspace_context import (
    evoflow_home_project_root,
    resolve_host_workspace_root_for_files,
)


def test_evoflow_home_project_root_strips_data_suffix():
    with patch.dict(os.environ, {"EVOFLOW_HOME": "D:/proj/data"}, clear=False):
        assert evoflow_home_project_root().replace("\\", "/") == "D:/proj"


def test_evoflow_home_project_root_strips_legacy_workspace_data_suffix():
    with patch.dict(os.environ, {"EVOFLOW_HOME": "D:/proj/workspace/data"}, clear=False):
        assert evoflow_home_project_root().replace("\\", "/") == "D:/proj"


def test_resolve_host_workspace_root_without_virtual_paths():
    with tempfile.TemporaryDirectory() as tmp:
        project = Path(tmp) / "myproj"
        project.mkdir()
        evoflow_home = project / "data"
        evoflow_home.mkdir(parents=True)
        with patch.dict(os.environ, {"EVOFLOW_HOME": str(evoflow_home)}, clear=False):
            with patch(
                "evoflow.tools.host_direct.workspace_context.thread_use_virtual_paths",
                return_value=False,
            ):
                with patch(
                    "evoflow.tools.host_direct.workspace_context.load_local_workspace_root_for_thread",
                    return_value="",
                ):
                    root = resolve_host_workspace_root_for_files(thread_id="thread-abc")
        assert root is not None
        assert Path(root).resolve() == project.resolve()


def test_resolve_host_workspace_root_uses_evoflow_home_when_unbound_even_if_virtual():
    with tempfile.TemporaryDirectory() as tmp:
        project = Path(tmp) / "myproj"
        project.mkdir()
        evoflow_home = project / "data"
        evoflow_home.mkdir(parents=True)
        with patch.dict(os.environ, {"EVOFLOW_HOME": str(evoflow_home)}, clear=False):
            with patch(
                "evoflow.tools.host_direct.workspace_context.thread_use_virtual_paths",
                return_value=True,
            ):
                with patch(
                    "evoflow.tools.host_direct.workspace_context.load_local_workspace_root_for_thread",
                    return_value="",
                ):
                    root = resolve_host_workspace_root_for_files(thread_id="thread-abc")
        assert root is not None
        assert Path(root).resolve() == project.resolve()


def test_resolve_host_workspace_root_prefers_bound_over_virtual():
    with patch(
        "evoflow.tools.host_direct.workspace_context.load_local_workspace_root_for_thread",
        return_value="D:/bound-proj",
    ):
        with patch(
            "evoflow.tools.host_direct.workspace_context.thread_use_virtual_paths",
            return_value=True,
        ):
            assert resolve_host_workspace_root_for_files(thread_id="thread-abc") == "D:/bound-proj"
