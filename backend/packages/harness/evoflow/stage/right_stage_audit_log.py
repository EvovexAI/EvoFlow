"""右栏审计日志：把「工具发了什么」与「前端上报了什么」写进同一个文件。

【self-evolution-bot · 2026-11-20 · 第101轮 · 模型:deepseek-v4.1-flash-1017】
改了什么：新增本模块，落盘 ``{logs}/right-stage-YYYY-MM-DD.log``。
为什么（用户当场指出，原话）：
  「我看你调用右侧工具的时候，右侧的侧边面板我没看到打开。如果你查不到问题的
    话，可以加一点日志呀。到时候你可以在日志文件里看到操作了什么样的工具、
    右侧有什么东西出现，或者通过一些数据和处理去查看客户端面板的实时操作。」
事实是这三处此前都没有留痕：
  ① ``stage_tool._emit`` 只写 logger ``evoflow.right_stage``，今日
     ``grep right-stage-emit`` 在 gateway / langgraph 日志里命中 **0** ——
     工具返回 ok、屏幕上什么都没发生，我拿不到任何可核对的证据；
  ② 前端 ``logRightStage`` 有落盘能力但**默认关**（要手动设
     ``localStorage['ef.debug.rightStage.file']='1'``）；
  ③ 前端状态上报 ``POST /api/stage/right-stage/state`` 只覆盖一份快照，
     **不留历史**，所以「我发出去那一刻 UI 是什么样」永远查不回来。

写法边界：
- 与 ``tools/builtins/browser_debug_log.py`` 同型：单文件、单锁、失败静默。
  日志坏了绝不能反过来拖垮右栏或工具。
- 前缀用来区分来源：``[py]`` = 后端推送/工具链，``[web-state]`` = 前端上报。
  一个文件按时间顺序看，就能对上「后端发了 X，前端回的是 Y」。
- 路径解析优先 ``EVOFLOW_LOGS_DIR``（桌面端注入），否则 ``~/.evoflow/logs``。
  harness 不许 import app，因此走 ``evoflow.runtime.log_policy``。
"""

from __future__ import annotations

import os
import threading
from datetime import datetime
from pathlib import Path

_WRITE_LOCK = threading.Lock()
_MAX_LINE = 4000


def _logs_dir() -> Path:
    try:
        from evoflow.runtime.log_policy import resolve_product_logs_dir

        return resolve_product_logs_dir()
    except Exception:
        env = (os.environ.get("EVOFLOW_LOGS_DIR") or "").strip()
        if env:
            return Path(env).expanduser()
        return Path(os.path.expanduser("~")) / ".evoflow" / "logs"


def right_stage_log_path() -> Path:
    """``{logs}/right-stage-YYYY-MM-DD.log``（按日本地时间）。"""
    day = datetime.now().strftime("%Y-%m-%d")
    return _logs_dir() / f"right-stage-{day}.log"


def right_stage_log(source: str, message: str) -> None:
    """追加一行。``source`` 见模块 docstring（``py`` / ``web-state`` …）。"""
    try:
        text = str(message or "").replace("\r", " ").replace("\n", " ")
        if len(text) > _MAX_LINE:
            text = text[:_MAX_LINE] + f"…(+{len(text) - _MAX_LINE})"
        stamp = datetime.now().strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3]
        line = f"{stamp} [{source}] {text}\n"
        path = right_stage_log_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        with _WRITE_LOCK:
            with open(path, "a", encoding="utf-8") as fh:
                fh.write(line)
    except Exception:
        # 审计日志失败绝不冒泡：它只服务排查。
        pass
