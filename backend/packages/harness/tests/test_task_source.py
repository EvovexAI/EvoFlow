"""Unit tests for collab task_source taxonomy (chat|workflow|role only)."""

from __future__ import annotations

from evoflow.collab.task_source import (
    TASK_SOURCE_CHAT,
    TASK_SOURCE_ROLE,
    TASK_SOURCE_WORKFLOW,
    list_task_sources,
    normalize_task_source,
    resolve_write_source,
    sources_equal,
    task_source_zh,
)


def test_normalize_aliases():
    assert normalize_task_source("proactive_patrol") == TASK_SOURCE_ROLE
    assert normalize_task_source("employee_page") == TASK_SOURCE_ROLE
    assert normalize_task_source("chat_mention") == TASK_SOURCE_CHAT
    assert normalize_task_source("task_center") == TASK_SOURCE_WORKFLOW
    assert normalize_task_source("supervisor") == TASK_SOURCE_WORKFLOW
    assert normalize_task_source("manual") == TASK_SOURCE_CHAT
    assert normalize_task_source("cli") == TASK_SOURCE_CHAT
    assert normalize_task_source("api") == TASK_SOURCE_CHAT
    assert normalize_task_source("event:git_push") == TASK_SOURCE_ROLE
    assert normalize_task_source("") == ""


def test_sources_equal_matches_aliases():
    assert sources_equal("proactive_patrol", "role")
    assert sources_equal("task_center", "workflow")
    assert sources_equal("manual", "chat")
    assert not sources_equal("role", "workflow")


def test_resolve_write_source_keeps_channel():
    canon, channel = resolve_write_source("proactive_patrol")
    assert canon == TASK_SOURCE_ROLE
    assert channel == "proactive_patrol"
    canon2, channel2 = resolve_write_source("role")
    assert canon2 == TASK_SOURCE_ROLE
    assert channel2 is None


def test_labels_and_catalog():
    assert task_source_zh("proactive_dispatch") == "智能体岗位"
    assert task_source_zh("workflow") == "工作流"
    assert task_source_zh("manual") == "主对话"
    ids = {x["id"] for x in list_task_sources()}
    assert ids == {"chat", "workflow", "role"}
