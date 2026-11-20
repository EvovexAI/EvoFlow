"""read 短路径（``Wasted call``）必须按**会话**记账，不能按进程记账。

【为什么单列一份】现网 obs（agent 全岗，2026-11-12~19）里 70 次 ``Wasted call``：
- 同线程有登记 28 次（其中一部分是压缩后工具结果已被折叠）；
- 同岗别的线程 10 次、别的岗位 31 次 —— **41/70 = 58.6% 是跨线程误判**。

进程级账本 ``_SEEN`` 的键只有路径，于是 A 岗位读过的文件会让 B 岗位收到
「Wasted call — 去翻你之前那条 tool_result」，而那条根本不在 B 的上下文里。
这些测试全部走 ``read_file_hd`` 本体（``@tool`` 包装后的真实入口），
不直调 ``note_read`` —— 第33/38 轮的教训：只测函数层，接线断了照样全绿。
"""

from __future__ import annotations

import uuid
from pathlib import Path

import pytest

from evoflow.tools.host_direct.read_file import read_file_hd
from evoflow.tools.host_direct.str_replace import str_replace_hd
from evoflow.tools.host_direct.workspace_path_guard import runtime_with_workspace
from evoflow.tools.host_direct.write_file import write_file_hd
from evoflow.tools.zcode_port import read_file_state as st

_seq = iter(range(10_000))


@pytest.fixture(autouse=True)
def _clean_state():
    st.reset_read_state()
    yield
    st.reset_read_state()


def _rt(root: Path):
    return runtime_with_workspace(str(root), thread_id=f"t-{uuid.uuid4().hex[:8]}")


def _invoke_injected(tool, **kwargs):
    """write/replace 声明了 InjectedToolCallId：必须用完整 ToolCall 形态调用。"""
    call_id = f"test-call-{next(_seq)}"
    result = tool.invoke({"args": kwargs, "name": tool.name, "type": "tool_call", "id": call_id})
    return result.content if hasattr(result, "content") else result


def _mk(root: Path, rel: str = "a.txt", content: str = "hello\n") -> Path:
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")
    return p


def _read(rt, path: Path) -> str:
    out = read_file_hd.invoke({"path": str(path), "runtime": rt})
    return out.content if hasattr(out, "content") else str(out)


# ── ① 跨线程：本次会话没看过，必须拿到正文 ────────────────────────────


def test_别的线程读过的文件_本线程必须拿到正文(tmp_path):
    """A 线程读 → B 线程读同一文件：B 必须拿到内容，不许回「Wasted call」。"""
    p = _mk(tmp_path)
    rt_a = _rt(tmp_path)
    rt_b = _rt(tmp_path)

    first = _read(rt_a, p)
    assert first.startswith("hello"), first

    # A 再读：同一会话，短路仍然要生效（省 token 的原始收益不能丢）
    again = _read(rt_a, p)
    assert again.startswith("Wasted call"), again

    # B 读：进程账本里有，但 B 的上下文里没有 → 必须给正文
    cross = _read(rt_b, p)
    assert not cross.startswith("Wasted call"), f"跨线程误判复发：{cross[:120]}"
    assert "hello" in cross, cross


def test_跨线程误判_反证_按进程记账必然红(tmp_path):
    """反向验证：把 thread_id 拿掉（退回进程级判据）本用例必须失败。

    证明上面那条测试真的在测线程隔离，而不是在测「什么都没拦」。
    """
    p = _mk(tmp_path)
    rt_a = _rt(tmp_path)
    _read(rt_a, p)

    # 模拟修复前的判据：不传 thread_id → 落回进程级 _SEEN
    assert st.unchanged_since_last_read(p) is True, "进程级账本应命中（前提成立）"
    # 而带另一个线程时不许命中
    assert st.unchanged_since_last_read(p, thread_id="other-thread") is False


# ── ② 同线程：原始省 token 行为必须保留 ────────────────────────────────


def test_同线程重复读_仍然短路(tmp_path):
    p = _mk(tmp_path)
    rt = _rt(tmp_path)
    assert _read(rt, p).startswith("hello")
    out = _read(rt, p)
    assert out.startswith("Wasted call"), out


def test_write之后同线程重读_仍然短路(tmp_path):
    """write 写后回执也要登进线程账本，否则写完立刻读会白读一遍全文。"""
    rt = _rt(tmp_path)
    target = tmp_path / "notes" / "hello.txt"
    out = _invoke_injected(write_file_hd, path=str(target), content="hello evo", runtime=rt)
    assert out.startswith("OK:"), out
    back = _read(rt, target)
    assert back.startswith("Wasted call"), back


def test_replace之后同线程重读_仍然短路(tmp_path):
    rt = _rt(tmp_path)
    p = _mk(tmp_path, "b.txt", "hello evo\n")
    assert _read(rt, p).startswith("hello")
    out = _invoke_injected(
        str_replace_hd, path=str(p), old_string="hello evo", new_string="hello world", runtime=rt
    )
    assert out.startswith("OK:"), out
    assert _read(rt, p).startswith("Wasted call")


# ── ③ 压缩后：内容已被折叠，回执必须清账 ────────────────────────────────


def test_forget_thread_reads_让压缩后的重读拿到正文(tmp_path):
    """压缩把工具结果折叠掉后，同线程重读必须重新给内容（这是真缺陷现场）。"""
    p = _mk(tmp_path)
    rt = _rt(tmp_path)
    tid = st.runtime_thread_id(rt)
    assert tid, "夹具拿不到 thread_id，本测试无意义"

    assert _read(rt, p).startswith("hello")
    assert _read(rt, p).startswith("Wasted call")

    dropped = st.forget_thread_reads(tid)
    assert dropped >= 1, "本会话的读回执应当被清掉"

    after = _read(rt, p)
    assert after.startswith("hello"), f"压缩后仍被拦：{after[:120]}"


def test_forget_thread_reads_不误伤别的会话(tmp_path):
    p = _mk(tmp_path)
    rt_a = _rt(tmp_path)
    rt_b = _rt(tmp_path)
    _read(rt_a, p)
    _read(rt_b, p)

    tid_a = st.runtime_thread_id(rt_a)
    assert tid_a, "夹具拿不到 thread_id"
    st.forget_thread_reads(tid_a)
    # A 已清账 → 重读给正文
    assert _read(rt_a, p).startswith("hello")
    # B 未受影响 → 仍短路
    assert _read(rt_b, p).startswith("Wasted call")


# ── ④ 拿不到 thread_id 时保持旧行为（不扩大影响面）────────────────────


def test_无thread_id时回退进程级判据(tmp_path):
    p = _mk(tmp_path)
    st.note_read(str(p), full_read=True)
    assert st.unchanged_since_last_read(p) is True
    assert st.unchanged_since_last_read(p, thread_id="") is True


def test_部分视图不参与短路(tmp_path):
    """offset/limit/symbol 的局部视图不得登记为 full_read（zcode isPartialView 语义）。"""
    p = _mk(tmp_path, "c.txt", "\n".join(f"line{i}" for i in range(50)))
    rt = _rt(tmp_path)
    out = read_file_hd.invoke({"path": str(p), "offset": 5, "limit": 3, "runtime": rt})
    body = out.content if hasattr(out, "content") else str(out)
    assert not body.startswith("Wasted call"), body
    # 之后整读：局部视图不该让整读被短路
    full = _read(rt, p)
    assert not full.startswith("Wasted call"), full
