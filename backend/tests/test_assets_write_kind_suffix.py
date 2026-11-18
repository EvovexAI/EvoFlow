"""``assets action="write"`` 按 kind 补完目录后，必须同时补 ``.md`` 后缀。

【为什么有这份测试】第55轮拿真实工具入口做生效验证时，一次就撞上：
    {"action":"write","kind":"reflection",
     "path":"第31轮-接口报0件真因是函数没定义-我却先读了两轮判据"}
→ 被补成 ``memory/journal/第31轮-…判据``（无后缀）→ ``hub.write_text_file`` 的
   ``_TEXT_SUFFIXES`` 拒绝 → ``only text assets can be written via API``。

这条错误既不说后缀也不说 .md。更糟的是第54轮我刚写的 reject hint 里写着
「补 kind 即可自动补目录写成功」——**那是个假承诺**：补了 kind 依然失败，
而现网 obs 里第31轮那行正是一次真实踩中（2026-11-17 09:56，kind=reflection）。
根因：write 分支只补目录不补后缀，与 note 分支（走 ``build_ad_hoc_filename``，
一定会加 .md）不同口径。

判据：用例复用现网受害者的**原始入参**，且必须走真实的 ``assets_tool.func`` 入口
（第33/38轮教训：直接调 helper 会在接线断了时依然全绿）。
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


# 现网原件：2026-11-17 09:56 self-evolution-bot 的真实入参（content 截短）
REAL_INCIDENT = {
    "kind": "reflection",
    "path": "第31轮-接口报0件真因是函数没定义-我却先读了两轮判据",
    "content": "# 第31轮教训\n\n接口报 0 件真因是函数没定义。",
}
REAL_INCIDENT_EXPECTED = f"memory/journal/{REAL_INCIDENT['path']}.md"


def test_real_incident_kind_without_suffix_now_succeeds(asset_home: Path) -> None:
    """当轮真实受害者复跑：kind=reflection + 裸名无 .md，必须写成功且落 .md。"""
    out = _write(_runtime(), **REAL_INCIDENT)

    assert out.get("ok") is True, out
    assert out.get("resolved_path") == REAL_INCIDENT_EXPECTED, out
    assert out.get("suffix_added") == ".md", out
    # 必须真的落盘，不能只改回执
    hit = [
        asset_home / "assets" / "employees" / "main" / REAL_INCIDENT_EXPECTED,
        asset_home / "assets" / "users" / "yin-tai" / REAL_INCIDENT_EXPECTED,
    ]
    assert any(p.is_file() for p in hit), f"没落盘：{hit}"


def test_suffix_added_is_reported_back(asset_home: Path) -> None:
    """补后缀必须回显：否则调用方以为落的是无后缀路径，下次 read/update 再落空一次。

    这正是第16轮记过的「声明处 ↔ 使用处 ↔ 落盘输出处」三处不等的坑。
    """
    out = _write(_runtime(), **REAL_INCIDENT)
    assert out.get("ok") is True, out
    assert ".md" in str(out.get("resolved_path") or ""), out
    assert out.get("suffix_added") == ".md", out


def test_real_incident_file_is_readable_at_returned_path(asset_home: Path) -> None:
    """回执给的路径必须能被后续 read 直接读到（闭环，不是只有 write 侧自洽）。"""
    written = _write(_runtime(), **REAL_INCIDENT)
    path = str(written.get("resolved_path") or "")
    assert path, written

    # entity 由 principal 决定（_resolve_entity：有 pid 就落 users/<pid>），
    # 这里按真实落点回读，别猜 EntityRef（第55轮我先猜成 employee/main 直接红）。
    landed = [
        asset_home / "assets" / "users" / "yin-tai" / path,
        asset_home / "assets" / "employees" / "main" / path,
    ]
    files = [p for p in landed if p.is_file()]
    assert files, f"没落盘：{landed}"
    assert "第31轮教训" in files[0].read_text(encoding="utf-8")


def test_prefixed_path_without_suffix_also_gets_md(asset_home: Path) -> None:
    """反证：显式写前缀但漏后缀（craft/xx）也应补 .md，不是只对 kind 档生效。"""
    out = _write(_runtime(), path="craft/显式前缀漏后缀", content="正文")

    assert out.get("ok") is True, out
    assert str(out.get("path") or "").endswith("craft/显式前缀漏后缀.md"), out
    assert out.get("suffix_added") == ".md", out


def test_existing_suffix_is_never_double_appended(asset_home: Path) -> None:
    """反证：已带 .md 的路径不许变成 ``xx.md.md``。"""
    out = _write(_runtime(), path="craft/已经带后缀.md", content="正文")

    assert out.get("ok") is True, out
    assert not out.get("suffix_added"), out
    assert out.get("path", "").endswith("craft/已经带后缀.md"), out
    assert not str(out.get("path") or "").endswith(".md.md"), out


def test_dotted_filename_is_not_treated_as_missing_suffix(asset_home: Path) -> None:
    """判据边界：`.2` 这类**非文本后缀**不算后缀，仍要补 `.md`。

    这一条曾被我写反（以为是反证），跑红后确认代码对、测试错：
    `hub.write_text_file` 只认 `_TEXT_SUFFIXES`，`发布流程v1.2` 的后缀是 `.2`，
    不补 `.md` 必然被拒。所以「有点就不补」是错判据。
    """
    out = _write(_runtime(), path="craft/发布流程v1.2", content="正文")

    assert out.get("ok") is True, out
    assert str(out.get("path") or "").endswith("craft/发布流程v1.2.md"), out
    assert out.get("suffix_added") == ".md", out


def test_bare_name_without_kind_still_rejected(asset_home: Path) -> None:
    """反证：补后缀的放宽不许把「无 kind 的裸名」也放行（那条仍需 kind）。"""
    out = _write(_runtime(), path="zz_probe_no_kind", content="正文")

    assert out.get("ok") is False, out
    assert out.get("error") == "write_path_not_allowed", out
