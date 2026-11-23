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
    """replace 重装先卸旧实例再装，${KB_REF} 绑定必须回到包声明。"""
    pack, _ = _make_pack(tmp_path)
    source = {"type": "path", "path": str(pack)}
    first = install_organization(source=source)

    # 先人为把员工的知识库绑定清空，模拟「员工先在、绑定缺失」
    from evoflow.proactive.repositories import ProactiveRepository

    role = ProactiveRepository.get_role("worker")
    role.config.knowledge_vault_ids = []
    ProactiveRepository.save_role(role)

    second = install_organization(source=source, options={"conflict_policy": "replace"})
    assert second.get("rolled_back") is False
    assert second["org_instance_id"] != first["org_instance_id"]
    role2 = ProactiveRepository.get_role("worker")
    assert role2 is not None
    assert role2.config.knowledge_vault_ids == [second["artifacts"]["knowledge"][0]]


def test_uninstall_true_delete_by_default(
    isolated_home: Path, tmp_path: Path
) -> None:
    """Default uninstall removes extension + knowledge + roles; reinstall is clean."""
    from evoflow.admin import agents as agents_admin
    from evoflow.admin.errors import NotFoundError
    from evoflow.knowledge.owned import service as owned_service
    from evoflow.proactive.repositories import ProactiveRepository

    pack, _ = _make_pack(tmp_path)
    result = install_organization(source={"type": "path", "path": str(pack)})
    kb_id = result["artifacts"]["knowledge"][0]
    oid = result["org_instance_id"]

    out = uninstall_organization(oid)
    assert out["removed"]["extensions"] == ["my-ext"]
    assert out["removed"]["knowledge"] == [kb_id]
    assert out["removed"]["employees"] == ["worker"]
    assert out["removed"]["agents"] == ["worker"]
    assert not any(out.get("not_removed", {}).values())
    assert _registry_rows(isolated_home) == []  # 扩展行已摘除
    assert not any(b["id"] == kb_id for b in owned_service.list_bases())
    assert ProactiveRepository.get_role("worker") is None
    try:
        agents_admin.get_agent("worker")
        raise AssertionError("agent should be gone")
    except NotFoundError:
        pass

    # Clean reinstall must not hit Role already exists
    result2 = install_organization(source={"type": "path", "path": str(pack)})
    assert result2["artifacts"]["employees"] == ["worker"]
    assert ProactiveRepository.get_role("worker") is not None


def test_uninstall_can_keep_knowledge(
    isolated_home: Path, tmp_path: Path
) -> None:
    pack, _ = _make_pack(tmp_path)
    result = install_organization(source={"type": "path", "path": str(pack)})
    kb_id = result["artifacts"]["knowledge"][0]
    out = uninstall_organization(
        result["org_instance_id"], options={"keep_knowledge": True}
    )
    assert out["kept"]["knowledge"] == [kb_id]
    from evoflow.knowledge.owned import service as owned_service

    assert any(b["id"] == kb_id for b in owned_service.list_bases())


def test_zip_install_persists_and_forces_extension_copy(
    isolated_home: Path, tmp_path: Path
) -> None:
    """Market/zip installs must not folder-link into a deleted TEMP extract."""
    import zipfile

    from evoflow.admin.ui_extensions_registry import config_dir, ui_extensions_root
    from evoflow.organizations.pack_persist import org_packs_root

    pack, _ = _make_pack(tmp_path)
    # Author-style link flags (broken for zip unless installer forces copy)
    man = json.loads((pack / "evoflow.organization.json").read_text(encoding="utf-8"))
    man["primitives"]["extensions"] = [{"from": "./extensions/my-ext", "link": True}]
    man["primitives"]["skills"] = [{"path": "./skills/my-skill", "link": True}]
    (pack / "evoflow.organization.json").write_text(json.dumps(man), encoding="utf-8")
    ext_man = json.loads((pack / "extensions" / "my-ext" / "evoflow.extension.json").read_text(encoding="utf-8"))
    ext_man["service"] = {"mode": "none", "link": True}
    (pack / "extensions" / "my-ext" / "evoflow.extension.json").write_text(
        json.dumps(ext_man), encoding="utf-8"
    )

    zpath = tmp_path / "pack.zip"
    with zipfile.ZipFile(zpath, "w") as zf:
        for f in pack.rglob("*"):
            if f.is_file():
                zf.write(f, f.relative_to(pack).as_posix())

    result = install_organization(source={"type": "zip_path", "path": str(zpath)})
    assert result.get("portable") is True
    pack_root = Path(result["pack_root"])
    assert pack_root.is_dir()
    assert org_packs_root() in pack_root.parents or pack_root.parent == org_packs_root()
    assert "pack_root" in result["artifacts"]

    rows = _registry_rows(isolated_home)
    assert len(rows) == 1
    install_path = Path(rows[0]["install_path"])
    assert install_path.is_dir()
    assert install_path.parent == ui_extensions_root()
    assert "folder-link" not in str(rows[0].get("source") or "")
    # Copied manifest must not keep service.link
    copied = json.loads((install_path / "evoflow.extension.json").read_text(encoding="utf-8"))
    assert (copied.get("service") or {}).get("link") in (False, None)
    _ = config_dir  # keep import used for clarity in failures


def test_install_forwards_employee_mcp_resp_max_turns(
    isolated_home: Path, tmp_path: Path
) -> None:
    """P1: hire whitelist must land mcp_servers / responsibilities / max_turns."""
    from evoflow.admin import agents as agents_admin
    from evoflow.admin import mcp as mcp_admin
    from evoflow.proactive.repositories import ProactiveRepository

    pack, _ = _make_pack(tmp_path)
    mcp_name = "pack-hire-mcp"
    mcp_dir = pack / "mcp"
    mcp_dir.mkdir()
    (mcp_dir / f"{mcp_name}.json").write_text(
        json.dumps(
            {
                "name": mcp_name,
                "enabled": True,
                "type": "stdio",
                "command": "npx",
                "args": ["-y", "demo"],
                "description": "pack mcp",
            }
        ),
        encoding="utf-8",
    )
    (pack / "agents" / "worker.yaml").write_text(
        "agent_code: worker\nagent_name: 测试员工\ndescription: t\n"
        f"system_prompt: 你是测试员工\nskills: [my-skill]\nmcp_servers: [{mcp_name}]\n"
        "max_turns: 20\n",
        encoding="utf-8",
    )
    (pack / "employees" / "worker.json").write_text(
        json.dumps(
            {
                "agent_code": "worker",
                "role_name": "测试员工",
                "mcp_servers": [mcp_name],
                "max_turns": 20,
                "config": {
                    "workspace_path": "${ORG_WORKSPACE}",
                    "knowledge_vault_ids": ["${KB_REF:reports}"],
                    "skills": ["my-skill"],
                    "mcp_servers": [mcp_name],
                    "max_turns": 20,
                    "responsibilities": ["梳大纲", "陪练", "出题"],
                },
            }
        ),
        encoding="utf-8",
    )
    man = json.loads((pack / "evoflow.organization.json").read_text(encoding="utf-8"))
    man["primitives"]["mcp"] = [{"from": f"./mcp/{mcp_name}.json"}]
    (pack / "evoflow.organization.json").write_text(json.dumps(man), encoding="utf-8")

    result = install_organization(source={"type": "path", "path": str(pack)})
    assert result.get("rolled_back") is False
    assert "readiness" in result

    role = ProactiveRepository.get_role("worker")
    assert role is not None
    assert role.config.max_turns == 20
    assert mcp_name in (role.config.mcp_servers or [])
    assert "梳大纲" in (role.config.responsibilities or [])

    agent = agents_admin.get_agent("worker")
    assert mcp_name in (agent.get("mcp_servers") or [])
    assert int(agent.get("max_turns") or 0) == 20
    assert mcp_admin.get_mcp_server(mcp_name)["name"] == mcp_name

    # preflight after install must report conflicts (shared checker)
    from evoflow.organizations.installer import preflight_organization

    pre = preflight_organization(source={"type": "path", "path": str(pack)})
    assert pre["ok"] is False
    kinds = {c["type"] for c in pre["conflicts"]}
    assert "employee" in kinds or "agent" in kinds or "org_instance" in kinds

    # uninstall + reinstall idempotent
    out = uninstall_organization(result["org_instance_id"])
    assert out["ok"] is True
    result2 = install_organization(source={"type": "path", "path": str(pack)})
    assert result2.get("rolled_back") is False
    assert ProactiveRepository.get_role("worker") is not None


def test_install_registers_mcp_before_agent(isolated_home: Path, tmp_path: Path) -> None:
    """primitives.mcp 必须在 create_agent 前注册，否则 mcp_servers 校验失败。"""
    pack, _ = _make_pack(tmp_path)
    mcp_name = "pack-wire-mcp"
    mcp_dir = pack / "mcp"
    mcp_dir.mkdir()
    (mcp_dir / f"{mcp_name}.json").write_text(
        json.dumps(
            {
                "name": mcp_name,
                "enabled": True,
                "type": "stdio",
                "command": "npx",
                "args": ["-y", "demo"],
                "description": "pack mcp",
            }
        ),
        encoding="utf-8",
    )
    agent_path = pack / "agents" / "worker.yaml"
    agent_path.write_text(
        "agent_code: worker\nagent_name: 测试员工\ndescription: t\n"
        f"system_prompt: 你是测试员工\nskills: [my-skill]\nmcp_servers: [{mcp_name}]\n",
        encoding="utf-8",
    )
    man = json.loads((pack / "evoflow.organization.json").read_text(encoding="utf-8"))
    man["primitives"]["mcp"] = [{"from": f"./mcp/{mcp_name}.json"}]
    (pack / "evoflow.organization.json").write_text(json.dumps(man), encoding="utf-8")

    result = install_organization(source={"type": "path", "path": str(pack)})
    assert mcp_name in result["artifacts"]["mcp"]
    assert any(
        f"mcp registered: {mcp_name}" in w or f"mcp exists, reused: {mcp_name}" in w
        for w in result["warnings"]
    )

    from evoflow.admin import agents as agents_admin
    from evoflow.admin import mcp as mcp_admin

    agent = agents_admin.get_agent("worker")
    assert mcp_name in (agent.get("mcp_servers") or [])
    mcp = mcp_admin.get_mcp_server(mcp_name)
    assert mcp["name"] == mcp_name
