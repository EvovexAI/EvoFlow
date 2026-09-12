import tempfile
from pathlib import Path
from unittest.mock import patch

from langchain_core.messages import HumanMessage
from langgraph.runtime import Runtime

from evoflow.agents.middlewares.context_files_middleware import ContextFilesMiddleware


def test_before_agent_captures_context_files_on_state():
    mw = ContextFilesMiddleware()
    msg = HumanMessage(
        content="fix bug",
        additional_kwargs={"context_files": [{"path": "hello.txt", "name": "hello.txt"}]},
    )
    runtime = Runtime(context={})
    out = mw.before_agent({"messages": [msg]}, runtime)
    assert out == {"context_files": [{"path": "hello.txt", "name": "hello.txt"}]}


def test_before_model_injects_context_files_block():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        f = root / "hello.txt"
        f.write_text("hello world", encoding="utf-8")
        mw = ContextFilesMiddleware()
        msg = HumanMessage(
            content="fix bug",
            additional_kwargs={"context_files": [{"path": "hello.txt", "name": "hello.txt"}]},
        )
        runtime = Runtime(context={"local_workspace_root": str(root)})
        captured = mw.before_agent({"messages": [msg]}, runtime)
        assert captured is not None
        state = {"messages": [msg], **captured}
        out = mw.before_model(state, runtime)
        assert out is not None
        updated = out["messages"][-1]
        text = updated.content if isinstance(updated.content, str) else str(updated.content)
        assert "<context_files>" in text
        assert "hello world" in text
        assert "fix bug" in text


def test_before_model_uses_state_context_files_after_hydration_wipe():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        f = root / "hello.txt"
        f.write_text("from state", encoding="utf-8")
        mw = ContextFilesMiddleware()
        hydrated = HumanMessage(content="fix bug", id="user-1")
        runtime = Runtime(context={"local_workspace_root": str(root)})
        out = mw.before_model(
            {
                "messages": [hydrated],
                "context_files": [{"path": "hello.txt", "name": "hello.txt"}],
            },
            runtime,
        )
        assert out is not None
        text = out["messages"][-1].content
        assert "<context_files>" in text
        assert "from state" in text


def test_before_model_injects_native_image_for_vision_model(tmp_path: Path):
    img = tmp_path / "photo.jpg"
    img.write_bytes(b"\xff\xd8\xff\xe0" + b"\0" * 64)
    mw = ContextFilesMiddleware()
    msg = HumanMessage(
        content="这是什么",
        additional_kwargs={
            "context_files": [{"path": str(img), "name": "photo.jpg"}],
        },
    )
    runtime = Runtime(context={"local_workspace_root": str(tmp_path), "model_name": "vision-pro"})
    captured = mw.before_agent({"messages": [msg]}, runtime)
    state = {"messages": [msg], **(captured or {})}
    with patch(
        "evoflow.agents.middlewares.context_files_middleware.main_model_supports_vision",
        return_value=True,
    ):
        out = mw.before_model(state, runtime)
    assert out is not None
    updated = out["messages"][-1]
    text = mw._human_text(updated)
    assert "do NOT call view_image" in text
    assert isinstance(updated.content, list)
    assert any(
        isinstance(b, dict) and b.get("type") == "image_url" and "data:image" in str(b.get("image_url", {}).get("url", ""))
        for b in updated.content
    )


def test_before_model_image_context_files_prompts_view_image_without_vision(tmp_path: Path):
    img = tmp_path / "photo.jpg"
    img.write_bytes(b"\xff\xd8\xff\xe0" + b"\0" * 64)
    mw = ContextFilesMiddleware()
    msg = HumanMessage(
        content="这是什么",
        additional_kwargs={
            "context_files": [{"path": str(img), "name": "photo.jpg"}],
        },
    )
    runtime = Runtime(context={"local_workspace_root": str(tmp_path)})
    with patch(
        "evoflow.agents.middlewares.context_files_middleware.main_model_supports_vision",
        return_value=False,
    ):
        out = mw.before_model({"messages": [msg]}, runtime)
    assert out is not None
    text = out["messages"][-1].content
    assert "view_image" in text
    assert not isinstance(out["messages"][-1].content, list) or not any(
        isinstance(b, dict) and b.get("type") == "image_url" for b in (out["messages"][-1].content or [])
    )
