"""Duty beat open lines: think vs execute; dispatch names who sent the work."""

from evoflow.proactive.chat_session import build_duty_beat_text


def test_think_dispatch_names_user_without_duty_start_head(monkeypatch):
    monkeypatch.setattr(
        "evoflow.proactive.chat_session._local_user_display_name",
        lambda: "张三",
    )
    text = build_duty_beat_text(
        role_name="AIGC Gen",
        prompt=(
            "### 用户派发任务（优先执行，覆盖本轮自选战场）\n"
            "**目标：** 处理岗位工作项 2610201300_9a7b\n"
            "**优先级：** high · **来源：** 用户从员工页派发\n"
        ),
        kind="think",
    )
    assert "本轮值班开始" not in text
    assert text == "推进张三派发：处理岗位工作项 2610201300_9a7b"
    assert "开始执行" not in text


def test_think_dispatch_names_employee_from_source_line():
    text = build_duty_beat_text(
        role_name="AIGC Gen",
        prompt=(
            "### 用户派发任务\n"
            "**目标：** 写周报大纲\n"
            "**优先级：** normal · **来源：** 同事跨岗派发 · 技术总监\n"
        ),
        kind="think",
    )
    assert text == "推进技术总监派发：写周报大纲"


def test_think_dispatch_names_xiaov_from_source_line():
    text = build_duty_beat_text(
        role_name="客服",
        prompt=(
            "### 用户派发任务\n"
            "**目标：** 跟进投诉\n"
            "**优先级：** high · **来源：** 小V催办派发 · 小V\n"
        ),
        kind="think",
    )
    assert text == "推进小V派发：跟进投诉"


def test_think_patrol_has_no_duty_start_head():
    text = build_duty_beat_text(
        role_name="抖音拆解师",
        prompt="# 值班\n对照职责巡检",
        kind="think",
    )
    assert text == "对照职责巡检，有待办则推进并结案。"
    assert "本轮值班开始" not in text


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
    assert "派发" not in text
