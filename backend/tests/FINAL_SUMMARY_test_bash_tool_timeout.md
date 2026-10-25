# `test_bash_tool_timeout.py` 分析工作 —— 最终汇总报告

> 工作流：Step 1 静态分析 → Step 2 改进建议 → Step 3 收尾汇总
> 目标文件：`backend/tests/test_bash_tool_timeout.py`（102 行）
> 被测源码：`backend/packages/harness/evoflow/tools/zcode_port/bash_tool.py`
> 本工作流**全程只读**：未修改任何测试源码与业务源码，也未提交任何变更。

---

## 一、最终结论（先看这里）

1. **测试可运行、当前全绿**：`python -m pytest tests/test_bash_tool_timeout.py -q` → **13 passed**（8 个 `test_` 函数，其中 1 个 parametrize 6 组）。
2. **但断言质量存在 3 处硬伤（P0），其中 2 处使用例在当前实现下「恒真」**——常量被改坏、阈值被放宽也照样全绿，等于把契约测试退化成了实现快照。
3. **覆盖存在明显空洞**：13 个实例全部集中在 5 个纯函数上；`_semantic_timeout`、`_stale_hint_for` 写命令门控、`_format_finished` 输出信封、`_preview_first`、`bash_shell()`（WindowsApps 假 shell）、`_kill_process_tree` 的 `except → os.kill` 兜底分支**零覆盖**。其中 kill 兜底分支是 Windows 下「taskkill 不可用」时唯一的止损点。
4. **按建议落地后**：用例数 13 → 约 40，首次覆盖上述 6 个函数/分支，并以变异测试证明新断言确实会红。

**可直接使用的交付物**：`backend/tests/IMPROVEMENTS_test_bash_tool_timeout.md`（375 行）——P0/P1/P2 排序，每条含「理由（源码位置）+ 可直接粘贴的 pytest 写法 + 落地顺序 + 变异验证方式」，按文档顺序抄即可实施。

---

## 二、Step 1：静态分析核心结论

### 规模与场景
- 8 个 `test_` 函数 / **13 个用例实例**（`test_probe_command_detection` = 6 组）。
- 覆盖的 5 个纯函数：`_PROBE_COMMAND_RE` 匹配、`_effective_timeout_ms`、`_blocking_budget_ms`、`_timeout_was_explicit`、`_model_stream`（落盘 + 内联两条路径）。

### 断言强度分级
| 强度 | 用例 | 说明 |
|---|---|---|
| 最强 | `test_small_stdout_stays_inline` | `truncated is False` + `shown == "git status ok"` 精确等值 |
| 最强 | `test_large_stdout_is_persisted_with_short_preview` | 落盘后文件内容全文等值 + 信封结构与 `Full output saved to:` 路径 |
| 中/强 | `test_stale_read_hint_after_mtime_change` | 子串 + `resolve()` 绝对路径 |
| 强（但为现状快照） | `test_probe_command_detection` ×6 | `matched is expect_probe` 精确布尔等值，期望值来自现状；正则表成员覆盖不全 |
| **中/弱** | `test_effective_timeout_soft_caps_probes_when_implicit` | 右侧引用 `bt.PROBE_TIMEOUT_MS`（常量自引用） |
| **中/弱** | `test_blocking_budget_backgrounds_implicit_long_commands` | 右侧引用 `bt.ASSISTANT_BLOCKING_BUDGET_MS`（常量自引用） |

### 关键缺口
- **契约值未硬编码**：`PROBE_TIMEOUT_MS`（实测 30000，env 可覆盖）与 `ASSISTANT_BLOCKING_BUDGET_MS`（15000）是对外契约（对位 ZCode 的 `bash.ts resultBudget` / `bash-model-content.ts`），但测试右侧就是被测常量本身。
- **`len(shown) < MAX_INLINE_BYTES` 在落盘分支恒真**：任何 ≤30KB 的信封都通过（包括 29KB），完全没有约束 `MODEL_PREVIEW_CHARS=2000` 这一维度。
- **kill 路径兜底零覆盖**：`subprocess.run` 被 mock 成功返回，`except Exception: os.kill(pid, 9)` 从未执行；`capture_output=True, timeout=8`（kill 路径自身不许死锁）无人守。

### 事实校正（Step 2 对 Step 1 摘要的修正，已核实）
| 项 | Step 1 摘要 | 核实结果 |
|---|---|---|
| 用例计数 | 7 个函数 / 12 实例 | **8 个函数 / 13 实例**（漏评 `test_stale_read_hint_after_mtime_change`、`test_small_stdout_stays_inline`，已补评） |
| 常量真值 | 多处「自引用」 | `PROBE_TIMEOUT_MS=30000`、`ASSISTANT_BLOCKING_BUDGET_MS=15000`、`MAX_INLINE_BYTES=30000`、`MODEL_PREVIEW_CHARS=2000`、`MAX_BASH_TIMEOUT_MS=600000`、`DEFAULT_TIMEOUT_MS=120000` → **「自引用=弱断言」判断成立** |

> 两处摘要差异不影响主结论（P0 三处硬伤、覆盖空洞均成立），仅计数与列表需以 Step 2 校正值为准。

---

## 三、Step 2：改进建议要点（按优先级）

### P0 —— 本轮必做（3 处）

| 编号 | 问题 | 改法 | 变异验证 |
|---|---|---|---|
| **P0-1** | 软上限/阻塞预算用常量自引用作期望值 → 恒真 | 硬编码契约值 `30_000` / `15_000`，并加 `PROBE_TIMEOUT_MS < DEFAULT_TIMEOUT_MS == 120_000` 相对关系；显式短超时原样保留 | `PROBE_TIMEOUT_MS` 改 `600000` 或 `ASSISTANT_BLOCKING_BUDGET_MS` 改 `120000` → 必须红 |
| **P0-2** | `len(shown) < MAX_INLINE_BYTES` 在落盘分支恒真 | 改为相对 `MODEL_PREVIEW_CHARS` 的预览预算（`< 2000*3`、`< MAX_INLINE_BYTES/10`）+ 信封首尾/字节数文案等值 + 落盘文件全文等值；新增内联阈值边界参数化（`==MAX_INLINE_BYTES` 内联 / `+1` 落盘） | `_model_stream` 的 `<=` 改 `<` → 边界用例必须红 |
| **P0-3** | tree-kill 的 `except → os.kill` 兜底与 `timeout=8` 约定零覆盖 | 拆 3 个用例：完整 `argv` 等值 + `capture_output/timeout` 断言；`subprocess.run` 抛 `OSError` → `os.kill(pid, 9)`；`pid<=0` early return | 删掉 `except Exception: os.kill` → 必须红 |

### P1 —— 高价值新增覆盖（当前完全无对应用例）
`bash_shell()` WindowsApps 假 shell 平台陷阱 · `_semantic_timeout` 钳位/默认值（`None/""/abc→120000`、`0/-5→1`、`600001→600000`）· `_stale_hint_for` 写命令门控（`git status` 不提示 / `ruff format`·`black`·`sed -i`·`cargo fmt` 提示）· `_format_finished` 输出信封（`status: timed_out`、`stdoutTruncated: true` 小写、超时分支不报 truncated）· UTF-8 字节 vs 字符阈值（中文 10000 字 = 30000 字节）· `_effective_timeout_ms` 容错非 str 命令 · `_preview_first` 换行边界回退。

### P2 —— 参数化 / 去重 / 可维护性
prompt 正则表与超时链路共用一张契约表（补齐 `git diff/rev-parse/remote/branch`、`Set-Location`、`GIT STATUS`、`lsblk`/`directory` 反例等 15 条）· `_timeout_was_explicit` 补 `" 15000 "`/`15000.0`/`0` 边界 · 模块级 fixture 收敛重复 import/monkeypatch（含 teardown 重置）· 全局读状态泄漏守卫（与 `test_bash_readonly_policy.py` 共表，执行顺序需确定）· parametrize `ids` 可读性。

### 落地顺序（文档已给）
1. P0-1 / P0-2 / P0-3（3 处小改，预计 < 60 行 diff）
2. P1-2 / P1-4 / P1-5（纯新增，可先跑通）
3. P2-1 合并 probe 契约表
4. P2-3 / P2-4 fixture 收敛 + P2-2 参数化

自检命令：`cd backend && python -m pytest tests/test_bash_tool_timeout.py -q`

---

## 四、验收标准核对

| 验收项 | 结论 | 说明 |
|---|---|---|
| 第一步：静态分析覆盖场景、断言质量、潜在缺口 | **达成** | 8 个函数 / 13 实例逐条给出行为 + 断言强弱分级，缺口按函数列出 |
| 第二步：输出可执行改进建议 | **达成** | 3×P0 + 7×P1 + 5×P2，每条含源码位置、可直接粘贴的 pytest 代码、变异验证方式、落地顺序 |
| 分析/建议基于真实代码而非臆测 | **达成** | 常量真值、行号、分支均对照 `bash_tool.py` 核实；并主动校正了 Step 1 的计数与清单遗漏 |
| 不修改源码（只读分析） | **达成** | 仅新增 Markdown 文档，测试与业务源码零改动 |
| 建议的可验证性 | **达成** | 提供 5 条变异抽查项 + 每次「必须失败」的预期，以及最终 `pytest -q` 自检命令 |

### 风险与保留项
1. **Step 1 / Step 2 的用例计数口径不一致（7/12 vs 8/13）**；本报告统一采用 Step 2 的 **8 个函数 / 13 实例**（与实跑 `13 passed` 一致）。若引用 Step 1 摘要需注意此差异。
2. **P1-1（`bash_shell()`）的写法示例依赖内部候选列表是否可注入**；文档已给出退化方案（黑盒断言「返回值不含 WindowsApps」+ `Path(...).name == 'bash.exe'`），落地时需按实际实现选择。
3. **P0-2 的信封文案断言会随格式改动而红**（如 `29.3KB` 这类由 `_format_byte_size` 产生的字符串）。这是有意为之（锁契约），但格式迭代时需同步更新。
4. **建议尚未落地**：本轮只产出方案，未改动 `test_bash_tool_timeout.py`。实施后需跑一次完整 `pytest -q` 与变异抽查才算闭环。
5. 断言中 `PROBE_TIMEOUT_MS` 可被 `EVOFLOW_BASH_PROBE_TIMEOUT_MS` 覆盖 —— 若 CI 设置了该 env，P0-1 的硬编码 `30_000` 断言会红；建议在用例内 `monkeypatch.delenv` 或用 `pytest.mark.skipif` 显式声明前置条件。

---

## 五、全部产出文件清单

| # | 文件 | 类型 | 说明 |
|---|---|---|---|
| 1 | `backend/tests/IMPROVEMENTS_test_bash_tool_timeout.md` | **最终交付物** | 375 行改进建议（P0/P1/P2 + 代码示例 + 变异验证 + 落地顺序） |
| 2 | `backend/tests/FINAL_SUMMARY_test_bash_tool_timeout.md` | 汇总 | 本报告：最终结论 + 验收核对 + 产出清单 |
| 3 | `backend/tests/test_bash_tool_timeout.py` | 分析对象（**未改动**） | 102 行 / 13 实例，当前全绿 |
| 4 | `backend/packages/harness/evoflow/tools/zcode_port/bash_tool.py` | 被测源码（**未改动**） | 常量与分支真值核对依据 |

> 文件路径以仓库根 `D:/dev/github/EvoFlow` 为基准；测试目录实际位于 `backend/tests/`（Step 1 摘要中的 `backend/backend/tests/` 为路径笔误，已核实文件不存在）。
