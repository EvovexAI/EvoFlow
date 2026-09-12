"""Fast thread state read from checkpointer."""

from __future__ import annotations

import json
import os

import pytest
from langchain_core.messages import AIMessage, HumanMessage

from evoflow.agents.checkpointer.thread_state_reader import (
    get_thread_state_snapshot,
    json_safe_channel_values,
    parse_thread_id_from_state_path,
)


def test_json_safe_channel_values_serializes_messages() -> None:
    raw = {
        "messages": [HumanMessage(content="你好"), AIMessage(content="嗨")],
        "ui_messages": [HumanMessage(content="ui")],
        "title": "测试",
    }
    safe = json_safe_channel_values(raw)
    json.dumps(safe)
    assert safe["messages"][0]["type"] == "human"
    assert safe["messages"][0]["content"] == "你好"
    assert safe["messages"][1]["type"] == "ai"
    assert safe["title"] == "测试"


def test_parse_thread_state_path() -> None:
    assert parse_thread_id_from_state_path("threads/abc-123/state") == "abc-123"
    assert parse_thread_id_from_state_path("threads/abc-123/state/") == "abc-123"
    assert parse_thread_id_from_state_path("threads/search") is None


@pytest.mark.skipif(
    not os.getenv("EVOFLOW_CONFIG_PATH"),
    reason="needs real checkpointer config",
)
def test_get_thread_state_snapshot_shape() -> None:
    body = get_thread_state_snapshot("00000000-0000-0000-0000-000000000000")
    assert body is not None
    assert "values" in body
    assert body.get("source") == "checkpointer"
