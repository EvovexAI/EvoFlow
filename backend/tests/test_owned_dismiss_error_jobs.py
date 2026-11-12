"""「一键清理失效任务」must clear terminal error ledger rows for one KB."""

from __future__ import annotations

from pathlib import Path

import pytest


@pytest.fixture()
def owned_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    root = tmp_path / "knowledge"
    root.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("EVOFLOW_KNOWLEDGE_ROOT", str(root))
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path))
    monkeypatch.setenv("EVOFLOW_OWNED_KB_WORKER", "0")
    from evoflow.knowledge.owned.db import reset_db_state_for_tests
    from evoflow.knowledge.owned.worker import stop_owned_kb_worker_for_tests

    stop_owned_kb_worker_for_tests()
    reset_db_state_for_tests()
    yield root
    stop_owned_kb_worker_for_tests()
    reset_db_state_for_tests()


def test_dismiss_error_jobs_clears_ledger(owned_root: Path):
    from evoflow.knowledge.owned.db import db
    from evoflow.knowledge.owned.ids import new_id, utc_now
    from evoflow.knowledge.owned import jobs as owned_jobs

    kb_id = "kb_dismiss_err"
    other = "kb_other"
    now = utc_now()
    with db() as conn:
        for kid in (kb_id, other):
            conn.execute(
                """
                INSERT INTO kb_bases(
                  id, name, chunk_size, chunk_overlap, chunk_strategy,
                  embedding_mode, embedding_model, vector_enabled, keyword_enabled,
                  created_at, updated_at
                ) VALUES (?,?,512,80,'auto','cloud','m',1,1,?,?)
                """,
                (kid, kid, now, now),
            )
        for i in range(3):
            conn.execute(
                """
                INSERT INTO kb_jobs(
                  id, kb_id, doc_id, type, state, attempts, max_attempts, priority,
                  run_after, progress_json, error_message, locked_by, payload_json,
                  created_at, updated_at, finished_at
                ) VALUES (?,?,?,?, 'error', 3, 3, 100, ?, '{}', ?, '', '{}', ?, ?, ?)
                """,
                (
                    new_id("job_"),
                    kb_id,
                    f"doc_{i}",
                    "parse_index",
                    now,
                    "Embedding API rate limit (429): monthly usage quota exceeded",
                    now,
                    now,
                    now,
                ),
            )
        conn.execute(
            """
            INSERT INTO kb_jobs(
              id, kb_id, doc_id, type, state, attempts, max_attempts, priority,
              run_after, progress_json, error_message, locked_by, payload_json,
              created_at, updated_at, finished_at
            ) VALUES (?,?,?,?, 'error', 3, 3, 100, ?, '{}', ?, '', '{}', ?, ?, ?)
            """,
            (
                new_id("job_"),
                other,
                "doc_x",
                "parse_index",
                now,
                "other kb error",
                now,
                now,
                now,
            ),
        )

    n = owned_jobs.dismiss_error_jobs(kb_id, reason="cleared from ledger")
    assert n == 3

    stats = owned_jobs.job_stats(kb_id)
    assert stats["error"] == 0
    assert stats["errors"] == []

    other_stats = owned_jobs.job_stats(other)
    assert other_stats["error"] == 1


def test_purge_orphans_endpoint_dismisses_and_scopes(owned_root: Path):
    """Gateway helper path: orphans scoped + dismiss error rows."""
    from evoflow.knowledge.owned.db import db
    from evoflow.knowledge.owned.ids import new_id, utc_now
    from evoflow.knowledge.owned import jobs as owned_jobs
    from evoflow.knowledge.owned import service as owned_service

    kb_id = "kb_purge_btn"
    now = utc_now()
    with db() as conn:
        conn.execute(
            """
            INSERT INTO kb_bases(
              id, name, chunk_size, chunk_overlap, chunk_strategy,
              embedding_mode, embedding_model, vector_enabled, keyword_enabled,
              created_at, updated_at
            ) VALUES (?,?,512,80,'auto','cloud','m',1,1,?,?)
            """,
            (kb_id, kb_id, now, now),
        )
        conn.execute(
            """
            INSERT INTO kb_jobs(
              id, kb_id, doc_id, type, state, attempts, max_attempts, priority,
              run_after, progress_json, error_message, locked_by, payload_json,
              created_at, updated_at, finished_at
            ) VALUES (?,?,?,?, 'error', 3, 3, 100, ?, '{}', ?, '', '{}', ?, ?, ?)
            """,
            (
                new_id("job_"),
                kb_id,
                "doc_missing",
                "parse_index",
                now,
                "Embedding API rate limit (429): monthly usage quota exceeded",
                now,
                now,
                now,
            ),
        )

    orphans = owned_jobs.purge_failed_orphan_jobs(limit=50, kb_id=kb_id)
    dismissed = owned_jobs.dismiss_error_jobs(kb_id, limit=50)
    # No document row → orphan purge may cancel the error job first; either path ok.
    assert orphans + dismissed >= 1
    assert owned_jobs.job_stats(kb_id)["error"] == 0
    # Heal is a no-op without failed docs — just ensure it does not raise.
    heal = owned_service.requeue_embedding_failed_as_keyword(kb_id, limit=10)
    assert heal["ok"] is True
