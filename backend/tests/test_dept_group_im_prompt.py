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
    assert "【群近期】" in block
    assert "agent_code" in block or "内部编码" in block
    assert "被点名" not in block
    assert not any(line.lstrip().startswith("# ") for line in block.splitlines())


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
