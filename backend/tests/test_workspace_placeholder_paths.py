"""未展开的场景包占位符 ``${ORG_WORKSPACE}`` 不得让右栏打开文件失败。

【self-evolution-bot · 2026-11-23 · 第130轮 · 模型:qwen3.8-flash】
现网证据：gateway-2026-11-23.log 09:11 批量
``GET /api/workspaces/resolve-target?path=${ORG_WORKSPACE}/outputs/x.docx&root=${ORG_WORKSPACE}`` → 400，
前端报 ``read failed: HTTP 400``（V4ZCodeTimeline.tsx:509）。
两处真缺陷：
1. root 带占位符直喂 ``resolve_index_root`` → ValueError(400)，path 侧剥了也没用；
2. heal 只拿 basename 扫整根，``max_scan=4000`` 预算被吃掉（本机命中排第 5850 位），
   引 ``outputs/x.html`` 而实际在 ``outputs/_view/x.html`` 就永远打不开。
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import HTTPException

from app.gateway.routers.workspaces import (
    _fuzzy_locate_under_workspace,
    _heal_missing_workspace_file_target,
    _normalize_rel_path,
    _normalize_root_hint,
    _resolve_workspace_file_target,
    _resolve_workspace_root,
)
from evoflow.proactive.employee_prompting.session import _clean_workspace_hint

PH = "${ORG_WORKSPACE}"


# ---------------------------------------------------------------- root / path 归一


def test_normalize_rel_path_drops_placeholder_segments() -> None:
    assert _normalize_rel_path(f"{PH}/outputs/a.docx") == "outputs/a.docx"
    assert _normalize_rel_path(PH + "/deep/" + "${other}" + "/outputs/a.docx") == "deep/outputs/a.docx"
    assert _normalize_rel_path("outputs/a.docx") == "outputs/a.docx"


def test_normalize_root_hint_placeholder_means_unbound() -> None:
    # 全占位符 → 视为没绑根，交给 thread/host 回退（这是 400 的直接成因）
    assert _normalize_root_hint(PH) is None
    assert _normalize_root_hint("") is None
    assert _normalize_root_hint(None) is None
    # 真路径保持不变
    assert _normalize_root_hint("D:/real/root") == "D:/real/root"


def test_resolve_workspace_root_placeholder_root_falls_back(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """旧代码这里抛 HTTPException(400)；现在必须能解析出目录。"""
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path))
    got = _resolve_workspace_root(PH, None)
    assert Path(got).is_dir(), got
    assert "${" not in got


def test_resolve_file_target_placeholder_root_and_path(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """端到端：占位符 root + 占位符 path，落到 host 根下真实文件。

    占位符根视作"未绑根" → 回落 ``evoflow_home_project_root()``（读 EVOFLOW_HOME），
    所以这里必须把它指到 tmp_path，否则测到的是真实 profiles 目录。
    """
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path))
    out = tmp_path / "outputs"
    out.mkdir()
    f = out / "台本.docx"
    f.write_bytes(b"x")
    got = _resolve_workspace_file_target(root=PH, thread_id=None, rel=f"{PH}/outputs/台本.docx")
    assert got.is_file(), got


# ---------------------------------------------------------------- heal 扫描序


def _make_noise(root: Path, count: int) -> None:
    """在根目录直接铺文件：topdown 先处理根文件名再下钻，预算耗尽顺序是确定的。"""
    for i in range(count):
        (root / f"n{i:05d}.txt").write_bytes(b"")


def test_fuzzy_locate_narrow_subtree_beats_scan_budget(tmp_path: Path) -> None:
    """引 ``outputs/x.html``，实际在 ``outputs/_view/x.html``，预算不足以整根扫时必须命中。"""
    (tmp_path / "outputs" / "_view").mkdir(parents=True)
    target = tmp_path / "outputs" / "_view" / "taiben-compare.html"
    target.write_bytes(b"<html></html>")
    _make_noise(tmp_path, 5000)

    hit = _fuzzy_locate_under_workspace(
        tmp_path, "outputs/taiben-compare.html", max_scan=4000
    )
    assert hit is not None and hit.is_file(), hit
    assert hit.name == "taiben-compare.html"


def test_basename_only_locate_is_budget_limited(tmp_path: Path) -> None:
    """反证：无可窄扫的首段子树时，同一预算下确实扫不到。

    这条是上一条的对照——证明"窄扫首段子树"才是命中关键，不是预算被调大了。
    """
    (tmp_path / "outputs" / "_view").mkdir(parents=True)
    target = tmp_path / "outputs" / "_view" / "taiben-compare.html"
    target.write_bytes(b"<html></html>")
    _make_noise(tmp_path, 5000)

    # 首段 "missing" 不存在 → 只能整根遍历；根目录 5000 个文件先吃掉 4000 预算
    assert _fuzzy_locate_under_workspace(tmp_path, "missing/taiben-compare.html", max_scan=4000) is None


def test_heal_missing_file_hits_view_subdir(tmp_path: Path) -> None:
    """全链：heal 必须靠"引用路径靠前"的候选键命中 ``_view`` 子目录。"""
    (tmp_path / "outputs" / "_view").mkdir(parents=True)
    (tmp_path / "outputs" / "_view" / "report.html").write_bytes(b"<html></html>")
    _make_noise(tmp_path, 5000)

    missed = tmp_path / "outputs" / "report.html"  # 引错一层
    healed = _heal_missing_workspace_file_target(
        missed, root=str(tmp_path), thread_id=None, cited="outputs/report.html"
    )
    assert healed.is_file(), healed
    assert healed.parent.name == "_view"


# ---------------------------------------------------------------- 写入侧


def test_clean_workspace_hint_never_prints_placeholder(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """提示词「用户工作目录」不得出现字面 ``${…}``（否则模型照着写进回复）。"""
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path))
    assert "${" not in _clean_workspace_hint("", PH)
    assert "${" not in _clean_workspace_hint(PH)
    assert _clean_workspace_hint("D:/real/ws", PH) == "D:/real/ws"
    # 全剥空时回落到 host 根，而不是空串
    assert _clean_workspace_hint("", PH) != ""
