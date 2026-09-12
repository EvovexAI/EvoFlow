"""Tests for AioSandbox write-path allowlist (security hardening).

These tests verify that ``AioSandbox.write_file`` / ``update_file`` reject
writes to system directories and read-only mounts, mirroring the intent of
``sandbox/tools.py:validate_local_tool_path`` but operating on container-internal
paths (the AIO sandbox already has /mnt/user-data bind-mounted).

The container-internal path validation function is unit-tested directly so no
running Docker container is required.
"""

from __future__ import annotations

import base64
from unittest.mock import MagicMock

import pytest

from evoflow.community.aio_sandbox.aio_sandbox import (
    AioSandbox,
    _reject_path_traversal,
    _validate_writable_container_path,
)

# ─── _reject_path_traversal ────────────────────────────────────────────────


class TestRejectPathTraversal:
    def test_clean_path_passes(self):
        _reject_path_traversal("/mnt/user-data/workspace/file.txt")

    def test_dotdot_rejected(self):
        with pytest.raises(PermissionError, match="traversal"):
            _reject_path_traversal("/mnt/user-data/workspace/../../../etc/passwd")

    def test_dotdot_backslash_rejected(self):
        with pytest.raises(PermissionError, match="traversal"):
            _reject_path_traversal("/mnt/user-data\\..\\..\\etc")


# ─── _validate_writable_container_path ─────────────────────────────────────


class TestValidateWritableContainerPath:
    @pytest.mark.parametrize(
        "path",
        [
            "/mnt/user-data/workspace/file.txt",
            "/mnt/user-data/uploads/image.png",
            "/mnt/user-data/outputs/report.md",
            "/mnt/user-data/workspace",  # exact prefix dir itself
            "/mnt/user-data/workspace/nested/deep/file.py",
        ],
    )
    def test_writable_user_data_paths_allowed(self, path):
        # Should not raise
        _validate_writable_container_path(path)

    @pytest.mark.parametrize(
        "path",
        [
            "/bin/sh",
            "/usr/bin/python3",
            "/etc/passwd",
            "/sbin/init",
            "/opt/exploit",
            "/root/.bashrc",
            "/tmp/evil",  # tmp is not in the writable allowlist at the app layer
        ],
    )
    def test_system_paths_rejected(self, path):
        with pytest.raises(PermissionError):
            _validate_writable_container_path(path)

    @pytest.mark.parametrize(
        "path",
        [
            "/mnt/skills/public/bootstrap/SKILL.md",
            "/mnt/skills",  # root itself
            "/mnt/acp-workspace/hello.py",
            "/mnt/acp-workspace",  # root itself
        ],
    )
    def test_readonly_mounts_rejected(self, path):
        with pytest.raises(PermissionError):
            _validate_writable_container_path(path)

    def test_user_data_root_itself_rejected(self):
        # /mnt/user-data is the parent, not one of the writable subdirs
        with pytest.raises(PermissionError):
            _validate_writable_container_path("/mnt/user-data")

    def test_user_data_arbitrary_subdir_rejected(self):
        # Only workspace/uploads/outputs are writable; arbitrary siblings are not
        with pytest.raises(PermissionError):
            _validate_writable_container_path("/mnt/user-data/secret/file")

    def test_empty_path_rejected(self):
        with pytest.raises(PermissionError):
            _validate_writable_container_path("")

    def test_non_string_rejected(self):
        with pytest.raises(PermissionError):
            _validate_writable_container_path(None)  # type: ignore[arg-type]

    def test_traversal_into_allowed_prefix_rejected(self):
        # /mnt/user-data/workspace/../../etc must be caught by traversal check
        with pytest.raises(PermissionError, match="traversal"):
            _validate_writable_container_path("/mnt/user-data/workspace/../../etc/passwd")

    def test_normalised_redundant_separators(self):
        # posixpath.normpath collapses // — should still match allowed prefix
        _validate_writable_container_path("/mnt/user-data//workspace/file.txt")


# ─── AioSandbox.write_file / update_file integration ───────────────────────


def _make_aio_sandbox():
    """Build an AioSandbox-like object with a mocked client (no real container).

    AioSandbox is abstract (inherits abstract ``delete_file``), so we build a
    concrete subclass that provides a no-op ``delete_file`` and then patch the
    client to a MagicMock.
    """
    class _ConcreteAioSandbox(AioSandbox):
        def delete_file(self, path: str) -> None:  # type: ignore[override]
            pass

    sandbox = _ConcreteAioSandbox.__new__(_ConcreteAioSandbox)
    sandbox._id = "test"  # type: ignore[attr-defined]
    sandbox._base_url = "http://localhost:8080"  # type: ignore[attr-defined]
    sandbox._client = MagicMock()  # type: ignore[attr-defined]
    sandbox._home_dir = "/home/sandbox"  # type: ignore[attr-defined]
    return sandbox


class TestWriteFileGuard:
    def test_write_to_system_path_raises_before_api_call(self):
        sb = _make_aio_sandbox()
        with pytest.raises(PermissionError):
            sb.write_file("/bin/malicious", "payload")
        # Client must never have been called
        sb._client.file.write_file.assert_not_called()

    def test_write_to_etc_raises_before_api_call(self):
        sb = _make_aio_sandbox()
        with pytest.raises(PermissionError):
            sb.write_file("/etc/passwd", "hacked")
        sb._client.file.write_file.assert_not_called()

    def test_write_to_skills_raises(self):
        sb = _make_aio_sandbox()
        with pytest.raises(PermissionError, match="skills"):
            sb.write_file("/mnt/skills/public/x.py", "x")
        sb._client.file.write_file.assert_not_called()

    def test_write_to_acp_workspace_raises(self):
        sb = _make_aio_sandbox()
        with pytest.raises(PermissionError, match="ACP"):
            sb.write_file("/mnt/acp-workspace/x.py", "x")
        sb._client.file.write_file.assert_not_called()

    def test_write_to_user_data_workspace_succeeds(self):
        sb = _make_aio_sandbox()
        sb.write_file("/mnt/user-data/workspace/out.txt", "hello")
        sb._client.file.write_file.assert_called_once_with(
            file="/mnt/user-data/workspace/out.txt", content="hello"
        )

    def test_write_to_user_data_outputs_succeeds(self):
        sb = _make_aio_sandbox()
        sb.write_file("/mnt/user-data/outputs/report.md", "# Report")
        sb._client.file.write_file.assert_called_once()

    def test_append_reads_existing_then_writes(self):
        sb = _make_aio_sandbox()
        # read_file returns content via the mocked client
        sb._client.file.read_file.return_value = MagicMock(data=MagicMock(content="existing\n"))
        sb.write_file("/mnt/user-data/workspace/log.txt", "new", append=True)
        sb._client.file.write_file.assert_called_once_with(
            file="/mnt/user-data/workspace/log.txt", content="existing\nnew"
        )

    def test_append_to_system_path_still_blocked(self):
        sb = _make_aio_sandbox()
        with pytest.raises(PermissionError):
            sb.write_file("/usr/bin/evil", "x", append=True)
        sb._client.file.write_file.assert_not_called()


class TestUpdateFileGuard:
    def test_update_system_path_raises(self):
        sb = _make_aio_sandbox()
        with pytest.raises(PermissionError):
            sb.update_file("/bin/payload", b"binary")
        sb._client.file.write_file.assert_not_called()

    def test_update_user_data_workspace_succeeds(self):
        sb = _make_aio_sandbox()
        sb.update_file("/mnt/user-data/workspace/blob.bin", b"\x00\x01")
        sb._client.file.write_file.assert_called_once()
        call_kwargs = sb._client.file.write_file.call_args.kwargs
        assert call_kwargs["file"] == "/mnt/user-data/workspace/blob.bin"
        assert call_kwargs["encoding"] == "base64"
        # base64 content decodes back to original bytes
        assert base64.b64decode(call_kwargs["content"]) == b"\x00\x01"

    def test_update_skills_raises(self):
        sb = _make_aio_sandbox()
        with pytest.raises(PermissionError, match="skills"):
            sb.update_file("/mnt/skills/x", b"x")
        sb._client.file.write_file.assert_not_called()
