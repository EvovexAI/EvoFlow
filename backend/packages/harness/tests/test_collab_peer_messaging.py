"""Collab peer messaging (private subtask threads)."""

from __future__ import annotations

import asyncio

import pytest

from evoflow.collab.peer.service import peer_read, peer_reply, peer_send
from evoflow.collab.peer.thread_key import build_thread_key
from evoflow.collab.storage import get_project_storage, new_project_bundle_root_task
from evoflow.collab.subtask_outcome import apply_subtask_outcome_report
from evoflow.persistence import peer_repositories as peer_repo


@pytest.fixture
def peer_collab(tmp_path, monkeypatch):
    monkeypatch.setenv("EVOFLOW_DATA_DIR", str(tmp_path))
    storage = get_project_storage()
    project, task = new_project_bundle_root_task("main", "x" * 30, thread_id="t_peer")
    task_id = str(task["id"])
    task["subtasks"] = [
        {
            "id": "Subtask_fe",
            "ref": "1",
            "name": "frontend",
            "status": "executing",
            "assigned_to": "general-purpose",
        },
        {
            "id": "Subtask_be",
            "ref": "2",
            "name": "backend",
            "status": "executing",
            "assigned_to": "general-purpose",
        },
        {
            "id": "Subtask_qa",
            "ref": "3",
            "name": "qa",
            "status": "executing",
            "assigned_to": "general-purpose",
        },
    ]
    storage.save_project(project)
    return storage, task_id


def test_completed_sender_cannot_peer_send(peer_collab) -> None:
    storage, task_id = peer_collab

    async def _complete() -> None:
        await apply_subtask_outcome_report(
            main_task_id=task_id,
            subtask_id="Subtask_be",
            outcome="completed",
            summary="API done",
            storage=storage,
        )

    asyncio.run(_complete())

    async def _send() -> dict:
        return await peer_send(
            main_task_id=task_id,
            from_subtask_id="Subtask_be",
            to_subtask="Subtask_fe",
            message="question?",
        )

    res = asyncio.run(_send())
    assert res.get("ok") is False


def test_executing_can_ask_completed(peer_collab) -> None:
    storage, task_id = peer_collab

    async def _complete_be() -> None:
        await apply_subtask_outcome_report(
            main_task_id=task_id,
            subtask_id="Subtask_be",
            outcome="completed",
            summary="API spec in task_report",
            storage=storage,
        )

    asyncio.run(_complete_be())

    async def _ask() -> dict:
        return await peer_send(
            main_task_id=task_id,
            from_subtask_id="Subtask_fe",
            to_subtask="2",
            message="What is the pagination param?",
            expect_reply=False,
        )

    res = asyncio.run(_ask())
    assert res.get("ok") is True
    tk = build_thread_key("Subtask_fe", "Subtask_be")
    msgs = peer_repo.list_peer_messages(task_id, thread_key=tk)
    assert len(msgs) == 1
    assert msgs[0]["direction"] == "question"


def test_peer_read_thread_isolation(peer_collab) -> None:
    _, task_id = peer_collab

    async def _seed() -> None:
        await peer_send(
            main_task_id=task_id,
            from_subtask_id="Subtask_fe",
            to_subtask="Subtask_be",
            message="fe question",
            expect_reply=False,
        )
        await peer_send(
            main_task_id=task_id,
            from_subtask_id="Subtask_qa",
            to_subtask="Subtask_be",
            message="qa question",
            expect_reply=False,
        )

    asyncio.run(_seed())

    fe_view = peer_read(main_task_id=task_id, reader_party="Subtask_fe")
    qa_view = peer_read(main_task_id=task_id, reader_party="Subtask_qa")
    fe_keys = set((fe_view.get("threads") or {}).keys())
    qa_keys = set((qa_view.get("threads") or {}).keys())
    assert build_thread_key("Subtask_fe", "Subtask_be") in fe_keys
    assert build_thread_key("Subtask_qa", "Subtask_be") in qa_keys
    assert build_thread_key("Subtask_qa", "Subtask_be") not in fe_keys
    assert build_thread_key("Subtask_fe", "Subtask_be") not in qa_keys


def test_peer_reply_and_read(peer_collab) -> None:
    _, task_id = peer_collab

    async def _flow() -> None:
        sent = await peer_send(
            main_task_id=task_id,
            from_subtask_id="Subtask_fe",
            to_subtask="Subtask_be",
            message="path?",
            expect_reply=False,
        )
        qid = str(sent["messageId"])
        replied = await peer_reply(
            main_task_id=task_id,
            subtask_id="Subtask_be",
            in_reply_to=qid,
            message="/api/users",
        )
        assert replied.get("ok") is True
        view = peer_read(main_task_id=task_id, reader_party="Subtask_fe")
        bodies = [
            m.get("body")
            for thread in (view.get("threads") or {}).values()
            for m in thread
        ]
        assert "/api/users" in bodies

    asyncio.run(_flow())
