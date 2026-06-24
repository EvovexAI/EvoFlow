# 配置你的第一个模型

## 你将学到什么

- 在 EvoPanel 中添加对话模型
- 配置 OpenAI 兼容服务商
- 设置主模型与 `max_tokens`

## 前置条件

- 已完成 [安装](../getting-started/installation.md)
- Gateway 已启动（模型写入 SQLite `evoflow.db`）

## 预计用时

10 分钟

## 说明

**对话模型不再写在 `config.yaml`。** 运行时只从 SQLite（`evoflow_models` 表）读取；`config.yaml` 里的 `models:` 会被忽略。

## 步骤

### 1. 打开模型设置

EvoPanel → **设置 → 模型**（或访问 Gateway `GET /api/models` 查看当前列表）。

### 2. 添加服务商与模型

按界面添加：

- **接口地址**（`base_url`，通常以 `/v1` 结尾）
- **API Key**
- **模型 ID**（须与供应商文档一致）
- **上下文长度**（`context_length`，用于压缩阈值）
- 单次输出 token 固定 **64K（65536）**，保存模型时自动写入，无需单独配置

### 3. 设置 API 密钥

可在模型行填写，或使用环境变量（部分部署会从 `$ENV` 解析）。

### 4. 设为主模型

在模型页选择 **主模型**（写入 `evoflow_app_settings.primary_model`）。

### 5. 验证

```bash
curl http://127.0.0.1:8013/api/models
```

确认列表中有你的模型且 `max_tokens` 符合预期。

## 多模型切换

在聊天会话侧栏或会话设置中选择模型；底层通过模型 `name` 解析到 SQLite 中的配置行。

## 常见问题

**回复写到一半停了、`output_tokens` 正好 8192？**  
把该模型的 **`max_tokens` 调大**（思考模式会占用输出预算）。

**旧版 `config.yaml` 里还有 models 块？**  
可删除；保留也会被启动逻辑忽略。一次性迁移可用 `sync_models_from_yaml_to_db`（见 `evoflow.persistence.bootstrap`）。

## 下一步

- [配置工具](configure-tools.md)
- [第一次对话](first-conversation.md)
