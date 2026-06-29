# 案例五：自动化

## 场景说明

你希望智能体在特定时间自动执行任务，比如每天早上 9 点推送技术日报、每小时检查一次系统状态、每周五发送周报等。自动化让你无需手动触发，智能体就能按计划自动工作。

## 前置准备

- 已完成 [安装](../getting-started/installation.md)
- 已配置至少一个 AI 模型
- （可选）已配置消息推送渠道（飞书、Slack、Telegram 等）

## 操作步骤

### 步骤 1：进入自动化页面

在 EvoPanel 左侧导航栏中，点击 **「自动化」** 图标，进入自动化管理页面。

<!-- 截图占位：scheduled-tasks-step1.png — 进入自动化 -->

> **截图说明**：展示左侧导航栏，标注"自动化"图标位置。

### 步骤 2：点击创建新任务

在自动化管理页面，点击 **「+ 新建任务」** 按钮。

<!-- 截图占位：scheduled-tasks-step2.png — 点击新建任务 -->

> **截图说明**：展示自动化列表页面，标注"新建任务"按钮。

### 步骤 3：填写任务名称和指令

- **任务名称**：给任务起一个易识别的名字（如"每日技术日报"）
- **执行指令**：用自然语言告诉智能体要做什么

**示例指令：**

```
请搜集今天的技术新闻，重点涵盖 AI、云计算和开源领域，
整理成一份简报，包含标题、摘要和原文链接。
```

<!-- 截图占位：scheduled-tasks-step3.png — 填写任务信息 -->

> **截图说明**：展示任务名称和执行指令输入框。

### 步骤 4：设置执行时间

你可以用以下几种方式设置执行时间：

**方式一：快捷预设**

| 预设 | 说明 |
|------|------|
| 每小时 | 每个整点执行 |
| 每天 9:00 | 每天早上 9 点执行 |
| 工作日 9:00 | 周一至周五早上 9 点执行 |
| 立即执行 | 创建后马上运行一次（测试用） |

**方式二：可视化时间选择器**

点击时钟图标，通过界面选择时间和重复周期。

**方式三：自定义 Cron 表达式**

如果你熟悉 Cron 语法，可以直接输入表达式，如 `0 9 * * 1-5`（工作日每天 9 点）。

<!-- 截图占位：scheduled-tasks-step4.png — 设置执行时间 -->

> **截图说明**：展示时间选择器界面，标注快捷预设和可视化时钟。

### 步骤 5：配置推送渠道（可选）

如果你希望任务执行结果自动发送到某个消息平台：

- 开启 **「推送」** 开关
- 选择目标渠道（飞书、Slack、Telegram、Discord）
- 填写对应的聊天 ID 或 Webhook 地址

<!-- 截图占位：scheduled-tasks-step5.png — 配置推送渠道 -->

> **截图说明**：展示推送渠道选择界面，标注已勾选的渠道。

### 步骤 6：选择线程模式

- **全新会话**：每次执行都开启新对话，不保留历史上下文
- **延续会话**：复用同一会话，智能体可以记住之前的执行结果

对于日报类任务，建议选择 **"全新会话"**。

### 步骤 7：保存并测试

点击 **「保存」**。创建完成后，你可以点击 **「立即执行」** 按钮测试任务是否正常工作。

<!-- 截图占位：scheduled-tasks-step6.png — 保存并测试 -->

> **截图说明**：展示保存后的任务详情页面，标注"立即执行"按钮。

### 步骤 8：查看执行历史

在任务详情页面，你可以查看每次执行的结果、耗时和输出内容。

<!-- 截图占位：scheduled-tasks-step7.png — 查看执行历史 -->

> **截图说明**：展示执行历史记录列表，标注每次执行的状态和结果摘要。

## 小结

自动化让你可以"设置一次，自动运行"。配合消息推送渠道，智能体可以主动向你汇报工作成果，无需你每次手动查询。

<!-- ACCEPTANCE_RECORD_BEGIN -->

# 《案例五：自动化》流式验收报告

| 元数据项 | 填写 |
|----------|------|
| **报告 ID** | `20260512-084636-case5-v1` |
| **关联案例 / 场景** | [案例五：自动化](scheduled-tasks.md) |
| **关联仓库文档** | 本页正文上方「案例」章节 |
| **执行人** | 自动化 `case_doc_acceptance_append.py` |
| **执行时间（本地）** | `2026-05-12T08:46:37.234503+00:00` |
| **代码版本** | `a877c3b3` |
| **Gateway 基址** | `http://127.0.0.1:8070` |
| **LangGraph 端口（若已知）** | 2070（由 Gateway 代理） |
| **session_key** | `agent:main:case-doc-20260512-084636` |
| **默认 assistant_id** | `lead_agent` |

---

## 1. 测试范围与通过准则

**本报告覆盖：**与本案例文档对应的流式/API 验收（共 **2** 次用户发起）。

**功能通过准则：**以本案例文档操作步骤中「可经流式接口验证」的子目标为准；无未处理 SSE error；主答复可读。

**性能与可观测性准则：**记录 `request_total_ms`、TTFT（`first_ai_visible_ms`）及侧载耗时，供与历史 JSON 对比。

---

## 2. 环境与前置条件

| 检查项 | 状态（是/否/不适用） | 说明 |
|--------|----------------------|------|
| 模型与 API Key | 是 | 以本机已配置为准 |
| 技能 / MCP / 渠道 | 未逐项核对 | 见案例前置说明 |
| 沙箱与写盘范围 | 未逐项核对 | 见网关配置 |
| 与本场景相关的配置项 | 未逐项核对 |  |

**原始机器产物：** `docs/cases/reports/raw/case-doc-5-20260512-084636.json`

---

## 3. 交互总览

| 指标 | 值 |
|------|-----|
| **用户发起流式交互总次数** | 2 |
| **涉及 thread_id 数量** | 1 |
| **是否出现 SSE error / HTTP 非 2xx** | 否 |
| **工具调用总次数（含重复 tool_call_id 刷新）** | 0 |

**thread 与时间线：**

| 序号 | thread_id | 用途说明 |
|------|-----------|----------|
| 1 | `N/A（REST）` | 见下节分轮 |

---

## 4. 分轮交互记录

### 4.1 轮次 1

#### 4.1.1 请求与用户输入

| 字段 | 内容 |
|------|------|
| **thread_id** | `N/A（REST）` |
| **本轮在用户界面的序号** | 1 / 2 |
| **activated_scenarios** | `[]` |
| **collab_phase** | `` |
| **is_plan_mode / subagent_enabled / thinking_enabled** | `False` / `False` / `False` |
| **recursion_limit** | `0` |
| **用户输入（原文，完整）** | `GET http://127.0.0.1:8070/api/automation/scheduler/status` |

#### 4.1.2 流式与模型侧时序（本轮）

| 指标 | 值（ms） | 说明 |
|------|----------|------|
| **request_total_ms** | 418.908 | 自 POST 起至流读完 |
| **first_sse_payload_ms** | None | 至首条有效 data: |
| **first_ai_visible_ms（TTFT）** | None | 至首段可见助手正文 |
| **assistant_visible_stream_ms** | None | 首末次可见正文时间差 |
| **本轮是否出现 error 事件** | 否 |  |

#### 4.1.3 工具调用明细（本轮，按发生顺序）

| — | （无） |  |  |  |  |

#### 4.1.4 模型输出（本轮）

- [x] **正文粘贴**（完整或截断说明见上）

```text
{
  "backend_env_enabled": true,
  "backend_loop_running": true,
  "automations_dir": "C:\\Users\\jingyt_ebiz\\.evoflow\\tasks\\automations",
  "automations_dir_exists": true,
  "hint": "Gateway runs ~/.evoflow/tasks/automations/*.toml on a background loop by default. EvoPanel 'start engine' only marks UI state. Set EVOFLOW_AUTOMATION_SCHEDULER=0 (or false/off) on Gateway to disable; restart after changes.",
  "last_tick": {
    "tick_iso": "2026-05-12T16:46:28",
    "slot": "2026-5-12_16_46",
    "toml_files": 3,
    "active_tasks": 3,
    "fired_task_ids": [],
    "channel_service_running": true,
    "skipped_reasons_sample": [
      "37239d57:cron_no_match_now expr='0 */6 * * *' slot=2026-5-12_16_46",
      "Automation_20260507025426_226175:cron_no_match_now expr='59 18 * * *' slot=2026-5-12_16_46",
      "Automation_20260508153305_013057:cron_no_match_now expr='0 9 * * *' slot=2026-5-12_16_46"
    ],
    "skipped_reasons_total": 3
  }
}
```

#### 4.1.5 本轮结论（非总评）

| 项 | 内容 |
|----|------|
| **对照准则条目** | 案例五：调度与任务 API 可达 |
| **子目标是否达成** | 符合 |
| **证据** | `ai_text_seen=True`；侧载种类数 `0` |

### 4.2 轮次 2

#### 4.2.1 请求与用户输入

| 字段 | 内容 |
|------|------|
| **thread_id** | `N/A（REST）` |
| **本轮在用户界面的序号** | 2 / 2 |
| **activated_scenarios** | `[]` |
| **collab_phase** | `` |
| **is_plan_mode / subagent_enabled / thinking_enabled** | `False` / `False` / `False` |
| **recursion_limit** | `0` |
| **用户输入（原文，完整）** | `GET http://127.0.0.1:8070/api/automation/tasks` |

#### 4.2.2 流式与模型侧时序（本轮）

| 指标 | 值（ms） | 说明 |
|------|----------|------|
| **request_total_ms** | 95.412 | 自 POST 起至流读完 |
| **first_sse_payload_ms** | None | 至首条有效 data: |
| **first_ai_visible_ms（TTFT）** | None | 至首段可见助手正文 |
| **assistant_visible_stream_ms** | None | 首末次可见正文时间差 |
| **本轮是否出现 error 事件** | 否 |  |

#### 4.2.3 工具调用明细（本轮，按发生顺序）

| — | （无） |  |  |  |  |

#### 4.2.4 模型输出（本轮）

- [x] **正文粘贴**（完整或截断说明见上）

```text
{
  "automations": [
    {
      "id": "37239d57",
      "name": "每日AI日报",
      "prompt": "执行每日AI日报任务，搜索并汇总最新AI前沿技术动态，要求资讯精准、排版清晰、适配手机飞书快速查阅。\n### 补充说明（新增）\n1. emoji规范：仅分类标题（对应emoji）、新闻前缀（📩）、核心亮点（★）使用，不添加多余图标，避免杂乱。\n2. 来源规范：优先标注企业/机构全称缩写（如谷歌、字节跳动可简写为谷歌、字节），无明确来源标“行业资讯”。\n3. 摘要规范：优先提炼技术突破、产品更新、核心数据，不冗余，避免与标题重复。\n## 执行步骤（简化版，最多2轮搜索）：\n### 第一步：快速获取AI新闻（单次调用）\n使用web_search，news_53ai=\"latest\"模式，query=\"AI前沿技术动态\"，获取最新AI资讯列表。\n### 第二步：内容筛选与整理\n从搜索结果中筛选最近3天内、有价值的新闻，排除重复报道和过时内容。\n### 第三步：按分类汇总输出\n将筛选后的新闻按以下分类整理（没有该分类的新闻可省略）：\n【大模型动态】📊\n【多模态AI】🎨\n【产品应用】📱\n【技术研究】🔬\n【行业动态】🏢\n### 第四步：输出格式要求（手机适配版）\n1. 纯文本，不要Markdown符号，图标用简洁emoji（仅分类标题和每条新闻前缀使用）\n2. 每条新闻独立一行，格式（丰富版）：\n📩 日期 来源：标题 - 摘要（核心亮点标★，仅标注1个最关键突破/优势）\n   示例：📩 05-07 OpenAI：GPT-5.5发布 - ★幻觉暴降52%，数学能力同步提升\n3. 日期格式：MM-DD\n4. 来源简短（如OpenAI、谷歌、字节等）\n5. 标题控制在15字以内，简洁抓重点\n6. 摘要控制在50字以内，概括核心信息，关键突破标★\n7. 分类标题用【】包裹，后缀加对应emoji（贴合分类属性）\n## 输出示例（手机版，规范排版）：\n【大模型动态】📊\n📩 05-07 OpenAI：GPT-5.5发布 - ★幻觉暴降52%，数学能力同步提升\n📩 05-06 DeepSeek：V4 Pro桌面版 - ★1.6T参数MoE架构，MIT开源\n\n【产品应用】📱\n📩 05-07 Browser Use 0.12 - ★token用量减半，四行Python可构建\n\n【技术研究】🔬\n📩 05-06 RAG vs LLM+Wiki - ★LLM+Wiki跨文档推理更具优势\n## 输出示例（手机版）：\n【大模型动态】📊\n📩 05-07 OpenAI：GPT-5.5发布 - ★幻觉暴降52%，数学能力提升，全员免费使用\n📩 05-06 DeepSeek：V4 Pro桌面版 - ★1.6T参数MoE架构，MIT开源，支持Windows直连\n\n【产品应用】📱\n📩 05-07 Browser Use 0.12 - ★弃用Playwright，token用量减半，四行Python构建浏览器Agent\n\n【技术研究】🔬\n📩 05-06 RAG vs LLM+Wiki - ★实验验证LLM+Wiki在跨文档推理、知识积累方面优势\n## 约束：\n1. 只搜索一轮（news_53ai=\"latest\"），禁止多轮泛搜\n2. 只汇报最近3天内的新鲜资讯\n3. 每个分类最多5条，精选最重要内容\n4. 必须标注具体日期\n5. 纯文本+简洁emoji输出，适配手机飞书查看，排版清晰\n6. 一行一条，简洁明了，仅分类之间空1行，新闻之间无多余空行，避免排版杂乱。\n7. 摘要50字以内，信息完整，关键亮点标★\n8. 最终回复不要说明适配手机版或者任务完成说明等非输出示例的内容",
      "schedule": "0 */6 * * *",
      "status": "active",
      "schedule_type": "recurring",
      "max_duration_minutes": 30,
      "feishu_push_enabled": true,
      "feishu_chat_id": "oc_db5b53b3d1d8ab050ad4f7b6e0fa9f75",
      "langgraph_run": true,
      "langgraph_thread_mode": "fresh",
      "langgraph_timeout_seconds": 600,
      "created_at": "2026-05-06T12:35:46.298Z"
    },
    {
      "id": "Automation_20260507025426_226175",
      "name": "Jira日志自动检查与补写",
      "prompt": "执行Jira日志自动检查与补写任务。\n\n## 前置判断：节假日/休息日检查\n获取当前日期和星期几：\n- 如果是周六、周日 → 飞书推送\"【Jira日志】今日为休息日，跳过日志检查\"，任务结束\n- 如果是法定节假日（元旦、春节、清明、劳动节、端午、中秋、国庆等）→ 飞书推送\"【Jira日志】今日为节假日，跳过日志检查\"，任务结束\n- 如果是工作日 → 继续执行\n\n## 执行步骤：\n\n### 第一步：查询历史日志\n必须真实执行查询命令：\n`​``powershell\ncd D:\\github\\EvoFlow\\skills\\custom\\jira_logger\\scripts\npython query_recent_logs.py 7\n`​``\n\n**关键要求**：必须获取实际查询结果，严禁以记忆或假设代替。\n\n### 第二步：确定检查目标日期\n- 昨天日期 = 今天日期 - 1天\n- 今天日期 = 当前日期\n\n### 第三步：检查昨天日志\n根据查询结果判断：\n\n**情况A：昨天有日志**\n1. 检查内容是否包含\"deerflaw\"、\"evoflow\"、\"DeerFlaw\"、\"EvoFlow\"、\"TraeClaw\"等个人项目关键词\n2. 如果包含个人项目 → 删除昨天所有日志，然后执行补写流程\n3. 如果不包含 → 保留，作为今天任务参考基础\n\n**情况B：昨天无日志** → 执行补写流程\n\n**昨天补写流程**：\n1. 从查询结果中找到最近有日志的日期（往前找3-7天内）\n2. 提取该日期的真实工作任务关键词\n3. **仅做日期平移**，生成昨天的4个任务（内容必须与历史日志高度一致）\n4. 创建昨天的工作日志（使用昨天的日期）\n\n### 第四步：检查今天日志\n根据查询结果判断：\n\n**情况A：今天有日志**\n1. 检查内容是否包含个人项目关键词\n2. 如果包含 → 删除今天所有日志，然后执行补写流程\n3. 如果不包含 → 飞书推送\"【Jira日志】今日日志已存在且合规，无需补写\"\n\n**情况B：今天无日志** → 执行补写流程\n\n**今天补写流程**：\n1. 基于昨天（刚确认/补写的）日志内容提取任务关键词\n2. **仅做日期平移**，生成今天的4个任务\n3. 创建今天的工作日志\n\n### 第五步：生成任务的严格规则\n基于查询结果生成任务时遵守：\n\n1. **只能从查询结果中提取已有任务**，禁止创造新工作\n2. **禁止添加历史日志中没有的内容**\n3. **禁止根据个人记忆或上下文编写**\n4. **仅做日期平移**：昨天任务→今天任务，保持描述高度一致\n5. **任务描述示例**：\n   - ✅ 正确：\"智能平台技能功能调试\"（历史日志中有）\n   - ❌ 错误：\"deerflaw框架优化\"（个人项目）\n   - ❌ 错误：\"研究新AI模型\"（历史日志中未出现）\n\n### 第六步：创建日志\n使用EnhancedSmartLogger类：\n`​``python\nimport sys\nsys.path.insert(0, r'D:\\github\\EvoFlow\\skills\\custom\\jira_logger\\scripts')\nfrom enhanced_smart_logger import EnhancedSmartLogger\n\nlogger = EnhancedSmartLogger()\n\n# 昨天任务（如需补写）\nyesterday_tasks = [\"任务1\", \"任务2\", \"任务3\", \"任务4\"]\n# 使用特定日期创建昨天日志\n\n# 今天任务\ntoday_tasks = [\"任务1\", \"任务2\", \"任务3\", \"任务4\"]\nsuccess = logger.smart_log_today_with_fallback(today_tasks=today_tasks)\n`​``\n\n### 第七步：飞书汇报\n推送结构化结果：\n\n`​``\n【Jira日志检查报告】\n检查时间：YYYY-MM-DD HH:mm\n\n历史日志概况：\n- 最近有日志日期：YYYY-MM-DD\n- 工作内容摘要：xxx\n\n昨天（YYYY-MM-DD）处理结果：\n- 状态：已存在/已补写/已修正\n- 操作：无/删除重建/新建\n\n今天（YYYY-MM-DD）处理结果：\n- 状态：已存在/已补写/已修正\n- 操作：无/删除重建/新建\n\n生成任务清单：\n1. 09:00-11:00 | 任务1\n2. 12:00-14:00 | 任务2\n3. 14:00-16:00 | 任务3\n4. 16:00-18:00 | 任务4\n`​``\n\n## 绝对禁止：\n1. 严禁以记忆代替查询\n2. 严禁出现deerflaw/evoflow/TraeClaw等个人项目\n3. 严禁创造历史日志中没有的新工作内容\n4. 必须基于查询结果生成任务\n\n## 纯文本输出，适配手机飞书查看",
      "schedule": "59 18 * * *",
      "rrule": "FREQ=DAILY;INTERVAL=1;BYHOUR=18;BYMINUTE=59",
      "status": "active",
      "schedule_type": "recurring",
      "max_duration_minutes": 30,
      "feishu_push_enabled": true,
      "feishu_chat_id": "oc_db5b53b3d1d8ab050ad4f7b6e0fa9f75",
      "langgraph_run": true,
      "memory_enabled": false,
      "created_at": "2026-05-07T10:54:26"
    },
    {
      "id": "Automation_20260508153305_013057",
      "name": "AI热点新闻",
      "prompt": "执行AI热点新闻推送任务，获取30条精选AI资讯并格式化推送。\n\n## 执行步骤：\n### 第一步：获取AI热点数据\n使用 aihot Skill，调用API：GET /api/public/items?mode=selected&take=30\n\n### 第二步：内容筛选与整理\n从返回的30条数据中筛选最有价值的头条资讯（精选5-8条），按以下分类整理：\n【大模型动态】📊\n【多模态AI】🎨\n【产品应用】📱\n【行业动态】🏢\n\n### 第三步：输出格式要求（手机适配版）\n1. **emoji规范**：仅分类标题使用emoji，新闻前缀用📩，核心亮点标★\n2. **每条新闻格式**：\n   📩 来源：标题 - ★核心亮点（1个最关键突破）\n   示例：📩 OpenAI：GPT-5.5发布 - ★幻觉暴降52%，全员免费使用\n3. **来源简短**（如OpenAI、谷歌、字节、DeepSeek等）\n4. **标题15字以内**，简洁抓重点\n5. **摘要50字以内**，关键突破标★\n6. **分类标题**用【】包裹，后缀加对应emoji\n7. **排版**：一行一条，分类之间空1行，新闻之间无多余空行\n\n## 输出示例：\n【大模型动态】📊\n📩 OpenAI：GPT-5.5发布 - ★幻觉暴降52%，数学能力提升\n📩 DeepSeek：V4 Pro桌面版 - ★1.6T参数MoE架构，MIT开源\n\n【产品应用】📱\n📩 Browser Use 0.12 - ★token用量减半，四行Python构建Agent\n\n## 约束：\n1. 精选最重要5-8条，避免信息过载，每条需要带上日期\n2. 纯文本+简洁emoji，适配手机飞书查看\n3. 一行一条，排版清晰不杂乱\n4. 仅输出整理后的资讯内容，不添加任务完成说明",
      "schedule": "0 9 * * *",
      "rrule": "FREQ=DAILY;INTERVAL=1;BYHOUR=9",
      "status": "active",
      "schedule_type": "recurring",
      "max_duration_minutes": 30,
      "feishu_push_enabled": true,
      "feishu_chat_id": "oc_db5b53b3d1d8ab050ad4f7b6e0fa9f75",
      "langgraph_run": true,
      "memory_enabled": false,
      "created_at

…（已截断，全文见同次 raw JSON）
```

#### 4.2.5 本轮结论（非总评）

| 项 | 内容 |
|----|------|
| **对照准则条目** | 案例五：调度与任务 API 可达 |
| **子目标是否达成** | 符合 |
| **证据** | `ai_text_seen=True`；侧载种类数 `0` |

---

## 5. 测试意见（文档末尾总评）

### 5.1 结论摘要

- **总体结果：**通过（REST 快照与列表可达）
- **阻塞项：**无
- **非阻塞问题：**创建/触发任务仍以 EvoPanel + TOML 为准。


### 5.2 风险与影响

无额外结论；以本案例业务风险为准。

### 5.3 后续建议

若发布前 gate：可对比 `docs/cases/reports/raw` 中历史 JSON 做基线回归。

<!-- ACCEPTANCE_RECORD_END -->
