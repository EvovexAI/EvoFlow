"""右栏审计日志：工具发了什么 / 前端上报了什么，必须能在同一个文件里查到。

【self-evolution-bot · 2026-11-20 · 第101轮 · 模型:deepseek-v4.1-flash-1017】

用户原话：「我看你调用右侧工具的时候，右侧的侧边面板我没看到打开。如果你查不到
问题的话，可以加一点日志呀。到时候你可以在日志文件里看到操作了什么样的工具、
右侧有什么东西出现，或者通过一些数据和处理去查看客户端面板的实时操作。」

改动前的事实（现网实测，不是推测）：
- ``grep -c 'right-stage-emit'`` 在 ``gateway-2026-11-20.log`` 与
  ``langgraph-2026-11-20.log`` 里都是 **0** —— 上一轮加的 stdlib logger 在这两个
  进程里根本没进文件（langgraph 启动时会重建 logging 树）。
- 前端 ``logRightStage`` 落盘默认关（要手动设 localStorage）。
- ``POST /api/stage/right-stage/state`` 覆盖式单快照，不留历史。

判据（可反证）：
- 推送成功的分支必须留一行 ``[py] emit sent``，且事件全文可读（surface/kind/key）。
- 取不到 writer 必须留 ``[py] emit no-writer``，**不许**与 sent 混为一谈。
- 每次上报必须留一行 ``[web-state] report``，带 activeKey / collapsed / tabs 数 / 各签 key。
- 反向验证：把落盘函数替换成 no-op，文件必须不产生 —— 证明断言读的确实是这条路径，
  而不是别的什么顺手写出来的文件。
"""

from __future__ import annotations

import pytest

from app.gateway.routers import stage_right_panel as srp
from evoflow.stage import right_stage_audit_log as audit
from evoflow.tools.builtins import stage_tool


@pytest.fixture(autouse=True)
def _isolated_logs(tmp_path, monkeypatch):
    """审计日志落到 tmp_path，绝不污染现网 logs 目录。"""
    monkeypatch.setattr(audit, "_logs_dir", lambda: tmp_path)
    # 状态文件同样隔离：跨进程落盘会让用例互相污染。
    monkeypatch.setattr(srp, "right_stage_state_path", lambda: tmp_path / "right-stage-state.json")
    srp._STATE.clear()  # noqa: SLF001 - 测试隔离
    yield
    srp._STATE.clear()  # noqa: SLF001


def _log_lines(tmp_path) -> list[str]:
    path = audit.right_stage_log_path()
    assert path.parent == tmp_path, f"审计日志没落到隔离目录: {path}"
    if not path.is_file():
        return []
    return [ln for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip()]


def test_emit_sent_is_logged_with_event_body(tmp_path, monkeypatch):
    """writer 正常 → 必须留 sent 行，且带 surface kind / key（排查要看这些）。"""
    captured: list[dict] = []
    # stage_tool 顶部是 `from langgraph.config import get_stream_writer`（导入时快照），
    # 改 langgraph.config 上的属性**不会**影响它 —— 必须打这个模块自己的名字。
    monkeypatch.setattr(stage_tool, "get_stream_writer", lambda: captured.append)
    stage_tool._emit(
        {
            "type": "right_stage",
            "action": "show",
            "surface": {"kind": "employeeProcess", "id": "process:live:release-engineer"},
            "key": "employeeProcess:process:live:release-engineer",
        }
    )

    lines = _log_lines(tmp_path)
    assert len(captured) == 1, "事件没送到 writer，用例前提不成立"
    sent = [ln for ln in lines if "[py] emit sent" in ln]
    assert len(sent) == 1, f"没有 sent 审计行，实际: {lines}"
    assert "employeeProcess" in sent[0]
    assert "employeeProcess:process:live:release-engineer" in sent[0]


def test_emit_without_writer_is_no_writer_not_sent(tmp_path, monkeypatch):
    """取不到 writer 时必须记 no-writer，绝不能记成 sent（否则排查又被骗一次）。"""

    def boom():
        raise RuntimeError("no writer in this context")

    monkeypatch.setattr(stage_tool, "get_stream_writer", boom)
    stage_tool._emit({"type": "right_stage", "action": "show", "surface": {"kind": "shell-page"}})

    lines = _log_lines(tmp_path)
    assert any("[py] emit no-writer" in ln for ln in lines), f"缺 no-writer 审计行: {lines}"
    assert not any("[py] emit sent" in ln for ln in lines), "取不到 writer 却记了 sent"


def test_state_report_is_logged(tmp_path):
    """前端上报必须留痕：activeKey / collapsed / 各签 key。"""
    srp.post_right_stage_state(
        {
            "activeKey": "employeeProcess:process:live:release-engineer",
            "collapsed": True,
            "tabs": [
                {
                    "key": "employeeProcess:process:live:release-engineer",
                    "kind": "employeeProcess",
                    "title": "发版工程师",
                }
            ],
            "rev": 106,
        }
    )
    lines = _log_lines(tmp_path)
    hit = [ln for ln in lines if "[web-state] report" in ln]
    assert len(hit) == 1, f"没有上报审计行: {lines}"
    assert "employeeProcess:process:live:release-engineer" in hit[0]
    assert "collapsed=True" in hit[0]
    assert "tabs=1" in hit[0]


def test_log_write_is_the_source_of_assertion(tmp_path, monkeypatch):
    """反向验证：把落盘换成 no-op，同一动作必须**一条都不产生**。

    没有这一条，上面的断言可能命中别处的残留文件（我就按这种方式假绿过一次）。
    """
    monkeypatch.setattr(audit, "right_stage_log", lambda *a, **k: None)
    srp.post_right_stage_state({"activeKey": "browser:primary", "collapsed": False, "tabs": []})
    assert _log_lines(tmp_path) == [], "落盘被禁后仍有日志行 → 断言读错了来源"


def test_audit_failure_never_breaks_report(tmp_path, monkeypatch):
    """审计坏掉不许影响上报本身（日志只服务排查，不能拖垮右栏）。"""

    def boom(*_a, **_k):
        raise OSError("disk full")

    monkeypatch.setattr(audit, "right_stage_log", boom)
    out = srp.post_right_stage_state({"activeKey": "browser:primary", "collapsed": False, "tabs": []})
    assert out["ok"] is True
    assert out["activeKey"] == "browser:primary"
