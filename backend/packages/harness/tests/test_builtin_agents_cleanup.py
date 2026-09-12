"""Builtin subagent registry hygiene (delist ephemeral workers, tool names, UI names)."""

from __future__ import annotations

from evoflow.collab.agent_assignment import BUILTIN_AGENT_UI_NAMES
from evoflow.config.agents_config import _BUILTIN_SUBAGENT_UI_NAMES
from evoflow.subagents.builtins import BUILTIN_SUBAGENTS, FILE_WORKER_CONFIG, SEARCH_WORKER_CONFIG
from evoflow.subagents.builtins.bash_agent import BASH_AGENT_CONFIG
from evoflow.subagents.builtins.project_crew import PROJECT_ARCHITECT_CONFIG


def test_file_worker_not_in_registry_but_ephemeral_config_exists() -> None:
    assert "file-worker" not in BUILTIN_SUBAGENTS
    assert "search-worker" not in BUILTIN_SUBAGENTS
    assert FILE_WORKER_CONFIG.name == "file-worker"
    assert SEARCH_WORKER_CONFIG.name == "search-worker"


def test_bash_and_project_use_modern_tool_names() -> None:
    assert "bash" not in (BASH_AGENT_CONFIG.tools or [])
    assert "read_file" not in (BASH_AGENT_CONFIG.tools or [])
    assert "terminal" in (BASH_AGENT_CONFIG.tools or [])
    assert "read" in (BASH_AGENT_CONFIG.tools or [])
    assert "read_file" not in (PROJECT_ARCHITECT_CONFIG.tools or [])
    assert "read" in (PROJECT_ARCHITECT_CONFIG.tools or [])


def test_builtin_ui_names_cover_core_and_knowledge() -> None:
    for code, label in (
        ("code-agent", "代码助手"),
        ("knowledge-retriever", "知识检索"),
        ("knowledge-curator", "知识整理"),
        ("xiaomi", "小V"),
        ("main", "EvoFlow"),
    ):
        if code in {"main", "xiaomi"}:
            assert BUILTIN_AGENT_UI_NAMES.get(code) == label
        else:
            assert _BUILTIN_SUBAGENT_UI_NAMES.get(code) == label
            assert BUILTIN_AGENT_UI_NAMES.get(code) == label
