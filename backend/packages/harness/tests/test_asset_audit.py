"""Asset system self-audit — score + Markdown report.

Verifies:
- scoring is monotonic and well-bounded
- report file lands under memory/audit/
- broken refs and unreferenced files are surfaced
- user_id argument is honored
"""

from __future__ import annotations

from pathlib import Path

import pytest


def test_run_audit_writes_report(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from evoflow.assets import audit
    from evoflow.assets.paths import EntityRef, entity_root, sanitize_user_asset_id

    user_id = "audit_test_user"
    entity = EntityRef("user", sanitize_user_asset_id(user_id))
    root = entity_root(entity)

    # Pre-populate minimal healthy layout.
    (root / "memory").mkdir(parents=True, exist_ok=True)
    (root / "memory" / "MEMORY.md").write_text("# MEMORY\n", encoding="utf-8")
    (root / "memory" / "facts").mkdir(parents=True, exist_ok=True)
    (root / "memory" / "episodic").mkdir(parents=True, exist_ok=True)
    (root / "memory" / "journal").mkdir(parents=True, exist_ok=True)
    (root / "memory" / "journal" / "2026-09-23.md").write_text("[reflection] ok\n", encoding="utf-8")
    (root / "profile").mkdir(parents=True, exist_ok=True)
    (root / "profile" / "basic-info.md").write_text("name: t\n" * 30, encoding="utf-8")
    (root / "profile" / "preferences.md").write_text("p: t\n" * 30, encoding="utf-8")
    (root / "profile" / "persona.md").write_text("p: t\n" * 30, encoding="utf-8")
    (root / "craft").mkdir(parents=True, exist_ok=True)
    (root / "craft" / "alpha.md").write_text("---\nname: alpha\n---\n", encoding="utf-8")

    # Broken ref: MEMORY.md points to non-existent file
    (root / "memory" / "MEMORY.md").write_text(
        "- memory/episodic/ghost.md (rollout_path=memory/episodic/ghost.md)\n"
        "- memory/episodic/2026-09-23.md (rollout_path=memory/episodic/2026-09-23.md)\n",
        encoding="utf-8",
    )
    (root / "memory" / "episodic" / "2026-09-23.md").write_text("[episodic] t\n", encoding="utf-8")

    try:
        result = audit.run_audit(user_id)
        report_path_str = result["path"]
        report_path = Path(report_path_str)

        assert result["ok"] is True
        assert "scores" in result
        assert result["scores"]["overall"] >= 0
        assert result["scores"]["overall"] <= 100
        assert result["scores"]["grade"] in ("A", "B", "C", "D")
        # broken ghost should be surfaced
        assert any("ghost.md" in r for r in result["broken_refs"])
        # alpha.md (on disk but not in MEMORY.md) is unreferenced
        assert any("alpha.md" in r for r in result["unreferenced"])
        # report file written and readable
        assert report_path.exists(), f"report not at {report_path}"
        report_text = report_path.read_text(encoding="utf-8")
        assert "资产体系审计" in report_text
        assert "评分" in report_text
        assert "体系的优势" in report_text
        assert "体系的问题" in report_text
    finally:
        # cleanup
        import shutil
        if root.exists():
            shutil.rmtree(root, ignore_errors=True)


def test_score_bounds_and_grade_thresholds() -> None:
    from evoflow.assets.audit import AuditScore, _grade

    assert _grade(85) == "A"
    assert _grade(70) == "B"
    assert _grade(50) == "C"
    assert _grade(0) == "D"

    s = AuditScore(closure=100, density=100, freshness=100, overall=100, grade="A")
    assert 0 <= s.overall <= 100


def test_profile_gaps_detection() -> None:
    from evoflow.assets.audit import _profile_gaps
    import tempfile

    with tempfile.TemporaryDirectory() as td:
        # No profile dir at all → all three are gaps (function warns to create them)
        gaps = _profile_gaps(Path(td))
        assert "profile/basic-info.md" in gaps
        assert "profile/preferences.md" in gaps
        assert "profile/persona.md" in gaps

        # Profile dir exists but no files → three gaps
        Path(td, "profile").mkdir()
        gaps = _profile_gaps(Path(td))
        assert "profile/basic-info.md" in gaps
        assert "profile/preferences.md" in gaps
        assert "profile/persona.md" in gaps

        # Files exist but too short (<80 bytes) → still gap
        Path(td, "profile", "basic-info.md").write_text("x" * 40, encoding="utf-8")
        gaps2 = _profile_gaps(Path(td))
        assert "profile/basic-info.md" in gaps2

        # File long enough → no gap for that one
        Path(td, "profile", "basic-info.md").write_text("x" * 100, encoding="utf-8")
        gaps3 = _profile_gaps(Path(td))
        assert "profile/basic-info.md" not in gaps3


def test_audit_preserves_history_and_rotates(tmp_path: Path) -> None:
    from evoflow.assets import audit
    from evoflow.assets.paths import EntityRef, entity_root, sanitize_user_asset_id

    user_id = "audit_rotate_user"
    entity = EntityRef("user", sanitize_user_asset_id(user_id))
    root = entity_root(entity)

    # minimal skeleton
    (root / "memory" / "facts").mkdir(parents=True, exist_ok=True)
    (root / "memory" / "episodic").mkdir(parents=True, exist_ok=True)

    try:
        for _ in range(35):
            audit.run_audit(user_id)
        # rotation: only 30 most recent survive
        reports = audit.list_audit_reports(user_id)
        assert len(reports) <= 30
    finally:
        import shutil
        if root.exists():
            shutil.rmtree(root, ignore_errors=True)


def test_readme_files_exempt_from_unreferenced() -> None:
    """README.md 是说明文档，按设计不进入 MEMORY.md → 不算孤立。"""
    from evoflow.assets import audit
    from evoflow.assets.paths import EntityRef, entity_root, sanitize_user_asset_id

    user_id = "audit_readme_user"
    entity = EntityRef("user", sanitize_user_asset_id(user_id))
    root = entity_root(entity)

    (root / "memory" / "facts").mkdir(parents=True, exist_ok=True)
    (root / "memory" / "episodic").mkdir(parents=True, exist_ok=True)
    (root / "memory" / "journal").mkdir(parents=True, exist_ok=True)
    (root / "memory" / "MEMORY.md").write_text("# M\n", encoding="utf-8")
    (root / "profile").mkdir(parents=True, exist_ok=True)
    (root / "profile" / "basic-info.md").write_text("x" * 100, encoding="utf-8")
    (root / "profile" / "preferences.md").write_text("x" * 100, encoding="utf-8")
    (root / "profile" / "persona.md").write_text("x" * 100, encoding="utf-8")
    (root / "craft").mkdir(parents=True, exist_ok=True)
    (root / "craft" / "README.md").write_text("# 目录说明\n", encoding="utf-8")

    try:
        result = audit.run_audit(user_id)
        assert result["ok"] is True
        assert not any("README.md" in r for r in result["unreferenced"])
    finally:
        import shutil
        if root.exists():
            shutil.rmtree(root, ignore_errors=True)


def test_repair_appends_to_audit_trail_and_is_idempotent() -> None:
    from evoflow.assets import audit
    from evoflow.assets.paths import EntityRef, entity_root, sanitize_user_asset_id

    user_id = "audit_repair_user"
    entity = EntityRef("user", sanitize_user_asset_id(user_id))
    root = entity_root(entity)

    (root / "memory").mkdir(parents=True, exist_ok=True)
    (root / "memory" / "MEMORY.md").write_text("# M\n", encoding="utf-8")
    (root / "memory" / "facts").mkdir(parents=True, exist_ok=True)
    (root / "memory" / "facts" / "alpha.md").write_text("---\nid: a\n---\n", encoding="utf-8")
    (root / "memory" / "episodic").mkdir(parents=True, exist_ok=True)
    (root / "memory" / "episodic" / "beta.md").write_text("---\ntitle: b\n---\n", encoding="utf-8")
    (root / "memory" / "journal").mkdir(parents=True, exist_ok=True)
    (root / "profile").mkdir(parents=True, exist_ok=True)
    for f in ("basic-info.md", "preferences.md", "persona.md"):
        (root / "profile" / f).write_text("x" * 100, encoding="utf-8")

    try:
        # 1st repair: should create new section + append 2 pointers
        r1 = audit.run_audit(user_id, repair=True)
        assert r1["repair"]["appended"] == 2
        assert r1["repair"]["new_section"] is True
        assert r1["scores"]["closure"] == 100  # 闭环度修满
        text = (root / "memory" / "MEMORY.md").read_text(encoding="utf-8")
        assert "## Audit-Trail" in text
        assert "memory/facts/alpha.md" in text
        assert "memory/episodic/beta.md" in text

        # 2nd repair: should be idempotent (append=0)
        r2 = audit.run_audit(user_id, repair=True)
        assert r2["repair"]["appended"] == 0
        assert r2["repair"]["new_section"] is False
    finally:
        import shutil
        if root.exists():
            shutil.rmtree(root, ignore_errors=True)


def test_repair_does_not_break_existing_pointer() -> None:
    """If MEMORY.md already references a path, repair must not duplicate it."""
    from evoflow.assets import audit
    from evoflow.assets.paths import EntityRef, entity_root, sanitize_user_asset_id

    user_id = "audit_repair_existing_user"
    entity = EntityRef("user", sanitize_user_asset_id(user_id))
    root = entity_root(entity)

    (root / "memory").mkdir(parents=True, exist_ok=True)
    (root / "memory" / "facts").mkdir(parents=True, exist_ok=True)
    (root / "memory" / "facts" / "known.md").write_text("---\nid: k\n---\n", encoding="utf-8")
    (root / "memory" / "episodic").mkdir(parents=True, exist_ok=True)
    (root / "memory" / "journal").mkdir(parents=True, exist_ok=True)
    (root / "profile").mkdir(parents=True, exist_ok=True)
    for f in ("basic-info.md", "preferences.md", "persona.md"):
        (root / "profile" / f).write_text("x" * 100, encoding="utf-8")
    # MEMORY.md already has the pointer
    (root / "memory" / "MEMORY.md").write_text(
        "# M\n\n## Existing Task\n\n- memory/facts/known.md (rollout_path=memory/facts/known.md)\n",
        encoding="utf-8",
    )

    try:
        result = audit.run_audit(user_id, repair=True)
        assert result["ok"] is True
        # known.md is already referenced → repair should be a no-op
        assert result["repair"]["appended"] == 0
        assert result["repair"]["new_section"] is False
        text = (root / "memory" / "MEMORY.md").read_text(encoding="utf-8")
        # Existing Task section must remain untouched (no Audit-Trail duplication)
        assert "## Existing Task" in text
        # The original pointer line is preserved as-is
        assert "- memory/facts/known.md (rollout_path=memory/facts/known.md)" in text
    finally:
        import shutil
        if root.exists():
            shutil.rmtree(root, ignore_errors=True)
