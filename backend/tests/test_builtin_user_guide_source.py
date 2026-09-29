from pathlib import Path

from evoflow.knowledge.owned import builtin_seed


def test_packaged_user_guide_source(monkeypatch, tmp_path: Path) -> None:
    module_path = tmp_path / "_internal" / "evoflow" / "knowledge" / "owned" / "builtin_seed.py"
    module_path.parent.mkdir(parents=True)
    module_path.touch()
    docs = tmp_path / "_internal" / "evoflow" / "assets" / "builtin_knowledge_vaults" / "user-guide"
    docs.mkdir(parents=True)
    (docs / "index.md").write_text("Packaged user guide", encoding="utf-8")
    monkeypatch.setattr(builtin_seed, "__file__", str(module_path))

    assert builtin_seed._repo_docs_user() == docs


def test_source_checkout_user_guide_source(monkeypatch, tmp_path: Path) -> None:
    module_path = tmp_path / "backend" / "packages" / "harness" / "evoflow" / "knowledge" / "owned" / "builtin_seed.py"
    module_path.parent.mkdir(parents=True)
    module_path.touch()
    docs = tmp_path / "docs" / "user"
    docs.mkdir(parents=True)
    (docs / "index.md").write_text("Source user guide", encoding="utf-8")
    monkeypatch.setattr(builtin_seed, "__file__", str(module_path))

    assert builtin_seed._repo_docs_user() == docs
