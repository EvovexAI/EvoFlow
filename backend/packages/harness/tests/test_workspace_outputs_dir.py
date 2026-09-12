"""Bound workspace outputs path resolution."""

from pathlib import Path
from unittest.mock import MagicMock

from evoflow.tools.host_direct.workspace_context import (
    bound_workspace_thread_paths,
    resolve_effective_outputs_dir,
)


def _runtime_with_root(root: Path, *, sandbox_outputs: Path, virtual: bool = False):
    class _Ctx:
        def get(self, key, default=None):
            data = {
                "local_workspace_root": str(root),
                "use_virtual_paths": virtual,
                "thread_id": "thread-1",
            }
            return data.get(key, default)

    rt = MagicMock()
    rt.context = _Ctx()
    rt.config = {"configurable": {"local_workspace_root": str(root), "use_virtual_paths": virtual}}
    rt.state = {"thread_data": {"outputs_path": str(sandbox_outputs)}}
    return rt


def test_resolve_effective_outputs_dir_prefers_bound_workspace(tmp_path):
    ws = tmp_path / "project"
    ws.mkdir()
    sandbox = tmp_path / "sandbox" / "outputs"
    sandbox.mkdir(parents=True)

    rt = _runtime_with_root(ws, sandbox_outputs=sandbox)
    out = resolve_effective_outputs_dir(runtime=rt)
    assert out == (ws / "outputs").resolve()
    assert out != sandbox.resolve()


def test_bound_workspace_thread_paths_overrides_sandbox(tmp_path):
    ws = tmp_path / "project"
    ws.mkdir()
    sandbox_paths = {
        "workspace_path": str(tmp_path / "sandbox" / "workspace"),
        "uploads_path": str(tmp_path / "sandbox" / "uploads"),
        "outputs_path": str(tmp_path / "sandbox" / "outputs"),
    }
    rt = _runtime_with_root(ws, sandbox_outputs=Path(sandbox_paths["outputs_path"]))
    mapped = bound_workspace_thread_paths(sandbox_paths, runtime=rt)
    assert mapped["outputs_path"] == str((ws / "outputs").resolve())
    assert mapped["workspace_path"] == str(ws.resolve())


def test_virtual_paths_keeps_sandbox_outputs(tmp_path):
    ws = tmp_path / "project"
    ws.mkdir()
    sandbox = tmp_path / "sandbox" / "outputs"
    sandbox.mkdir(parents=True)
    rt = _runtime_with_root(ws, sandbox_outputs=sandbox, virtual=True)
    out = resolve_effective_outputs_dir(runtime=rt)
    assert out == sandbox.resolve()
