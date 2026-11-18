"""守卫：``tasks`` 列表热路径不得拉起模型栈（langchain / transformers / torch）。

Why (2026-11-18)
----------------
用户报「任务列表拉很久，拉完还不正常」。实测本机 291 条任务、同一进程内：

    list_tasks(limit=10)  首调 5456ms → 次调 18ms

慢的不是查询，是**首调的 import 冷启动**。两条链都把模型栈拽了进来：

1. ``admin.tasks._status_zh`` 为了取一张状态中文表，
   ``from evoflow.tools.builtins.supervisor_tool import _STATUS_ZH_MAP``
   → ``tools/builtins/__init__`` eager 导入每个内置工具
   → ``langchain.tools`` → ``transformers`` → ``torch``。
2. ``collab.task_handlers.task_handlers_of`` → ``workspace_root_for_agent``
   → ``from evoflow.proactive.repositories import ProactiveRepository``
   → ``evoflow.proactive.__init__`` eager 导入 ``engine``/``runner``
   → ``evoflow.models`` → ``langchain`` → ``torch``。

修法是搬常量（``evoflow.collab.task_status``）+ 包级惰性导出（PEP 562）。
本测试把结论钉住：新进程里跑一次 list，模型栈必须还没被导入。
"""

from __future__ import annotations

import subprocess
import sys
import textwrap

_MODEL_STACK = ("langchain", "transformers", "torch")

_PROBE = textwrap.dedent(
    """
    import sys
    from evoflow.admin import tasks as T
    rows = T.list_tasks(limit=10)
    loaded = [m for m in %(stack)s if m in sys.modules]
    print("LOADED:" + ",".join(loaded))
    print("ROWS:" + str(rows["count"]))
    """
)


def _fresh_process_loaded_modules() -> tuple[list[str], int]:
    """在**全新解释器**里跑一次 tasks list，回来看谁被拽进来了。

    用子进程而不是本进程：pytest 自身早已导入 langchain，在同进程里断言
    只会永远红或永远假绿。冷启动成本也只有新进程才测得出来。
    """
    code = _PROBE % {"stack": repr(list(_MODEL_STACK))}
    proc = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=180,
    )
    loaded: list[str] = []
    rows = -1
    for line in (proc.stdout or "").splitlines():
        if line.startswith("LOADED:"):
            loaded = [x for x in line[len("LOADED:") :] if x]
        elif line.startswith("ROWS:"):
            rows = int(line[len("ROWS:") :] or -1)
    assert proc.returncode == 0, f"probe crashed:\n{proc.stdout}\n{proc.stderr}"
    return loaded, rows


def test_list_tasks_does_not_import_model_stack() -> None:
    loaded, rows = _fresh_process_loaded_modules()
    assert rows >= 0, "list_tasks 未返回可解析行数"
    assert not loaded, (
        "tasks list 热路径把模型栈拉进来了 → 首调要付几秒 import 冷启动。"
        f" 已导入: {loaded}。检查 admin.tasks / collab.task_handlers / "
        "evoflow.proactive.__init__ 是否又恢复了 eager 导入。"
    )


def test_status_vocabulary_matches_legacy_supervisor_source() -> None:
    """状态词表搬家不能改口径——逐键对齐 HEAD 里 supervisor_tool 的原表。"""
    from evoflow.collab.task_status import (
        ALLOWED_TASK_STATES,
        STATUS_ZH_MAP,
        TASK_STATE_TRANSITIONS,
        can_transition,
        next_states,
        status_zh,
    )

    # supervisor_tool 仍暴露旧私有名（向后兼容），且必须与词表同源。
    from evoflow.tools.builtins.supervisor_tool import (
        _ALLOWED_TASK_STATES,
        _STATUS_ZH_MAP,
        _TASK_STATE_TRANSITIONS,
    )

    assert _STATUS_ZH_MAP is STATUS_ZH_MAP
    assert _TASK_STATE_TRANSITIONS is TASK_STATE_TRANSITIONS
    assert _ALLOWED_TASK_STATES is ALLOWED_TASK_STATES

    assert status_zh("executing") == "处理中"
    assert status_zh("COMPLETED") == "已完成"
    assert status_zh("in-progress") == "处理中"  # 连字符归一
    assert status_zh(None) == "未知"
    assert status_zh("nonsense") == "未知"

    assert can_transition("pending", "executing") is True
    assert can_transition("completed", "executing") is False
    assert can_transition("failed", "pending") is True  # 失败可重试
    assert can_transition("pending", "pending") is True  # 同态恒可
    assert next_states("completed") == []


def test_proactive_package_exports_resolve_lazily() -> None:
    """惰性导出后，`from evoflow.proactive import X` 行为不变。"""
    code = textwrap.dedent(
        """
        import sys
        import evoflow.proactive as p
        from evoflow.proactive import ProactiveRole, ProactiveRepository, DecisionGate
        light = "torch" in sys.modules or "langchain" in sys.modules
        from evoflow.proactive import ProactiveEngine
        heavy = "torch" in sys.modules
        print("LIGHT_EAGER_POLLUTED:" + str(light))
        print("ENGINE_OK:" + str(ProactiveEngine.__name__))
        print("HEAVY_ON_DEMAND:" + str(heavy))
        print("DIR_HAS_ENGINE:" + str("ProactiveEngine" in dir(p)))
        print("ALL_OK:" + str(all(hasattr(p, n) for n in p.__all__)))
        """
    )
    proc = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=180,
    )
    assert proc.returncode == 0, proc.stderr
    out = proc.stdout
    assert "LIGHT_EAGER_POLLUTED:False" in out, "轻量子模块又被 eager 拉进模型栈"
    assert "ENGINE_OK:ProactiveEngine" in out
    assert "HEAVY_ON_DEMAND:True" in out, "ProactiveEngine 应当按需加载真模块"
    assert "DIR_HAS_ENGINE:True" in out, "dir() 需包含惰性名（star 导入依赖）"
    assert "ALL_OK:True" in out, "__all__ 中每个名字都必须可解析"
