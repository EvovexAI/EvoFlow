"""CRUD tests for host-direct file operation tools.

Covers the active file-tool surface in ``evoflow/tools/host_direct/``:
- 增 create:   write (auto-mkdir parents, create_line) + append/backup semantics
- 删 delete:   file delete + negative paths (missing file / directory)
- 改 update:   replace unique match / multi-match refusal / dry_run preview
- 查 read:     read roundtrip, list_dir tree+hidden, find glob search

Runtime fixture follows the in-repo scheduler pattern
(``runtime_with_workspace`` + ``tool.invoke({"runtime": rt})``).

Run: cd backend && python -m pytest tests/test_host_direct_file_tools.py -v
"""

import uuid
from pathlib import Path

from evoflow.tools.host_direct.delete_file import delete_file_hd
from evoflow.tools.host_direct.find_file import find_file_hd
from evoflow.tools.host_direct.list_dir import list_dir_hd
from evoflow.tools.host_direct.read_file import read_file_hd
from evoflow.tools.host_direct.str_replace import str_replace_hd
from evoflow.tools.host_direct.workspace_path_guard import runtime_with_workspace
from evoflow.tools.host_direct.write_file import write_file_hd


def _rt(root: Path):
    """Minimal runtime bound to *root*; unique thread_id avoids find-budget cross-test collisions."""
    return runtime_with_workspace(str(root), thread_id=f"t-{uuid.uuid4().hex[:8]}")


_seq = iter(range(10_000))


def _invoke_injected(tool, **kwargs):
    """Invoke a tool that declares ``InjectedToolCallId`` (write/replace).

    langchain-core requires the full model ToolCall form for such tools:
    ``{'args': {...}, 'name': ..., 'type': 'tool_call', 'tool_call_id': ...}``.
    """
    call_id = f"test-call-{next(_seq)}"
    result = tool.invoke({"args": kwargs, "name": tool.name, "type": "tool_call", "id": call_id})
    # Full ToolCall form returns a ToolMessage; unwrap to plain string content.
    return result.content if hasattr(result, "content") else result


def _mk(root: Path, rel: str, content: str = "") -> Path:
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")
    return p


# ────────────────────────────── 增 create ──────────────────────────────


def test_write_creates_file_with_parent_dirs_then_read_roundtrip(tmp_path):
    """写：新文件 + 自动建父目录；读：roundtrip 内容一致。"""
    rt = _rt(tmp_path)
    target = tmp_path / "notes" / "hello.txt"

    out = _invoke_injected(write_file_hd, path=str(target), content="hello evo", runtime=rt)
    assert out.startswith("OK:"), out
    assert target.exists()
    assert target.read_text(encoding="utf-8") == "hello evo\n"  # create_line 补尾换行

    # 写入后 readFileState 已记录（zcode file_unchanged 语义）：立即重读返回短路标记
    back = read_file_hd.invoke({"path": str(target), "runtime": rt})
    assert back.startswith("Wasted call"), back


def test_write_overwrite_backup_and_append(tmp_path):
    """写：backup 覆盖留 .bak；append 追加而非覆盖。"""
    rt = _rt(tmp_path)
    target = tmp_path / "log.txt"

    assert _invoke_injected(write_file_hd, path=str(target), content="v1", runtime=rt).startswith("OK:")
    assert target.read_text(encoding="utf-8") == "v1\n"

    out = _invoke_injected(write_file_hd, path=str(target), content="v2", backup=True, runtime=rt)
    assert out.startswith("OK:"), out
    assert target.read_text(encoding="utf-8") == "v2\n"
    bak = tmp_path / "log.txt.bak"
    assert bak.exists() and bak.read_text(encoding="utf-8") == "v1\n"

    out = _invoke_injected(write_file_hd, path=str(target), content="v3", append=True, runtime=rt)
    assert out.startswith("OK:"), out
    assert target.read_text(encoding="utf-8") == "v2\nv3\n"


# ────────────────────────────── 改 update ──────────────────────────────


def test_replace_unique_string_updates_file(tmp_path):
    """改：唯一匹配替换成功并落盘。"""
    rt = _rt(tmp_path)
    target = _mk(tmp_path, "app.py", "def main():\n    return 'old'\n")

    # zcode Edit guard：编辑前必须 Read
    read_file_hd.invoke({"path": str(target), "runtime": rt})

    out = _invoke_injected(str_replace_hd, path=str(target), old_string="'old'", new_string="'new'", runtime=rt)
    assert out.startswith("OK:"), out
    assert "Replaced 1 occurrence" in out
    assert "'new'" in target.read_text(encoding="utf-8")
    assert "'old'" not in target.read_text(encoding="utf-8")


def test_replace_multi_match_refuses_and_dry_run_leaves_file_intact(tmp_path):
    """改-安全：多处匹配拒绝执行；dry_run 只预览不落盘。"""
    rt = _rt(tmp_path)
    target = _mk(tmp_path, "dup.txt", "same token\nsame token\n")
    before = target.read_text(encoding="utf-8")

    # zcode Edit guard：编辑前必须 Read
    read_file_hd.invoke({"path": str(target), "runtime": rt})

    out = _invoke_injected(str_replace_hd, path=str(target), old_string="same token", new_string="x", runtime=rt)
    assert out.startswith("Error:"), out
    assert "2 times" in out
    assert target.read_text(encoding="utf-8") == before  # 未被改动

    preview = _invoke_injected(
        str_replace_hd, path=str(target), old_string="same token", new_string="x", dry_run=True, runtime=rt
    )
    assert "Dry Run Preview" in preview
    assert target.read_text(encoding="utf-8") == before  # 预览不写盘


# ────────────────────────────── 删 delete ──────────────────────────────


def test_delete_file_then_read_reports_not_found(tmp_path):
    """删：文件删除成功；随后读同路径报 File not found。"""
    rt = _rt(tmp_path)
    target = _mk(tmp_path, "gone.txt", "bye")

    out = delete_file_hd.invoke({"path": str(target), "runtime": rt})
    assert out.startswith("OK:"), out
    assert not target.exists()

    back = read_file_hd.invoke({"path": str(target), "runtime": rt})
    assert back.startswith("Error:"), back
    assert "File not found" in back


def test_delete_rejects_missing_file_and_directory(tmp_path):
    """删-负路径：不存在的文件与目录均拒绝，且不产生副作用。"""
    rt = _rt(tmp_path)

    missing = delete_file_hd.invoke({"path": str(tmp_path / "nope.txt"), "runtime": rt})
    assert missing.startswith("Error:"), missing
    assert "not found" in missing.lower()

    sub = tmp_path / "subdir"
    sub.mkdir()
    out = delete_file_hd.invoke({"path": str(sub), "runtime": rt})
    assert out.startswith("Error:"), out
    assert sub.exists()  # 目录原样保留


# ────────────────────────────── 查 read / list / find ──────────────────────────────


def test_list_dir_tree_hides_hidden_and_builtin_ignores(tmp_path):
    """查-目录：默认隐藏点文件、忽略 *.log；show_hidden 可见。"""
    rt = _rt(tmp_path)
    _mk(tmp_path, "src/main.py", "x = 1")
    _mk(tmp_path, "src/.secret", "h")
    _mk(tmp_path, "src/app.log", "log")

    visible = list_dir_hd(str(tmp_path / "src"), runtime=rt)
    assert "main.py" in visible
    assert ".secret" not in visible  # 隐藏文件默认跳过
    assert "app.log" not in visible  # *.log 属内置 ignore

    with_hidden = list_dir_hd(str(tmp_path / "src"), show_hidden=True, runtime=rt)
    assert ".secret" in with_hidden


def test_find_files_by_glob_pattern(tmp_path):
    """查-搜索：glob 命中多级文件；无命中时返回明确提示。"""
    rt = _rt(tmp_path)
    _mk(tmp_path, "app.py", "1")
    _mk(tmp_path, "README.md", "r")
    _mk(tmp_path, "pkg/util.py", "2")
    _mk(tmp_path, "pkg/data.json", "{}")

    out = find_file_hd.invoke({"pattern": "*.py", "root": ".", "runtime": rt})
    assert out.startswith("Found"), out
    assert "app.py" in out
    assert "pkg/util.py" in out
    assert "README.md" not in out

    miss = find_file_hd.invoke({"pattern": "*.rs", "root": ".", "runtime": rt})
    assert miss.startswith("No files matching"), miss
