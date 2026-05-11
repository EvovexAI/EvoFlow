# 5 分钟快速上手

## 你将学到什么

- 配置一个模型
- 启动 EvoFlow
- 完成第一次对话

## 前置条件

已完成 [安装](installation.md)。

## 步骤

### 1. 配置模型

编辑项目根目录的 `config.yaml`，添加一个模型：

```yaml
models:
  - name: my-model
    display_name: My Model
    use: langchain_openai:ChatOpenAI
    model: gpt-4
    api_key: $OPENAI_API_KEY
```

### 2. 设置 API 密钥

编辑 `.env` 文件：

```bash
OPENAI_API_KEY=your-actual-api-key-here
```

### 3. 启动服务

```bash
make dev
```

这会启动 LangGraph Server 和 Gateway API。

### 4. 打开 EvoPanel

启动 **EvoPanel 桌面端**，它会自动连接到本地运行的 EvoFlow。

或者访问 Web 界面（如果配置了前端）。

### 5. 开始对话

在聊天界面输入第一条消息，例如：

```
你好，介绍一下你能做什么
```

Agent 会流式返回响应。

## 你完成了！

现在你已经成功运行了 EvoFlow。

## 下一步

- [完成第一个任务](first-task.md) — 让 Agent 执行一个实际任务
- [配置你的第一个模型](../tutorials/configure-models.md) — 学习更多模型配置选项
- [EvoPanel 使用指南](../guides/evopanel-guide.md) — 了解桌面端的全部功能

---

**最后验证**：2026-05-10；适用范围：默认分支。
