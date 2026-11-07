"""资源包导出：extensions 两形态 + knowledge 源目录 + 员工 ${KB_REF} 改写。"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from evoflow.admin.errors import ValidationError
from evoflow.organizations import export as org_export


@pytest.fixture()
def isolated_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("EVOFLOW_UI_EXTENSIONS_DIR", str(home / ".evoflow-dev"))
    return home


def _seed_registry(home: Path) -> tuple[Path, Path]:
    from evoflow.admin.ui_extensions_registry import (
        read_manifest_from_dir,
        register_directory,
    )

    copy_src = home / "src-copy-ext"
    copy_src.mkdir()
    (copy_src / "evoflow.extension.json").write_text(
        json.dumps(
            {
                "schema": 1,
                "id": "copy-ext",
                "name": "复制扩展",
                "version": "1.0.0",
                "ui": {"kind": "webview", "entry": "http://127.0.0.1:7001"},
                "service": {"mode": "none"},
            }
        ),
        encoding="utf-8",
    )
    (copy_src / "index.html").write_text("<html></html>", encoding="utf-8")
    register_directory(copy_src, source="folder")

    link_src = home / "src-link-ext"
    link_src.mkdir()
    (link_src / "evoflow.extension.json").write_text(
        json.dumps(
            {
                "schema": 1,
                "id": "link-ext",
                "name": "链接扩展",
                "version": "1.0.0",
                "ui": {"kind": "webview", "entry": "http://127.0.0.1:7002"},
                "service": {"mode": "none", "link": True},
            }
        ),
        encoding="utf-8",
    )
    row = register_directory(link_src, source="folder-link")
    assert row["source"] == "folder-link"
    read_manifest_from_dir(link_src)  # 冒烟：目录可解析
    return copy_src, link_src


def _seed_kb_source(tmp_path: Path) -> Path:
    src = tmp_path / "kb-src"
    (src / "sub").mkdir(parents=True)
    (src / "doc1.md").write_text("doc one", encoding="utf-8")
    (src / "sub" / "doc2.md").write_text("doc two", encoding="utf-8")
    return src


def test_export_extensions_and_knowledge(
    isolated_env: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    copy_src, link_src = _seed_registry(isolated_env)
    kb_src = _seed_kb_source(tmp_path)

    fake_bases = [
        {
            "id": "kb_reports_1",
            "name": "reports-kb",
            "description": "报告库",
            "syncSourceType": "folder",
            "syncSourcePath": str(kb_src),
        },
        {"id": "kb_other_9", "name": "other-kb", "syncSourceType": "", "syncSourcePath": ""},
    ]
    monkeypatch.setattr(
        "evoflow.knowledge.owned.service.list_bases", lambda *a, **k: fake_bases
    )
    monkeypatch.setattr(
        org_export,
        "_employee_to_json",
        lambda code: {
            "agent_code": code,
            "role_name": code,
            "config": {
                "workspace_path": "${ORG_WORKSPACE}",
                "knowledge_vault_ids": ["kb_reports_1", "kb_other_9"],
                "skills": [],
            },
        },
    )
    monkeypatch.setattr(
        org_export,
        "_agent_to_yaml",
        lambda code: (
            {
                "agent_code": code,
                "agent_name": code,
                "skills": [],
                "system_prompt_file": f"./{code}.SOUL.md",
            },
            "soul",
        ),
    )

    result = org_export.export_organization(
        pack={"id": "demo-pack", "name": "演示包", "version": "1.0.0"},
        include={
            "employee_codes": ["worker"],
            "extension_ids": ["copy-ext", "link-ext"],
            "knowledge_base_names": ["reports-kb"],
        },
        output={"dir": str(tmp_path / "out")},
    )

    out_dir = Path(result["output_dir"])
    manifest = json.loads((out_dir / "evoflow.organization.json").read_text(encoding="utf-8"))
    prim = manifest["primitives"]

    # knowledge：源目录拷进包，条目指向包内相对路径
    assert prim["knowledge"] == [
        {"ref": "reports-kb", "name": "reports-kb", "description": "报告库", "import_folder": "./knowledge/reports-kb"}
    ]
    assert (out_dir / "knowledge" / "reports-kb" / "doc1.md").is_file()
    assert (out_dir / "knowledge" / "reports-kb" / "sub" / "doc2.md").is_file()

    # extensions：copy 形态整目录、link 形态仅路径
    assert {"from": "./extensions/copy-ext"} in prim["extensions"]
    assert {"path": str(link_src), "link": True} in prim["extensions"]
    assert (out_dir / "extensions" / "copy-ext" / "index.html").is_file()
    assert (out_dir / "extensions" / "link-ext" / "evoflow.extension.json").is_file()
    assert result["extensions"] == ["copy-ext", "link-ext"]

    # 员工 JSON：包内 kb 改写为 ${KB_REF:ref}，包外保留原文并告警
    emp = json.loads((out_dir / "employees" / "worker.json").read_text(encoding="utf-8"))
    assert emp["config"]["knowledge_vault_ids"] == ["${KB_REF:reports-kb}", "kb_other_9"]
    assert any("kb_other_9" in w and "未包含" in w for w in result["warnings"])


def test_export_extension_missing_from_registry(isolated_env: Path, tmp_path: Path) -> None:
    monkeypatch = pytest.MonkeyPatch()
    try:
        monkeypatch.setattr(
            org_export,
            "_employee_to_json",
            lambda code: {"agent_code": code, "config": {"knowledge_vault_ids": []}},
        )
        monkeypatch.setattr(
            org_export,
            "_agent_to_yaml",
            lambda code: ({"agent_code": code, "skills": []}, "soul"),
        )
        result = org_export.export_organization(
            pack={"id": "demo-pack2", "name": "演示包2"},
            include={"employee_codes": ["worker"], "extension_ids": ["ghost-ext"]},
            output={"dir": str(tmp_path / "out2")},
        )
        assert result["extensions"] == []
        assert any("extension not in registry: ghost-ext" in w for w in result["warnings"])
        manifest = json.loads(
            (Path(result["output_dir"]) / "evoflow.organization.json").read_text(encoding="utf-8")
        )
        assert "extensions" not in manifest["primitives"]
    finally:
        monkeypatch.undo()


def test_employee_export_autonomy_uses_enum_value(isolated_env: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """导出的 autonomy_level 必须是值形式（approval_for_all），不能是枚举 repr。"""
    from types import SimpleNamespace

    from evoflow.proactive import repositories as proactive_repositories
    from evoflow.proactive.models import ProactiveAutonomyLevel

    role = SimpleNamespace(
        config=SimpleNamespace(
            autonomy_level=ProactiveAutonomyLevel.APPROVAL_FOR_ALL,
            reports_to="",
            knowledge_vault_ids=[],
            skills=[],
            responsibilities=[],
            max_turns=10,
            timeout_seconds=0,
            daily_budget_usd=0.0,
        ),
        role_name="员工",
        position_code="",
        department="",
        heartbeat_rrule="",
    )
    monkeypatch.setattr(
        proactive_repositories.ProactiveRepository,
        "get_role",
        staticmethod(lambda code: role),
    )
    out = org_export._employee_to_json("worker")
    assert out["config"]["autonomy_level"] == "approval_for_all"


def test_parse_autonomy_accepts_enum_repr(isolated_env: Path) -> None:
    """导入侧兼容历史导出包里的枚举 repr（ProactiveAutonomyLevel.APPROVAL_FOR_ALL）。"""
    from evoflow.admin.employees import _parse_autonomy
    from evoflow.proactive.models import ProactiveAutonomyLevel

    assert _parse_autonomy("approval_for_all") is ProactiveAutonomyLevel.APPROVAL_FOR_ALL
    assert _parse_autonomy("full_auto") is ProactiveAutonomyLevel.FULL_AUTO
    assert (
        _parse_autonomy("ProactiveAutonomyLevel.APPROVAL_FOR_ALL")
        is ProactiveAutonomyLevel.APPROVAL_FOR_ALL
    )
    with pytest.raises(ValidationError):
        _parse_autonomy("nonsense_level")
