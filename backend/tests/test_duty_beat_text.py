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


def test_plain_user_chat_keeps_original_words_without_dispatch_prefix():
    """【self-evolution-bot · 2026-11-21 · 第107轮 · 模型:deepseek-v4.1-flash-1017】

    人跟员工正常说话（wk="chat"）时，节拍文案必须逐字等于用户原话，
    不能出现「推进X派发：」前缀（用户原话：「就相当于是正常说话就行了，
    不要说什么'谁推进小微派发'」）。
    """
    text = build_duty_beat_text(
        role_name="个人助理",
        prompt=(
            "### 用户派发任务\n"
            "**目标：** 你好，请用一句话告诉我你现在负责什么。\n"
            "**优先级：** normal · **来源：** 小V催办派发 · 小V\n"
        ),
        kind="think",
        plain_user_chat=True,
    )
    assert text == "你好，请用一句话告诉我你现在负责什么。"
    assert "派发" not in text
    assert "小V" not in text


def test_plain_user_chat_false_still_keeps_dispatch_prefix():
    """对照：值班/派单回合仍保留「推进X派发：」——不能为了聊天把派单语义也删了。"""
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


def test_task_notification_is_not_persisted_as_user_transcript():
    """【self-evolution-bot · 2026-11-21 · 第107轮 · 模型:deepseek-v4.1-flash-1017】

    现网实证：个人助理会话 16:15:08.855 落了一条 role=user、
    tool_name=task-notification、正文是 <task-notification>…</task-notification>
    的行，前端当成用户气泡渲染。系统注入绝不能进用户气泡。
    """
    from evoflow.persistence.chat_message_repositories import _is_injected_user_transcript

    body = (
        "<task-notification>\n<task-id>duty_1</task-id>\n<kind>duty</kind>\n"
        "<status>completed</status>\n</task-notification>"
    )
    payload = {"content": [{"type": "text", "text": body}]}
    # 按 tool_name 命中
    assert _is_injected_user_transcript(role="user", payload=payload, tool_name="task-notification")
    # tool_name 缺失时按正文前缀兜底
    assert _is_injected_user_transcript(role="user", payload=payload, tool_name=None)
    # 真人发言不能被误伤
    human = {"content": [{"type": "text", "text": "你好，请用一句话告诉我你现在负责什么。"}]}
    assert not _is_injected_user_transcript(role="user", payload=human, tool_name=None)


def test_display_path_filters_injected_user_rows():
    """【self-evolution-bot · 2026-11-21 · 第107轮 · 模型:deepseek-v4.1-flash-1017】

    上一轮只补了写入侧拦截，历史行照样漏。本轮现网复算：显示路径
    （list_messages_for_display*）只滤 hidden、不滤 injected，全库 4465 条
    user 行里有 875 条 <task-notification> XML 会被渲染成用户气泡。
    这条测试钉住「显示单点判据」两侧：注入要滤掉，压缩摘要要留着。
    """
    from evoflow.persistence.chat_message_repositories import _display_visible_rows

    def row(tool_name, text, seq=1):
        return {"role": "user", "tool_name": tool_name, "seq": seq,
                "payload": {"content": [{"type": "text", "text": text}]}}

    notif = row("task-notification", "<task-notification>\n<task-id>d1</task-id>\n</task-notification>")
    notif_noname = row(None, "<task-notification>\n<task-id>d2</task-id>\n</task-notification>")
    brief = row("proactive_duty_brief", "# 值班 · 「个人助理」")
    summary = row("conversation_summary", "[CONTEXT COMPACTION — REFERENCE ONLY] …")
    human = row(None, "你好，请用一句话告诉我你现在负责什么。")

    visible = _display_visible_rows([notif, notif_noname, brief, summary, human])
    ids = [r["seq"] for r in visible]
    # 注入与 hidden 都要消失
    assert notif not in visible
    assert notif_noname not in visible
    assert brief not in visible
    # 压缩摘要是会话标记行，必须仍可见（否则历史断层）
    assert summary in visible
    assert human in visible
    assert len(ids) == 2
