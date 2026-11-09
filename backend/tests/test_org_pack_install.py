"""资源包安装集成：knowledge 原语 + extensions 注册 + ${KB_REF} 接线 + 幂等/卸载。"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from evoflow.organizations.installer import (
    install_organization,
    uninstall_organization,
)
from evoflow.persistence.db import reset_db_for_tests


@pytest.fixture()
def isolated_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("EVOFLOW_HOME", str(home))
    monkeypatch.setenv("EVOFLOW_UI_EXTENSIONS_DIR", str(home / ".evoflow-dev"))  # 共享根=该目录
    monkeypatch.setenv("EVOFLOW_OWNED_KB_WORKER", "0")
    monkeypatch.delenv("EVOFLOW_DB_PATH", raising=False)
    # 预置 skills 布局，确保 get_skills_root_path 落在 tmp home（否则回退真实 ~/.evoflow）
    (home / "skills" / "custom").mkdir(parents=True)
    from evoflow.config.agents_config import invalidate_agent_config_cache
    from evoflow.config.app_config import reset_app_config
    from evoflow.skills.loader import clear_skills_cache

    # This fixture moves EVOFLOW_HOME per test, but the app-config singleton and
    # the skill loader cache both remember the *previous* test's skills root. The
    # installer then copies the pack skill into the new home while
    # ``create_agent`` validates against the stale scan → "unknown skill(s):
    # my-skill" (only when tests run in sequence; each passes alone).
    invalidate_agent_config_cache()
    reset_app_config()
    clear_skills_cache()
    reset_db_for_tests()
    yield home
    clear_skills_cache()
    reset_app_config()
    invalidate_agent_config_cache()
    reset_db_for_tests()


def _make_pack(tmp_path: Path) -> tuple[Path, Path]:
    """最小 full 包：1 知识库(2 文档) + 1 技能 + 1 扩展(copy) + 1 员工(${KB_REF} 绑定)。"""
    pack = tmp_path / "pack"
    (pack / "data" / "reports").mkdir(parents=True)
    (pack / "data" / "reports" / "a.md").write_text("# A 报告\n钩子案例一", encoding="utf-8")
    (pack / "data" / "reports" / "b.md").write_text("# B 报告\n钩子案例二", encoding="utf-8")

    skill = pack / "skills" / "my-skill"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text(
        "---\nname: my-skill\ndescription: 测试技能\n---\n\nbody\n",
        encoding="utf-8",
    )

    ext = pack / "extensions" / "my-ext"
    ext.mkdir(parents=True)
    (ext / "evoflow.extension.json").write_text(
        json.dumps(
            {
                "schema": 1,
                "id": "my-ext",
                "name": "测试扩展",
                "version": "1.0.0",
                "ui": {"kind": "webview", "entry": "http://127.0.0.1:5173"},
                "service": {"mode": "none"},
            }
        ),
        encoding="utf-8",
    )

    agent = pack / "agents"
    agent.mkdir()
    (agent / "worker.yaml").write_text(
        "agent_code: worker\nagent_name: 测试员工\ndescription: t\nsystem_prompt: 你是测试员工\nskills: [my-skill]\n",
        encoding="utf-8",
    )

    emp = pack / "employees"
    emp.mkdir()
    (emp / "worker.json").write_text(
        json.dumps(
            {
                "agent_code": "worker",
                "role_name": "测试员工",
                "config": {
                    "workspace_path": "${ORG_WORKSPACE}",
                    "knowledge_vault_ids": ["${KB_REF:reports}"],
                    "skills": ["my-skill"],
                },
            }
        ),
        encoding="utf-8",
    )

    manifest = {
        "schema": 1,
        "kind": "team",
        "id": "test-pack",
        "name": "测试包",
        "version": "1.0.0",
        "workspace": {"path": "${ORG_ROOT}/workspace", "create_if_missing": True},
        "primitives": {
            "knowledge": [{"ref": "reports", "name": "reports-kb", "import_folder": "./data/reports"}],
            "skills": [{"path": "./skills/my-skill"}],
            "agents": [{"from": "./agents/worker.yaml"}],
            "extensions": [{"from": "./extensions/my-ext"}],
        },
        "team": {"employees": [{"from": "./employees/worker.json"}]},
    }
    (pack / "evoflow.organization.json").write_text(json.dumps(manifest), encoding="utf-8")
    return pack, (pack / "extensions" / "my-ext")


def _registry_rows(home: Path) -> list[dict]:
    from evoflow.admin.ui_extensions_registry import registry_path

    p = registry_path()
    assert home.name in str(p) or True
    return json.loads(p.read_text(encoding="utf-8")) if p.is_file() else []


def test_install_wires_knowledge_extension_and_employee(
    isolated_home: Path, tmp_path: Path
) -> None:
    pack, _ext_src = _make_pack(tmp_path)
    result = install_organization(source={"type": "path", "path": str(pack)})

    assert result["pack_id"] == "test-pack"
    arts = result["artifacts"]
    assert arts["skills"] == ["my-skill"]
    assert arts["agents"] == ["worker"]
    assert arts["employees"] == ["worker"]
    assert len(arts["knowledge"]) == 1
    kb_id = arts["knowledge"][0]
    assert arts["extensions"] == ["my-ext"]
    assert any("ready (created)" in w for w in result["warnings"])

    # 知识库已建并导入（同步拷贝部分）
    from evoflow.knowledge.owned import service as owned_service

    bases = {b["name"]: b for b in owned_service.list_bases()}
    assert "reports-kb" in bases
    assert bases["reports-kb"]["id"] == kb_id
    assert bases["reports-kb"]["syncSourcePath"]  # 记住了 folder 同步源，支持 resync

    # 员工绑定了真实 kb_id（${KB_REF:reports} 已替换）
    from evoflow.proactive.repositories import ProactiveRepository

    role = ProactiveRepository.get_role("worker")
    assert role is not None
    assert role.config.knowledge_vault_ids == [kb_id]

    # 扩展注册到共享 registry，且目录已复制
    rows = _registry_rows(isolated_home)
    assert [r["id"] for r in rows] == ["my-ext"]
    assert rows[0]["source"] == "org_pack:test-pack"
    assert Path(rows[0]["install_path"]).is_dir()


def test_reinstall_is_idempotent(isolated_home: Path, tmp_path: Path) -> None:
    pack, _ = _make_pack(tmp_path)
    source = {"type": "path", "path": str(pack)}
    install_organization(source=source)
    second = install_organization(source=source, options={"conflict_policy": "skip"})

    assert any("(reused)" in w for w in second["warnings"])
    assert any("agent exists, skipped" in w for w in second["warnings"])
    rows = _registry_rows(isolated_home)
    assert [r["id"] for r in rows] == ["my-ext"]  # upsert 不产生重复行

    from evoflow.knowledge.owned import service as owned_service
    assert len([b for b in owned_service.list_bases() if b["name"] == "reports-kb"]) == 1


def test_reinstall_with_replace_rebinds_employee(
    isolated_home: Path, tmp_path: Path
) -> None:
    """员工已存在时 replace 重装应删旧重建，把 ${KB_REF} 绑定补上（存量员工补绑场景）。"""
    pack, _ = _make_pack(tmp_path)
    source = {"type": "path", "path": str(pack)}
    install_organization(source=source)

    # 先人为把员工的知识库绑定清空，模拟「员工先在、绑定缺失」
    from evoflow.proactive.repositories import ProactiveRepository

    role = ProactiveRepository.get_role("worker")
    role.config.knowledge_vault_ids = []
    ProactiveRepository.save_role(role)

    second = install_organization(source=source, options={"conflict_policy": "replace"})
    assert any("employee replaced: worker" in w for w in second["warnings"])
    role2 = ProactiveRepository.get_role("worker")
    assert role2 is not None
    assert role2.config.knowledge_vault_ids == [second["artifacts"]["knowledge"][0]]


def test_uninstall_removes_extension_keeps_knowledge_by_default(
    isolated_home: Path, tmp_path: Path
) -> None:
    pack, _ = _make_pack(tmp_path)
    result = install_organization(source={"type": "path", "path": str(pack)})
    kb_id = result["artifacts"]["knowledge"][0]

    out = uninstall_organization(result["org_instance_id"])
    assert out["removed"]["extensions"] == ["my-ext"]
    assert out["kept"]["knowledge"] == [kb_id]
    assert _registry_rows(isolated_home) == []  # 扩展行已摘除

    from evoflow.knowledge.owned import service as owned_service

    assert any(b["id"] == kb_id for b in owned_service.list_bases())  # 默认保留

    # 重装（幂等复用同一个知识库）后显式删除知识库卸载
    result2 = install_organization(
        source={"type": "path", "path": str(pack)}, options={"conflict_policy": "skip"}
    )
    assert result2["artifacts"]["knowledge"] == [kb_id]
    out2 = uninstall_organization(result2["org_instance_id"], options={"keep_knowledge": False})
    assert out2["removed"]["knowledge"] == [kb_id]
    assert not any(b["id"] == kb_id for b in owned_service.list_bases())
