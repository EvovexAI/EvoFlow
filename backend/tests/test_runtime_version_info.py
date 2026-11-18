"""运行态自证：「在跑的是哪一版」必须由代码回答，不许靠人查进程时间。

【self-evolution-bot · 2026-11-18 · 第51轮 · 模型:deepseek-v4.1-flash-1017】

背景（都是真实误报）
------------------
· 上一轮我据「文件已改」宣布修复生效，实际进程还是旧的；
· 第29轮我查了 7 层接线，最后发现只是没重启。

判据
----
1. 拿得到 commit / 进程启动时刻 / 扫到的文件数；
2. 进程启动时刻早于源码 mtime → 必须报 `source_newer_than_process=True`；
3. **不知道就必须是 None**：
   · 拿不到进程启动时刻；
   · 一个源文件都没扫到（`checked_files==0`）；
   · 传入的 repo_root 不是仓库。
   这三条都是我自己反证时撞出来的坑——前两版实现里，扫 0 个文件照样打勾
   「无源码改动」，非仓库目录照样报出父仓库的 commit。
"""

from __future__ import annotations

import time
from pathlib import Path

import pytest

from evoflow.runtime import version_info as V


@pytest.fixture(autouse=True)
def _restore_probe_cache():
    """进程启动时刻是模块级缓存，测试之间不许互相污染。"""
    prev_ts = V._PROCESS_START_TS
    prev_src = V._PROCESS_START_SOURCE
    yield
    V._PROCESS_START_TS = prev_ts
    V._PROCESS_START_SOURCE = prev_src


def _make_repo(tmp_path: Path) -> Path:
    """造一个最小 git 仓库 + 一个源文件。"""
    import subprocess

    subprocess.run(["git", "init", "-q", str(tmp_path)], check=False, timeout=20)
    (tmp_path / "src").mkdir(parents=True, exist_ok=True)
    (tmp_path / "src" / "a.py").write_text("x = 1\n", encoding="utf-8")
    return tmp_path


def test_reports_commit_and_start_time(tmp_path: Path) -> None:
    repo = _make_repo(tmp_path)
    info = V.build_runtime_version_info(repo_root=str(repo), source_dirs=["src"])
    # git init 后没有 commit：commit 为 None 是正确行为（不许编一个哈希）
    assert info["commit"] is None or isinstance(info["commit"], str)
    assert info["process"]["ts"], "拿不到进程启动时刻"
    assert info["checked_files"] == 1
    # tmp_path 里的文件是在 pytest 进程启动**之后**创建的，所以正确结果就是
    # True。别把断言改成 False —— 那会把「刚写的文件没进运行中的进程」这个
    # 真实信号压掉（我第一次就是这么写错的）。
    assert info["source_newer_than_process"] is True
    assert info["newest_newer_file"] == "src/a.py"


def test_source_newer_than_fake_old_process(tmp_path: Path) -> None:
    """反证：进程「1 小时前启动」时，刚写的源码必须被报成 stale。"""
    repo = _make_repo(tmp_path)
    V._PROCESS_START_TS = time.time() - 3600
    V._PROCESS_START_SOURCE = "test-fake"
    info = V.build_runtime_version_info(repo_root=str(repo), source_dirs=["src"])
    assert info["source_newer_than_process"] is True
    assert info["newest_newer_file"] == "src/a.py"
    text = V.format_runtime_version_markdown(info)
    assert "需重启才生效" in text


def test_zero_files_scanned_is_unknown_not_clean(tmp_path: Path) -> None:
    """反证：一个文件都没扫到 → 必须是 None（不知道），不许报「干净」。

    这是我自己反证3 撞出来的假绿：`checked_dirs` 全空时，输出照样打
    「✓ 进程启动后无源码改动（检查 0 个文件）」。
    """
    repo = _make_repo(tmp_path)
    info = V.build_runtime_version_info(
        repo_root=str(repo), source_dirs=["no_such_dir"]
    )
    assert info["checked_files"] == 0
    assert info["source_newer_than_process"] is None, (
        "扫描 0 个文件却报了「干净」——0 只代表过滤器没命中"
    )
    assert any("no source files scanned" in e for e in info["probe_errors"])
    assert "✓" not in V.format_runtime_version_markdown(info)


def test_non_repo_root_does_not_borrow_parent_repo(tmp_path: Path) -> None:
    """反证：传一个非仓库目录，不许偷偷用父目录的 .git 报出别人的 commit。"""
    repo = _make_repo(tmp_path)
    plain = repo / "src"
    info = V.build_runtime_version_info(repo_root=str(plain), source_dirs=["."])
    assert info["commit"] is None
    assert any("no .git" in e for e in info["probe_errors"])


def test_unavailable_start_time_is_unknown(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """反证：拿不到启动时刻 → None + 记录原因，绝不当作「无改动」。"""
    repo = _make_repo(tmp_path)
    monkeypatch.setattr(V, "_process_start_ts_win32", lambda: (None, "forced"))
    monkeypatch.setattr(V, "_process_start_ts_posix", lambda: (None, "forced"))
    monkeypatch.setattr(V, "_PROCESS_START_TS", None)
    monkeypatch.setattr(V, "_PROCESS_START_SOURCE", "")
    info = V.build_runtime_version_info(repo_root=str(repo), source_dirs=["src"])
    assert info["source_newer_than_process"] is None
    assert info["probe_errors"]
    assert "无法判定" in V.format_runtime_version_markdown(info)


def test_system_status_snapshot_includes_version() -> None:
    """接线：version 段必须出现在 system_status 快照里（否则等于没做）。"""
    from evoflow.admin.system_status import build_system_status_snapshot

    snap = build_system_status_snapshot()
    assert "version" in snap, "system_status 没带 version 段"
    ver = snap["version"]
    assert isinstance(ver, dict)
    assert "markdown" in ver or ver.get("probe_errors")
