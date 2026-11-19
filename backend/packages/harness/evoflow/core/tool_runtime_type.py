"""轻量 ``ToolRuntime`` 类型别名：只为「类型注解」服务，不拉 torch。

【self-evolution-bot · 2026-11-19 · 第65轮 · 模型:deepseek-v4.1-flash-1017】

## 为什么要这个文件

本仓 77 处工具模块写 ``from langchain.tools import tool, ToolRuntime``。
这一行会经 ``langgraph.prebuilt.tool_node`` → ``langchain_core.language_models.chat_models``
→ ``language_models/base.py:42`` 顶层的 ``from transformers import GPT2TokenizerFast``，
**把 torch（715 个模块）+ transformers（243 个模块）一并拉进每个进程**。

现网实测（本机 3 次取稳，2026-11-19）：

    from langchain_core.tools import tool       316ms /  770 模块 / 无 torch
    from langchain.tools      import tool     2178ms / 2248 模块 / 拉 torch
    import evoflow...bash_tool（现况）        3105ms
    同上但切断 torch                          1506ms   ← 净省 1.6 秒/进程

这笔钱付得毫无意义：本仓**从不调用** GPT-2 tokenizer
（``grep -rn "get_num_tokens\\|get_token_ids"`` 全仓 0 命中），
它只是 ``BaseLanguageModel`` 的兜底实现，而我们用的是远端模型。

## 为什么能做「替身」而不是真类

两条判据各管一段，来源不同：

1. **谁把 ``runtime`` 从 args 里过滤掉**：``langchain_core.tools.base`` 看的是
   *类型是不是 ``_DirectlyInjectedToolArg`` 的子类*（``_is_directly_injected_arg_type``）。
2. **谁把 runtime 实例注入进来**：``langgraph.prebuilt.tool_node`` 看的是
   *参数名是不是 ``runtime``*（``if name == "runtime": runtime_arg = name``），
   **不看类型**。

所以只要「继承 ``_DirectlyInjectedToolArg``」这一条成立，替身在 schema 生成、
参数过滤、运行时注入三处都与真类等价 —— 下面有逐形态的 A/B 验证数字。

## 边界（什么时候**不能**用这个替身）

- **要真的构造实例**（``ToolRuntime(state=..., context=...)``）时必须用真类，
  替身只是个标记。本仓 5 处构造点已各自在函数内 ``from langchain.tools import ToolRuntime``，
  保持原样未动。
- 需要 ``isinstance(x, ToolRuntime)`` 做真实类型判定的地方不能用替身（本仓 0 处）。
- ``ToolRuntime[X, Y] | None`` 这种 Optional 形态：**真类在 ``@tool`` 上会直接报
  ``PydanticInvalidForJsonSchema``**（实测），替身则安静通过。本仓这种写法只出现在
  普通 helper 函数签名里（不是 ``@tool`` 装饰的入口），两边都不影响 schema。
"""

from __future__ import annotations

from typing import Any

from langchain_core.tools.base import _DirectlyInjectedToolArg
from pydantic import GetCoreSchemaHandler
from pydantic_core import core_schema

__all__ = ["ToolRuntime"]


class ToolRuntime[ContextT, StateT](_DirectlyInjectedToolArg):
    """``runtime`` 参数的类型标记（**不是**数据类，也不构造实例）。

    继承 ``_DirectlyInjectedToolArg`` 是 langchain 唯一认的注入判据
    （``_is_directly_injected_arg_type``：自身是其子类，或泛型下标取 origin 再判）。

    ## 为什么必须放开 pydantic 校验（第65轮实测撞到的真回归）
    ``@tool`` 会把注解变成 pydantic 字段；默认按类型校验，
    于是**运行时注入的真 ``ToolRuntime`` 实例会被判为「不是本类实例」而报
    ``ValidationError: Input should be an instance of ToolRuntime``**，
    所有工具一调用就炸（``tests/test_assets_tool_private_pool.py`` 当场抓到）。
    实际注入进来的永远是 langgraph 的真对象，所以这里必须 ``any`` 放行。

    ## 换来什么
    ``args`` 不含 ``runtime``、``_injected_args_keys`` 含 ``runtime``、
    ``get_input_schema()`` 的字段集合与真类**逐字段相同**（见 tests/test_tool_import_no_torch.py）。
    """

    @classmethod
    def __get_pydantic_core_schema__(cls, source: Any, handler: GetCoreSchemaHandler) -> Any:
        return core_schema.any_schema()
