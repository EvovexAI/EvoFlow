"""Meeting conclude helpers (no live LLM)."""

from __future__ import annotations

from evoflow.a2a.meeting_conclude import (
    _normalize_conclusion,
    _parse_conclude_json,
    deposit_meeting_conclusion_document,
    format_conclusion_document,
)


def test_parse_conclude_json_fenced() -> None:
    raw = '```json\n{"summary":"选方案A","plan":"先做MVP","steps":["调研","试点"],"risks":["工期"],"owners":[{"role":"产品","action":"出PRD"}]}\n```'
    parsed = _parse_conclude_json(raw)
    assert parsed["summary"] == "选方案A"
    out = _normalize_conclusion(parsed, topic="是否上新首页")
    assert out["topic"] == "是否上新首页"
    assert out["steps"][0] == "调研"
    doc = format_conclusion_document(out, meeting_id="mt_abc")
    assert "最优方案" in doc
    assert "MVP" in doc
    assert "会议室方案" in doc
    assert "Plan" not in doc


def test_parse_conclude_json_fallback_prose() -> None:
    parsed = _parse_conclude_json("不是 json，只是一段话")
    assert "一段话" in parsed["plan"] or "综合" in parsed["summary"]


def test_deposit_meeting_conclusion_document(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path))
    conclusion = {
        "topic": "周报自动起草",
        "summary": "一周 MVP 上线",
        "plan": "定时任务 + 模板",
        "steps": ["取数", "渲染"],
        "risks": ["口径"],
        "owners": [{"role": "产品", "action": "定口径"}],
    }
    res = deposit_meeting_conclusion_document(
        "mt_test123",
        conclusion,
        turns=[{"agent_code": "pm", "text": "先收范围"}],
    )
    assert res.get("ok") is True
    path = res.get("path") or ""
    assert path.startswith("memory/episodic/")
    assert "meeting" in path
    from pathlib import Path

    from evoflow.assets.paths import EntityRef, resolve_entity_file

    f = resolve_entity_file(EntityRef("user", "user"), path)
    assert isinstance(f, Path)
    text = f.read_text(encoding="utf-8")
    assert "一周 MVP" in text
    assert "kind: meeting-plan" in text
    assert "先收范围" in text
