# 快捷指令使用指南
---
## 概述
所有斜杠指令在**所有渠道通用**，包括：桌面端聊天窗口、飞书、Slack、Telegram等IM渠道，直接在对话中输入即可执行，无需打开对应功能页面。

---
## 一、基础操作类
| 指令 | 别名 | 功能说明 | 使用示例 |
|------|------|----------|----------|
| `/new` | - | 新建独立会话线程，上下文和之前完全隔离 | `/new` |
| `/stop` | `/cancel` | 终止当前运行中的任务/目标任务/编排任务 | `/stop` |
| `/help` | `/h` | 查看所有可用指令说明和用法 | `/help` |

---
## 二、智能体/模式切换类
| 指令 | 别名 | 功能说明 | 使用示例 |
|------|------|----------|----------|
| `/agent [智能体名称]` | `/use` | 切换到指定的智能体 | `/agent 代码专家`<br>`/use 产品经理` |
| `/claude` | `/code` | 开启Claude Code专属模式，使用原生Claude Code能力 | `/claude` |
| `/claude [会话ID]` | `/code [会话ID]` | 续接指定ID的历史Claude Code会话 | `/claude sess_123456` |
| `/lead` | `/main` | 关闭Claude Code模式，切回EvoFlow主智能体 | `/lead`<br>`/main` |
| `/model [模型名称]` | - | 切换当前会话使用的模型 | `/model Claude 3.7 Sonnet` |

---
## 三、任务管理类
| 指令 | 别名 | 功能说明 | 使用示例 |
|------|------|----------|----------|
| `/goal [任务目标]` | `/hd`、`/hosted` | 直接创建并启动后台目标任务 | `/goal 每小时检查服务器磁盘占用，超过90%告警`<br>`/hd 每天早上9点生成昨日业务报表` |
| `/task [任务描述]` | `/tk` | 创建编排任务，智能体自动拆解成多步骤执行 | `/task 开发一个Python的TODO管理工具，支持增删改查功能` |
| `/status` | `/st` | 查看当前会话的任务状态、运行进度、目标任务列表、自动化列表 | `/status` |
| `/automation [操作]` | `/cron`、`/schedule` | 自动化操作，支持创建、查看、暂停、删除自动化 | `/automation create 每周五下午6点执行代码安全扫描`<br>`/cron list`<br>`/schedule pause task_123` |
| `/automation pause [任务ID]` | `/cron pause` | 暂停指定的自动化 | `/automation pause task_123` |
| `/automation resume [任务ID]` | `/cron resume` | 恢复指定的自动化 | `/automation resume task_123` |
| `/automation delete [任务ID]` | `/cron delete` | 删除指定的自动化 | `/automation delete task_123` |
| `/automation list` | `/cron list` | 查看所有自动化列表 | `/automation list` |
| `/automation history [任务ID]` | `/cron history` | 查看指定自动化的执行历史 | `/automation history task_123` |

---
## 四、系统查询类
| 指令 | 别名 | 功能说明 | 使用示例 |
|------|------|----------|----------|
| `/models` | `/m` | 查看所有可用模型列表 | `/models` |
| `/agents` | `/a` | 查看所有可用智能体列表 | `/agents` |
| `/memory` | `/mem` | 查看当前会话的记忆内容 | `/memory` |
| `/clear` | `/cls` | 清除当前会话的上下文记忆，保留会话ID | `/clear` |
| `/info` | - | 查看当前会话的详细信息：会话ID、使用的智能体、使用的模型、创建时间等 | `/info` |

---
## 使用注意事项
1. **不区分大小写**：指令大小写不敏感，`/CLAUDE`、`/Claude`、`/claude`效果相同
2. **参数支持空格**：指令后面的参数可以包含空格，比如`/agent 资深产品经理`可以正常识别
3. **群聊使用方式**：在飞书/Slack群聊中使用时，需要@机器人后再输入指令，例如`@EvoFlow /goal 每天9点发日报`
4. **参数可选**：部分指令的参数是可选的，如果没有带参数会提示正确的使用方法
5. **权限控制**：部分操作需要对应权限，没有权限的话会提示无法操作
6. **错误提示**：如果输入了不存在的指令或格式错误，系统会自动提示支持的指令列表和正确用法
