"""Write-tool SSE wire: path-only tool_call args; body streams via write_file_progress deltas."""

from __future__ import annotations

import json

from app.gateway.sse_ui_normalize import UiStreamNormalizer, _build_slim_write_tool_call, _write_tool_line_stats


def test_write_tool_line_stats_write_and_replace():
    assert _write_tool_line_stats("write_to_file", {"content": "a\nb\nc"}) == (3, 0)
    assert _write_tool_line_stats("write", {"content": "a\nb"}) == (2, 0)
    assert _write_tool_line_stats(
        "replace_in_file",
        {"content": "new\nline", "old_string": "old"},
    ) == (2, 1)
    assert _write_tool_line_stats(
        "replace",
        {"content": "new\nline", "old_string": "old"},
    ) == (2, 1)


def test_sanitize_write_alias_name_emits_progress():
    norm = UiStreamNormalizer(user_input="write demo", anchored=True, allow_tuple_tools=True)
    tc = {
        "id": "call_write_alias",
        "name": "write",
        "function": {
            "name": "write",
            "arguments": '{"path":"smoke_test_temp.txt","content":"hello\\nworld"}',
        },
    }
    slim, progress = norm._sanitize_write_tool_call(tc, chunk_meta=tc)
    assert progress is not None
    assert progress["tool_call_id"] == "call_write_alias"
    assert progress["lines_added"] == 2
    assert progress["content_delta"] == "hello\nworld"
    assert progress["content_len"] == len("hello\nworld")
    assert json.loads(slim["function"]["arguments"]) == {"path": "smoke_test_temp.txt"}


def test_sanitize_write_tool_call_strips_content_and_emits_progress():
    norm = UiStreamNormalizer(user_input="write demo", anchored=True, allow_tuple_tools=True)
    tc = {
        "id": "call_write_1",
        "name": "write_to_file",
        "function": {
            "name": "write_to_file",
            "arguments": '{"path":"outputs/demo.txt","content":"line1\\nline2"}',
        },
    }
    slim, progress = norm._sanitize_write_tool_call(tc, chunk_meta=tc)
    assert progress is not None
    assert progress["type"] == "write_file_progress"
    assert progress["tool_call_id"] == "call_write_1"
    assert progress["lines_added"] == 2
    assert progress["lines_removed"] == 0
    assert progress["content_delta"] == "line1\nline2"
    assert progress["content_len"] == len("line1\nline2")
    fn = slim["function"]
    args = json.loads(fn["arguments"])
    assert args == {"path": "outputs/demo.txt"}
    assert "content" not in args

    slim2, progress2 = norm._sanitize_write_tool_call(
        {
            "id": "call_write_1",
            "function": {
                "arguments": '{"path":"outputs/demo.txt","content":"line1\\nline2\\nline3"}',
            },
        },
        chunk_meta={"index": 0, "id": "call_write_1"},
    )
    assert progress2 is not None
    assert progress2["lines_added"] == 3
    assert progress2["content_delta"] == "\nline3"
    assert progress2["content_len"] == len("line1\nline2\nline3")
    fn2 = slim2["function"]
    assert json.loads(fn2["arguments"]) == {"path": "outputs/demo.txt"}


def test_sanitize_write_emits_progress_on_same_line_content_growth():
    """Content can grow without a new line; UI still needs deltas."""
    norm = UiStreamNormalizer(user_input="write demo", anchored=True, allow_tuple_tools=True)
    tc1 = {
        "id": "call_write_same_line",
        "name": "write",
        "function": {
            "name": "write",
            "arguments": '{"path":"a.txt","content":"hello"}',
        },
    }
    _, p1 = norm._sanitize_write_tool_call(tc1, chunk_meta=tc1)
    assert p1 is not None
    assert p1["content_delta"] == "hello"
    assert p1["lines_added"] == 1

    _, p2 = norm._sanitize_write_tool_call(
        {
            "id": "call_write_same_line",
            "function": {"arguments": '{"path":"a.txt","content":"hello world"}'},
        },
        chunk_meta={"index": 0, "id": "call_write_same_line"},
    )
    assert p2 is not None
    assert p2["lines_added"] == 1
    assert p2["content_delta"] == " world"
    assert p2["content_len"] == len("hello world")


def test_incremental_vendor_argument_fragments_stream_content_deltas():
    """OpenAI-style incremental function.arguments fragments must emit live deltas.

    Regression: old ``_merge_tool_calls`` kept the longer fragment and dropped
    prior pieces, so content only appeared once the full JSON arrived.
    """
    from app.gateway.agui_stream_normalizer import AgUiEncoderState, evf_payload_to_agui_events

    norm = UiStreamNormalizer(
        user_input="write demo",
        anchored=True,
        allow_tuple_tools=True,
        thread_id="t-inc",
    )
    fragments = [
        '{"path":"outputs/老友记.md","content":"',
        "# 老友记\\n\\n",
        "## 一、发小\\n\\n",
        "人生第一份友情",
        '"}',
    ]
    out: list = []
    for i, frag in enumerate(fragments):
        ch = {
            "index": 0,
            "id": "call_inc_write",
            "name": "write" if i == 0 else "",
            "function": {
                "name": "write" if i == 0 else "",
                "arguments": frag,
            },
        }
        meta = norm.block_ledger.before_tools()
        norm._append_write_tool_wire(
            out, ch, ev_type="tool_call_chunk", source="messages", chunk_meta=ch, meta=meta
        )

    progress = [p for p in out if p.get("type") == "write_file_progress"]
    assert len(progress) >= 2, f"expected multiple live progress events, got {len(progress)}: {progress}"
    joined = "".join(str(p.get("content_delta") or p.get("content") or "") for p in progress)
    assert "老友记" in joined
    assert "发小" in joined
    assert "人生第一份友情" in joined

    state = AgUiEncoderState(thread_id="t-inc", run_id="r1")
    custom_deltas: list[str] = []
    for p in out:
        for e in evf_payload_to_agui_events(p, state=state):
            if e.get("type") == "CUSTOM" and e.get("name") == "write_file_progress":
                v = e.get("value") or {}
                if v.get("content_delta"):
                    custom_deltas.append(str(v["content_delta"]))
                elif v.get("content"):
                    custom_deltas.append(str(v["content"]))
    assert len(custom_deltas) >= 2
    assert "老友记" in "".join(custom_deltas)


def test_build_slim_write_tool_call_keeps_path_only():
    slim = _build_slim_write_tool_call(
        {"id": "x", "name": "write_to_file", "function": {"name": "write_to_file", "arguments": "{}"}},
        {"path": "a/b.txt", "content": "secret body"},
    )
    assert json.loads(slim["function"]["arguments"]) == {"path": "a/b.txt"}
    assert slim.get("args") == {"path": "a/b.txt"}


def test_build_slim_write_omits_args_until_path_known():
    slim = _build_slim_write_tool_call(
        {
            "id": "x",
            "name": "write",
            "function": {"name": "write", "arguments": '{"content":"---"}'},
            "args": {"content": "---"},
        },
        {"path": "", "content": "---"},
    )
    assert slim["function"]["arguments"] == ""
    assert "args" not in slim
    assert "input" not in slim


def test_content_before_path_emits_progress_with_path():
    """Regression: content-first JSON left path empty forever in write_file_progress.

    Progress used to fire only on content growth; when path arrived on the final
    fragment with no further content growth, UI/wire kept path=\"\".
    """
    from app.gateway.sse_ui_normalize import _merge_tool_call_arg_strings

    # Cumulative snapshot merge must not drop path when a longer content-only
    # object arrives (vendor quirks / partial re-parses).
    merged = _merge_tool_call_arg_strings(
        '{"path":"a.md","content":"hi"}',
        '{"content":"hi there longer"}',
    )
    obj = json.loads(merged)
    assert obj.get("path") == "a.md"
    assert "hi there longer" in str(obj.get("content") or "")

    norm = UiStreamNormalizer(user_input="write demo", anchored=True, allow_tuple_tools=True)
    fragments = [
        '{"content":"',
        "---",
        "\\n",
        "title",
        '","path":"outputs/demo.md"}',
    ]
    out: list = []
    for i, frag in enumerate(fragments):
        ch = {
            "id": "call_content_first",
            "name": "write" if i == 0 else "",
            "function": {
                "name": "write" if i == 0 else "",
                "arguments": frag,
            },
        }
        meta = norm.block_ledger.before_tools()
        norm._append_write_tool_wire(
            out, ch, ev_type="tool_call_chunk", source="messages", chunk_meta=ch, meta=meta
        )

    progress = [p for p in out if p.get("type") == "write_file_progress"]
    assert progress, "expected write_file_progress events"
    assert any(not str(p.get("path") or "").strip() for p in progress[:-1]) or len(progress) >= 2
    assert str(progress[-1].get("path") or "") == "outputs/demo.md"
    joined = "".join(str(p.get("content_delta") or "") for p in progress)
    assert "---" in joined
    assert "title" in joined

    # No useless TOOL_CALL_ARGS "{}" while path unknown — wire args stay empty until path.
    early_args = []
    for p in out:
        if p.get("type") != "tool_call_chunk":
            continue
        args = str((p.get("chunk") or {}).get("function", {}).get("arguments") or "")
        early_args.append(args)
    assert "" in early_args
    assert '{"path":"outputs/demo.md"}' in early_args
    assert "{}" not in early_args


def test_replace_old_new_before_path_emits_path_and_new_string_delta():
    """replace often streams old_string/new_string before path — same late-path fix as write."""
    from app.gateway.sse_ui_normalize import _extract_write_fields_from_partial_args

    # Nested "path" inside old_string must not steal the real root path.
    nested = (
        '{"old_string":"const cfg = {\\"path\\": \\"nested\\"}","new_string":"x",'
        '"path":"src/real.py"}'
    )
    fields = _extract_write_fields_from_partial_args(nested)
    assert fields["path"] == "src/real.py"
    assert "nested" in fields["old_string"]

    norm = UiStreamNormalizer(user_input="replace demo", anchored=True, allow_tuple_tools=True)
    fragments = [
        '{"old_string":"',
        'hello',
        ' world","new_string":"',
        'hel',
        'lo',
        ' ',
        '.',
        '","path":"',
        'src/demo.py"}',
    ]
    out: list = []
    for i, frag in enumerate(fragments):
        ch = {
            "id": "call_replace_late_path",
            "name": "replace" if i == 0 else "",
            "function": {
                "name": "replace" if i == 0 else "",
                "arguments": frag,
            },
        }
        meta = norm.block_ledger.before_tools()
        norm._append_write_tool_wire(
            out, ch, ev_type="tool_call_chunk", source="messages", chunk_meta=ch, meta=meta
        )

    progress = [p for p in out if p.get("type") == "write_file_progress"]
    assert progress, "expected write_file_progress events"
    assert any(not str(p.get("path") or "").strip() for p in progress)
    assert str(progress[-1].get("path") or "") == "src/demo.py"
    joined = "".join(str(p.get("content_delta") or "") for p in progress)
    assert "hel" in joined and "." in joined
    # replace should also expose new_string_delta for AG-UI diff binding
    assert any(p.get("new_string_delta") for p in progress)

    wire_args = [
        str((p.get("chunk") or {}).get("function", {}).get("arguments") or "")
        for p in out
        if p.get("type") == "tool_call_chunk"
    ]
    assert '{"path":"src/demo.py"}' in wire_args
    assert "{}" not in wire_args


def test_sanitize_delete_tool_call_no_write_progress():
    norm = UiStreamNormalizer(user_input="delete demo", anchored=True, allow_tuple_tools=True)
    tc = {
        "id": "call_delete_1",
        "name": "delete",
        "function": {
            "name": "delete",
            "arguments": '{"path":"smoke_test_temp.txt"}',
        },
    }
    slim, progress = norm._sanitize_write_tool_call(tc, chunk_meta=tc)
    assert progress is None
    assert slim is tc or slim.get("name") == "delete"
