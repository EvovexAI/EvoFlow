"""evoflow doctor — 输出契约与环境检查（卡死排查）。"""

from __future__ import annotations

import argparse
from pathlib import Path

import pytest

from evoflow.cli.commands import doctor


@pytest.fixture()
def fake_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setattr(Path, "home", staticmethod(lambda: home))
    monkeypatch.delenv("EVOFLOW_SKILLS_PATH", raising=False)
    monkeypatch.delenv("EVOFLOW_HOME", raising=False)
    return home


def _args() -> argparse.Namespace:
    return argparse.Namespace(compact=True)


def test_run_shape_and_gateway_hint(
    fake_home: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """DB 检查与 gateway runtime 打桩，验证整体结构与替代通道提示。

    【self-evolution-bot · 2026-11-20 · 第92轮 · 模型:deepseek-v4.1-flash-1017】
    原用例只打桩 ``_check_database`` / ``_find_gateway_runtime``，另外两项仍在
    读真实机器状态：
    - ``_check_media_credentials`` 读本机 profile 数据库；
    - ``_count_stale_python_processes`` 数全机 python 进程，本机常驻 30+ 个
      别仓库服务（实测 34 个 > 阈值 15）→ ``ok`` 恒为 False，用例必红。
    这两项与本用例要验的「结构 + 替代通道提示」无关，一并打桩保持用例自洽。

    另：``_run`` 现在在 skills 之前插入了 ``media_credentials`` 检查，
    而旧断言 ``names[:3] == ["env", "database", "skills"]`` 是插入前的快照，
    一并按「顺序包含」重写（仍能抓「检查项被误删/换序」）。
    """
    monkeypatch.setattr(
        doctor,
        "_check_database",
        lambda: {"name": "database", "ok": True, "detail": {}},
    )
    monkeypatch.setattr(doctor, "_find_gateway_runtime", lambda: {"path": None})
    monkeypatch.setattr(
        doctor,
        "_check_media_credentials",
        lambda: {"name": "media_credentials", "ok": True, "detail": {}},
    )
    monkeypatch.setattr(doctor, "_count_stale_python_processes", lambda: None)
    monkeypatch.setattr(
        doctor,
        "_check_skills",
        lambda: {"name": "skills", "ok": True, "detail": {}},
    )

    out = doctor._run(_args())

    assert out["command"] == "doctor"
    assert out["ok"] is True
    names = [c["name"] for c in out["checks"]]
    assert names[:2] == ["env", "database"]
    assert names.index("skills") > names.index("database")
    assert any("gateway" in h for h in out["hints"])
    assert any("backend-runtime.json" in h for h in out["hints"])


def test_skills_mismatch_surfaces_hint(fake_home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    default_root = fake_home / ".evoflow" / "skills"
    skill_dir = default_root / "custom" / "alpha"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text("---\nname: alpha\ndescription: t\n---\n", encoding="utf-8")

    profile_root = fake_home / ".evoflow" / "profiles" / "default" / "skills"
    beta = profile_root / "custom" / "beta"
    beta.mkdir(parents=True)
    (beta / "SKILL.md").write_text("---\nname: beta\ndescription: t\n---\n", encoding="utf-8")

    monkeypatch.setattr(
        doctor,
        "_check_database",
        lambda: {"name": "database", "ok": True, "detail": {}},
    )
    monkeypatch.setattr(doctor, "_find_gateway_runtime", lambda: {"path": None})

    out = doctor._run(_args())

    assert out["ok"] is False
    skills_check = next(c for c in out["checks"] if c["name"] == "skills")
    assert skills_check["ok"] is False
    assert skills_check["hint"]
    assert any(str(profile_root) in h for h in out["hints"])


def test_find_gateway_runtime_reads_profile_file(fake_home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    profile = fake_home / ".evoflow" / "profiles" / "default"
    profile.mkdir(parents=True)
    (profile / "backend-runtime.json").write_text(
        '{"port": 8123, "baseUrl": "http://127.0.0.1:8123", "status": "ready"}',
        encoding="utf-8",
    )

    runtime = doctor._find_gateway_runtime()

    assert runtime["baseUrl"] == "http://127.0.0.1:8123"
    assert runtime["port"] == 8123
