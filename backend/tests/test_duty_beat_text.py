"""Duty beat open lines: think vs execute must not both say duty-start."""

from evoflow.proactive.chat_session import build_duty_beat_text


def test_think_dispatch_uses_duty_start_head():
    text = build_duty_beat_text(
        role_name="AIGC Gen",
        prompt="### 用户派发任务\n\n目标：处理岗位工作项 2610201300_9a7b\n",
        kind="think",
    )
    assert text.startswith("本轮值班开始 · AIGC Gen")
    assert "推进用户派发" in text
    assert "开始执行" not in text


def test_execute_uses_start_exec_head_not_duty_start():
    text = build_duty_beat_text(
        role_name="AIGC Gen",
        prompt="run approved plan for task 2610201300_9a7b",
        kind="execute",
    )
    assert text.startswith("开始执行 · AIGC Gen")
    assert "按已批计划执行并结案" in text
    assert "本轮值班开始" not in text


def test_execute_ignores_dispatch_markers_in_prompt():
    text = build_duty_beat_text(
        role_name="XiaoV",
        prompt="### 用户派发任务\n\n目标：should-not-appear\n",
        kind="execute",
    )
    assert text.startswith("开始执行 · XiaoV")
    assert "推进用户派发" not in text
