"""``platform`` 顶层多传的参数被静默丢弃 —— ``title is required`` 5 次的真因。

【为什么有这份测试】**现网 obs 实测**（agent_code=self-evolution-bot，近 7 天，
``tool_name='platform'`` 且 ``error_message`` 含 ``title is required`` 共 5 条）。
逐条取 ``input_json`` 看顶层键：

    #1~#4  顶层键 = [action, args_json, confirm, title] ，args_json 里没有 title
    #5     顶层键 = [action, args_json, confirm]        ，args_json = {text: ...}

即 **4/5 的 title 其实传了**，只是放在工具顶层而不是 ``args_json`` 里。
``platform`` 的签名没有 ``title``，pydantic 默认 ``extra='ignore'`` 把它无声吃掉，
工具再回一句「你没传 title」—— 调用方看到的是「我明明传了」。

这不是报错文案问题，是**静默丢数据**：同样的写法在 ``notes`` / ``path`` / ``text``
上也会重演。修法是在工具层接住顶层额外字段并并进 args_json（显式容器优先）。

判据：用例复用现网原件；反证要覆盖「args_json 已给的键不被顶层覆盖」。
"""

from __future__ import annotations

import importlib
import json
from types import SimpleNamespace

import pytest

from evoflow.admin import platform_actions

mod = importlib.import_module("evoflow.tools.builtins.platform_tool")


@pytest.fixture()
def captured(monkeypatch: pytest.MonkeyPatch) -> dict:
    """拦在 dispatch 层，只观察工具把什么交给了 handler（不碰真实库）。"""
    box: dict = {}

    def fake_dispatch(act, args_json=None, **kwargs):
        box["act"] = act
        box["args_json"] = args_json
        return {"ok": True}

    monkeypatch.setattr(platform_actions, "dispatch_platform_action", fake_dispatch)
    return box


def _call(**kwargs):
    rt = SimpleNamespace(context={}, config={}, tool_call_id="t")
    return mod.platform_tool.func(action=kwargs.pop("action"), runtime=rt, tool_call_id="t", **kwargs)


def _args(box: dict) -> dict:
    raw = box.get("args_json")
    if isinstance(raw, str):
        return json.loads(raw or "{}")
    return dict(raw or {})


def test_顶层title必须并入args_json(captured: dict) -> None:
    """现网原件 #1~#4：title 在顶层、args_json 里没有 → 必须被接住，不许丢。"""
    _call(
        action="items.create",
        args_json={"notes": "现象：近7天 342 次调用…", "priority": "normal", "status": "todo", "tags": []},
        title="工具耗时采样",
        confirm=True,
    )
    got = _args(captured)
    assert got.get("title") == "工具耗时采样", f"顶层 title 被丢了：{got}"


def test_顶层与args_json同时给时不覆盖显式值(captured: dict) -> None:
    """反证合并方向：args_json 是显式容器，优先级必须高于顶层散字段。"""
    _call(
        action="items.create",
        args_json={"title": "容器里的"},
        title="顶层散字段",
    )
    assert _args(captured).get("title") == "容器里的"


def test_顶层text也一并接住(captured: dict) -> None:
    """现网原件 #5：只有 text 没有 title —— 至少不许把 text 也丢掉。"""
    _call(action="items.create", args_json={}, text="第28轮教训：…")
    assert _args(captured).get("text") == "第28轮教训：…"


def test_工具自身参数不被合并(captured: dict) -> None:
    """反证：action/confirm/domain 属工具参数，不该被塞进业务 args。"""
    _call(action="items.create", args_json={"title": "T"}, confirm=True, domain="items")
    got = _args(captured)
    for k in ("action", "confirm", "domain", "runtime", "tool_call_id"):
        assert k not in got, f"{k} 不该进 args_json：{got}"


def test_args_json是字符串时同样合并(captured: dict) -> None:
    """接线：模型常把 args_json 传成 JSON 字符串，合并逻辑不能只认 dict。"""
    _call(action="items.create", args_json='{"priority": "high"}', title="字符串容器")
    got = _args(captured)
    assert got.get("title") == "字符串容器", got
    assert got.get("priority") == "high", got


def test_没有多余字段时行为不变(captured: dict) -> None:
    """反证：不传额外字段时不得凭空造 args。"""
    _call(action="items.create", args_json={"title": "只有容器"})
    assert _args(captured) == {"title": "只有容器"}


def test_入参schema允许额外字段() -> None:
    """schema 层自证：默认 extra='ignore' 才是丢字段的源头。"""
    m = mod._PlatformArgsSchema.model_validate({"action": "items.create", "title": "X", "notes": "n"})
    assert m.model_extra and m.model_extra.get("title") == "X", m.model_dump()
