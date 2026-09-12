"""Tests for post-edit scheduler lint (parallel read_lints UI rows)."""

from __future__ import annotations

import tempfile
from pathlib import Path
from unittest.mock import patch

from evoflow.config.agent_orchestration_config import AgentOrchestrationConfig
from evoflow.scheduler.post_edit_lint import follow_lint_after_edit


def test_follow_lint_after_edit_emits_prefetch_batch():
    with tempfile.TemporaryDirectory() as tmp:
        f = Path(tmp) / "a.py"
        f.write_text("x=1\n", encoding="utf-8")
        emitted: list[dict] = []

        cfg = AgentOrchestrationConfig()
        cfg.hybrid.post_edit_parallel_lint_enabled = True
        cfg.hybrid.post_edit_auto_lint_enabled = True

        with (
            patch(
                "evoflow.scheduler.prefetch_stream._emit",
                side_effect=lambda p, **_: emitted.append(p),
            ),
            patch("evoflow.scheduler.post_edit_lint.hybrid_post_edit_lint_enabled", return_value=True),
            patch("evoflow.scheduler.post_edit_lint._auto_lint_enabled", return_value=True),
            patch("evoflow.scheduler.post_edit_lint.get_agent_orchestration_config", return_value=cfg),
            patch(
                "evoflow.tools.code_lint.lint_path_post_edit",
                return_value="python (ruff): No issues found.",
            ),
        ):
            block = follow_lint_after_edit(str(f))

        assert "<post_edit_lints" in block
        batch = [e for e in emitted if e.get("type") == "prefetch_tool_calls_batch"]
        assert batch
        calls = batch[0].get("calls") or []
        assert calls[0].get("tool_name") == "read_lints"
        assert calls[0].get("invocation_source") == "post_edit"
