# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

## [1.2.0] - 2026-10-29

相对 **1.1.9** 以来的增量发布：知识库与资产 Hub 分层重构、统一情感基底、飞书入站管线、技能原地登记、OpenAI 兼容网关与 MCP 工作台联动、界面与稳定性修复（前后端同一版本号）。
GitHub Release 正文见 `scripts/maintainer/windows/release-notes/PRODUCT-NOTES-1.2.0.md`；升级横幅见 `scripts/maintainer/update/latest.json`。

### Added

- **自托管知识库**：分块 / 格式 / 去重与同步预览，嵌入调用按用途记账并在用量页出日报明细
- **资产 Hub 注入分层**：明确 L0 岗位骨架 → L1 standing → L2 catalog → L3 按需正文 → L4 pending inbox；新增 hub 标题召回；资产记忆运行台账（memory-runs）在资产中心可查
- **统一情感基底**：全智能体（小V + 员工）情感统一为激素轴，镜像 `profile/affect.md`，资产中心新增情感页，员工可编 SOUL
- **飞书入站**：解析 / 合并 / 媒体三层管线，图片、文件、音视频统一归一处理
- **技能原地登记（bound）**：可选择含 SKILL.md 的文件夹原地登记，技能留原目录、`skill:` URI 直连，与 zip 导入并存
- **Agent 详情页**：新增 `/agents/:code` 路由与 hero 布局（来源 / 模型 / lastRun）
- **OpenAI 兼容网关**：新增 `openai.chat` / `openai.vision` 平台动作与 `settings.invoke_model`
- **媒体增强**：共享厂商 URL / 路径提取兜底，MiniMax 视频 provider 接入，平台媒体预览补全
- **Computer Use 屏边蓝光**：执行时屏边蓝光提示，改后端权威状态 + `/glow-status` 轮询
- **MCP 工作台联动**：员工会话按绑定 MCP 自动在右栏打开对应工作台（Agent 应用 / 本地兜底 URL）
- **HTML 预览与 knowledge 工具渲染器**：预览面板支持 HTML 预览 / 源码切换

### Changed

- **Plan 会话模式下线**：会话仅保留 Agent（旧 plan 数据自动回落），写方案改用 `plan` 工具
- **平台工具挂载策略**：main / 小V 默认挂载，其它员工 opt-in
- **产物交付引用**：统一为 Markdown 链接 / 反引号（zcode artifact_display），兼容旧 `@@path@@`
- **员工提示词**：按 `system_prompt` 组装，岗位块只留职责骨架（经验走资产 Hub）
- **展示名与小V 人设**：展示名统一 `agent_name` 优先；小V 口头语 / 边界约束细化
- **界面**：UI 扩展外壳页并入全局顶栏、toast 定位统一、首页快捷面板精简、角色详情身份条紧凑

### Fixed

- **渲染进程 OOM**：封顶会话 rows 与流式缓冲；dev 环境清理 React 19.2 渲染追踪
- **macOS 12 工作台空白**：修复正则 lookbehind 崩溃
- **后台任务保活**：TaskOutput 阻塞期间脉冲心跳，避免后台 bash 被误判僵尸回收
- **工作区路径自愈**：打开前探测并按文件名找回真实路径，音视频走同一流式播放链路
- **浏览器**：冷启动空白页加固，本地文件路径转 `file://` 归一化
- **bash 环境**：识别 WSL / Store stub bash 并回退；网关兼容 Title-Case 响应头
- **其它**：Minimax 视频协议对齐、MCP host plugin kernel 工具随插件启停、嵌入探测 purpose 标记、proactive 角色菜单纯色、侧栏历史筛选搜索框定位、聊天空草稿闪跳、CUA glow 窗口改自包含 HTML

### Notes

- 发版说明与版本线对齐 **1.2.0**（面板 + Gateway / harness 同一号）
- 建议从 **1.1.9** 覆盖安装至 **1.2.0**；无数据迁移

## [1.1.9] - 2026-10-28

相对 **1.1.8** 以来的增量发布：语音与唤醒链路（DashScope ASR/TTS、KWS 唤醒词 sidecar）、媒体生成渠道与用量记账、OpenAI 兼容网关、MCP 工具绑定重构、组织协作与任务健康度、Computer Use 屏边蓝光提示、界面统一与渲染稳定性修复（前后端同一版本号）。
GitHub Release 正文见 `scripts/maintainer/windows/release-notes/PRODUCT-NOTES-1.1.9.md`；升级横幅见 `scripts/maintainer/update/latest.json`。

### Added

- **DashScope 语音**：接入 DashScope ASR/TTS 语音会话与音色选择，媒体设置页可选音色，语音管线与媒体设置对齐
- **唤醒词 KWS**：唤醒词 KWS 原生 sidecar（sherpa-onnx）接入，配套 Tauri 命令与权限接线
- **OpenAI 兼容网关**：新增 OpenAI 兼容 chat/completions 网关与 CLI `openai` 命令，内部模型可被 OpenAI 客户端调用
- **Computer Use 屏边蓝光**：屏幕计算机使用运行时显示屏边蓝光 overlay，Tauri 窗口命令 + AGUI 事件转发
- **转交审核通知**：全局轮询转交审核，左下角芯片 / 侧栏角标 / 桌面通知，不依赖打开员工页
- **任务运行时健康度**：服务端标注 live / interrupted / idle，任务中心与详情页据此展示
- **媒体用量记账**：媒体生成接入用量账本，用量与元信息设置页展示

### Changed

- **MCP 工具绑定重构**：工具白名单按角色 mcp_servers 绑定保留，会话级工具名缓存与图重建同步 tools/all_tools；移除 MCP 系统提示词注入，MCP 工具降为普通 function 工具
- **组织与协作**：组织名册 / 协作规则拆分为独立提示块，新增雇佣通知与上游回执系统唤醒，飞书回执按角色账号路由，组织名册接入右侧栏宿主
- **UI 扩展外壳页**：导航并入全局顶栏 chrome，顶栏感应带加宽与收起防抖，样式收敛
- **界面统一**：toast 定位模型统一（center + anchor），员工雇佣 / 主动运营界面改版与主题样式统一
- **会话列表**：首屏只预拉当前目录与少量已展开组，避免抢占 app-server 管道

### Fixed

- **渲染进程 OOM**：封顶会话 rows 与流式缓冲，修复编排长跑 renderer OOM；dev 环境清理 React 19.2 渲染追踪撑爆 User Timing 缓冲
- **浏览器冷启动空白页**：浏览器引擎冷启动停在空白页时加固
- **网关日志 500**：兼容 Title-Case 响应头，避免 /runs/stream 记日志 KeyError
- **工作区历史删除**：按归一化路径匹配，同步会话缓存与本地镜像
- **自动化 /roles 性能**：列表改走 load_agent_config 免 soul 物化，cron 运行记录显示名解析统一
- **聊天空草稿闪跳**：空草稿会话加载中即居中，消除贴底转居中闪跳
- **自托管知识库**：默认关闭摘要，jobs / schema / service 与阅读页对齐

### Notes

- 发版说明与版本线对齐 **1.1.9**（面板 + Gateway / harness 同一号）
- 建议从 **1.1.8** 覆盖安装至 **1.1.9**；无数据迁移

## [1.1.8] - 2026-10-27

相对 **1.1.7** 以来的增量发布：媒体生成多模型接入、语音与唤醒链路加固、阻塞与权限审计修复、弹层动效统一（前后端同一版本号）。
GitHub Release 正文见 `scripts/maintainer/windows/release-notes/PRODUCT-NOTES-1.1.8.md`；升级横幅见 `scripts/maintainer/update/latest.json`。

### Added

- **媒体生成多模型接入**：新增即梦、万相 2.7、可灵、MiniMax 视频、OpenAI 图像等多个生成渠道，统一为 provider 工厂并可在生成面板选择；平台新增媒体预览卡片
- **系统状态面板**：设置内新增系统状态页，集中查看运行与依赖概况
- **向量模型双模式安装**：向量模型支持云端 / 本机两种安装模式，预设列表可直接点选

### Changed

- **语音与唤醒链路优化**：连续对话、唤醒与打断链路整体加固，本地识别 / 打断模型随包内置，免提体验更稳定
- **任务重试与并发加固**：任务整包重写改为乐观并发，过期提交直接拒绝，重试与自动化删除更可靠
- **弹层与切页动效统一**：模态 / 抽屉 / 菜单进出场与遮罩淡入淡出统一，路由切换消除白屏闪变，骨架屏节奏一致

### Fixed

- **聊天页整页加载失败**：去重重复的 api 引入，修复聊天页偶发整页打不开
- **任务中心点击无反应**：右栏「首页收栏」误收起执行过程，修复后点击任务中心可正常展开
- **权限越权风险**：工作流 runs 端点鉴权收紧（fail-closed），任务 ACL 与本地直连路径守卫加固
- **自动化单复活**：脚本化删除改走显式事务，避免被后续事务回滚复活
- **孤儿待办单**：建单归属只认真实执行主体，杜绝自动化每轮产生的孤儿 pending 单
- **市场目录卡顿**：目录拉取失败后负缓存 5 分钟，避免外网波动时干等超时
- **系统卡顿**：消除多处线程阻塞点，媒体 IO、调度并发与锁竞争优化，长任务可观测
- **语音模型缺失**：随包内置 pipecat 本地识别 / 打断模型，修复打包版语音异常

### Notes

- 发版说明与版本线对齐 **1.1.8**（面板 + Gateway / harness 同一号）
- 建议从 **1.1.7** 覆盖安装至 **1.1.8**；无数据迁移

## [1.1.7] - 2026-10-26

相对 **1.1.6** 以来的增量发布：小V语音助手（连续语音对话 / 免提 / 情感化自然播报）、深色模式可读性统一框架、资源中心与用量账本重构、工作流与自动化加固（前后端同一版本号）。
GitHub Release 正文见 `scripts/maintainer/windows/release-notes/PRODUCT-NOTES-1.1.7.md`；升级横幅见 `scripts/maintainer/update/latest.json`。

### Added

- **小V语音助手**：支持连续语音对话、免提全屏语音舞台、TTS 实时打断与唤醒 / 打断；语音播报更自然（带连续内在状态与情感，真实不表演），并接入实时语音识别（STT）与合成（TTS）
- **Agent 应用商店式布局**：应用页重构为商店式卡片，打开应用改为收进侧栏而非全屏
- **资源中心升级**：资源包详情与技能目录挂载；用量账本改为按消息计费并展示定价，内置浏览器与资源中心重构
- **工作流确定性模板节点**：固定模板类步骤内联渲染、不再经过 LLM，执行更稳更快
- **右侧工作区文件树**：工作区浏览接入原生文件树，可直接浏览与管理工作区文件
- **任务时序指标**：任务中心新增执行时序指标，便于排查耗时瓶颈

### Changed

- **深色模式可读性**：落地统一的主题框架（区域 × 表面分层 token），修复深色下多处文字 / 对比度不可读问题
- **工作流与聊天解耦**：工作流运行与聊天会话线程分离，避免多任务观测数据互相串线
- **语音能力统一收口**：语音相关能力统一整合到平台层，并新增员工前台语音视图
- **员工值守并入自动化**：员工值守心跳并入自动化调度，执行过程与文件树改走新版面板

### Fixed

- **工作流卡死**：blocked 步骤现视为终态，避免死步骤被反复派发、主任务永久「执行中」
- **跨 Agent 串行卡顿**：执行通道按会话线程分域，解除多 Agent 互相串行阻塞
- **观测串线**：工作流运行与聊天线程解耦，统计按运行窗口隔离，无人值守任务跳过冗余规划
- **标签页误清空**：关闭单个工作流标签不再清空整栏同类型标签
- **侧栏折叠残留**：修复侧栏内折叠后残留展开状态
- **预览频繁刷新**：稳定预览面板引用，避免侧栏预览反复重读刷新
- **文件服务取数路径**：V4 文件服务走真实网关地址，修复预览 / 下载异常
- **资产中心审计**：用量改为账本化、加写并发锁与隔离守卫，修复后台审计数据错乱
- **提示词注入对齐**：资产注入链路工具名对齐、员工画像按负责人，修复组装错位
- **权限越权**：任务 ACL 与本地直连路径守卫收紧

### Notes

- 发版说明与版本线对齐 **1.1.7**（面板 + Gateway / harness 同一号）
- 建议从 **1.1.6** 覆盖安装至 **1.1.7**；无数据迁移

## [1.1.6] - 2026-10-24

相对 **1.1.5** 以来的增量发布：任务中心节点进度右栏化 + 员工渠道扫码绑定 + 右侧预览升级 + 自动化补跑与工作流加固 + 模型失败可见化（前后端同一版本号）。
GitHub Release 正文见 `scripts/maintainer/windows/release-notes/PRODUCT-NOTES-1.1.6.md`；升级横幅见 `scripts/maintainer/update/latest.json`。

### Added

- **任务详情「任务节点」树**：点节点在本页右侧打开工作流与每节点独立进度，不再跳转会话；`task-center:{taskId}` 右栏归属隔离，任务侧栏与对话侧栏互不串台
- **员工专属机器人扫码绑定**：创建/雇佣员工、新建知识库后由助手引导对话内扫码绑定飞书/企微，扫码完成自动生效
- **右侧预览升级**：接入 ZCode PreviewPane，支持代码 / 补丁 / 图片 / 音视频 / PDF / PPT / 多文件差异；HTML 可切「渲染 / 源码」；产物自动打开
- **首页工作台「正在处理」卡片**：聚合进行中的对话、员工、自动化与工作流
- **员工上班 / 值班记录**：记录每次值班触发轨迹、会话与轮次评分，并显示执行耗时与每步产出
- **平台结果卡「查看进度」**：操作完成后一键盯执行过程
- **自动化补跑与分钟级频率**：关闭应用期间错过的计划启动后自动补齐；新增 `FREQ=MINUTELY`
- **节点进度「结案摘要」**：最终结果与逐步记录分开呈现
- **Agent / Task 工具卡「在右侧打开」**：直接查看该子任务实时输出

### Changed

- **任务详情双区布局**：改「详情 | 侧栏」对切；任务中心区分「在跑 / 已中断」
- **预览统一半宽右栏**：文件与代码预览不再弹近全屏窗口
- **会话列表**：工作区排序以服务端 `panel.ui` 为事实源（本地仅冷启动缓存）；新增拖拽换序、置顶整行拖拽 / 折叠、工作区菜单、空态「新建对话」
- **模型限流策略**：同模型最多重试 3 次，退避优先遵循服务端 `Retry-After`（上限 5 分钟），不再自动换密钥 / 切模型
- **渠道并发**：默认由 5 提升到 64
- **对话模式**：默认 Agent，「Ask」正式下线（历史 Ask 会话按 Agent 使用）
- **右侧面板控制**：统一到 `platform` 的 `ui.show/hide/update`，退役 `panel_set` / `stage_set`；进度类面板改为工作区级（可跨对话查看）
- **安装包**：支持多会话并发；升版可直接覆盖安装

### Fixed

- **飞书重连重复回复**：入站去重加持久化层（内存 TTL 120s→24h + DB 兜底）
- **员工扫码后消息仍走主智能体**：WS 按实例 `account_id` 打标，出站账号路由修复
- **历史会话卡「等待首帧」/ 大会话被截断**：V4 SSE 尾缓冲上限 512KiB→32MiB
- **发送气泡延迟 / 新会话误判工作台首页**：发送瞬间注入乐观 userInput；`preferHomeDashboard` 残留失效
- **模型失败正文消失 / 一直「生成中」**：失败走 AI 正文 + 及时结束 busy；BILLING 不重试；失败回合终态落 fail
- **打开网页 / 文件右栏无反应、话术文件链接无法关闭**：LangGraph custom 流补接 right_stage
- **Office / Excel 预览整页刷新**：避免触发 Vite 全量 reload，并跟随宿主明暗主题
- **本地访问身份被拆两份**：localhost 统一为主 WebUI 管理员并幂等合并 bootstrap 数据
- **macOS 员工页挡窗口拖动、内嵌浏览器盖侧栏 / 最大化错位**
- **自动化**：关闭期间漏跑、多进程重复触发、`schedule`/`rrule` 冲突静默、已完成节点被改回执行中 / 重复唤醒、应用进度与步骤不一致
- **执行失败只显示笼统错误码**：保留原始异常详情
- **节点进度把结案报告伪装成对话**：独立「结案摘要」；子任务转录写入不再落到 UUID 重建后的空线程

### Notes

- 发版说明与版本线对齐 **1.1.6**（面板 + Gateway / harness 同一号）
- 建议从 **1.1.5** 覆盖安装至 **1.1.6**；无数据迁移

## [1.1.5] - 2026-10-23

相对 **1.1.4** 以来的增量发布：内嵌浏览器软解耦与稳定性 + 子代理流式侧栏 + 文件审查/打开与媒体内联 + 切会话闪烁修复（前后端同一版本号）。
GitHub Release 正文见 `scripts/maintainer/windows/release-notes/PRODUCT-NOTES-1.1.5.md`；升级横幅见 `scripts/maintainer/update/latest.json`。

### Added

- **子代理流式输出侧栏**：子任务工具卡可点开右侧面板，轮询查看全量流式 transcript（执行中贴底跟读）
- **工具卡内联媒体**：图片 / 视频 / 音频产物在工具卡内直接预览（大文件走 serve-file，不塞 base64）
- **内嵌浏览器软解耦**：宿主持有浏览器窗口；右侧面板只管显示与用户操作，减少多会话抢主控冲突

### Changed

- **文件变更「审查 / 打开」**：打开可拉真实文件高亮预览；审查 diff 整行红绿底色与行内对比同源
- **Markdown / 表格渲染**：流式正文表格与样式微调，阅读更稳

### Fixed

- **切换会话先闪一屏旧样式 / 整树抖动**：V4 回落条件收紧；网关冷启动预热 hydration，首订不再双快照重挂
- **浏览器嵌入 / CDP / 桥接**：导航、视口与日志链路加固，面板与引擎协作更稳
- **技能 / 知识库注入位置**：注入内容紧跟用户消息，避免被系统段冲散
- **Node REPL / 读文件 / 看图**：插件运行与多图查看路径更可靠

### Notes

- 发版说明与版本线对齐 **1.1.5**（面板 + Gateway / harness 同一号）
- 建议从 **1.1.4** 覆盖安装至 **1.1.5**；无数据迁移

## [1.1.4] - 2026-10-22

相对 **1.1.3** 以来的增量发布：对话新流式时间线 + 授权/平台工具恢复 + 侧栏运行时长 + 小V 同款面板 + 多会话与滚动修复（前后端同一版本号）。
GitHub Release 正文见 `scripts/maintainer/windows/release-notes/PRODUCT-NOTES-1.1.4.md`；升级横幅见 `scripts/maintainer/update/latest.json`。

### Added

- **对话显示新流式时间线（默认开启）**：正文流式、工具卡排布、贴底滚动与虚拟列表走新协议投影；历史会话打开补齐轮次、工具结果与文件变更；`?chatV4=0` 可退回旧面板
- **轮尾「文件已更改」与可点 diff**：同轮写类工具汇总为变更卡；Edit/Write 展开可看补丁；点文件名打开右侧预览
- **交付物卡片**：助手用 Markdown 链接 / 路径写出的产物会出预览卡（需新一轮对话吃到更新后的提示词）
- **授权弹窗恢复**：待审批工具以底部悬浮卡呈现（批准 / 拒绝 / 全部批准），批准后结果回流
- **侧栏运行时长**：执行中右侧只显示已运行多久（如「1分05秒」），不再刷工具活动文案
- **小V 对话区并入新流式面板**：全局助手改用与主对话同款时间线；窄栏嵌入态露出左侧轮次导航条
- **主动员工 Tab 搜索**：员工页 Tab 可搜；导航条与聊天/知识库样式微调

### Changed

- **面板表格壳**：仅新面板内表格恢复 MD/CSV 复制 + 放大 + 滚轮缩放
- **显示闸门收窄**：只拦文件写类工具的重参数流；平台工具（面板配置 / 交互）参数放行
- **小V 发送 / 停止与贴底**：发送 / 停止钮原地切换、贴底由面板自管
- **模型输出上限**：面板显式上限真正生效；新建 OpenAI 兼容渠道默认 32K
- **插件 / 浏览器日志位置**：统一进 `logs/`（如 `plugin-control.log`），旧文件名启动时自动迁走
- **多会话诊断日志**：`logs/subtask-stream.trace.log` 增加隔离 / live / inject 相关行

### Fixed

- **开两个会话会卡住**：安装包 Gateway 上注入接口没正确等待，连爆错误拖垮整机
- **流式时正文不出来 / 结束后空转**：文本增量没挂上；结束后短暂空白「生成中」或忙碌卡住约十几秒
- **多会话忙碌状态乱跳**：一边还在流式，列表刷新却把忙碌清掉
- **停止亮着但齿轮不转（或审批后续流丢齿轮）**：左下角齿轮与右下角停止共用同一忙碌判定
- **授权弹窗消失 / 平台工具交互整块没了**：状态归一化；闸门收窄后恢复
- **Edit/Write 工具卡**：补齐解析后的参数对象，文件 chip 可点开右侧预览
- **上滚停住后被拽回底部**：关闭滚动端口的浏览器滚动锚定
- **知识库没向量就搜不到**：无向量时仍可按关键词搜；内置用户指南打包路径修好
- **打包后浏览器桥连错端口**：子进程与桥统一走真实 Gateway 地址

### Notes

- 发版说明与版本线对齐 **1.1.4**（面板 + Gateway / harness 同一号）
- 建议从 **1.1.3** 覆盖安装至 **1.1.4**；无数据迁移。临时退回旧对话面板：`?chatV4=0` 或 `localStorage.evoflow_chat_v4=0`

## [1.1.3] - 2026-10-21

相对 **1.1.2** 以来的增量发布：官方插件随仓库打包（空市场修复）+ 工具审批完全访问 + view_image 多图与联网搜索 + 会话标题走马灯与员工区交互 + 预设角色归并。
GitHub Release 正文见 `scripts/maintainer/windows/release-notes/PRODUCT-NOTES-1.1.3.md`；升级横幅见 `scripts/maintainer/update/latest.json`。

### Added

- **工具审批「完全访问」**：需要权限面板可一键完全访问；支持「新对话默认完全访问」勾选
- **view_image 多图**：一次传入多张本地路径 / URL；工具卡片展示更新
- **联网搜索增强**：web_search 设置门控 + 百度搜索增强；Gateway 配置热重载
- **任务 ACL / 启动加速**：agent_actor 任务权限；task startup accelerator；值班 beat / 伪工具标记前端处理
- **会话标题走马灯**：侧栏标题过长右侧渐隐 + hover 横向滚动
- **用户文档**：任务中心 / 自动化 / Agent 应用概念文与指南交叉链接

### Changed

- **官方插件随仓库打包**：提交真实 `official-plugins-bundle.tar.gz`，CI 默认解压打包；拒绝 stub 占位（此前 stub 导致安装后市场为空）
- **新建自定义智能体**：默认不挂技能白名单（与 tools 配置对齐）
- **预设角色归并**：并入 `evoflow-admin`；下线独立 `preset-role-assistant`
- **员工工作区 / 下拉**：统一 DropdownSelect + 花名册同步；员工会话筛选仅跟手动选择，不再随选中会话自动跳变

### Fixed

- **安装后插件市场为空 / 浏览器与电脑控制不可用**：发版曾打进 stub，seed 全部丢弃；本版打入真实插件并硬化 preflight / gateway-build 校验
- **工具审批**：折叠态同回合已完成工具保持可见；「新对话默认完全访问」同步当前会话并放行挂起审批；审批续流时停止按钮与设置齿轮同源（isSending）
- **知识库**：注入内容紧跟用户消息；历史行 key 去重
- **对话停止**：停止诊断日志（trigger + 落盘 + 环形缓冲）

### Notes

- 发版说明与版本线对齐 **1.1.3**
- 建议从 **1.1.2** 覆盖安装至 **1.1.3**；无数据迁移。若曾装过插件市场为空的 1.1.2，升级后重启即可重新灌入官方插件

## [1.1.2] - 2026-10-20

相对 **1.1.1** 以来的增量发布：官方插件 bundle 打包与 CI + 主动引擎与飞书通知 + 会话执行状态与忙因日志 + prompt 动态分层与 turn timing + 经验工具移除与 admin 路由整合 + lean gateway 打包硬化。
GitHub Release 正文见 `scripts/maintainer/windows/release-notes/PRODUCT-NOTES-1.1.2.md`；升级横幅见 `scripts/maintainer/update/latest.json`。

### Added

- **官方插件 bundle 打包**：macOS + Windows 双平台 bundle 打包脚本 + CI workflows；`fetch-official-plugins-bundle` 无源时生成 stub bundle（10 目录 + placeholder）使构建继续；marketplace seed 硬化 + 同步脚本 + builtin 插件注册
- **插件服务**：plugin service + builtin registration + catalog cache 细化（进程内缓存 + 并发去重 + subscribe/listener）
- **主动引擎**：proactive engine + proactive timeout + proactive feishu notify（飞书投递可交付物卡片）；`supervisor tool` + `task retry leaf` + `assets memory gate`
- **会话执行状态**：session execution state + busy reason log + context compaction + workspace info rail；`stream resume gate` 续流门控；`stage tool` 阶段工具
- **prompt 动态分层 + turn timing**：prompt dynamic layers + prompt blocks + turn timing；message row rendering 更新
- **内存与可观测**：memory live footer + session repos；`eval_metrics` 评估指标；`view image inline preview` 图片内联预览
- **其他**：code comment cards + trae tool + deliverable cards + stream perf + docs refresh；`platform_registry_doc_sync` 测试

### Changed

- **经验工具移除**：删除 `admin/experience.py` / `cli/commands/experience.py` / `tools/builtins/experience_middleware.py`（旧经验库迁移至资产中心后下线）
- **admin 路由整合**：agents / approvals / apps / automation / automation_schedule / employees / knowledge / skills / tasks / platform_* 路由与 handler 整合
- **collab/app 生成器**：app_extractor / app_generator / app_runner / app_schema 更新
- **lean gateway 打包**：`assert-lean-gateway-bundle` (sh/ps1) + `gateway-pyarmor.spec` / `gateway.spec` 打包规格硬化
- **knowledge / assets**：owned retrieve / service + craft / migrate / user_profile_dims 更新
- **中间件**：`collab_cycle_trace_middleware` / `invalid_tool_call_middleware` 更新
- **前端**：`agui-turn-reducer` 更新；新增 `evopanel/public/logo.ico`
- **文档**：`evoflow-admin-external`（README / cli-cheatsheet / http-platform / playbooks）+ `evoflow-system-verification`（SKILL / examples / scenario-full-chain）刷新

### Fixed

- **CI**：PS1 脚本中 em-dash / 箭道箭头 / 省略号等非 ASCII 字符在非 UTF-8 CI 中乱码破坏语法 → 清除非 ASCII
- **CI**：无官方插件源时 `fetch-official-plugins-bundle` 改生成 stub bundle 不再 throw

### Notes

- 发版说明与版本线对齐 **1.1.2**
- 建议从 **1.1.1** 覆盖安装至 **1.1.2**；无数据迁移

## [1.1.1] - 2026-10-18

相对 **1.1.0** 以来的增量发布：浏览器内嵌面板能力补齐 + Computer Use 显示链路打通 + 会话执行停止可靠性修复 + 插件目录与性能优化。
GitHub Release 正文见 `scripts/maintainer/windows/release-notes/PRODUCT-NOTES-1.1.1.md`；升级横幅见 `scripts/maintainer/update/latest.json`。

### Added

- **node_repl Playwright 命令面**：`__pwHandle` 翻译 Playwright Tab API（domSnapshot / click / fill / type / press / selectOption / textContent / getAttribute / isVisible / count / evaluate / waitFor* 等）为引擎命令；locator 链展开为叶子操作；role/text 定位器不支持时给出可操作错误
- **node_repl 浏览器意图检测**：`nodeReplArgsTouchBrowser` 正则识别代码中的浏览器 API（agent.browsers / tabs.new / tab.navigate 等）；纯数据处理 JS 不再自动拉起浏览器面板；漏判由后端 browser-panel-request 兜底
- **CUA display 标记 + 预览卡**：node_repl 结果尾部 `{evoflow-cua-display:...}` 标记 → `parseEvoflowCuaDisplay` 解析目标应用徽标 + 截图灯箱；`CuaToolPreview` / `CuaSummaryLeadingIcon` 组件；AG-UI `tool_cua_displays` 状态 + TOOL_CALL_RESULT.cua_display 事件；ZCode ToolCallBlocks cua / node-repl 渲染器
- **浏览器内嵌 URL 安全**：`browser-page-url.ts` 检测 chrome-error:// / chrome:// / edge:// / devtools:// / about:neterror / chromewebdata；`sanitizeBrowserPageUrl` / `isNavigableBrowserUrl` 阻止错误页写回 pageUrl 造成死循环；Rust `normalize_target_url` 拒绝内部 URL；`clamp_rect` 钳制 y ≥ 48px 不盖拖拽区
- **浏览器 tab history + 导航**：`browser-panel-store` 新增 pageTitle / canGoBack / canGoForward / TabHistory(stack+index) / favicon / displayTitle；toolbar 后退/前进/重载按钮；`browser_stream.py` 添加 reload 命令
- **浏览器 zoom**：embed zoom 预设（fit/50/67/75/100/125/150/200）持久化到 localStorage；`browserEmbedSetZoom` 客户端调用；`zoom_hotkeys_enabled(true)` 开启 Ctrl+滚轮；`ZoomFactorChanged` 事件监听推 `browser-embed-zoom` 到面板更新 toolbar
- **浏览器 embed 跨平台兼容**：`#[cfg(not(target_os = "windows"))]` 存根（embed_is_ws_child / log_region_diag / nest_embed_into_main / place_embed_client / browser_cdp_server::log_line）使 macOS/Linux CI 可编译
- **per-session 浏览器面板隔离**：`right-stage-session-memory` 跟踪 currentSessionKey + `upsertBrowserTabInSessionMemory` 按会话保存浏览器 tab；`forceHidden` 选项：后台会话导航只保证 HWND/CDP 可用不贴到当前 UI
- **zcode_port 工具移植**：background / bash_tool / glob_grep / task_notification / task_tools / notify_continuation / capability / prelude
- **background bash**：`background_bash.py` REST 接口 + `background-bash-api.ts` / `background-work-merge.ts` 前端 API + 流合并
- **image staging**：`image_staging.py` 工具截图共享暂存到 `viewed_images`；node_repl / browser 工具统一暂存
- **scrollbar reveal**：`scrollbar-reveal.ts` macOS overlay 风格滚动条显隐（鼠标靠近右缘/滚动时短暂显现）
- **ChatSummaryPanel 浮动卡**：三态（隐藏 / 气泡 / 浮动卡）+ 缩放过渡动画 + 与右栏互斥展开
- **全局插件目录**：`plugin-catalog.js` 统一 `GET /api/plugins/overview` 客户端 + 进程内缓存 + 并发去重 + subscribe/listener；对话与首页预加载
- **STOP-TRACE 取消补丁**：`langgraph_cancellation_patch.py` 修复 vendor `listen_for_cancellation` 240s 超时退出缺陷（长任务取消消息无人消费 → 协作式取消失效）；改为永久 `await queue.get()` + `[STOP-TRACE]` 全链路日志
- **bash PowerShell 路由**：检测 PowerShell cmdlet（Select-String / Get-ChildItem / ConvertFrom-Json 等）直接走 `powershell -NoProfile -NonInteractive`，不走 Git Bash（省去多秒登录 shell 启动且找不到 cmdlet）；bash 用 `--noprofile --norc -c`
- **node_repl 窗口隐藏**：`CREATE_NO_WINDOW` 隐藏 node.exe 黑窗 + preload 脚本 claim `evoflow-node-repl` 进程标题
- **CUA PNG 归一化**：`_raster_png_and_size` 将 CUA JPEG（存为 .png）转成真 PNG + 宽高元数据，修复 IHDR 读 JPEG 头得到垃圾坐标
- **统一日志重命名**：`browser-debug.log` → `插件控制日志.log`；MCP CUA / node_repl 全量 I/O 日志

### Changed

- 流式结束后自动折叠执行过程，只留最终正文
- 首页加载去掉分阶段 loadPhase 文案，保留单一横幅
- 插件市场暂隐藏尚未迁移的 MCP / Skills 独立 Tab（统一收进插件）；移除 mcpStore 预载 + tab 切换死代码
- `node_repl_tool` 将 `tool_call_id` 加到 args_schema（InjectedToolCallId）使 LangChain 自动注入；fallback 从 `runtime.tool_call_id` 取
- `runtime.py` 添加 computer-use 运行时提示（截图自动进入上下文，不要调 view_image，坐标用截图像素）
- 插件图标 `localizeGatewayIcon` 相对路径改写为 Gateway 绝对地址（桌面 WebView 页面源不是 Gateway）；`trustedImageUrl` 放行 loopback
- `place_embed_client` 统一 `HWND_TOP`（修复 park→show 落到主 WebView2 下面导致右侧空白）
- `reportEmbedSlot` 在 setBounds 失败时按 URL 重建 embed 窗口
- i18n（en-US / zh-CN）与主题样式随上述能力更新

### Fixed

- **CI**：`evopanel/vendor/**/package.json` 被根 `.gitignore` 的 `package.json` 规则排除，导致 CI 无法解析 exports 子路径 → 添加例外 `!evopanel/vendor/**/package.json`
- **api-client import**：ZCode `@/` 解析到 `src/zcode-ui`，`@/lib/api-client.js` 404 → 直接 import `../../lib/api-client.js` + re-export shim
- **知识库**：documentCount 对空 storage_dir 的 KB 改用 per-KB 库计数（修复内置知识库灰点）；parse_index 成功后回收同文档旧终态 error 任务行（修复索引状态横幅误报）
- **模型**：厂商拒绝 `thinking.type=disabled` 返回 400 时实例记忆并剥参重试一次
- **工具审批**：审批挂起时实时视图保留待授权工具（修复审批卡消失无按钮）；摘要文案「曾待授权」→「等待授权」；折叠头带最后一步 + spinner 文案事件化 + proactive 活动走 `panel:activity` 控制面广播
- **浏览器嵌入**：embed bridge coords + panel store + desktop notification；overlay + modal z-index；park→show 抬层；setBounds 失败按 URL 重建
- **CDP**：`Runtime.evaluate` 支持 `awaitPromise` 标志；`native_evaluate` 不再 dial embed debug port（每次 4s 阻塞）；`pump_both_ways` 获取 `out_tx_reader` 使 reader loop 可内联回复
- **node_repl bridge**：`newTab` 无 url 时不映射成 navigate（会报错）回退 getState；`claimTab` __tab 补 `tabId` 字段；`attachTab` 每个结果附加 primary tab（ZCode BrowsersFacade 契约）；错误回显包含 cmd JSON

### Performance

- **session list**：`refreshSessions` do-while 重跑循环改为 trailing timer 补刷；`MIN_REFRESH_INTERVAL_MS` 1500→2500；`panel:session_upserted` / session-thread-rebound / background final 走 `syncSessionRowRef` 单行同步不刷全表；`watchBackgroundBashRef` 按后台 bash 活动门控列表轮询
- **file preview**：`WorkspaceFilePreviewPanel` 连续 5 次静默拉取无变化后停轮询（~4s）；`workspaceScopeOpts` 拆为原始字段依赖避免会话轮询重渲染时反复 read-file
- **stream perf**：移除 `buildRow-diag` console.warn 诊断；`PHASE_WARN_MS` 4→30 减少误报

### Docs

- 新增 `RELEASE.md` 发版清单（VERSION 唯一源 / 三份说明 / tag / CI 自检）
- `MAINTAINERS.md` / `CONTRIBUTING.md` / `README` / `docs/` / `scripts/maintainer/` 全部交叉引用 `RELEASE.md`

### Notes

- 发版说明与版本线对齐 **1.1.1**
- 建议从 **1.1.0** 覆盖安装至 **1.1.1**；无数据迁移

## [1.1.0] - 2026-10-16

相对 **1.0.9** 以来主线真实合入（含标签后继续合并、随本包发出的修复）。
GitHub Release 正文见 `scripts/maintainer/windows/release-notes/PRODUCT-NOTES-1.1.0.md`；升级横幅见 `scripts/maintainer/update/latest.json`。

### Added

- **任务失败步骤重试**：任务列表 / 详情新增「重试失败步骤」（`POST /tasks/{id}/retry`），只补跑 `failed` 子任务；可指定子任务 ID 或重试全部失败步骤；已完成步骤不动；`tauri-api.retryTask`
- **任务操作术语**：paused「继续」→「恢复执行」；failed 拆成「重试失败步骤」与「重新执行」（整任务克隆）；详情「再跑一次」→「重新执行」
- **插件系统**：后端 plugins runtime / service / storage / manifest / zip 源；网关 `plugins` 路由；设置页插件管理；聊天侧 PluginPickerModal / PluginQuickPanel；内置 evoflow-guide / skill-kit / hello-command；`bridge_auth` 认证桥接
- **浏览器桥接与内嵌面板**：网关 `browser_bridge` / `cua_bridge`；Tauri `browser_embed` / `browser_embed_bridge` / CDP HTTP；右侧舞台 BrowserPanel；WebView2 嵌进右侧槽位并跟主窗口缩放移动；`node_repl` Playwright 命令面（domSnapshot / click / fill / type / waitFor* 等）与浏览器意图检测；CUA 结果预览卡（应用图标 + 截图灯箱）
- **MCP 服务器管理**：设置页 MCP 管理与市场同步；MCP 连接池复用与缓存
- **右侧舞台标签化**：RightStage 收成 tabs 模型（Terminal / 工作区预览 / 浏览器等），BrowserPanel 不再当整栏外壳；会话级右侧舞台记忆
- **聊天摘要浮动卡**：ChatSummaryPanel 三态（隐藏 / 气泡 / 浮动卡），与右侧舞台互斥展开
- **任务完成通知音**：后台通知可播放提示音，设置内可开关
- **流式追踪调试**：`stream_trace` / `analyze_stream_trace` 与相关文档（排障用）
- **统一日志**：浏览器 / CDP / CUA / node_repl 写入 `插件控制日志.log`；MCP CUA / node_repl 全量 I/O 日志
- **文档与许可**：Claude Code Python SDK 集成指南、zcode 许可说明、介绍页；zcode 第三方许可文件

### Changed

- 删除 `experience_tool.py`，旧经验库迁资产中心扁平 MD
- 知识库 owned 解析 / 嵌入 / pipeline / worker 增强；技能注入中间件与 loader 调整
- 流式结束后自动折叠执行过程，只留最终正文
- 首页加载去掉分阶段 loadPhase 文案，保留单一横幅
- 插件市场暂隐藏尚未迁移的 MCP / Skills 独立 Tab（统一收进插件）
- i18n（en-US / zh-CN）与主题样式随上述能力更新

### Fixed

**工具审批**

- 审批面板不再被「工作时长」折叠藏掉；授权暂停时折叠头显示「等待授权」并保持展开
- 多工具待审批时点击后立即显示「已批准 / 已拒绝」回执
- 多轮审批按 tool_call_id 精确匹配宿主，授权间隙折叠防闪烁（approval latch）
- 「始终允许本项目」追溯放行同批已登记的兄弟 pending
- 审批挂起时实时视图保留待授权工具，修复审批卡消失、无按钮
- 摘要文案「曾待授权」→「等待授权」

**聊天 / 流式**

- 折叠头带最后一步；spinner 文案事件化；proactive 活动走 `panel:activity` 控制面广播
- 流式显示行 / MessageVirtualList / 行 memo 在流式 tick 下更稳
- stream-perf 热路径去掉噪音诊断；相位告警阈值上调，减少误报

**浏览器嵌入**

- WebView2 嵌进右侧槽位；CSS 槽位按主窗口客户区缩放；槽位 vs HWND 坐标诊断
- park 后再 show 时抬到主 WebView 之上，避免右侧槽位空白
- setBounds 失败（停靠 / 崩溃）时按 URL 重建 embed 窗口，避免恢复时把页面打成 about:blank
- 嵌入覆盖层与全局弹窗 z-index，避免遮挡错乱
- macOS / Linux 编译桩补齐（跨平台 CI 可过；嵌入能力仍为 Windows WebView2）

**模型 / MCP / 插件**

- 厂商拒绝 `thinking.type=disabled` 返回 400 时实例记忆并剥参重试一次
- MCP 连接池与插件 bridge_auth 相关稳定性修复
- CI 跟踪 `evopanel/vendor/**/package.json`，避免 vendor 包 exports 在 CI 解析失败

**其它**

- 子任务产出 / outcome 判定；流式路由日志与 SSE 归一化；会话仓储与权限预设持久化
- 桌面通知与浏览器桥接坐标相关边角问题

### Notes

- 发版说明与版本线对齐 **1.1.0**
- 建议从 **1.0.9** 覆盖安装至 **1.1.0**；无数据迁移

## [1.0.9] - 2026-10-14

### Added

- **扩展注册表 API**：新增 `/api/ui-extensions/*` 网关路由，AI / 脚本可像面板一样注册 / 启停 / 卸载 UI 扩展；面板会即时重读 registry，外部写入面板立即生效
- **Tauri 端 ui_extensions 命令**：与网关对齐 registry / manifest / suite 三层读写，支持 `link`（不复制只登记路径）安装
- **`evoflow doctor` 命令**：本机环境自检，排查 SQLite 锁与 WAL 残留、Python 残留进程、技能根目录错位、`EVOFLOW_*` 环境变量、网关运行时信息
- **技能路由注册后端**：网关侧按角色挂载技能，提供可调用的 HTTP 入口
- **主窗口 Streamdown 样式接管**：流式 markdown 渲染统一走 Streamdown，文件 chip / 协议白名单 / 表格放大 / 代码块分行等交互一致
- **流式结束自动折叠执行过程**：流结束后只保留最终正文卡片，长任务不再被中间执行细节占据屏幕
- **`evoflow log files` 命令**：列出当前 profile 全部日志文件路径与会话 ID，方便取日志
- **桌面端默认优先直连 API**：与开发环境一致，启动即可用本地网关，免去网关反代握手
- **会话列表流式探针**：诊断面板里能看到每个会话的 SSE 状态 / 缓冲水位
- **流式多维性能监控（streamperf）**：默认开启，长任务可看到每 delta 各阶段耗时与全面板卡顿监测

### Changed

- 字体大小令牌体系覆盖主窗口后，1.0.9 继续把 `react-vlist-scroller`、Streamdown 接管区与右侧舞台等剩余界面纳入 `--ef-text-*`，设置中的「字体大小」滑块统一联动
- 工具调用时间线与流式正文卡片化后，正文分段、合并行齿轮、RUN_FINISHED 收尾状态等生命周期进一步收紧，长对话滚动更稳
- 桌面端与开发环境共享同一组 API 通道配置（直连模式），减少 profile 间行为漂移

### Fixed

- 修复聊天长思考出现两个思考块：连续 reasoning piece 自动合并
- 修复折叠态把待授权工具藏掉：审批面板始终可见，不再随自动折叠被吞
- 修复聊天流式尾窗 / 合并行齿轮熄灭 / 60s 自愈把 live 视图打回 DB 视图（用户看不到最新内容）的三处根因
- 修复 `RUN_FINISHED` 帧上 reducer 崩溃（`state.timeline` 不存在抛 `TypeError`），流式收尾不再闪退
- 修复聊天编辑用户消息时图片增删不同步
- 修复主窗口 markdown 把内联 hashtag / 全角括号行 / 表格行误判为标题 / URL 编码换行 / false-positive heading
- 修复流式过程卡片化后正文分段与多轮新流一闪而过的两处问题
- 修复 `platform` / `panel_set` 工具在 agent 模式下被错误移除，右侧面板平台 / 产物入口恢复
- 修复 Windows `select()` FD 耗尽（`loading_extended` 重试打爆 socket）；`loading_extended` 缺 v4 时不再卡 503
- 修复 `/runs/stream` 传输失败时的回退路径：自动改走 `/runs/wait`，流式不被截断
- 修复右侧舞台折叠时浏览器面板等 surface 未干净关闭的残留
- 修复 `react-vlist-scroller` 滚动不丝滑 + 滚动条 thumb 跳动的两处渲染抖动
- 修复 `fastdom` / `fastdom-promised` 桩与 mermaid 11.17+ 的 ESM 互操作；新增 `extend()` 让 Vite ESM 不再报 stub 缺方法
- 修复 Vite 旧 dep 缓存导致 `fastdom` 桩回归的冷启动问题（自动清理）
- 修复 `mergeSoftHistoryFetch` `curLast` 作用域回退导致的运行时 `ReferenceError`
- 修复视觉镜像 head 行去重 / 行级 `ui-display-visual.log` 流水
- 修复 `task_tool` 主动任务中把被禁的 mandatory 协作工具塞进 `disallowed_tools`
- 修复企业微信接收图文混合消息的端到端通路与回退路径未读最新 DB
- 修复模型限流等瞬时不可用标记不自动过期
- 修复 Anthropic 原生模型请求超时参数未映射；未指定 `thinking` 时未跟随模型默认
- 修复桌面端 health 探测应打网关基址而非页面 origin
- 修复工作区视图的会话列表漏掉未绑定会话
- 修复内置 lazy langgraph 请求转发时未剥离挂载前缀
- 修复主动角色未绑定飞书推送时仍被误发的目标路由错误
- 修复知识库（owned KB）重建索引期间搜索体验断流；`staged chunk` 分配串行化避免竞争
- 修复 ui_extensions 兼容 PowerShell 5.1 写出的 UTF-8 BOM 与单对象 registry 历史写法（脚本装了不显示的常见坑）

### Notes

- 发版说明与版本线对齐 **1.0.9**
- 本版主要修复 1.0.8 启动性能专项之后的 4 天窗口内累积的流式 / 渲染 / 通道 / 知识库回归，并把 ui_extensions + skills 路由注册 + doctor 自检这三块基础能力合并发布
- 升级方式：覆盖安装即可，无数据迁移

## [1.0.8] - 2026-10-04

### Added

- 内嵌浏览器面板：右侧舞台新增浏览器标签，可实时查看远程页面、切换标签/视口、执行命令（CDP 控制协议）
- 工具卡片系统 + 设计令牌：工具调用展示统一为扁平时间线，配色/间距/字号全部接入 EF 设计令牌
- UI 缩放：Ctrl + = / - / 0 缩放界面，Ctrl + 滚轮即时调整，设置面板同步开放
- 模型预设：新增 128K 输出 / 2M 输入上下文模型预设，长文本/大输入场景一键切换
- 知识库角色级自动注入：每角色可独立配置是否自动注入知识库上下文（auto 模式 + 手动开关）
- 全局助手可调大小：底部固定的小 V 面板支持拖拽改高度

### Changed

- 启动性能专项优化：CLI 冷启动移除模块级全量导入（torch / transformers 改为按需），提速约 2.7 秒；桌面端内置后端改为后台线程拉起，窗口创建不再被端口探测阻塞；移除 Google Fonts 外链（首页 + 登录页），WebView 首帧不再等待外部 DNS；构建拆出内容稳定的 vendor-react chunk，二次启动缓存命中率提升
- 字体大小：869 处硬编码字号迁入 `--ef-text-*` 令牌，设置中的「字体大小」滑块现在能联动全部界面文字
- 模型解析统一：模型选择器集中到 `evoflow.models.resolver`，员工模型优先于默认模型，会话内一键复用

### Fixed

- 修复聊天流式拼接时文本丢失与有序列表标记被截断
- 修复企业微信接收图文混合消息的端到端通路
- 修复企业微信回退路径未读最新 DB 真实状态（SSOT 修正）
- 修复模型限流等瞬时不可用标记不自动过期
- 修复 Anthropic 原生模型请求超时参数未映射
- 修复未指定 thinking 参数时未跟随模型默认（GLM-5.3 1210）
- 修复桌面端 health 探测应打网关基址而非页面 origin
- 修复工作区视图的会话列表漏掉未绑定会话
- 修复内置 lazy langgraph 请求转发时未剥离挂载前缀
- 修复企业微信接收图片+文本混合消息
- 修复聊天编辑用户消息时图片增删不同步

### Notes

- 发版说明与版本线对齐 **1.0.8**

## [1.0.7] - 2026-09-26

### Changed

- 知识库完全切换到 owned KB 单一路径：移除旧的 Obsidian vault 接入与相关 UI / skills / 文档
- 角色工具白名单现在能精确控制「任务 / 平台行政 / 侧边面板」等系统级工具，不再由 catalog 默认强制绑定（之前员工模式也会无差别挂载）

### Fixed

- 修复合并请求的工具签名消失问题：ask 模式（默认聊天）不再因为脱壳 fallback 误挂整个工具 catalog
- 修复角色白名单下 platform / panel_set 真正不可移除的旧 bug

### Removed

- 删除 `knowledge_vault_tools` 模块及对应 UI 入口（`evopanel/src/pages/knowledge-source-tabs.jsx` / `docs/user/guides/configuration/knowledge-vault.md` / `docs/user/guides/integrations/obsidian-knowledge-vault.md` 等），由 owned KB 接管

### Notes

- 发版说明与版本线对齐 **1.0.7**

## [1.0.5] - 2026-09-23

### Changed

- 知识库（owned KB）存储改造为**每个知识库独立索引**：文档/分块/嵌入/FTS/资产/wiki/KG 落在 `<kb_dir>/.evoflow/kb/index.db`，中心 `owned.sqlite` 只保留 kb 注册表、任务队列、活动日志与 Agent 记忆（新增 `kb_conn.py` / `store_paths.py`）
- 知识库 blob 解析按 `kb_id` 隔离，避免跨库路径串用
- 技能索引与加载（skills index/loader）增强

### Added

- 知识库迁移脚本 `knowledge/owned/migrate.py`（旧布局 → per-KB 布局）
- 资产经验（craft）回读能力与测试覆盖（`test_asset_craft_readback.py`）
- 平台动作 `experience.save` 字段扩展（problem/solution/outcome/steps 等）

### Notes

- 发版说明与版本线对齐 **1.0.5**

## [1.0.4] - 2026-09-22

### Added

- 消息渠道新增企业微信（WeCom）与钉钉（DingTalk）接入（Stream 模式，出站长连接，无需公网 IP）；支持企微/钉钉多机器人名册能力底座
- 渠道配置模板：`config.example.yaml` 新增 `wecom` / `dingtalk` 段
- 后端新增 `dingtalk-stream` 依赖

### Changed

- 知识库（owned KB）、内存（assets/memory）等模块重构与增强
- 面板前端（react-chat 样式、资产中心、渠道页、工作台信息轨）多轮改进

### Notes

- 发版说明与版本线对齐 **1.0.4**

## [1.0.3] - 2026-09-16

### Changed

- 工作区代码索引迁到绑定项目内的 `.evoflow/code_index/index.db`（不再写 `~/.evoflow/code_index/{hash}.db`）
- 发版说明与版本线对齐 **1.0.3**
- Windows 安装/卸载进程清理改为轻量策略：一轮 `taskkill` + ~1.5s 短等 + 写锁探测/Retry；去掉全机 `Win32_Process` 扫描与多轮最长约 15s 等待
- 员工：部门 CRUD / 负责人、一次加人、组织树；工作流与自动化指派改为选员工；智能体入口下沉到「更多」；「工作项」Tab 移到最后

### Fixed

- 索引构建完成后写入 `index_tokenizer_version`，避免搜索误触发全量重建
- 新建空白工作流后立刻打开报 `Application not found`：创建时强制写入 `owner_scope_id`，避免非管理员因未盖章归属而 404（#19）
- 桌面 `checkBackendReady` / sidecar 等待改为 `/health/ready`（core 路由已挂载），不再把 liveness 当 API 可用
- 扩展模块 `loading_extended` 503 改为可重试，避免设置等面板偶发「加载失败」
- Guardian 热重启后等到 `/health/ready` 再标记恢复
- Gateway 生命周期串行锁（ensure/stop/reload/apply_workspace 互斥），消除并发 kill/spawn 与 SQLite lock 竞态
- `backend-runtime.json` 增加 `generation` / `status` / `pid`；后台 ready 探测忽略过期 generation
- Warm latch 仅在 `/health/ready` 放行；扩展 API 调用前 soft-wait `extended_routers`
- 会话右侧调试面板：按 `thread_id` 读 observability 不再强制 `org_admin`（流式时刷 `org_admin required`）
- 设置「模型」厂商品牌图标：恢复 SVG logo（公开仓字母占位替换），深色主题下白底芯片保证可见

## [1.0.2] - 2026-09-16

### Changed

- 项目空间记忆迁到绑定仓库内的 `.evoflow/memory/` 与 `.evoflow/craft/`（不再写 `~/.evoflow/assets/workspaces/`）
- 发版说明与版本线对齐 **1.0.2**

### Fixed

- Gateway 文本响应补齐 `charset=utf-8`，减轻中文 Windows 下乱码
- 会话历史 / 首页数据与资源市场相关稳定性问题

## [1.0.1] - 2026-09-13

### Added

- 侧栏菜单与设置 Tab 悬停预热（模块 + 首屏 API），降低任务中心 / 工作流 / 智能体 / 自动化等页首次打开等待
- macOS 桌面端采用系统原生 Overlay 标题栏，并为交通灯统一让位

### Fixed

- Gateway 扩展路由未就绪时返回可重试 503，避免设置等面板出现「加载失败：Not Found」
- 设置「联网搜索」首选引擎标签换行与下拉样式不一致

### Changed

- 发版说明与版本线对齐 **1.0.1**

## [1.0.0] - 2026-09-11

### Added

- 发布 EvoFlow **1.0.0** 首个公开源码可见版本（桌面端 / 面板 / 后端统一版本）
- 原生 Agent Teams：长任务规划、拆解、执行、恢复与验收
- 对话 / Plan / Goal 主流程，以及任务中心、工作流、自动化与 IM 渠道
- 技能包与 MCP 连接器扩展能力；知识库、沙箱执行与可观测

### Changed

- 产品说明与发版文档对齐 1.0.0 公开版本线

### Removed

- 公开树移除不可再分发的第三方资产与受限技能包（详见仓库 NOTICE）

## [0.6.1] - 2026-09-09

### Fixed

- 发消息「准备中」空等：进度 HTTP inject 不再堵在 LangGraph 事件循环上
- 发消息「运行中」空等：热路径信任本地 thread，避免 ensure-thread 慢查询（0.5–数秒）
- 普通 Agent 闲聊时系统提示少做磁盘扫描，压低每轮 before_model 耗时
- 启动预热常用 lead graph，并在 MCP 清缓存后自动再预热
- 修复回复已结束后右下角仍显示「运行中」（刷新竞态）
- 流式 404 后可 force 重建 thread，避免重启丢 checkpoint 后钉死旧 thread
- 新一轮工具开始前收尾「幽灵调用中」工具，避免一直显示调用中
- 冷启动加载对话增加超时，避免 Gateway 未就绪时无限转圈

### Changed

- 会话并发与延迟观测辅助脚本/打点，便于对照 POST→claim→首字

## [0.6.0] - 2026-09-08

### Changed

- 桌面冷启动更快，减少长时间「引擎加载中」；打开后会话、对话与模型更快可用

### Fixed

- 修复打开后对话内容、模型名一直「加载中」
- 修复发消息后界面卡顿、模型迟迟不显示
- 修复升级/覆盖安装时进程残留导致安装失败等问题

## [0.5.9] - 2026-09-06

### Fixed

- 安装后聊天卡住「准备中…」：交互流以 `ui_sse` 判定 multitask=interrupt（不再误用 mirror 开关导致 enqueue HOL）
- 事件循环卡顿后回收无 `run_id` 的僵尸 SSE 槽位，并触发会话 reconcile，避免占槽永不 claim
- 知识库搜索 MCP：启动前预检 `better-sqlite3`/`sqlite-vec`，永久原生模块失败立即 fail-fast，不再反复拉起 Node 崩溃放大卡顿
- 智能体员工「上班 / 恢复」因缺失 ACL 辅助函数失败（HTTP 错误）；已补齐 `_require_role_agent`，网关错误信息也能解析 FastAPI 校验详情
- 任务中心等页面：桌面端 `gateway_proxy` 在无登录 token 时不再因 `headers: null` 报 `invalid type: null, expected a map`
- 对话结束后贴底跟随不再被 ResizeObserver / rows 抖动无限续期，避免消息区上下抢滚动
- 上滑阅读时：折叠误判回贴底收紧、用户上滑意图优先、虚拟列表手势中不改 scrollTop、跳转按钮频率加滞回，减少卡顿抖动
- 侧边「网页」面板可内嵌打开本地 `file://` / 磁盘路径 HTML（不再一直「加载中」）；系统打开也支持本地文件
- 小V 工作台轮询岗位 busy 时对 422 按空闲处理，避免控制台刷 HTTP 422
- 写入文件流式进度在模型先推 content、后推 path 时也会补发带路径的 `write_file_progress`，不再一直 `path=""`
- 替换文件（replace）流式参数同样补齐路径：根对象键提取、path 后到仍会推送进度；工具行优先用 `_writeProgress.path`
- 多次 replace 的 +/- 行数以最新进度为准（writing/done 重置），不再 Math.max 保留历史大数字
- 对话右下角工作空间上拉菜单可纵向滚动，并展示全部最近工作空间（不再截断为 8 条且无法滚动）
- 侧边网页内嵌不再弹出「若下方空白… / 在系统浏览器打开」提示条
- 聊天顶栏「扩展应用」打开已装扩展时，复用右侧浏览器内嵌面板（含服务就绪与 Bridge），不再跳转全页路由
- 聊天顶栏拆成「应用 / 扩展」两个菜单：应用在扩展左侧列出已装扩展（可滚动），扩展只保留浏览器与应用中心

## [0.5.8] - 2026-09-04

### Added

- 设置新增「资源中心」：我的 / 已装 / 市场三合一，用于盘点本机资源、管理已装资源包、从市场或本地安装
- 「我的」支持搜索、按类型筛选与勾选，右侧资源包草稿可一键导出为同构目录或 zip（含员工、工作流、技能、知识库与扩展）
- 资源市场支持导入本地文件夹 / zip 预检安装；配置 catalog URL 后可浏览并安装资源包
- 命令行支持 `evoflow org` 安装、导出与市场 catalog

### Fixed

- 资产中心员工列表与智能体员工一致，不再出现已删除岗位的残留项

- Gateway `/health/ready` 在 **core routers 注册后即就绪**；停 sidecar 时强制清端口并等待释放，避免多实例 SQLite `database is locked` 把 `create_app` 卡到数十秒。

### Changed

- 技能在资源中心清单中标注系统 / 自定义（及 SkillHub）来源

## [0.5.7] - 2026-09-02

### Added

- 聊天输入区可切换「请求批准 / 帮我批准 / 完全访问」权限档位，并同步对应 OS 沙箱策略
- 工具待批准时在消息流内联展示「需要权限」面板，支持允许一次、本会话始终允许或拒绝
- 安全中心支持 Helper 就绪时自动启用 OS 沙箱，并可设置新对话默认权限
- 首页输入区「更多」菜单：加图片、语音播报/记忆开关，以及创意快捷提示

### Fixed

- 模型页嵌在设置里时，删除确认框不再被设置弹层挡住
- 小V 协助在深色与液态玻璃下不再出现实心白底；对话气泡使用真实头像
- 小V 页面上下文更干净，减少路过路由等噪声
- 桌面端「引擎加载中」提示不再挡住标题栏拖动区

- Gateway `/health/ready` 在 **core routers 注册后即就绪**；停 sidecar 时强制清端口并等待释放，避免多实例 SQLite `database is locked` 把 `create_app` 卡到数十秒。

### Changed

- 忙碌回合中 Enter 改为排队、结束后自动发送；↑ / 空 Enter 可立即纠偏
- 开场介绍、液态玻璃与界面动效默认始终播放，不再跟随系统「减少动态效果」
- 主动员工状态简化为「工作中 / 在岗 / 已停」；关闭自动上班会真正停掉到期巡检
- 平台操作结果卡在折叠工具活动后仍留在外侧可见
- 模型配置文案明确为 OpenAI 兼容端点（与 ChatGPT Plus 无关）；侧栏折叠后汉堡按钮更易辨认

## [0.5.6] - 2026-09-01

### Added

- 对话执行步骤清单：绿勾 / 红叉状态，以及写入、新增、删除行数等文件改动摘要
- 任务中心「待办」Tab；首页待处理 KPI 跳转待办列表
- 事项快速添加与「处理结论」字段
- 平台操作结果卡：创建/更新待办、任务、员工等后在对话中直接确认并可跳转详情
- 员工「已停止自动值班」状态；学习中心「技术专栏」入口

- Gateway `/health/ready` 在 **core routers 注册后即就绪**；停 sidecar 时强制清端口并等待释放，避免多实例 SQLite `database is locked` 把 `create_app` 卡到数十秒。

### Changed

- 最新一轮对话过程聚焦：思考一行摘要、正文正常阅读、更早轮次收入「明细」；折叠与贴底滚动更稳
- 壳层工作台视觉：新建对话并入主导航；会话列表更易扫读；顶栏窗口按钮更接近系统习惯；后台暂停动画与轮询
- 默认主智能体对外统一为 EvoFlow（名称与头像）
- 任务详情状态轮询与协作执行图更及时；有汇总节点时交付物去噪
- 应用列表按最近更新排序并显示更新时间
- 「停止当前工作」会暂停自动值班；单次思考默认不再被短超时掐断
- 输入区控件收拢（语音开关进「更多」等）；上下文占用默认更简洁，细项可展开；语音播报更完整
- 工具行优先显示文件名；代码多关键词检索更贴近精确匹配

## [0.5.5] - 2026-08-29

### Added

- 安全中心「主机执行安全」：可启用 OS 沙箱，并在限制 / 工作空间 / 完全访问三档间切换
- 已发送用户消息支持编辑回溯：改写后再发，历史按预期收束
- 终端命令策略与系统级工具开关与真实审批对齐展示

- Gateway `/health/ready` 在 **core routers 注册后即就绪**；停 sidecar 时强制清端口并等待释放，避免多实例 SQLite `database is locked` 把 `create_app` 卡到数十秒。

### Changed

- 安全中心文案与布局：去掉未在主机路径生效的名单展示；命令审批与保存按钮位置更合理
- OS 沙箱开关与档位写入本地配置，重开设置仍保持
- 桌面默认走本机直连执行；会话侧栏与工具调用展示更清楚；网页搜索可在设置里单独配置

### Fixed

- 开启 OS 沙箱并保存后，再次打开安全中心仍显示未开启的问题

## [0.5.4] - 2026-08-28

### Added

- Windows 应用内一键更新（设置 → 关于 → 检查更新 / 启动横幅）
- 会议室讨论收束：结论可写入资产方案文档并在对话中打开
- 对话同轮多段回复折叠与历史分页更清晰；展示员工当前任务与待跟进
- 自动化 / 值班会话默认不出现在侧栏列表，减少打扰

- Gateway `/health/ready` 在 **core routers 注册后即就绪**；停 sidecar 时强制清端口并等待释放，避免多实例 SQLite `database is locked` 把 `create_app` 卡到数十秒。

### Changed

- 启动体验：后台服务分阶段就绪，界面可更早进入
- MCP 工具市场、绑定与提示文案更稳易懂
- 全局助手、资产中心与值班提示多处体验打磨
- 运维观测：会话消息序号与完整请求记录更可靠

## [0.5.3] - 2026-08-27

### Added

- 对话右侧信息栏新增「调试」Tab（开启运维观测后可见）：按轮次查看模型调用、系统提示词、挂载工具与完整 JSON
- 发送前可预览粘贴或选中的图片，支持缩略图核查与全屏浏览
- 委派子任务进度直接显示在消息流中，无需切换侧栏

### Fixed

- 断流或切后台时保留已收到的回复内容，避免「思考着思考着就没了」
- 内嵌网页链接优先在应用内浏览器面板打开，不再只粘贴裸 URL
- 桌面端 Gateway 稳定性增强，减少卡死与主动任务拥堵

## [0.5.2] - 2026-08-26

### Added

- 新增「资产中心」：统一查看与编辑画像、记忆、经验、反思与专长技能
- 对话结束后会自动整理偏好与可复用经验；启动时也可扫一遍待整理草稿
- 助手回复可带「引用了哪条记忆」标签，一点即可打开对应资产文件
- 资产中心新增「统计」页：看哪些记忆常用、哪些久未使用，可一键整合或全库扫描
- 界面支持液态玻璃外观；智能体也可协助调整主题与外观
- 定时任务与员工排班改用自然语言/预设选择，不必再面对复杂表达式
- 会话侧栏可集中查看平台运行与产物相关信息
- 资产中心用户说明与面板内帮助（概念 / 操作 / `#/assets` 引导）

### Fixed

- 附件在历史消息加载后也能正确显示；发送后输入区附件标签会及时清除
- 自定义壁纸下半透明界面与澄清条更协调
- Plan 页签更稳；设置里可看到 Agent Plan 联网搜索相关选项
- 会话产物优先出现在信息侧栏，减少空白面板

- Gateway `/health/ready` 在 **core routers 注册后即就绪**；停 sidecar 时强制清端口并等待释放，避免多实例 SQLite `database is locked` 把 `create_app` 卡到数十秒。

### Changed

- 长对话压缩后，助手更倾向于用资产检索补回细节，而不是只靠摘要猜

## [0.5.1] - 2026-08-22

### Added

- 优化对话内容打开速度，切换会话与回看历史更流畅
- 会话可生成分享链接，支持设置有效期
- 每轮产物可在侧栏集中浏览、打开或定位到文件夹
- 上下文占用可视化：窗口用量、系统/工具/消息占比一目了然，可手动整理上下文
- 回复进行中展示分步进度与当前状态

### Fixed

- 切换会话时减少「加载中」等待与画面跳动
- 对话界面与工具活动展示更清爽稳定

- Gateway `/health/ready` 在 **core routers 注册后即就绪**；停 sidecar 时强制清端口并等待释放，避免多实例 SQLite `database is locked` 把 `create_app` 卡到数十秒。

### Changed

- 知识库自有内容支持重新索引；智能体探索与任务执行更稳

## [0.5.0] - 2026-08-20

### Added

- 智能体可配置默认模型；新建对话跟随智能体，会话内可临时切换并恢复
- 智能体员工「执行过程」可在对话中查看实时工作轨迹
- 应用运行检查与交付物预览统一：HTML 结果可预览并一键打开所在文件夹
- 头像选择器优化；首页附件支持图片预览
- 工作区外绝对路径文件可在对话中预览

### Fixed

- 流式回复段落分隔不再被吞
- 员工列表不再闪烁；新建对话默认进入 Agent 模式
- 卡住的「运行中」会话可回收；员工任务派发更稳（忙碌排队 / 打断、完成后回写事项）
- 长对话更流畅：Markdown/Mermaid 渲染缓存，历史更早虚拟化
- 主会话减少记忆召回干扰；闲聊不再硬塞查询召回噪声
- 智能体对话聚焦当前消息，不再被值班轮次冲淡
- 管理 / 知识库 / MCP 校验与实时探索界面更稳

- Gateway `/health/ready` 在 **core routers 注册后即就绪**；停 sidecar 时强制清端口并等待释放，避免多实例 SQLite `database is locked` 把 `create_app` 卡到数十秒。

### Changed

- 主动执行与 Plan 运行时加固（循环检测、空闲巡逻收敛）

## [0.4.3] - 2026-08-14

### Added

- 统一记忆中枢：用户 / 工作区 / 智能体员工记忆分区管理，支持图谱与试召回
- 对话中可用「记住」写入统一记忆（偏好不再误写入知识库笔记）
- 工作区侧栏「项目记忆」：约定仅对本工作区生效
- 启动时种子内置用户指南到知识库；界面统一称「知识库」

### Fixed

- 中文记忆检索更稳（短词如称呼、偏好更易命中）
- 常驻记忆收紧：减少无关旧百科事实每轮塞进对话
- 闲聊短句不再硬塞归档召回噪声
- 桌面瘦包构建硬门禁，避免误打进 Chromium/torch；瘦包默认改走云端向量

- Gateway `/health/ready` 在 **core routers 注册后即就绪**；停 sidecar 时强制清端口并等待释放，避免多实例 SQLite `database is locked` 把 `create_app` 卡到数十秒。

### Changed

- 记忆图谱改为命名空间批抽，降低对话时多余模型调用

## [0.4.2] - 2026-08-13

### Added

- 模型容错中间件：自动检测模型调用失败并切换备选模型
- 小V全局调度：前台智能体可跨岗位协调资源
- Stream Mirror Lane：SSE 归一化与流式稳定性增强

### Fixed

- 停止后再发：stop sweep 不再误杀新 run；发送时清 cooldown / stop 标记
- Composer 预热收敛为 focus→ensure-thread；去掉无效的打字 prime-hydration，减少白读库

- Gateway `/health/ready` 在 **core routers 注册后即就绪**；停 sidecar 时强制清端口并等待释放，避免多实例 SQLite `database is locked` 把 `create_app` 卡到数十秒。

### Changed

- 自动化调度器与任务路由重构；可观测性与 Agent Trace 调试增强
- 自有知识库页面迁至 `/knowledge/owned`，知识库首页回到 vaults
- 公共仓同步白名单不再包含 `website/`（官网仅走 TOS 部署）

## [0.4.1] - 2026-08-10

### Added

- `platform` 行政工具各域补充「何时用 / 不用」与功能清单，catalog/help 更易选型
- 联网搜索新增博查（Bocha）渠道；`.env.example` 补充配置项
- Person Kernel 相关持久化与记忆工具（人设/代谢/关系等）

### Fixed

- Hugging Face 本地 embedding 预热：在 hub 已导入后仍强制切到镜像，避免直连 huggingface.co 超时
- 平台工具描述不清导致模型不知何时调用各行政域的问题

- Gateway `/health/ready` 在 **core routers 注册后即就绪**；停 sidecar 时强制清端口并等待释放，避免多实例 SQLite `database is locked` 把 `create_app` 卡到数十秒。

### Changed

- 小V / 超级助手路由文案：明确 items（用户备忘）、tasks（协作工单）、todo（对话清单）分工
- 智能体员工工作过程与面板展示增强

## [0.4.0] - 2026-08-08

### Added

- 新增 AI 员工圆桌聊天室：多角色围桌讨论，支持语音播报、口头发言与 @ 点名
- 会议进度汇报可带近 20 条任务记忆与数量统计，便于对齐当前工作
- 应用支持最终汇总（rollup）；面板新增主题设置
- 移动端适配：底部导航、个人页与窄屏双栏切换

### Fixed

- Windows 覆盖安装前多轮结束桌面/网关进程，并结束仍引用安装目录的进程（含知识库检索相关进程），降低文件占用导致的升级失败
- 正式包不含检索组件时，知识库「重建索引」会自动先安装检索组件；组件缺失时按钮文案同步提示
- 修复工作流侧边「做什么」输入后空白
- 修复子代理工具详情缺少会话标识、手机发图截断、底栏选模型与上拉遮挡等问题
- 文件引用改为要求绝对路径，避免相对路径解析失败

- Gateway `/health/ready` 在 **core routers 注册后即就绪**；停 sidecar 时强制清端口并等待释放，避免多实例 SQLite `database is locked` 把 `create_app` 卡到数十秒。

### Changed

- 圆桌口头发言改为短口语（约 10–30 字），听感更接近真实会议
- 智能体员工工作空间改为可选，不选即用默认
- 全局助手、使用指南与智能体员工/工作流相关入口体验增强
- 任务中心与助手侧工作同步展示改进

## [0.3.9] - 2026-08-04

### Added

- 模型供应商新增「月之暗面 Kimi」预设，可一键接入 Kimi K2.5（含图片理解）/ K2.6 / K3
- 扩展应用卡片增加运行状态指示灯（运行中 / 启动中 / 失败 / 已停用等）

### Fixed

- 修复桌面端密码框等输入框 Ctrl+V / 右键粘贴经常无效的问题（聊天主输入仍保留图片粘贴）
- 修复首次添加知识库时长时间卡在「保存中」、并可能弹出控制台窗口的问题；安装检索组件与建索引改为后台任务，页面可看进度
- 升级后内置「EvoFlow 用户指南」会随版本自动同步最新文档并后台重建索引，避免检索仍是旧内容

- Gateway `/health/ready` 在 **core routers 注册后即就绪**；停 sidecar 时强制清端口并等待释放，避免多实例 SQLite `database is locked` 把 `create_app` 卡到数十秒。

### Changed

- 知识库首次初始化进度区分「安装检索组件」与「重建索引」，文案标明安装的是检索包而非 Obsidian 应用
- 本版暂不强制激活码校验：任务中心 / 工作流 / 智能体员工可直接使用；设置与关于页隐藏授权入口
- 扩展管理页布局调整：状态灯前置、管理菜单收至底部；设置中心移除已迁移的「扩展」占位 Tab
- 智能体员工编辑「职责」区域更大，便于一次写清多条职责
- Windows 安装器进程清理改用 `nsExec + taskkill`，减少安全软件对「隐藏 PowerShell」的告警

## [0.3.8] - 2026-07-28

### Added

- 写入文件时摘要显示实时生成进度，并可打开差异弹窗边写边看正文
- 侧栏展示品牌 Logo，扩展应用支持分组折叠与统一图标

### Fixed

- 修复大内容写入时进度与差异预览只更新一次、无法持续流式显示的问题

- Gateway `/health/ready` 在 **core routers 注册后即就绪**；停 sidecar 时强制清端口并等待释放，避免多实例 SQLite `database is locked` 把 `create_app` 卡到数十秒。

### Changed

- 侧栏导航、会话列表与标题栏视觉更统一，主题与布局更易辨认

## [0.3.7] - 2026-07-26

### Added

- 小V 支持微信式「一员工一会话」：左侧联系人、右侧直接委派，并查看进行中进度与最新汇报
- 员工会话可按需打开工作轨迹；历史完成默认折叠，最新汇报按时间正序展示

### Fixed

- 修复工作轨迹打开工具详情时提示「缺少会话标识」无法加载结果
- 任务状态标签（如「已完成」）不再竖排拆字，已完成使用绿色标识更易辨认

- Gateway `/health/ready` 在 **core routers 注册后即就绪**；停 sidecar 时强制清端口并等待释放，避免多实例 SQLite `database is locked` 把 `create_app` 卡到数十秒。

### Changed

- 值班派发可续用同一轮工作轨迹，便于在原任务上继续推进

## [0.3.6] - 2026-07-24

### Added

- 智能体员工与全局助手支持扫码绑定专属飞书机器人，按岗位独立收发消息
- 新增多智能体群会议：可选择参会员工发起讨论与 @ 点名
- 交工时可指定下游处理人与阅读产物，方便跨岗接力
- Windows 安装向导支持将 evoflow CLI 加入 PATH（默认可选）

- Gateway `/health/ready` 在 **core routers 注册后即就绪**；停 sidecar 时强制清端口并等待释放，避免多实例 SQLite `database is locked` 把 `create_app` 卡到数十秒。

### Changed

- 飞书渠道页可查看各岗位绑定关系；任务详情与会话列表展示更清晰

## [0.3.5] - 2026-07-22

### Added

- 智能体员工交工时可填写「任务总结」，一句话说清做了什么、交付了什么、如何验收
- 任务中心列表与任务详情支持展示任务总结，待确认任务一目了然，无需再到对话里翻找结果

- Gateway `/health/ready` 在 **core routers 注册后即就绪**；停 sidecar 时强制清端口并等待释放，避免多实例 SQLite `database is locked` 把 `create_app` 卡到数十秒。

### Changed

- 交工提审流程更完整：提交待确认时同步留下可汇报的交付说明，方便上级快速验收

## [0.3.4] - 2026-07-12

### Added

- 新增应用工作流编排功能，支持可视化画布设计多步骤 Agent 协作流程
- 新增会话通知中心，集中展示任务状态变更与异常提醒
- 新增 Android 自动化技能，支持通过 ADB 连接设备执行操作

- Gateway `/health/ready` 在 **core routers 注册后即就绪**；停 sidecar 时强制清端口并等待释放，避免多实例 SQLite `database is locked` 把 `create_app` 卡到数十秒。

### Changed

- 对话流式输出与内容块渲染优化，多步骤任务展示更清晰
- 模型思维链（thinking）载荷处理与工具调用展示改进
- 会话预算中间件与延迟工具过滤机制增强

### Fixed

- 修复 AGUI 流式处理在部分场景下的内容丢失问题

## [0.3.3] - 2026-07-09

### Added

- 官网新增「实操教程」专栏，按学习、办公、媒体、协作等场景提供分步图文教程（首篇：配置模型与第一次对话）
- 模型配置支持可选「模型名称」，留空时界面自动使用模型 ID 展示

- Gateway `/health/ready` 在 **core routers 注册后即就绪**；停 sidecar 时强制清端口并等待释放，避免多实例 SQLite `database is locked` 把 `create_app` 卡到数十秒。

### Changed

- 官网品牌、文档与导航统一为 EvoFlow，入门与教程入口已对齐
- 对话流式输出与消息展示进一步优化，长回复阅读更顺畅
- 模型连接在多端点场景下的匹配与列表展示更稳定

### Fixed

- 修复模型配置页弹窗脚本异常导致页面无法正常使用的问题
- 修复官网教程配图、主题切换与 GitHub Star 数在部分浏览器下的显示异常

## [0.3.2] - 2026-07-08

### Added

- 思维导图新增图表视图，支持流程图、时序图、状态图、类图、ER 图等多种可视化形式
- 思维导图节点支持状态标记（进行中、已解决、已验证、已排除、已阻塞、已搁置），方便追踪排查进度
- 新增技能选择器弹窗，可在会话中快速搜索和选用技能
- 支持为不同会话绑定专属工具集，灵活控制每个会话可用的能力范围

- Gateway `/health/ready` 在 **core routers 注册后即就绪**；停 sidecar 时强制清端口并等待释放，避免多实例 SQLite `database is locked` 把 `create_app` 卡到数十秒。

### Changed

- 聊天消息流式输出与界面渲染全面优化，对话体验更流畅
- 会话模式切换与重新接入逻辑优化，减少切换时的状态丢失
- Goal 模式自动续行与提案面板交互改进

### Fixed

- 修复会话工具绑定与场景工具配置在部分场景下的异常行为
- 修复计划执行守卫在特定边界情况下的工具拦截问题

## [0.3.1] - 2026-07-06

### Added

- 飞书推送集成，支持将任务结果自动推送到飞书群聊，实现工作流闭环通知
- 火山引擎语音识别升级，支持流式实时语音转文字与一键说话（PTT）功能
- 知识库向量存储重构，支持本地 Embedding 模型（ONNX/HF）
- 定时任务管理界面优化，支持更灵活的 Cron 表达式配置

- Gateway `/health/ready` 在 **core routers 注册后即就绪**；停 sidecar 时强制清端口并等待释放，避免多实例 SQLite `database is locked` 把 `create_app` 卡到数十秒。

### Changed

- 思维导图面板切换与探索图配置优化，提升交互体验

### Fixed

- 修复 AI 流式返回内容在流结束后变空白的问题
- 优化微信自动化区域框选校准准确性
- 改进知识图谱树形视图渲染性能

## [0.3.0] - 2026-07-01

### Added

- Plan 模式新增思维导图视图，可将计划以可视化导图展示，便于理解结构与调整
- 内置视频创意团队 Agent，支持脚本、分镜与创意策划等多角色协作流程

- Gateway `/health/ready` 在 **core routers 注册后即就绪**；停 sidecar 时强制清端口并等待释放，避免多实例 SQLite `database is locked` 把 `create_app` 卡到数十秒。

### Changed

- EvoFlow 0.3.x 正式版发布，桌面端功能与体验达到对外正式发布标准

## [0.1.9] - 2026-05-18

### Added

- 数据目录统一布局（`data_layout` / `data_paths`）与可配置的数据保留策略（自动清理过期会话、追踪与聊天消息）
- EvoPanel 任务状态中文标签与任务列表/详情页状态展示优化
- 通道管理增强（飞书流式桥接、微信与多通道调度）

- Gateway `/health/ready` 在 **core routers 注册后即就绪**；停 sidecar 时强制清端口并等待释放，避免多实例 SQLite `database is locked` 把 `create_app` 卡到数十秒。

### Changed

- 聊天消息与会话持久化路径对齐新数据布局；Gateway 启动时可选运行数据保留任务
- EvoPanel 会话侧栏、运行管理与任务页样式与交互

### Fixed

- 通道相关单测与飞书/微信消息处理边界情况

## [0.1.8] - 2026-05-17

### Added

- 上下文压缩中间件与 `context_compaction_core`；预调用护栏、Provider 回退与工具超时中间件
- 场景策略摘要（`scenario_policy_excerpt`）、`send_message` / `session_search` / 代码执行 / 经验库等内置工具
- Gateway `panel_settings` 与 SQLite 工作区、聊天消息持久化；凭证池配置
- EvoPanel 面板设置、澄清预览解析、会话 transcript 持久化与 i18n 扩展

- Gateway `/health/ready` 在 **core routers 注册后即就绪**；停 sidecar 时强制清端口并等待释放，避免多实例 SQLite `database is locked` 把 `create_app` 卡到数十秒。

### Changed

- 场景激活、托管上下文压缩、LangGraph 代理与任务/工作区路由
- EvoPanel 聊天归一化、工具展示、托管 Agent 与 Tauri Gateway 命令
- 浏览器/Playwright 工具、Supervisor 监控与开发栈隔离脚本

### Fixed

- 工具错误处理、UI 消息快照与对话摘要标签相关边界行为

## [0.1.7] - 2026-05-17

### Added

- Harness SQLite 持久化层（配置、协作、任务状态、自动化等）与相关单测
- 托管上下文压缩（`hosted_context_compressor`）与 EvoPanel 上下文预算提示
- Lead Agent 提示块中英拆分（`prompt_blocks_en/zh`、`plan_prompt_blocks_en/zh`）与动态提示语言路由
- Gateway `chat_sessions`、`platform_config` 路由；运行延迟与摘要耗时追踪中间件
- Agent 追踪：调用类型筛选、模型响应视图与 SQLite 查询增强

- Gateway `/health/ready` 在 **core routers 注册后即就绪**；停 sidecar 时强制清端口并等待释放，避免多实例 SQLite `database is locked` 把 `create_app` 卡到数十秒。

### Changed

- 通道管理、托管服务、飞书自动化与 LangGraph 代理路由
- EvoPanel 聊天、托管 Agent 钩子、WebSocket 客户端与 Agent 追踪页
- 配置加载统一走 SQLite 存储；多项 harness 中间件与内置工具适配

### Fixed

- 会话标题中间件与 checkpointer 相关边界行为

## [0.1.6] - 2026-05-16

### Added

- Gateway 可观测性：SQLite 轨迹存储与查询路由；请求负载与 vendor 往返记录
- EvoPanel Agent 追踪：独立页、SQLite 视图、JSON 弹窗与格式工具脚本
- 浏览器自动化相关内置工具（CDP / Playwright 同步 actor 等）与 `process` 工具

- Gateway `/health/ready` 在 **core routers 注册后即就绪**；停 sidecar 时强制清端口并等待释放，避免多实例 SQLite `database is locked` 把 `create_app` 卡到数十秒。

### Changed

- 模型工厂与各 Provider、记忆与任务生命周期追踪、工具响应封装
- Agent trace 中间件与 Gateway 模型路由；EvoPanel 聊天与工具列表体验

## [0.1.5] - 2026-05-15

### Added

- 协作 Plan 专用提示块（`plan_prompt_blocks`）；Supervisor 编排提示（`orchestration_hints`）

- Gateway `/health/ready` 在 **core routers 注册后即就绪**；停 sidecar 时强制清端口并等待释放，避免多实例 SQLite `database is locked` 把 `create_app` 卡到数十秒。

### Changed

- 协作阶段、动态系统提示、场景运行时提示与 Plan Guard 中间件链路
- Lead Agent 提示拼装（`prompt_blocks` / `prompt`）与协作存储
- Supervisor 监控与目标工具行为

### Fixed

- 飞书通道与任务记忆（`task_memory`）相关逻辑

## [0.1.4] - 2026-05-14

### Added

- 托管 Agent 提案流程与相关网关能力；飞书侧完成流辅助
- 面试向技能包与公开预设角色助手技能示例

- Gateway `/health/ready` 在 **core routers 注册后即就绪**；停 sidecar 时强制清端口并等待释放，避免多实例 SQLite `database is locked` 把 `create_app` 卡到数十秒。

### Changed

- 通道、飞书自动化与流桥、消息总线与托管服务编排
- EvoPanel 聊天、目标面板、cron 与 WebSocket 客户端行为
- 模型工厂、内置 Agent 工具、会话标题中间件与官网文档目录

## [0.1.3] - 2026-05-13

### Fixed

- 托管相关逻辑与稳定性问题

- Gateway `/health/ready` 在 **core routers 注册后即就绪**；停 sidecar 时强制清端口并等待释放，避免多实例 SQLite `database is locked` 把 `create_app` 卡到数十秒。

### Changed

- 飞书自动化与定时任务（cron）的配置与推送体验

### Added

- 托管场景下更清晰的错误提示与重试体验

## [0.1.0] - 2026-05-11

项目初版发布。
