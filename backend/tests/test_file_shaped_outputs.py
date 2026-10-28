"""Non-file tokens (chat:/session refs) must not register as type=file."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from evoflow.collab.id_format import _ts_compact, _ts_short
from evoflow.collab.subtask_outcome import apply_subtask_outcome_report
from evoflow.collab.task_outputs import (
    evidence_paths_from_outputs,
    is_file_shaped_output_value,
    normalize_task_output,
    normalize_task_outputs,
    outputs_from_evidence_paths,
)
from evoflow.timeutil import BEIJING_TZ


def test_is_file_shaped_rejects_chat_and_entity_ids() -> None:
    assert not is_file_shaped_output_value("chat:Subtask_20261028052402_047312")
    assert not is_file_shaped_output_value("session:proactive:xiaomi:chat:1")
    assert not is_file_shaped_output_value("Subtask_20261028052402_047312")
    assert not is_file_shaped_output_value("Task_20261028052402_000001")
    assert is_file_shaped_output_value("docs/roles/xiaomi/notes.md")
    assert is_file_shaped_output_value("outputs/report.md")
    assert is_file_shaped_output_value("https://example.com/a.pdf")
    assert is_file_shaped_output_value(r"D:\dev\github\EvoFlow\backend\outputs\a.md")


def test_normalize_demotes_chat_ref_from_file_to_text() -> None:
    item = normalize_task_output(
        {"type": "file", "key": "trail", "value": "chat:Subtask_20261028052402_047312"}
    )
    assert item is not None
    assert item["type"] == "text"
    assert item["value"].startswith("chat:")


def test_outputs_from_evidence_paths_skips_chat_refs() -> None:
    items = outputs_from_evidence_paths(
        [
            "chat:Subtask_20261028052402_047312",
            "docs/a.md",
        ]
    )
    assert len(items) == 1
    assert items[0]["type"] == "file"
    assert items[0]["value"] == "docs/a.md"


def test_evidence_paths_from_outputs_ignores_demoted_chat() -> None:
    paths = evidence_paths_from_outputs(
        [
            {"type": "file", "key": "a", "value": "chat:Subtask_x"},
            {"type": "file", "key": "b", "value": "outputs/ok.md"},
            {"type": "text", "key": "c", "value": "hello"},
        ]
    )
    assert paths == ["outputs/ok.md"]


def test_normalize_string_chat_ref_dropped() -> None:
    assert normalize_task_outputs("chat:Subtask_20261028052402_047312") == []


def test_id_timestamps_use_beijing(monkeypatch) -> None:
    fixed = datetime(2026, 10, 28, 13, 24, 2, tzinfo=BEIJING_TZ)

    class _Dt:
        @staticmethod
        def now(tz=None):
            assert tz is BEIJING_TZ
            return fixed

    monkeypatch.setattr("evoflow.collab.id_format.datetime", _Dt)
    assert _ts_compact() == "20261028132402"
    assert _ts_short() == "2610281324"


@pytest.mark.asyncio
async def test_outcome_report_drops_chat_ref_and_missing_file(tmp_path: Path, monkeypatch) -> None:
    real = tmp_path / "ok.md"
    real.write_text("hi\n", encoding="utf-8")
    missing = tmp_path / "ghost.md"

    st = {
        "id": "Subtask_1",
        "status": "running",
        "progress": 50,
        "assigned_to": "xiaomi",
        "workspace_path": str(tmp_path),
    }
    store = MagicMock()
    monkeypatch.setattr(
        "evoflow.collab.subtask_outcome.find_subtask_by_ids",
        lambda _s, _m, _sid: st,
    )
    monkeypatch.setattr(
        "evoflow.collab.subtask_outcome.workspace_root_for_task_row",
        lambda _row: str(tmp_path),
    )
    monkeypatch.setattr(
        "evoflow.collab.subtask_outcome.agent_code_for_task_row",
        lambda _row: "xiaomi",
    )
    monkeypatch.setattr(
        "evoflow.collab.subtask_outcome.persist_subtask_runtime_snapshot",
        lambda *_a, **_k: True,
    )
    monkeypatch.setattr(
        "evoflow.collab.subtask_outcome.rollup_root_task_progress_from_subtasks",
        lambda *_a, **_k: None,
    )
    monkeypatch.setattr(
        "evoflow.collab.subtask_outcome.get_task_detail_storage",
        lambda: MagicMock(),
    )
    monkeypatch.setattr(
        "evoflow.collab.storage.patch_collab_subtask_in_project_storage",
        lambda *_a, **_k: True,
    )
    monkeypatch.setattr(
        "evoflow.collab.structured_output.process_step_output",
        lambda *_a, **_k: {
            "structured_output": None,
            "schema_valid": True,
            "schema_errors": [],
        },
    )
    monkeypatch.setattr(
        "evoflow.collab.schema_enforcement.resolve_schema_policy",
        lambda **_k: "warn",
    )
    monkeypatch.setattr(
        "evoflow.collab.schema_enforcement.enforce_schema_on_outcome",
        lambda **_k: {
            "outcome": "completed",
            "enforcement_action": "none",
            "enforcement_reason": "",
            "error": "",
        },
    )
    monkeypatch.setattr(
        "evoflow.collab.conversation_persist.append_subtask_outcome_record",
        lambda *_a, **_k: None,
    )
    monkeypatch.setattr(
        "evoflow.collab.sse_notify.broadcast_collab_task_event",
        AsyncMock(),
    )
    monkeypatch.setattr(
        "evoflow.tools.builtins.collab_bridge.schedule_followup_wave_needed",
        lambda *_a, **_k: None,
    )

    result = await apply_subtask_outcome_report(
        main_task_id="2610281324_abcd",
        subtask_id="Subtask_1",
        outcome="completed",
        summary="取要点完成",
        evidence_paths=[
            "chat:Subtask_20261028052402_047312",
            str(missing),
            str(real),
        ],
        storage=store,
    )
    assert result.get("ok") is True
    outs = result.get("outputs") or []
    file_outs = [o for o in outs if o.get("type") == "file"]
    assert len(file_outs) == 1
    assert Path(file_outs[0]["value"]) == real
    summary = str(result.get("message") or "")
    # Summary is not returned; chat must not survive as file output.
    assert not any("chat:Subtask_" in str(o.get("value") or "") and o.get("type") == "file" for o in outs)
    assert not any("ghost.md" in str(o.get("value") or "") for o in outs)
    _ = summary
