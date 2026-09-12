"""Plan markdown syncs subtasks on bind."""

from __future__ import annotations

from pathlib import Path

import pytest

from evoflow.collab.plan_session_task import bind_plan_markdown_to_thread_task
from evoflow.collab.plan_subtasks_sync import parse_plan_steps, resolve_step_assigned_to
from evoflow.collab.storage import ProjectStorage, find_main_task


class _FakePaths:
    def __init__(self, base_dir: Path):
        self.base_dir = base_dir

    def thread_dir(self, thread_id: str) -> Path:
        return self.base_dir / "threads" / thread_id


PLAN_MD = """# Plan

## Goal
Build demo

## Flowchart
```mermaid
flowchart TD
  START["开始"] --> S1["Step 1"]
```

## Steps

### Step 1: 准备环境
- **目标**: 初始化
- **输入物**: 用户需求
- **输出物**: `outputs/a.txt`
- **验收标准**: test -f outputs/a.txt
- **失败处理**: 重试
- **执行人**: general-purpose

### Step 2: 验收
- **目标**: 检查
- **输入物**: `outputs/a.txt`
- **输出物**: `outputs/report.md`
- **验收标准**: test -f outputs/report.md
- **失败处理**: 上报
- **执行人**: claude-code

## Validation
- 全部文件存在

## Open Questions
无
"""


@pytest.fixture
def plan_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    paths = _FakePaths(tmp_path / "home")
    storage = ProjectStorage(tmp_path / "bundles")
    monkeypatch.setattr("evoflow.collab.plan_session_task.get_paths", lambda: paths)
    monkeypatch.setattr("evoflow.collab.plan_session_task.get_project_storage", lambda: storage)
    monkeypatch.setattr("evoflow.collab.plan_subtasks_sync.get_project_storage", lambda: storage)
    monkeypatch.setattr("evoflow.collab.storage.get_project_storage", lambda: storage)
    monkeypatch.setattr("evoflow.config.paths.get_paths", lambda: paths)
    return {"paths": paths, "storage": storage, "thread_id": "Thread_plan_sync"}


def test_parse_plan_steps() -> None:
    steps = parse_plan_steps(PLAN_MD)
    assert len(steps) == 2
    assert steps[0]["ref"] == "1"
    assert steps[0]["short_name"] == "准备环境"
    assert "初始化" in steps[0]["goal"]
    assert steps[0]["assignee"] == "general-purpose"
    assert steps[1]["assignee"] == "claude-code"
    assert resolve_step_assigned_to(steps[0]) == "general-purpose"
    assert resolve_step_assigned_to(steps[1]) == "claude-code"
    assert resolve_step_assigned_to({"assignee": ""}) == "general-purpose"
    assert resolve_step_assigned_to({"assignee": "无"}) == "general-purpose"


def test_bind_plan_creates_subtasks(plan_env) -> None:
    tid = plan_env["thread_id"]
    paths = plan_env["paths"]
    steps = parse_plan_steps(PLAN_MD)
    meta = bind_plan_markdown_to_thread_task(tid, PLAN_MD, paths=paths, structured_steps=steps)
    task_id = meta["task_id"]
    assert task_id
    sync = meta.get("subtasksSync") or {}
    assert sync.get("success") is True, sync.get("warnings")
    row = find_main_task(plan_env["storage"], task_id)
    assert row is not None
    subs = row[1].get("subtasks") or []
    assert len(subs) == 2, sync
    assert len(sync.get("created") or []) + len(sync.get("updated") or []) >= 2
    assert subs[0].get("ref") == "1"
    assert str(subs[0].get("name") or "").startswith("Step 1:")
    assert subs[0].get("assigned_to") == "general-purpose"
    assert subs[0].get("assigned_agent_name") == "通用助手"
    assert subs[1].get("assigned_to") == "claude-code"
    assert len(row[1].get("bound_plan_steps") or []) == 2
    assert (subs[0].get("worker_profile") or {}).get("base_subagent") == "general-purpose"
    assert (subs[1].get("worker_profile") or {}).get("base_subagent") == "claude-code"
    created = sync.get("created") or []
    assert created[0].get("assignedTo") == "general-purpose"
    assert created[0].get("assignedAgentName") == "通用助手"
    assert created[1].get("assignedTo") == "claude-code"


def test_parse_depends_and_parallel_warning() -> None:
    md = """## Steps

### Step 1: 任务1
- **目标**: 写 task1
- **输入物**: 用户需求
- **输出物**: outputs/task1.txt
- **验收标准**: ok
- **失败处理**: 重试

### Step 2: 并行任务2和3
- **目标**: 任务 2：写 task2。任务 3：写 task3。
- **输入物**: outputs/task1.txt
- **输出物**: outputs/task2.txt, outputs/task3.txt
- **验收标准**: ok
- **失败处理**: 上报
"""
    steps = parse_plan_steps(md)
    assert len(steps) == 2
    assert steps[1]["depends_refs"] == ["1"]

    md3 = """## Steps

### Step 1: 任务1
- **目标**: 写 task1
- **输入物**: 用户需求
- **输出物**: outputs/task1.txt
- **验收标准**: ok
- **失败处理**: 重试

### Step 2: 任务2
- **目标**: 写 task2
- **输入物**: outputs/task1.txt
- **输出物**: outputs/task2.txt
- **验收标准**: ok
- **失败处理**: 重试
- **依赖**: 1

### Step 3: 任务3
- **目标**: 写 task3
- **输入物**: outputs/task1.txt
- **输出物**: outputs/task3.txt
- **验收标准**: ok
- **失败处理**: 重试
- **依赖**: 1
"""
    steps3 = parse_plan_steps(md3)
    assert len(steps3) == 3
    assert steps3[1]["depends_refs"] == ["1"]
    assert steps3[2]["depends_refs"] == ["1"]


def test_infer_fan_out_depends_when_step3_omits_explicit_depends() -> None:
    md3 = """## Steps

### Step 1: 任务1
- **目标**: 写 task1
- **输入物**: 用户需求
- **输出物**: outputs/task1.txt
- **验收标准**: ok
- **失败处理**: 重试

### Step 2: 任务2
- **目标**: 写 task2
- **输入物**: outputs/task1.txt
- **输出物**: outputs/task2.txt
- **验收标准**: ok
- **失败处理**: 重试
- **依赖**: 1

### Step 3: 任务3
- **目标**: 写 task3
- **输入物**: outputs/task1.txt
- **输出物**: outputs/task3.txt
- **验收标准**: ok
- **失败处理**: 重试
"""
    steps3 = parse_plan_steps(md3)
    assert len(steps3) == 3
    assert steps3[2]["depends_refs"] == ["1"]


def test_structured_plan_infers_fan_out_without_step3_depends(plan_env) -> None:
    from evoflow.collab.plan_subtasks_sync import sync_subtasks_from_plan_steps
    from evoflow.collab.storage import find_main_task, new_project_bundle_root_task

    storage = plan_env["storage"]
    project, task = new_project_bundle_root_task("fan", "description long enough for test", thread_id=plan_env["thread_id"])
    task_id = str(task["id"])
    storage.save_project(project)

    steps = [
        {
            "ref": 1,
            "name": "任务1",
            "goal": "写 task1",
            "inputs": "用户需求",
            "outputs": "outputs/task1.txt",
            "assigned_agent": "general-purpose",
        },
        {
            "ref": 2,
            "name": "任务2",
            "goal": "写 task2",
            "inputs": "outputs/task1.txt",
            "outputs": "outputs/task2.txt",
            "assigned_agent": "general-purpose",
            "depends_on": ["1"],
        },
        {
            "ref": 3,
            "name": "任务3",
            "goal": "写 task3",
            "inputs": "outputs/task1.txt",
            "outputs": "outputs/task3.txt",
            "assigned_agent": "general-purpose",
        },
    ]
    sync = sync_subtasks_from_plan_steps(task_id, steps, storage=storage)
    assert sync["success"] is True

    row = find_main_task(storage, task_id)
    assert row is not None
    _proj, task = row
    subs = sorted(task["subtasks"], key=lambda s: int(str(s.get("ref") or "0")))
    id_by_ref = {str(s["ref"]): str(s["id"]) for s in subs}
    assert subs[2]["worker_profile"]["depends_on"] == [id_by_ref["1"]]


def test_bind_plan_revision_updates_subtasks(plan_env) -> None:
    tid = plan_env["thread_id"]
    paths = plan_env["paths"]
    meta = bind_plan_markdown_to_thread_task(
        tid,
        PLAN_MD,
        paths=paths,
        structured_steps=parse_plan_steps(PLAN_MD),
    )
    task_id = meta["task_id"]

    revised = PLAN_MD.replace("### Step 1: 准备环境", "### Step 1: 环境搭建")
    again = bind_plan_markdown_to_thread_task(
        tid,
        revised,
        paths=paths,
        structured_steps=parse_plan_steps(revised),
    )
    sync = again.get("subtasksSync") or {}
    assert sync.get("success") is True
    assert len(sync.get("updated") or []) >= 1

    row = find_main_task(plan_env["storage"], task_id)
    assert row is not None
    subs = row[1].get("subtasks") or []
    assert len(subs) == 2
    assert "环境搭建" in str(subs[0].get("name") or "")
