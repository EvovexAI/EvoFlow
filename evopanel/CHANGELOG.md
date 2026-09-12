# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

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
