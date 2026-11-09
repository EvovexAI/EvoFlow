# 问题说明书：`output_schema` 运行期哑配置

> 交接用。对方无会话上下文、未跑过这条流、看不到本机 DB。  
> 文中区分 **【实证】** 与 **【推断】**。优先按「反方视角」证伪，不要顺着结论走。  
> **状态（2026-11-09）**：生产派发接线缺口 + vacuously valid + 默认 warn **已修**；以文末「已落地的修复」为准。更完整的可转发稿见 `outputs/工作流绑定缺陷交接.md`。

## 一句话

工作流节点可声明 `output_schema`，发布期校验当真，但运行期若 worker 不产出 JSON，则 `structured_output` 为空、下游 `{{steps.X.output.字段}}` 绑定被 production 门禁硬失败。阻断语义本身正确；**根因曾是**：生产 `_build_subtask_enriched_prompt` 丢掉契约块 + 缺产出曾被判合法 + 默认 `warn` 静默放行。

---

## 现象（可复现）

| 项 | 值 |
|---|---|
| App | `App_20261108225156_bb78ab` |
| 失败 Run | `Run_20261108225202_6984aa` / main `2611082252_984e` |
| 对照成功 Run | `2611082257_109a`（v3，**未**声明 output_schema，绑 `.summary`） |
| 库 | `C:/Users/admin/.evoflow-dev/data/app/evoflow.db` |

失败流：三节点串行 collect → expand → audit。expand 派发前：

```
Unresolved input bindings (production mode):
points: unresolved {{steps.collect.output.points}}; target_count: expected number, got str
```

→ expand failed → audit skipped → run failed。

### SQL 入口

```sql
SELECT subtask_id, name, status, extra_json
FROM evoflow_collab_subtasks
WHERE main_task_id = '2611082252_984e'
ORDER BY sort_order;

SELECT plan_steps_json
FROM evoflow_collab_tasks
WHERE main_task_id = '2611082252_984e';
```

### 【实证】两跑对比

| | v2 `2611082252_984e`（声明了 output_schema） | v3 `2611082257_109a`（未声明） |
|---|---|---|
| plan collect `output_schema` | 有 `topic`/`points` | 无 |
| expand 绑定 | `{{steps.collect.output.points}}` + `input_schema.number` | `{{steps.collect.summary}}` + `count_str` string |
| collect `extra_json.structured_output` | **缺失** | **缺失** |
| expand 状态 | failed（绑定门禁） | completed |
| Step3 `structured_output` | （skipped） | `{}` + `schema_valid=true` |

**v3 Step3 的 `{}` 推翻了「抽取路径永远写不进」**：`extract_structured_output` 的 trailing-JSON 能落库；问题是缺 schema 约束 / 上游没产出可用字段。

---

## 存储路径（此前未闭合的一环）【实证】

- **无** `structured_output` 专用列。
- `apply_subtask_outcome_report` → `outcome_meta` → `patch_collab_subtask_in_project_storage` → bundle save → `task_row_mappers._split_extra`：非 known 字段进 `evoflow_collab_subtasks.extra_json`。
- 读回：`_merge_extra` 把 `extra_json` 展平到子任务 dict。
- 下游：`build_steps_output_from_subtasks` 读 `st["structured_output"]` → `steps[<ref>].output`。

验证：对已完成且写出 JSON 的行，`json_extract(extra_json,'$.structured_output')` 非空（v3 Step3）；失败跑 collect 该键不存在。

---

## 发布期 vs 运行期【实证】

发布期 **check3b**（`workflow_validator.py` ~234–275）：`{{steps.A.output.field}}` 要求 `A.output_schema.properties` 声明该字段。  
运行期读者（修前）：`structured_output.py` / `subtask_outcome.py` / validator / debug_runner / app_schema — **`step_prompt_builder` 不注入 schema**。  
`done.structured_output` 为 Optional，无提示则 worker 无动力回传 JSON。

---

## 根因排序（已用本机 DB 复核后修正）

### R1 — worker 不知契约 + 散文无 JSON 【实证 · 本跑主因】

对失败跑 collect：

```text
get_step_output_schema(subtask, plan_steps=plan_steps_json) → 找到 schema（props topic/points）
process_step_output(task_report, schema) → structured=None, extraction_source=none
```

报告是 markdown 散文，无 fence/trailing JSON → **不写** `structured_output` → `steps.collect.output == {}` → `points` 未解析。

### R2 — 「声明了 schema 却零产出」曾被 vacuously valid 【实证 · 代码】

修前 `process_step_output`：`structured is None` → `schema_valid=True`（注释 vacuously valid）。  
默认 enforcement=`warn`，strict 的 block 永不因「缺产出」触发。  
下游仍靠绑定门禁才失败（语义对，但失败点偏晚、归因成 expand 而非 collect）。

### R3 — 参数类型全是 str 【实证】

- `RunAppRequest.parameters: dict[str, str]`（`app/gateway/routers/apps.py`）
- `admin/apps.py` 再 `str(v)`  
→ `{{params.count}}` 进 `input_schema` type=number → `expected number, got str`。

### R4 — schema 按 ref 查找缺语义别名 【实证为潜伏；本跑非主因】

```python
# 未归一化 plan（作者语义 ref）→ None
get_step_output_schema({"ref":"1","semantic_ref":"collect"},
                       [{"ref":"collect","output_schema":S}])

# 本跑 plan_steps_json 已是 ref="1"+semantic_ref → 能命中
get_step_output_schema(..., [{"ref":"1","semantic_ref":"collect","output_schema":S}])
```

`build_steps_output_from_subtasks` 已用 `subtask_semantic_ref` 做数字/语义镜像；修前 `get_step_output_schema` 漏桥。  
**本失败跑 plan 已归一化，lookup 成功**，故 R4 不是本次硬失败原因。

### R5 — 同步未把 output_schema 落到子任务行 【实证】

`plan_subtasks_sync.py` 修前不写 `output_schema`；行内兜底空。本跑靠 `plan_steps_json` 回查仍可用。

### 已排除

- **run_kind=debug**：全仓无按 run_kind 分支的执行逻辑；仅标签。曾误判「导致产物不注册」——作废。
- **「structured_output 永远写不进」**：被 v3 Step3=`{}` 证伪。

---

## 反方视角（优先证伪）

1. **「本跑是 ref 桥断裂」？** 用上面两条 `get_step_output_schema` + 真实 `plan_steps_json` 即可证伪：本跑能命中。
2. **「设计只做发布期静态校验、运行期不该要 JSON」？** 与 `structured_output.py` 模块头、`done.structured_output`、`schema_enforcement`、handoff「结构化优先」矛盾——除非文档/产品明确撤回 `.output` 绑定。查 git log / 设计稿判定意图。
3. **「修 vacuous 即可端到端绿」？** 默认 `warn` 下 collect 仍 completed；expand 仍会因空 `output` 挂。要跑通还需 worker 真产出 JSON（prompt 注入或强制 done 参数）。
4. **「v3 有 structured_output 说明 v2 schema 害了抽取」？** v3 Step1/2 同样无 `structured_output`；仅 Step3 trailing `{}`。v3 成功因绑的是 `.summary`。

---

## 建议验证顺序

1. 复现 R1：真实 DB collect 行 + `process_step_output(report, schema)` → None。  
2. 复现 R4 潜伏：未归一化 `ref=collect` plan → None；归一化后 → S。  
3. 复现 R3：`build_core_prompt` + `target_count: "{{params.count}}"` + params `{"count":"4"}` + input_schema number（修前应 TYPE_MISMATCH）。  
4. 判产品意图：补齐运行期契约，还是撤掉 `.output.*` 文档/编辑器能力。

---

## 本仓已落地的修复

| 点 | 改动 |
|---|---|
| R2 | `process_step_output`：有 schema 且无 JSON → `schema_valid=False`（不再 vacuously valid） |
| R4 | `get_step_output_schema` / `find_plan_step_for_subtask`：语义+数字别名 |
| R1 | `format_output_schema_for_prompt`；**生产** `_build_subtask_enriched_prompt` 直接注入（不只靠 `build_core_prompt` 第 5 段） |
| 默认策略 | `schema_enforcement` 默认 `strict`（`schema_enforcement.py` / `app_schema` / `app_runner`） |
| R5 | `plan_subtasks_sync` 把 output/input_schema、input_bindings 写入子任务行 |
| R3 | resolve 后按 input_schema 软 coerce number/integer/boolean 字符串 |
| 标签 | platform `workflow.run` / `admin.apps.run_app` 默认 `run_kind=production`（不再硬编码 debug） |
| 测试 | `backend/tests/test_structured_output_contract.py`（含 enriched prompt 断言） |

回归：`cd backend && uv run python -m pytest tests/test_structured_output_contract.py tests/test_expression_resolver_semantic_ref.py -q`
