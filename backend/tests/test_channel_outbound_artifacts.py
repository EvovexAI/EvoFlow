"""IM outbound artifacts: extract from reply body + resolve under thread roots."""

from __future__ import annotations

from pathlib import Path


def test_extract_artifacts_from_mixed_body_forms():
    from app.channels.manager import _extract_artifacts

    result = {
        "messages": [
            {"type": "human", "content": "给我图和视频"},
            {
                "type": "ai",
                "content": (
                    "封面如下：\n"
                    "![封面](workspace/assets/cover.png)\n"
                    "视频在 `uploads/clip.mp4`\n"
                    "还有 @@outputs/note.pdf@@\n"
                    "外链不上传 https://cdn.example.com/a.png\n"
                    "代码不上传 `src/main.py`"
                ),
            },
        ]
    }
    arts = _extract_artifacts(result)
    assert "workspace/assets/cover.png" in arts
    assert "uploads/clip.mp4" in arts
    assert "outputs/note.pdf" in arts
    assert not any("cdn.example.com" in a for a in arts)
    assert not any(a.endswith("main.py") for a in arts)


def test_extract_also_mines_response_text():
    from app.channels.manager import _extract_artifacts

    arts = _extract_artifacts(
        {"messages": []},
        response_text="请看 /mnt/user-data/workspace/shot.jpg",
    )
    assert arts == ["/mnt/user-data/workspace/shot.jpg"]


def test_resolve_attachments_from_workspace_and_uploads(tmp_path, monkeypatch):
    from app.channels import manager as mgr

    thread_id = "th_art_2"
    ud = tmp_path / "threads" / thread_id / "user-data"
    (ud / "workspace" / "assets").mkdir(parents=True)
    (ud / "uploads").mkdir(parents=True)
    (ud / "outputs").mkdir(parents=True)
    cover = ud / "workspace" / "assets" / "cover.png"
    clip = ud / "uploads" / "clip.mp4"
    cover.write_bytes(b"\x89PNG\r\n\x1a\n" + b"0" * 32)
    clip.write_bytes(b"fake-mp4")

    class _Paths:
        def sandbox_user_data_dir(self, tid: str):
            return ud

        def sandbox_outputs_dir(self, tid: str):
            return ud / "outputs"

        def sandbox_uploads_dir(self, tid: str):
            return ud / "uploads"

        def sandbox_work_dir(self, tid: str):
            return ud / "workspace"

        def acp_workspace_dir(self, tid: str):
            return tmp_path / "threads" / tid / "acp-workspace"

        def resolve_virtual_path(self, tid: str, virtual_path: str):
            assert virtual_path.startswith("/mnt/user-data/")
            rel = virtual_path[len("/mnt/user-data/") :]
            return ud / rel

    monkeypatch.setattr("evoflow.config.paths.get_paths", lambda: _Paths())

    attachments = mgr._resolve_attachments(
        thread_id,
        ["workspace/assets/cover.png", "uploads/clip.mp4", "C:/Windows/System32/drivers/etc/hosts"],
    )
    names = {a.filename for a in attachments}
    assert names == {"cover.png", "clip.mp4"}
    assert all(a.is_image is (a.filename.endswith(".png")) for a in attachments)


def test_resolve_absolute_project_image_outside_thread_sandbox(tmp_path, monkeypatch):
    """Skill/$PROJ frames live outside thread user-data — still deliver to Feishu."""
    from app.channels import manager as mgr

    thread_id = "th_abs_img"
    ud = tmp_path / "threads" / thread_id / "user-data"
    ud.mkdir(parents=True)
    proj = tmp_path / "knowledge-library" / "pack" / "data" / "scenes"
    proj.mkdir(parents=True)
    frame = proj / "frame_0001.jpg"
    frame.write_bytes(b"\xff\xd8\xff" + b"0" * 64)

    class _Paths:
        def sandbox_user_data_dir(self, tid: str):
            return ud

        def sandbox_outputs_dir(self, tid: str):
            return ud / "outputs"

        def sandbox_uploads_dir(self, tid: str):
            return ud / "uploads"

        def sandbox_work_dir(self, tid: str):
            return ud / "workspace"

        def acp_workspace_dir(self, tid: str):
            return tmp_path / "threads" / tid / "acp-workspace"

        def resolve_virtual_path(self, tid: str, virtual_path: str):
            raise ValueError("unused")

    monkeypatch.setattr("evoflow.config.paths.get_paths", lambda: _Paths())

    sensitive = tmp_path / "Windows" / "System32" / "evil.jpg"
    sensitive.parent.mkdir(parents=True)
    sensitive.write_bytes(b"\xff\xd8\xff" + b"1" * 16)

    abs_cite = str(frame).replace("\\", "/")
    attachments = mgr._resolve_attachments(
        thread_id,
        [abs_cite, str(sensitive).replace("\\", "/")],
    )
    assert len(attachments) == 1
    assert attachments[0].filename == "frame_0001.jpg"
    assert attachments[0].is_image


def test_feishu_outbound_file_kinds_media_for_mp4():
    from app.channels.feishu import FeishuChannel

    assert FeishuChannel._outbound_file_kinds(Path("a.mp4"), "a.mp4") == ("mp4", "media")
    assert FeishuChannel._outbound_file_kinds(Path("a.opus"), "a.opus") == ("opus", "audio")
    assert FeishuChannel._outbound_file_kinds(Path("a.pdf"), "a.pdf") == ("pdf", "file")
