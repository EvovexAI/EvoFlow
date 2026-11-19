"""TaskOutput and TaskStop — ZCode background-task control.

Sources:
- ZCode packages/contracts/src/tools/task-output.ts
- ZCode packages/contracts/src/tools/task-stop.ts
- ZCode packages/core/src/tool/handlers/task-output.ts
- ZCode packages/core/src/tool/handlers/task-stop.ts
"""

from __future__ import annotations

import json
import time

# 【self-evolution-bot · 2026-11-19 · 第65轮 · 模型:deepseek-v4.1-flash-1017】
# 改了什么：`tool` 改从 `langchain_core.tools` 取（本文件不用 ToolRuntime）。
# 为什么：`langchain.tools` 会顺带拉 torch（实测多 1.9 秒/进程），这里只需要 `tool`。
from langchain_core.tools import tool

from evoflow.tools.zcode_port.background import get_task, stop_task, wait_task
from evoflow.tools.zcode_port.prelude import TASK_OUTPUT_DESCRIPTION, TASK_STOP_DESCRIPTION


def _read_output(path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        return f"(output unreadable: {exc})"


def _task_output_path_candidate(task_id: str):
    """后台任务输出文件 `<TEMP>/evoflow-bash-tasks/<task_id>.output`，存在则返回路径。

    【self-evolution-bot · 2026-11-19 · 第58轮 · 模型:deepseek-v4.1-flash-1017】
    目录推导必须与 `bash_tool.py:894` **逐字一致**（同一个 TEMP/TMP/"/tmp" 回退链），
    另起一套会在 TEMP/TMP 不一致的环境里静默判成"没跑过"。
    """
    tid = str(task_id or "").strip()
    # 只接受我们自己生成的 id 形态，避免把用户输入拼进路径（目录穿越）
    if not tid or len(tid) > 64 or not all(c.isalnum() or c in "-_" for c in tid):
        return None
    try:
        import os
        from pathlib import Path

        root = Path(os.environ.get("TEMP") or os.environ.get("TMP") or "/tmp") / "evoflow-bash-tasks"
        p = root / f"{tid}.output"
        return p if p.is_file() else None
    except Exception:  # 探测输出文件是纯增益，任何失败都不该挡住 taskstop
        return None


@tool("taskoutput", description=TASK_OUTPUT_DESCRIPTION, parse_docstring=False)
def task_output_tool(task_id: str, block: bool | str = True, timeout: int | str = 5_000) -> str:
    """Retrieves output from a running or completed background task.

    task_id: The task ID to get output from.
    block: Whether to wait for completion. Default true (short wait, see below).
    timeout: Max wait time in ms. Default 5000, max 600000.
    """
    # 【self-evolution-bot · 2026-11-19 · 第67轮 · 模型:deepseek-v4.1-flash-1017】
    # 默认等待从 30000ms 降到 5000ms，并启用「静默宽限」提前返回。
    # 为什么：旧默认让每次查询最多按满 30s。近 7 天 543 次调用里
    #   140 次 ≥30s（平均 137.7s）+ 130 次 10~30s，光等待就约 6.2 小时，
    #   占全部工具耗时 21.4%（仅次于 bash），对话表现为「正在获取任务输出」假死。
    # 语义没变：任务仍在跑就返回 <retrieval_status>not_ready/timeout</retrieval_status>，
    # 调用方照旧可以稍后再查；只是不再为「多等一会也许就完了」白付 25 秒。
    # 要真的等完，显式传 timeout=600000 即可——长任务本来就该走通知，不该堵在查询里。
    if not str(task_id or "").strip():
        return "errorCode: 1\nmessage: Task ID is required"
    should_block = block if isinstance(block, bool) else str(block).strip().lower() not in {"false", "0", "no"}
    try:
        timeout_ms = max(0, min(int(timeout), 600_000))
    except (TypeError, ValueError):
        timeout_ms = 5_000
    task = get_task(task_id)
    if task is None:
        return f"errorCode: 2\nmessage: No task found with ID: {task_id}"
    if should_block and task.status == "running":
        # 静默 1.5s 且已有输出 → 提前返回，不必等满 timeout
        task = wait_task(task_id, timeout_ms, idle_grace_ms=1_500) or task
    if task.status == "running":
        retrieval = "not_ready" if not should_block else "timeout"
    else:
        retrieval = "success"
    output = _read_output(task.output_path) if task.output_path.exists() else ""
    return (
        f"<retrieval_status>{retrieval}</retrieval_status>\n"
        f"<task_id>{task.task_id}</task_id>\n"
        f"<task_type>bash</task_type>\n"
        f"<status>{task.status}</status>\n"
        f"<description>{task.description}</description>\n"
        f"<exitCode>{task.exit_code}</exitCode>\n"
        f"<outputFile>{task.output_path}</outputFile>\n"
        f"<output>\n{output[-32000:]}\n</output>"
    )


@tool("taskstop", description=TASK_STOP_DESCRIPTION, parse_docstring=False)
def task_stop_tool(task_id: str | None = None, shell_id: str | None = None) -> str:
    """Stops a running background task by its ID.

    task_id: The ID of the background task to stop.
    shell_id: Deprecated: use task_id instead.
    """
    resolved = (task_id or shell_id or "").strip()
    if not resolved:
        return "Error: Missing required parameter: task_id"
    existing = get_task(resolved)
    if existing is None:
        # 【self-evolution-bot · 2026-11-19 · 第58轮 · 模型:deepseek-v4.1-flash-1017】
        # 改了什么：注册表里查不到时，不再一律 `Error: No task found with ID: x`。
        # 为什么：「查不到」有两种完全不同的成因，而**输出文件还在盘上**能区分它们——
        #   ① 网关重启清了进程内 `_TASKS`（唯一真相在内存里），任务其实正常运行/已结束；
        #   ② id 真打错了（此时 evoflow-bash-tasks/ 下没有 <id>.output）。
        # 现网实证（2026-11-18 23:19:31，就是 23:18:36 重启之后第一分钟）：
        # 同一个 id 5eac7434c5ed 在 23:00 还能查到 status=completed，
        # 19 分钟后变成「No task found」——不是它消失了，是字典被重启清空了。
        # 我拿这条错误去重试，多绕了整整一轮才想明白。返回结构化 JSON 才能让模型
        # 一眼分清「该去读 output」还是「该重新执行命令」。
        out_path = _task_output_path_candidate(resolved)
        if out_path is not None:
            out = ""
            try:
                out = _read_output(out_path)[-4000:]
            except Exception:  # 输出是附加信息，取不到不影响结论
                out = ""
            payload_unknown: dict[str, object] = {
                "stopped": False,
                "already_finished": True,
                "registry_missing": True,
                "task_id": resolved,
                "status": "unknown",
                "message": (
                    f"任务 {resolved} 已不在本进程的任务表里（网关重启会清空该表），"
                    "但它有输出文件 —— 说明它跑过，已结束或已随进程退出。无需停止。"
                ),
                "output_path": str(out_path),
            }
            if out:
                payload_unknown["output"] = out
            else:
                payload_unknown["message"] += " 输出文件当前为空，命令可能没来得及产出。"
            return json.dumps(payload_unknown, ensure_ascii=False)
        return f"Error: No task found with ID: {resolved}"
    if existing.status != "running":
        # 【self-evolution-bot · 2026-11-18 · 第57轮 · 模型:deepseek-v4.1-flash-1017】
        # 改了什么：任务已结束不再是 `Error:` 开头，改为「目标已达成」+ 该任务的收尾信息。
        # 为什么：`taskstop` 的语义是「确保它停下」。喊停一个已经 completed/failed 的任务，
        # 目标状态**已经达成**，不是失败。原实现一律回 `Error: Task ... is not running`，
        # 现网 7 天 8 次（横跨 4 个岗位，其中 5 次是我自己），每次都让模型以为停止操作出错，
        # 于是回头去查任务状态/重启服务 —— 而它只需要知道「已经停了」。
        # 连带把该任务的 output 一并返回：喊停已结束任务的真实诉求通常是"我要它的结果"。
        finished = existing.status
        detail = [f"任务 {resolved} 已经不在运行（状态 {finished}），无需停止 —— 目标已达成。"]
        if finished == "failed":
            detail.append("它是失败结束的，如需排查看 output。")
        payload: dict[str, object] = {
            "stopped": False,
            "already_finished": True,
            "task_id": resolved,
            "status": finished,
            "message": " ".join(detail),
        }
        out = ""
        try:
            if existing.output_path and existing.output_path.exists():
                out = _read_output(existing.output_path)[-4000:]
        except Exception:  # 输出是附加信息，取不到不影响"已停止"这个结论
            out = ""
        if out:
            payload["output"] = out
        return json.dumps(payload, ensure_ascii=False)
    stopped = stop_task(resolved)
    if stopped is None:
        return f"Error: No task found with ID: {resolved}"
    # Give the pump thread a moment to notice the kill.
    time.sleep(0.05)
    return json.dumps(
        {
            "message": f"Successfully stopped task: {stopped.task_id} ({stopped.command})",
            "task_id": stopped.task_id,
            "task_type": "bash",
            "command": stopped.command,
        },
        ensure_ascii=False,
    )
