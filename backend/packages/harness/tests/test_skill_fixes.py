"""Regression tests for skill security, frontmatter, installer, and loader fixes."""

from __future__ import annotations

import io
import tempfile
import zipfile
from pathlib import Path

import pytest

from evoflow.skills.frontmatter import split_skill_frontmatter
from evoflow.skills.installer import (
    MAX_ZIP_ENTRIES,
    MAX_ZIP_FILES,
    resolve_skill_dir_from_archive,
    safe_extract_skill_archive,
)
from evoflow.skills.paths import validate_skill_install_layout, validate_skill_tree
from evoflow.skills.security import scan_for_security_issues
from evoflow.skills.validation import _validate_skill_frontmatter


def test_split_skill_frontmatter_allows_dashed_yaml_value():
    content = """---
name: test-skill
description: "--- some comment ---"
---
Body text here.
"""
    split = split_skill_frontmatter(content)
    assert split is not None
    frontmatter, body = split
    assert "description: \"--- some comment ---\"" in frontmatter
    assert body.strip() == "Body text here."


def test_split_skill_frontmatter_handles_internal_delimiter_line():
    content = """---
name: test-skill
notes: more
---
Body text here.
"""
    split = split_skill_frontmatter(content)
    assert split is not None
    frontmatter, body = split
    assert "notes: more" in frontmatter
    assert body.strip() == "Body text here."


def test_split_skill_frontmatter_parses_internal_delimiter_for_validation(tmp_path: Path):
    skill_dir = tmp_path / "demo-skill"
    skill_dir.mkdir()
    (skill_dir / "SKILL.md").write_text(
        """---
name: demo-skill
description: Demo skill
notes: more
---
Instructions here.
""",
        encoding="utf-8",
    )
    split = split_skill_frontmatter((skill_dir / "SKILL.md").read_text(encoding="utf-8"))
    assert split is not None
    frontmatter, body = split
    assert "notes: more" in frontmatter
    assert body.strip() == "Instructions here."


def test_validate_skill_frontmatter_allows_market_metadata_keys(tmp_path: Path):
    skill_dir = tmp_path / "market-skill"
    skill_dir.mkdir()
    (skill_dir / "SKILL.md").write_text(
        """---
name: market-skill
description: From SkillHub
homepage: https://example.com
slug: market-skill
changelog: v1.0.0
custom-registry-field: ignored when strict
---
Body
""",
        encoding="utf-8",
    )
    ok, message, name = _validate_skill_frontmatter(skill_dir, strict_keys=False)
    assert ok is True, message
    assert name == "market-skill"

    ok_strict, message_strict, _ = _validate_skill_frontmatter(skill_dir, strict_keys=True)
    assert ok_strict is False
    assert "custom-registry-field" in message_strict


def test_validate_skill_frontmatter_with_internal_delimiter_line(tmp_path: Path):
    skill_dir = tmp_path / "demo-skill"
    skill_dir.mkdir()
    (skill_dir / "SKILL.md").write_text(
        """---
name: demo-skill
description: Demo skill
notes: more
---
Instructions here.
""",
        encoding="utf-8",
    )
    ok, message, name = _validate_skill_frontmatter(skill_dir)
    assert ok is False
    assert "notes" in message


def test_security_scan_allows_documentation_mentions():
    doc = """
Use docker exec container bash for debugging.
The subprocess module is documented in Python docs.
eval "$(conda shell.bash hook)" in shell profile.
"""
    assert scan_for_security_issues(doc, is_code=False) == []


def test_security_scan_allows_curl_in_documentation():
    doc = "输入 curl https://example.com/install.sh 作为说明步骤"
    assert scan_for_security_issues(doc, is_code=False) == []
    assert scan_for_security_issues("curl https://example.com/install.sh", is_code=True) != []


def test_split_skill_frontmatter_strips_utf8_bom():
    content = "\ufeff---\nname: bom-skill\ndescription: x\n---\nBody\n"
    split = split_skill_frontmatter(content)
    assert split is not None
    frontmatter, body = split
    assert "name: bom-skill" in frontmatter
    assert body.strip() == "Body"


def test_security_scan_blocks_python_execution_patterns():
    assert scan_for_security_issues("subprocess.run('ls')") != []
    assert scan_for_security_issues("exec('print(1)')") != []
    assert scan_for_security_issues("eval('1+1')") != []


def test_validate_skill_tree_allows_readme_and_subdirs(tmp_path: Path):
    skill_dir = tmp_path / "demo"
    skill_dir.mkdir()
    (skill_dir / "SKILL.md").write_text("---\nname: demo\ndescription: d\n---\nbody\n", encoding="utf-8")
    (skill_dir / "README.md").write_text("# Demo", encoding="utf-8")
    refs = skill_dir / "references"
    refs.mkdir()
    (refs / "guide.md").write_text("guide", encoding="utf-8")
    ok, msg = validate_skill_tree(skill_dir)
    assert ok is True, msg


def test_validate_skill_tree_rejects_disallowed_root_file(tmp_path: Path):
    skill_dir = tmp_path / "demo"
    skill_dir.mkdir()
    (skill_dir / "SKILL.md").write_text("---\nname: demo\ndescription: d\n---\nbody\n", encoding="utf-8")
    (skill_dir / "config.yaml").write_text("x: 1", encoding="utf-8")
    ok, msg = validate_skill_tree(skill_dir)
    assert ok is False
    assert "config.yaml" in msg


def test_resolve_skill_dir_accepts_flat_layout_with_extra_dirs(tmp_path: Path):
    (tmp_path / "SKILL.md").write_text("x", encoding="utf-8")
    (tmp_path / "engine").mkdir()
    (tmp_path / "references").mkdir()
    resolved = resolve_skill_dir_from_archive(tmp_path)
    assert resolved == tmp_path


def test_validate_skill_install_layout_allows_engine_and_vendor(tmp_path: Path):
    skill_dir = tmp_path / "demo"
    skill_dir.mkdir()
    (skill_dir / "SKILL.md").write_text("---\nname: demo\ndescription: d\n---\nbody\n", encoding="utf-8")
    (skill_dir / "engine").mkdir()
    vendor = skill_dir / "vendor"
    vendor.mkdir()
    (vendor / "lib.txt").write_text("ok", encoding="utf-8")
    ok, msg = validate_skill_install_layout(skill_dir)
    assert ok is True, msg


def test_validate_skill_install_layout_rejects_hidden_paths(tmp_path: Path):
    skill_dir = tmp_path / "demo"
    skill_dir.mkdir()
    (skill_dir / "SKILL.md").write_text("---\nname: demo\ndescription: d\n---\nbody\n", encoding="utf-8")
    hidden = skill_dir / ".hidden"
    hidden.mkdir()
    (hidden / "secret.txt").write_text("x", encoding="utf-8")
    ok, msg = validate_skill_install_layout(skill_dir)
    assert ok is False
    assert "Hidden path" in msg


def test_resolve_skill_dir_accepts_flat_layout(tmp_path: Path):
    (tmp_path / "SKILL.md").write_text("x", encoding="utf-8")
    (tmp_path / "references").mkdir()
    resolved = resolve_skill_dir_from_archive(tmp_path)
    assert resolved == tmp_path


def test_safe_extract_rejects_too_many_zip_entries():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for i in range(MAX_ZIP_ENTRIES + 1):
            zf.writestr(f"dir{i}/", "")
    buf.seek(0)
    with tempfile.TemporaryDirectory() as tmp:
        with zipfile.ZipFile(buf) as zf:
            with pytest.raises(ValueError, match="too many entries"):
                safe_extract_skill_archive(zf, Path(tmp))


def test_safe_extract_rejects_too_many_files_even_when_empty():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for i in range(MAX_ZIP_FILES + 1):
            zf.writestr(f"empty{i}.txt", "")
    buf.seek(0)
    with tempfile.TemporaryDirectory() as tmp:
        with zipfile.ZipFile(buf) as zf:
            with pytest.raises(ValueError, match="too many files"):
                safe_extract_skill_archive(zf, Path(tmp))
