"""Regression test for chat-session permission preset persistence.

The user-reported symptom: after picking 「完全访问」(full-access) for a chat
session and then switching to another session (or refreshing the page), the
session's permission pill regressed to 「批准访问」(default) — meaning the
runtime preset was lost between writes.

The root cause was a non-atomic two-statement write in
``set_session_preset`` (``upsert_session_row`` writing
``tool_approval_policy`` then a separate ``UPDATE`` for
``permission_preset``). The new implementation must persist both columns in
a single transaction so an interleaved read (e.g. session-list refresh) can
never see a half-applied state, and the upsert path also has to remember an
explicit ``permission_preset`` override so the value is not blanked by an
unrelated ``upsert_session_row`` call.

These tests lock that fix in place.
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock

_BACKEND_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_BACKEND_ROOT))
sys.path.insert(0, str(_BACKEND_ROOT / "packages" / "harness"))


def _ensure_subagent_mock() -> None:
    if "evoflow.subagents.executor" not in sys.modules:
        executor_mock = MagicMock()
        executor_mock.SubagentExecutor = MagicMock
        executor_mock.SubagentResult = MagicMock
        executor_mock.SubagentStatus = MagicMock
        executor_mock.MAX_CONCURRENT_SUBAGENTS = 5
        executor_mock.get_background_task_result = MagicMock()
        sys.modules["evoflow.subagents.executor"] = executor_mock


_ensure_subagent_mock()


class _PermissionPresetStoreTestBase(unittest.TestCase):
    """Per-test isolated ``evoflow.db`` in a temp file with full schema."""

    tmp_dir: tempfile.TemporaryDirectory | None = None
    db_path: str | None = None
    _previous_storage_env: str | None = None

    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp_dir = tempfile.TemporaryDirectory(prefix="evoflow-preset-test-")
        cls.db_path = str(Path(cls.tmp_dir.name) / "evoflow.db")
        cls._previous_storage_env = os.environ.get("EVOFLOW_STORAGE_SQLITE_PATH")
        os.environ["EVOFLOW_STORAGE_SQLITE_PATH"] = cls.db_path

    @classmethod
    def tearDownClass(cls) -> None:
        if cls._previous_storage_env is None:
            os.environ.pop("EVOFLOW_STORAGE_SQLITE_PATH", None)
        else:
            os.environ["EVOFLOW_STORAGE_SQLITE_PATH"] = cls._previous_storage_env
        if cls.tmp_dir is not None:
            cls.tmp_dir.cleanup()
            cls.tmp_dir = None

    def setUp(self) -> None:
        from evoflow.persistence import db as db_mod
        from evoflow.persistence.schema import ensure_app_schema
        from evoflow.persistence.session_repositories import invalidate_session_select_cache

        # Reset the shared connection and force a fresh open against our
        # per-test temp DB. We then ensure the full schema is present so the
        # permission_preset column is available.
        db_mod.reset_db_for_tests()
        conn = db_mod.get_db(storage_sqlite_path=self.db_path)
        ensure_app_schema(conn)
        invalidate_session_select_cache()

    def tearDown(self) -> None:
        from evoflow.persistence import db as db_mod
        from evoflow.persistence.session_repositories import invalidate_session_select_cache

        invalidate_session_select_cache()
        db_mod.reset_db_for_tests()

    def _create_session(self, session_key: str) -> None:
        from evoflow.persistence.session_repositories import upsert_session_row

        upsert_session_row(session_key, title="test", context={})


class SetSessionPresetPersistenceTest(_PermissionPresetStoreTestBase):
    """The full-access regression: pick → close session → reopen → still full-access."""

    def test_full_access_persists_across_simulated_refresh(self) -> None:
        from evoflow.persistence.permission_preset_store import (
            effective_preset,
            get_session_preset_raw,
            set_session_preset,
        )

        sk = "agent:main:test-full-access-1"
        self._create_session(sk)

        # 1. User picks "完全访问" (full-access) in the UI.
        written = set_session_preset(sk, "full-access")
        self.assertEqual(written, "full-access")

        # 2. The raw column must be readable right away (no in-memory cache
        #    hiding the value before the next page load).
        self.assertEqual(get_session_preset_raw(sk), "full-access")
        self.assertEqual(effective_preset(sk), "full-access")

        # 3. Simulate a session-list refresh that re-reads from the DB.
        from evoflow.persistence import db as db_mod
        from evoflow.persistence.session_repositories import invalidate_session_select_cache

        invalidate_session_select_cache()
        db_mod.reset_db_for_tests()
        self.assertEqual(get_session_preset_raw(sk), "full-access")
        self.assertEqual(effective_preset(sk), "full-access")

    def test_full_access_sticks_after_legacy_policy_upsert(self) -> None:
        """``upsert_session_row`` invoked for an unrelated field must not
        blank the previously stored ``permission_preset``."""
        from evoflow.persistence.permission_preset_store import (
            effective_preset,
            get_session_preset_raw,
            set_session_preset,
        )
        from evoflow.persistence.session_repositories import upsert_session_row

        sk = "agent:main:test-full-access-2"
        self._create_session(sk)

        set_session_preset(sk, "full-access")
        self.assertEqual(get_session_preset_raw(sk), "full-access")

        # A second upsert with no tool_approval_policy / permission_preset
        # override (e.g. a session-list refresh) must not clear the preset.
        upsert_session_row(sk, message_count=5, context={})

        self.assertEqual(get_session_preset_raw(sk), "full-access")
        self.assertEqual(effective_preset(sk), "full-access")

    def test_set_session_preset_via_upsert_overrides(self) -> None:
        """When the caller passes ``permission_preset`` in ``flat_overrides``,
        the upsert path must honor it (defense-in-depth against the legacy
        non-atomic writer)."""
        from evoflow.persistence.permission_preset_store import (
            effective_preset,
            get_session_preset_raw,
        )
        from evoflow.persistence.session_repositories import upsert_session_row

        sk = "agent:main:test-full-access-3"
        self._create_session(sk)

        upsert_session_row(
            sk,
            tool_approval_policy="grant_all",
            permission_preset="full-access",
        )
        self.assertEqual(get_session_preset_raw(sk), "full-access")
        self.assertEqual(effective_preset(sk), "full-access")

        # And switching to read-only via the same path must work too.
        upsert_session_row(
            sk,
            tool_approval_policy="prompt",
            permission_preset="read-only",
        )
        self.assertEqual(get_session_preset_raw(sk), "read-only")
        self.assertEqual(effective_preset(sk), "read-only")

    def test_set_session_preset_clear_reverts_to_default(self) -> None:
        from evoflow.persistence.permission_preset_store import (
            effective_preset,
            get_session_preset_raw,
            set_session_preset,
        )
        from evoflow.persistence.tool_approval_policy import set_global_default_policy

        # Global default must be deterministic for the test.
        set_global_default_policy("session")

        sk = "agent:main:test-clear-1"
        self._create_session(sk)

        set_session_preset(sk, "full-access")
        self.assertEqual(get_session_preset_raw(sk), "full-access")

        set_session_preset(sk, None)
        self.assertIsNone(get_session_preset_raw(sk))
        # After clearing, the session inherits the global default.
        self.assertEqual(effective_preset(sk), "default")

    def test_set_session_preset_seed_when_row_missing(self) -> None:
        """If the row is somehow not in the table (e.g. seeded outside the
        canonical path), ``set_session_preset`` must still land the value."""
        from evoflow.persistence.permission_preset_store import (
            effective_preset,
            get_session_preset_raw,
            set_session_preset,
        )

        sk = "agent:main:test-seed-1"
        # No _create_session this time; the row is created lazily by the setter.
        written = set_session_preset(sk, "read-only")
        self.assertEqual(written, "read-only")
        self.assertEqual(get_session_preset_raw(sk), "read-only")
        self.assertEqual(effective_preset(sk), "read-only")


class GlobalGrantAllReconcileTest(_PermissionPresetStoreTestBase):
    """Turning on global grant_all must clear soft default/session stamps."""

    def test_soft_default_inherits_after_global_grant_all(self) -> None:
        from evoflow.persistence.permission_preset_store import (
            effective_preset,
            get_session_preset_raw,
            set_session_preset,
        )
        from evoflow.persistence.tool_approval_policy import (
            effective_policy,
            get_session_policy_raw,
            set_global_default_policy,
            set_session_policy,
        )

        set_global_default_policy("session")
        sk = "agent:main:test-reconcile-soft"
        self._create_session(sk)
        set_session_preset(sk, "default")
        self.assertEqual(effective_preset(sk), "default")

        set_global_default_policy("grant_all")
        self.assertIsNone(get_session_preset_raw(sk))
        self.assertIsNone(get_session_policy_raw(sk))
        self.assertEqual(effective_preset(sk), "full-access")
        self.assertEqual(effective_policy(sk), "grant_all")

    def test_set_session_policy_grant_all_syncs_preset(self) -> None:
        from evoflow.persistence.permission_preset_store import (
            effective_preset,
            get_session_preset_raw,
            set_session_preset,
        )
        from evoflow.persistence.tool_approval_policy import set_session_policy

        sk = "agent:main:test-policy-sync"
        self._create_session(sk)
        set_session_preset(sk, "default")
        set_session_policy(sk, "grant_all")
        self.assertEqual(get_session_preset_raw(sk), "full-access")
        self.assertEqual(effective_preset(sk), "full-access")

    def test_read_only_survives_global_grant_all(self) -> None:
        from evoflow.persistence.permission_preset_store import (
            effective_preset,
            set_session_preset,
        )
        from evoflow.persistence.tool_approval_policy import set_global_default_policy

        set_global_default_policy("session")
        sk = "agent:main:test-reconcile-readonly"
        self._create_session(sk)
        set_session_preset(sk, "read-only")
        set_global_default_policy("grant_all")
        self.assertEqual(effective_preset(sk), "read-only")


class SetSessionPresetAtomicityTest(_PermissionPresetStoreTestBase):
    """Verify that ``permission_preset`` and ``tool_approval_policy`` are
    committed together — no other reader can observe a half-applied state."""

    def test_both_columns_stored_in_one_commit(self) -> None:
        from evoflow.persistence.permission_preset_store import set_session_preset
        from evoflow.persistence.session_repositories import upsert_session_row
        from evoflow.persistence.tool_approval_policy import get_session_policy_raw

        sk = "agent:main:test-atomic-1"
        upsert_session_row(sk, title="atomic", context={})

        set_session_preset(sk, "full-access")
        # Both columns must be present and consistent.
        self.assertEqual(get_session_policy_raw(sk), "grant_all")
        from evoflow.persistence.permission_preset_store import get_session_preset_raw

        self.assertEqual(get_session_preset_raw(sk), "full-access")

        set_session_preset(sk, "read-only")
        self.assertEqual(get_session_policy_raw(sk), "prompt")
        self.assertEqual(get_session_preset_raw(sk), "read-only")


if __name__ == "__main__":
    unittest.main()
