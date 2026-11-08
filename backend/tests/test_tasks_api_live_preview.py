"""GET /tasks 必须给未终态子任务带上实时正文（executionPreview / current_step）。

背景：工作流节点原先只显示「子任务已派发」——那是派发瞬间写死的 current_step。
worker 不会主动调 progress 工具（该工具是 plan 层专属），真实运行正文只在
worker 的 chat transcript 里。故 /tasks 响应必须从 transcript 取最后一条正文。

复现：用户 2026-11-08 的「验证N9慢跑深度并发」运行，节点只有冻结文案。
"""

from __future__ import annotations

import sys
from pathlib import Path

_BACKEND = Path(__file__).resolve().parents[1]
_HARNESS = _BACKEND / "packages" / "harness"
for _p in (str(_BACKEND), str(_HARNESS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from app.gateway.routers import tasks as tasks_router  # noqa: E402


def _task(status: str = "executing", sub_status: str = "executing") -> dict:
    return {
        "id": "Task_20261108133150_a4de",
        "name": "慢跑深度并发",
        "status": status,
        "progress": 50,
        "thread_id": "lead-thread-1",
        "subtasks": [
            {
                "id": "Subtask_20261108133150_729921",
                "name": "Step 1: 慢跑",
                "status": sub_status,
                "progress": 40,
                # 派发瞬间写死，之后 worker 不再更新
                "current_step": "子任务已派发",
                "subtask_thread_id": "SubThread_Subtask_20261108133150_729921",
            }
        ],
    }


def test_public_task_dict_adds_execution_preview_for_running_subtask(monkeypatch):
    """未终态子任务：补 executionPreview，并同步 current_step（不再是冻结文案）。"""

    def fake_preview(_task, _row, _sid, *, limit=1):
        assert limit == 1, "预览必须收紧 limit，避免每次轮询扫全量 transcript"
        return "用 bash 循环来实现慢跑验证"

    monkeypatch.setattr(
        "evoflow.collab.task_progress_snapshot._latest_subtask_preview_text",
        fake_preview,
    )

    out = tasks_router._public_task_dict(_task())
    sub = out["subtasks"][0]
    assert sub["executionPreview"] == "用 bash 循环来实现慢跑验证"
    # current_step 必须同步，否则节点仍显示「子任务已派发」
    assert sub["current_step"] == "用 bash 循环来实现慢跑验证"


def test_public_task_dict_skips_terminal_subtask(monkeypatch):
    """终态子任务不再读 transcript（省一次 DB 查询），保留原 outcome 文案。"""

    def fake_preview(_task, _row, _sid, *, limit=1):
        raise AssertionError("终态子任务不应读取 transcript")

    monkeypatch.setattr(
        "evoflow.collab.task_progress_snapshot._latest_subtask_preview_text",
        fake_preview,
    )

    out = tasks_router._public_task_dict(_task(sub_status="completed"))
    sub = out["subtasks"][0]
    assert "executionPreview" not in sub
    assert sub["current_step"] == "子任务已派发"


def test_public_task_dict_keeps_current_step_when_preview_missing(monkeypatch):
    """transcript 还没有内容时，不要把 current_step 清空（退化成空白）。"""

    monkeypatch.setattr(
        "evoflow.collab.task_progress_snapshot._latest_subtask_preview_text",
        lambda *_a, **_k: "",
    )

    out = tasks_router._public_task_dict(_task())
    sub = out["subtasks"][0]
    assert sub["current_step"] == "子任务已派发"
    assert "executionPreview" not in sub


def test_public_task_dict_tolerates_transcript_error(monkeypatch):
    """transcript 读取抛错时不能让整个 /tasks 500。"""

    def boom(*_a, **_k):
        raise RuntimeError("transcript db unavailable")

    monkeypatch.setattr(
        "evoflow.collab.task_progress_snapshot._latest_subtask_preview_text",
        boom,
    )

    out = tasks_router._public_task_dict(_task())
    assert out["subtasks"][0]["current_step"] == "子任务已派发"


def test_public_task_dict_without_subtasks_is_unchanged():
    out = tasks_router._public_task_dict({"id": "Task_x", "status": "planned"})
    assert "subtasks" not in out or out["subtasks"] == []
