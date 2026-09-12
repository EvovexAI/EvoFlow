"""Unit tests for mock_vendor_chat_server (no Gateway required)."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest

SCRIPTS = Path(__file__).resolve().parents[3] / "scripts"
MOCK_SCRIPT = SCRIPTS / "mock_vendor_chat_server.py"


@pytest.fixture(scope="module")
def mock_server():
    port = 18770
    env = os.environ.copy()
    env["EVOFLOW_MOCK_VENDOR_PATTERN"] = "text"
    env["EVOFLOW_MOCK_VENDOR_CHUNKS"] = "6"
    env["EVOFLOW_MOCK_VENDOR_CHUNK_DELAY_MS"] = "0"
    proc = subprocess.Popen(
        [sys.executable, str(MOCK_SCRIPT), "--port", str(port), "--pattern", "text", "--chunks", "6", "--chunk-delay-ms", "0"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        env=env,
    )
    base = f"http://127.0.0.1:{port}/v1"
    deadline = time.time() + 10
    ready = False
    while time.time() < deadline:
        try:
            r = httpx.get(f"http://127.0.0.1:{port}/health", timeout=1.0)
            if r.status_code == 200:
                ready = True
                break
        except Exception:
            pass
        time.sleep(0.1)
    if not ready:
        proc.terminate()
        pytest.skip("mock vendor server failed to start")
    yield base
    proc.terminate()
    try:
        proc.wait(timeout=3)
    except subprocess.TimeoutExpired:
        proc.kill()


def _parse_sse(raw: str) -> list[dict]:
    out: list[dict] = []
    for block in raw.replace("\r\n", "\n").split("\n\n"):
        block = block.strip()
        if not block.startswith("data:"):
            continue
        payload = block[5:].strip()
        if payload == "[DONE]":
            continue
        out.append(json.loads(payload))
    return out


def test_mock_stream_text(mock_server: str) -> None:
    with httpx.Client() as client:
        with client.stream(
            "POST",
            f"{mock_server}/chat/completions",
            json={"model": "stress-mock", "stream": True, "messages": [{"role": "user", "content": "hi"}]},
            timeout=10.0,
        ) as resp:
            assert resp.status_code == 200
            body = resp.read().decode("utf-8")
    chunks = _parse_sse(body)
    assert len(chunks) >= 3
    texts = []
    for c in chunks:
        delta = c["choices"][0].get("delta") or {}
        if delta.get("content"):
            texts.append(delta["content"])
    joined = "".join(texts)
    assert "stress-mock-vendor" in joined or "模拟厂商" in joined or len(joined) > 10


def test_mock_stream_tool_pattern() -> None:
    port = 18771
    proc = subprocess.Popen(
        [sys.executable, str(MOCK_SCRIPT), "--port", str(port), "--pattern", "tool", "--chunk-delay-ms", "0"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    try:
        deadline = time.time() + 10
        while time.time() < deadline:
            try:
                if httpx.get(f"http://127.0.0.1:{port}/health", timeout=1.0).status_code == 200:
                    break
            except Exception:
                pass
            time.sleep(0.1)
        else:
            pytest.skip("tool mock server failed to start")

        with httpx.Client() as client:
            with client.stream(
                "POST",
                f"http://127.0.0.1:{port}/v1/chat/completions",
                json={"model": "stress-mock", "stream": True, "messages": [{"role": "user", "content": "tool"}]},
                timeout=10.0,
            ) as resp:
                assert resp.status_code == 200
                assert resp.headers.get("X-Mock-Pattern") == "tool"
                body = resp.read().decode("utf-8")
        chunks = _parse_sse(body)
        tool_names: list[str] = []
        for c in chunks:
            delta = c["choices"][0].get("delta") or {}
            for tc in delta.get("tool_calls") or []:
                fn = tc.get("function") or {}
                if fn.get("name"):
                    tool_names.append(fn["name"])
        assert "write_todos" in tool_names
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()
