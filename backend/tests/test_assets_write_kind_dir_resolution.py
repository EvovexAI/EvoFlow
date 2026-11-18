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


# ─────────────────────────────────────────────────────────────────────────────
# 【self-evolution-bot · 2026-11-18 · 第54轮 · 模型:deepseek-v4.1-flash-1017】
# 现网 obs：self-evolution-bot 近7天 write_path_not_allowed 14 次，回执原文**完全一样**
# （只列白名单目录 + 3 个示例），于是我每次只能靠猜自己错在哪，同一类坑踩了 14 次。
#
# 逐条取 input_json 复核后，真实原因分布（此前的三分类有一处判错，这里已更正）：
#   ① 裸名 + 盘上无同名文件 + 未给 kind ......... 7 条  ← 占最多，修法=补 kind
#   ② 少 .md 后缀，但同名 .md 就在盘上 ......... 1 条  ← 修法=解析器补后缀重试
#   ③ 传绝对路径 / 含 '..' .................... 1 条
#   ④ 真越界（outputs/、memory/_inbox/）....... 5 条  ← 拒得对
# 更正点：'系统优化清单-按可证伪性排序' 原来被归成「①少后缀」，实际它盘上存在的是
# `memory/episodic/系统优化清单-按可证伪性排序.md`，真因是**裸名没给 kind**（类①）。
# 按旧分类去补后缀，补了仍然没有目录信息，照样被拒 —— 分类错会把人引向无效动作。
#
# 注意：allow 判定集合一个字都没动 —— 只改"说不说清为什么"。

# 现网原件（2026-11-16 ~ 2026-11-18 self-evolution-bot 的真实 path 值）
REAL_REJECTED_PATHS = {
    # 类①：裸名、无 kind、且测试环境里确实没有同名文件
    "bare_no_kind": "第19轮-我写了个20+-实测是13-数量词必须来自当轮命令stdout",
    "absolute_or_dotdot": "D:/dev/github/EvoFlow/../检索效果AB的池规模口径.md",
    "outside_whitelist": "outputs/_perf_probe_w.md",
    "inbox_not_writable": "memory/_inbox/probe_lat_r3.md",
}


def _reject(runtime, path: str):
    out = _write(runtime, path=path, content="正文")
    assert out.get("ok") is False, out
    assert out.get("error") == "write_path_not_allowed", out
    return out


def test_bare_name_without_kind_names_kind_not_whitelist(asset_home: Path) -> None:
    """类①：裸名 + 无 kind → hint 必须点名 kind 这一条修法，而不是让调用方核对白名单。"""
    out = _reject(_runtime(), REAL_REJECTED_PATHS["bare_no_kind"])
    hint = str(out.get("hint") or "")
    assert "kind" in hint, out
    assert "找不到同名已有文件" in hint, hint
    # 不许把「少给参数」说成「写到白名单外」
    assert "不在可写目录内" not in hint, hint


def test_absolute_path_is_named_as_absolute(asset_home: Path) -> None:
    """② 绝对路径/..：必须说清"资产只收 entity 相对路径"。"""
    out = _reject(_runtime(), REAL_REJECTED_PATHS["absolute_or_dotdot"])
    hint = str(out.get("hint") or "")
    assert "绝对路径" in hint or ".." in hint, out
    assert "相对路径" in hint, out


def test_outside_whitelist_points_at_examples(asset_home: Path) -> None:
    """③ 真越界：原样拒，且示例仍然给到位（这条行为不许被上面的细化改坏）。"""
    out = _reject(_runtime(), REAL_REJECTED_PATHS["outside_whitelist"])
    assert out.get("examples"), out
    assert "可写" in str(out.get("hint") or ""), out


def test_probe_style_inbox_path_still_rejected(asset_home: Path) -> None:
    """反证：收件箱不因 hint 变详细就被放行。"""
    out = _reject(_runtime(), REAL_REJECTED_PATHS["inbox_not_writable"])
    assert out.get("received_path") == REAL_REJECTED_PATHS["inbox_not_writable"], out


def test_hint_reasons_are_mutually_exclusive(asset_home: Path) -> None:
    """各类原因不许串味：各自只命中自己的那条提示。"""
    bare = str(_reject(_runtime(), REAL_REJECTED_PATHS["bare_no_kind"]).get("hint") or "")
    absp = str(_reject(_runtime(), REAL_REJECTED_PATHS["absolute_or_dotdot"]).get("hint") or "")
    outside = str(_reject(_runtime(), REAL_REJECTED_PATHS["outside_whitelist"]).get("hint") or "")
    # 裸名无 kind 那档不能提到后缀/绝对路径
    assert "绝对路径" not in bare and "缺少 .md" not in bare, bare
    # 绝对路径那档不能提到 kind 修法
    assert "找不到同名已有文件" not in absp, absp
    # 真越界那档不许把两种修法混进来
    assert "找不到同名已有文件" not in outside and "绝对路径" not in outside, outside
