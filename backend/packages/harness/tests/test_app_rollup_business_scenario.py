"""L3.5 business scenario test for app rollup: realistic multi-step workflow.

Simulates a real "Market Research Report" workflow with 4 steps, each with
authentic-looking task reports and deliverables. Verifies that the final
rollup produces a sensible merged result on the main task.

No real AI calls — subtasks are manually marked completed with realistic
content, just like a real run would produce.
"""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

from evoflow.persistence.db import get_db, reset_db_for_tests


@pytest.fixture
def sqlite_tmp(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        reset_db_for_tests()
        yield Path(tmp)
        reset_db_for_tests()
        import gc

        gc.collect()


# ──────────────────────────── realistic step data ────────────────────────────

STEP_1_COMPETITORS_REPORT = """## 竞品分析报告

### 主要竞品
1. **ProductA** — 市场份额 35%，主打性价比，用户群 25-35 岁
2. **ProductB** — 市场份额 28%，高端定位，企业客户为主
3. **ProductC** — 市场份额 15%，新兴玩家，AI 功能突出

### 竞品优劣势对比
| 竞品 | 优势 | 劣势 |
|------|------|------|
| ProductA | 价格低、渠道广 | 品牌形象低端 |
| ProductB | 品质好、服务优 | 价格高、下沉难 |
| ProductC | 技术新、增长快 | 生态不完善 |

### 关键发现
- 市场头部集中度高，CR3 = 78%
- AI 功能是 2026 年差异化核心
- 中端市场（200-500 元价位段）存在空白
"""

STEP_2_USER_REPORT = """## 用户调研总结

### 调研方法
- 线上问卷：1200 份有效回收
- 深度访谈：30 位目标用户
- 可用性测试：15 人

### 用户画像
- **核心人群**：28-40 岁都市白领，月收入 1.5-3 万
- **次要人群**：22-27 岁职场新人，月收入 0.8-1.5 万
- **决策因素**：功能完整性 > 品牌 > 价格 > 外观

### 核心痛点
1. 现有产品学习成本高，新手 3 天才能上手
2. 跨设备同步体验差，数据经常丢失
3. 客服响应慢，平均等待 2 小时
4. 个性化推荐不准，80% 用户表示"推荐的都不是我要的"

### 机会点
- 简化新手引导流程（目标：30 分钟上手）
- 优化云同步可靠性
- 引入 AI 智能客服
"""

STEP_3_TECH_REPORT = """## 技术可行性评估

### 架构方案
采用微服务架构，核心模块拆分：
- 用户服务（User Service）
- 内容服务（Content Service）
- AI 推理服务（AI Inference Service）
- 同步服务（Sync Service）

### 技术栈
- 后端：Python + FastAPI
- 前端：React + TypeScript
- 数据库：PostgreSQL + Redis
- AI 模型：开源 LLM + 向量数据库
- 部署：Kubernetes + Docker

### 开发周期估算
| 阶段 | 工期 | 人力 |
|------|------|------|
| 需求设计 | 2 周 | 3 人 |
| MVP 开发 | 8 周 | 6 人 |
| 测试上线 | 2 周 | 4 人 |
| **总计** | **12 周** | **峰值 6 人** |

### 风险评估
- **高风险**：AI 推理成本控制（预估单用户 ¥0.5/天）
- **中风险**：同步服务并发性能
- **低风险**：常规 CRUD 功能
"""

STEP_4_STRATEGY_REPORT = """## 产品策略建议

### 定位
「人人能用的 AI 效率工具」—— 中端价位，高端体验

### 核心卖点
1. 🚀 **30 分钟上手** — 极简交互设计
2. 🤖 **AI 智能助手** — 全程陪伴式引导
3. ☁️ **无缝同步** — 多端实时协作
4. 💰 **¥299/年** — 性价比之王

### 定价策略
- 个人版：¥299/年（首年 ¥199）
- 团队版：¥999/人/年
- 企业版：定制报价

### 推广路径
1. **种子期**（0-3 月）：KOL 测评 + 邀请制，目标 1 万用户
2. **增长期**（3-6 月）：内容营销 + 社群运营，目标 10 万用户
3. **爆发期**（6-12 月）：广告投放 + 渠道合作，目标 50 万用户

### 预期 ROI
- 首年营收：约 3000 万元
- 盈亏平衡点：第 8 个月
- 三年目标：100 万付费用户，年营收 3 亿元
"""

ROLLUP_SUMMARY = """# 产品市场调研报告 — 最终汇总

## 一、市场概况
当前市场 CR3 达 78%，头部集中度高。中端价位段（200-500 元）存在明显空白，是切入良机。

## 二、目标用户
核心人群为 28-40 岁都市白领，最关注功能完整性。最大痛点：学习成本高、同步差、客服慢。

## 三、技术方案
12 周可完成 MVP 开发。最大风险点是 AI 推理成本，需重点优化。

## 四、产品策略
定位「中端价位、高端体验」，首年定价 ¥199 引流。预期 8 个月盈亏平衡，三年目标 100 万付费用户。

## 五、核心建议
✅ **建议立项** — 市场有空间、用户有痛点、技术可实现、经济模型成立
⚠️ **重点关注** — AI 成本控制 + 新手体验优化
"""


# ──────────────────────────── helpers ────────────────────────────

def _make_market_research_app(app_id: str, rollup_mode: str = "auto") -> dict:
    """Build a realistic market research app with 4 sequential steps."""
    return {
        "name": "市场调研报告生成器",
        "description": "自动完成竞品分析、用户调研、技术评估、策略建议四步流程",
        "steps": [
            {
                "ref": "1",
                "goal": "竞品分析",
                "description": "调研主要竞品，分析优劣势和市场格局",
                "tools": ["web_search", "file_write"],
                "depends_on": [],
                "assigned_agent": "researcher",
            },
            {
                "ref": "2",
                "goal": "用户调研",
                "description": "分析目标用户画像、痛点和需求",
                "tools": ["web_search", "file_write"],
                "depends_on": ["1"],
                "assigned_agent": "researcher",
            },
            {
                "ref": "3",
                "goal": "技术评估",
                "description": "评估技术可行性、架构方案和开发周期",
                "tools": ["web_search", "file_write"],
                "depends_on": ["1"],
                "assigned_agent": "code-agent",
            },
            {
                "ref": "4",
                "goal": "策略建议",
                "description": "输出产品定位、定价和推广策略",
                "tools": ["file_write"],
                "depends_on": ["2", "3"],
                "assigned_agent": "general-purpose",
            },
        ],
        "parameters": [
            {"name": "product_name", "label": "产品名称"},
            {"name": "target_market", "label": "目标市场"},
        ],
        "goal_template": "为 {{product_name}} 在 {{target_market}} 市场做完整调研报告",
        "execution_mode": "workflow",
        "version": 1,
        "status": "published",
        "final_rollup": rollup_mode,
        "final_rollup_agent": "general-purpose",
        "final_rollup_instruction": "综合所有步骤的产出，生成一份结构清晰的最终调研报告，包含市场概况、用户分析、技术方案、产品策略和核心建议。",
        "answer_from_ref": "",
    }


def _find_subtask_by_ref(subtasks: list[dict], ref: str) -> dict | None:
    for st in subtasks:
        if isinstance(st, dict) and str(st.get("ref") or "").strip() == ref:
            return st
    return None


def _mark_step_completed(
    subtask: dict,
    *,
    task_report: str,
    output_files: list[tuple[str, str]] | None = None,
) -> None:
    """Mark a subtask completed with realistic report content."""
    from evoflow.timeutil import utc_now_iso_z

    subtask["status"] = "completed"
    subtask["progress"] = 100
    subtask["outcome_reported_at"] = utc_now_iso_z()
    subtask["task_report"] = task_report
    subtask["result"] = task_report[:500]  # summary preview

    if output_files:
        subtask["outputs"] = [
            {
                "type": "file",
                "key": f"report_{i}",
                "value": path,
                "label": label,
            }
            for i, (path, label) in enumerate(output_files)
        ]

    if "worker_profile" not in subtask:
        subtask["worker_profile"] = {"assigned_agent": "researcher"}


# ──────────────────────────── test cases ────────────────────────────


def test_full_market_research_workflow_auto_rollup(sqlite_tmp: Path) -> None:
    """End-to-end: 4-step market research workflow with auto rollup produces merged result."""
    del sqlite_tmp
    from evoflow.collab import app_runner
    from evoflow.collab.storage import get_project_storage, find_main_task
    from evoflow.collab.task_progress import sync_main_task_from_subtasks
    from evoflow.persistence import app_repositories

    get_db()
    app_id = "App_market_research_biz"
    app = _make_market_research_app(app_id, rollup_mode="auto")
    app_repositories.save_app(app_id, app)

    # Kick off the workflow
    result = app_runner.run_app_workflow(
        app_id,
        {"product_name": "SmartFlow", "target_market": "AI 效率工具"},
        auto_authorize=True,
    )
    task_id = str(result.get("task_id") or "").strip()
    assert task_id, "Should have created a task"

    storage = get_project_storage()

    # ── Verify initial state: 4 user steps + 1 rollup step = 5 subtasks ──
    found = find_main_task(storage, task_id)
    assert found is not None
    _project, task = found
    subtasks = task.get("subtasks") or []

    user_refs = ["1", "2", "3", "4"]
    for ref in user_refs:
        assert _find_subtask_by_ref(subtasks, ref), f"Step {ref} should exist"

    rollup_st = _find_subtask_by_ref(subtasks, "__rollup__")
    assert rollup_st is not None, "Rollup step should exist in auto mode"
    assert rollup_st.get("status") == "planned"
    assert len(subtasks) == 5, f"Expected 5 subtasks (4 user + 1 rollup), got {len(subtasks)}"

    # Main task should be app-sourced
    assert task.get("source_app_id") == app_id
    assert task.get("final_rollup") == "auto"

    # ── Simulate step 1 completion (competitor analysis) ──
    step1 = _find_subtask_by_ref(subtasks, "1")
    assert step1 is not None
    _mark_step_completed(
        step1,
        task_report=STEP_1_COMPETITORS_REPORT,
        output_files=[
            ("/tmp/reports/competitor_analysis.md", "竞品分析报告"),
            ("/tmp/reports/competitor_matrix.csv", "竞品对比矩阵"),
        ],
    )
    storage.save_project(_project)
    sync_main_task_from_subtasks(storage, task_id)

    # After step 1: rollup still blocked (steps 2,3,4 not done)
    refound1 = find_main_task(storage, task_id)
    assert refound1 is not None
    _, task1 = refound1
    rollup1 = _find_subtask_by_ref(task1.get("subtasks") or [], "__rollup__")
    assert rollup1 is not None
    assert rollup1.get("status") == "planned", (
        f"Rollup should still be planned after step 1 only, got {rollup1.get('status')}"
    )

    # ── Simulate steps 2 and 3 completion (both depend on step 1) ──
    refound2 = find_main_task(storage, task_id)
    assert refound2 is not None
    _p2, t2 = refound2

    step2 = _find_subtask_by_ref(t2.get("subtasks") or [], "2")
    step3 = _find_subtask_by_ref(t2.get("subtasks") or [], "3")
    assert step2 is not None and step3 is not None

    _mark_step_completed(
        step2,
        task_report=STEP_2_USER_REPORT,
        output_files=[
            ("/tmp/reports/user_survey.md", "用户调研报告"),
            ("/tmp/reports/user_personas.pdf", "用户画像卡片"),
        ],
    )
    _mark_step_completed(
        step3,
        task_report=STEP_3_TECH_REPORT,
        output_files=[
            ("/tmp/reports/tech_assessment.md", "技术评估报告"),
            ("/tmp/reports/architecture.svg", "架构图"),
        ],
    )
    storage.save_project(_p2)
    sync_main_task_from_subtasks(storage, task_id)

    # After steps 2+3: rollup still blocked (step 4 not done)
    refound3 = find_main_task(storage, task_id)
    assert refound3 is not None
    _, t3 = refound3
    rollup3 = _find_subtask_by_ref(t3.get("subtasks") or [], "__rollup__")
    assert rollup3 is not None
    assert rollup3.get("status") == "planned", (
        f"Rollup should still be planned before step 4 completes, got {rollup3.get('status')}"
    )

    # ── Simulate step 4 completion (strategy, depends on 2+3) ──
    refound4 = find_main_task(storage, task_id)
    assert refound4 is not None
    _p4, t4 = refound4

    step4 = _find_subtask_by_ref(t4.get("subtasks") or [], "4")
    assert step4 is not None
    _mark_step_completed(
        step4,
        task_report=STEP_4_STRATEGY_REPORT,
        output_files=[
            ("/tmp/reports/product_strategy.md", "产品策略建议"),
            ("/tmp/reports/roadmap.xlsx", "产品路线图"),
        ],
    )
    storage.save_project(_p4)
    sync_main_task_from_subtasks(storage, task_id)

    # After all 4 user steps: rollup should be runnable
    refound5 = find_main_task(storage, task_id)
    assert refound5 is not None
    _, t5 = refound5
    rollup5 = _find_subtask_by_ref(t5.get("subtasks") or [], "__rollup__")
    assert rollup5 is not None
    assert rollup5.get("status") == "planned", (
        f"Rollup should still be planned (not yet executed), got {rollup5.get('status')}"
    )

    # ── Simulate rollup step execution ──
    refound6 = find_main_task(storage, task_id)
    assert refound6 is not None
    _p6, t6 = refound6

    rollup_step = _find_subtask_by_ref(t6.get("subtasks") or [], "__rollup__")
    assert rollup_step is not None
    _mark_step_completed(
        rollup_step,
        task_report=ROLLUP_SUMMARY,
        output_files=[
            ("/tmp/reports/final_report.md", "最终调研报告"),
            ("/tmp/reports/executive_summary.pdf", "执行摘要"),
        ],
    )
    storage.save_project(_p6)

    # Trigger sync — this should promote the rollup result to main task
    sync_res = sync_main_task_from_subtasks(storage, task_id)
    assert sync_res["ok"] is True

    # ── Verify final main task state ──
    final = find_main_task(storage, task_id)
    assert final is not None
    _, final_task = final

    # Status should be completed (all subtasks terminal + app-sourced)
    assert final_task.get("status") == "completed", (
        f"Main task should be completed, got {final_task.get('status')}"
    )
    assert final_task.get("progress") == 100

    # Rollup metadata
    assert final_task.get("rollup_applied_at") is not None
    assert final_task.get("rollup_mode") == "auto"
    assert final_task.get("rollup_source_ref") == "__rollup__"

    # Result summary should be the rollup report
    result_summary = final_task.get("result_summary") or ""
    assert len(result_summary) > 200, "result_summary should be substantial"
    assert "产品市场调研报告" in result_summary
    assert "核心建议" in result_summary
    assert "建议立项" in result_summary

    # Outputs: prefer rollup summary deliverables only
    outputs = final_task.get("outputs") or []
    output_values = [o.get("value", "") for o in outputs]

    # Rollup outputs present
    assert any("final_report" in v for v in output_values), "Missing final report output"
    assert any("executive_summary" in v for v in output_values), "Missing exec summary output"

    # Intermediate user step outputs must not surface on the main task
    assert not any("competitor_analysis" in v for v in output_values), "Unexpected competitor report"
    assert not any("user_survey" in v for v in output_values), "Unexpected user survey report"
    assert not any("tech_assessment" in v for v in output_values), "Unexpected tech assessment report"
    assert not any("product_strategy" in v for v in output_values), "Unexpected strategy report"

    # Total: 2 rollup outputs only
    assert len(outputs) == 2, f"Expected 2 rollup outputs, got {len(outputs)}"

    # All outputs have proper structure
    for o in outputs:
        assert o.get("type") in ("file", "url", "text", "other"), f"Bad output type: {o}"
        assert o.get("key"), f"Output missing key: {o}"
        assert o.get("value"), f"Output missing value: {o}"


def test_business_scenario_answer_node_only(sqlite_tmp: Path) -> None:
    """Business scenario with answer_node_only mode: step 4 is the answer node."""
    del sqlite_tmp
    from evoflow.collab import app_runner
    from evoflow.collab.storage import get_project_storage, find_main_task
    from evoflow.collab.task_progress import sync_main_task_from_subtasks
    from evoflow.persistence import app_repositories

    get_db()
    app_id = "App_answer_node_biz"
    app = _make_market_research_app(app_id, rollup_mode="answer_node_only")
    app["answer_from_ref"] = "4"  # 策略建议步骤作为最终答案
    app_repositories.save_app(app_id, app)

    result = app_runner.run_app_workflow(
        app_id,
        {"product_name": "SmartFlow", "target_market": "AI 效率工具"},
        auto_authorize=True,
    )
    task_id = str(result.get("task_id") or "").strip()
    assert task_id

    storage = get_project_storage()

    # No rollup subtask in answer_node_only mode
    found = find_main_task(storage, task_id)
    assert found is not None
    _project, task = found
    subtasks = task.get("subtasks") or []
    assert len(subtasks) == 4, f"Expected 4 subtasks (no rollup), got {len(subtasks)}"
    assert _find_subtask_by_ref(subtasks, "__rollup__") is None

    # Mark all steps completed
    for st in subtasks:
        ref = st.get("ref", "")
        reports = {
            "1": STEP_1_COMPETITORS_REPORT,
            "2": STEP_2_USER_REPORT,
            "3": STEP_3_TECH_REPORT,
            "4": STEP_4_STRATEGY_REPORT,
        }
        if ref in reports:
            _mark_step_completed(
                st,
                task_report=reports[ref],
                output_files=[(f"/tmp/biz/step_{ref}.md", f"Step {ref} report")],
            )

    storage.save_project(_project)
    sync_res = sync_main_task_from_subtasks(storage, task_id)
    assert sync_res["ok"] is True

    # Verify final state
    final = find_main_task(storage, task_id)
    assert final is not None
    _, final_task = final

    assert final_task.get("status") == "completed"
    assert final_task.get("rollup_mode") == "answer_node_only"
    assert final_task.get("rollup_source_ref") == "4"

    # result_summary should be the answer node's report (step 4 = strategy)
    result_summary = final_task.get("result_summary") or ""
    assert "产品策略建议" in result_summary
    assert "¥299/年" in result_summary

    # Outputs should prefer the answer node (step 4) only
    outputs = final_task.get("outputs") or []
    assert len(outputs) == 1, f"Expected 1 answer-node output, got {len(outputs)}"


def test_business_scenario_off_mode(sqlite_tmp: Path) -> None:
    """Business scenario with off mode: no rollup, just progress tracking."""
    del sqlite_tmp
    from evoflow.collab import app_runner
    from evoflow.collab.storage import get_project_storage, find_main_task
    from evoflow.collab.task_progress import sync_main_task_from_subtasks
    from evoflow.persistence import app_repositories

    get_db()
    app_id = "App_off_mode_biz"
    app = _make_market_research_app(app_id, rollup_mode="off")
    app_repositories.save_app(app_id, app)

    result = app_runner.run_app_workflow(
        app_id,
        {"product_name": "SmartFlow", "target_market": "AI 效率工具"},
        auto_authorize=True,
    )
    task_id = str(result.get("task_id") or "").strip()
    assert task_id

    storage = get_project_storage()

    found = find_main_task(storage, task_id)
    assert found is not None
    _project, task = found
    subtasks = task.get("subtasks") or []

    # No rollup step
    assert len(subtasks) == 4
    assert _find_subtask_by_ref(subtasks, "__rollup__") is None

    # Mark all completed
    for st in subtasks:
        ref = st.get("ref", "")
        _mark_step_completed(st, task_report=f"Step {ref} done")

    storage.save_project(_project)
    sync_res = sync_main_task_from_subtasks(storage, task_id)
    assert sync_res["ok"] is True

    # Task completes but no rollup metadata
    final = find_main_task(storage, task_id)
    assert final is not None
    _, final_task = final

    assert final_task.get("status") == "completed"
    assert final_task.get("rollup_applied_at") is None
    assert final_task.get("rollup_mode") is None
    # result_summary should be empty (no rollup applied)
    assert not (final_task.get("result_summary") or "").strip(), (
        f"off mode should have no result_summary, got: {final_task.get('result_summary')}"
    )
