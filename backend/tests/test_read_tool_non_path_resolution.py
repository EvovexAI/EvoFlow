"""`read` 工具在路径解析器返回非 Path 时，必须给出可执行的错误串而不是裸崩。

【self-evolution-bot · 2026-11-18 · 第52轮 · 模型:deepseek-v4.1-flash-1017】

## 为什么要有这条测试

现网 obs 实测（2026-11-18 当日）：`read` 出现 **6 次**
```
Error: Tool 'read' failed with AttributeError: 'NoneType' object has no attribute 'suffix'
```
入参全是正常的相对路径（`backend/packages/.../tasks.py` 等），报错里**没有路径、
没有下一步动作**，调用方只能换个写法重试——这正是「多绕一步」的典型形态。

## 崩溃点是怎么定位的

- `read_file.py` 文本路径里只有两行取值后缀：`339`（PDF 判断）与 `348`（语言判断），
  两处都直接写 `resolved.suffix`；
- 上游 `if isinstance(resolved, str): return resolved` **只挡了 str**，
  `None`（或任何非 Path 意外值）会直接穿过，落到 `.suffix` 上；
- 用 `_resolve_read_target → None` 的注入实验可稳定复现同一句 AttributeError
  （见 `test_none_from_resolver_returns_error_not_crash` 的反证）。

## 为什么修的是「防线」而不是「根因」

本轮穷举了 12 种怪异入参（`.` / `/` / `~` / `skill:` / `None` / 空串 / 目录 …），
当前 `_resolve_read_target` 全部返回 Path 或错误串，**无法在本机复现该 None**。
所以没有假装找到根因，而是把「拿到非 Path 就当错误处理」这条正向断言补上：
判据是「必须拿到 Path」，任何意外类型都该在这条被挡住并说清是哪条入参。
这样即使触发条件还存在，也不会再变成一句无路径、无动作的裸崩。
"""

from __future__ import annotations

from pathlib import Path

import pytest

# 【self-evolution-bot · 2026-11-19 · 第65轮 · 模型:deepseek-v4.1-flash-1017】
# 本测试要**真构造** runtime 实例，所以取真类（轻量标记类不接受构造参数）。
from langgraph.prebuilt.tool_node import ToolRuntime

from evoflow.tools.host_direct import read_file as RF


def _runtime() -> ToolRuntime:
    return ToolRuntime(
        state={},
        context={},
        config={},
        stream_writer=None,
        tool_call_id="probe",
        store=None,
    )


@pytest.fixture()
def resolver_returns_none(monkeypatch):
    """让路径解析器返回 None —— 模拟现网那次 6 连击的形态。"""
    monkeypatch.setattr(RF, "_resolve_read_target", lambda *a, **k: None)


def test_none_from_resolver_returns_error_not_crash(resolver_returns_none):
    """反证：解析器返回 None 时必须返回错误串，绝不能抛 AttributeError。

    这条在修复前是红的（旧代码会在 resolved.suffix 处抛
    AttributeError: 'NoneType' object has no attribute 'suffix'）。
    """
    out = RF.read_file_hd.invoke({"path": "backend/some/file.py", "runtime": _runtime()})
    text = str(out)
    assert text.startswith("Error:"), text
    assert "NoneType" in text  # 说清解析器给了什么，而不是让下游崩
    assert "backend/some/file.py" in text  # 必须回显是哪条入参，否则没法自查


def test_none_from_resolver_on_image_ref_returns_error(resolver_returns_none):
    """图片路径也走同一个解析器；旧代码 `str(None)` 会得到假路径 "None"。"""
    out = RF.read_file_hd.invoke({"path": "cover.png", "runtime": _runtime()})
    text = str(out)
    assert text.startswith("Error:"), text
    assert "cover.png" in text


@pytest.mark.parametrize("weird", [None, 0, object()])
def test_any_non_path_type_is_rejected(monkeypatch, weird):
    """判据是「必须拿到 Path」，不只防 None —— 其它意外类型同样要挡住。"""
    monkeypatch.setattr(RF, "_resolve_read_target", lambda *a, **k: weird)
    out = RF.read_file_hd.invoke({"path": "x.txt", "runtime": _runtime()})
    text = str(out)
    assert text.startswith("Error:"), text


def test_normal_path_still_works(tmp_path):
    """正向断言：加防线不能误伤正常读文件。"""
    f = tmp_path / "hello.txt"
    f.write_text("line1\nline2\n", encoding="utf-8")
    out = RF.read_file_hd.invoke({"path": str(f), "runtime": _runtime()})
    text = str(out)
    assert not text.startswith("Error:"), text
    assert "line1" in text


def test_resolver_really_returns_path_for_normal_input():
    """确认正常输入确实返回 Path，证明上面的防线不是把正常路径也拦掉。

    这条同时是本测试的「夹具有效性」证明：如果 _resolve_read_target 现在
    对正常文件返回的不是 Path，那 test_normal_path_still_works 就失去了意义。
    """
    hero = Path(RF.__file__).resolve()
    assert hero.is_file()
    resolved = RF._resolve_read_target(str(hero), runtime=_runtime())
    assert isinstance(resolved, Path), type(resolved)
    assert resolved.is_file()
