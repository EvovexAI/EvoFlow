---
name: self-evolution
description: 执行任务时持续改进技能、经验库与智能体配置。修补过时/错误的 SKILL.md、复杂任务后沉淀经验（experience save/list/mark-used）、缺能力时新建或调整自定义 Agent/技能。用户提到「优化技能」「保存经验」「上次怎么解决的」「给这个助手加能力」时使用；CLI 细节见 evoflow-admin，读本技能后按需 read skill:self-evolution 全文。
---

# 自我进化

执行任务的同时，持续改进**技能**、**经验**与**智能体配置**。治理类 CLI 走 **evoflow-admin** + `terminal`；本技能管**何时、怎么做**。

## 何时读本文

- 发现某技能步骤过时、命令报错、接口已废弃
- 任务像「以前解决过的问题」，或刚完成一次难缠的 bugfix / 可复用流程
- 子任务因缺工具失败、重复性工作适合专用助手、要新建/调整自定义 Agent
- 用户明确要求优化技能、保存经验、进化助手能力

## 技能（Skills）

技能是可复用工作流，写在 `SKILL.md` 里。

1. **用前读全文**（`read` / `skill:<name>`）。
2. **立刻修补**：步骤缺漏、命令错误、过时 API——不要等用户提醒。
3. **可优化就优化**：有更好的做法就改步骤；复杂且可复用的流程若无对应技能，可新建（见 **skill-creator**）。
4. **改完验证**：能跑 CLI/脚本的就跑一遍；技能描述触发不准时用 skill-creator 的 eval 流程。

编辑路径：``evoflow skills get <name>`` 确认位置 → `read` / `write` / `replace` 改 `skills/custom/…/SKILL.md`（host 工作区可见时）。

## 经验（Experience）

经验库记录「上次怎么解决的」。

| 时机 | 动作 |
|------|------|
| 开工前像老问题 | `evoflow experience list --query "关键词"` |
| 难缠任务 / bugfix 完成后 | 评估是否 `evoflow experience save --file …` |
| 复用已有经验 | `evoflow experience mark-used <id>` |

命令与 JSON 格式见 **evoflow-admin**「Experience library」章节。

## 智能体（Agents）

以下情况读 **evoflow-admin**，经 **terminal** 跑 `evoflow` CLI：

- 角色常缺某类能力
- 重复性工作适合专用助手
- 子任务因缺工具反复失败
- 角色不再需要或要合并能力

典型流程：`evoflow agents check` → `evoflow skills list --enabled-only` → `evoflow agents create/update --file …`

## 纪律

- **真落盘**：技能/Agent/经验要写入文件或 CLI，不要只口头说「已优化」。
- **最小改动**：进化不等于大重构；一次解决一类问题。
- **每次交互留意**：什么能复用、什么要修、什么能做得更好——需要时再读本技能，不必每轮复述流程。
