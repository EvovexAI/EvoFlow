"""Checkpoint write must survive SQLite lock contention.

Root cause (Task 2610241133_c9f4): two EvoFlow gateways share one
``checkpoints.db``. A checkpoint write that lost the race against the other
gateway's writer raised ``sqlite3.OperationalError: database is locked`` and
killed the whole run — including an 85-minute round whose transcript was
already persisted in ``evoflow_chat_messages``.

These tests pin the contract:

* a lock error is retried with backoff and eventually succeeds;
* a non-lock error is raised immediately (no pointless retries);
* retries are bounded (a permanent lock fails, it does not hang);
* the transcript strip still happens before the write.
"""

from __future__ import annotations

import asyncio
import os
import unittest

from evoflow.agents.checkpointer.omit_transcript import (
    OmitTranscriptCheckpointer,
    _is_sqlite_lock_error,
    omit_transcript_channels,
)


class _FlakyInner:
    """Inner saver that fails with a lock error N times, then succeeds."""

    def __init__(self, *, failures: int, exc: Exception | None = None) -> None:
        self.failures = failures
        self.exc = exc or RuntimeError("database is locked")
        self.calls = 0
        self.last_checkpoint: object | None = None

    async def aput(self, config, checkpoint, metadata, new_versions):
        self.calls += 1
        if self.calls <= self.failures:
            raise self.exc
        self.last_checkpoint = checkpoint
        return config

    async def aput_writes(self, config, writes, task_id, task_path=""):
        self.calls += 1
        if self.calls <= self.failures:
            raise self.exc
        return None


class LockDetectionTest(unittest.TestCase):
    def test_lock_errors_detected(self) -> None:
        self.assertTrue(_is_sqlite_lock_error(RuntimeError("database is locked")))
        self.assertTrue(_is_sqlite_lock_error(RuntimeError("database is busy")))
        self.assertTrue(_is_sqlite_lock_error(RuntimeError("SQLITE_BUSY: database is locked")))

    def test_other_errors_not_detected(self) -> None:
        self.assertFalse(_is_sqlite_lock_error(ValueError("bad config")))
        self.assertFalse(_is_sqlite_lock_error(RuntimeError("no such table")))


class AputLockRetryTest(unittest.TestCase):
    def setUp(self) -> None:
        self._prev_attempts = os.environ.get("EVOFLOW_CHECKPOINT_LOCK_RETRY_ATTEMPTS")
        self._prev_base = os.environ.get("EVOFLOW_CHECKPOINT_LOCK_RETRY_BASE_MS")
        # Keep the test fast: short backoff.
        os.environ["EVOFLOW_CHECKPOINT_LOCK_RETRY_ATTEMPTS"] = "4"
        os.environ["EVOFLOW_CHECKPOINT_LOCK_RETRY_BASE_MS"] = "10"

    def tearDown(self) -> None:
        for key, prev in (
            ("EVOFLOW_CHECKPOINT_LOCK_RETRY_ATTEMPTS", self._prev_attempts),
            ("EVOFLOW_CHECKPOINT_LOCK_RETRY_BASE_MS", self._prev_base),
        ):
            if prev is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = prev

    def test_transient_lock_is_retried_then_succeeds(self) -> None:
        inner = _FlakyInner(failures=2)
        cp = OmitTranscriptCheckpointer(inner)
        out = asyncio.run(cp.aput({"configurable": {"thread_id": "t"}}, {"v": 1}, {}, {}))
        self.assertEqual(inner.calls, 3, "two lock failures then a success")
        self.assertIsNotNone(out)

    def test_non_lock_error_raised_immediately(self) -> None:
        inner = _FlakyInner(failures=5, exc=ValueError("not a lock"))
        cp = OmitTranscriptCheckpointer(inner)
        with self.assertRaises(ValueError):
            asyncio.run(cp.aput({"configurable": {"thread_id": "t"}}, {"v": 1}, {}, {}))
        self.assertEqual(inner.calls, 1, "a non-lock error must not be retried")

    def test_retries_are_bounded(self) -> None:
        inner = _FlakyInner(failures=99)
        cp = OmitTranscriptCheckpointer(inner)
        with self.assertRaises(RuntimeError):
            asyncio.run(cp.aput({"configurable": {"thread_id": "t"}}, {"v": 1}, {}, {}))
        self.assertEqual(inner.calls, 4, "retries must be bounded by the configured attempts")

    def test_aput_writes_is_retried(self) -> None:
        inner = _FlakyInner(failures=1)
        cp = OmitTranscriptCheckpointer(inner)
        asyncio.run(cp.aput_writes({"configurable": {"thread_id": "t"}}, [("c", 1)], "task-1"))
        self.assertEqual(inner.calls, 2)

    def test_transcript_is_stripped_before_write(self) -> None:
        inner = _FlakyInner(failures=0)
        cp = OmitTranscriptCheckpointer(inner)
        checkpoint = {
            "channel_values": {
                "messages": [
                    {"type": "human", "content": "hi"},
                    {"type": "ai", "content": "hello", "tool_calls": []},
                ],
                "ui_messages": [{"type": "ai", "content": "x"}],
            }
        }
        asyncio.run(cp.aput({"configurable": {"thread_id": "t"}}, checkpoint, {}, {}))
        stored = inner.last_checkpoint
        self.assertIsNotNone(stored)
        cv = stored["channel_values"]  # type: ignore[index]
        self.assertEqual(cv["messages"], [])
        self.assertEqual(cv["ui_messages"], [])

    def test_unresolved_tool_calls_keep_transcript(self) -> None:
        """HITL / mid-tool resume must keep messages — they cannot be rebuilt."""
        checkpoint = {
            "channel_values": {
                "messages": [
                    {
                        "type": "ai",
                        "content": "",
                        "tool_calls": [{"id": "call-1", "name": "bash", "args": {}}],
                    }
                ]
            }
        }
        out = omit_transcript_channels(checkpoint)
        self.assertEqual(len(out["channel_values"]["messages"]), 1)


if __name__ == "__main__":
    unittest.main()
