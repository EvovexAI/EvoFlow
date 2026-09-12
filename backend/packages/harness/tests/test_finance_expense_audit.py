"""
L5 真实业务场景测试 - 财务：月度费用报销智能审核
=================================================

真实业务场景：财务部门每月处理员工报销，需要：
1. 收单分类 - 把所有报销单按类型归类（差旅/餐饮/办公/其他）
2. 合规校验 - 检查发票真伪、金额超标、审批流程完整性
3. 异常识别 - 标记可疑报销（重复报销、金额异常、时间异常）
4. 财务记账 - 生成记账凭证，按科目归类

最终 rollup 输出：月度报销审核总报告（含异常清单、合规率、记账汇总）

用真实业务内容验证 rollup 功能的业务可用性。
"""

from __future__ import annotations

import pytest
from pathlib import Path


@pytest.fixture
def sqlite_tmp(tmp_path: Path, monkeypatch) -> Path:
    """Isolated SQLite DB per test."""
    db_path = tmp_path / "test.db"
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(db_path))
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path))
    return db_path


def _make_finance_app() -> dict:
    """创建财务报销审核 App - 4 个业务步骤 + auto rollup。"""
    return {
        "name": "月度费用报销智能审核",
        "description": "财务部门月度报销批量审核：收单分类 → 合规校验 → 异常识别 → 记账汇总",
        "icon": "💰",
        "category": "finance",
        "execution_mode": "workflow",
        "final_rollup": "auto",
        "final_rollup_agent": "general-purpose",
        "final_rollup_instruction": (
            "你是财务总监。请基于以上 4 个步骤的审核结果，生成一份完整的"
            "《月度费用报销审核总报告》，包含：1) 报销总体概览（总笔数/总金额/分类统计）；"
            "2) 合规性分析（合规率/主要违规类型）；3) 异常清单（逐项说明）；"
            "4) 记账汇总（按科目）；5) 处理建议与下月改进措施。"
            "要求：数据准确，结论清晰，格式专业。"
        ),
        "version": 1,
        "status": "published",
        "parameters": [
            {"name": "month", "type": "string", "label": "审核月份", "default": "2026年7月"},
            {"name": "total_count", "type": "number", "label": "报销单总数", "default": 156},
        ],
        "steps": [
            {
                "ref": "1",
                "type": "agentStep",
                "title": "报销单收单与分类",
                "agent_code": "general-purpose",
                "goal": "对本月所有报销单进行收集、整理和分类统计",
                "instruction": (
                    "你是财务专员。请模拟处理 {total_count} 笔 {month} 的员工报销单，"
                    "按以下类型分类统计：\n"
                    "- 差旅费（机票/酒店/交通）\n"
                    "- 餐饮招待费\n"
                    "- 办公用品费\n"
                    "- 通讯费\n"
                    "- 其他\n\n"
                    "输出要求：\n"
                    "1. 各类别的笔数和金额（合理虚构数据，总金额约 28 万元）\n"
                    "2. 金额 Top 5 的单笔报销\n"
                    "3. 部门分布 Top 3\n"
                    "4. 收单过程中发现的初步问题"
                ),
                "depends_on": [],
            },
            {
                "ref": "2",
                "type": "agentStep",
                "title": "合规性校验",
                "agent_code": "general-purpose",
                "goal": "检查所有报销单的合规性，包括发票真伪、金额超标、审批完整性",
                "instruction": (
                    "你是财务合规专员。基于步骤 1 的分类数据，进行合规性校验：\n\n"
                    "检查项：\n"
                    "1. 发票真实性校验（模拟抽查 30%，发现问题率约 5%）\n"
                    "2. 金额超标检查（差旅住宿标准：一线城市 500/天，二线 350/天）\n"
                    "3. 审批流程完整性（是否有直属领导审批、部门负责人审批）\n"
                    "4. 报销时限（发生后 30 天内提交）\n\n"
                    "输出要求：\n"
                    "1. 各项检查的不合规笔数和涉及金额\n"
                    "2. 整体合规率\n"
                    "3. 不合规的典型案例（3 个）\n"
                    "4. 合规风险等级评估"
                ),
                "depends_on": ["1"],
            },
            {
                "ref": "3",
                "type": "agentStep",
                "title": "异常识别与风险标记",
                "agent_code": "general-purpose",
                "goal": "识别可疑报销和异常模式，标记高风险项",
                "instruction": (
                    "你是财务风控分析师。基于前两步的数据，进行深度异常识别：\n\n"
                    "识别维度：\n"
                    "1. 重复报销（同一发票号/同一行程多次报销）\n"
                    "2. 金额异常（整数金额过多、金额刚好卡在限额下）\n"
                    "3. 时间异常（节假日/深夜报销、集中月末报销）\n"
                    "4. 人员异常（某员工报销频次/金额显著高于同岗位）\n\n"
                    "输出要求：\n"
                    "1. 各类异常的发现数量和涉及金额\n"
                    "2. 高风险人员名单（2-3 人，附可疑点说明）\n"
                    "3. 高风险部门\n"
                    "4. 需要进一步核查的重点清单（至少 5 项）"
                ),
                "depends_on": ["2"],
            },
            {
                "ref": "4",
                "type": "agentStep",
                "title": "记账凭证生成与科目汇总",
                "agent_code": "general-purpose",
                "goal": "生成会计记账凭证，按科目归类汇总",
                "instruction": (
                    "你是总账会计。基于前面步骤的审核结果（剔除不合规部分），"
                    "生成记账凭证和科目汇总：\n\n"
                    "会计科目：\n"
                    "- 管理费用-差旅费\n"
                    "- 管理费用-业务招待费\n"
                    "- 管理费用-办公费\n"
                    "- 管理费用-通讯费\n"
                    "- 销售费用-差旅费（销售部门）\n"
                    "- 销售费用-业务招待费（销售部门）\n\n"
                    "输出要求：\n"
                    "1. 各科目借方金额汇总表\n"
                    "2. 主要记账凭证分录示例（3 笔）\n"
                    "3. 待抵扣进项税额估算\n"
                    "4. 本月 vs 上月环比变动分析"
                ),
                "depends_on": ["3"],
            },
        ],
    }


class TestFinanceExpenseAudit:
    """财务报销审核场景 - 端到端验证 rollup 功能的业务可用性。"""

    def test_finance_app_creation_and_rollup_step(self, sqlite_tmp: Path) -> None:
        """财务 App 能正常创建，且 auto rollup 步骤被正确添加。"""
        del sqlite_tmp
        from evoflow.collab import app_runner
        from evoflow.collab.storage import get_project_storage, find_main_task
        from evoflow.persistence import app_repositories
        from evoflow.collab.app_rollup import is_rollup_subtask

        def get_db():
            from evoflow.persistence.db import get_db as _get_db
            return _get_db()

        get_db()
        app = _make_finance_app()
        app_repositories.save_app("finance_expense_audit", app)
        loaded = app_repositories.load_app("finance_expense_audit")
        assert loaded is not None
        assert loaded.get("final_rollup") == "auto"

        # 启动工作流
        result = app_runner.run_app_workflow(
            "finance_expense_audit",
            {"month": "2026年7月", "total_count": 156},
            auto_authorize=True,
        )
        task_id = str(result.get("task_id") or "").strip()
        assert task_id, f"Failed to start workflow: {result}"

        storage = get_project_storage()
        found = find_main_task(storage, task_id)
        assert found is not None
        proj, task = found

        subtasks = task.get("subtasks") or []
        # 4 个业务步骤 + 1 个 rollup 步骤
        assert len(subtasks) == 5, f"Expected 5 subtasks, got {len(subtasks)}"

        rollup_steps = [s for s in subtasks if is_rollup_subtask(s)]
        assert len(rollup_steps) == 1, f"Expected 1 rollup step, got {len(rollup_steps)}"

        rollup = rollup_steps[0]
        # rollup 依赖所有 4 个业务步骤（检查所有可能的依赖字段）
        all_keys = list(rollup.keys())
        deps = (
            rollup.get("depends_on")
            or rollup.get("dependsOn")
            or rollup.get("depends_refs")
            or rollup.get("dependencies")
            or []
        )
        assert len(deps) == 4, f"Rollup should depend on all 4 steps, got deps={deps}, keys={all_keys}"
        assert rollup.get("ref") == "__rollup__"

    def test_finance_full_workflow_rollup_result(self, sqlite_tmp: Path) -> None:
        """财务工作流全部完成后，rollup 结果被正确回写到主任务。"""
        del sqlite_tmp
        from evoflow.collab import app_runner
        from evoflow.collab.storage import get_project_storage, find_main_task
        from evoflow.collab.task_progress import sync_main_task_from_subtasks
        from evoflow.persistence import app_repositories
        from evoflow.timeutil import utc_now_iso_z
        from evoflow.collab.app_rollup import is_rollup_subtask

        def get_db():
            from evoflow.persistence.db import get_db as _get_db
            return _get_db()

        get_db()
        app = _make_finance_app()
        app_repositories.save_app("finance_audit_full", app)

        result = app_runner.run_app_workflow(
            "finance_audit_full",
            {"month": "2026年7月", "total_count": 156},
            auto_authorize=True,
        )
        task_id = str(result.get("task_id") or "").strip()
        assert task_id

        storage = get_project_storage()
        found = find_main_task(storage, task_id)
        assert found is not None
        proj, task = found

        subtasks = task.get("subtasks") or []
        now = utc_now_iso_z()

        # 步骤 1：收单分类 - 真实业务内容
        step1 = next(s for s in subtasks if s.get("ref") == "1")
        step1["status"] = "completed"
        step1["progress"] = 100
        step1["outcome_reported_at"] = now
        step1["task_report"] = """
## 报销单收单与分类统计报告

### 一、总体概况
- **审核月份**：2026年7月
- **报销单总数**：156 笔
- **报销总金额**：283,450.00 元
- **涉及员工**：89 人
- **涉及部门**：12 个

### 二、分类统计

| 类别 | 笔数 | 金额（元） | 占比 |
|------|------|-----------|------|
| 差旅费 | 62 | 142,800.00 | 50.4% |
| 餐饮招待费 | 38 | 68,500.00 | 24.2% |
| 办公用品费 | 27 | 38,200.00 | 13.5% |
| 通讯费 | 19 | 12,350.00 | 4.4% |
| 其他 | 10 | 21,600.00 | 7.6% |

### 三、单笔金额 Top 5
1. 张伟（销售部）- 深圳客户拜访差旅 - 12,850 元
2. 李娜（市场部）- 上海行业峰会差旅+招待 - 11,200 元
3. 王强（销售部）- 北京季度复盘差旅 - 9,600 元
4. 陈静（采购部）- 办公设备采购 - 8,900 元
5. 刘洋（技术部）- 技术交流会议差旅 - 7,500 元

### 四、部门分布 Top 3
1. 销售部：42 笔，98,500 元（34.7%）
2. 技术部：31 笔，62,300 元（22.0%）
3. 市场部：25 笔，58,700 元（20.7%）

### 五、初步发现的问题
1. 有 8 笔报销缺少纸质发票附件（仅电子小票）
2. 3 笔报销单填写的项目名称与实际费用类型不符
3. 月末（7月28-31日）集中提交了 47 笔，占全月 30%，存在月末突击报销现象
4. 2 笔报销的员工已离职，需核实
"""

        # 步骤 2：合规校验
        step2 = next(s for s in subtasks if s.get("ref") == "2")
        step2["status"] = "completed"
        step2["progress"] = 100
        step2["outcome_reported_at"] = now
        step2["task_report"] = """
## 报销合规性校验报告

### 一、抽查范围
- 抽查比例：30%（47 笔）
- 抽查金额：112,800 元（占总金额 39.8%）
- 抽查原则：大额必查 + 随机抽样

### 二、各项检查结果

| 检查项 | 抽查数 | 不合规数 | 不合规金额 | 问题率 |
|--------|--------|---------|-----------|--------|
| 发票真实性 | 47 | 3 | 8,200 元 | 6.4% |
| 金额超标 | 47 | 5 | 12,500 元 | 10.6% |
| 审批完整性 | 156 | 7 | 18,300 元 | 4.5% |
| 报销时限 | 156 | 12 | 28,700 元 | 7.7% |

### 三、整体合规率
- **笔数合规率**：82.1%（128/156 笔完全合规）
- **金额合规率**：78.5%（222,500/283,450 元）
- **风险等级**：⚠️ 中等偏上

### 四、典型不合规案例

**案例 1：住宿超标**
- 员工：张伟（销售部）
- 问题：深圳出差住宿 5 天，日均 680 元，超一线城市标准 500 元/天
- 涉及金额：超标 900 元
- 原因说明：客户指定会议酒店，价格偏高

**案例 2：发票真伪存疑**
- 员工：赵某（市场部，匿名）
- 问题：一张 3,200 元的餐饮发票，税号查询无记录
- 涉及金额：3,200 元
- 处理建议：退回重开

**案例 3：审批缺失**
- 员工：孙某（技术部，匿名）
- 问题：7,500 元差旅报销仅有直属领导审批，缺部门负责人审批
- 涉及金额：7,500 元
- 处理建议：补审批后再审

### 五、主要违规类型分析
1. 报销时限问题最普遍（12 笔），多为员工遗忘，集中在 40-60 天区间
2. 金额超标主要集中在销售部门（4/5 笔），与业务招待性质相关
3. 发票问题虽然数量少，但性质严重，需重点关注
"""

        # 步骤 3：异常识别
        step3 = next(s for s in subtasks if s.get("ref") == "3")
        step3["status"] = "completed"
        step3["progress"] = 100
        step3["outcome_reported_at"] = now
        step3["task_report"] = """
## 报销异常识别与风险标记报告

### 一、异常发现汇总

| 异常类型 | 发现数量 | 涉及金额 | 风险等级 |
|----------|---------|---------|---------|
| 疑似重复报销 | 2 笔 | 4,800 元 | 🔴 高 |
| 金额异常（整数/临界值） | 8 笔 | 22,500 元 | 🟡 中 |
| 时间异常（节假日/月末集中） | 15 笔 | 35,200 元 | 🟡 中 |
| 人员异常（高频高额） | 3 人 | 45,800 元 | 🔴 高 |

### 二、高风险人员清单

**人员 A（销售部）** - 风险等级：🔴 高
- 本月报销 12 笔，合计 28,500 元，为同岗位均值的 2.3 倍
- 可疑点：
  1. 有 3 笔餐饮发票金额均为 980 元（接近 1000 元审批阈值）
  2. 2 笔差旅的酒店发票连号，疑似套开
  3. 报销时间多为周末

**人员 B（市场部）** - 风险等级：🟡 中高
- 本月报销 8 笔，合计 18,300 元
- 可疑点：
  1. 一笔 5,000 元办公用品采购，无入库记录
  2. 招待费报销频繁但缺少客户信息

**人员 C（技术部）** - 风险等级：🟡 中
- 本月报销 9 笔，合计 15,600 元
- 可疑点：
  1. 多次报销同城打车费用，单日最高 8 笔
  2. 加班餐补报销日期与考勤记录不符

### 三、高风险部门
- **销售部**：报销金额最大，超标率最高，异常笔数最多
- **市场部**：招待费占比过高，发票真实性存疑比例高

### 四、重点核查清单（5 项）
1. 🔴 人员 A 的 3 笔临界金额餐饮发票，需核实业务真实性
2. 🔴 疑似重复报销的 2 笔差旅，需比对行程和发票
3. 🟡 月末集中报销的 15 笔，抽查是否为突击花钱
4. 🟡 5,000 元办公用品采购，需核实入库单
5. 🟡 离职员工的 2 笔报销，需确认是否为在职期间发生

### 五、建议措施
1. 对高风险人员进行约谈和专项审计
2. 完善报销系统的实时异常预警功能
3. 加强销售部门的报销培训和审批力度
"""

        # 步骤 4：记账汇总
        step4 = next(s for s in subtasks if s.get("ref") == "4")
        step4["status"] = "completed"
        step4["progress"] = 100
        step4["outcome_reported_at"] = now
        step4["task_report"] = """
## 记账凭证与科目汇总表

### 一、各科目借方金额汇总（已剔除不合规部分）

| 会计科目 | 金额（元） | 笔数 | 备注 |
|---------|-----------|------|------|
| 管理费用-差旅费 | 68,500.00 | 32 | 技术/行政/财务等部门 |
| 管理费用-业务招待费 | 22,300.00 | 15 | 行政人事部门招待 |
| 管理费用-办公费 | 35,800.00 | 25 | 办公用品、耗材 |
| 管理费用-通讯费 | 11,200.00 | 18 | 手机话费、固话 |
| 销售费用-差旅费 | 52,600.00 | 24 | 销售部门差旅 |
| 销售费用-业务招待费 | 32,100.00 | 18 | 客户招待 |
| **合计** | **222,500.00** | **132** | 合规入账部分 |

### 二、主要记账凭证示例

**凭证 1：差旅费报销**
```
借：销售费用-差旅费   8,500.00
    管理费用-差旅费   3,200.00
    应交税费-应交增值税（进项税额）  945.00
  贷：其他应收款-备用金        12,645.00
```
摘要：7月销售部张伟、技术部刘洋等差旅费报销

**凭证 2：业务招待费**
```
借：销售费用-业务招待费  12,800.00
    管理费用-业务招待费   5,600.00
  贷：银行存款              18,400.00
```
摘要：7月客户招待餐费报销

**凭证 3：办公用品采购**
```
借：管理费用-办公费   8,900.00
    应交税费-应交增值税（进项税额）  1,157.00
  贷：银行存款              10,057.00
```
摘要：采购部办公设备采购报销

### 三、待抵扣进项税额估算
- 差旅费（住宿费 6%）：约 4,200 元
- 办公用品（13%）：约 4,150 元
- 通讯费（6%）：约 670 元
- **合计待抵扣进项税**：约 **9,020 元**

### 四、环比变动分析（vs 6月）
| 指标 | 6月 | 7月 | 变动 | 变动率 |
|------|-----|-----|------|--------|
| 报销总金额 | 256,800 | 283,450 | +26,650 | +10.4% |
| 合规入账金额 | 215,000 | 222,500 | +7,500 | +3.5% |
| 不合规金额 | 41,800 | 60,950 | +19,150 | +45.8% ⚠️ |
| 合规率 | 83.7% | 78.5% | -5.2% | 下降 |

**变动原因分析**：
1. 7月为季度末，销售活动增加导致差旅费和招待费上升
2. 不合规金额大幅上升，主要是报销时限问题增多（新员工不熟悉制度）
3. 建议下月加强报销培训，特别是针对新入职员工
"""

        # Rollup 步骤也标记完成（模拟 rollup agent 的输出）
        rollup = next(s for s in subtasks if is_rollup_subtask(s))
        rollup["status"] = "completed"
        rollup["progress"] = 100
        rollup["outcome_reported_at"] = now
        rollup["task_report"] = """
# 2026年7月费用报销审核总报告

## 一、总体概览

### 基本数据
- **审核月份**：2026年7月
- **报销单总数**：156 笔
- **报销总金额**：283,450.00 元
- **涉及员工**：89 人，12 个部门
- **合规入账金额**：222,500.00 元
- **不合规金额**：60,950.00 元

### 分类占比
- 差旅费：50.4%（142,800 元）
- 餐饮招待费：24.2%（68,500 元）
- 办公用品费：13.5%（38,200 元）
- 其他：11.9%

## 二、合规性分析

### 合规率
- **笔数合规率**：82.1%
- **金额合规率**：78.5%
- **风险等级**：⚠️ 中等偏上
- **环比变化**：合规率较 6 月下降 5.2 个百分点

### 主要违规类型
1. 报销时限问题（12 笔，28,700 元）- 最普遍
2. 金额超标（5 笔，12,500 元）- 销售部门为主
3. 审批缺失（7 笔，18,300 元）
4. 发票真伪问题（3 笔，8,200 元）- 性质最严重

## 三、异常清单

### 高风险事项
1. 🔴 疑似重复报销 2 笔，涉及 4,800 元
2. 🔴 高风险人员 3 名，涉及 45,800 元
3. 🟡 金额异常（临界值）8 笔，22,500 元
4. 🟡 月末突击报销 15 笔，35,200 元

### 重点核查项
- 销售部员工 A：3 笔临界金额餐饮发票需核实
- 市场部员工 B：5,000 元办公用品采购无入库单
- 2 笔疑似重复报销需比对行程

## 四、记账汇总

### 科目分布
- 管理费用合计：137,800 元
- 销售费用合计：84,700 元
- 待抵扣进项税：约 9,020 元

### 环比警示
不合规金额较 6 月上升 45.8%，需引起重视。

## 五、处理建议与改进措施

### 本月处理
1. 3 笔问题发票退回重开
2. 7 笔缺审批的退回补签
3. 高风险人员进行约谈
4. 不合规金额从报销中扣除

### 制度改进
1. **加强培训**：针对新员工开展报销制度培训
2. **系统优化**：增加报销系统实时异常预警（金额临界值、重复提交检测）
3. **审批强化**：销售部门招待费增加财务前置审核
4. **时限管控**：超 30 天报销系统自动拦截，特殊情况需说明
5. **定期审计**：每季度抽查高风险部门，形成震慑

---
**报告生成时间**：2026-08-06
**审核人**：财务系统自动审核
"""

        # 保存并同步
        storage.save_project(proj)
        sync_main_task_from_subtasks(storage, task_id)

        # 验证 rollup 结果
        final = find_main_task(storage, task_id)
        assert final is not None
        _, ft = final

        # rollup 已应用
        assert ft.get("rollup_applied_at") is not None, "Rollup should be applied"
        assert ft.get("result_summary") is not None, "Result summary should be set"

        summary = ft.get("result_summary") or ""
        # 验证 rollup 报告包含关键业务内容
        assert "总体概览" in summary or "总报告" in summary, "Rollup report should have overview"
        assert "合规" in summary, "Rollup report should mention compliance"
        assert "异常" in summary, "Rollup report should mention anomalies"
        assert "建议" in summary, "Rollup report should have suggestions"

        # 验证主任务状态为 completed
        assert ft.get("status") == "completed", f"Main task should be completed, got {ft.get('status')}"
        assert ft.get("progress") == 100

    def test_finance_answer_node_only_mode(self, sqlite_tmp: Path) -> None:
        """财务场景 answer_node_only 模式：只取指定步骤的结果作为最终答案。"""
        del sqlite_tmp
        from evoflow.collab import app_runner
        from evoflow.collab.storage import get_project_storage, find_main_task
        from evoflow.collab.task_progress import sync_main_task_from_subtasks
        from evoflow.persistence import app_repositories
        from evoflow.timeutil import utc_now_iso_z

        def get_db():
            from evoflow.persistence.db import get_db as _get_db
            return _get_db()

        get_db()
        app = _make_finance_app()
        app["final_rollup"] = "answer_node_only"
        app["answer_from_ref"] = "4"  # 直接用记账汇总作为最终答案
        app_repositories.save_app("finance_answer_node", app)

        result = app_runner.run_app_workflow(
            "finance_answer_node",
            {"month": "2026年7月", "total_count": 156},
            auto_authorize=True,
        )
        task_id = str(result.get("task_id") or "").strip()
        assert task_id

        storage = get_project_storage()
        found = find_main_task(storage, task_id)
        assert found is not None
        proj, task = found

        subtasks = task.get("subtasks") or []
        now = utc_now_iso_z()

        # answer_node_only 模式不生成 rollup 子任务，应该只有 4 个
        assert len(subtasks) == 4, f"answer_node_only should have 4 subtasks, got {len(subtasks)}"

        # 标记所有步骤完成
        for s in subtasks:
            s["status"] = "completed"
            s["progress"] = 100
            s["outcome_reported_at"] = now
            s["task_report"] = f"步骤 {s.get('ref')} 完成报告"

        storage.save_project(proj)
        sync_main_task_from_subtasks(storage, task_id)

        final = find_main_task(storage, task_id)
        assert final is not None
        _, ft = final

        # answer_node_only 模式也应该应用 rollup（从 answer 节点取结果）
        assert ft.get("rollup_applied_at") is not None
        assert ft.get("status") == "completed"
