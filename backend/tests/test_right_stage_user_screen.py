"""右栏「用户当前在看哪一页」必须可查、且开面板时要带上。

【self-evolution-bot · 2026-11-20 · 第100轮 · 模型:deepseek-v4.1-flash-1017】

用户原话：「你知道我当前右侧标签页是哪个吗？这个在你的管理体系里边能查到吗？
没有的话，你应该处理好，因为有可能有些时候用户还在右侧拉开了一些东西，
所以说你要知道当前是哪一个，然后怎么去切换到哪一个要处理好。」

改动前的事实：``grep activeKey backend --include=*.py`` 命中 0 次 ——
右栏状态只活在前端内存，后端一无所知，模型 ui.show 只能盲开。

判据（可反证）：
- 从没上报时 ``known=False``（不许假装「右栏是空的」）。
- 上报后 ``ui.current`` 读回同一份 activeKey / activeKind / tabs。
- 开面板的返回里带 ``userScreen``：同类页面 → ``reusedSameKindTab=True`` 且不抢焦点；
  跨类页面 → ``mayStealFocus=True`` 并给出提示。
"""

from __future__ import annotations

import pytest

from app.gateway.routers import stage_right_panel as srp


@pytest.fixture(autouse=True)
def _clean_state(tmp_path, monkeypatch):
    # 【self-evolution-bot · 2026-11-20 · 第100轮续 · 模型:deepseek-v4.1-flash-1017】
    # 改了什么：隔离从「只清内存」改为「指向临时盘文件 + 清内存」。
    # 为什么：状态现在会落盘跨进程共享，只清 _STATE 时上一条用例写的盘文件会被
    #   read_right_stage_state() 回读出来 → test_unknown_before_first_report 变成假红/假绿。
    #   隔离必须覆盖**它实际读的每一处**（内存 + 盘），否则测的是上一条用例的残留。
    state_file = tmp_path / "right-stage-state.json"
    monkeypatch.setattr(srp, "right_stage_state_path", lambda: state_file)
    # 【self-evolution-bot · 2026-11-20 · 第101轮 · 模型:deepseek-v4.1-flash-1017】
    # 改了什么：把审计日志目录也隔离到 tmp_path。
    # 为什么（本轮自撞）：跑这批用例时 ``_emit`` 走 no-writer 分支，把 6 行
    #   ``[py] emit no-writer ... RuntimeError: Called get_config outside of a runnable
    #   context`` 写进了用户现网 ``right-stage-2026-11-20.log`` —— 那是我要拿来
    #   当证据的文件，被测试自己污染了。隔离必须覆盖**实际写的每一处**，
    #   内存 + 状态盘 + 审计日志，三处缺一不可。
    from evoflow.stage import right_stage_audit_log as audit

    monkeypatch.setattr(audit, "_logs_dir", lambda: tmp_path)
    srp._STATE.clear()  # noqa: SLF001 - 测试隔离：清掉上一条用例残留
    yield
    srp._STATE.clear()  # noqa: SLF001


def test_unknown_before_first_report():
    """从没上报过时不许假设「右栏为空」。"""
    out = srp.read_right_stage_state()
    assert out["known"] is False
    assert out["reason"] == "no_report_yet"


def test_report_then_read_back():
    """前端上报什么，ui.current 就得读回什么。"""
    saved = srp.store_right_stage_state(
        {
            "activeKey": "employeeProcess:process:live:reviewer",
            "activeKind": "employeeProcess",
            "activeTitle": "审核员",
            "collapsed": False,
            "tabs": [
                {
                    "key": "employeeProcess:process:live:reviewer",
                    "kind": "employeeProcess",
                    "title": "审核员",
                    "data": {"agentCode": "reviewer"},
                },
                {"key": "file:docs/a.md", "kind": "file", "title": "a.md", "data": {"path": "docs/a.md"}},
            ],
            "rev": 7,
        }
    )
    assert saved["activeKey"] == "employeeProcess:process:live:reviewer"

    out = srp.read_right_stage_state()
    assert out["known"] is True
    assert out["activeKey"] == "employeeProcess:process:live:reviewer"
    assert out["activeKind"] == "employeeProcess"
    assert len(out["tabs"]) == 2


def test_ui_current_reports_unknown_honestly():
    """platform ui.current 在未知时必须给 hint，不能编一个空右栏。"""
    from evoflow.admin.platform_handlers import ui_current

    out = ui_current({})
    assert out["known"] is False
    assert "未知右栏状态" in out["hint"]


def test_ui_current_reads_reported_state():
    srp.store_right_stage_state(
        {
            "activeKey": "file:docs/b.md",
            "activeKind": "file",
            "activeTitle": "b.md",
            "tabs": [{"key": "file:docs/b.md", "kind": "file", "title": "b.md"}],
        }
    )
    from evoflow.admin.platform_handlers import ui_current

    out = ui_current({})
    assert out["known"] is True
    assert out["activeKind"] == "file"
    assert out["activeTitle"] == "b.md"


def test_show_same_kind_reuses_tab_without_stealing_focus():
    """用户正看着 employeeProcess，再开 employeeProcess → 应判为原地复用。"""
    srp.store_right_stage_state(
        {
            "activeKey": "employeeProcess:process:live:reviewer",
            "activeKind": "employeeProcess",
            "activeTitle": "审核员",
            "tabs": [{"key": "employeeProcess:process:live:reviewer", "kind": "employeeProcess"}],
        }
    )
    from evoflow.tools.builtins.stage_tool import apply_right_panel

    out = apply_right_panel(
        action="show",
        kind="employeeProcess",
        data={"agentCode": "reviewer", "taskId": "live:reviewer"},
    )
    assert out["ok"] is True
    screen = out["userScreen"]
    assert screen["known"] is True
    assert screen["reusedSameKindTab"] is True
    assert screen["mayStealFocus"] is False
    assert screen["before"]["activeKind"] == "employeeProcess"


def test_show_other_kind_flags_focus_steal():
    """用户正看着文件，模型却要开网页 → 必须标记可能抢焦点。"""
    srp.store_right_stage_state(
        {
            "activeKey": "file:docs/a.md",
            "activeKind": "file",
            "activeTitle": "a.md",
            "tabs": [{"key": "file:docs/a.md", "kind": "file"}],
        }
    )
    from evoflow.tools.builtins.stage_tool import apply_right_panel

    out = apply_right_panel(
        action="show",
        kind="web-embed",
        data={"url": "https://example.com"},
    )
    assert out["ok"] is True
    screen = out["userScreen"]
    assert screen["mayStealFocus"] is True
    assert screen["reusedSameKindTab"] is False
    assert screen["before"]["activeKey"] == "file:docs/a.md"


def test_show_unknown_state_says_so():
    """没上报过时，开面板也要如实说「无法判断是否抢视线」。"""
    from evoflow.tools.builtins.stage_tool import apply_right_panel

    out = apply_right_panel(action="show", kind="web-embed", data={"url": "https://example.com"})
    assert out["ok"] is True
    assert out["userScreen"]["known"] is False
    assert "无法判断" in out["userScreen"]["note"]


def test_state_crosses_process_boundary_via_disk(tmp_path, monkeypatch):
    """【self-evolution-bot · 2026-11-20 · 第100轮续 · 模型:deepseek-v4.1-flash-1017】

    改了什么：新增跨进程回归用例 —— 另一个 Python 进程（不同 PID）必须能读到上报。
    为什么（现网实测的真缺陷）：打包形态下 gateway 与模型工具是**两个进程**：
        网关     gateway_entry.py --mode gateway   --port 8382
        工具     gateway_entry.py --mode langgraph --port 8384
      而状态原来是模块级 dict，各进程一份。实测同一秒：curl GET 返回 known:true，
      而 platform ui.current 返回 known:false/no_report_yet —— 读侧「通了但永远空」。
      只用同进程断言永远发现不了这种缺陷（同进程读自己的内存当然对）。
    判据：写入进程 A 后，进程 B（subprocess，空内存）读盘必须拿到同一 activeKey；
      盘上没有时 B 必须老实返回 known:false。
    """
    import json
    import subprocess
    import sys

    state_file = tmp_path / "cross" / "right-stage-state.json"
    state_file.parent.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(srp, "right_stage_state_path", lambda: state_file)

    srp._STATE.clear()  # noqa: SLF001
    srp.store_right_stage_state(
        {
            "activeKey": "shell-page:tasks",
            "activeKind": "shell-page",
            "activeTitle": "任务",
            "tabs": [{"key": "shell-page:tasks", "kind": "shell-page", "title": "任务"}],
            "rev": 11,
        }
    )
    assert state_file.is_file(), "写侧必须真的落盘，否则另一个进程看不到"

    script = (
        "import json,sys\n"
        "from pathlib import Path\n"
        "sys.path.insert(0,'packages/harness')\n"
        "data=json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))\n"
        "print(json.dumps({'activeKey':data.get('activeKey'),'activeKind':data.get('activeKind'),"
        "'tabs':len(data.get('tabs') or []),'rev':data.get('rev')}))\n"
    )
    out = subprocess.run(
        [sys.executable, "-c", script, str(state_file)],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert out.returncode == 0, out.stderr
    payload = json.loads(out.stdout.strip().splitlines()[-1])
    assert payload["activeKey"] == "shell-page:tasks"
    assert payload["activeKind"] == "shell-page"
    assert payload["tabs"] == 1
    assert payload["rev"] == 11


def test_read_falls_back_to_disk_when_memory_is_empty(tmp_path, monkeypatch):
    """【self-evolution-bot · 2026-11-20 · 第100轮续 · 模型:deepseek-v4.1-flash-1017】

    改了什么：新增读侧落盘兜底的回归用例 —— 清空进程内存后 read 必须仍能拿到状态。
    为什么：现网 gateway（写）与模型工具（读）是两个进程，工具进程的 ``_STATE``
      永远是空的。上一版只从内存读，于是 ``ui.current`` 恒 known=false。
      只测「写进盘里有什么」抓不到这个问题 —— 必须测「内存空时读到哪里」。
    判据：清空 _STATE 后 read_right_stage_state() 仍返回 known=True 且 activeKey 一致；
      盘文件不存在时仍老实返回 known=False。
    """
    state_file = tmp_path / "fallback" / "right-stage-state.json"
    state_file.parent.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(srp, "right_stage_state_path", lambda: state_file)

    srp._STATE.clear()  # noqa: SLF001
    # 盘上还没有：必须老实说未知
    assert srp.read_right_stage_state()["known"] is False

    srp.store_right_stage_state(
        {
            "activeKey": "web-embed:primary",
            "activeKind": "web-embed",
            "activeTitle": "网页",
            "tabs": [{"key": "web-embed:primary", "kind": "web-embed", "title": "网页"}],
            "rev": 21,
        }
    )
    # 模拟「另一个进程」：内存清空，只能靠盘
    srp._STATE.clear()  # noqa: SLF001

    out = srp.read_right_stage_state()
    assert out["known"] is True
    assert out["activeKey"] == "web-embed:primary"
    assert out["activeKind"] == "web-embed"
    assert out["rev"] == 21


def test_read_prefers_newer_disk_snapshot_over_stale_memory(tmp_path, monkeypatch):
    """【self-evolution-bot · 2026-11-21 · 第104轮 · 模型:deepseek-v4.1-flash-1017】

    改了什么：新增「内存有值但更旧」的回归用例。
    为什么（本轮真机实测，用户侧表现「你现在也控制不了」）：
      前端上报打进 **gateway** 进程，而 ``ui.current`` 跑在 **langgraph 工具进程**。
      工具进程一旦先读到过一份旧快照并留在 ``_STATE``，旧写法「内存非空就绝不看盘」
      就会永久压住后来更新的那份 —— 实证 11:13:55 盘上 rev=28（active=browser:primary），
      工具侧同一时刻回 rev=5（reportedAt 03:10:21Z），整整差 3 分半。
    判据：内存 rev 较旧时，读必须返回落盘那份（rev、activeKey 都以盘为准）；
      内存较新时仍用内存，不能反向压住。
    """
    state_file = tmp_path / "newer" / "right-stage-state.json"
    state_file.parent.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(srp, "right_stage_state_path", lambda: state_file)

    # 模拟工具进程里残留的旧快照
    srp._STATE.clear()  # noqa: SLF001
    srp._STATE.update(  # noqa: SLF001
        {
            "activeKey": "employeeProcess:process:live:atmosphere-emotion-bot",
            "activeKind": "employeeProcess",
            "activeTitle": "情绪陪伴Bot",
            "collapsed": True,
            "tabs": [],
            "rev": 5,
            "reportedAt": "2026-11-21T03:10:21.009Z",
        }
    )
    # 另一个进程（gateway）刚写下的更新快照
    srp._write_state_file(
        {
            "activeKey": "browser:primary",
            "activeKind": "browser",
            "activeTitle": "浏览器",
            "collapsed": False,
            "tabs": [{"key": "browser:primary", "kind": "browser", "title": "浏览器"}],
            "rev": 28,
            "reportedAt": "2026-11-21T03:13:54.661Z",
        }
    )

    out = srp.read_right_stage_state()
    assert out["rev"] == 28, "内存 rev=5 更旧，必须让位给盘上 rev=28"
    assert out["activeKey"] == "browser:primary"
    assert out["collapsed"] is False

    # 反向：内存更新时不能被盘压回去
    srp._STATE.update({"activeKey": "web-embed:primary", "activeKind": "web-embed", "rev": 30})  # noqa: SLF001
    out2 = srp.read_right_stage_state()
    assert out2["rev"] == 30
    assert out2["activeKey"] == "web-embed:primary"


def test_old_frontend_payload_with_empty_tab_keys_is_repaired(tmp_path, monkeypatch):
    """【self-evolution-bot · 2026-11-20 · 第100轮续 · 模型:deepseek-v4.1-flash-1017】

    改了什么：后端补 key —— 老前端上报 ``key:""`` / ``activeKind:null`` 时必须读得出真相。
    为什么（现网实测原文，2026-11-20 21:37:34 那份上报）::

        {"activeKey":"employeeProcess:process:live:release-engineer",
         "activeKind":null,"activeTitle":null,
         "tabs":[{"key":"","kind":"employeeProcess","title":"审核员",...},
                 {"key":"","kind":"employeeProcess","title":"发版工程师",...}]}

    打包 exe 内嵌的是旧前端（它读 ``surface.key``，而 RightStageSurface 没有这个字段），
    于是每个 tab 的 key 都是空串、activeKind 找不到活动签就是 null。
    若后端原样保存，模型拿到的就是「有一堆标签但全都无键、当前页类型未知」——
    等于查到了却没法用（也就没法切签）。
    判据：key 必须补成 ``${kind}:${id}`` 或能从 activeKey 反查；
      activeKind / activeTitle 必须由 activeKey 命中回填，不得为 null。
    """
    state_file = tmp_path / "legacy" / "right-stage-state.json"
    state_file.parent.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(srp, "right_stage_state_path", lambda: state_file)
    srp._STATE.clear()  # noqa: SLF001

    saved = srp.store_right_stage_state(
        {
            "activeKey": "employeeProcess:process:live:release-engineer",
            "activeKind": None,
            "activeTitle": None,
            "collapsed": True,
            "tabs": [
                {
                    "key": "",
                    "kind": "employeeProcess",
                    "title": "审核员",
                    "sessionKey": "proactive:x:chat:1",
                    "data": {"agentCode": "reviewer"},
                },
                {
                    "key": "",
                    "kind": "employeeProcess",
                    "title": "发版工程师",
                    "sessionKey": "proactive:x:chat:1",
                    "data": {"agentCode": "release-engineer"},
                },
            ],
            "rev": 41,
        }
    )

    # activeKind 能从 activeKey 的 ``kind:`` 前缀精确回填 —— 这是事实，不是猜。
    assert saved["activeKind"] == "employeeProcess"
    # 但 title 只能靠 activeKey 命中同一 tab；老前端没报 id → key 补不出来 →
    # 命中不了 → 必须留 None，不许按 title 猜一个（猜错会让 ui.activate 指错签）。
    assert saved["activeTitle"] is None
    # 补不了 key 就如实标记，模型据此知道「能读当前页、还不能按 key 切签」。
    assert saved["keysRepairable"] is False

    out = srp.read_right_stage_state()
    assert out["known"] is True
    assert out["activeKind"] == "employeeProcess"
    assert out["keysRepairable"] is False


def test_tab_with_id_gets_key_repaired(tmp_path, monkeypatch):
    """有 id 时必须补出 ``${kind}:${id}``，这是能精确补的那一半。

    【self-evolution-bot · 2026-11-20 · 第100轮续 · 模型:deepseek-v4.1-flash-1017】
    为什么单列一条：上一轮我只写了「补不了要标记」，若不写「有 id 时必须补上」，
    整段补 key 逻辑删掉也能全绿 —— 那等于没测。
    """
    state_file = tmp_path / "repairable" / "right-stage-state.json"
    state_file.parent.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(srp, "right_stage_state_path", lambda: state_file)
    srp._STATE.clear()  # noqa: SLF001

    saved = srp.store_right_stage_state(
        {
            "activeKey": "shell-page:tasks",
            "activeKind": None,
            "activeTitle": None,
            "collapsed": False,
            "tabs": [
                {"key": "", "kind": "shell-page", "id": "tasks", "title": "任务"},
                {"key": "", "kind": "employeeProcess", "id": "process:live:reviewer", "title": "审核员"},
            ],
            "rev": 9,
        }
    )
    keys = [t["key"] for t in saved["tabs"]]
    assert keys == ["shell-page:tasks", "employeeProcess:process:live:reviewer"]
    assert saved["keysRepairable"] is True
    assert saved["activeKind"] == "shell-page"
    assert saved["activeTitle"] == "任务"


def test_emit_logs_when_writer_missing(caplog):
    """【self-evolution-bot · 2026-11-20 · 第100轮续 · 模型:deepseek-v4.1-flash-1017】

    改了什么：给 `_emit` 加日志后必须有门禁 —— writer 拿不到 / 不可调用 / 抛异常
      三种情况都要留下可 grep 的痕迹，且都不能把异常抛给调用方。
    为什么（用户当场要求）：「如果你查不到问题的话，可以加一点日志呀。到时候你可以
      在日志文件里看到操作了什么样的工具、右侧有什么东西出现。」
      此前这里是 `except: pass`：工具返回 ok、屏幕上什么都没变、日志里一个字都没有，
      我只能靠猜。判据必须盯住「有没有留下痕迹」，而不是「有没有报错」。
    """
    import logging

    from evoflow.tools.builtins import stage_tool

    # 情形一：取 writer 直接抛异常（非 LangGraph 上下文）
    def _boom():
        raise RuntimeError("no stream writer here")

    orig = stage_tool.get_stream_writer
    try:
        stage_tool.get_stream_writer = _boom
        with caplog.at_level(logging.WARNING, logger=stage_tool._RIGHT_STAGE_LOGGER_NAME):
            stage_tool._emit({"type": "right_stage", "action": "show", "surface": {"kind": "shell-page"}})
        assert any("no writer" in r.getMessage() for r in caplog.records), caplog.text

        # 情形二：writer 存在但不可调用 —— 这条最关键：返回值 ok 但通道根本不存在
        caplog.clear()
        stage_tool.get_stream_writer = lambda: None
        with caplog.at_level(logging.WARNING, logger=stage_tool._RIGHT_STAGE_LOGGER_NAME):
            stage_tool._emit({"type": "right_stage", "action": "show", "surface": {"kind": "shell-page"}})
        assert any("not callable" in r.getMessage() for r in caplog.records), caplog.text

        # 情形三：writer 可调用但内部抛错
        caplog.clear()

        def _fail(_event):
            raise ValueError("sse closed")

        stage_tool.get_stream_writer = lambda: _fail
        with caplog.at_level(logging.WARNING, logger=stage_tool._RIGHT_STAGE_LOGGER_NAME):
            stage_tool._emit({"type": "right_stage", "action": "show", "surface": {"kind": "shell-page"}})
        assert any("writer failed" in r.getMessage() for r in caplog.records), caplog.text
    finally:
        stage_tool.get_stream_writer = orig


# 【self-evolution-bot · 2026-11-20 · 第101轮 · 模型:deepseek-v4.1-flash-1017】
# 改了什么：新增两条用例，锁住「ok 不等于用户看见」。
# 为什么（本轮现网实测，同一秒双侧日志）：
#   23:22:57.538 [py] emit sent action=show（未传 expand）
#   23:22:57.976 [web-state] collapsed=True   ← 用户屏幕上什么都没出现
#   补 expand=true 后 23:23:27.909 [py] → 23:23:28.583 [web-state] collapsed=False
#   旧返回只有 ok:true，模型据此就会对用户说「已经打开了」，是假成功。
# 判据：收起态 + 未传 expand → visible=False 且带可执行 hint；
#   收起态 + expand=True → visible=True；本来就没收起 → visible=True。三态必须可区分。
def test_show_while_collapsed_reports_invisible_with_hint():
    srp.store_right_stage_state(
        {
            "activeKey": "file:docs/a.md",
            "activeKind": "file",
            "activeTitle": "a.md",
            "collapsed": True,
            "tabs": [{"key": "file:docs/a.md", "kind": "file"}],
        }
    )
    from evoflow.tools.builtins.stage_tool import apply_right_panel

    out = apply_right_panel(action="show", kind="web-embed", data={"url": "https://example.com"})
    screen = out["userScreen"]
    assert screen["visible"] is False
    assert "expand" in screen["hint"]
    assert "不可见" in screen["note"]


def test_show_while_collapsed_with_expand_is_visible():
    srp.store_right_stage_state(
        {
            "activeKey": "file:docs/a.md",
            "activeKind": "file",
            "activeTitle": "a.md",
            "collapsed": True,
            "tabs": [{"key": "file:docs/a.md", "kind": "file"}],
        }
    )
    from evoflow.tools.builtins.stage_tool import apply_right_panel

    out = apply_right_panel(
        action="show", kind="web-embed", data={"url": "https://example.com"}, expand=True
    )
    screen = out["userScreen"]
    assert screen["visible"] is True
    assert "hint" not in screen
    assert out["surface"]["expand"] is True


def test_show_when_not_collapsed_is_visible():
    srp.store_right_stage_state(
        {
            "activeKey": "file:docs/a.md",
            "activeKind": "file",
            "activeTitle": "a.md",
            "collapsed": False,
            "tabs": [{"key": "file:docs/a.md", "kind": "file"}],
        }
    )
    from evoflow.tools.builtins.stage_tool import apply_right_panel

    out = apply_right_panel(action="show", kind="web-embed", data={"url": "https://example.com"})
    assert out["userScreen"]["visible"] is True


def test_employee_process_branch_also_reports_invisible():
    """进度类面板走独立 return 分支，必须同样带 visible —— 上一轮就是这样漏了一处。"""
    srp.store_right_stage_state(
        {
            "activeKey": "file:docs/a.md",
            "activeKind": "file",
            "activeTitle": "a.md",
            "collapsed": True,
            "tabs": [{"key": "file:docs/a.md", "kind": "file"}],
        }
    )
    from evoflow.tools.builtins.stage_tool import apply_right_panel

    out = apply_right_panel(
        action="show", kind="employeeProcess", data={"agentCode": "reviewer"}
    )
    assert out["ok"] is True
    assert out["userScreen"]["visible"] is False
    assert "expand" in out["userScreen"]["hint"]


# ── 第103轮：keyHint 必须逐字等于前端真实 tab key（端到端，不测函数层）──────────
# 【self-evolution-bot · 2026-11-21 · 第103轮 · 模型:deepseek-v4.1-flash-1017】
# 为什么补这三条：本轮真机实测的缺陷是「工具回我的 keyHint，拿去 ui.activate 必失败」——
#   employeeProcess 我报 process:xiaomi，前端实际建的是 process:live:xiaomi；
#   shell-page 我报 primary，前端实际是 shell:/tasks。
#   旧测试只测了 userScreen 的字段形状，没锁住「id 与前端一致」这件事，所以一直绿。
# 判据：store.tabKeyOf = ``${kind}:${id}``，故 keyHint 必须等于 ``{kind}:{前端opener算出的id}``。

@pytest.mark.parametrize(
    ("kind", "data", "real_id"),
    [
        # 对话侧一人一签（open-employee-process-stage.ts:76-92）
        ("employeeProcess", {"agentCode": "xiaomi"}, "process:live:xiaomi"),
        # sessionRuntime:{sessionKey}（open-session-runtime-stage.ts:16-19）
        ("sessionRuntime", {"sessionKey": "agent:main:new-1"}, "sessionRuntime:agent:main:new-1"),
        # shell:{normalizePath(path)}（shell-page-mount-table.ts:186-189）
        ("shell-page", {"path": "/tasks"}, "shell:/tasks"),
        ("collab-workflow", {"mainTaskId": "mt-1"}, "workflow:mt-1"),
    ],
)
def test_key_hint_matches_frontend_tab_key(kind, data, real_id):
    srp.store_right_stage_state({"activeKey": None, "tabs": [], "collapsed": False, "rev": 1})
    from evoflow.tools.builtins.stage_tool import apply_right_panel

    out = apply_right_panel(action="show", kind=kind, data=dict(data))
    assert out["ok"] is True, out
    hint = out["userScreen"]["target"]["keyHint"]
    assert hint == f"{kind}:{real_id}", (hint, real_id)
    assert out["surface"]["id"] == real_id


def test_shell_page_external_url_is_rejected_not_opened():
    """外链必须报错拒收，不许静默开个空壳签顶掉用户原来的页面。"""
    srp.store_right_stage_state(
        {
            "activeKey": "shell-page:shell:/tasks",
            "activeKind": "shell-page",
            "tabs": [{"key": "shell-page:shell:/tasks", "kind": "shell-page", "title": "任务"}],
            "collapsed": False,
            "rev": 1,
        }
    )
    from evoflow.tools.builtins.stage_tool import apply_right_panel

    out = apply_right_panel(action="show", kind="shell-page", data={"path": "https://example.com"})
    assert out["ok"] is False
    assert "web-embed" in (out.get("error") or "")
    # 拒收后不得发出 emit，用户的 /tasks 签原样还在
    state = srp.read_right_stage_state()
    assert state["activeKey"] == "shell-page:shell:/tasks"


def test_session_runtime_missing_key_reports_error():
    from evoflow.tools.builtins.stage_tool import apply_right_panel

    out = apply_right_panel(action="show", kind="sessionRuntime", data={})
    assert out["ok"] is False
    assert "sessionKey" in (out.get("error") or "")


# ---------------------------------------------------------------------------
# 【self-evolution-bot · 2026-11-21 · 第102轮 · 模型:deepseek-v4.1-flash-1017】
# 两条「工具回执说假话」的回归：它们各自骗了我一整轮，必须钉住。
# ---------------------------------------------------------------------------


def _seed(snap: dict) -> None:
    srp._STATE.clear()
    srp._STATE.update(snap)


def test_stale_snapshot_is_flagged_not_reported_as_current():
    """落盘残留必须标 stale —— ``known=True`` 不等于「现在是这样」。

    反证依据（本轮真机）：08:11 新进程起来后 ui.current 返回 ok/known=True、
    tabs=7、rev=42，而 reportedAt 是 2026-11-20T17:03:48Z（本地 01:03:48），
    即上一个进程 7 小时前写下的盘。我据此误报了一整轮「标签莫名消失」。
    """
    _seed(
        {
            "activeKey": "shell-page:shell:/proactive",
            "activeKind": "shell-page",
            "activeTitle": "BOT",
            "collapsed": False,
            "tabs": [{"key": "a"}, {"key": "b"}],
            "keysRepairable": True,
            "rev": 42,
            "reportedAt": "2026-11-20T17:03:48.021Z",
        }
    )
    snap = srp.read_right_stage_state()
    assert snap["known"] is True
    assert snap.get("stale") is True
    assert snap.get("ageSeconds", 0) > 600
    assert "不代表用户此刻" in snap.get("staleHint", "")


def test_fresh_snapshot_is_not_flagged_stale():
    """刚上报的快照不许被误标 stale（否则提示会变成噪声，我就又学会忽略它）。"""
    from datetime import UTC, datetime

    _seed(
        {
            "activeKey": "shell-page:shell:/tasks",
            "activeKind": "shell-page",
            "collapsed": False,
            "tabs": [{"key": "shell-page:shell:/tasks"}],
            "keysRepairable": True,
            "rev": 3,
            "reportedAt": datetime.now(UTC).isoformat(),
        }
    )
    snap = srp.read_right_stage_state()
    assert snap["known"] is True
    assert not snap.get("stale")
    assert snap.get("ageSeconds", 999) < 60


def test_snapshot_without_reported_at_is_not_fabricated():
    """缺 reportedAt 时不编年龄、不编 stale（无依据就不下结论）。"""
    _seed({"activeKey": "shell-page:shell:/tasks", "activeKind": "shell-page", "tabs": []})
    snap = srp.read_right_stage_state()
    assert snap["known"] is True
    assert "ageSeconds" not in snap
    assert not snap.get("stale")


def test_show_reports_new_tab_when_target_key_absent():
    """目标 key 不在已开标签里 → 必须承认「会多开一个签」。

    反证依据（本轮真机 08:12:05）：我 ui.show path=/tasks 时右栏新建了第 2 个签
    （web-state 紧接上报 tabs=2），而回执写 reusedSameKindTab=true +
    「用户原本就在同类页面上，本次多半是原地更新」—— 两句都与事实相反。
    根因：判据用的是「activeKind == 本次 kind」，而 shell-page 一个 kind 下有几十个页面。
    """
    from evoflow.tools.builtins import stage_tool as st

    _seed(
        {
            "activeKey": "shell-page:shell:/proactive",
            "activeKind": "shell-page",
            "activeTitle": "主动任务ABC",
            "collapsed": False,
            "tabs": [{"key": "shell-page:shell:/proactive", "kind": "shell-page", "title": "主动任务ABC"}],
            "keysRepairable": True,
            "rev": 3,
            "reportedAt": "2026-11-21T00:12:06.924Z",
        }
    )
    out = st._describe_user_screen_before_after(
        act="show",
        kind="shell-page",
        surface={"id": "shell:/tasks", "path": "/tasks", "title": "任务"},
        expand=True,
    )
    assert out["target"]["keyHint"] == "shell-page:shell:/tasks"
    assert out["reusedSameKindTab"] is False
    assert out["mayStealFocus"] is True
    assert "多开一个标签" in out["note"]


def test_show_reports_reuse_when_target_key_present():
    """目标 key 已在签里 → 判复用，不许说会多开。"""
    from evoflow.tools.builtins import stage_tool as st

    _seed(
        {
            "activeKey": "shell-page:shell:/proactive",
            "activeKind": "shell-page",
            "collapsed": False,
            "tabs": [
                {"key": "shell-page:shell:/proactive", "kind": "shell-page"},
                {"key": "shell-page:shell:/tasks", "kind": "shell-page", "title": "任务"},
            ],
            "keysRepairable": True,
            "rev": 4,
            "reportedAt": "2026-11-21T00:12:06.924Z",
        }
    )
    out = st._describe_user_screen_before_after(
        act="show",
        kind="shell-page",
        surface={"id": "shell:/tasks", "path": "/tasks", "title": "任务"},
        expand=True,
    )
    assert out["reusedSameKindTab"] is True
    assert out["mayStealFocus"] is False
    assert "原地更新" in out["note"]

def test_show_shell_page_without_title_does_not_use_path_as_title():
    """【self-evolution-bot · 2026-11-21 · 第103轮 · 模型:deepseek-v4.1-flash-1017】

    改了什么：钉住「路径不是名字」这条判据。

    为什么（真机实测抓到的回执缺陷）：``ui.show kind=shell-page data.path=/knowledge``
    不传 title 时，surface.title 曾是裸路径 ``"/knowledge"``，于是工具回执对模型说
    「标题是 /knowledge」。用户签上实际显示的是「知识库」——由前端挂载表兜底，
    所以签没错，错的是回执。模型读到路径会误以为名字丢了、再补传一次 title。

    判据：不传 title 时 surface 里**不许有** title 字段；传了才透传。
    """
    from evoflow.tools.builtins.stage_tool import apply_right_panel

    out = apply_right_panel(
        action="show",
        kind="shell-page",
        data={"path": "/knowledge"},
    )
    surface = out.get("surface") or {}
    assert surface.get("data", {}).get("path") == "/knowledge"
    assert "title" not in surface, f"路径不许被当标题：{surface.get('title')!r}"

    named = apply_right_panel(
        action="show",
        kind="shell-page",
        data={"path": "/knowledge"},
        title="知识库总览",
    )
    assert (named.get("surface") or {}).get("title") == "知识库总览"


# 【self-evolution-bot · 2026-11-21 · 第104轮 · 模型:deepseek-v4.1-flash-1017】
# 钉住一条真机缺陷：ui.hide 回 ok:true，但前端 applyRemote 把 hide 派给了 store.hide()
# （关一个签，遇到 shell-page 这类受保护 kind 直接 return），右栏纹丝不动。
# 实测证据：10:29:30.041 [py] emit sent action=hide 之后再无 [web-state] report，
# 状态盘停在 collapsed=false / tabs=2。
# 后端能守的那一半：hide 必须回读收起前快照，让调用方下一轮自己核对收掉了几个签。
def test_hide_reports_what_was_there_before_collapsing():
    srp.store_right_stage_state(
        {
            "activeKey": "shell-page:shell:/tasks",
            "activeKind": "shell-page",
            "activeTitle": "任务",
            "collapsed": False,
            "tabs": [
                {"key": "shell-page:shell:/tasks", "kind": "shell-page", "title": "任务", "data": {"path": "/tasks"}},
                {"key": "shell-page:shell:/knowledge", "kind": "shell-page", "title": "知识库", "data": {"path": "/knowledge"}},
            ],
            "rev": 9,
        }
    )

    from evoflow.tools.builtins.stage_tool import apply_right_panel

    out = apply_right_panel(action="hide")
    assert out["ok"] is True
    assert out["action"] == "hide"
    assert out["surface"] is None
    # 关键：不许只回一个 ok。收起前有几个签必须如实带出来，
    # 调用方才能下一轮用 ui.current 核对「标签数有没有被误拆」。
    screen = out["userScreen"]
    assert screen["known"] is True
    assert screen["before"]["tabs"] == 2
    assert screen["before"]["activeKey"] == "shell-page:shell:/tasks"
    assert screen["before"]["collapsed"] is False
    assert "整栏收起" in screen["expect"]
    assert "2" in screen["verifyHint"]


def test_show_invisible_when_right_stage_is_on_another_session():
    """右栏挂在别的会话上、且**未带 expand** 时，visible 必须为 False。

    【self-evolution-bot · 2026-11-21 · 第104轮 · 模型:deepseek-v4.1-flash-1017】
    【self-evolution-bot · 2026-11-21 · 第106轮 · 模型:deepseek-v4.1-flash-1017】改了什么：
    本条原先传 ``expand=True`` 断言 visible=False —— 那是第104轮「前端隔离分支无条件
    冻结会话级 kind」时期的正确判据。本轮前端已把该分支放宽为「expand=true 时按用户
    当前 UI 会话盖章写 live」（right-stage-agui.ts:372/403），回执若仍报不可见，
    就是告诉模型一句与屏幕相反的话。于是本条改为钉**不带 expand** 的原始语义，
    带 expand 的那一半另立 test_show_visible_when_expand_crosses_session。
    为什么（现网实证 13:26:37）：当时 emit 的 surface 里没有 sessionKey、
    前端也没有 expand 豁免，那签被写进归属会话的冻结记忆，用户 44 秒看不到。
    """
    from evoflow.tools.builtins import stage_tool as st

    _seed(
        {
            "activeKey": "shell-page:shell:/proactive/personal-assistant",
            "activeKind": "shell-page",
            "activeTitle": "个人助理",
            "collapsed": False,
            # 老前端没有顶层 sessionKey：靠激活签自己的 sessionKey 兜底
            "tabs": [
                {
                    "key": "shell-page:shell:/proactive/personal-assistant",
                    "kind": "shell-page",
                    "sessionKey": "agent:main:new-d005f287",
                }
            ],
            "keysRepairable": True,
            "rev": 9,
            "reportedAt": "2026-11-21T05:26:37.000Z",
        }
    )
    out = st._describe_user_screen_before_after(
        act="show",
        kind="web-embed",
        surface={
            "id": "primary",
            "url": "https://example.com",
            "sessionKey": "proactive:self-evolution-bot:chat:2026-11-19T16-15-39.290Z",
        },
        # 第106轮：不带 expand ＝ 调用方没要求「让用户看见」，前端隔离分支不放行 →
        # 会话级 kind 被冻进归属会话记忆，回执必须如实报不可见。
        expand=False,
    )
    assert out["visible"] is False, out
    assert "另一条会话" in out["hint"], out
    assert "切过去" in out["hint"], out


def test_show_visible_when_same_session():
    """同一条会话内 show：可见，不许因为「有 sessionKey 字段」就一律判不可见。"""
    from evoflow.tools.builtins import stage_tool as st

    sk = "proactive:self-evolution-bot:chat:2026-11-19T16-15-39.290Z"
    _seed(
        {
            "activeKey": "web-embed:primary",
            "activeKind": "web-embed",
            "collapsed": False,
            "sessionKey": sk,
            "tabs": [{"key": "web-embed:primary", "kind": "web-embed"}],
            "keysRepairable": True,
            "rev": 21,
            "reportedAt": "2026-11-21T05:27:56.987Z",
        }
    )
    out = st._describe_user_screen_before_after(
        act="show",
        kind="shell-page",
        surface={"id": "shell:/tasks", "path": "/tasks", "sessionKey": sk},
        expand=False,
    )
    assert out["visible"] is True, out
    assert "hint" not in out, out


def test_show_detects_frozen_when_owner_passed_explicitly():
    """【self-evolution-bot · 2026-11-21 · 第106轮 · 模型:deepseek-v4.1-flash-1017】

    改了什么：钉住「归属会话由调用方传入」这条接线，而不是只认 surface.sessionKey。

    为什么（本轮现网实证，这是「回执报可见其实不可见」的真根因）：
    13:26:37.506 那条 emit 的原文是
        {"action":"show","surface":{"id":"primary","kind":"web-embed",
         "data":{"url":"https://example.com","editable":true},
         "title":"第104轮验证A","expand":true}}
    —— **surface 里根本没有 sessionKey**。于是判据里 ``owner_session_key`` 恒为空串，
    ``frozen_in_other_session`` 整个表达式恒为 False，第104轮写的「切过去才看得到」
    分支是死代码；回执照旧报 visible=true，而用户屏幕上 44 秒什么都没有
    （13:27:13 用户点发送切到该会话后，13:27:21 那签才被换出来）。

    判据：surface 无 sessionKey，但 owner_session_key 传入时，仍然必须判不可见。
    """
    from evoflow.tools.builtins import stage_tool as st

    other = "agent:main:new-a8d17462"  # 用户当时在看的那条会话（1688卫衣）
    mine = "proactive:self-evolution-bot:chat:2026-11-19T16-15-39.290Z"
    _seed(
        {
            "activeKey": "screenshot:call_70c744c34141491a9ec70f90",
            "activeKind": "screenshot",
            "collapsed": False,
            "sessionKey": other,
            "tabs": [
                {
                    "key": "screenshot:call_70c744c34141491a9ec70f90",
                    "kind": "screenshot",
                    "sessionKey": other,
                }
            ],
            "keysRepairable": True,
            "rev": 18,
            "reportedAt": "2026-11-21T05:26:59.857Z",
        }
    )
    out = st._describe_user_screen_before_after(
        act="show",
        kind="web-embed",
        # 这正是现网事件原文的形状：surface 里没有 sessionKey。
        surface={"id": "primary", "kind": "web-embed", "title": "第104轮验证A"},
        # 第106轮：不带 expand（现网原文也没有 expand —— 是前一条第104轮测试自己加的），
        # 才是「冻结在别的会话、用户看不见」的真实形状。
        expand=False,
        owner_session_key=mine,
    )
    assert out["visible"] is False, out
    assert "另一条会话" in out["hint"], out


def test_show_visible_when_expand_crosses_session():
    """带 ``expand=True`` 跨会话：回执必须报可见（与前端放宽后的落地口径一致）。

    【self-evolution-bot · 2026-11-21 · 第106轮 · 模型:deepseek-v4.1-flash-1017】
    改了什么：新增本对照条，钉住「expand 豁免」在**前后端两侧同口径**。
    为什么（同一缺陷改两处漏第三处的当场自撞）：本轮已把前端
    ``right-stage-agui.ts`` 会话级隔离分支改成「expand=true → 按用户当前 UI 会话
    盖章写 live」，用户当场就能看见；后端回执若还按旧判据报 ``visible: False`` +
    「切过去才看得到」，模型会对用户说一句与屏幕相反的话，比不报更糟。
    判据：上报会话 ≠ 归属会话 **且** expand=True → visible True 且不带 hint；
    同一 fixture 下 expand=False 必须 False（对照条见上一条）。两条同时绿才算接线。
    """
    from evoflow.tools.builtins import stage_tool as st

    other = "agent:main:new-a8d17462"
    mine = "proactive:self-evolution-bot:chat:2026-11-19T16-15-39.290Z"
    _seed(
        {
            "activeKey": "screenshot:call_70c744c34141491a9ec70f90",
            "activeKind": "screenshot",
            "collapsed": False,
            "sessionKey": other,
            "tabs": [
                {
                    "key": "screenshot:call_70c744c34141491a9ec70f90",
                    "kind": "screenshot",
                    "sessionKey": other,
                }
            ],
            "keysRepairable": True,
            "rev": 19,
            "reportedAt": "2026-11-21T05:27:10.000Z",
        }
    )
    out = st._describe_user_screen_before_after(
        act="show",
        kind="web-embed",
        surface={"id": "primary", "kind": "web-embed", "title": "第106轮验证B"},
        expand=True,
        owner_session_key=mine,
    )
    assert out["visible"] is True, out
    assert "hint" not in out, out


def test_clean_payload_keeps_top_level_session_key():
    """【self-evolution-bot · 2026-11-21 · 第106轮 · 模型:deepseek-v4.1-flash-1017】

    改了什么：``_clean_payload`` 必须保留前端上报的顶层 ``sessionKey``。

    为什么（本轮现网实证）：前端 ``right-stage-state-report.buildPayload`` 从第104轮起
    就在发这个字段（注释写得很清楚：「顶层 sessionKey 是『用户此刻看的会话』的唯一事实」），
    但 ``_clean_payload`` 是白名单式重建返回体 —— 没列进去的字段一律消失。
    盘上 ``right-stage-state.json`` 实测确实没有它（只有 tabs[].sessionKey），
    于是 read 侧、``ui.show`` 回执的文件兜底都拿不到这条事实。

    判据：POST 带顶层 sessionKey → clean 后必须原样还在；不带时按激活签兜底。
    """
    from app.gateway.routers.stage_right_panel import _clean_payload

    sk = "proactive:self-evolution-bot:chat:2026-11-19T16-15-39.290Z"
    clean = _clean_payload(
        {
            "activeKey": "web-embed:primary",
            "activeKind": "web-embed",
            "collapsed": False,
            "sessionKey": sk,
            "tabs": [{"key": "web-embed:primary", "kind": "web-embed", "sessionKey": sk}],
            "rev": 29,
            "reportedAt": "2026-11-21T05:49:37.087Z",
        }
    )
    assert clean.get("sessionKey") == sk, clean

    # 老前端不报顶层字段时，用激活签的归属会话兜底（同一事实的另一种携带方式）。
    fallback = _clean_payload(
        {
            "activeKey": "web-embed:primary",
            "activeKind": "web-embed",
            "collapsed": False,
            "tabs": [{"key": "web-embed:primary", "kind": "web-embed", "sessionKey": sk}],
            "rev": 30,
            "reportedAt": "2026-11-21T05:50:37.087Z",
        }
    )
    assert fallback.get("sessionKey") == sk, fallback


def test_artifacts_branch_carries_expand_and_user_screen():
    """artifacts 分支必须同时带 ``expand`` 与 ``userScreen``。

    【self-evolution-bot · 2026-11-21 · 第106轮 · 模型:deepseek-v4.1-flash-1017】
    改了什么：钉住 ``apply_right_panel`` 三个独立 return 分支里最容易被漏掉的第三个
    ——``_apply_artifacts_panel``。

    为什么（本轮扫全仓 expand 落点时发现）：artifacts 在 ``_SESSION_SCOPED_KINDS`` 里，
    属会话级 kind，跨会话会被前端冻进归属会话记忆；而它的 surface 此前**从来不携带
    ``expand``**，回执也**不带 ``userScreen``**。于是 44 秒那件事在 artifacts 上原样可
    复现（右栏收起时 expand 不撑开、跨会话时回执也无从判断），只是我这几轮都在测
    web-embed，没扫到它。这正是「改一处漏另一处」的跨分支同型复发。

    判据：expand=True → surface["expand"] is True 且回执带 userScreen；
    不带 expand → surface 里不得出现 expand 键（不许把默认值也写进去污染语义）。
    """
    from evoflow.tools.builtins import stage_tool as st

    emitted: list[tuple[str, dict]] = []
    orig = st._emit_surface
    st._emit_surface = lambda action, surface: emitted.append((action, surface))
    try:
        out = st.apply_right_panel(
            action="show",
            kind="artifacts",
            data={"items": [{"type": "file", "path": "outputs/a.png", "name": "a.png"}]},
            session_key="proactive:self-evolution-bot:chat:x",
            expand=True,
        )
        assert out["ok"] is True, out
        assert out["surface"].get("expand") is True, out["surface"]
        assert "userScreen" in out, out
        assert out["userScreen"].get("known") in (True, False), out

        emitted.clear()
        out2 = st.apply_right_panel(
            action="show",
            kind="artifacts",
            data={"items": [{"type": "file", "path": "outputs/b.png", "name": "b.png"}]},
            session_key="proactive:self-evolution-bot:chat:x",
            expand=False,
        )
        assert "expand" not in out2["surface"], out2["surface"]
        assert "userScreen" in out2, out2
    finally:
        st._emit_surface = orig


def test_session_scoped_kinds_match_frontend_whitelist():
    """后端 ``_SESSION_SCOPED_KINDS`` 必须与前端 ``SESSION_SCOPED_KINDS`` 逐条相等。

    【self-evolution-bot · 2026-11-21 · 第106轮 · 模型:deepseek-v4.1-flash-1017】
    改了什么：新增跨语言对账，直接解析前端 TS 源文件里的 Set 字面量。

    为什么：同一份「哪些 kind 属于某条会话」的事实现在有两份手写副本——
    前端的 ``evopanel/src/lib/right-stage/right-stage-scope.ts``（真正决定写 live
    还是冻结记忆，是唯一事实）与后端 ``_SESSION_SCOPED_KINDS``（只用于回执措辞）。
    我这轮就是靠肉眼逐条背下来才敢说"两边一致"，而肉眼对账下次一定会漂：
    前端加一个新 kind，后端回执就开始对那个 kind 说错话，且没有任何测试会红。

    判据：两个集合必须完全相等（不是包含关系）——
      · 后端多一个 → 会对一个其实是 workspace 级的 kind 报「切过去才看得到」；
      · 后端少一个 → 会话级 kind 被冻结时回执照旧报 visible:true，正是 44 秒那件事。
    """
    import re
    from pathlib import Path

    from evoflow.tools.builtins.stage_tool import _SESSION_SCOPED_KINDS

    ts_path = (
        Path(__file__).resolve().parents[2]
        / "evopanel"
        / "src"
        / "lib"
        / "right-stage"
        / "right-stage-scope.ts"
    )
    assert ts_path.exists(), f"前端唯一事实文件不存在：{ts_path}"
    src = ts_path.read_text(encoding="utf-8")
    block = re.search(
        r"const SESSION_SCOPED_KINDS = new Set<string>\(\[(.*?)\]\)",
        src,
        re.S,
    )
    assert block, "解析不到前端 SESSION_SCOPED_KINDS 字面量（结构变了，请同步更新本测试）"
    frontend_kinds = set(re.findall(r"'([^']+)'", block.group(1)))

    assert frontend_kinds, "解析出的前端清单为空——正则失效，不能当成『两边都空』通过"
    missing = frontend_kinds - _SESSION_SCOPED_KINDS
    extra = _SESSION_SCOPED_KINDS - frontend_kinds
    assert not missing, f"后端漏登记（会导致回执对会话级 kind 报错可见性）：{sorted(missing)}"
    assert not extra, f"后端多登记（会对 workspace 级 kind 误判被冻结）：{sorted(extra)}"
