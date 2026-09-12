import tempfile
from pathlib import Path
from unittest.mock import patch

from evoflow.code_index.store import build_index, search_index
from evoflow.scheduler.search_follow_read import (
    follow_read_after_search,
    format_read_catalog,
    paths_from_search_data,
)


def _orch_cfg(*, hybrid: object | None = None):
    if hybrid is None:
        hybrid = type(
            "H",
            (),
            {
                "post_search_parallel_read_enabled": True,
                "post_search_path_catalog_max": 24,
                "post_search_read_context_before": 12,
                "post_search_read_context_after": 48,
                "post_search_read_fallback_lines": 80,
            },
        )()
    local = type("LS", (), {"max_io_concurrency": 8})()
    return type("Cfg", (), {"hybrid": hybrid, "local_scheduler": local})()


def _capture_emit(emitted: list[dict]):
    def _emit(payload, **kwargs):
        emitted.append(payload)

    return _emit


def test_paths_from_search_data_prioritizes_symbols():
    data = {
        "symbols": [{"path": "a.py", "name": "Foo", "kind": "class", "line": 1}],
        "hits": [{"path": "b.py", "snippet": "x"}],
    }
    paths = paths_from_search_data(data, "/ws", max_files=2)
    assert len(paths) == 2
    assert paths[0].endswith("a.py")
    assert paths[1].endswith("b.py")


def test_format_read_catalog_numbered():
    paths = ["/ws/a.py", "/ws/b.py"]
    text = format_read_catalog(paths, workspace_root="/ws")
    assert "[0] a.py" in text
    assert "[1] b.py" in text
    assert "read_offset=0 read_limit=2" in text
    assert "read_file on the top 1-2 catalog paths" in text


def test_follow_read_catalog_when_hybrid_disabled():
    data = {
        "symbols": [{"path": "feishu.py", "name": "FeishuChannel", "kind": "class", "line": 1}],
        "hits": [],
    }
    with (
        patch("evoflow.scheduler.search_follow_read.hybrid_search_scheduler_enabled", return_value=False),
        patch("evoflow.scheduler.search_follow_read.get_agent_orchestration_config", return_value=_orch_cfg()),
    ):
        block = follow_read_after_search(data, workspace_root="/ws", read_offset=0, read_limit=0)

    assert "Read catalog" in block
    assert "[0] feishu.py:1" in block
    assert "<post_search_reads" not in block


def test_follow_read_catalog_only_when_read_limit_zero():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "feishu.py").write_text("class FeishuChannel:\n    pass\n", encoding="utf-8")
        build_index(str(root), force=True)
        data = search_index(str(root), "FeishuChannel", limit=5)
        emitted: list[dict] = []

        with (
            patch("evoflow.scheduler.prefetch_stream._emit", side_effect=_capture_emit(emitted)),
            patch("evoflow.scheduler.search_follow_read.hybrid_search_scheduler_enabled", return_value=True),
            patch("evoflow.scheduler.search_follow_read.get_agent_orchestration_config", return_value=_orch_cfg()),
        ):
            block = follow_read_after_search(data, workspace_root=str(root), read_offset=0, read_limit=0)

        assert "Read catalog" in block
        assert "[0]" in block
        assert "<post_search_reads" not in block
        assert not any(e.get("type") == "prefetch_tool_calls_batch" for e in emitted)


def test_follow_read_respects_model_read_limit_not_config_cap():
    root = "/ws"
    data = {
        "symbols": [{"path": f"f{i}.py", "name": "x", "kind": "variable", "line": 1} for i in range(8)],
        "hits": [],
    }
    emitted: list[dict] = []

    with (
        patch("evoflow.scheduler.prefetch_stream._emit", side_effect=_capture_emit(emitted)),
        patch("evoflow.scheduler.search_follow_read.hybrid_search_scheduler_enabled", return_value=True),
        patch("evoflow.scheduler.search_follow_read.get_agent_orchestration_config", return_value=_orch_cfg()),
        patch("evoflow.scheduler.search_follow_read.read_target_snippet", return_value="1:snippet\n"),
    ):
        block = follow_read_after_search(
            data,
            workspace_root=root,
            read_offset=0,
            read_limit=7,
        )

    assert "<post_search_reads offset=0 limit=7" in block
    batch = next((e for e in emitted if e.get("type") == "prefetch_tool_calls_batch"), None)
    assert batch is not None
    assert len(batch.get("calls") or []) == 7


def test_follow_read_search_only_when_auto_read_disabled():
    data = {
        "symbols": [{"path": "feishu.py", "name": "FeishuChannel", "kind": "class", "line": 1}],
        "hits": [],
    }
    hybrid = type(
        "H",
        (),
        {
            "post_search_parallel_read_enabled": False,
            "post_search_auto_read_enabled": False,
            "post_search_read_batch_max": 5,
            "post_search_path_catalog_max": 24,
            "post_search_read_context_before": 12,
            "post_search_read_context_after": 48,
            "post_search_read_fallback_lines": 80,
        },
    )()

    with (
        patch("evoflow.scheduler.search_follow_read.hybrid_search_scheduler_enabled", return_value=True),
        patch("evoflow.scheduler.search_follow_read.get_agent_orchestration_config", return_value=_orch_cfg(hybrid=hybrid)),
    ):
        block = follow_read_after_search(data, workspace_root="/ws", read_offset=0, read_limit=0)

    assert "Read catalog" in block
    assert "[0] feishu.py:1" in block
    assert "Scheduler batch read is off" in block


def test_follow_read_no_batch_when_parallel_disabled():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "main.py").write_text("class FeishuChannel:\n    pass\n", encoding="utf-8")
        build_index(str(root), force=True)
        data = search_index(str(root), "FeishuChannel", limit=5)
        emitted: list[dict] = []
        hybrid = type(
            "H",
            (),
            {
                "post_search_parallel_read_enabled": False,
                "post_search_auto_read_enabled": False,
                "post_search_read_batch_max": 5,
                "post_search_path_catalog_max": 24,
                "post_search_read_context_before": 12,
                "post_search_read_context_after": 48,
                "post_search_read_fallback_lines": 80,
            },
        )()

        with (
            patch("evoflow.scheduler.prefetch_stream._emit", side_effect=_capture_emit(emitted)),
            patch("evoflow.scheduler.search_follow_read.hybrid_search_scheduler_enabled", return_value=True),
            patch("evoflow.scheduler.search_follow_read.get_agent_orchestration_config", return_value=_orch_cfg(hybrid=hybrid)),
        ):
            block = follow_read_after_search(
                data,
                workspace_root=str(root),
                read_offset=0,
                read_limit=5,
            )

        assert "Read catalog" in block
        assert "Scheduler batch read is off" in block
        assert not any(e.get("type") == "prefetch_tool_calls_batch" for e in emitted)


def test_follow_read_paginated_batch_when_parallel_enabled():
    data = {
        "symbols": [
            {"path": "main.py", "name": "FeishuChannel", "kind": "class", "line": 1},
            {"path": "f0.py", "name": "Other", "kind": "class", "line": 3},
        ],
        "hits": [],
    }
    emitted: list[dict] = []
    hybrid = type(
        "H",
        (),
        {
            "post_search_parallel_read_enabled": True,
            "post_search_auto_read_enabled": False,
            "post_search_read_batch_max": 5,
            "post_search_path_catalog_max": 24,
            "post_search_read_context_before": 12,
            "post_search_read_context_after": 48,
            "post_search_read_fallback_lines": 80,
        },
    )()

    with (
        patch("evoflow.scheduler.prefetch_stream._emit", side_effect=_capture_emit(emitted)),
        patch("evoflow.scheduler.search_follow_read.hybrid_search_scheduler_enabled", return_value=True),
        patch("evoflow.scheduler.search_follow_read.get_agent_orchestration_config", return_value=_orch_cfg(hybrid=hybrid)),
        patch("evoflow.scheduler.search_follow_read.read_target_snippet", return_value="1:snippet\n"),
    ):
        block = follow_read_after_search(
            data,
            workspace_root="/ws",
            read_offset=0,
            read_limit=2,
        )

    assert "<post_search_reads offset=0 limit=2" in block
    batch = next((e for e in emitted if e.get("type") == "prefetch_tool_calls_batch"), None)
    assert batch is not None
    assert len(batch.get("calls") or []) == 2


def test_follow_read_uses_anchor_snippet_not_whole_file():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        filler = "\n".join(f"# filler {i}" for i in range(120))
        body = f"{filler}\nclass FeishuChannel:\n    pass\n"
        (root / "feishu.py").write_text(body, encoding="utf-8")
        build_index(str(root), force=True)
        data = search_index(str(root), "FeishuChannel", limit=5)

        hybrid = type(
            "H",
            (),
            {
                "post_search_parallel_read_enabled": True,
                "post_search_path_catalog_max": 24,
                "post_search_read_context_before": 2,
                "post_search_read_context_after": 2,
                "post_search_read_fallback_lines": 20,
            },
        )()

        with (
            patch("evoflow.scheduler.prefetch_stream._emit"),
            patch("evoflow.scheduler.search_follow_read.hybrid_search_scheduler_enabled", return_value=True),
            patch("evoflow.scheduler.search_follow_read.get_agent_orchestration_config", return_value=_orch_cfg(hybrid=hybrid)),
        ):
            block = follow_read_after_search(
                data,
                workspace_root=str(root),
                read_offset=0,
                read_limit=1,
            )

        assert "FeishuChannel" in block
        assert "filler 0" not in block
        assert "filler 50" not in block
