"""Spawn argv for Python "worker modules" that must also work inside a frozen desktop EXE.

【self-evolution-bot · 2026-11-24 · 模型:deepseek-v4.1-flash】
问题（现网实证，安装版 D:/EvoFlow/binaries/evoflow-gateway/evoflow-gateway.exe）：
  `search_code_index` 永远只回 "Workspace index is not ready — open the project in
  EvoPanel (index build) or wait for background indexing"，`.evoflow/code_index/index.db`
  只有 `meta` 三行 + 空表（fts_content 0 行、symbols 0 行），用户装完新版本就再也搜不到代码。
  根因不在索引逻辑，而在**子进程命令行**：
      code_index/store.py::_spawn_build_subprocess -> [sys.executable, "-m",
      "evoflow.code_index.build_worker"]
  非冻结时 `sys.executable` 是 python 解释器，这条 cmd 合法；PyInstaller 冻结后
  `sys.executable` 就是 `evoflow-gateway.exe`，等价于
      evoflow-gateway.exe -m evoflow.code_index.build_worker
  → 被 gateway 自己的 argparse 拦下：
      error: unrecognized arguments: -m evoflow.code_index.build_worker（exitCode=2，实测）
  → 构建子进程 0.2 秒就死，还带着 stdout/stderr=DEVNULL，所以**完全静默**：
  索引永远是空库，检索工具只能说「未就绪」。
  同一个缺陷也存在于 knowledge/embedding/embed_client.py 的 embed worker（同一句
  `[sys.executable, "-m", ...]`），冻结后本地向量也起不来。

修法：冻结时改走 EXE 自带的内部 mode 分发（`--mode <internal-mode>`），由
`gateway_entry.py` 在 argparse 之前拦下并调用对应模块的 `main()`；非冻结保持
`-m <module>` 不变，dev/测试路径零变化。mode 名与模块的映射只此一份，spawn 侧和
entry 侧共用，避免两边漂移（本仓栽过「函数层改好、接线没通」）。
"""

from __future__ import annotations

import sys

# 内部 mode 名 -> 模块。gateway_entry.py 按这份表分发；spawn 侧按同一份表反查。
FROZEN_INTERNAL_MODES: dict[str, str] = {
    "code-index-build-worker": "evoflow.code_index.build_worker",
    "embed-worker": "evoflow.knowledge.embedding.embed_worker",
}


def is_frozen() -> bool:
    """True when running inside a PyInstaller EXE (sys.executable is not python)."""
    return bool(getattr(sys, "frozen", False))


def internal_mode_for_module(module: str) -> str | None:
    """Reverse lookup: module name -> frozen internal mode (None when unregistered)."""
    for mode, mod in FROZEN_INTERNAL_MODES.items():
        if mod == module:
            return mode
    return None


def module_for_internal_mode(mode: str) -> str | None:
    """Forward lookup used by the frozen entrypoint."""
    return FROZEN_INTERNAL_MODES.get(mode)


def python_module_argv(module: str, *extra: str) -> list[str]:
    """Argv that runs *module*'s ``main`` / ``__main__`` in the current build mode.

    Non-frozen:        ``[python, "-m", module, *extra]``
    Frozen EXE:        ``[exe, "--mode", <internal-mode>, *extra]``
    Frozen, unregistered module falls back to ``-m`` (kept for compatibility; callers
    that add new worker modules must register them in ``FROZEN_INTERNAL_MODES``).
    """
    args = [str(a) for a in extra]
    exe = str(sys.executable)
    if is_frozen():
        mode = internal_mode_for_module(module)
        if mode:
            return [exe, "--mode", mode, *args]
    return [exe, "-m", module, *args]


def split_internal_mode_argv(argv: list[str]) -> tuple[str, list[str]] | None:
    """Parse an internal-worker argv; return ``(module, remaining_argv)`` or None.

    【self-evolution-bot · 2026-11-24 · 模型:deepseek-v4.1-flash】
    放在这里（而不是 packaging/windows 下的脚本里）有两个理由：
      · spawn 侧和 entry 侧必须用**同一份** mode 表与同一套解析，否则两边会漂移；
      · `packaging/` 目录没有 `__init__.py`，且与 PyPA 的 `packaging` 包同名，
        测试里 import 会撞车；纯函数放在 harness 包内才能被单测直接覆盖。
    只吃掉 ``--mode``（以及 ``--mode=x`` 形式），worker 自己的参数原样保留。
    """
    mode_arg = ""
    rest: list[str] = []
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == "--mode" and i + 1 < len(argv):
            mode_arg = argv[i + 1]
            i += 2
            continue
        if arg.startswith("--mode="):
            mode_arg = arg.split("=", 1)[1]
            i += 1
            continue
        rest.append(arg)
        i += 1
    if not mode_arg:
        return None
    module = module_for_internal_mode(mode_arg)
    if not module:
        return None
    return module, rest
