"""Regression guardrails for wire tool-schema token bloat."""

from __future__ import annotations

import json

import pytest

from evoflow.community.baidu_search.tools import web_search_tool
from evoflow.community.web_fetch.tools import web_fetch_tool
from evoflow.context.compaction_token_utils import count_text_tokens, warm_token_encodings
from evoflow.context.model_request_token_estimate import wire_openai_tool_spec
from evoflow.tools.builtins.clarification_tool import ask_clarification_tool
from evoflow.tools.builtins.knowledge_vault_tools import knowledge_tool
from evoflow.tools.builtins.mind_map_tool import mind_map_tool
from evoflow.tools.builtins.platform_tool import platform_tool
from evoflow.tools.builtins.process_tool import process_tool
from evoflow.tools.builtins.read_lints_tool import read_lints_tool
from evoflow.tools.builtins.stage_tool import panel_set_tool
from evoflow.tools.builtins.task_tool import task_tool
from evoflow.tools.builtins.tasks_tool import tasks_tool
from evoflow.tools.builtins.view_image_tool import view_image_tool
from evoflow.tools.host_direct.delete_file import delete_file_hd
from evoflow.tools.host_direct.find_file import find_file_hd
from evoflow.tools.host_direct.read_file import read_file_hd
from evoflow.tools.host_direct.rg import rg_hd
from evoflow.tools.host_direct.search_code_index import search_code_index_hd
from evoflow.tools.host_direct.str_replace import str_replace_hd
from evoflow.tools.host_direct.terminal_tool import terminal_tool
from evoflow.tools.host_direct.trace_call_chain import trace_call_chain_hd
from evoflow.tools.host_direct.write_file import write_file_hd

warm_token_encodings()


def _wire_tokens(tool) -> int:
    spec = wire_openai_tool_spec(tool)
    blob = json.dumps(spec, ensure_ascii=False, separators=(",", ":"), default=str)
    return int(count_text_tokens(blob))


@pytest.mark.parametrize(
    ("tool", "max_tokens"),
    [
        (mind_map_tool, 900),
        (tasks_tool, 950),
        (knowledge_tool, 500),
        (panel_set_tool, 450),
        (task_tool, 400),
        (ask_clarification_tool, 350),
        (platform_tool, 200),
    ],
)
def test_heavy_tool_wire_schema_stays_within_budget(tool, max_tokens: int) -> None:
    tokens = _wire_tokens(tool)
    assert tokens <= max_tokens, f"{getattr(tool, 'name', tool)!r} wire schema={tokens} tokens (max {max_tokens})"


@pytest.mark.parametrize(
    ("tool", "max_tokens"),
    [
        (read_file_hd, 140),
        (write_file_hd, 130),
        (str_replace_hd, 130),
        (delete_file_hd, 90),
        (rg_hd, 240),
        (find_file_hd, 110),
        (search_code_index_hd, 210),
        (trace_call_chain_hd, 140),
        (terminal_tool, 150),
        (read_lints_tool, 110),
        (view_image_tool, 110),
        (process_tool, 170),
        (web_fetch_tool, 250),
        (web_search_tool, 150),
    ],
)
def test_basic_tool_wire_schema_stays_within_budget(tool, max_tokens: int) -> None:
    tokens = _wire_tokens(tool)
    desc = str(getattr(tool, "description", "") or "").strip()
    assert desc, f"{getattr(tool, 'name', tool)!r} should keep a short wire description"
    assert tokens <= max_tokens, f"{getattr(tool, 'name', tool)!r} wire schema={tokens} tokens (max {max_tokens})"
