"""Meeting oral-report helpers: sanitize duty noise, build speak prompt."""

from types import SimpleNamespace

from evoflow.a2a.adapter import (
    _llm_meeting_speak,
    _meeting_speak_user_error,
    build_meeting_speak_goal,
    sanitize_meeting_reply,
)
from evoflow.proactive.work_items import format_meeting_task_memory_for_prompt


def test_meeting_speak_user_error_rate_limit_is_friendly():
    exc = Exception(
        "Error code: 429 - {'error': {'code': 'SetLimitExceeded', "
        "'message': 'Your account [2130697331] has reached the set inference "
        "limit for the [deepseek-v4-flash] model'}}"
    )
    msg = _meeting_speak_user_error(exc)
    assert "限流" in msg
    assert "SetLimitExceeded" not in msg
    assert "2130697331" not in msg


def test_llm_meeting_speak_retries_on_set_limit(monkeypatch):
    import asyncio

    calls = {"n": 0}

    class _Resp:
        content = "这周登录页联调完了，还差验证码。"

    async def fake_ainvoke(model, messages):
        calls["n"] += 1
        if calls["n"] < 3:
            raise Exception(
                "Error code: 429 - {'error': {'code': 'SetLimitExceeded', "
                "'message': 'inference limit'}}"
            )
        return _Resp()

    monkeypatch.setattr(
        "evoflow.context.internal_model_invoke.ainvoke_internal_chat_model",
        fake_ainvoke,
    )
    monkeypatch.setattr(
        "evoflow.models.create_chat_model",
        lambda **kwargs: object(),
    )
    monkeypatch.setattr(
        "evoflow.a2a.adapter._meeting_speak_backoff_seconds",
        lambda attempt, error: 0.01,
    )

    role = SimpleNamespace(
        agent_code="fe",
        role_name="前端",
        config=SimpleNamespace(model_name=None, responsibilities=["UI"]),
    )
    text = asyncio.run(_llm_meeting_speak(role=role, topic="汇报进度", context_summary=""))
    assert "登录页" in text
    assert calls["n"] == 3


def test_sanitize_strips_feishu_duty_summary():
    raw = (
        "[feishu·值班交班摘要]\n"
        "员工工作摘要\n"
        "本周登录页已联调完成，缺验证码服务。"
    )
    out = sanitize_meeting_reply(raw)
    assert "feishu" not in out.lower()
    assert "交班" not in out
    assert "登录页" in out


def test_sanitize_strips_work_report_summary_marker():
    raw = (
        "[feishu·工作汇报]\n"
        "工作汇报摘要\n"
        "本周登录页已联调完成，缺验证码服务。"
    )
    out = sanitize_meeting_reply(raw)
    assert "feishu" not in out.lower()
    assert "工作汇报摘要" not in out
    assert "登录页" in out


def test_sanitize_keeps_normal_oral_report():
    raw = "登录页差不多了，就差验证码。"
    assert sanitize_meeting_reply(raw) == raw


def test_sanitize_truncates_long_oral_report():
    raw = "这周" + ("跟进任务进展，" * 40)
    out = sanitize_meeting_reply(raw, max_chars=160)
    assert len(out) <= 160
    assert out.endswith("…")


def test_sanitize_strips_stance_labels():
    raw = "【立场】赞同。【风险】口径乱。【建议】先上模板。"
    out = sanitize_meeting_reply(raw)
    assert "【立场】" not in out
    assert "赞同" in out


def test_meeting_speak_mode_proposal_vs_sync():
    from evoflow.a2a.adapter import meeting_speak_mode

    assert meeting_speak_mode("大家汇报下工作进度") == "sync"
    assert meeting_speak_mode("讨论周报自动起草的一周 MVP 方案，请辩论取舍") == "proposal"
    assert "rebuttal" == meeting_speak_mode("议题\n\n【第二轮·碰撞】请只回应分歧")


def test_build_meeting_speak_goal_mentions_topic_and_ban_duty():
    g = build_meeting_speak_goal("大家汇报下工作进度", "【后端】接口已好")
    assert "大家汇报下工作进度" in g
    assert "工作同步" in g or "聊天室" in g
    assert "160" in g
    assert "完成几件" in g or "未结" in g or "任务量" in g
    assert "随时能接新活" in g  # banned phrase listed in prompt
    assert "值班" in g or "飞书" in g
    assert "会上已有发言" in g or "同事" in g
    assert "禁止抄" in g or "别复述" in g or "同义复读" in g


def test_build_meeting_speak_goal_proposal_no_duty_sync():
    g = build_meeting_speak_goal("我们要做一个周报自动起草方案，请辩论 MVP 取舍", "【PM】先收范围")
    assert "方案" in g or "需求" in g
    assert "280" in g or "220" in g
    assert "值班" in g  # banned
    assert "会上已有发言" in g
    assert "【PM】先收范围" in g

def test_format_meeting_task_memory_includes_completed_and_status_hint():
    text = format_meeting_task_memory_for_prompt(
        [
            {
                "task_id": "Task_open",
                "name": "联调登录页",
                "status": "executing",
                "progress": 60,
                "updated_at": "2026-08-08T10:00:00Z",
            },
            {
                "task_id": "Task_done",
                "name": "文案替换",
                "status": "completed",
                "progress": 100,
                "updated_at": "2026-08-07T10:00:00Z",
                "result": "已替换 tasks.js",
            },
        ]
    )
    assert "自动加载" in text
    assert "无需再查" in text
    assert "概况" in text
    assert "已完成 1" in text
    assert "未结 1" in text
    assert "Task_open" in text
    assert "[executing]" in text
    assert "更新 08-08" in text
    assert "Task_done" in text
    assert "[completed]" in text
    assert "已替换 tasks.js" in text


def test_format_meeting_task_memory_empty():
    assert "暂无" in format_meeting_task_memory_for_prompt([])


def test_list_role_recent_tasks_includes_completed(monkeypatch):
    from evoflow.proactive.models import ProactiveRole, ProactiveRoleConfig
    from evoflow.proactive.work_items import list_role_recent_tasks

    class _Storage:
        def list_projects(self):
            return [{"id": "p1"}]

        def load_project(self, pid):
            assert pid == "p1"
            return {
                "id": "p1",
                "tasks": [
                    {
                        "id": "Task_old",
                        "name": "旧单",
                        "status": "completed",
                        "progress": 100,
                        "assigned_role": "前端工程师",
                        "updated_at": "2026-01-01T00:00:00Z",
                        "result": "done",
                    },
                    {
                        "id": "Task_new",
                        "name": "新单",
                        "status": "pending",
                        "progress": 0,
                        "assigned_role": "前端工程师",
                        "updated_at": "2026-08-01T00:00:00Z",
                    },
                    {
                        "id": "Task_other",
                        "name": "别人的",
                        "status": "pending",
                        "assigned_role": "后端工程师",
                        "updated_at": "2026-08-02T00:00:00Z",
                    },
                ],
            }

    monkeypatch.setattr(
        "evoflow.collab.storage.get_project_storage",
        lambda: _Storage(),
    )
    role = ProactiveRole(
        agent_code="fe",
        role_name="前端工程师",
        config=ProactiveRoleConfig(responsibilities=["UI"]),
    )
    rows = list_role_recent_tasks(role, limit=20)
    ids = [r["task_id"] for r in rows]
    assert ids == ["Task_new", "Task_old"]
    assert rows[1]["status"] == "completed"
