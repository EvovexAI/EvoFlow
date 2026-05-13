# 测试方案：Plan 阶段 0 副作用 + 执行阶段不受限

## 目标

- 防回归：planning/plan_ready/awaiting_exec 阶段永远不会产生写/执行/委派类副作用
- 确认 executing 阶段不被错误拦截

## 单元测试（推荐）

### 1) PlanGuard：拦截副作用 tool_calls

- 构造一个带 `tool_calls=[execute_command(...)]` 的 AIMessage
- runtime.context.collab_phase="planning"
- 期望：PlanGuard 输出中 tool_calls 被清空/过滤（或仅剩 allowlist）

### 2) PlanGuard：允许只读工具

- runtime.context.collab_phase="planning"
- tool_calls=[read_file(...), list_dir(...)]
- 期望：tool_calls 保留

### 3) executing：不拦截

- runtime.context.collab_phase="executing"
- tool_calls=[execute_command(...), write_to_file(...)]
- 期望：tool_calls 不被 PlanGuard 修改

## 集成测试（可选）

- 通过 LangGraph runs API 发起一次 planning run
  - 期望：响应文本为计划模板；无执行类工具调用事件
- 授权进入 executing
  - 期望：能够看到执行类工具调用与结果回传

## 可复用真实 API 全流程测试（推荐）

为避免“只测模拟脚本”与真实链路不一致，新增了可复用脚本：

- 脚本：`backend/scripts/e2e_plan_mode_api_test.py`
- 特点：
  - 走真实接口：`/api/langgraph/threads` + `/runs/stream` + `/api/collab/threads/{id}`
  - 覆盖完整生命周期：计划 -> 澄清回复 -> 确认执行
  - 自动校验关键中文日志（`collab_lifecycle_cn.log`）
  - 可选强校验阶段日志（`collab_lifecycle_stage_cn.log`）

### 运行方式

1. 启动后端（LangGraph + Gateway）
   - Windows: `scripts/windows/start-backend.ps1`
2. 执行测试脚本
   - `python backend/scripts/e2e_plan_mode_api_test.py --gateway http://127.0.0.1:8012`
3. 严格校验阶段日志（可选）
   - `python backend/scripts/e2e_plan_mode_api_test.py --gateway http://127.0.0.1:8012 --require-stage-logs`
4. 落盘结果（建议 CI 或留存）
   - `python backend/scripts/e2e_plan_mode_api_test.py --output-json outputs/plan_mode_e2e_result.json`

### 脚本判定标准

- 通过（exit code = 0）：
  - 确认执行后 `collab_phase` 为 `executing` 或 `done`
  - `collab_lifecycle_cn.log` 包含：
    - `场景切换为执行并进入规划`
    - `规划阶段请求工具过滤`
    - `用户确认执行并自动切换阶段`
- 失败（exit code = 2）：
  - 任一关键步骤或日志缺失，脚本会输出 `errors` 列表

### 关键日志定位

脚本会同时在两套路径检索日志（双写场景）：

- 仓库路径：`logs/debug/*.log`
- 运行时路径：`{base_dir}/logs/debug/*.log`（`base_dir` 来自 `/api/runtime/paths`）

### 复测建议

- 每次涉及 `PlanGuard`、`collab_phase`、`scenario_activation`、`lifecycle logging` 改动后，至少运行 1 次该脚本
- 合并前建议加 `--require-stage-logs` 再跑一次，避免关键里程碑日志回归

