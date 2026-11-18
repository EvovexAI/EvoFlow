"""``assets`` 命中不到文件时，必须给出**相近候选**，而不是让模型再猜一次名字。

【self-evolution-bot · 2026-11-19 · 第59轮 · 模型:deepseek-v4.1-flash-1017】

为什么有这份测试（现网依据）：近 7 天 obs 里 ``assets`` 的 ``not_found`` 共 48 次
（我自己的探针 20 次，真实失败 28 次），失败形态高度一致——``read`` 一个
「我记得它叫…」的文件名。本仓资产文件名由正文首行标题自动生成，记不准是常态，
而原报错只有 ``{"ok":false,"error":"not_found","path":"craft/xxx.md"}``，
模型唯一的出路就是再猜一次 = 用一整轮调用换一次试错。

同时这条用例锁住我本轮亲手写出的一个**静默失效**：
``_not_found_payload`` 在模块级直接调用 ``list_tree``，而该文件里
``evoflow.assets.*`` 的 import 一律是函数内局部 import → ``NameError`` 被
``except Exception`` 兜底吞掉，候选列表从未生效，只剩兜底文案。
判据：兜底路径必须被断言覆盖，不许靠「except 里写了 hint」冒充功能可用。
"""

from __future__ import annotations

import importlib
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from evoflow.assets.paths import EntityRef, entity_root
from evoflow.config.paths import reset_paths_cache

assets_mod = importlib.import_module("evoflow.tools.builtins.assets_tool")


@pytest.fixture()
def asset_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path))
    reset_paths_cache()
    monkeypatch.setattr(assets_mod, "_principal_from_runtime", lambda _rt: "yin-tai")
    yield tmp_path
    reset_paths_cache()


def _entity(tmp_path: Path) -> EntityRef:
    return EntityRef("employee", "self-evolution-bot").normalized()


def _runtime():
    return SimpleNamespace(
        context={"agent_name": "self-evolution-bot", "principal_id": "yin-tai"},
        config={},
    )


def _seed(tmp_path: Path, names: list[str]) -> Path:
    root = entity_root(_entity(tmp_path)) / "craft"
    root.mkdir(parents=True, exist_ok=True)
    for n in names:
        (root / n).write_text(f"# {n}\n", encoding="utf-8")
    return root


def _read(**kwargs) -> dict:
    return json.loads(
        assets_mod.assets_tool.func(
            action="read", runtime=_runtime(), tool_call_id="t1", **kwargs
        )
    )


# ── 主用例：候选必须真的出现 ─────────────────────────────────────────────


def test_read_missing_name_returns_candidates(asset_home: Path) -> None:
    """记错名字时，正确文件名必须出现在 candidates 里——而不是只有 not_found。"""
    _seed(asset_home, [
        "反向验证锚点必须在CRLF文件上才命中.md",
        "验证尺度-tsc够用不起服务.md",
        "工具耗时与报错的观测入口.md",
    ])

    out = _read(path="craft/反向验证锚点必须在CRLF文件上才命中吗.md")

    assert out["ok"] is False and out["error"] == "not_found"
    assert "candidates" in out, f"候选列表没生效（大概率是局部 import 缺失）：{out}"
    assert "craft/反向验证锚点必须在CRLF文件上才命中.md" in out["candidates"], out["candidates"]
    assert out["dir_file_count"] == 3, out
    # 最相近的排第一
    assert out["candidates"][0].endswith("反向验证锚点必须在CRLF文件上才命中.md"), out["candidates"]


def test_candidates_are_capped_at_three(asset_home: Path) -> None:
    """候选最多 3 条：这是提示，不是目录转储。"""
    _seed(asset_home, [f"验证尺度-第{i}版.md" for i in range(9)])

    out = _read(path="craft/验证尺度-第9版吗.md")

    assert out["ok"] is False
    assert len(out["candidates"]) == 3, out
    assert out["dir_file_count"] == 9, out


def test_empty_dir_gives_actionable_hint_not_candidates(asset_home: Path) -> None:
    """目录空/不存在时给「怎么办」，不许伪造候选。"""
    (entity_root(_entity(asset_home)) / "craft").mkdir(parents=True, exist_ok=True)

    out = _read(path="craft/根本不存在.md")

    assert out["ok"] is False
    assert "candidates" not in out, out
    assert "list" in out["hint"] or "search" in out["hint"], out


# ── 反证：候选逻辑自己崩了也不许盖掉主错误 ───────────────────────────────


def test_payload_never_raises_even_when_listing_breaks(
    asset_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """反证：目录枚举炸掉时，仍要回 not_found + 可执行 hint，不许抛异常。"""

    def _boom(*_a, **_k):
        raise OSError("disk on fire")

    monkeypatch.setattr("evoflow.assets.hub.list_tree", _boom)

    payload = assets_mod._not_found_payload(_entity(asset_home), "craft/坏掉.md")

    assert payload["ok"] is False and payload["error"] == "not_found"
    assert "hint" in payload, payload
    assert "candidates" not in payload


def test_list_action_also_gets_candidates(asset_home: Path) -> None:
    """list 一个不存在的子目录同样受益（同一 helper 接线两处）。"""
    _seed(asset_home, ["某个配方.md"])

    out = json.loads(
        assets_mod.assets_tool.func(
            action="list", runtime=_runtime(), tool_call_id="t2", path="craft/不存在子目录"
        )
    )

    assert out["ok"] is False
    assert "hint" in out, out
