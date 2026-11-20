"""bash 学到的 cwd 必须对 read/replace/grep 同样生效（一个 session 只有一个「当前目录」）。

【self-evolution-bot · 2026-11-20 · 第89轮 · 模型:deepseek-v4.1-flash-1017】

为什么单建：现网 obs 近 7 天 read/replace/grep 相对路径调用 209 次、失败 116 次，
其中 **16 次目标文件真就在仓库根下**——不是路径写错，是「当前目录」不一致：
  · bash 的 cwd 由第 68 轮持久化，`cd` 之后下一条命令能看见；
  · read/replace/grep 走 `resolve_tool_path`，按「进程 cwd / 会话工作区根」拼，
    完全不看 bash 学到的 cwd。
后果：bash 明明回 `cwd: /d/dev/github/EvoFlow`，read 却拼出
`backend/backend/packages/...`，模型于是**每次**都写 `D:/dev/github/EvoFlow/...` 全量路径。
现网量化：绝对路径 3402 次平均 76 字符 vs 相对路径 209 次平均 53 字符，每条多 23 字符。

本文件必须走 `resolve_tool_path`（真实调用点入口），不能只测 `thread_cwd_for`——
第 12/16 轮教训：只测函数、不测接线，等于没修。
"""

from __future__ import annotations

import importlib
from pathlib import Path

import pytest

bt = importlib.import_module("evoflow.tools.zcode_port.bash_tool")


class _Runtime:
    """够 resolve_tool_workspace_root / _bash_cwd_for_thread 取 thread_id 的最小替身。"""

    def __init__(self, thread_id: str) -> None:
        self.context = {"thread_id": thread_id}
        self.config: dict = {}
        self.state: dict = {}


REPO = Path("D:/dev/github/EvoFlow")


@pytest.fixture(autouse=True)
def _reset_cwd():
    bt._PERSISTED_CWD.clear()
    yield
    bt._PERSISTED_CWD.clear()


def _guard():
    return importlib.import_module("evoflow.tools.host_direct.workspace_path_guard")


def test_thread_cwd_for_returns_learned_dir():
    """已学到的 cwd 能被读回；未学过的 thread 返回空串。"""
    bt._remember_cwd("t-learn", "/d/dev/github/EvoFlow")
    assert bt.thread_cwd_for("t-learn") == "D:/dev/github/EvoFlow"
    assert bt.thread_cwd_for("t-never-seen") == ""
    assert bt.thread_cwd_for("") == ""


def test_thread_cwd_for_drops_vanished_dir(tmp_path):
    """记下的目录后来被删掉时不再返回，避免把相对路径拼到不存在的根上。"""
    gone = tmp_path / "gone"
    gone.mkdir()
    bt._remember_cwd("t-gone", str(gone))
    assert bt.thread_cwd_for("t-gone") != ""
    gone.rmdir()
    assert bt.thread_cwd_for("t-gone") == ""


@pytest.mark.skipif(not (REPO / "backend").is_dir(), reason="需要 EvoFlow 仓库")
def test_relative_path_resolves_under_bash_cwd():
    """接线测试：bash cd 到仓库根后，`backend/tests/...` 这类仓库相对路径必须命中。

    这是本缺陷的原始形态——修复前它被拼成 `backend/backend/tests/...`（不存在）。
    """
    rt = _Runtime("t-wire")
    rel = "backend/tests/test_bash_cwd_persist.py"

    before = _guard().resolve_tool_path(rel, runtime=rt, must_exist=False)
    assert str(before).replace("\\", "/").count("/backend/backend/") >= 1, (
        f"前置条件不成立：未学 cwd 时应拼出重复前缀，实际 {before}"
    )

    bt._remember_cwd("t-wire", "/d/dev/github/EvoFlow")
    after = _guard().resolve_tool_path(rel, runtime=rt, must_exist=True, must_be_file=True)
    assert isinstance(after, Path), f"应当解析成 Path，实际 {after!r}"
    assert after == (REPO / "backend/tests/test_bash_cwd_persist.py").resolve()


@pytest.mark.skipif(not (REPO / "backend").is_dir(), reason="需要 EvoFlow 仓库")
def test_root_relative_to_repo_after_cd_repo_root():
    """在仓库根时 `docs/...` 直接可用，不必再写 D:/ 全量前缀。"""
    rt = _Runtime("t-docs")
    bt._remember_cwd("t-docs", "/d/dev/github/EvoFlow")
    got = _guard().resolve_tool_path("backend/app", runtime=rt, must_exist=True, must_be_dir=True)
    assert isinstance(got, Path), f"应当解析成 Path，实际 {got!r}"
    assert got == (REPO / "backend/app").resolve()


def test_missing_target_falls_back_to_old_logic():
    """bash cwd 下也没有的路径，必须回落旧逻辑并保持原有报错文案（不放宽、不改口径）。"""
    rt = _Runtime("t-miss")
    bt._remember_cwd("t-miss", "/d/dev/github/EvoFlow")
    got = _guard().resolve_tool_path(
        "no_such_dir/__bash_cwd_probe__.py", runtime=rt, must_exist=True
    )
    assert isinstance(got, str), f"未命中应当回落报错串，实际 {got!r}"
    assert got.startswith("Error: "), got
    assert "__bash_cwd_probe__.py" in got, "报错要回显入参，否则调用方只能再猜一次"


def test_absolute_path_unaffected():
    """绝对路径不受 cwd 影响（本次只改相对路径的根）。"""
    rt = _Runtime("t-abs")
    bt._remember_cwd("t-abs", "/d/dev/github/EvoFlow")
    target = REPO / "backend/tests/test_bash_cwd_persist.py"
    got = _guard().resolve_tool_path(str(target), runtime=rt, must_exist=True, must_be_file=True)
    assert got == target.resolve()


def test_grep_default_root_follows_bash_cwd():
    """grep 不传 path 时，默认根应跟随 bash 学到的 cwd（IDE 语义：未指定 = 当前目录）。"""
    rt = _Runtime("t-grep")
    gg = importlib.import_module("evoflow.tools.zcode_port.glob_grep")

    before = gg._workspace_root(rt, None)
    bt._remember_cwd("t-grep", "/d/dev/github/EvoFlow")
    after = gg._workspace_root(rt, None)

    assert before != after, f"未跟随 cwd：before={before} after={after}"
    assert after == REPO.resolve(), f"默认根应为 bash cwd，实际 {after}"


def test_cwd_void_after_workspace_switch():
    """同一 thread 切换工作区后，旧工作区学到的 cwd 必须作废（第68轮同类缺陷）。"""
    bt._remember_cwd("t-switch", "/d/dev/github/EvoFlow")
    bt._THREAD_WORKSPACE["t-switch"] = "D:/dev/github/EvoFlow"
    # 只在记住 cwd 时带了 root，才会做切换判定；这里手工把 root 补进条目。
    _r, _p = bt._PERSISTED_CWD["t-switch"]
    bt._PERSISTED_CWD["t-switch"] = ("D:/dev/github/EvoFlow", _p)

    assert bt.thread_cwd_for("t-switch", "D:/dev/github/EvoFlow") != "", "同一工作区应保留 cwd"
    assert bt.thread_cwd_for("t-switch", "D:/some/other/workspace") == "", "切换工作区后旧 cwd 必须作废"


# ───────────── 第89轮补：read 走的是自己的解析器，必须单独验接线 ─────────────


def test_read_tool_relative_path_uses_bash_cwd(tmp_path):
    """read 是调用量最高的文件工具，它**不走** resolve_tool_path，必须单独验接线。

    第89轮上一笔提交只在 resolve_tool_path 里接了 cwd，read 的普通相对路径仍按
    「会话根 / 进程 cwd」拼，等于 read 上这个缺陷没修。

    夹具刻意用临时目录：仓库相对路径会被 read 第67轮的「向上找同名文件」兜底救回来，
    于是**接线坏掉测试也照样绿**（我第一次就这么假绿了，注入 if False 后 11 条全绿）。
    这里 `sub/target.txt` 在 backend/ 及所有祖先目录下都不存在，兜底救不到，
    只有 bash cwd 接线生效才可能解析成功。
    """
    rf = importlib.import_module("evoflow.tools.host_direct.read_file")
    proj = tmp_path / "proj"
    (proj / "sub").mkdir(parents=True)
    (proj / "sub" / "target.txt").write_text("hi", encoding="utf-8")
    rel = "sub/target.txt"

    rt = _Runtime("t-read-wire")
    before = rf._resolve_read_target(rel, runtime=rt)
    assert isinstance(before, str), f"前置条件不成立：未学 cwd 时不该命中，实际 {before!r}"

    bt._remember_cwd("t-read-wire", str(proj).replace("\\", "/"))
    after = rf._resolve_read_target(rel, runtime=rt)
    assert isinstance(after, Path), f"read 没接上 bash cwd，实际返回 {after!r}"
    assert after == (proj / "sub" / "target.txt").resolve()


def test_read_tool_missing_relative_reports_real_base(tmp_path):
    """相对路径确实不存在时：报错要点名**真正参与拼接的根**，不许无条件说「会话工作区根」。

    第89轮实测：未绑定工作区（6/8 会话如此）时拼的是网关进程 cwd，旧文案却说
    「按会话工作区根拼的」——照那句去改路径只会更错。
    """
    rf = importlib.import_module("evoflow.tools.host_direct.read_file")
    rt = _Runtime("t-read-miss")
    got = rf._resolve_read_target("no_such_dir/__read_probe__.py", runtime=rt)

    assert isinstance(got, str), f"应当返回报错串，实际 {got!r}"
    assert got.startswith("Error: File not found: "), got
    assert "实际查找的绝对路径" in got, got
    # 文案里的根必须是真实参与拼接的那个，不能凭空断言「会话工作区根」
    if "会话工作区根" in got:
        assert str(Path.cwd()).replace("\\", "/").lower() not in got.replace("\\", "/").lower(), (
            f"未绑定工作区却说是会话工作区根：{got}"
        )


def test_replace_missing_relative_points_at_real_root(tmp_path):
    """replace 的缺路径文案同样要按实际根说话（共用 _finalize_path）。"""
    guard = _guard()
    rt = _Runtime("t-replace-miss")
    got = guard.resolve_tool_path(
        "no_such_dir/__replace_probe__.md", runtime=rt, must_exist=True
    )

    assert isinstance(got, str), f"应当返回报错串，实际 {got!r}"
    first = got.splitlines()[0]
    assert first == "Error: Path not found: no_such_dir/__replace_probe__.md", got
    assert "实际查找的绝对路径" in got, got
