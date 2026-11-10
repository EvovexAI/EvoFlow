"""压缩日志触发源标签（manual / emergency / auto）回归。"""

from __future__ import annotations

import logging

from langchain_core.messages import AIMessage, HumanMessage

from evoflow.agents.context_compaction_core import (
    log_compaction_model_payload,
    log_compaction_pass_result,
)

_LOGGER = "evoflow.agents.context_compaction_core"


def _msgs():
    return [HumanMessage(content="你好"), AIMessage(content="回复")]


def test_pass_line_contains_manual_source(caplog):
    with caplog.at_level(logging.INFO, logger=_LOGGER):
        log_compaction_pass_result(
            _msgs(),
            _msgs()[:1],
            context_length=1_000_000,
            thread_id="t1",
            pass_label="pass1",
            trigger_source="manual",
        )
    assert "PASS pass1 [manual]" in caplog.text


def test_pass_line_defaults_to_auto(caplog):
    with caplog.at_level(logging.INFO, logger=_LOGGER):
        log_compaction_pass_result(
            _msgs(),
            _msgs()[:1],
            context_length=1_000_000,
            thread_id="t1",
            pass_label="pass1",
        )
    assert "PASS pass1 [auto]" in caplog.text


def test_payload_line_contains_source(caplog):
    with caplog.at_level(logging.INFO, logger=_LOGGER):
        log_compaction_model_payload(
            _msgs(),
            _msgs()[:1],
            context_length=1_000_000,
            thread_id="t1",
            passes=["pass1"],
            note="conversation_fold",
            trigger_source="manual",
        )
    assert "source=manual" in caplog.text
