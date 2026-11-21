"""panel_set progress kinds: collab-workflow / collabSubtaskTranscript / employeeProcess."""

from evoflow.tools.builtins.stage_tool import _build_progress_surface, _normalize_panel_kind


def test_normalize_progress_kind_aliases():
    assert _normalize_panel_kind("collab-workflow") == "collab-workflow"
    assert _normalize_panel_kind("workflow") == "collab-workflow"
    assert _normalize_panel_kind("employee-process") == "employeeProcess"
    assert _normalize_panel_kind("employee_process") == "employeeProcess"
    assert _normalize_panel_kind("collab-subtask") == "collabSubtaskTranscript"


def test_collab_workflow_requires_main_task_id():
    surface, err = _build_progress_surface(kind="collab-workflow", payload_data={}, title=None, layout=None)
    assert surface is None
    assert "mainTaskId" in (err or "")


def test_collab_workflow_stable_id():
    surface, err = _build_progress_surface(
        kind="collab-workflow",
        payload_data={"taskId": "mt-1", "thread_id": "th-9"},
        title="图",
        layout=None,
    )
    assert err is None
    assert surface is not None
    assert surface["id"] == "workflow:mt-1"
    assert surface["kind"] == "collab-workflow"
    assert surface["data"]["mainTaskId"] == "mt-1"
    assert surface["data"]["leadThreadId"] == "th-9"
    assert surface["layout"] == "half"


def test_collab_subtask_requires_ids():
    surface, err = _build_progress_surface(
        kind="collabSubtaskTranscript",
        payload_data={"mainTaskId": "mt-1"},
        title=None,
        layout=None,
    )
    assert surface is None
    assert "subtaskId" in (err or "")


def test_collab_subtask_stable_id():
    surface, err = _build_progress_surface(
        kind="collabSubtaskTranscript",
        payload_data={"main_task_id": "mt-1", "subtask_id": "st-2"},
        title=None,
        layout="wide",
    )
    assert err is None
    assert surface is not None
    assert surface["id"] == "collabSubtaskTranscript:st-2"
    assert surface["data"]["subtaskId"] == "st-2"
    assert surface["data"]["mainTaskId"] == "mt-1"


def test_employee_process_requires_task_and_agent():
    surface, err = _build_progress_surface(
        kind="employeeProcess",
        payload_data={"taskId": "mt-1"},
        title=None,
        layout=None,
    )
    assert surface is None
    assert "agentCode" in (err or "")


def test_employee_process_stable_id():
    """对话侧一人一签：有 agentCode 就按人钉签（与前端 employeeProcessStageTabId 一致）。

    【self-evolution-bot · 2026-11-21 · 第103轮 · 模型:deepseek-v4.1-flash-1017】
    改了什么：断言由 ``process:mt-9`` 改为 ``process:live:duty-ops``，并补任务中心用例。
    为什么：原断言把「后端按 taskId 建签」当成标准答案，而前端真实建签是
      ``process:live:{agentCode}``（一人一签，避免同员工每次唤醒都新开签）。
      于是 keyHint 恒指向不存在的签 —— 测试绿着，线上 ui.activate 必失败。
      错的那一侧是后端，所以改后端 + 改这条断言；不是为了让测试变绿而改。
    """
    surface, err = _build_progress_surface(
        kind="employeeProcess",
        payload_data={"task_id": "mt-9", "assigned_to": "duty-ops", "busy": 1},
        title="值班",
        layout=None,
    )
    assert err is None
    assert surface is not None
    assert surface["id"] == "process:live:duty-ops"
    assert surface["data"]["taskId"] == "mt-9"
    assert surface["data"]["agentCode"] == "duty-ops"
    assert surface["data"]["busy"] is True
    assert surface["layout"] == "wide"


def test_employee_process_task_center_uses_tc_id():
    """任务中心侧仍按 task 拆签：``tc:process:{taskId}``（前端同规则）。"""
    surface, err = _build_progress_surface(
        kind="employeeProcess",
        payload_data={"taskId": "mt-9", "agentCode": "duty-ops"},
        title=None,
        layout=None,
        session_key="task-center:mt-9",
    )
    assert err is None
    assert surface is not None
    assert surface["id"] == "tc:process:mt-9"


def test_employee_process_without_task_uses_live_placeholder():
    surface, err = _build_progress_surface(
        kind="employeeProcess",
        payload_data={"agentCode": "duty-ops"},
        title=None,
        layout=None,
    )
    assert err is None
    assert surface is not None
    assert surface["id"] == "process:live:duty-ops"
    assert "taskId" not in surface["data"]
# ── shell-page / sessionRuntime：契约校验 + tab id 单一真源 ────────────────────
# 【self-evolution-bot · 2026-11-21 · 第103轮 · 模型:deepseek-v4.1-flash-1017】
# 为什么补这片：本轮真机实测抓到的四条缺陷，此前**一条测试都没有**，所以一直绿：
#   ① 外链当站内路径被接受并真的开了个空壳签；
#   ② sessionRuntime 缺 data.sessionKey 也 emit；
#   ③ 后端 surface.id 与前端建签规则不一致（employeeProcess / sessionRuntime /
#      shell-page 三处），keyHint 因此恒指错签；
#   ④ keyHint 自己另算了一遍 shell-page 的 key（同一规则写两份）。
# 这些用例锁的是「后端算出来的 id 必须逐字等于前端 tabKeyOf 的结果」。


def test_shell_page_rejects_external_url():
    surface, err = _build_progress_surface(
        kind="shell-page",
        payload_data={"path": "https://example.com"},
        title=None,
        layout=None,
    )
    assert surface is None
    assert "in-app path" in (err or "")
    assert "web-embed" in (err or "")


def test_shell_page_rejects_protocol_relative_and_empty():
    for bad in ("//example.com/x", ""):
        surface, err = _build_progress_surface(
            kind="shell-page", payload_data={"path": bad}, title=None, layout=None
        )
        assert surface is None, bad
        assert err


def test_shell_page_id_matches_frontend_shell_page_tab_id():
    """前端 id 形状是 ``shell:{normalizePath(path)}``，后端必须逐字一致。"""
    surface, err = _build_progress_surface(
        kind="shell-page",
        payload_data={"path": "tasks"},
        title="任务",
        layout=None,
    )
    assert err is None and surface is not None
    assert surface["id"] == "shell:/tasks"
    assert surface["data"]["path"] == "/tasks"

    # 挂载表别名：/employees → /proactive（两侧同一规则）
    surface2, _ = _build_progress_surface(
        kind="shell-page", payload_data={"path": "/employees"}, title=None, layout=None
    )
    assert surface2 is not None
    assert surface2["id"] == "shell:/proactive"


def test_session_runtime_requires_session_key():
    surface, err = _build_progress_surface(
        kind="sessionRuntime", payload_data={}, title=None, layout=None
    )
    assert surface is None
    assert "sessionKey" in (err or "")


def test_session_runtime_id_matches_frontend():
    surface, err = _build_progress_surface(
        kind="sessionRuntime",
        payload_data={"sessionKey": "agent:main:new-1"},
        title=None,
        layout=None,
    )
    assert err is None and surface is not None
    # 前端 sessionRuntimeStageTabId → sessionRuntime:{sk}
    assert surface["id"] == "sessionRuntime:agent:main:new-1"


def test_key_hint_equals_kind_colon_id():
    """keyHint 只许有一条规则：``${kind}:${id}``（前端 store.tabKeyOf）。"""
    from evoflow.tools.builtins.stage_tool import _infer_tab_key

    for kind, data in (
        ("employeeProcess", {"agentCode": "xiaomi"}),
        ("sessionRuntime", {"sessionKey": "agent:main:new-1"}),
        ("shell-page", {"path": "/tasks"}),
        ("collab-workflow", {"mainTaskId": "mt-1"}),
    ):
        surface, err = _build_progress_surface(
            kind=kind, payload_data=dict(data), title=None, layout=None
        )
        assert err is None and surface is not None, kind
        hint = _infer_tab_key(kind=kind, surface=surface, tabs=[])
        assert hint == f"{kind}:{surface['id']}", kind
