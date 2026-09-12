"""Tests for OpenAI-compat App parameter mapping (no gateway / DB)."""

from __future__ import annotations

import pytest

from evoflow.collab.app_openai_compat import (
    build_chat_completion_response,
    build_response_data,
    collect_new_step_stream_pieces,
    extract_last_user_text,
    format_step_stream_piece,
    load_app_for_run,
    map_chat_to_parameters,
    missing_required_parameters,
    progress_fingerprint,
    publicize_step_response,
    resolve_app_id_from_request,
    resolve_step_agent,
    should_append_final_answer_delta,
    summarize_run_content,
    wait_for_run_terminal,
)


def test_extract_last_user_text():
    messages = [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "first"},
        {"role": "assistant", "content": "ok"},
        {"role": "user", "content": " second "},
    ]
    assert extract_last_user_text(messages) == "second"


def test_map_variables_and_query_alias():
    app = {
        "parameters": [
            {"name": "topic", "label": "主题"},
            {"name": "query", "label": "问题"},
        ]
    }
    params = map_chat_to_parameters(
        app,
        variables={"topic": "AI"},
        messages=[{"role": "user", "content": "帮我调研"}],
    )
    assert params == {"topic": "AI", "query": "帮我调研"}


def test_missing_required_parameters():
    app = {
        "parameters": [
            {"name": "topic", "required": True},
            {"name": "optional", "required": False},
            {"name": "query", "required": 1},
        ]
    }
    assert missing_required_parameters(app, {"topic": "x"}) == ["query"]
    assert missing_required_parameters(app, {"topic": "x", "query": "q"}) == []
    assert missing_required_parameters(app, {"topic": "  ", "query": "q"}) == ["topic"]


def test_map_does_not_overwrite_variable_query():
    app = {"parameters": [{"name": "query"}]}
    params = map_chat_to_parameters(
        app,
        variables={"query": "from-var"},
        messages=[{"role": "user", "content": "from-msg"}],
    )
    assert params["query"] == "from-var"


def test_resolve_app_id_accepts_model_match():
    assert (
        resolve_app_id_from_request(
            bound_app_id="App_abc",
            model="App_abc",
            body_app_id=None,
        )
        == "App_abc"
    )


def test_resolve_app_id_rejects_conflicting_app_id():
    with pytest.raises(ValueError, match="appId"):
        resolve_app_id_from_request(
            bound_app_id="App_abc",
            body_app_id="App_other",
        )


def test_resolve_app_id_ignores_non_app_model():
    assert (
        resolve_app_id_from_request(
            bound_app_id="App_abc",
            model="gpt-4o",
        )
        == "App_abc"
    )


def test_wait_for_run_terminal_success():
    calls = {"n": 0}

    def get_status(_rid: str):
        calls["n"] += 1
        if calls["n"] < 3:
            return {"status": "running", "progress": 10}
        return {"status": "completed", "result_summary": "done"}

    doc = wait_for_run_terminal(
        "Run_1",
        get_status=get_status,
        timeout_sec=5,
        poll_interval_sec=0.01,
    )
    assert doc["status"] == "completed"
    assert calls["n"] == 3


def test_wait_for_run_terminal_timeout():
    with pytest.raises(TimeoutError):
        wait_for_run_terminal(
            "Run_x",
            get_status=lambda _r: {"status": "running"},
            timeout_sec=0.05,
            poll_interval_sec=0.02,
        )


def test_build_example_chat_request_is_paste_ready():
    from evoflow.collab.app_openai_compat import (
        build_example_chat_request,
        build_example_chat_response,
        build_example_variables,
        build_response_contract,
        sample_parameter_value,
    )

    assert sample_parameter_value({"name": "topic", "default": "AI"}) == "AI"
    assert sample_parameter_value(
        {"name": "format", "type": "select", "options": ["Markdown", "PDF"]}
    ) == "Markdown"
    assert "<" not in sample_parameter_value({"name": "topic", "label": "主题"})

    app = {
        "name": "竞品调研",
        "goal_template": "调研 {{topic}}",
        "answer_from_ref": "2",
        "version": 3,
        "parameters": [
            {"name": "topic", "label": "主题", "required": True},
            {
                "name": "format",
                "type": "select",
                "options": ["Markdown"],
                "required": False,
            },
        ],
        "steps": [
            {
                "ref": "1",
                "name": "调研",
                "assigned_agent": "researcher",
            },
            {
                "ref": "2",
                "name": "撰稿",
                "assigned_agent": "writer",
            },
        ],
    }
    vars_map = build_example_variables(app)
    assert vars_map == {"topic": "示例主题", "format": "Markdown"}
    body = build_example_chat_request("App_x", app, detail=True)
    assert body["model"] == "App_x"
    assert body["detail"] is True
    assert body["variables"]["topic"] == "示例主题"
    assert "竞品调研" in body["messages"][0]["content"]

    resp = build_example_chat_response("App_x", app, detail=True)
    assert resp["choices"][0]["message"]["content"].startswith("（示例）撰稿")
    assert [r["assigned_agent"] for r in resp["responseData"]] == [
        "researcher",
        "writer",
    ]
    assert resp["evoflow"]["flowResponses"][1]["ref"] == "2"
    contract = build_response_contract()
    assert "assigned_agent" in contract["detail_true"]["step_fields"]


def test_summarize_and_build_response():
    content = summarize_run_content(
        {"status": "completed", "result_summary": "报告完成"}
    )
    assert content == "报告完成"
    resp = build_chat_completion_response(
        app_id="App_1", content=content, run_id="Run_1"
    )
    assert resp["object"] == "chat.completion"
    assert resp["model"] == "App_1"
    assert resp["choices"][0]["message"]["content"] == "报告完成"
    assert resp["evoflow"]["run_id"] == "Run_1"
    assert "responseData" not in resp


def test_build_response_includes_agent_identity_when_detail():
    doc = {
        "status": "completed",
        "result_summary": "总答",
        "steps": [
            {
                "ref": "1",
                "name": "调研",
                "assigned_agent": "researcher",
                "status": "completed",
                "result_summary": "竞品 A/B",
                "subtask_id": "s1",
            },
            {
                "ref": "2",
                "name": "撰稿",
                "assigned_agent": "writer",
                "status": "completed",
                "result_summary": "Markdown OK",
                "subtask_id": "s2",
            },
        ],
    }
    rows = build_response_data(doc)
    assert [r["assigned_agent"] for r in rows] == ["researcher", "writer"]
    assert rows[0]["moduleName"] == "调研"
    assert rows[0]["moduleType"] == "agentStep"
    assert rows[0]["agent"] == "researcher"
    assert rows[1]["ref"] == "2"

    resp = build_chat_completion_response(
        app_id="App_1",
        content="总答",
        run_id="Run_1",
        status_doc=doc,
        detail=True,
    )
    assert resp["responseData"] == rows
    assert resp["evoflow"]["flowResponses"] == rows
    assert resp["choices"][0]["message"]["content"] == "总答"


def test_format_step_stream_piece_includes_agent():
    text = format_step_stream_piece(
        {
            "ref": "1",
            "name": "调研",
            "assigned_agent": "researcher",
            "status": "completed",
            "result_summary": "ok",
        }
    )
    assert "@researcher" in text
    assert "调研" in text
    assert resolve_step_agent({"assigned_to": "coder"}) == "coder"
    pub = publicize_step_response(
        {"ref": "9", "assigned_agent": "ops", "status": "completed", "result_summary": "x"}
    )
    assert pub["moduleName"] == "ops"
    assert pub["assigned_agent"] == "ops"


def test_summarize_prefers_last_step_when_no_overall():
    doc = {
        "status": "completed",
        "steps": [
            {
                "ref": "1",
                "status": "completed",
                "result_summary": "第一步",
            },
            {
                "ref": "2",
                "status": "completed",
                "result_summary": "最终结论",
            },
        ],
    }
    assert summarize_run_content(doc) == "最终结论"


def test_summarize_prefers_answer_from_ref():
    doc = {
        "status": "completed",
        "answer_from_ref": "1",
        "result_summary": "任务级摘要应被答案节点覆盖",
        "steps": [
            {"ref": "1", "status": "completed", "result_summary": "公开答案"},
            {"ref": "2", "status": "completed", "result_summary": "收尾日志"},
        ],
    }
    assert summarize_run_content(doc) == "公开答案"


def test_should_append_final_answer_skips_duplicate_last_step():
    doc = {
        "status": "completed",
        "result_summary": "最终结论",
        "steps": [
            {"ref": "1", "status": "completed", "result_summary": "第一步"},
            {"ref": "2", "status": "completed", "result_summary": "最终结论"},
        ],
    }
    assert should_append_final_answer_delta(
        "最终结论",
        streamed_parts=["### 步骤 2\n最终结论"],
        status_doc=doc,
    ) is False
    assert should_append_final_answer_delta(
        "最终结论",
        streamed_parts=[],
        status_doc=doc,
    ) is True
    assert should_append_final_answer_delta(
        "另外一句总结",
        streamed_parts=["### 步骤 2\n最终结论"],
        status_doc=doc,
    ) is True


def test_collect_new_step_stream_pieces_incremental():
    emitted: set[str] = set()
    doc1 = {
        "status": "running",
        "steps": [
            {
                "ref": "1",
                "subtask_id": "s1",
                "name": "调研",
                "status": "completed",
                "result_summary": "发现 3 个竞品",
            },
            {"ref": "2", "subtask_id": "s2", "name": "报告", "status": "running"},
        ],
    }
    pieces = collect_new_step_stream_pieces(doc1, emitted)
    assert len(pieces) == 1
    assert "调研" in pieces[0]
    assert "发现 3 个竞品" in pieces[0]
    assert emitted == {"s1"}

    doc2 = {
        "status": "completed",
        "steps": [
            {
                "ref": "1",
                "subtask_id": "s1",
                "name": "调研",
                "status": "completed",
                "result_summary": "发现 3 个竞品",
            },
            {
                "ref": "2",
                "subtask_id": "s2",
                "name": "报告",
                "status": "completed",
                "result_summary": "Markdown OK",
            },
        ],
    }
    pieces2 = collect_new_step_stream_pieces(doc2, emitted)
    assert len(pieces2) == 1
    assert "报告" in pieces2[0]
    assert collect_new_step_stream_pieces(doc2, emitted) == []


def test_collect_buffers_until_lower_ref_done():
    """Parallel finish of ref 3 before ref 2 must not jump the stream."""
    emitted: set[str] = set()
    doc = {
        "status": "running",
        "steps": [
            {
                "ref": "1",
                "subtask_id": "s1",
                "name": "A",
                "status": "completed",
                "result_summary": "a",
            },
            {
                "ref": "2",
                "subtask_id": "s2",
                "name": "B",
                "status": "running",
            },
            {
                "ref": "3",
                "subtask_id": "s3",
                "name": "C",
                "status": "completed",
                "result_summary": "c",
            },
        ],
    }
    pieces = collect_new_step_stream_pieces(doc, emitted)
    assert len(pieces) == 1 and "A" in pieces[0]
    assert "s3" not in emitted

    doc2 = {
        "status": "completed",
        "steps": [
            {
                "ref": "1",
                "subtask_id": "s1",
                "name": "A",
                "status": "completed",
                "result_summary": "a",
            },
            {
                "ref": "2",
                "subtask_id": "s2",
                "name": "B",
                "status": "completed",
                "result_summary": "b",
            },
            {
                "ref": "3",
                "subtask_id": "s3",
                "name": "C",
                "status": "completed",
                "result_summary": "c",
            },
        ],
    }
    pieces2 = collect_new_step_stream_pieces(doc2, emitted)
    assert [p.split("\n", 1)[0] for p in pieces2] == ["## B", "## C"]


def test_progress_fingerprint_stable_until_change():
    a = {"status": "executing", "progress": 10, "subtask_status": {"1": "executing"}}
    b = {"status": "executing", "progress": 10, "subtask_status": {"1": "executing"}}
    c = {"status": "executing", "progress": 20, "subtask_status": {"1": "completed"}}
    assert progress_fingerprint(a) == progress_fingerprint(b)
    assert progress_fingerprint(a) != progress_fingerprint(c)


def test_load_app_for_run_merges_revision_snapshot(monkeypatch):
    from evoflow.collab import app_openai_compat as mod

    monkeypatch.setattr(
        mod.app_repositories,
        "load_app",
        lambda _id: {
            "id": "App_1",
            "name": "live",
            "version": 3,
            "status": "published",
            "parameters": [{"name": "a"}],
            "steps": [{"ref": "1", "name": "new"}],
            "execution_mode": "workflow",
        },
    )
    monkeypatch.setattr(
        mod.app_repositories,
        "load_revision",
        lambda _id, ver: {
            "version": ver,
            "snapshot": {
                "name": "pinned",
                "parameters": [{"name": "old_param", "required": True}],
                "steps": [{"ref": "1", "name": "old"}],
                "execution_mode": "workflow",
            },
        },
    )
    app = load_app_for_run("App_1", pinned_version=2)
    assert app["name"] == "pinned"
    assert app["version"] == 2
    assert app["parameters"][0]["name"] == "old_param"
    assert app["status"] == "published"


def test_async_body_field_alias_with_pydantic():
    """Mirror ChatCompletionsRequest async alias (avoid importing gateway here)."""
    from pydantic import BaseModel, Field

    class Body(BaseModel):
        stream: bool = False
        async_: bool = Field(default=False, alias="async")
        model_config = {"populate_by_name": True}

    body = Body.model_validate({"async": True, "stream": False})
    assert body.async_ is True
    assert body.stream is False
