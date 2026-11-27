---
name: agent-prompt-blueprint
description: >-
  智能体提示词母版库：给 system_prompt / soul 的 RTCO 装配母版、六种岗位原型、可判定性改写规则、
  平台真实工具目录与退役工具名对照、12 条高频缺陷自检清单。用户要新建或改造智能体、写或审
  system_prompt 与 soul、问「角色怎么设定」「提示词怎么写才稳」「这个智能体的提示词有什么问题」时使用。
  本技能只管「怎么写」；「怎么落盘」（agent_code 校验、能力包、agents.create 强制顺序）走
  evoflow-admin 的 references/preset-role.md，两者配合使用，不要互相替代。
---

# 智能体提示词母版库

**一句话定位**：`evoflow-admin/preset-role.md` 管「能不能建、怎么落盘」，本技能管「提示词写成什么样才算合格」。

## 三条铁律

1. **角色要窄**。一个 Agent 只干一类活。出现「又采集、又写文案、又出图、又剪片」的角色，先拆成多个 Agent，或至少给每个模块写独立的完成判据——否则每个模块都只能停在"最低可执行"。
2. **可判定优先于有文采**。「专业一些」「质感好」「尽量准确」不可判定，模型无法判断自己是否达标。「每条结论必须指到原文句子」「缺项写未采到」「同一处最多改 2 轮」可判定。
3. **不承诺做不到的事**。提示词里出现的每个工具名、模型 id、路径、端口、外部服务，落盘前必须实测存在。**退役工具名是最常见的 P0**——见 `references/reality-cheatsheet.md`。

## 五步工作流

| 步 | 动作 | 产出 |
|---|---|---|
| 1 拆 | 明确：服务谁、典型任务 2–3 个、绝对不做的事、是否需要联网/终端/写盘 | 一句话职责 + 禁止项清单 |
| 2 选档 | 按 `references/archetypes.md` 归到六种岗位原型之一，取对应母版；定篇幅档（窄/均衡/宽） | 选定母版 |
| 3 装配 | 按 `references/rtco.md` 五段逐段填，每段一句只归一段 | system_prompt 草稿 |
| 4 配 soul | 按 `references/soul-template.md` 写"是谁"，与 system_prompt 的"怎么做"分工，不重复 | soul 草稿 |
| 5 自检 | 过 `references/audit-checklist.md` 12 条，再看下方交付清单 | 可落盘版本 |

## 六种岗位原型（选档入口）

| 原型 | 一句话 | 篇幅档 | 能力包 |
|---|---|---|---|
| 采集分析型 | 只出事实表与对比，不写结论 | 窄–均衡 | `research` |
| 生产制作型 | 固定参数加工素材成成品 | 均衡–宽 | `writer` + 所需 MCP |
| 审核判定型 | 只判通过/不通过，不加润色 | 窄 | `research` |
| 客服应答型 | 有依据才答，无依据转人工 | 窄 | `research` + 知识库 |
| 调度编排型 | 拆活派活验收，不亲自执行 | 均衡 | `duty` + `subagent` |
| 值守运维型 | 巡检止损上报，白名单外不动手 | 窄–均衡 | `duty` |

## 文件索引

| 文件 | 何时读 |
|---|---|
| `references/rtco.md` | 装配时逐段对照；判断一句话该放哪段 |
| `references/archetypes.md` | 选母版、抄结构、看每种原型的常见错法 |
| `references/soul-template.md` | 写 soul；区分 soul 与 system_prompt 职责 |
| `references/reality-cheatsheet.md` | **落盘前必读**：真实工具目录、退役工具名、必须实测的三类东西 |
| `references/audit-checklist.md` | 自检、或审别人的提示词 |
| `examples/ecommerce-audit.md` | 看一份真实提示词的 12 条缺陷与补丁（反例教材） |

## 交付前 10 条自检

- [ ] 角色能用一句话说清、且只有一个岗位
- [ ] 五段齐全：角色 / 任务 / 背景 / 输出契约 / 护栏
- [ ] 有一段显式**裁决顺序**（规则冲突时听谁的）
- [ ] 至少 4 条规则可被第三方判真假（有数字、有字段、有上限）
- [ ] 输出契约有固定字段或固定小标题，缺项有约定值（如「未采到」）
- [ ] 有不确定性出口（`unknowns` 字段或「待核实」标注）
- [ ] 工具名、模型 id、路径、端口**全部实测存在**，无退役工具名
- [ ] 金额/价格类不允许自估，必须取权威报价
- [ ] 循环类规则有终止条件（最多几轮、几次）
- [ ] soul 与 system_prompt 无重复段，改一处不会漏另一处

## 与其它资产的关系

- **落盘**：`evoflow-admin` → `references/preset-role.md`（agent_code 校验 → 盘点技能 → 选能力包 → 用户确认 → `agents create`）
- **机检**：`python scripts/prompt-audit/prompt_audit.py <file>`（结构诊断）、`python backend/scripts/prompt_drift_guard.py`（退役工具名/死路径）
- **真实资产**：`evoflow agents bindings`（工具与能力包）、`evoflow mcp <server> test`（MCP 工具名）、`evoflow media catalog`（模型 id）
