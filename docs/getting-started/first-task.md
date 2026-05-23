# 完成第一个任务

## 你将学到什么

- 让 Agent 执行一个多步骤任务
- 观察子 Agent 的委派过程
- 查看任务产出的文件

## 前置条件

- 已完成 [5 分钟快速上手](quick-start.md)
- EvoFlow 正在运行

## 步骤

### 1. 发起任务

在 EvoPanel 聊天界面输入：

```
帮我调研当前主流的 AI Agent 框架，写一份对比报告
```

### 2. 观察执行过程

Agent 会：
1. 分析问题，拆解需要调研的维度
2. 调用搜索工具收集信息
3. （如果启用了子 Agent）委派子 Agent 并行调研不同框架
4. 综合结果，生成报告

你可以在 EvoPanel 的**任务中心**看到：
- 实时进度
- 子任务状态
- Agent 的工具调用记录

### 3. 查看产出

任务完成后，Agent 会将报告保存在沙箱的 `/mnt/user-data/outputs/` 目录中。

在 EvoPanel 中，你可以直接在对话中看到和下载产出的文件。

### 4. 尝试 Plan 模式

对于更复杂的任务，可以开启 Plan 模式：

```
/config set is_plan_mode true
```

Agent 会先列出 TODO 清单，规划步骤后再执行。

## 你完成了！

现在你已经体验了 EvoFlow 的核心能力。

## 下一步

- [配置你的第一个模型](../tutorials/configure-models.md) — 学习更多模型配置选项
- [创建自定义 Agent](../tutorials/create-agent.md) — 定制专属 Agent
- [多智能体协作](../tutorials/multi-agent-collab.md) — 体验项目级任务编排
