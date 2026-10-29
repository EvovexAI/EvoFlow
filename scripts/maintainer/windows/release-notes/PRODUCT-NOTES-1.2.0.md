**EvoFlow v1.2.0 — 知识库与资产 Hub 重构 / 情感与飞书入站 / 技能原地登记 / OpenAI 网关与 MCP 工作台**

本版覆盖自 **1.1.9** 以来实际合入的用户可感知变更（41 个提交）。

### 新增

- **自托管知识库**：分块 / 格式 / 去重与同步预览，嵌入调用按用途记账并在用量页出日报明细
- **资产 Hub 分层**：明确 L0 岗位骨架 → L1 standing → L2 catalog → L3 按需正文 → L4 pending inbox 注入分层；新增 hub 标题召回；资产记忆运行台账（memory-runs）在资产中心可查
- **统一情感**：全智能体（小V + 员工）情感统一为激素轴基底，镜像到 `profile/affect.md`，资产中心新增情感页；员工可编 SOUL
- **飞书入站**：入站消息解析 / 合并 / 媒体三层管线，图片、文件、音视频统一归一处理
- **技能原地登记**：可选择含 SKILL.md 的文件夹原地登记（bound），技能留在原目录、`skill:` URI 直连；与 zip 导入并存
- **Agent 详情页**：新增 `/agents/:code` 详情页与 hero 布局（来源 / 模型 / lastRun）
- **OpenAI 兼容网关**：新增 `openai.chat` / `openai.vision` 平台动作与 `settings.invoke_model`，可在 CLI / 平台直接调用内部模型
- **媒体增强**：共享厂商 URL / 路径提取兜底，MiniMax 视频 provider 接入，平台媒体预览补全
- **Computer Use 屏边蓝光**：执行时屏边蓝光提示，改后端权威状态 + `/glow-status` 轮询
- **MCP 工作台联动**：员工会话按绑定 MCP 自动在右栏打开对应工作台（Agent 应用 / 本地兜底 URL）
- **HTML 预览**：预览面板支持 HTML 预览 / 源码切换；工具调用新增 knowledge 渲染器

### 变更

- **Plan 会话模式下线**：会话仅保留 Agent（旧 plan 数据自动回落），写方案改用 `plan` 工具
- **平台工具挂载策略**：main / 小V 默认挂载，其它员工 opt-in，避免误绑
- **产物交付引用**：统一为 Markdown 链接 / 反引号（zcode artifact_display），兼容旧 `@@path@@`
- **员工提示词**：按 `system_prompt` 组装，岗位块只留职责骨架（经验走资产 Hub）
- **展示名**：会话与列表统一优先 `agent_name`
- **小V 人设**：口头语与边界约束细化（不自称 AI、不舞台旁白、不越界生活安排）
- **界面**：UI 扩展外壳页并入全局顶栏、toast 定位统一、首页快捷面板精简、角色详情身份条紧凑

### 修复

- **渲染进程 OOM**：封顶会话 rows 与流式缓冲；dev 环境清理 React 19.2 渲染追踪
- **macOS 12 工作台空白**：修复正则 lookbehind 崩溃
- **后台任务保活**：TaskOutput 阻塞期间脉冲心跳，避免后台 bash 被误判僵尸回收
- **工作区路径自愈**：打开前探测并按文件名找回真实路径，音视频走同一流式播放链路
- **浏览器**：冷启动空白页加固，本地文件路径转 `file://` 归一化
- **bash 环境**：识别 WSL / Store stub bash 并回退
- **网关日志 500**：兼容 Title-Case 响应头
- **其它**：Minimax 视频协议对齐、MCP host plugin kernel 工具随插件启停、嵌入探测 purpose 标记、proactive 角色菜单纯色、侧栏历史筛选搜索框定位、聊天空草稿闪跳、CUA glow 窗口改自包含 HTML

### 覆盖安装即可

无数据迁移。从 **1.1.9** 覆盖安装至 **1.2.0**。