"""冷恢复 hydration：subagent 工具行必须合成 kind:"subagent" 镜像行。

ZCode 契约：subagent 镜像事件进事件日志。冷恢复没有镜像事件，但 transcript 里
有 subagent 工具调用（args.description/subagent_type）与结果（success/error），
可据此重建——否则刷新后 Agent 工具卡丢类型徽标与配对，掉回通用 JSON 卡。
"""

from __future__ import annotations

import json
from unittest.mock import patch

from app.gateway.v4.conversation import HUB
from app.gateway.v4.hydration import hydrate_session_from_transcript


def _messages() -> list[dict[str, object]]:
    assistant_args = {
        "description": "读取项目概览",
        "prompt": "轻量探查",
        "subagent_type": "code-agent",
    }
    return [
        {
            "role": "user",
            "content_json": json.dumps({"content": "帮我探查项目"}),
            "run_id": "run-h1",
            "message_id": "u1",
        },
        {
            "role": "assistant",
            "content_json": json.dumps(
                {
                    "content": "",
                    "tool_calls": [
                        {"id": "tc-h1", "name": "subagent", "args": assistant_args}
                    ],
                }
            ),
            "run_id": "run-h1",
            "message_id": "a1",
        },
        {
            "role": "tool",
            "tool_call_id": "tc-h1",
            "content_json": json.dumps({"content": "仓库形态：前后端分离。", "result": "success"}),
            "run_id": "run-h1",
        },
    ]


def test_hydration_synthesizes_subagent_row() -> None:
    tid = "hydrate-subagent-test"
    if tid in getattr(HUB, "_sessions", {}):
        del HUB._sessions[tid]  # noqa: SLF001
    with (
        patch(
            "evoflow.persistence.session_repositories.find_session_key_by_thread_id",
            return_value="",
        ),
        patch(
            "evoflow.persistence.chat_message_repositories.conversation_archive_from_thread_id",
            return_value=[],
        ),
        patch(
            "app.gateway.v4.hydration._load_raw_messages_by_thread",
            return_value=_messages(),
        ),
    ):
        count = hydrate_session_from_transcript(HUB, tid)
    assert count > 0

    sess = HUB.get_session(tid)
    assert sess is not None
    rows = sorted(sess.rows.values(), key=lambda r: int(r["rowId"]))
    sub_rows = [r for r in rows if r.get("kind") == "subagent"]
    assert len(sub_rows) == 1, rows
    row = sub_rows[0]
    assert row["parentToolCallId"] == "tc-h1"
    assert row["subagentType"] == "code-agent"
    assert row["status"] == "success"
    assert row["summaryText"] == "读取项目概览"
    assert row["turnId"] == "run-h1"
    # 宿主 toolCall 行存在且同轮——前端 pairSubagentRows 的配对条件。
    hosts = [
        r
        for r in rows
        if r.get("kind") == "toolCall"
        and r.get("toolCallId") == "tc-h1"
        and r.get("turnId") == row["turnId"]
    ]
    assert len(hosts) == 1


def test_hydration_subagent_error_maps_to_failed() -> None:
    tid = "hydrate-subagent-error-test"
    if tid in getattr(HUB, "_sessions", {}):
        del HUB._sessions[tid]  # noqa: SLF001
    messages = _messages()
    messages[-1]["content_json"] = json.dumps({"content": "boom", "result": "error"})
    with (
        patch(
            "evoflow.persistence.session_repositories.find_session_key_by_thread_id",
            return_value="",
        ),
        patch(
            "evoflow.persistence.chat_message_repositories.conversation_archive_from_thread_id",
            return_value=[],
        ),
        patch(
            "app.gateway.v4.hydration._load_raw_messages_by_thread",
            return_value=messages,
        ),
    ):
        hydrate_session_from_transcript(HUB, tid)

    sess = HUB.get_session(tid)
    assert sess is not None
    sub_rows = [r for r in sess.rows.values() if r.get("kind") == "subagent"]
    assert len(sub_rows) == 1
    assert sub_rows[0]["status"] == "failed"
