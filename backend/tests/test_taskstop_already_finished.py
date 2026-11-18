"""喊停一个已经结束的任务不是失败，是「目标已达成」（第57轮修复契约）。

【为什么有这份测试】现网观测库 7 天 8 次 `taskstop` 报错，横跨 4 个岗位
（self-evolution-bot 5、live-notes-keeper 2、main 1、aigc-remaker 1），
原文一律是 `Error: Task <id> is not running (status: completed)`。

`taskstop` 的语义是「确保它停下」。对已 completed/failed 的任务喊停，
目标状态**已经达成**，不是失败。但 `Error:` 前缀会让模型以为停止操作出错，
于是回头查任务状态、重启服务 —— 而它只需要知道「已经停了，这是它的结果」。

本文件的正向断言钉住「不再以 Error 开头且结构化说明」，
反向断言钉住「真失败仍必须是 Error」（别为了修这条把真错误也软化）。
"""

from __future__ import annotations

import json

import pytest

from evoflow.tools.zcode_port import task_tools


class _FakeTask:
    def __init__(self, task_id: str, status: str, output_path=None):
        self.task_id = task_id
        self.status = status
        self.output_path = output_path
        self.command = "sleep 1"


@pytest.mark.parametrize("finished_status", ["completed", "failed", "cancelled"])
def test_stopping_finished_task_is_not_an_error(monkeypatch, finished_status: str) -> None:
    """已结束的任务：不得以 Error 开头，要说明已达成并带上状态。"""
    monkeypatch.setattr(
        task_tools, "get_task", lambda tid: _FakeTask(tid, finished_status)
    )

    out = task_tools.task_stop_tool.func(task_id="abc123")
    assert not out.startswith("Error"), f"已结束不是错误，实际输出：{out}"

    payload = json.loads(out)
    assert payload["already_finished"] is True
    assert payload["stopped"] is False
    assert payload["task_id"] == "abc123"
    assert payload["status"] == finished_status
    assert "目标已达成" in payload["message"]


def test_failed_task_points_at_output(monkeypatch) -> None:
    """失败结束的任务要额外指一句「去看 output」，而不是只说已结束。"""
    monkeypatch.setattr(task_tools, "get_task", lambda tid: _FakeTask(tid, "failed"))
    payload = json.loads(task_tools.task_stop_tool.func(task_id="abc123"))
    assert "失败" in payload["message"]
    assert "output" in payload["message"]


def test_running_task_still_reports_success(monkeypatch) -> None:
    """反证：真在跑的任务走原路径，返回 stopped=True。"""
    monkeypatch.setattr(task_tools, "get_task", lambda tid: _FakeTask(tid, "running"))
    monkeypatch.setattr(
        task_tools, "stop_task", lambda tid: _FakeTask(tid, "stopped")
    )
    monkeypatch.setattr(task_tools.time, "sleep", lambda _s: None)

    payload = json.loads(task_tools.task_stop_tool.func(task_id="abc123"))
    assert payload["message"].startswith("Successfully stopped")


def test_missing_task_id_is_still_an_error() -> None:
    """反证：参数缺失仍是错误（别把所有分支都软化）。"""
    assert task_tools.task_stop_tool.func().startswith("Error: Missing required parameter")


def test_unknown_task_id_is_still_an_error(monkeypatch) -> None:
    """反证：任务不存在仍是错误（与「已结束」是两回事）。"""
    monkeypatch.setattr(task_tools, "get_task", lambda tid: None)
    out = task_tools.task_stop_tool.func(task_id="nope")
    assert out.startswith("Error: No task found")


# ── 「注册表里查不到」的两种成因必须分开（第58轮）────────────────────────


def _fake_bg_dir(tmp_path, monkeypatch, task_id: str, content: str = "hello from bg") -> None:
    """造一个后台任务输出目录，并让 TEMP 指向它（与 bash_tool.py 的推导一致）。"""
    root = tmp_path / "evoflow-bash-tasks"
    root.mkdir(parents=True, exist_ok=True)
    (root / f"{task_id}.output").write_text(content, encoding="utf-8")
    monkeypatch.setenv("TEMP", str(tmp_path))
    monkeypatch.setenv("TMP", str(tmp_path))


def test_registry_missing_but_output_exists_is_not_an_error(tmp_path, monkeypatch) -> None:
    """重启清空了进程内 `_TASKS`，但输出文件还在 —— 这不是错误。

    现网实证：2026-11-18 23:19:31（23:18:36 重启后第一分钟），
    同一个 id 在重启前还能查到 status=completed，重启后变成「No task found」。
    旧实现把它报成 `Error:`，模型据此以为喊停失败、回头重试，白绕一轮。
    """
    task_id = "5eac7434c5ed"
    _fake_bg_dir(tmp_path, monkeypatch, task_id)
    monkeypatch.setattr(task_tools, "get_task", lambda tid: None)

    out = task_tools.task_stop_tool.func(task_id=task_id)
    assert not out.startswith("Error"), f"有输出文件说明它跑过，不该报错：{out}"
    payload = json.loads(out)
    assert payload["already_finished"] is True
    assert payload["registry_missing"] is True
    assert payload["stopped"] is False
    assert payload["output"] == "hello from bg"
    assert "重启" in payload["message"], "必须点明重启会清空任务表，否则模型猜不到原因"


def test_registry_missing_and_no_output_is_still_an_error(tmp_path, monkeypatch) -> None:
    """反证：真打错了 id（盘上没有输出文件）仍必须是 Error。"""
    (tmp_path / "evoflow-bash-tasks").mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("TEMP", str(tmp_path))
    monkeypatch.setenv("TMP", str(tmp_path))
    monkeypatch.setattr(task_tools, "get_task", lambda tid: None)

    out = task_tools.task_stop_tool.func(task_id="deadbeef9999")
    assert out.startswith("Error: No task found"), f"没有输出文件就是真找不到：{out}"


def test_registry_missing_rejects_path_traversal(tmp_path, monkeypatch) -> None:
    """id 里带路径分隔符时不得拼进文件系统路径（探测是增益，不是新攻击面）。"""
    (tmp_path / "evoflow-bash-tasks").mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("TEMP", str(tmp_path))
    monkeypatch.setattr(task_tools, "get_task", lambda tid: None)

    out = task_tools.task_stop_tool.func(task_id="../../secret")
    assert out.startswith("Error: No task found")
