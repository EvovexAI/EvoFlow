"""Frozen-EXE worker spawn argv (code-index build / embed worker).

【self-evolution-bot · 2026-11-24 · 模型:deepseek-v4.1-flash】
锁住安装版「代码索引永远建不起来」的根因：PyInstaller 冻结后
`sys.executable` 是 evoflow-gateway.exe，`[sys.executable, "-m", module]` 会被
gateway 自己的 argparse 判成 ``unrecognized arguments: -m …``（实测 exitCode=2），
构建子进程 0.2s 就静默死掉，索引库永远只有空表。

判据两条：
1. 非冻结（dev/测试/CI）argv 与改前**逐字节相同**，行为零变化；
2. 冻结时必须走 ``--mode <internal-mode>``，且该 mode 能被 entry 分发回同一个模块。
"""

from __future__ import annotations

import sys

import pytest

from evoflow.utils import frozen_modules as F


def test_non_frozen_keeps_python_dash_m(monkeypatch: pytest.MonkeyPatch) -> None:
    """回归闸：非冻结路径不许因为本次修复而改 argv（dev/CI 全靠它）。"""
    monkeypatch.delattr(sys, "frozen", raising=False)
    argv = F.python_module_argv("evoflow.code_index.build_worker", "--force")
    assert argv[:3] == [sys.executable, "-m", "evoflow.code_index.build_worker"]
    assert argv[3:] == ["--force"]


def test_frozen_gateway_uses_internal_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    """冻结后必须换成 --mode 分发，否则 EXE 会以 unrecognized arguments 退出。"""
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", "evoflow-gateway.exe")
    argv = F.python_module_argv(
        "evoflow.code_index.build_worker", "--workspace-root", "D:/ws", "--force"
    )
    assert argv[0] == "evoflow-gateway.exe"
    assert argv[1:3] == ["--mode", "code-index-build-worker"]
    assert "-m" not in argv
    assert argv[3:] == ["--workspace-root", "D:/ws", "--force"]


def test_embed_worker_registered(monkeypatch: pytest.MonkeyPatch) -> None:
    """同一个缺陷也存在于 embed worker；漏注册 = 本地向量在安装版里静默降级。"""
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    argv = F.python_module_argv("evoflow.knowledge.embedding.embed_worker")
    assert argv[1:3] == ["--mode", "embed-worker"]


def test_mode_table_round_trips() -> None:
    """spawn 侧与 entry 侧共用同一张表，任何一边漂移都会被这条抓住。"""
    assert F.FROZEN_INTERNAL_MODES, "内部 mode 表不能为空"
    for mode, module in F.FROZEN_INTERNAL_MODES.items():
        assert F.module_for_internal_mode(mode) == module
        assert F.internal_mode_for_module(module) == mode


def test_frozen_unregistered_module_degrades_to_dash_m(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """未注册模块退回 -m（保留旧行为，不悄悄改成某种错误 argv）。"""
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    argv = F.python_module_argv("some.unregistered.module")
    assert argv[1:3] == ["-m", "some.unregistered.module"]


def _load_gateway_entry():
    """Load backend/packaging/windows/gateway_entry.py by path.

    目录名 ``packaging`` 与 PyPA 的 ``packaging`` 包同名且没有 ``__init__.py``，
    直接 ``import packaging.windows`` 会撞车（本轮实测 ModuleNotFoundError），
    所以按文件路径装载——测的是真实 entry 模块，不是复制品。
    """
    import importlib.util
    from pathlib import Path

    path = Path(__file__).parent.parent / "packaging" / "windows" / "gateway_entry.py"
    spec = importlib.util.spec_from_file_location("_evoflow_gateway_entry_test", path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_internal_mode_argv_strips_mode_only(monkeypatch: pytest.MonkeyPatch) -> None:
    """entry 侧解析：只吃掉 --mode，worker 自己的参数必须原样保留。"""
    GE = _load_gateway_entry()

    parsed = GE._internal_mode_argv(
        ["--mode", "code-index-build-worker", "--workspace-root", "D:/ws", "--force"]
    )
    assert parsed is not None
    module, rest = parsed
    assert module == "evoflow.code_index.build_worker"
    assert rest == ["--workspace-root", "D:/ws", "--force"]


def test_internal_mode_argv_ignores_normal_gateway_modes() -> None:
    """`--mode gateway` / `langgraph` 不许被内部 worker 分支截走。"""
    GE = _load_gateway_entry()

    assert GE._internal_mode_argv(["--mode", "gateway", "--port", "8382"]) is None
    assert GE._internal_mode_argv(["--mode=langgraph"]) is None
    assert GE._internal_mode_argv([]) is None
