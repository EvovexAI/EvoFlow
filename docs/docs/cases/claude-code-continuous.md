# 案例七：Claude Code 持续对话

## 场景说明

EvoFlow 可以调用外部 Claude Code 实例来完成编码、调试和代码库修改任务。智能体作为"指挥官"，Claude Code 作为"执行者"，两者配合实现 AI 辅助开发。

## 前置准备

- 已完成 [安装](../getting-started/installation.md)
- 已安装并配置 Claude Code CLI
- 已配置 ACP（Agent Communication Protocol）包装器

## 操作步骤

### 步骤 1：确保 Claude Code 可用

在终端中确认 Claude Code 已正确安装：

```bash
codex --version
```

同时确认 ACP 包装器已安装：

```bash
npx -y @zed-industries/codex-acp --version
```

<!-- 截图占位：claude-code-step1.png — 确认 Claude Code -->

> **截图说明**：展示终端中运行版本检查命令的输出结果。

### 步骤 2：打开对话并进入执行模式

在 EvoPanel 中打开对话页面，选择 **「执行」** 或 **「无限」** 模式。

<!-- 截图占位：claude-code-step2.png — 选择执行模式 -->

> **截图说明**：展示对话模式选择，标注"执行"模式。

### 步骤 3：输入编码任务

向智能体描述你需要完成的开发任务。

**示例提示词：**

```
请帮我在当前项目中添加一个 REST API 端点 /api/health，
返回服务的健康状态（JSON 格式），
包括版本号、运行时间和依赖连接状态。
```

<!-- 截图占位：claude-code-step3.png — 输入编码任务 -->

> **截图说明**：展示输入框中输入编码任务的界面。

### 步骤 4：智能体委托 Claude Code

智能体会分析任务，判断需要调用 Claude Code 来完成，然后通过 ACP 协议将任务委托出去。

<!-- 截图占位：claude-code-step4.png — 委托 Claude Code -->

> **截图说明**：展示智能体委托 Claude Code 的过程，标注任务传递的信息。

### 步骤 5：查看 Claude Code 执行过程

Claude Code 会读取项目代码、理解上下文、编写代码并进行测试。执行过程会实时回传到 EvoPanel。

<!-- 截图占位：claude-code-step5.png — 执行过程 -->

> **截图说明**：展示 Claude Code 执行编码任务的实时输出。

### 步骤 6：审查代码变更

Claude Code 完成后，智能体会将代码变更展示给你审查。你可以查看修改的文件、新增的代码和测试结果。

<!-- 截图占位：claude-code-step6.png — 审查变更 -->

> **截图说明**：展示代码变更的对比视图，标注新增/修改的内容。

### 步骤 7：确认或要求修改

如果代码符合预期，确认接受变更。如果需要调整，继续对话：

**示例提示词：**

```
请在 health 接口中增加数据库连接池的状态信息。
```

智能体会将修改意见再次委托给 Claude Code 执行。

### 步骤 8：持续迭代

重复步骤 4-7，与智能体和 Claude Code 进行多轮对话，逐步完善代码。这种"对话式开发"让你可以边想边写，无需离开对话界面。

<!-- 截图占位：claude-code-step7.png — 持续迭代 -->

> **截图说明**：展示多轮对话后代码逐步完善的整个过程。

## 小结

通过 Claude Code 集成，EvoFlow 不仅能"说"，还能"做"。智能体理解你的意图，Claude Code 执行具体编码工作，两者配合实现高效的 AI 辅助开发流程。

