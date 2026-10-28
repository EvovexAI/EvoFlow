"""协作待闭环：claim-before-send，并行下游结案不得双发飞书。"""

from __future__ import annotations

import os
import tempfile
import threading
from pathlib import Path
from unittest.mock import MagicMock

import pytest


def test_claim_tree_receipt_slot_second_loses(monkeypatch: pytest.MonkeyPatch) -> None:
    from evoflow.collab import upstream_receipt as ur

    task = {"id": "root1", "name": "demo", "status": "awaiting_close"}
    project = {"id": "p1", "tasks": [task]}
    store = MagicMock()
    store.save_project.return_value = True

    monkeypatch.setattr("evoflow.collab.storage.get_project_storage", lambda: store)
    monkeypatch.setattr(
        "evoflow.collab.storage.find_main_task",
        lambda *_a, **_k: (project, task),
    )
    monkeypatch.setattr(
        "evoflow.collab.storage.main_task_mutation_lock",
        lambda _mid: MagicMock(__enter__=lambda s: s, __exit__=lambda *a: False),
    )
    monkeypatch.setattr(
        "evoflow.persistence.channel_push_repositories.tree_receipt_outbound_exists",
        lambda *_a, **_k: False,
    )

    ok1, row1 = ur.claim_tree_receipt_slot("root1")
    assert ok1 is True
    assert str(row1.get("tree_receipt_pushed_at") or "")
    assert str(task.get("tree_receipt_pushed_at") or "")

    ok2, _row2 = ur.claim_tree_receipt_slot("root1")
    assert ok2 is False
    assert store.save_project.call_count == 1


class TestTreeReceiptPushLogClaim:
    @classmethod
    def setup_class(cls) -> None:
        cls._tmpdir = tempfile.TemporaryDirectory()
        cls.db_path = str(Path(cls._tmpdir.name) / "evoflow.db")
        cls._previous_db_env = os.environ.get("EVOFLOW_DB_PATH")
        os.environ["EVOFLOW_DB_PATH"] = cls.db_path
        import evoflow.persistence.db as db_mod

        db_mod.reset_db_for_tests()

    @classmethod
    def teardown_class(cls) -> None:
        import evoflow.persistence.db as db_mod

        db_mod.reset_db_for_tests()
        if cls._previous_db_env is None:
            os.environ.pop("EVOFLOW_DB_PATH", None)
        else:
            os.environ["EVOFLOW_DB_PATH"] = cls._previous_db_env
        cls._tmpdir.cleanup()

    def setup_method(self) -> None:
        import evoflow.persistence.db as db_mod
        from evoflow.persistence.schema import ensure_app_schema

        db_mod.reset_db_for_tests()
        conn = db_mod.get_db()
        ensure_app_schema(conn)

    def test_try_claim_second_is_none(self) -> None:
        from evoflow.persistence import channel_push_repositories as cpl

        first = cpl.try_claim_tree_receipt("2610280217_e6db")
        second = cpl.try_claim_tree_receipt("2610280217_e6db")
        assert first and first.startswith("push_")
        assert second is None
        assert cpl.tree_receipt_outbound_exists("2610280217_e6db") is True

        cpl.finalize_tree_receipt_claim(
            first,
            ok=True,
            receive_id="oc_test",
            receive_id_type="chat_id",
            sender_account_id="xiaomi",
            content_summary="协作待闭环",
        )
        assert cpl.tree_receipt_outbound_exists("2610280217_e6db", statuses=("ok",)) is True
        assert cpl.try_claim_tree_receipt("2610280217_e6db") is None

    def test_release_allows_retry(self) -> None:
        from evoflow.persistence import channel_push_repositories as cpl

        pid = cpl.try_claim_tree_receipt("root_retry")
        assert pid
        cpl.release_tree_receipt_claim(pid, error="boom")
        assert cpl.tree_receipt_outbound_exists("root_retry") is False
        again = cpl.try_claim_tree_receipt("root_retry")
        assert again and again != pid


def test_maybe_push_skips_when_slot_taken(monkeypatch: pytest.MonkeyPatch) -> None:
    from evoflow.collab import upstream_receipt as ur

    root = {"id": "root1", "name": "demo", "raised_by": "user", "summary": "done"}
    child = {
        "id": "c1",
        "assigned_to": "dev-frontend",
        "parent_task_id": "root1",
        "status": "completed",
    }
    parent = {"id": "root1", "assigned_to": "dev-tech-director", "status": "awaiting_close"}

    monkeypatch.setattr(ur, "find_root_task_row", lambda _t: root)
    monkeypatch.setattr(
        ur,
        "tree_descendants_all_terminal",
        lambda _rid: {
            "total": 2,
            "done": 2,
            "open": 0,
            "all_done": True,
            "open_rows": [],
            "rows": [],
        },
    )
    monkeypatch.setattr(ur, "claim_tree_receipt_slot", lambda _rid: (False, root))

    sent: list[dict] = []

    async def _fake_push(**kwargs):
        sent.append(kwargs)
        return "tree_receipt:root1"

    monkeypatch.setattr(
        "evoflow.proactive.feishu_notify.push_collab_tree_receipt",
        _fake_push,
    )

    out = ur.maybe_push_tree_receipt_feishu(child=child, parent=parent, all_siblings_done=True)
    assert out and out.get("skipped") is True
    assert out.get("reason") == "already_pushed"
    assert sent == []


def test_maybe_push_claims_once_under_parallel(monkeypatch: pytest.MonkeyPatch) -> None:
    """Two sibling completions: only one Feishu send."""
    from evoflow.collab import upstream_receipt as ur

    root = {"id": "root1", "name": "demo", "raised_by": "user", "summary": "done"}
    lock = threading.Lock()
    claimed = {"n": 0}

    def _claim(_rid: str):
        with lock:
            if claimed["n"] >= 1:
                return False, root
            claimed["n"] += 1
            root["tree_receipt_pushed_at"] = "2026-10-28T00:00:00Z"
            return True, root

    monkeypatch.setattr(ur, "find_root_task_row", lambda _t: dict(root))
    monkeypatch.setattr(
        ur,
        "tree_descendants_all_terminal",
        lambda _rid: {
            "total": 2,
            "done": 2,
            "open": 0,
            "all_done": True,
            "open_rows": [],
            "rows": [],
        },
    )
    monkeypatch.setattr(ur, "claim_tree_receipt_slot", _claim)
    monkeypatch.setattr(
        "evoflow.persistence.channel_push_repositories.try_claim_tree_receipt",
        lambda *_a, **_k: "push_claim_1",
    )
    monkeypatch.setattr(
        "evoflow.persistence.channel_push_repositories.tree_receipt_outbound_exists",
        lambda *_a, **_k: False,
    )

    sent: list[str] = []
    send_lock = threading.Lock()

    async def _fake_push(**kwargs):
        with send_lock:
            sent.append(str(kwargs.get("child_task_id") or ""))
        return "tree_receipt:root1"

    monkeypatch.setattr("evoflow.proactive.feishu_notify.push_collab_tree_receipt", _fake_push)

    results: list[dict | None] = [None, None]

    def _run(idx: int, child_id: str) -> None:
        child = {
            "id": child_id,
            "assigned_to": "dev",
            "parent_task_id": "root1",
            "status": "completed",
        }
        parent = {"id": "root1", "assigned_to": "lead", "status": "awaiting_close"}
        results[idx] = ur.maybe_push_tree_receipt_feishu(
            child=child, parent=parent, all_siblings_done=True
        )

    t0 = threading.Thread(target=_run, args=(0, "c_a"))
    t1 = threading.Thread(target=_run, args=(1, "c_b"))
    t0.start()
    t1.start()
    t0.join(timeout=5)
    t1.join(timeout=5)

    assert len(sent) == 1
    skipped = [r for r in results if r and r.get("skipped")]
    ok = [r for r in results if r and r.get("ok") and not r.get("skipped")]
    assert len(ok) == 1
    assert len(skipped) == 1
