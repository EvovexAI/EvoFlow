"""Department group IM system-prompt block."""

from evoflow.proactive.employee_prompting.dept_group_im import (
    build_dept_group_im_block,
    is_dept_group_im_context,
    is_dept_group_steward_context,
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


def test_build_dept_group_im_block_mentions_at_rule():
    block = build_dept_group_im_block(dept_name="研发部")
    assert "<dept_group_im" in block
    assert "研发部" in block
    assert "@角色名" in block
    assert "叫醒" in block
    assert "纯文本" in block or "普通文字" in block
    assert "Markdown" in block
    # 提示词自身也不要用 Markdown 标题井号
    assert not any(line.lstrip().startswith("# ") for line in block.splitlines())


def test_build_dept_group_im_steward_block():
    block = build_dept_group_im_block(dept_name="研发部", steward=True)
    assert "<dept_group_im" in block
    assert "小V" in block
    assert "群管家" in block
    assert "研发部" in block
    assert "分流" in block or "接住" in block or "默认" in block
    assert "@角色名" in block
    assert "Markdown" in block
    assert "被点名" not in block
    assert not any(line.lstrip().startswith("# ") for line in block.splitlines())
