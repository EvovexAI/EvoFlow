from pathlib import Path

from evoflow.tools.builtins.read_lints_tool import read_lints_tool
from evoflow.tools.code_lint import lint_path
from evoflow.tools.host_direct.workspace_path_guard import runtime_with_workspace


def test_read_lints_skips_non_code_file(tmp_path: Path):
    fp = tmp_path / "notes.txt"
    fp.write_text("hello", encoding="utf-8")
    rt = runtime_with_workspace(str(tmp_path), "t-lint-skip")
    out = read_lints_tool.invoke({"paths": "notes.txt", "runtime": rt})
    assert out.startswith("Skip:")
    assert "Python, JavaScript, TypeScript, and Java" in out
    assert not out.startswith("Error:")


def test_lint_path_skips_markdown(tmp_path: Path):
    fp = tmp_path / "README.md"
    fp.write_text("# hi", encoding="utf-8")
    out = lint_path(fp)
    assert out.startswith("Skip:")
    assert not out.startswith("Error:")


def test_read_lints_requires_file_path(tmp_path: Path):
    rt = runtime_with_workspace(str(tmp_path), "t-lint-req")
    out = read_lints_tool.invoke({"paths": "", "runtime": rt})
    assert out.startswith("Error:")
    assert "single file path" in out
    assert "Directory" in out or "directory" in out.lower()


def test_read_lints_rejects_directory(tmp_path: Path):
    d = tmp_path / "src"
    d.mkdir()
    (d / "main.py").write_text("x=1\n", encoding="utf-8")
    rt = runtime_with_workspace(str(tmp_path), "t-lint-dir")
    out = read_lints_tool.invoke({"paths": "src", "runtime": rt})
    assert out.startswith("Error:")
    assert "directory" in out.lower() or "not a file" in out.lower()


def test_read_lints_resolves_relative_path_under_workspace(tmp_path: Path):
    fp = tmp_path / "evopanel" / "src" / "page.js"
    fp.parent.mkdir(parents=True)
    fp.write_text("const x = 1\n", encoding="utf-8")
    rt = runtime_with_workspace(str(tmp_path), "t-lint")
    out = read_lints_tool.invoke(
        {"paths": "evopanel/src/page.js", "runtime": rt},
    )
    assert "path does not exist" not in out
    assert out.startswith("Linter results:")
