"""Test dispatch idempotency fix v2.

Verify that duplicate dispatches do NOT produce duplicate Tasks.
Uses the existing find_open_work_item_by_title logic to check if a task
with the same title and assignee already exists before creating a new one.
"""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

# Ensure evoflow is importable
_backend = Path(__file__).resolve().parents[1] / "backend" / "packages" / "harness"
if str(_backend) not in sys.path:
    sys.path.insert(0, str(_backend))

from evoflow.proactive.work_items import find_open_work_item_by_title


def test_dispatch_idempotency_same_assignee_same_title():
    """Same assignee + same title should reuse existing open task."""
    storage = MagicMock()
    storage.list_projects.return_value = [{"id": "p1"}]
    storage.load_project.return_value = {
        "id": "p1",
        "tasks": [
            {
                "id": "task_existing",
                "name": "测试 dispatch 幂等性修复v2",
                "assigned_to": "code-agent",
                "status": "pending",
                "progress": 0,
                "updated_at": "2026-08-15T00:00:00Z",
            },
        ],
    }
    with patch("evoflow.collab.storage.get_project_storage", return_value=storage):
        tid = find_open_work_item_by_title("code-agent", "测试 dispatch 幂等性修复v2")
    
    # Should return the existing task id, not None
    assert tid == "task_existing", f"Expected 'task_existing', got '{tid}'"
    print("✓ Test passed: Duplicate dispatch reuses existing task (same assignee)")


def test_dispatch_idempotency_different_assignee():
    """Different assignee + same title should NOT reuse (cross-assignee fan-out)."""
    storage = MagicMock()
    storage.list_projects.return_value = [{"id": "p1"}]
    storage.load_project.return_value = {
        "id": "p1",
        "tasks": [
            {
                "id": "task_fe",
                "name": "测试 dispatch 幂等性修复v2",
                "assigned_to": "fe-dev",
                "status": "pending",
                "progress": 0,
                "updated_at": "2026-08-15T00:00:00Z",
            },
        ],
    }
    with patch("evoflow.collab.storage.get_project_storage", return_value=storage):
        tid = find_open_work_item_by_title("code-agent", "测试 dispatch 幂等性修复v2")
    
    # Should return None because assignee is different
    assert tid is None, f"Expected None for different assignee, got '{tid}'"
    print("✓ Test passed: Different assignee does not reuse task (cross-assignee fan-out)")


def test_dispatch_idempotency_completed_task_not_reused():
    """Completed task should NOT be reused even with same title/assignee."""
    storage = MagicMock()
    storage.list_projects.return_value = [{"id": "p1"}]
    storage.load_project.return_value = {
        "id": "p1",
        "tasks": [
            {
                "id": "task_done",
                "name": "测试 dispatch 幂等性修复v2",
                "assigned_to": "code-agent",
                "status": "completed",
                "progress": 100,
                "updated_at": "2026-08-15T00:00:00Z",
            },
        ],
    }
    with patch("evoflow.collab.storage.get_project_storage", return_value=storage):
        tid = find_open_work_item_by_title("code-agent", "测试 dispatch 幂等性修复v2")
    
    # Should return None because task is completed
    assert tid is None, f"Expected None for completed task, got '{tid}'"
    print("✓ Test passed: Completed task is not reused")


def test_dispatch_idempotency_executing_task_reused():
    """Executing task should be reused (not create duplicate)."""
    storage = MagicMock()
    storage.list_projects.return_value = [{"id": "p1"}]
    storage.load_project.return_value = {
        "id": "p1",
        "tasks": [
            {
                "id": "task_running",
                "name": "测试 dispatch 幂等性修复v2",
                "assigned_to": "code-agent",
                "status": "executing",
                "progress": 10,
                "updated_at": "2026-08-15T00:00:00Z",
            },
        ],
    }
    with patch("evoflow.collab.storage.get_project_storage", return_value=storage):
        tid = find_open_work_item_by_title("code-agent", "测试 dispatch 幂等性修复v2")
    
    # Should return the executing task id
    assert tid == "task_running", f"Expected 'task_running', got '{tid}'"
    print("✓ Test passed: Executing task is reused (no duplicate)")


if __name__ == "__main__":
    print("Running dispatch idempotency tests...\n")
    
    try:
        test_dispatch_idempotency_same_assignee_same_title()
        test_dispatch_idempotency_different_assignee()
        test_dispatch_idempotency_completed_task_not_reused()
        test_dispatch_idempotency_executing_task_reused()
        
        print("\n✅ All tests passed! Dispatch idempotency fix v2 is working correctly.")
        print("   - Same assignee + same title → reuses existing task")
        print("   - Different assignee → creates new task (fan-out)")
        print("   - Completed task → not reused")
        print("   - Executing task → reused (no duplicate)")
    except AssertionError as e:
        print(f"\n❌ Test failed: {e}")
        sys.exit(1)
    except Exception as e:
        print(f"\n❌ Unexpected error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
