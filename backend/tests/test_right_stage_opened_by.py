"""右栏 surface 出站时的「谁打开的」盖章 —— 回归测试。

【self-evolution-bot · 2026-11-23 · 第128轮 · 模型:deepseek-v4.1-flash】新建。

用户原话（2026-11-23）：「右侧侧边那个地方，其实要加上一个标识，说明这个是谁打开的……
否则我在 A 处打开的截图在别处出现时，不知道是谁打开的，就容易错乱。」

判据（每条都对应一个会真出错的场景）：
- A. 出口永远只有**恰好一层** ``agent:`` 前缀。本轮实测 ``agent:release-engineer``
  这类已带前缀的 actor 会被拼成 ``agent:agent:release-engineer`` → 前端查不到
  岗位中文名，签上只剩裸串。所以这里专门喂带前缀的值。
- B. main/user/auto/lead_agent/system 一律不出章。把用户操作标成「智能体打开的」
  比不标更糟（谎报），宁可返回空让前端兜底成会话归属。
- C. 无 actor 时返回空串（前端按 ``session:<sessionKey>`` 兜底），**绝不兜 user**。
- D. ``_emit_surface`` 是唯一出口：surface 自带 openedBy 时不许被 actor 覆盖。
"""

from __future__ import annotations

import pytest

from evoflow.authz.agent_actor import set_current_agent_actor
from evoflow.tools.builtins.stage_tool import _emit_surface, _resolve_opened_by_actor


@pytest.fixture(autouse=True)
def _clear_actor():
    set_current_agent_actor(None)
    yield
    set_current_agent_actor(None)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("proactive:release-engineer:task", "agent:release-engineer"),
        ("proactive:tech-director:chat", "agent:tech-director"),
        # 已带前缀的两种形态都必须收敛成一层
        ("agent:release-engineer", "agent:release-engineer"),
        ("agent:agent:tech-director", "agent:tech-director"),
        ("agent:agent:agent:x:task", "agent:x"),
        ("release-engineer", "agent:release-engineer"),
        ("sw-nobody", "agent:sw-nobody"),
    ],
)
def test_actor_normalizes_to_exactly_one_agent_prefix(raw: str, expected: str) -> None:
    set_current_agent_actor(raw)
    assert _resolve_opened_by_actor() == expected


@pytest.mark.parametrize("raw", [None, "", "user", "main", "auto", "lead_agent", "system", "USER"])
def test_non_employee_actor_never_stamps(raw: str | None) -> None:
    # 空串同样走这里：NULL 就是「取不到」，下游按会话兜底。
    assert _resolve_opened_by_actor() == ""


def test_emit_surface_stamps_actor(monkeypatch) -> None:
    captured: list[dict] = []
    monkeypatch.setattr("evoflow.tools.builtins.stage_tool._emit", captured.append)
    set_current_agent_actor("proactive:release-engineer:task")

    _emit_surface("show", {"kind": "file", "id": "a"})

    assert len(captured) == 1
    assert captured[0]["surface"]["openedBy"] == "agent:release-engineer"


def test_emit_surface_does_not_overwrite_existing(monkeypatch) -> None:
    captured: list[dict] = []
    monkeypatch.setattr("evoflow.tools.builtins.stage_tool._emit", captured.append)
    set_current_agent_actor("proactive:release-engineer:task")

    _emit_surface("show", {"kind": "file", "id": "a", "openedBy": "user"})

    # 前端已经明确说是用户亲手打开的，后端不许改成 agent
    assert captured[0]["surface"]["openedBy"] == "user"


def test_emit_surface_leaves_unstamped_when_no_actor(monkeypatch) -> None:
    captured: list[dict] = []
    monkeypatch.setattr("evoflow.tools.builtins.stage_tool._emit", captured.append)

    _emit_surface("show", {"kind": "file", "id": "a"})

    # 不写字段（而不是写空串），前端据此按 session:<key> 兜底
    assert "openedBy" not in captured[0]["surface"]
