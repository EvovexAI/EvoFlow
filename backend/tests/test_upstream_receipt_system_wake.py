"""Downstream receipt must wake orchestrator as platform ``system``.

Regression: wake used child assignee as from_agent → org denied 下级→上级,
then still stamped upstream_receipt_at so the failure never retried.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest


def test_validate_dispatch_allows_system_to_any_role() -> None:
    from evoflow.proactive.runner import validate_dispatch_org_relationship

    err = validate_dispatch_org_relationship(
        from_agent="system",
        target_code="dev-tech-director",
        roster=[],
    )
    assert err is None


def test_notify_wakes_as_system_and_stamps_on_ok(monkeypatch: pytest.MonkeyPatch) -> None:
    from evoflow.collab import upstream_receipt as ur

    child = {
        "id": "c1",
        "task_id": "c1",
        "assigned_to": "dev-frontend",
        "parent_task_id": "p1",
        "name": "前端",
        "status": "completed",
    }
    parent = {
        "id": "p1",
        "task_id": "p1",
        "assigned_to": "dev-tech-director",
        "raised_by": "user",
        "status": "awaiting_close",
    }
    store = MagicMock()
    patches: list[tuple[str, dict]] = []
    wakes: list[dict] = []

    monkeypatch.setattr("evoflow.collab.storage.get_project_storage", lambda: store)
    monkeypatch.setattr(
        "evoflow.collab.storage.find_main_task",
        lambda *_a, **_k: ({"id": "proj"}, parent),
    )
    monkeypatch.setattr(ur, "sibling_rollup", lambda _pid: {"done": 1, "total": 1, "all_done": True, "done_rows": [{"task_id": "c1"}], "open_rows": []})
    monkeypatch.setattr(ur, "maybe_push_tree_receipt_feishu", lambda **_k: None)

    def _patch(_storage, tid, fields):
        patches.append((tid, dict(fields)))
        return True

    monkeypatch.setattr(
        "evoflow.collab.storage.patch_collab_main_task_in_project_storage",
        _patch,
    )

    class _Emp:
        @staticmethod
        def wake(code, *, goal, from_agent, description, source, task_id, skip_done_guard):
            wakes.append(
                {
                    "code": code,
                    "from_agent": from_agent,
                    "task_id": task_id,
                    "skip_done_guard": skip_done_guard,
                }
            )
            return {"ok": True, "dispatched": True}

    monkeypatch.setattr("evoflow.admin.employees", _Emp, raising=False)
    import evoflow.admin.employees as emp_mod

    monkeypatch.setattr(emp_mod, "wake", _Emp.wake)

    out = ur.notify_upstream_on_child_terminal(child, terminal_status="completed")
    assert out and out.get("ok") is True
    assert wakes and wakes[0]["from_agent"] == "user"
    assert wakes[0]["code"] == "dev-tech-director"
    assert any("upstream_receipt_at" in (f or {}) for _tid, f in patches if _tid == "c1")


def test_notify_skips_wake_when_child_already_chained(monkeypatch: pytest.MonkeyPatch) -> None:
    """Peer handoff already dispatched → do not wake manager as messenger."""
    from evoflow.collab import upstream_receipt as ur

    child = {
        "id": "c3",
        "assigned_to": "dev-backend",
        "parent_task_id": "p1",
        "name": "全栈",
        "status": "completed",
        "handlers_dispatched_at": "2026-10-28T12:37:07+08:00",
        "handlers_dispatched": [{"agent_code": "dev-qa", "task_id": "qa1", "ok": True}],
    }
    parent = {
        "id": "p1",
        "assigned_to": "dev-tech-director",
        "raised_by": "user",
        "status": "awaiting_close",
    }
    wakes: list[dict] = []
    patches: list[tuple[str, dict]] = []

    monkeypatch.setattr("evoflow.collab.storage.get_project_storage", lambda: MagicMock())
    monkeypatch.setattr(
        "evoflow.collab.storage.find_main_task",
        lambda *_a, **_k: ({"id": "proj"}, parent),
    )
    monkeypatch.setattr(
        ur,
        "sibling_rollup",
        lambda _pid: {
            "done": 1,
            "total": 1,
            "all_done": True,
            "done_rows": [{"task_id": "c3"}],
            "open_rows": [],
        },
    )
    monkeypatch.setattr(ur, "maybe_push_tree_receipt_feishu", lambda **_k: None)
    monkeypatch.setattr(
        "evoflow.collab.storage.patch_collab_main_task_in_project_storage",
        lambda _s, tid, fields: patches.append((tid, dict(fields))) or True,
    )
    import evoflow.admin.employees as emp_mod

    monkeypatch.setattr(
        emp_mod,
        "wake",
        lambda *_a, **_k: wakes.append({"hit": True}) or {"ok": True},
    )

    out = ur.notify_upstream_on_child_terminal(child, terminal_status="completed")
    assert out and out.get("ok") is True
    assert out.get("targets") == []
    assert out.get("skipped_wake_already_chained") is True
    assert wakes == []
    assert any("upstream_receipt_at" in (f or {}) for _tid, f in patches if _tid == "c3")


def test_notify_does_not_stamp_when_wake_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    from evoflow.collab import upstream_receipt as ur

    child = {
        "id": "c2",
        "assigned_to": "dev-backend",
        "parent_task_id": "p1",
        "name": "后端",
        "status": "completed",
    }
    parent = {
        "id": "p1",
        "assigned_to": "dev-tech-director",
        "raised_by": "user",
        "status": "awaiting_close",
    }
    patches: list[tuple[str, dict]] = []

    monkeypatch.setattr("evoflow.collab.storage.get_project_storage", lambda: MagicMock())
    monkeypatch.setattr(
        "evoflow.collab.storage.find_main_task",
        lambda *_a, **_k: ({"id": "proj"}, parent),
    )
    monkeypatch.setattr(ur, "sibling_rollup", lambda _pid: {"done": 1, "total": 2, "all_done": False, "done_rows": [{"task_id": "c2"}], "open_rows": []})
    monkeypatch.setattr(ur, "maybe_push_tree_receipt_feishu", lambda **_k: None)
    monkeypatch.setattr(
        "evoflow.collab.storage.patch_collab_main_task_in_project_storage",
        lambda _s, tid, fields: patches.append((tid, dict(fields))) or True,
    )

    import evoflow.admin.employees as emp_mod

    monkeypatch.setattr(
        emp_mod,
        "wake",
        lambda *_a, **_k: {"ok": False, "org_denied": True, "error": "下级不能向上级派发"},
    )

    out = ur.notify_upstream_on_child_terminal(child, terminal_status="completed")
    assert out is not None
    assert out.get("ok") is False
    assert out.get("retried_safe") is True
    assert not any("upstream_receipt_at" in (f or {}) for _tid, f in patches)
