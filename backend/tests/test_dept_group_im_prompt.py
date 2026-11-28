"""Department group IM system-prompt block."""

from evoflow.proactive.employee_prompting.dept_group_im import (
    build_dept_group_im_block,
    is_dept_group_im_context,
    is_dept_group_steward_context,
    normalize_dept_group_roster,
)


def test_is_dept_group_im_context_flags():
    assert is_dept_group_im_context({"dept_group_im": True}) is True
    assert is_dept_group_im_context({"dept_group_im": "true"}) is True
    assert is_dept_group_im_context({"dept_group_id": "rd-1"}) is True
    assert is_dept_group_im_context({}) is False
    assert is_dept_group_im_context(None) is False


def test_is_dept_group_steward_context_flags():
    assert is_dept_group_steward_context({"dept_group_steward": True}) is True
    assert is_dept_group_steward_context({"dept_group_steward": "1"}) is True
    assert is_dept_group_steward_context({"dept_group_im": True}) is False
    assert is_dept_group_steward_context({}) is False
    assert is_dept_group_steward_context(None) is False


def test_normalize_dept_group_roster():
    assert normalize_dept_group_roster(["技术总监", "测试工程师", "技术总监"]) == [
        "技术总监",
        "测试工程师",
    ]
    assert normalize_dept_group_roster(
        [{"role_name": "全栈工程师", "agent_code": "fs"}, {"agent_code": "qa"}]
    ) == ["全栈工程师", "qa"]
    assert normalize_dept_group_roster(None) == []
    assert normalize_dept_group_roster("nope") == []


def test_build_dept_group_im_block_mentions_at_rule():
    block = build_dept_group_im_block(dept_name="研发部")
    assert "<dept_group_im" in block
    assert "研发部" in block
    assert "@角色名" in block
    assert "何时不要 @" in block or "不要再 @ 同事" in block
    assert "打招呼" in block
    assert "纯文本" in block or "普通文字" in block
    assert "Markdown" in block
    assert "岗位" in block or "角色名" in block
    assert "agent_code" in block or "内部编码" in block
    assert "旧任务" in block or "站立摘要" in block
    # 提示词自身也不要用 Markdown 标题井号
    assert not any(line.lstrip().startswith("# ") for line in block.splitlines())


def test_build_dept_group_im_steward_block():
    block = build_dept_group_im_block(
        dept_name="研发部",
        steward=True,
        roster=["技术总监", "测试工程师", "全栈工程师"],
    )
    assert "<dept_group_im" in block
    assert "小V" in block
    assert "群管家" in block
    assert "研发部" in block
    assert "分流" in block or "接住" in block or "默认" in block
    assert "@角色名" in block
    assert "何时 @" in block
    assert "打招呼" in block
    assert "Markdown" in block
    assert "本群可点名：技术总监、测试工程师、全栈工程师" in block
    assert "<dept_group_recent>" in block
    assert "<dept_group_instruction>" in block
    assert "agent_code" in block or "内部编码" in block
    assert "employees.dispatch" in block
    assert "同群说话走群聊会话" in block or "群聊 sticky" in block
    assert "chat_send" in block
    assert "被点名" not in block
    assert not any(line.lstrip().startswith("# ") for line in block.splitlines())


def test_build_dept_group_im_member_block_forbids_dispatch_instead_of_at():
    block = build_dept_group_im_block(dept_name="氛围部")
    assert "chat_send" in block
    assert "dispatch" in block
    assert "同群说话走群聊会话" in block or "群聊 sticky" in block
    assert "私有岗" in block or "本群看不见" in block or "1:1" in block


def test_reject_dept_group_private_ping_blocks_roster_mate(monkeypatch):
    from evoflow.proactive.employee_prompting import dept_group_im as mod

    monkeypatch.setattr(
        mod,
        "resolve_dept_group_im_from_session",
        lambda _sk: (True, "AIGC部", False, ["AIGC 导演", "漫剧编剧"]),
    )
    reason = mod.reject_dept_group_private_ping(
        caller_session_key="proactive:manju-director:chat:dept-x",
        target_agent_code="manju-writer",
        target_role_name="漫剧编剧",
    )
    assert reason
    assert "@" in reason
    assert "dispatch" in reason or "wake" in reason


def test_reject_dept_group_private_ping_allows_outside_group(monkeypatch):
    from evoflow.proactive.employee_prompting import dept_group_im as mod

    monkeypatch.setattr(
        mod,
        "resolve_dept_group_im_from_session",
        lambda _sk: (True, "AIGC部", False, ["AIGC 导演", "漫剧编剧"]),
    )

    def _no_db_dept(*_a, **_k):
        class _Fake:
            def execute(self, *_args, **_kwargs):
                class _R:
                    def fetchone(self):
                        return {"department": "内容运营部", "role_name": "别人"}

                return _R()

        return _Fake()

    import evoflow.persistence.db as db_mod

    monkeypatch.setattr(db_mod, "get_db", _no_db_dept)
    reason = mod.reject_dept_group_private_ping(
        caller_session_key="proactive:manju-director:chat:dept-x",
        target_agent_code="content-ops",
        target_role_name="内容运营",
    )
    assert reason is None


def test_resolve_dept_group_chat_route_pins_sticky(monkeypatch):
    from evoflow.proactive.employee_prompting import dept_group_im as mod

    monkeypatch.setattr(
        mod,
        "resolve_dept_group_im_from_session",
        lambda _sk: (True, "AIGC部", False, ["AIGC 导演", "漫剧编剧"]),
    )
    monkeypatch.setattr(
        "evoflow.persistence.session_repositories.get_session_context_for_run_config",
        lambda _sk: {"dept_group_id": "d40263165395", "dept_group_im": True},
    )
    route = mod.resolve_dept_group_chat_route(
        caller_session_key="proactive:manju-director:chat:dept-d40263165395",
        target_agent_code="manju-writer",
        target_role_name="漫剧编剧",
    )
    assert route is not None
    assert route["sticky_session_key"] == "proactive:manju-writer:chat:dept-d40263165395"
    assert route["timeline_session_key"] == "dept:d40263165395:chat"


def test_build_dept_group_im_steward_empty_roster():
    block = build_dept_group_im_block(dept_name="研发部", steward=True, roster=[])
    assert "花名册暂空" in block


def test_refresh_dept_group_im_in_prompt_replaces_block(monkeypatch):
    from evoflow.proactive.employee_prompting import dept_group_im as mod

    def _fake_resolve(_sk):
        return True, "研发部", True, ["技术总监", "测试工程师"]

    monkeypatch.setattr(mod, "resolve_dept_group_im_from_session", _fake_resolve)
    old = "prefix\n\n" + build_dept_group_im_block(dept_name="旧部门", steward=True, roster=["旧人"])
    out = mod.refresh_dept_group_im_in_prompt(old, "proactive:xiaomi:chat:dept-rd")
    assert "prefix" in out
    assert "旧部门" not in out
    assert "旧人" not in out
    assert "本群可点名：技术总监、测试工程师" in out
    assert out.count("<dept_group_im") == 1
