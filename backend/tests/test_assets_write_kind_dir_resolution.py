"""``assets action="write"`` 传裸文件名 + kind 时，必须与 note 同口径按 kind 补目录。

【为什么有这份测试】现网观测库实测（2026-11-16 09:01，xiaomi）：
    {"action": "write", "kind": "episodic",
     "path": "补充-2026-11-16-09-00-值班-ef73合并落库催办.md", "content": ...}
被拒 ``write_path_not_allowed``。同一个工具里 note 分支早就「落点由 kind 决定」，
write 分支却只认带前缀的完整相对路径 —— 一套工具两套口径，调用方还得再猜一次前缀。

判据（第20轮）：用例必须复用当轮现网受害者的**原始入参**，不许自造样例。
"""

from __future__ import annotations

import importlib
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from evoflow.config.paths import reset_paths_cache

assets_mod = importlib.import_module("evoflow.tools.builtins.assets_tool")


@pytest.fixture()
def asset_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path))
    reset_paths_cache()
    monkeypatch.setattr(assets_mod, "_principal_from_runtime", lambda _rt: "yin-tai")
    yield tmp_path
    reset_paths_cache()


def _runtime(*, agent: str = "main"):
    return SimpleNamespace(context={"agent_name": agent, "principal_id": "yin-tai"}, config={})


def _write(runtime, **kwargs):
    return json.loads(
        assets_mod.assets_tool.func(action="write", runtime=runtime, tool_call_id="t1", **kwargs)
    )


# 现网原件：2026-11-16 09:01 xiaomi 的真实入参（content 截短，其余原样）
REAL_CALL = {
    "kind": "episodic",
    "path": "补充-2026-11-16-09-00-值班-ef73合并落库催办.md",
    "content": "# 值班第20轮（2026-11-16 09:00）· ef73 合并落库催办\n\n- 看板 6 项未结全在 release-engineer。",
}


def test_real_incident_bare_filename_with_kind_is_accepted(asset_home: Path) -> None:
    """当轮真实受害者复跑：裸文件名 + kind=episodic 必须写成功并落在 episodic 目录。"""
    out = _write(_runtime(), **REAL_CALL)

    assert out.get("ok") is True, out
    assert out.get("resolved_from_kind") is True, out
    assert out.get("resolved_path") == f"memory/episodic/{REAL_CALL['path']}", out
    # 必须真的落盘，不能只改回执
    landed = asset_home / "assets" / "employees" / "main" / "memory" / "episodic" / REAL_CALL["path"]
    alt = asset_home / "assets" / "users" / "yin-tai" / "memory" / "episodic" / REAL_CALL["path"]
    assert landed.is_file() or alt.is_file(), f"没落盘：{landed} / {alt}"


def test_回执必须明写已按kind补目录(asset_home: Path) -> None:
    """静默改址 = 下次 update_path 还得重新猜；回执必须说清楚。"""
    out = _write(_runtime(), **REAL_CALL)
    assert "补全目录" in str(out.get("hint") or ""), out


def test_full_prefixed_path_is_untouched(asset_home: Path) -> None:
    """反证：已带正确前缀的路径不许被 kind 二次改写。"""
    out = _write(
        _runtime(),
        kind="episodic",
        path="memory/episodic/显式前缀.md",
        content="正文",
    )
    assert out.get("ok") is True, out
    assert not out.get("resolved_from_kind"), out
    assert out.get("path", "").endswith("memory/episodic/显式前缀.md")


def test_kind_mismatch_with_prefixed_path_keeps_path(asset_home: Path) -> None:
    """反证：前缀已明确时，kind 与之冲突也不许擅自改址（避免把 journal 写成 episodic）。"""
    out = _write(
        _runtime(),
        kind="episodic",
        path="memory/journal/明确要写这.md",
        content="正文",
    )
    assert out.get("ok") is True, out
    assert not out.get("resolved_from_kind"), out
    assert out.get("path", "").endswith("memory/journal/明确要写这.md")


def test_still_rejects_disallowed_target_with_actionable_hint(asset_home: Path) -> None:
    """真越界仍要拒，但必须给出可落点示例（原来是白名单一句话，指不到位）。"""
    out = _write(_runtime(), path="docs/不该写这里.md", content="正文")
    assert out.get("ok") is False
    assert out.get("error") == "write_path_not_allowed", out
    assert out.get("received_path") == "docs/不该写这里.md", out
    assert out.get("examples"), out
