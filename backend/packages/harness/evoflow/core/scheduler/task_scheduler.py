#!/usr/bin/env python3
"""
并行任务调度器 - 支持防重入的自动化执行

设计原则：
1. 不同任务可以并行执行（各自独立子进程）
2. 同一任务防重入（上一个没执行完，跳过本次）
3. 每个任务维护自己的执行状态
"""

from __future__ import annotations

import asyncio
import json
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from .executor import AutomationExecutor


@dataclass
class TaskInstance:
    """任务实例定义"""

    task_id: str
    name: str
    prompt: str
    cron_expression: str  # 如 "*/5 * * * *" (每5分钟)
    last_run: datetime | None = None
    next_run: datetime | None = None
    is_running: bool = False
    current_future: asyncio.Future | None = None
    run_history: list[dict] = field(default_factory=list)
    max_history: int = 10


class ParallelTaskScheduler:
    """
    并行任务调度器

    特性：
    - 每个任务独立调度，按 cron 时间触发
    - 同一任务防重入（is_running 标记）
    - 不同任务并行执行（线程池）
    - 支持用户取消任务
    """

    def __init__(self, max_workers: int = 5):
        self.tasks: dict[str, TaskInstance] = {}
        self.executor = AutomationExecutor()
        self.thread_pool = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="task_scheduler")
        self._running = False
        self._scheduler_task: asyncio.Task | None = None
        self._lock = threading.RLock()
        self._check_interval = 1  # 每秒检查一次是否需要触发任务

        # 取消标记：task_id -> bool
        self._cancelled_tasks: set[str] = set()

        # 历史记录目录
        self._history_dir = Path(r"d:\github\EvoFlow\temp\scheduler_history")
        self._history_dir.mkdir(parents=True, exist_ok=True)

    def _is_task_cancelled(self, task_id: str) -> bool:
        """Check if a task has been marked for cancellation."""
        with self._lock:
            return task_id in self._cancelled_tasks

    def cancel_task(self, task_id: str) -> bool:
        """Cancel a running or pending task.

        Returns True if cancellation was requested.
        """
        with self._lock:
            task = self.tasks.get(task_id)
            if not task:
                return False

            # Mark as cancelled
            self._cancelled_tasks.add(task_id)

            # If currently running, terminate the subprocess
            if task.is_running:
                print(f"[Scheduler] 请求取消运行中的任务: {task.name}")
                return self.executor.cancel_task(task_id)

            return True

    def clear_cancelled(self, task_id: str):
        """Clear cancellation mark for a task (call after task completes)."""
        with self._lock:
            self._cancelled_tasks.discard(task_id)

    def register_task(
        self,
        task_id: str,
        name: str,
        prompt: str,
        cron_expression: str,
    ) -> TaskInstance:
        """注册一个自动化"""
        task = TaskInstance(
            task_id=task_id,
            name=name,
            prompt=prompt,
            cron_expression=cron_expression,
        )
        self.tasks[task_id] = task
        print(f"[Scheduler] 注册任务: {task_id} ({cron_expression})")
        return task

    def _should_run(self, task: TaskInstance) -> bool:
        """检查任务是否应该执行（基于 cron 时间）"""
        now = datetime.now()

        # 如果正在运行，跳过（防重入）
        if task.is_running:
            return False

        # 第一次运行或到达下次执行时间
        if task.next_run is None or now >= task.next_run:
            return True

        return False

    def _calculate_next_run(self, cron_expression: str, from_time: datetime) -> datetime:
        """根据 cron 表达式计算下次执行时间（简化版，支持常见的分钟级调度）"""
        # 简化实现：解析 */5 或具体数字
        parts = cron_expression.split()
        if len(parts) >= 1:
            minute_part = parts[0]
            if minute_part.startswith("*/"):
                # 每 N 分钟
                interval = int(minute_part[2:])
                # 找到下一个整点间隔
                current_minute = from_time.minute
                next_minute = ((current_minute // interval) + 1) * interval
                if next_minute >= 60:
                    next_minute = 0
                    from_time = from_time.replace(hour=from_time.hour + 1)
                return from_time.replace(minute=next_minute, second=0, microsecond=0)
            elif minute_part.isdigit():
                # 具体分钟
                minute = int(minute_part)
                next_time = from_time.replace(minute=minute, second=0, microsecond=0)
                if next_time <= from_time:
                    next_time = next_time.replace(minute=minute)  # 下小时的这个时间
                return next_time

        # 默认每5分钟
        return from_time.replace(minute=(from_time.minute // 5 + 1) * 5 % 60, second=0, microsecond=0)

    def _execute_task_sync(self, task: TaskInstance) -> dict:
        """同步执行任务（在线程池中运行）"""
        print(f"[Scheduler] 开始执行任务: {task.name} ({task.task_id})")
        start_time = datetime.now()

        try:
            # Check if cancelled before starting
            if self._is_task_cancelled(task.task_id):
                print(f"[Scheduler] 任务已被取消，跳过执行: {task.name}")
                return {
                    "task_id": task.task_id,
                    "task_name": task.name,
                    "start_time": start_time.isoformat(),
                    "duration": 0,
                    "status": "cancelled",
                    "error": "Task cancelled before execution",
                }

            result = self.executor.execute(
                task_id=task.task_id,
                task_name=task.name,
                prompt=task.prompt,
                manual=True,
            )

            duration = (datetime.now() - start_time).total_seconds()

            record = {
                "task_id": task.task_id,
                "task_name": task.name,
                "start_time": start_time.isoformat(),
                "duration": duration,
                "status": "success",
                "output_preview": result.output[:200] if hasattr(result, "output") else "",
            }

            print(f"[Scheduler] 任务完成: {task.name}, 耗时: {duration:.2f}s")
            return record

        except Exception as e:
            duration = (datetime.now() - start_time).total_seconds()
            record = {
                "task_id": task.task_id,
                "task_name": task.name,
                "start_time": start_time.isoformat(),
                "duration": duration,
                "status": "failed",
                "error": str(e),
            }
            print(f"[Scheduler] 任务失败: {task.name}, 错误: {e}")
            return record
        finally:
            # 清理运行状态和取消标记
            with self._lock:
                task.is_running = False
                task.current_future = None
                self._cancelled_tasks.discard(task.task_id)

    def _on_task_complete(self, task: TaskInstance, future):
        """任务完成回调"""
        try:
            result = future.result()
            with self._lock:
                task.run_history.append(result)
                if len(task.run_history) > task.max_history:
                    task.run_history = task.run_history[-task.max_history :]
        except Exception as e:
            print(f"[Scheduler] 任务回调错误: {e}")

    async def _scheduler_loop(self):
        """调度器主循环"""
        print("[Scheduler] 调度器启动")

        asyncio.get_event_loop()

        while self._running:
            now = datetime.now()

            for task_id, task in self.tasks.items():
                if self._should_run(task):
                    with self._lock:
                        # 检查防重入
                        if task.is_running:
                            print(f"[Scheduler] 跳过任务 {task.name} (仍在运行)")
                            continue

                        # 标记为运行中
                        task.is_running = True
                        task.last_run = now
                        task.next_run = self._calculate_next_run(task.cron_expression, now)
                        print(f"[Scheduler] 调度任务: {task.name}, 下次执行: {task.next_run.strftime('%H:%M:%S')}")

                    # 在线程池中提交任务（真正并行执行）
                    future = self.thread_pool.submit(self._execute_task_sync, task)
                    task.current_future = future

                    # 添加完成回调
                    future.add_done_callback(lambda f, t=task: self._on_task_complete(t, f))

            await asyncio.sleep(self._check_interval)

        print("[Scheduler] 调度器停止")

    def start(self):
        """启动调度器"""
        if self._running:
            return

        self._running = True

        # 在新线程中运行 asyncio 事件循环
        def run_loop():
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            self._scheduler_task = loop.create_task(self._scheduler_loop())
            loop.run_until_complete(self._scheduler_task)

        self._scheduler_thread = threading.Thread(target=run_loop, daemon=True)
        self._scheduler_thread.start()
        print("[Scheduler] 调度器线程已启动")

    def stop(self):
        """停止调度器"""
        self._running = False
        self.thread_pool.shutdown(wait=True)
        print("[Scheduler] 调度器已停止")

    def get_status(self) -> dict:
        """获取调度器状态"""
        with self._lock:
            return {
                "running": self._running,
                "tasks": {
                    task_id: {
                        "name": task.name,
                        "is_running": task.is_running,
                        "last_run": task.last_run.isoformat() if task.last_run else None,
                        "next_run": task.next_run.isoformat() if task.next_run else None,
                        "cron": task.cron_expression,
                    }
                    for task_id, task in self.tasks.items()
                },
            }

    def save_history(self):
        """保存运行历史"""
        with self._lock:
            for task_id, task in self.tasks.items():
                if task.run_history:
                    history_file = self._history_dir / f"{task_id}_history.json"
                    with open(history_file, "w", encoding="utf-8") as f:
                        json.dump(task.run_history, f, ensure_ascii=False, indent=2)


# 单例实例
_default_scheduler: ParallelTaskScheduler | None = None


def get_scheduler() -> ParallelTaskScheduler:
    """获取默认调度器实例"""
    global _default_scheduler
    if _default_scheduler is None:
        _default_scheduler = ParallelTaskScheduler()
    return _default_scheduler
