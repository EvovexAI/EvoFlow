"""Regression tests for noisy/redundant SSE frame emitters.

These tests cover the streaming path the user complained about in
``sse-recv.log`` lines 3-22 — specifically the minimal
``{"type":"thread_state","anchored":true}`` frame emitted by the
attach/resume path and the live ``thread_state`` dedup signature.

Background: the previous live normalizer computed ``last_thread_state_sig``
over the full ``state_payload`` dict, including the entire ``toolCalls``
list.  Because tool calls change every super-step (yet have their own
dedicated ``tool_call`` events), the ``thread_state`` payload would be
re-emitted on every step and balloon the wire dump.  The attach/resume
path additionally emitted a redundant ``{"type":"thread_state","anchored":true}``
frame on first poll that carried no useful metadata and forced the
front-end panel to a transient ``idle`` state.

Both pieces of noise are removed by these tests:

* ``test_attach_first_poll_emits_no_thread_state_anchor`` — the
  ``AttachEvfDiffEmitter`` no longer emits a minimal anchor frame on
  its first successful poll; it now returns ``[]`` so the live normalizer
  can drive the panel from its own richer ``thread_state`` payload.
* ``test_live_thread_state_dedup_ignores_tool_calls_changes`` — the live
  normalizer's ``last_thread_state_sig`` only covers fields the panel
  actually re-renders on (``title``/``todos``/``artifacts``/``activityKind``
  /``activityDetail``/``toolNames``); ``toolCalls`` changes must NOT
  cause a fresh ``thread_state`` re-emission because tools have their own
  dedicated events.
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock


_BACKEND_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_BACKEND_ROOT))
sys.path.insert(0, str(_BACKEND_ROOT / "packages" / "harness"))


def _ensure_subagent_mock() -> None:
    """The same mock conftest.py injects; needed when running this file alone."""
    if "evoflow.subagents.executor" not in sys.modules:
        executor_mock = MagicMock()
        executor_mock.SubagentExecutor = MagicMock
        executor_mock.SubagentResult = MagicMock
        executor_mock.SubagentStatus = MagicMock
        executor_mock.MAX_CONCURRENT_SUBAGENTS = 5
        executor_mock.get_background_task_result = MagicMock()
        sys.modules["evoflow.subagents.executor"] = executor_mock


def _make_state():
    _ensure_subagent_mock()
    from app.gateway.sse_ui_normalize import UiStreamNormalizer

    return UiStreamNormalizer(thread_id="thread-test", anchored=True)


def _decode_evf_frame(frame: str | bytes) -> dict:
    """Parse a wire ``evf`` frame (``event: evf\\ndata: {...}\\n\\n``)."""
    if isinstance(frame, bytes):
        frame = frame.decode("utf-8")
    body = None
    for line in frame.splitlines():
        if line.startswith("data: "):
            body = json.loads(line[len("data: "):])
            break
    if body is None:
        raise AssertionError(f"frame is not a valid evf envelope: {frame!r}")
    return body


class AttachFirstPollTests(unittest.TestCase):
    """The minimal anchor ``thread_state`` frame is gone."""

    def test_attach_first_poll_emits_no_thread_state_anchor(self) -> None:
        from app.gateway.streaming.attach_evf_stream import AttachEvfDiffEmitter

        emitter = AttachEvfDiffEmitter()
        state_data = {
            "values": {
                "messages": [
                    {"type": "human", "content": "hi"},
                    {"type": "ai", "content": "hello back"},
                ]
            }
        }
        frames = emitter.frames_for_state(state_data)
        # Before the fix: a `{"type":"thread_state","anchored":true}` frame
        # was appended here. Now the first poll emits no anchor frame —
        # the live normalizer is responsible for the real thread_state.
        self.assertEqual(frames, [])
        self.assertTrue(emitter.baseline_locked)
        self.assertEqual(emitter.last_emitted_text, "hello back")

        # Subsequent polls must still emit a delta frame.
        state_data["values"]["messages"][1]["content"] = "hello back world"
        delta_frames = emitter.frames_for_state(state_data)
        self.assertEqual(len(delta_frames), 1)
        body = _decode_evf_frame(delta_frames[0])
        self.assertEqual(body.get("type"), "delta")


class LiveThreadStateDedupTests(unittest.TestCase):
    """``thread_state`` re-emission is gated on renderable fields only."""

    def test_live_thread_state_dedup_ignores_tool_calls_changes(self) -> None:
        _ensure_subagent_mock()
        from app.gateway.sse_ui_normalize import UiStreamNormalizer

        state = UiStreamNormalizer(thread_id="thread-test", anchored=True)
        # First poll: pushes one ``thread_state`` (cold cache).
        state1 = {
            "values": {
                "messages": [
                    {"type": "human", "content": "q"},
                    {
                        "type": "ai",
                        "id": "ai-1",
                        "content": "thinking",
                        "tool_calls": [
                            {
                                "id": "call-1",
                                "name": "read",
                                "args": {"path": "a.md"},
                            }
                        ],
                    },
                ],
                "todos": [{"id": "t1", "content": "do x"}],
            }
        }
        out1 = state._on_values(state1)
        thread_state_emits_1 = [
            p for p in out1 if isinstance(p, dict) and p.get("type") == "thread_state"
        ]
        self.assertEqual(
            len(thread_state_emits_1),
            1,
            "cold-cache poll must emit one thread_state",
        )

        # Second poll: tool_calls expanded but the *latest* tool call, the
        # activity detail / kind, todos/title/artifacts are all unchanged →
        # MUST NOT re-emit a fresh thread_state (the whole point of
        # dedup-sig). We only add an earlier tool call to confirm the
        # "extra tool call in the bag" case is also deduped.
        state2 = {
            "values": {
                "messages": [
                    {"type": "human", "content": "q"},
                    {
                        "type": "ai",
                        "id": "ai-1",
                        "content": "thinking more",
                        "tool_calls": [
                            {
                                "id": "call-0",
                                "name": "read",
                                "args": {"path": "a.md", "limit": 5},
                            },
                            {
                                "id": "call-1",
                                "name": "read",
                                "args": {"path": "a.md"},
                            },
                        ],
                    },
                ],
                "todos": [{"id": "t1", "content": "do x"}],
            }
        }
        out2 = state._on_values(state2)
        thread_state_emits_2 = [
            p for p in out2 if isinstance(p, dict) and p.get("type") == "thread_state"
        ]
        self.assertEqual(
            len(thread_state_emits_2),
            0,
            "tool_calls-only changes must not re-emit thread_state",
        )


class WriteToolPartialPathTests(unittest.TestCase):
    def test_content_streams_before_path_emits_growing_path_prefix(self) -> None:
        _ensure_subagent_mock()
        from app.gateway.sse_ui_normalize import _extract_write_fields_from_partial_args

        # Unclosed path — growing prefix is emitted so the UI can anchor the
        # target file immediately (a JSON string only grows while streaming,
        # so the prefix is always a prefix of the final value).
        self.assertEqual(
            _extract_write_fields_from_partial_args('{"content":"body","path":"outputs/')['path'],
            "outputs/",
        )
        self.assertEqual(
            _extract_write_fields_from_partial_args(
                '{"content":"body","path":"outputs/final.py"}'
            )["path"],
            "outputs/final.py",
        )

    def test_path_arrival_flushes_pending_body_exactly_once(self) -> None:
        _ensure_subagent_mock()
        from app.gateway.sse_ui_normalize import UiStreamNormalizer

        state = UiStreamNormalizer(thread_id="thread-test", anchored=True)
        # Path key not started yet: body is pending (no anchored path), counters only.
        _, pre_path = state._sanitize_write_tool_call(
            {
                "id": "call-0",
                "name": "write",
                "function": {
                    "name": "write",
                    "arguments": '{"content":"body"'
                },
            }
        )
        self.assertEqual(pre_path["path"], "")
        self.assertNotIn("content_delta", pre_path)

        # A growing path prefix anchors the stream as soon as the key appears:
        # pending body flushes against the prefix (prefix only ever grows).
        _, first_progress = state._sanitize_write_tool_call(
            {
                "id": "call-1",
                "name": "write",
                "function": {
                    "name": "write",
                    "arguments": '{"content":"body","path":"outputs/'
                },
            }
        )
        self.assertEqual(first_progress["path"], "outputs/")
        self.assertEqual(first_progress["content_delta"], "body")

        # Closed path; the sent-cursor prevents a content replay.
        _, path_progress = state._sanitize_write_tool_call(
            {
                "id": "call-1",
                "name": "write",
                "function": {
                    "name": "write",
                    "arguments": '{"content":"body","path":"outputs/final.py"}'
                },
            }
        )
        self.assertEqual(path_progress["path"], "outputs/final.py")
        self.assertNotIn("content_delta", path_progress)


class AguiToolStartPathTests(unittest.TestCase):
    def test_tool_call_start_includes_path_when_available(self) -> None:
        from app.gateway.agui_stream_normalizer import (
            AgUiEncoderState,
            _ensure_tool_started,
            _tool_path_from_tc,
        )

        state = AgUiEncoderState(thread_id="t1", run_id="r1")
        out: list[dict[str, Any]] = []
        tc = {
            "id": "call-1",
            "name": "write",
            "function": {"name": "write", "arguments": '{"path":"outputs/foo.py","content":"body"}'},
        }
        tid = _ensure_tool_started(state, tc, out)
        self.assertEqual(tid, "call-1")
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["type"], "TOOL_CALL_START")
        self.assertEqual(out[0]["toolCallId"], "call-1")
        self.assertEqual(out[0]["toolCallName"], "write")
        self.assertEqual(out[0]["path"], "outputs/foo.py")

    def test_tool_call_start_omits_path_for_non_write_tools(self) -> None:
        from app.gateway.agui_stream_normalizer import AgUiEncoderState, _ensure_tool_started

        state = AgUiEncoderState(thread_id="t1", run_id="r1")
        out: list[dict[str, Any]] = []
        # read tool should NOT include path in TOOL_CALL_START.
        tc = {
            "id": "call-2",
            "name": "read",
            "function": {"name": "read", "arguments": '{"path":"a.txt"}'},
        }
        _ensure_tool_started(state, tc, out)
        self.assertEqual(len(out), 1)
        self.assertNotIn("path", out[0])

    def test_tool_path_from_tc_handles_partial_json(self) -> None:
        from app.gateway.agui_stream_normalizer import _tool_path_from_tc

        # Closed path — found.
        self.assertEqual(
            _tool_path_from_tc(
                {"function": {"arguments": '{"content":"body","path":"outputs/test.py"}'}}
            ),
            "outputs/test.py",
        )
        # Unclosed path — growing prefix (partial JSON, prefix-safe for display).
        self.assertEqual(
            _tool_path_from_tc(
                {"function": {"arguments": '{"path":"outputs/test'}}
            ),
            "outputs/test",
        )
        # Dict args.
        self.assertEqual(
            _tool_path_from_tc({"args": {"path": "a/b.txt"}}),
            "a/b.txt",
        )


class AguiCuaDisplayWireTests(unittest.TestCase):
    def test_tool_call_result_forwards_cua_display(self) -> None:
        from app.gateway.agui_stream_normalizer import AgUiEncoderState, evf_payload_to_agui_events

        state = AgUiEncoderState(thread_id="t1", run_id="r1")
        state.tool_started.add("call-cua")
        state.tool_names["call-cua"] = "mcp__node_repl__js"
        cua = {
            "status": "success",
            "images": [{"url": "/api/threads/t1/browser-snapshots/abc123def456", "kb": 12}],
            "target_app": {"app_key": "windows-exe:d:\\app\\weixin.exe", "display_name": "微信"},
        }
        events = evf_payload_to_agui_events(
            {
                "type": "tool_result",
                "tool_call_id": "call-cua",
                "content": "[Screenshot captured]",
                "status": "ok",
                "tool": {
                    "tool_call_id": "call-cua",
                    "name": "mcp__node_repl__js",
                    "content": "[Screenshot captured]",
                    "cua_display": cua,
                },
            },
            state=state,
        )
        result = next(e for e in events if e.get("type") == "TOOL_CALL_RESULT")
        self.assertEqual(result["cua_display"], cua)
        self.assertEqual(state.tool_cua_displays["call-cua"], cua)


class AguiEarlyRunFinishedTests(unittest.TestCase):
    def test_lifecycle_ended_seals_before_checkpoint_run_end(self) -> None:
        from app.gateway.agui_stream_normalizer import AgUiEncoderState, evf_payload_to_agui_events

        state = AgUiEncoderState(thread_id="t1", run_id="r1")
        state.text_started.add("b1")
        early = evf_payload_to_agui_events(
            {
                "type": "custom",
                "chunk": {
                    "type": "session_run_lifecycle",
                    "phase": "ended",
                    "thread_id": "t1",
                },
            },
            state=state,
        )
        types = [e["type"] for e in early]
        self.assertIn("TEXT_MESSAGE_END", types)
        self.assertIn("RUN_FINISHED", types)
        self.assertTrue(state.run_finished)

        late = evf_payload_to_agui_events(
            {"type": "run_end", "display_segments": [{"kind": "text"}]},
            state=state,
        )
        late_types = [e["type"] for e in late]
        self.assertNotIn("RUN_FINISHED", late_types)
        self.assertEqual(late_types.count("CUSTOM"), 1)
        self.assertEqual(late[0]["name"], "display_segments")

    def test_other_thread_lifecycle_does_not_seal(self) -> None:
        from app.gateway.agui_stream_normalizer import AgUiEncoderState, evf_payload_to_agui_events

        state = AgUiEncoderState(thread_id="parent", run_id="r1")
        state.text_started.add("b1")
        events = evf_payload_to_agui_events(
            {
                "type": "custom",
                "chunk": {
                    "type": "session_run_lifecycle",
                    "phase": "ended",
                    "thread_id": "child",
                },
            },
            state=state,
        )
        self.assertNotIn("RUN_FINISHED", [e["type"] for e in events])
        self.assertFalse(state.run_finished)
        self.assertNotIn("b1", state.text_ended)


if __name__ == "__main__":
    unittest.main()