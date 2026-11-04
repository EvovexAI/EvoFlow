"""meeting_speak_mode: short Q&A must not default to work-sync task dump."""

from evoflow.a2a.adapter import (
    build_meeting_speak_goal,
    meeting_speak_mode,
    normalize_meeting_speak_mode,
)


def test_short_capability_question_is_chat_not_sync():
    assert meeting_speak_mode("你能干嘛") == "chat"
    assert meeting_speak_mode("@后端开发 你能干嘛") == "chat"
    assert meeting_speak_mode("介绍一下你自己") == "chat"


def test_explicit_progress_question_is_sync():
    assert meeting_speak_mode("汇报一下本周进度") == "sync"
    assert meeting_speak_mode("手头任务量怎么样") == "sync"


def test_forced_mode_overrides_classifier():
    assert meeting_speak_mode("汇报进度", forced_mode="chat") == "chat"
    assert meeting_speak_mode("你能干嘛", forced_mode="sync") == "sync"
    assert normalize_meeting_speak_mode("CHAT") == "chat"
    assert normalize_meeting_speak_mode("nope") == ""


def test_chat_goal_answers_user_text_without_task_sync_frame():
    goal = build_meeting_speak_goal("你能干嘛", forced_mode="chat")
    assert "用户说：你能干嘛" in goal
    assert "【部门群聊 · 正常对话】" in goal
    assert "禁止主动汇报" in goal
    assert "本场是工作同步" not in goal
    assert "完成/未结" not in goal
