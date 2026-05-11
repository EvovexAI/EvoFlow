# 创建定时自动化任务

## 你将学到什么

- 理解自动化任务（Automation）是什么：通过 cron / rrule 规则定时触发的 Agent 任务
- 创建一个 `.toml` 格式的任务配置文件
- 编写一个完整的日报示例（含飞书推送）
- 理解任务文件中每个字段的含义
- 验证自动化任务是否正常触发

## 前置条件

- 已完成 [安装](../getting-started/installation.md)
- EvoFlow 服务正在运行
- （可选）已接入飞书渠道，可获取 `chat_id`

## 预计用时

15 分钟

## 步骤

### 1. 理解自动化任务

自动化任务（Automation）允许你定义由调度器定期执行的 Agent 任务。调度器支持两种时间规则：

| 规则类型 | 格式示例 | 说明 |
|---------|---------|------|
| **Cron** | `0 9 * * *` | 每天上午 9 点执行 |
| **RRULE** | `FREQ=DAILY;BYHOUR=9` | 每天 9 点（iCalendar 标准） |
| **单次** | `scheduled_at: "2026-05-10T09:00:00+08:00"` | 只执行一次 |

每次触发时，调度器会启动一个 Agent 会话，执行你定义的 prompt，并将结果推送给你指定的目标（如飞书群聊）。

### 2. 创建任务目录

在 `~/.evoflow/tasks/automations/` 目录下存放自动化任务配置文件。如果目录不存在，请先创建：

```bash
mkdir -p ~/.evoflow/tasks/automations/
```

### 3. 编写第一个自动化任务

创建一个文件 `~/.evoflow/tasks/automations/daily-report.toml`，写入以下内容：

```toml
# 任务名称
name = "每日项目进度日报"

# 任务描述（可选，便于在面板中识别）
description = "每天早上 9 点自动汇总昨日工作进展，并推送到飞书群组"

# Agent 提示词 - 告诉 Agent 要做什么
prompt = """
请生成一份今日的工作日报，包含以下内容：

1. 昨日完成的开发任务
2. 当前进行中的工作
3. 需要关注的问题或风险
4. 今日计划

请基于项目代码提交记录、任务管理系统的数据来生成报告。
格式要求：结构清晰，使用 Markdown，适合在飞书中阅读。
"""

# 调度规则（cron 格式）
schedule = "0 9 * * *"

# 使用的工作空间目录（可选）
workspace = "/workspace/my-project"

# 飞书推送配置
[feishu_push]
enabled = true
chat_id = "oc_xxxxxxxxxxxxxxxx"

# LangGraph 线程模式
[langgraph]
thread_mode = "isolated"
```

### 4. 字段详解

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 是 | 任务名称，用于标识和日志 |
| `description` | string | 否 | 任务的简短描述 |
| `prompt` | string | 是 | 发送给 Agent 的指令，定义要执行的任务 |
| `schedule` | string | 是 | 调度规则，支持 cron 或 rrule 格式 |
| `workspace` | string | 否 | Agent 执行时的工作目录 |
| `feishu_push.enabled` | bool | 否 | 是否启用飞书推送，默认 `false` |
| `feishu_push.chat_id` | string | 否 | 飞书群组的 `chat_id` |
| `langgraph.thread_mode` | string | 否 | 线程模式：`isolated`（每次新线程）或 `shared`（复用线程） |

#### 调度规则示例

```toml
# 每 6 小时执行一次
schedule = "0 */6 * * *"

# 工作日早上 9 点
schedule = "0 9 * * 1-5"

# RRULE 格式 - 每周一、三、五上午 10 点
schedule = "FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=10"

# RRULE 格式 - 每天下午 2 点
schedule = "FREQ=DAILY;BYHOUR=14"
```

#### 线程模式说明

- **`isolated`**：每次触发都创建新的独立会话，适合无状态的定时任务
- **`shared`**：复用同一个线程会话，适合需要保持上下文的任务

### 5. 再一个例子：每周数据巡检

```toml
name = "每周系统巡检"
description = "每周一早上检查系统日志和性能指标"

prompt = """
请执行以下巡检任务：

1. 检查最近 7 天的应用日志，找出所有 ERROR 级别日志
2. 分析 API 响应时间，标记平均响应时间 > 500ms 的接口
3. 检查磁盘使用率超过 80% 的目录
4. 生成巡检报告，列出异常项和建议操作
"""

schedule = "0 8 * * 1"
workspace = "/workspace/production"

[feishu_push]
enabled = true
chat_id = "oc_xxxxxxxxxxxxxxxx"

[langgraph]
thread_mode = "isolated"
```

### 6. 验证任务是否生效

#### 查看任务列表

重启 EvoFlow 或触发配置热加载后，调度器会自动扫描 `~/.evoflow/tasks/automations/` 目录下的 `.toml` 文件。

你可以在 EvoPanel 的 **任务管理** 页面查看已注册的自动化任务及其状态。

#### 手动触发测试

在 EvoPanel 中找到该任务，点击 **立即执行** 来手动触发一次运行，观察：

1. 任务状态变为「执行中」
2. Agent 按 prompt 执行任务
3. 执行完成后，飞书群收到推送消息（如已配置）
4. 执行记录可在历史日志中查看

#### 查看执行历史

执行历史以 JSONL 格式存储在 `~/.evoflow/automations/` 目录下，每条记录包含：

```json
{
  "run_id": "run_001",
  "status": "success",
  "trigger_type": "scheduled",
  "duration_seconds": 5.5,
  "timestamp": "2026-05-09T09:00:00+08:00"
}
```

### 7. 获取飞书 chat_id

如果需要飞书推送，你需要目标群组的 `chat_id`：

1. 打开飞书，进入目标群组
2. 群设置中可以查看群 ID（格式为 `oc_` 开头）
3. 或者通过飞书开放平台 API 获取：`GET /open-apis/im/v1/chats`

## 你完成了！

你已成功创建了一个定时自动化任务。EvoFlow 调度器会在到达设定时间时自动执行该任务，并将结果推送到飞书。

## 下一步

- [自动化任务调度详解](../guides/automation-scheduler.md) -- 深入了解调度器原理、高级配置和故障排查
- [接入飞书消息渠道](setup-im-channel.md) -- 配置飞书渠道和获取凭证
- [创建自定义 Agent](create-agent.md) -- 为自动化任务配置专用 Agent

---

**最后验证**：2026-05-10；适用范围：默认分支。
