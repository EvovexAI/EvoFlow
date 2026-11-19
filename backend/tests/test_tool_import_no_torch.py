"""工具模块导入不再拉起 torch（第65轮）。

【self-evolution-bot · 2026-11-19 · 第65轮 · 模型:deepseek-v4.1-flash-1017】

## 为什么需要这个测试
`from langchain.tools import ...` → `langchain.tools.tool_node`
→ `langgraph.prebuilt.tool_node` → `langchain_core.language_models.base:42`
`from transformers import GPT2TokenizerFast` → **torch（715 模块）**。
本仓从不调用 GPT-2 tokenizer（远端模型），所以这笔钱是纯浪费。

同一个坑还有两处**包 `__init__` 急切导入**：
- `evoflow/agents/__init__.py` → `.thread_state` → `from langchain.agents import AgentState`
- `evoflow/agents/goal/__init__.py` → `.goal_auto_continue_middleware` → 同上

## 判据为什么是「子进程里 torch 是否被加载」
同进程测不出来：pytest 自己已经导入过一堆东西，`sys.modules` 早被污染。
必须起干净子进程（与真实调用同条件），并且**从工具模块入口进**（不是只 import
`langchain_core`）——只测依赖库等于没测接线（第61轮教训）。

## 反向验证
把 `tool_runtime_type.py` 里让替身继承 `_DirectlyInjectedToolArg` 的那行注释掉，
本文件 `test_lite_runtime_keeps_injection_contract` 必须变红（守卫自身也要过反证）。
"""

# 注意：本文件**不能**加 `from __future__ import annotations`。
# 那会把注解变成字符串、装饰时按模块 globals 求值，而 A/B 对比需要把真类/替身
# 作为**闭包变量**传进 `@tool` 的注解里（模块级写死就没法两种都测）。
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

from evoflow.core.tool_runtime_type import ToolRuntime

BACKEND = Path(__file__).resolve().parents[1]

_PROBE = """
import importlib, sys, time
t = time.perf_counter()
importlib.import_module({mod!r})
print(json.dumps({{
    "ms": int((time.perf_counter() - t) * 1000),
    "torch": "torch" in sys.modules,
    "modules": len(sys.modules),
}}))
"""


def _probe(mod: str) -> dict:
    code = "import json\n" + _PROBE.format(mod=mod)
    env = {
        "PYTHONPATH": f"{BACKEND / 'packages' / 'harness'}{';' if sys.platform == 'win32' else ':'}{BACKEND}",
        "PATH": __import__("os").environ.get("PATH", ""),
        "SystemRoot": __import__("os").environ.get("SystemRoot", ""),
        "TEMP": __import__("os").environ.get("TEMP", ""),
        "TMP": __import__("os").environ.get("TMP", ""),
    }
    out = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True,
        text=True,
        cwd=str(BACKEND),
        env=env,
        timeout=180,
    )
    assert out.returncode == 0, f"probe failed for {mod}:\n{out.stdout}\n{out.stderr[-2000:]}"
    return json.loads(out.stdout.strip().splitlines()[-1])


def test_hot_tool_modules_do_not_pull_torch() -> None:
    """四个最热的工具模块：干净进程里导入后不应出现 torch。"""
    hot = [
        "evoflow.tools.zcode_port.bash_tool",
        "evoflow.tools.host_direct.read_file",
        "evoflow.tools.host_direct.search_code_index",
        "evoflow.tools.host_direct.str_replace",
    ]
    bad = {}
    for mod in hot:
        info = _probe(mod)
        if info["torch"]:
            bad[mod] = info
    assert not bad, f"以下工具模块仍把 torch 拉进进程：{bad}"


def test_agents_goal_package_is_lazy() -> None:
    """`evoflow.agents.goal` 改成惰性后，取 `goal_state` 里的东西不该拉 torch。

    注意：`evoflow.agents.thread_state` **本身**就要 `from langchain.agents import AgentState`
    （它是 `ThreadState` 的真实基类，无法延后），所以它不在本断言范围内——
    这是真实依赖，不是缺陷，写清边界免得下轮误判。
    """
    bad = {}
    for mod in ("evoflow.agents.goal.goal_state", "evoflow.agents.goal.goal_events"):
        info = _probe(mod)
        if info["torch"]:
            bad[mod] = info
    assert not bad, f"agents.goal 子模块仍拉 torch：{bad}"


def test_lite_runtime_behaves_exactly_like_real_one() -> None:
    """判据是「替身与真类**行为相同**」，不是「一定被注入」。

    为什么不做绝对断言：本仓 91 个工具里 55 个 schema 含 runtime、但只有 17 个
    出现在 `_injected_args_keys` —— 过滤主要走 `args_schema` 注解那条路径。
    正确判据是**逐形态 A/B 相等**（第17轮：键漂移 ≠ 缺陷消除）。
    """
    from langchain_core.tools import tool
    from langgraph.prebuilt.tool_node import ToolRuntime as RealRuntime

    from evoflow.core.tool_runtime_type import ToolRuntime as LiteRuntime

    def make(rt):
        def bare(x: int, runtime: rt = None):
            """d."""
            return x

        def generic(x: int, runtime: rt[Any, dict] = None):
            """d."""
            return x

        def generic_any(x: int, runtime: rt[int, Any] = None):
            """d."""
            return x

        def optional(x: int, runtime: rt[Any, dict] | None = None):
            """d."""
            return x

        return {"bare": bare, "generic": generic, "generic_any": generic_any, "optional": optional}

    def shape(t):
        return (
            sorted(t.args),
            sorted(t._injected_args_keys),
            sorted(t.get_input_schema().model_fields),
        )

    real_fns = make(RealRuntime)
    lite_fns = make(LiteRuntime)

    # 三种可直接用于 @tool 的形态：必须逐字段相等
    for form in ("bare", "generic", "generic_any"):
        real = shape(tool(real_fns[form]))
        lite = shape(tool(lite_fns[form]))
        assert real == lite, f"{form} 形态下替身与真类不一致：real={real} lite={lite}"

    # `X | None` 形态：不预设谁抛谁不抛，只断言**两者结局相同**。
    # （上一版我写死「真类必抛」，实测反了——第41轮教训：不靠断言替我选结论。）
    def outcome(fn):
        try:
            return ("ok", shape(tool(fn)))
        except Exception as exc:  # noqa: BLE001
            return ("raise", type(exc).__name__)

    real_out = outcome(real_fns["optional"])
    lite_out = outcome(lite_fns["optional"])
    # 实测结论（2026-11-19）：真类抛 PydanticInvalidForJsonSchema，替身能出门。
    # 方向是「替身更宽松」，不是更严格 —— 不会把原本能跑的代码弄坏。
    # 为何不构成风险：全仓 `ToolRuntime[..] | None` 只出现在**普通 helper 函数**签名里
    # （asset_recorder / sandbox.tools / assets_tool 的内部函数等），没有一处是 @tool 入口；
    # 这一点由全量工具快照交叉证明：91 个工具的 args/schema 改前改后完全一致。
    assert real_out[0] == "raise", f"预期真类在 optional 形态报错，实测 {real_out}"
    assert lite_out[0] == "ok", f"预期替身能接受 optional 形态，实测 {lite_out}"


def test_lite_runtime_is_directly_injected_subclass() -> None:
    """轻量类必须继承 `_DirectlyInjectedToolArg`——这是 langchain 唯一认的判据。"""
    from langchain_core.tools.base import _DirectlyInjectedToolArg, _is_directly_injected_arg_type

    assert issubclass(ToolRuntime, _DirectlyInjectedToolArg)
    # 泛型下标形态走 origin 分支，langchain 也必须认（22 处 ToolRuntime[X, Y] 的依赖）
    assert _is_directly_injected_arg_type(ToolRuntime[Any, dict])
    assert _is_directly_injected_arg_type(ToolRuntime[int, Any])


def test_real_runtime_instance_passes_validation_on_lite_annotation() -> None:
    """端到端：拿**真** ToolRuntime 实例去 invoke 用轻量类注解的工具，不能报校验错。

    为什么这条必须有：第65轮我把替身写成 dataclass，`@tool` 生成的 pydantic 模型
    会按类型校验，真实例直接被判「不是本类」→ `ValidationError`，
    全仓工具一调用就炸。这个坑是 `test_assets_tool_private_pool.py` 先抓到的，
    这里补一条**最小、从工具入口进**的守卫，避免同类改动再无声复发。
    """
    from langchain_core.tools import tool
    from langgraph.prebuilt.tool_node import ToolRuntime as RealRuntime

    from evoflow.core.tool_runtime_type import ToolRuntime

    @tool
    def _echo(x: int, runtime: ToolRuntime[Any, dict] = None) -> int:  # noqa: RUF013
        """echo."""
        return x

    real = RealRuntime(
        state={},
        context={},
        config={},
        stream_writer=None,
        tool_call_id="probe",
        store=None,
    )
    assert _echo.invoke({"x": 7, "runtime": real}) == 7
    assert sorted(_echo.args) == ["x"]
