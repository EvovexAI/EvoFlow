"""``replace`` 的 STALE 守卫：内容真变过、但 ``old_string`` 仍唯一命中时放行。

【self-evolution-bot · 2026-11-19 · 第61轮 · 模型:deepseek-v4.1-flash-1017】

为什么有这份测试（现网依据）：obs 近 7 天 ``File has been modified since read``
共 35 次，其中 **32 次是 ``replace(old_string)``**，横跨 5 个岗位
（self-evolution-bot / fullstack-dev / document-author / …）。
最近一次 2026-11-19 00:36:17 就是我自己（改 ``assets_tool.py``）——
那次 ``old_string`` 当时就在最新内容里，替换结果是确定的，却仍被整轮打回。

守住的语义是「别对着你没看过的版本改」。当字面 ``old_string`` 在当前磁盘内容里
**唯一命中**时，替换结果与「先重读一遍再改」完全一致，这种拒绝纯属白烧一轮。
第54轮只修了 CRLF 那支（mtime 被摸、内容没变）；内容真变过的那支仍然一律拒。

判据与三条边界（本文件逐一锁住）：
1. 唯一命中 → 放行；
2. 命中 2 次以上 → 仍然拒（此时系统无法替你决定改哪一处，必须重读）；
3. ``old_string`` 太短（< 12 字符，如 ``}`` / ``return``）→ 仍然拒
   （短串「唯一命中」不携带定位信息，据它放行等于把守卫判宽）；
4. 正则模式 → 仍然拒（正则的「唯一命中」无法用于安全判定）。
"""

from __future__ import annotations

import os
import time

# 接线测试用（必须走 replace 本体，见文件末尾注释）
import uuid
from pathlib import Path

import pytest

from evoflow.tools.host_direct.read_file import read_file_hd
from evoflow.tools.host_direct.str_replace import str_replace_hd
from evoflow.tools.host_direct.workspace_path_guard import runtime_with_workspace
from evoflow.tools.zcode_port.read_file_state import (
    _STALE_ALLOW_MIN_OLD,
    edit_guard_failure,
    file_content_hash,
    note_read,
    reset_read_state,
)


@pytest.fixture(autouse=True)
def _clean_state():
    reset_read_state()
    yield
    reset_read_state()


def _seed(tmp_path: Path, body: str) -> Path:
    p = tmp_path / "victim.py"
    p.write_text(body, encoding="utf-8")
    return p


def _read_then_change(p: Path, new_body: str) -> None:
    """模拟现网真实序列：读过 → 文件被别处改过 → 模型再来改。"""
    note_read(str(p), full_read=True, content_hash=file_content_hash(p))
    time.sleep(0.01)
    p.write_text(new_body, encoding="utf-8")
    os.utime(p, None)


# ── 主用例：唯一命中必须放行 ────────────────────────────────────────────


def test_stale_but_old_string_unique_is_healed(tmp_path: Path) -> None:
    """内容真变过，但 old_string 在当前内容里唯一命中 → 放行。

    取值口径：现网 35 次 STALE 的 `old_string` 长度实测 **22~1439 字符，最小 22**
    （obs：`replace` + `modified since read`，按 length 分桶 31 行）。
    所以夹具必须用 ≥ 22 的真实量级串——之前这里用 11 字符的 `GAMMA_TOKEN`，
    比下限还短，测的是「短串仍拒」而不是「唯一命中放行」，2 条假红。
    """
    p = _seed(tmp_path, "alpha\nbeta\nGAMMA_TOKEN_UNIQUE\ndelta\n")
    _read_then_change(p, "alpha\nbeta\nGAMMA_TOKEN_UNIQUE\ndelta\nNEW_TAIL\n")

    err = edit_guard_failure(p, old_string="GAMMA_TOKEN_UNIQUE")

    assert err is None, f"唯一命中却仍被拒：{err}"


def test_healed_edit_still_targets_current_bytes(tmp_path: Path) -> None:
    """接线：放行之后真做替换，改的必须是最新字节，不许把旧版本写回去。"""
    p = _seed(tmp_path, "one\nTARGET_LINE_UNIQUE\nthree\n")
    _read_then_change(p, "zero\none\nTARGET_LINE_UNIQUE\nthree\n")

    assert edit_guard_failure(p, old_string="TARGET_LINE_UNIQUE") is None
    current = p.read_text(encoding="utf-8")
    assert current.count("TARGET_LINE_UNIQUE") == 1
    p.write_text(current.replace("TARGET_LINE_UNIQUE", "REPLACED_LINE", 1), encoding="utf-8")
    got = p.read_text(encoding="utf-8")
    assert "REPLACED_LINE" in got
    assert got.startswith("zero\n"), "替换必须落在最新内容上（zero 那行是新加的）"


# ── 反证一：命中多次仍必须拒 ────────────────────────────────────────────


def test_反证_多条命中仍判stale(tmp_path: Path) -> None:
    """命中 2 次以上 = 系统无法替你决定改哪一处，必须重读。"""
    p = _seed(tmp_path, "X_unique_first\n")
    _read_then_change(p, "DUP_TOKEN here\nDUP_TOKEN again\n")

    err = edit_guard_failure(p, old_string="DUP_TOKEN")

    assert err is not None, "多处命中却放行 = 守卫被废掉"
    assert "modified since read" in err


# ── 反证二：短串仍必须拒 ────────────────────────────────────────────────


def test_反证_过短的old_string即使唯一也拒(tmp_path: Path) -> None:
    """短串（`}` / `return`）唯一命中不携带定位信息，不许据它放行。"""
    p = _seed(tmp_path, "def f():\n    return 1\n")
    _read_then_change(p, "def g():\n    return 2\n")

    short = "return"
    assert len(short) < _STALE_ALLOW_MIN_OLD
    err = edit_guard_failure(p, old_string=short)

    assert err is not None, "短串放行 = 守卫判宽"
    assert "modified since read" in err


def test_反证_正好等于下限长度按正常判(tmp_path: Path) -> None:
    """边界：长度刚好达到下限时按「唯一命中放行」处理（不是差一杀）。"""
    p = _seed(tmp_path, "filler\n")
    needle = "A" * _STALE_ALLOW_MIN_OLD
    _read_then_change(p, f"head\n{needle}\ntail\n")

    assert edit_guard_failure(p, old_string=needle) is None


# ── 反证三：正则与 write 路径不受影响 ───────────────────────────────────


def test_反证_regex模式仍然判stale(tmp_path: Path) -> None:
    """正则模式的「唯一命中」无法用于安全判定，保持原样拒绝。"""
    p = _seed(tmp_path, "aaa\n")
    _read_then_change(p, "one\ntwo\nthree\n")

    err = edit_guard_failure(p, old_string="t.o", regex=True)

    assert err is not None, "正则模式不许走放行分支"
    assert "modified since read" in err


def test_反证_无old_string的整篇覆盖仍然判stale(tmp_path: Path) -> None:
    """``write`` 整篇覆盖没有 old_string，内容变过时必须继续要求重读。"""
    p = _seed(tmp_path, "original\n")
    _read_then_change(p, "changed elsewhere\n")

    err = edit_guard_failure(p)

    assert err is not None, "write 路径不许被这次改动放宽"
    assert "modified since read" in err


# ── 反证四：没有全量读记录时仍拦 ────────────────────────────────────────


def test_反证_从未读过时old_string不豁免(tmp_path: Path) -> None:
    """EDIT_NOT_READ 优先级高于本放行条件：没读过就是没读过。"""
    p = _seed(tmp_path, "hello\nUNIQUE_TARGET_MARKER\n")

    err = edit_guard_failure(p, old_string="UNIQUE_TARGET_MARKER")

    assert err is not None
    assert "has not been read yet" in err


# ── 接线：必须走 replace 工具本体，函数层全绿不算数 ──────────────────────
#
# 【self-evolution-bot · 2026-11-19 · 第61轮 · 模型:deepseek-v4.1-flash-1017】
# 为什么补这一段：上面 8 条只调 ``edit_guard_failure``。我把 ``str_replace.py``
# 里两处调用点的 ``old_string=.../regex=...`` 实参**整段删掉**做反向验证，
# 上面 12 条测试**全绿**——函数层根本没有接线可言，这就是「只测自己那一层」。
# 现网触发点在第 80/84 行的调用点，所以判据必须从 ``str_replace_hd`` 入口进。


def _rt(root: Path):
    return runtime_with_workspace(str(root), thread_id=f"t-{uuid.uuid4().hex[:8]}")


_seq = iter(range(10_000))


def _invoke(tool, **kwargs):
    """``replace``/``read`` 声明了 InjectedToolCallId，必须用完整 ToolCall 形态。"""
    call_id = f"test-call-{next(_seq)}"
    result = tool.invoke({"args": kwargs, "name": tool.name, "type": "tool_call", "id": call_id})
    return result.content if hasattr(result, "content") else result


def test_接线_replace入口_内容变过但old_string唯一必须放行(tmp_path: Path) -> None:
    """端到端：read → 文件被别处改过 → replace(old_string 仍唯一) 必须成功。"""
    p = tmp_path / "victim.py"
    p.write_text("alpha\nUNIQUE_TARGET_LINE_BETA\ngamma\n", encoding="utf-8")
    rt = _rt(tmp_path)

    out = _invoke(read_file_hd, path=str(p), runtime=rt)
    assert not str(out).startswith("Error:"), out

    time.sleep(0.01)
    p.write_text("prefix\nalpha\nUNIQUE_TARGET_LINE_BETA\ngamma\n", encoding="utf-8")

    out = _invoke(
        str_replace_hd,
        path=str(p),
        old_string="UNIQUE_TARGET_LINE_BETA",
        new_string="REPLACED_OK",
        runtime=rt,
    )
    msg = str(out)
    assert "modified since read" not in msg, f"唯一命中却仍判 stale：{msg}"
    assert not msg.startswith("Error:"), msg
    got = p.read_text(encoding="utf-8")
    assert "REPLACED_OK" in got
    assert got.startswith("prefix\n"), "替换必须落在最新字节上"


def test_接线_replace入口_old_string多处命中仍必须拒(tmp_path: Path) -> None:
    """反证：改过之后 old_string 命中 2 次，工具入口必须仍拒（不许判宽）。"""
    p = tmp_path / "victim.py"
    p.write_text("alpha\nDUP_TARGET_BLOCK_ONE\n", encoding="utf-8")
    rt = _rt(tmp_path)

    out = _invoke(read_file_hd, path=str(p), runtime=rt)
    assert not str(out).startswith("Error:"), out

    time.sleep(0.01)
    p.write_text("DUP_TARGET_BLOCK_ONE here\nDUP_TARGET_BLOCK_ONE again\n", encoding="utf-8")

    out = _invoke(
        str_replace_hd,
        path=str(p),
        old_string="DUP_TARGET_BLOCK_ONE",
        new_string="X",
        runtime=rt,
    )
    assert "modified since read" in str(out), f"多处命中却放行 = 守卫被废：{out}"
