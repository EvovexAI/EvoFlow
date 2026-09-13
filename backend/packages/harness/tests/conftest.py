"""Harness pytest bootstrap: sys.path + break evoflow.subagents executor import cycle."""

import sys
from pathlib import Path
from unittest.mock import MagicMock

_backend_root = Path(__file__).resolve().parents[3]
# ``app`` now resolves unambiguously to backend/app (the packages/harness/app
# shim was removed — see backend/ARCHITECTURE.md, Phase 2). Keep both roots on
# the path so evoflow.* and app.gateway.* both import from the real sources.
sys.path.insert(0, str(_backend_root / "packages" / "harness"))
sys.path.insert(0, str(_backend_root))

_executor_mock = MagicMock()
_executor_mock.SubagentExecutor = MagicMock
_executor_mock.SubagentResult = MagicMock
_executor_mock.SubagentStatus = MagicMock
_executor_mock.MAX_CONCURRENT_SUBAGENTS = 5
_executor_mock.get_background_task_result = MagicMock()

sys.modules["evoflow.subagents.executor"] = _executor_mock


def pytest_configure(config) -> None:
    config.addinivalue_line(
        "markers",
        "live_llm: hits running Gateway with real LLM (EVOFLOW_EVAL_LIVE_LLM=1)",
    )
