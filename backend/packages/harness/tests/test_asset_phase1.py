"""Tests for Asset Hub Phase1 extract (runtime-aligned)."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from evoflow.assets.paths import EntityRef
from evoflow.assets.phase1 import (
    _parse_phase1_json,
    asset_phase1_enabled,
    format_messages_as_rollout,
    run_phase1_extract,
)
from evoflow.config.paths import reset_paths_cache


@pytest.fixture
def assets_home(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        reset_paths_cache()
        yield Path(tmp)
        reset_paths_cache()


def test_asset_phase1_enabled_default(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("EVOFLOW_ASSET_PHASE1", raising=False)
    assert asset_phase1_enabled() is True
    monkeypatch.setenv("EVOFLOW_ASSET_PHASE1", "0")
    assert asset_phase1_enabled() is False


def test_format_messages_as_rollout():
    msgs = [
        SimpleNamespace(type="human", content="请修 CI 缓存键"),
        SimpleNamespace(type="ai", content="已改成按分支哈希缓存，验证通过。"),
        {"role": "user", "content": "记住：先 rebase 再 push"},
    ]
    text = format_messages_as_rollout(msgs)
    assert "[user]" in text
    assert "CI 缓存" in text
    assert "rebase" in text


def test_parse_phase1_json_fenced():
    raw = (
        '```json\n'
        '{"rollout_summary":"# 修好缓存\\n细节","rollout_slug":"ci-cache","raw_memory":"- use rebase"}\n'
        "```"
    )
    parsed = _parse_phase1_json(raw)
    assert parsed["rollout_slug"] == "ci-cache"
    assert "rebase" in parsed["raw_memory"]


def test_run_phase1_skips_when_disabled(assets_home: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("EVOFLOW_ASSET_PHASE1", "off")
    out = run_phase1_extract(
        messages=[{"role": "user", "content": "x" * 100}],
        thread_id="t1",
        entity=EntityRef("user", "user"),
    )
    assert out["skipped"] == "disabled"


def test_run_phase1_writes_inbox_and_episode(assets_home: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("EVOFLOW_ASSET_PHASE1", "1")

    class _Cfg:
        enabled = True
        model_name = None

    monkeypatch.setattr(
        "evoflow.config.memory_config.get_memory_config",
        lambda: _Cfg(),
    )

    payload = {
        "rollout_summary": "# CI 缓存修复\n\n按分支哈希缓存。",
        "rollout_slug": "ci-cache-fix",
        "raw_memory": "## Learning\n\n- rebase before push on shared branches\n",
    }
    mock_model = MagicMock()
    mock_model.invoke.return_value = SimpleNamespace(content=json.dumps(payload))
    monkeypatch.setattr(
        "evoflow.models.create_chat_model",
        lambda **kwargs: mock_model,
    )

    msgs = [
        {"role": "user", "content": "CI 失败了，缓存键冲突，请修好并记住以后用 rebase。"},
        {
            "role": "assistant",
            "content": "已把缓存键改成按分支哈希；以后共享分支先 rebase 再 push。",
        },
    ]
    ent = EntityRef("user", "user")
    out = run_phase1_extract(
        messages=msgs,
        thread_id="thread-abc/1",
        workspace_path="/tmp/proj",
        entity=ent,
    )
    assert out.get("ok") is True, out
    assert not out.get("skipped"), out
    paths = out.get("paths") or []
    assert any("_inbox/raw_" in p for p in paths)
    assert any("episodic/" in p for p in paths)

    inbox = assets_home / "assets" / "user" / "memory" / "_inbox" / "raw_thread-abc-1.md"
    assert inbox.is_file()
    body = inbox.read_text(encoding="utf-8")
    assert "rebase" in body
    assert "source: phase1" in body

    episodic_dir = assets_home / "assets" / "user" / "memory" / "episodic"
    assert any(episodic_dir.glob("*.md"))


def test_run_phase1_no_signal(assets_home: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("EVOFLOW_ASSET_PHASE1", "1")

    class _Cfg:
        enabled = True
        model_name = None

    monkeypatch.setattr(
        "evoflow.config.memory_config.get_memory_config",
        lambda: _Cfg(),
    )
    mock_model = MagicMock()
    mock_model.invoke.return_value = SimpleNamespace(
        content='{"rollout_summary":"","rollout_slug":"","raw_memory":""}'
    )
    monkeypatch.setattr(
        "evoflow.models.create_chat_model",
        lambda **kwargs: mock_model,
    )

    msgs = [
        {
            "role": "user",
            "content": "你好啊，今天天气怎么样？我只是随便聊聊，没有具体任务，也没有要你记住什么偏好。",
        },
        {
            "role": "assistant",
            "content": "你好！我是助手。今天可以聊聊日常，有具体问题随时说；这次没有可沉淀的工程经验。",
        },
    ]
    out = run_phase1_extract(
        messages=msgs,
        thread_id="greet",
        entity=EntityRef("user", "user"),
    )
    assert out.get("ok") is True
    assert out.get("skipped") == "no_signal"
