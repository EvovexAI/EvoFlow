"""``assets write`` 的两条拒写走查：少写 `.md` 后缀、裸名且未给 kind。

【为什么有这份测试】**现网 obs 实测数据**（agent_code=self-evolution-bot，近 7 天，
``error_message='write_path_not_allowed'`` 共 14 条，逐条取 ``input_json`` 分类）：

    类① 裸名 + 文件当时**不存在** + 未给 kind  .......... 7 条
        例：'系统优化清单-按可证伪性排序'、'反向验证锚点必须在CRLF文件上才命中.md'
    类② 少写 `.md`，但同名 `.md` **就在盘上** ........... 1 条
        例：'系统优化清单-按可证伪性排序'（盘上有 memory/episodic/…md）
    类③ 探针 / 绝对路径 / 明确越界 ..................... 6 条
        例：'outputs/_perf_probe_w.md'、'memory/_inbox/probe_lat_r1.md'、
            'D:/dev/github/EvoFlow/../检索效果AB的池规模口径.md'

两类真缺陷（类③ 拒得对，不动）：

1. 类② 的后缀差异不携带落点信息 —— 资产文件全是 Markdown，多打/少打 ``.md``
   不该把一次写入变成一次往返。修复在 ``resolve_asset_rel``：裸名查不到时用
   「补了后缀的名字」再查一次**已存在文件**；新建文件仍原样返回裸名，不静默猜目录。
2. 类① 被拒时的 hint 把「你少给了一个参数」说成「你写到白名单外」，方向是错的。
   修复后 hint 必须点名 ``kind`` 这一条修法，而不是让调用方去核对白名单。

判据（第20轮起）：用例复用**现网受害者原始入参**，不许自造样例。
"""

from __future__ import annotations

import importlib
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from evoflow.assets.paths import EntityRef, entity_root, resolve_asset_rel
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


def _entity(tmp_path: Path) -> EntityRef:
    return EntityRef("employee", "self-evolution-bot").normalized()


# ── 类②：少写后缀，但同名 .md 就在盘上 ──────────────────────────────────


def test_裸名缺md后缀_盘上有同名md时解析到真实文件(asset_home: Path) -> None:
    """现网原件：'系统优化清单-按可证伪性排序' 少了 .md，盘上有对应 .md。"""
    target = entity_root(_entity(asset_home)) / "memory" / "episodic" / "系统优化清单-按可证伪性排序.md"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("# 原件\n", encoding="utf-8")

    got = resolve_asset_rel(_entity(asset_home), "系统优化清单-按可证伪性排序")

    assert got == "memory/episodic/系统优化清单-按可证伪性排序.md", got


def test_后缀补全后写入直接命中原文件不新建重复件(asset_home: Path) -> None:
    """接线：解析出来的路径必须让 write 命中**同一个**文件，而不是另建一份。"""
    root = entity_root(_entity(asset_home))
    target = root / "craft" / "反向验证锚点必须在CRLF文件上才命中.md"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("# 原件\n", encoding="utf-8")

    # 文件名本身带 .md 的这条走的是既有 basename 查找，作为对照组
    out = _write(_runtime(agent="self-evolution-bot"), path=target.name, content="追加行")

    assert out.get("ok") is True, out
    assert out.get("updated") is True, out
    assert target.read_text(encoding="utf-8").count("追加行") == 1
    # 不许在别处多出一份同名文件
    dups = [p for p in root.rglob(target.name) if p != target]
    assert dups == [], dups


def test_反证_盘上没有就不要瞎猜目录(asset_home: Path) -> None:
    """反证：补后缀只在**已存在文件**上生效。新建时原样返回，交给 kind 决定。"""
    got = resolve_asset_rel(_entity(asset_home), "全新的配方-没有后缀")

    assert got == "全新的配方-没有后缀", got


def test_反证_带前缀的路径不受后缀逻辑影响(asset_home: Path) -> None:
    """反证：已带目录成分的路径走另一支，不许被二次改写。"""
    got = resolve_asset_rel(_entity(asset_home), "craft/显式路径.md")

    assert got == "craft/显式路径.md", got


# ── 类①：裸名 + 不存在 + 未给 kind，hint 必须点名 kind ──────────────────


def test_裸名无kind时hint要点名kind而不是白名单(asset_home: Path) -> None:
    """现网原件：'第19轮-我写了个20+-实测是13-数量词必须来自当轮命令stdout'。

    修复前 hint 只说「只允许写 craft/… 这几个目录」，等于告诉调用方「你越界了」；
    真实原因是少给 kind。hint 首句必须把这条修法说出来。
    """
    out = _write(
        _runtime(agent="self-evolution-bot"),
        path="第19轮-我写了个20+-实测是13-数量词必须来自当轮命令stdout",
        content="正文",
    )

    assert out.get("ok") is False, out
    assert out.get("error") == "write_path_not_allowed", out
    hint = str(out.get("hint") or "")
    assert "kind" in hint, hint
    assert "找不到同名已有文件" in hint, hint
    # 不许再把它说成「不在可写目录内」
    assert "不在可写目录内" not in hint, hint


def test_补上kind后同一条入参必须写成功(asset_home: Path) -> None:
    """同一条现网入参，只加 kind=reflection 就该成功 —— 证明 hint 给的修法是真修法。"""
    out = _write(
        _runtime(agent="self-evolution-bot"),
        kind="reflection",
        path="第19轮-我写了个20+-实测是13-数量词必须来自当轮命令stdout.md",
        content="正文",
    )

    assert out.get("ok") is True, out
    assert out.get("path") == (
        "memory/journal/第19轮-我写了个20+-实测是13-数量词必须来自当轮命令stdout.md"
    ), out


# ── 类③：拒得对的必须继续拒（反证，防止改动放宽白名单）────────────────


@pytest.mark.parametrize(
    "path",
    [
        "outputs/_perf_probe_w.md",
        "memory/_inbox/probe_lat_r1.md",
        "D:/dev/github/EvoFlow/../检索效果AB的池规模口径.md",
    ],
)
def test_反证_越界路径必须继续被拒(asset_home: Path, path: str) -> None:
    """现网 6 条越界拒写里抽 3 条原样复跑：白名单一个字都没放宽。"""
    out = _write(_runtime(agent="self-evolution-bot"), path=path, content="正文")

    assert out.get("ok") is False, out
    assert out.get("error") == "write_path_not_allowed", out
