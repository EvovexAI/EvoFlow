"""Unit tests for reindex progress parsing / job dict shape."""

from __future__ import annotations

from evoflow.knowledge.vault.reindex_jobs import ReindexJob, _PROGRESS_RE, _apply_progress_line


def test_progress_regex():
    m = _PROGRESS_RE.search("12/161 (7%) — 3s remaining")
    assert m is not None
    assert m.group(1) == "12"
    assert m.group(2) == "161"
    assert m.group(3) == "7"


def test_apply_progress_updates_job():
    job = ReindexJob(job_id="j1", vault_id="v1")
    _apply_progress_line(job, "40/200 (20%)")
    assert job.processed == 40
    assert job.total == 200
    assert job.percent == 20
    assert job.phase == "indexing"
    assert "40/200" in job.message


def test_job_to_dict_aliases():
    job = ReindexJob(job_id="abc", vault_id="docs", state="running", message="hi")
    data = job.to_dict()
    assert data["jobId"] == "abc"
    assert data["vaultId"] == "docs"
    assert data["state"] == "running"
    assert "job_id" not in data
