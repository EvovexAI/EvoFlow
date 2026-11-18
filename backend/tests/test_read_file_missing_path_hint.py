"""read 的「找不到」必须给出可执行的下一步，至少对高频特例要这样。

【self-evolution-bot · 2026-11-18 · 第51轮 · 模型:deepseek-v4.1-flash-1017】

实证来源（近 7 天 obs，`evoflow_obs_tool_invocations`）
-----------------------------------------------------
`read` 的 file-not-found 后半期 **12 次** / 前半期 1 次（唯一在涨的一条）。
抽样 5 条 error_message，4 条读的是 `…/evoflow-bash-tasks/<id>.output`
—— 后台 bash 任务刚被后台化时输出文件还没写出。原文只有
`Error: File not found: <path>`，没有一个字告诉我「这不是路径写错，是时机不对」，
于是我会换措辞再试一次（然后又被重复探索守卫拦一次）。

判据
----
1. 路径里含 `evoflow-bash-tasks` 目录段 → 提示必须出现「等任务完成 / 用 outputFile」；
2. 普通文件 → 不许出现该提示（防噪声）；
3. **只是名字像**（`evoflow-bash-tasks.md` 这种文件名，不是目录段）→ 不许命中
   （第 17 轮我拿 `uploads/web` 前缀当判据误命中的同类错）。
"""

from __future__ import annotations

from pathlib import Path

from evoflow.tools.host_direct.read_file import _background_task_output_hint


def test_background_task_output_gets_actionable_hint() -> None:
    p = Path(r"C:\Users\admin\AppData\Local\Temp\evoflow-bash-tasks\abc123.output")
    hint = _background_task_output_hint(p)
    assert "后台 bash 任务" in hint
    assert "outputFile" in hint
    assert "不要换措辞重试" in hint


def test_ordinary_file_gets_no_hint() -> None:
    assert _background_task_output_hint(Path(r"D:/dev/github/EvoFlow/README.md")) == ""


def test_lookalike_filename_is_not_a_directory_segment() -> None:
    """文件名里带同样字节 ≠ 在 evoflow-bash-tasks 目录下。"""
    assert _background_task_output_hint(Path(r"D:/tmp/evoflow-bash-tasks.md")) == ""
    # 子串出现在别处也不行
    assert _background_task_output_hint(Path(r"D:/tmp/x/evoflow-bash-tasksy/a.py")) == ""


def test_not_found_message_includes_hint_for_background_output() -> None:
    """接线：提示必须真的拼进 `_resolve_read_target` 返回的错误串里。

    只测辅助函数 = 测了一个没人调用的函数（本岗栽过 4 次的「接线」坑）。
    """
    from evoflow.tools.host_direct.read_file import _resolve_read_target

    class _NoRuntime:
        """resolve 路径分支不需要 runtime（绝对路径分支不碰它）。"""

    missing = str(
        Path(r"C:\Users\admin\AppData\Local\Temp\evoflow-bash-tasks\definitely_missing_9x7.output")
    )
    out = _resolve_read_target(missing, runtime=_NoRuntime())  # type: ignore[arg-type]
    assert isinstance(out, str), "应当返回错误串而不是 Path"
    assert "File not found" in out
    assert "后台 bash 任务" in out, f"提示没拼进错误串：{out}"
