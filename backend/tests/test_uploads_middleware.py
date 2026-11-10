from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from langchain_core.messages import HumanMessage

from evoflow.agents.middlewares.uploads_middleware import UploadsMiddleware


class _Paths:
    def __init__(self, uploads_dir: Path):
        self._uploads_dir = uploads_dir

    def sandbox_uploads_dir(self, _thread_id: str) -> Path:
        return self._uploads_dir


def test_upload_middleware_injects_extracted_document_text(tmp_path: Path, monkeypatch):
    uploads_dir = tmp_path / "uploads"
    uploads_dir.mkdir()
    (uploads_dir / "report.pdf").write_bytes(b"pdf")
    monkeypatch.setattr("evoflow.knowledge.parser.parse_file", lambda _path: "Quarterly revenue: 42")

    middleware = UploadsMiddleware()
    middleware._paths = _Paths(uploads_dir)
    state = {
        "messages": [
            HumanMessage(
                content="Summarize this",
                additional_kwargs={
                    "files": [{"filename": "report.pdf", "size": 3, "path": "/mnt/user-data/uploads/report.pdf"}]
                },
            )
        ]
    }
    runtime = SimpleNamespace(context={"thread_id": "thread-1"})

    result = middleware.before_model(state, runtime)

    assert "Quarterly revenue: 42" in result["messages"][0].content
    assert "Content extraction failed" not in result["messages"][0].content


def test_upload_middleware_does_not_parse_image_attachments(tmp_path: Path, monkeypatch):
    uploads_dir = tmp_path / "uploads"
    uploads_dir.mkdir()
    (uploads_dir / "photo.png").write_bytes(b"png")
    monkeypatch.setattr(
        "evoflow.knowledge.parser.parse_file",
        lambda _path: (_ for _ in ()).throw(AssertionError("image must not use document parser")),
    )

    middleware = UploadsMiddleware()
    middleware._paths = _Paths(uploads_dir)
    state = {
        "messages": [
            HumanMessage(
                content="What is in this image?",
                additional_kwargs={
                    "files": [{"filename": "photo.png", "size": 3, "path": "/mnt/user-data/uploads/photo.png"}]
                },
            )
        ]
    }
    runtime = SimpleNamespace(context={"thread_id": "thread-1"})

    result = middleware.before_model(state, runtime)

    assert "Image attached" in result["messages"][0].content
    assert "reference_image_urls" in result["messages"][0].content


def test_upload_middleware_local_host_injects_absolute_path_for_images(tmp_path: Path):
    uploads_dir = tmp_path / "uploads"
    uploads_dir.mkdir()
    photo = uploads_dir / "pasted-image-1.png"
    photo.write_bytes(b"png-bytes")

    middleware = UploadsMiddleware()
    middleware._paths = _Paths(uploads_dir)
    state = {
        "messages": [
            HumanMessage(
                content=[
                    {"type": "text", "text": "改中间标题"},
                    {
                        "type": "image_url",
                        "image_url": {"url": "data:image/png;base64,aaa"},
                    },
                ],
                additional_kwargs={
                    "files": [
                        {
                            "filename": "pasted-image-1.png",
                            "size": 9,
                            "path": "/mnt/user-data/uploads/pasted-image-1.png",
                            "absolute_path": str(photo.resolve()),
                        }
                    ]
                },
            )
        ]
    }
    # Desktop default: use_virtual_paths is false / absent → host absolute Path.
    runtime = SimpleNamespace(context={"thread_id": "thread-1"})

    result = middleware.before_model(state, runtime)
    msg = result["messages"][0]
    assert isinstance(msg.content, list)
    text_block = next(b for b in msg.content if isinstance(b, dict) and b.get("type") == "text")
    assert str(photo.resolve()) in text_block["text"]
    assert "reference_image_urls" in text_block["text"]
    # Must keep vision pixels — previously UploadsMiddleware stripped image_url.
    assert any(isinstance(b, dict) and b.get("type") == "image_url" for b in msg.content)


def test_upload_middleware_virtual_paths_keep_mnt_prefix(tmp_path: Path):
    uploads_dir = tmp_path / "uploads"
    uploads_dir.mkdir()
    (uploads_dir / "photo.png").write_bytes(b"png")

    middleware = UploadsMiddleware()
    middleware._paths = _Paths(uploads_dir)
    state = {
        "messages": [
            HumanMessage(
                content="look",
                additional_kwargs={
                    "files": [{"filename": "photo.png", "size": 3, "path": "/mnt/user-data/uploads/photo.png"}]
                },
            )
        ]
    }
    runtime = SimpleNamespace(context={"thread_id": "thread-1", "use_virtual_paths": True})

    result = middleware.before_model(state, runtime)
    assert "/mnt/user-data/uploads/photo.png" in result["messages"][0].content
