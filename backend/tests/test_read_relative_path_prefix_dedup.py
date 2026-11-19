"""`read` 相对路径的两处真缺陷（2026-11-19 第67轮定位）。

【self-evolution-bot · 2026-11-19 · 第67轮 · 模型:deepseek-v4.1-flash-1017】

## 缺陷 A：成功分支漏了 `return target`（已在 read_file.py 内修复）

`_resolve_read_target` 的相对路径分支里，`if not target.is_file():` 块内每条路径
都 return 了错误串，**块外却没有 `return target`**。于是「相对路径 + 文件确实存在」
这个最常见的成功情况会掉到函数末尾，隐式返回 `None`，上游报：

    could not resolve path 'AGENTS.md' to a file (resolver returned NoneType)

文件明明在（5242B），调用方只能换写法重试。

取证：`sys.settrace` 捕获 return 行号 = 231，正是 `if not target.is_file():` 那行；
此时局部变量 `expanded='AGENTS.md'`、`target=...backend/AGENTS.md`、`target.is_file()` 为 True。

**为什么 10 条绿色测试没拦住**：原有测试全部只用绝对路径（`str(hero)` 或直接
monkeypatch 掉解析器），相对路径分支零覆盖。

## 缺陷 B：重复前缀 `backend/backend/...`

网关进程 cwd 是 `backend/`，agent 却习惯写仓库相对路径
（`backend/packages/.../installer.py`），拼出来是 `backend/backend/packages/...`。
文件本身就在，报错只说「找不到」，且未绑定工作区时连「按哪个根拼的」都不提示。

现网后果：`read::file` 错误后半期 11 次 / 前半期 2 次，抽样全是这种形态。

修法（`_resolve_upward_fallback`）：先把相邻重复目录段合并（`backend/backend` → `backend`），
命中真实文件就返回；不命中再沿父目录最多 12 层整段重试；两者都不中才报错。
安全边界：最终返回的必须是 `is_file()` 的真实文件，不做模糊匹配。
"""

from __future__ import annotations

from pathlib import Path

from langgraph.prebuilt.tool_node import ToolRuntime

from evoflow.tools.host_direct import read_file as RF


def _runtime() -> ToolRuntime:
    return ToolRuntime(
        state={},
        context={},
        config={},
        stream_writer=None,
        tool_call_id="probe",
        store=None,
    )


def test_dedup_collapses_repeated_dir_segment(tmp_path):
    """`a/a/x.txt` 在 a/ 下真实存在时，应解析成 a/x.txt 而不是报找不到。"""
    root = tmp_path / "ws"
    root.mkdir()
    (root / "pkg").mkdir()
    real = root / "pkg" / "note.txt"
    real.write_text("body\n", encoding="utf-8")

    # 构造「重复一整段」的形态：ws/pkg/pkg/note.txt
    bogus = root / "pkg" / "pkg" / "note.txt"
    assert not bogus.is_file()

    got = RF._resolve_upward_fallback(bogus)
    assert got is not None, "重复前缀未被合并，仍报找不到"
    assert got.is_file()
    assert got.read_text(encoding="utf-8") == "body\n"


def test_upward_fallback_returns_none_for_truly_missing(tmp_path):
    """反证：真的不存在时必须返回 None，不能把随便哪个同名文件蒙进来。"""
    got = RF._resolve_upward_fallback(tmp_path / "no" / "such" / "zzz_unique_xyz.txt")
    assert got is None


def test_upward_fallback_does_not_escape_to_unrelated_same_name(tmp_path, monkeypatch):
    """反证：同名文件在别的目录里，不许被误认。"""
    a = tmp_path / "a"
    b = tmp_path / "b"
    a.mkdir()
    b.mkdir()
    (a / "same.txt").write_text("A\n", encoding="utf-8")
    (b / "same.txt").write_text("B\n", encoding="utf-8")

    # 从 b/nested/deep/same.txt 出发，向上第一层命中就是 b/same.txt（正确）
    got = RF._resolve_upward_fallback(b / "nested" / "deep" / "same.txt")
    assert got is not None
    assert got.read_text(encoding="utf-8") == "B\n", "认到了另一个目录的同名文件"


def test_real_repo_relative_path_resolves(tmp_path, monkeypatch):
    """真实形态：仓库相对路径 `backend/<rel>` 在 cwd=backend 下必须能读到。"""
    repo_backend = Path(RF.__file__).resolve()
    # .../backend/packages/harness/evoflow/tools/host_direct/read_file.py
    backend_dir = repo_backend.parents[5]
    assert (backend_dir / "packages").is_dir(), backend_dir

    rel = "backend/packages/harness/evoflow/tools/host_direct/read_file.py"
    monkeypatch.chdir(backend_dir)
    monkeypatch.setattr(RF, "resolve_tool_workspace_root", lambda **k: ("", None))

    resolved = RF._resolve_read_target(rel, runtime=_runtime())
    assert isinstance(resolved, Path), f"仍返回 {type(resolved).__name__}: {resolved}"
    assert resolved.is_file(), resolved
