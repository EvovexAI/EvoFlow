"""SpeechSession client_listening 门控真值表测试（M1 协议不变量）。

门控真值表见 docs/design/voice-state-machine-convergence.md §2.3：
  listening → 放麦；thinking → 仅 exit_listen；speaking → 仅 exit_listen
  （speaking+exit_listen = 软暂停探测放麦，2026-11-03 死锁的回归断言——
   没有这条，语音打断播报会再次静默失效）。
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from app.gateway.speech.session_manager import SpeechSession


class FakeWebSocket:
    """Enough of the WS interface for the session op loop."""

    def __init__(self, incoming: list[dict[str, Any]]) -> None:
        self._incoming = list(incoming)
        self.sent: list[dict[str, Any]] = []

    async def accept(self) -> None:
        return None

    async def send_json(self, data: dict[str, Any]) -> None:
        self.sent.append(data)

    async def receive(self) -> dict[str, Any]:
        if self._incoming:
            msg = self._incoming.pop(0)
            return {"type": "websocket.receive", "text": json.dumps(msg)}
        return {"type": "websocket.disconnect"}


class FakeBridge:
    """Records release_stt_unmute_hold calls; carries a settable phase."""

    def __init__(self, phase: str) -> None:
        self.client_phase = phase
        self.releases: list[str] = []

    async def release_stt_unmute_hold(self, *, reason: str = "client_listening") -> None:
        self.releases.append(reason)


def _drive(incoming: list[dict[str, Any]], phase: str) -> tuple[FakeBridge, list[dict[str, Any]]]:
    ws = FakeWebSocket(incoming)
    session = SpeechSession(ws)  # type: ignore[arg-type]
    bridge = FakeBridge(phase)
    session._bridge = bridge  # type: ignore[attr-defined]
    import asyncio

    asyncio.run(session.run())
    return bridge, ws.sent


@pytest.mark.parametrize(
    "phase,extra,expect_release",
    [
        # listening：正常放麦
        ("listening", {}, True),
        # thinking：默认不放（防回声/误开），exit_listen 放
        ("thinking", {}, False),
        ("thinking", {"force": True, "purpose": "exit_listen"}, True),
        # speaking：普通 client_listening 一律不放；exit_listen（软暂停探测）必须放
        ("speaking", {}, False),
        ("speaking", {"force": True, "purpose": "exit_listen"}, True),
    ],
)
def test_client_listening_gating_truth_table(phase: str, extra: dict, expect_release: bool) -> None:
    """§2.3 真值表；speaking+exit_listen 是语音打断死锁的永久回归断言。"""
    bridge, _sent = _drive([{"type": "client_listening", **extra}], phase)
    assert bool(bridge.releases) is expect_release, (
        f"phase={phase} extra={extra} releases={bridge.releases}"
    )


def test_client_listening_release_reason() -> None:
    """exit_listen 与普通放麦的 reason 可区分（后端日志/台账依赖它）。"""
    bridge, _ = _drive(
        [
            {"type": "client_listening", "force": True, "purpose": "exit_listen"},
            {"type": "client_listening"},
        ],
        "listening",
    )
    assert bridge.releases[0] == "exit_listen"
    assert bridge.releases[1] == "client_listening"


def test_ready_sent_before_ops() -> None:
    """会话建立必须先发 ready（前端等它再发 start）。"""
    _bridge, sent = _drive([], "listening")
    assert any(m.get("type") == "ready" for m in sent)
