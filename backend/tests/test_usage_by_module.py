"""Product-module usage classification for Settings."""

from __future__ import annotations

from evoflow.persistence.usage_by_module import (
    MODULE_CHAT,
    MODULE_EMPLOYEE,
    MODULE_KNOWLEDGE,
    MODULE_WORKFLOW,
    classify_session_module,
)


def test_classify_proactive_is_employee():
    assert (
        classify_session_module(session_key="proactive:xiaomi:duty:2026-11-08")
        == MODULE_EMPLOYEE
    )


def test_classify_executor_is_workflow():
    assert (
        classify_session_module(
            session_key="agent:executor:thread-1",
            agent_id="executor",
            collab_task_id="task-1",
        )
        == MODULE_WORKFLOW
    )


def test_classify_workflow_run_context():
    assert (
        classify_session_module(
            session_key="agent:main:new-abc",
            agent_id="main",
            context={"workflow_run": True, "app_id": "app-1"},
        )
        == MODULE_WORKFLOW
    )


def test_classify_plain_chat():
    assert classify_session_module(session_key="agent:main:new-abc", agent_id="main") == MODULE_CHAT


def test_classify_kb_prefix():
    assert classify_session_module(session_key="kb:ask:1") == MODULE_KNOWLEDGE
