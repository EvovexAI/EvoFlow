import type { LocalizedValue } from "./locales";
import type { ResumeEvoFlowLayer } from "./resume";

export const evoflowLayersByLocale: LocalizedValue<ResumeEvoFlowLayer[]> = {
  zh: [
    {
      layer: "L1 · 交付与体验层",
      subtitle: "EvoFlow 桌面端：用户在界面上能完成的对话、规划、改码、配置与查看体验。",
      modules: [
        {
          title: "聊天与会话",
          problem: "需要多会话并行、能看清 AI 边想边做，而不是只有一问一答的黑盒回复。",
          tech: "左侧会话列表：新建、切换、命名；主界面流式打字回复；展示每轮调用了哪些工具及结果摘要；可选模型与快慢模式；可发附件；AI 不清楚时会弹出澄清问题；可开关本会话是否带入长期记忆。",
          scenario: "日常问答；长对话换会话继续；需要 AI 先问清楚再动手。",
        },
        {
          title: "Plan 模式与子任务",
          problem: "复杂任务要先出方案、用户点头后再执行，并能看到做到哪一步。",
          tech: "一键进入 Plan：先看完整计划再点「开始执行」；右侧看协作阶段（规划中/待确认/执行中等）；子任务列表与进度；总控委派子 Agent 后可在侧栏或任务弹窗对照各子 Agent 流式输出；顶栏可切「规划 / 改代码 / 联网」等模式配合当前任务。",
          scenario: "大需求先对齐方案；确认后多子 Agent 并行改码/调研；执行中随时看哪条子任务、哪个子 Agent 卡在哪。",
        },
        {
          title: "工作区与文件",
          problem: "改本地项目时要选对文件夹，并知道 Agent 正在改哪些文件。",
          tech: "为会话指定本机工作目录；浏览目录树、搜索文件；Agent 写文件时右侧实时预览（类似打字机出字）；从对话里点路径直接打开；产出目录里的结果也能点开看。",
          scenario: "绑定 Monorepo 让 AI 改 bug；边生成边预览；查看 outputs 里的报告或脚本。",
        },
        {
          title: "设置与管理页",
          problem: "模型、角色、技能、渠道等常用配置要在客户端里就能改，不必找配置文件。",
          tech: "独立页面：选可用大模型；创建/编辑自定义智能体（名字、说明、可用能力）；浏览与安装技能包；查看与编辑用户记忆；管理飞书/微信等渠道开关；配置定时任务；查看工具分组；主题与面板偏好。离开聊天页后会话列表仍保留，随时点回继续。",
          scenario: "管理员配模型和 Agent；团队维护技能库；运维开 IM 机器人与巡检 cron。",
        },
        {
          title: "托管、任务与运行查看",
          problem: "长任务、夜间托管和出错时，用户需要除聊天外的查看入口。",
          tech: "聊天里收到托管方案卡片：填参数后一键后台跑；任务列表与任务详情页；子任务执行记录弹窗；运行观测页看会话耗时、工具调用次数与错误；轨迹调试页按时间线复盘一轮对话里发生了什么（适合研发排障）。",
          scenario: "确认托管方案后挂机跑；第二天看任务是否完成；查某次为什么慢或哪步工具报错。",
        },
      ],
    },
    {
      layer: "L2 · 接入与网关层",
      subtitle: "统一 API 网关、IM 多渠道、流式推送与会话绑定，把外部入口接到编排运行时。",
      modules: [
        {
          title: "统一 API 网关",
          problem: "桌面端、渠道 Bot 与第三方集成不能各自直连编排内核，需要稳定、可观测的统一入口。",
          tech: "FastAPI 网关聚合对话代理、协作/任务、智能体配置、工作区、记忆、观测等 REST；反向代理编排服务流式接口；启动时拉起渠道服务、任务事件队列与定时调度；OpenAPI 可导出对接。",
          scenario: "桌面端只连一个网关地址；企业用 HTTP API 查任务/会话；运维单点部署与鉴权。",
        },
        {
          title: "IM 多渠道接入",
          problem: "用户希望在飞书、微信、Telegram、Slack 等 IM 里直接对话，而不是只能开桌面。",
          tech: "消息总线解耦渠道与调度；各渠道适配器收消息后经统一分发器调用编排；支持快捷指令（新会话、切换主/编码模式、托管、模型列表等）；飞书等支持流式卡片更新；渠道会话与 Agent 线程持久绑定。",
          scenario: "群里 @ 机器人续问；IM 发起托管长任务；飞书侧看子任务进度流式刷新。",
        },
        {
          title: "会话与线程绑定",
          problem: "同一 IM 聊天窗口、桌面会话与协作任务必须对应同一套线程状态，避免上下文割裂。",
          tech: "渠道侧按聊天/话题映射到服务端线程 ID；绑定信息入库可恢复；桌面会话列表与渠道共用 Gateway 会话 API；工作区路径、模型与模式随会话上下文传递。",
          scenario: "IM 聊一半切到桌面接着问；多端看到同一任务进度；按群/话题隔离线程。",
        },
        {
          title: "流式输出与实时事件",
          problem: "长回答与多子任务执行需要边生成边展示，且桌面断线后应能续看。",
          tech: "网关代理编排 SSE 流并记录首字/端到端耗时；后台流式 worker 与前端连接解耦，支持刷新后从状态恢复；协作与任务变更经 SSE 按线程广播；子任务输出可桥接回 IM 渠道流式卡片。",
          scenario: "桌面聊天流式打字机；任务授权/进度桌面侧边栏实时更新；飞书卡片同步子 Agent 执行过程。",
        },
        {
          title: "后台调度与对外推送",
          problem: "定时巡检、渠道主动通知与数据清理不能占用交互式对话链路。",
          tech: "网关内嵌定时作业调度（与桌面配置同源）；任务生命周期事件异步队列；支持向飞书等主动推送卡片消息；可选数据保留策略后台执行。",
          scenario: "cron 自动跑日报；任务完成推送到群；网关重启后调度与渠道服务一并拉起。",
        },
      ],
    },
    {
      layer: "L3 · 编排运行时层",
      subtitle: "Supervisor 总控下的 Plan 协作状态机、结构化规划、人工执行闸口与 DAG 推进。",
      modules: [
        {
          title: "Plan 模式（协作状态机）",
          problem: "用户要先看清方案再动刀；聊天里口头计划无法绑定子任务 DAG，也缺执行授权闸口。",
          tech: "协作状态机驱动阶段切换；规划期与执行期工具隔离；结构化方案绑定子任务 DAG；人工授权闸口；总控按依赖分波次推进（见上方流程）。",
          scenario: "Cursor 式先规划后执行；跨天复杂任务；需人工确认再跑写盘/命令。",
        },
        {
          title: "Runtime 编排运行时",
          problem: "Plan 确认后仍需可分解、可汇合、可重试的执行引擎，不能单轮结束。",
          tech: "Supervisor start_execution；DAG depends_on 波次解锁；异步/同步汇合；共享上下文；cycle/round trace。",
          scenario: "多子任务并行/串行；局部重编排；与 Plan 模式衔接的执行面。",
        },
        {
          title: "子 Agent 委派与并行",
          problem: "复杂任务需总控同时派出多个子 Agent 分域执行，且各子 Agent 产出要能流式回传、汇合，不能挤在同一条主对话里。",
          tech: "Supervisor 总控按子任务 DAG 委派子 Agent（可并行多路）；子 Agent 独立工具面与轨迹；执行过程流式聚合供桌面/渠道对照；完成后结构化汇合进主任务上下文；支持外部编码子 Agent（如专用编码环境）与内置子 Agent 分工。",
          scenario: "一轨写业务代码、一轨补测试、一轨做调研；多源并行探索；子 Agent 失败可局部重试而不拖垮整轮。",
        },
        {
          title: "多角色",
          problem: "规划、执行、审核需不同提示词与工具集。",
          tech: "按角色配置系统提示与工具面；Supervisor 协调；外部编码角色桥接。",
          scenario: "先规划后执行；编码侧车；质检复核。",
        },
        {
          title: "托管 Agent",
          problem: "长驻任务不能依赖聊天窗一直打开。",
          tech: "Hosted 方案审阅；暂停/恢复/终止；沙箱执行；持久状态与日志；渠道远程启动。",
          scenario: "7×24 监控与批处理；人在回路前确认方案。",
        },
      ],
    },
    {
      layer: "L4 · 能力与集成层",
      subtitle: "技能包、MCP 扩展、内置能力目录、外部运行时桥接与任务场景编排，统一扩展 Harness 触达边界。",
      modules: [
        {
          title: "Skills 技能体系",
          problem: "领域 SOP 与可复用流程若只写在 Prompt 里，难以版本化、复用与按角色裁剪。",
          tech: "技能以结构化文档包存放（公共/自定义目录）；运行时按智能体白名单注入可用列表；先读技能说明再执行；支持在线创建/更新/附件脚本与参考文档；扩展配置可启停；内容校验防危险指令。",
          scenario: "运维/数据/业务 API 封装为团队技能；复杂任务成功后沉淀为技能；不同 Agent 绑定不同技能集。",
        },
        {
          title: "MCP 协议扩展",
          problem: "企业 SaaS、内部脚本与第三方服务需标准方式接入，且不能一次性把所有扩展说明塞进上下文。",
          tech: "支持多 MCP 服务（本地子进程、SSE、HTTP 远程）；OAuth 等鉴权配置；启动时缓存并注册到能力目录；与延迟按需加载配合，扩展工具按需暴露；多服务命名空间避免冲突。",
          scenario: "对接 GitHub/工单/数据库 MCP；内网 HTTP MCP；桌面侧统一 extensions 配置。",
        },
        {
          title: "内置能力目录",
          problem: "除扩展外，Harness 还需开箱可用的联网、浏览器、渠道、视觉与进程等能力，并要可治理。",
          tech: "大量内置能力分组入库（文件/编排/记忆/浏览器/消息渠道/视觉/进程等）；按模型与是否子 Agent 过滤；可选直连主机或经沙箱执行；与观测库记录每次工具调用便于审计。",
          scenario: "联网检索与网页预览；飞书/企微等消息发送；浏览器自动化；看图分析；后台命令与进程管理。",
        },
        {
          title: "外部运行时桥接",
          problem: "单一主 Agent 无法覆盖专用编码客户端、Trae 窗口或桌面托管长任务。",
          tech: "可配置外部 ACP 智能体调用；Claude Code 等编码侧车会话委派；Trae 插件运行时启停与委派；桌面托管方案卡片「填入并开始」与 Harness 状态对齐。",
          scenario: "主会话规划、子路径交给专用编码环境；Trae 窗口协作；用户确认后后台托管执行。",
        },
        {
          title: "任务场景能力集",
          problem: "规划、改代码、联网、治理、进化等任务所需能力差异大，不能始终挂载全集。",
          tech: "按任务场景激活/停用能力组并支持多场景并集；规划类场景可独占切换；与协作阶段门禁、延迟加载联动；对话中可动态切换，避免过期场景长期占用。",
          scenario: "先开规划场景再开工作区写代码；按需启用联网检索；治理/进化场景单独打开。",
        },
      ],
    },
    {
      layer: "L5 · 执行与作业层",
      subtitle: "受控工作空间、多语言代码索引与语法树检索、并行预取 IO，以及定时/无人值守作业。",
      modules: [
        {
          title: "受控工作空间",
          problem: "文件与命令若无目录边界易误伤本机或生产数据。",
          tech: "会话绑定本地/项目工作区根路径；区分用户目录、上传区与产出区；线程级沙箱目录；路径解析防逃逸；只读/沙箱策略与桌面、网关一致。",
          scenario: "按项目或租户隔离；子任务在指定目录执行；托管与自动化仅在授权范围内读写。",
        },
        {
          title: "代码索引与语法树检索",
          problem: "大仓库不能靠整树列举或全文正则摸底；需要按符号、依赖关系定点定位。",
          tech: "对工作区内 Python / JavaScript / TypeScript / Java 等构建本地索引：Tree-sitter 语法树提取类/函数/接口等符号，可选对接语言服务增强；全文检索 + 符号命中 + 文件级 import 图与类型继承关系；变更可增量重建与文件监听；检索后按目录批量预读相关文件。",
          scenario: "Monorepo 按类名/模块名定位；理清调用链与继承；改码前先搜索引再读，避免全仓库 grep。",
        },
        {
          title: "目录浏览与文本检索",
          problem: "索引未覆盖或需按字面量/日志片段查找时，仍需受控的目录与内容检索。",
          tech: "分层列举与 glob；受控路径解析；内容正则/关键字搜索作为索引的补充；结果结构化供规划与执行阶段使用。",
          scenario: "新文件尚未入索引；搜错误栈或配置关键字；小范围目录摸底。",
        },
        {
          title: "并行预取与批量 IO",
          problem: "符号检索命中多文件后，串行读取会拖慢首轮响应。",
          tech: "代码检索后按相关度并行预读一批文件并注入上下文；本地调度器可批量读/检；子任务委派可在工作区边界内并行探索；写改后可选并行静态检查摘要。",
          scenario: "一次搜索带出多文件摘要；重构前批量读配置；多目录合规抽样。",
        },
        {
          title: "定时与无人值守作业",
          problem: "巡检、日报等需与交互式聊天解耦，并按计划自动触发。",
          tech: "Gateway 侧 cron/单次调度，配置与桌面同源持久化；可走编排运行时；无人值守时跳过需人工澄清的中断；超时与渠道回执摘要；与 Plan 协作模式区分。",
          scenario: "定时巡逻与报告；夜间批处理；IM/渠道触发的自动化续跑。",
        },
      ],
    },
    {
      layer: "L6 · 记忆与知识层",
      subtitle: "对话沉淀、工具知识库、可复用经验与协作任务事实分工，避免混用或无限塞进上下文。",
      modules: [
        {
          title: "长期用户记忆",
          problem: "长期协作需记住偏好与结论，但不能把整段聊天历史塞进每轮 Prompt。",
          tech: "对话结束后异步提取（防抖合并）；结构化画像与 facts；按 Token 预算注入系统提示；可按 Agent 分槽；桌面端可查看/编辑；可选外部记忆插件同步。",
          scenario: "跨天续聊仍记得工作背景与近期关注点；会话可单独开关记忆注入。",
        },
        {
          title: "主动知识库",
          problem: "模型需主动记下可复用结论，并在后续按主题找回，而非只靠自动摘要。",
          tech: "显式写入与按主题召回；本机持久化；按会话与全局命名空间隔离；关键词匹配（无向量依赖）。",
          scenario: "项目常数、接口约定、上次排查结论由模型自行落盘并按需检索。",
        },
        {
          title: "经验库",
          problem: "复杂任务解法散落在线程里，同类问题反复从零摸索。",
          tech: "结构化情景记忆入库（标题、步骤、标签、置信度）；保存/列表/检索/更新/标记已用；复杂任务结束后 Middleware 提示是否沉淀；供开工前检索类似案例。",
          scenario: "疑难 Bug、多步流程、可复用排障套路形成团队级 episodic 资产。",
        },
        {
          title: "协作任务记忆",
          problem: "Plan / 多子任务执行时，各子 Agent 产出需汇总给主任务与侧边栏，不能丢在单次回复里。",
          tech: "子任务执行后沉淀要点与产出摘要；主任务聚合子任务记忆；经网关推送更新，与用户长期画像记忆分离。",
          scenario: "协作看板展示进度摘要；Supervisor 复盘各子任务结论；长任务跨轮续跑。",
        },
      ],
    },
    {
      layer: "L7 · 上下文与成本治理层",
      subtitle: "工具白名单与场景装配、延迟加载、工具回执分级、对话压缩与 Token 可观测，分别治理「能调什么」与「回执占多少上下文」。",
      modules: [
        {
          title: "场景装配与工具白名单",
          problem: "工具多且职责杂，需明确每一轮「能看见、能调用」的上限，避免误触写盘、编排或无关能力。",
          tech: "智能体配置可限定工具白名单；按任务场景并集挂载工具组；协作阶段（规划、待确认、执行、验收等）再收窄允许调用的工具集合；规划期与执行期能力边界分离。",
          scenario: "规划阶段不能擅自改代码或跑命令；不同角色 Agent 能力面不同；企业按租户裁剪可用工具。",
        },
        {
          title: "延迟按需加载",
          problem: "Harness 可挂载大量工具（内置、MCP、HTTP 等），但单次对话往往只需其中一小部分；若每轮把全部工具说明塞进上下文，首轮 Token 与误调风险都会很高。",
          tech: "仅常驻少量核心工具；其余进入延迟目录，提示中只保留工具名索引，并区分「已装配 / 待激活 / 延迟目录」，降低模型误判；确有需要时再加载完整说明后调用。",
          scenario: "工具目录很大时首包仍可控；本轮只做改代码就不必带上联网、治理类工具说明。",
        },
        {
          title: "工具回执分级治理",
          problem: "读文件、检索、终端等工具单次回执可达数万 Token，若原文全部进入上下文会迅速撑满窗口。",
          tech: "写入时按体量分档：小段保留原文、中段规则摘要（读码/终端输出可先做轻量裁剪）、超大结果落盘仅留引用与头尾预览；检索类大块可配专用摘要；工具调用历史分冷/热区合并远期轮次，近期保留完整链；关键类回执可配置白名单不裁剪；高频监控类重复回执可折叠只保留最新。",
          scenario: "读巨型日志或搜索结果不全量进 Prompt；长任务仍能复盘近期工具链；完整结果可在本地追溯。",
        },
        {
          title: "对话历史压缩",
          problem: "多轮人机对话本身也会占满上下文，需与工具回执治理分工而不是简单堆叠。",
          tech: "接近模型窗口阈值时，用独立压缩模型摘要折叠早期对话轮次；工具侧由回执分级与历史合并承担，避免对话与工具输出争抢同一预算。",
          scenario: "多日线程可续跑；审计侧仍保留摘要与近期交互。",
        },
        {
          title: "Token 用量可观测",
          problem: "企业落地需按会话/轮次核算消耗，不能只有黑盒账单。",
          tech: "每轮用量写入消息与会话并汇总；与白名单、延迟加载、回执分级、对话压缩组合评估，支撑控费策略与模型选型。",
          scenario: "按项目/会话查看输入与输出；对比治理策略前后效果；容量规划。",
        },
      ],
    },
    {
      layer: "L8 · 进化与治理层",
      subtitle: "智能体/技能配置治理、任务驱动进化，以及会话—模型—工具全链路运行观测与异常复盘。",
      modules: [
        {
          title: "智能体与技能治理",
          problem: "多角色、多工具组合需可配置、可审计，不能散落在 Prompt 里手工改。",
          tech: "专用治理场景下创建/更新自定义智能体；配置工具白名单与技能包；只读能力目录供装配；与场景化工具面、托管方案衔接。",
          scenario: "为运维/研发/业务各建角色 Agent；按租户裁剪可用能力；新技能版本化上线。",
        },
        {
          title: "任务驱动自我进化",
          problem: "提示词、工具组合与技能文档需随真实任务反馈持续优化，而非一次性交付。",
          tech: "进化场景引导模型在任务中改进智能体与技能（含提示词、工具分组、技能说明）；结合经验库与长期记忆沉淀可复用做法；版本化配置便于对比前后效果。",
          scenario: "内部复杂任务驱动 Harness 调优；重复性工作沉淀为技能；与模型侧能力升级协同迭代。",
        },
        {
          title: "运行观测与指标",
          problem: "黑盒对话无法回答「慢在哪、错在哪、调了哪些工具」，难做 SRE 与成本复盘。",
          tech: "观测库持久化会话、模型调用与工具调用；汇总调用次数、耗时、错误率、Token；按线程/时间窗口聚合；桌面端提供总览与排行视图。",
          scenario: "查看近期会话与活跃线程；找出高错误率或高耗时的工具；对比不同模型延迟与用量。",
        },
        {
          title: "会话链路与耗时分析",
          problem: "用户感知延迟来自网关、流式首字、模型与中间件多段叠加，需分段定位。",
          tech: "按用户轮次记录场景与可见工具面；协作周期轨迹记录阶段切换与模型响应耗时；运行耗时轨迹覆盖客户端预检、网关流式、模型前中间件等各段；支持按会话导出时间线。",
          scenario: "首字慢时区分网络、网关还是模型；Plan 协作卡在哪个阶段；长任务分段对齐瓶颈。",
        },
        {
          title: "异常分析与复盘",
          problem: "工具校验失败、场景未激活、HTTP 失败等需按类型聚合，否则只能翻原始日志。",
          tech: "工具调用记录错误类型与摘要；按线程拉取时间线（模型请求、工具 IO、轨迹事件）；支持会话级洞察报告与规则化改进建议；压缩后仍可通过历史工具轨迹检索复盘。",
          scenario: "批量排查某工具 403/参数校验问题；复盘一次失败的多 Agent 协作；给评审 Agent 提供七维观测输入。",
        },
      ],
    },
  ],
  en: [
    {
      layer: "L1 · Delivery & experience",
      subtitle: "EvoFlow desktop: what users see and can do—chat, planning, local files, settings, and run visibility.",
      modules: [
        {
          title: "Chat & sessions",
          problem: "Users need multiple chats, visible streaming replies, and insight into what the agent is doing—not a black-box answer.",
          tech: "Session list: create, switch, rename; main pane streams tokens as they arrive; each turn shows which tools ran and short results; pick model and fast/deep mode; attach files; clarification prompts when the agent needs input; toggle whether this chat uses long-term memory.",
          scenario: "Daily Q&A; resume in another session; let the agent ask before acting.",
        },
        {
          title: "Plan mode & subtasks",
          problem: "Complex work needs a visible plan, explicit user OK, then progress you can follow.",
          tech: "Enter Plan: read the full plan, then click to start execution; sidebar shows phase; subtask list and progress; when the lead delegates sub-agents, compare each sub-agent stream in the sidebar or task drawer; toolbar switches plan / code / web modes.",
          scenario: "Align on a big spec; then parallel sub-agents for code or research; see which subtask or sub-agent is stuck mid-run.",
        },
        {
          title: "Workspace & files",
          problem: "Local projects need the right folder picked and visibility into files being changed.",
          tech: "Bind a local project folder per session; browse and search the tree; live typewriter preview while the agent writes; open paths from chat; inspect files under the outputs area.",
          scenario: "Point at a monorepo for a bugfix; preview while generating; open reports or scripts in outputs.",
        },
        {
          title: "Settings & admin pages",
          problem: "Models, roles, skills, and channels should be editable in the app—not hidden in config files.",
          tech: "Pages for: model picker; create/edit custom agents (name, instructions, allowed capabilities); browse and install skill packs; view/edit user memory; enable Feishu/WeChat-style channels; schedule cron jobs; tool groups; theme and UI prefs. Session list stays in the sidebar when you leave chat.",
          scenario: "Admins configure models and agents; teams curate skills; ops enables IM bots and patrol schedules.",
        },
        {
          title: "Hosted runs, tasks & visibility",
          problem: "Long or overnight runs and failures need views beyond the chat thread.",
          tech: "Hosted proposal cards in chat: fill fields and start in the background; task list and detail pages; subtask transcript popup; run overview for latency, tool counts, and errors; trace page to replay a conversation timeline (for engineering triage).",
          scenario: "Kick off hosted work and walk away; check completion next day; find why a run was slow or which step failed.",
        },
      ],
    },
    {
      layer: "L2 · Gateway & channels",
      subtitle: "Unified API gateway, IM channels, streaming/events, and session binding into the orchestration runtime.",
      modules: [
        {
          title: "Unified API gateway",
          problem: "Desktop, channel bots, and integrations should not each talk to the orchestrator directly.",
          tech: "FastAPI gateway for chat proxy, collab/tasks, agents, workspaces, memory, observability; reverse-proxied orchestration streaming; starts channel service, task event queue, and schedulers at boot; exportable OpenAPI.",
          scenario: "Desktop client uses one gateway base URL; partners use HTTP for tasks/sessions; single deploy and auth surface.",
        },
        {
          title: "IM multi-channel access",
          problem: "Users want Feishu, WeChat, Telegram, Slack, etc.—not only the desktop app.",
          tech: "Message bus decouples adapters from dispatch; inbound routed into orchestration; shortcut commands (new thread, lead/coding mode, hosted, models); streaming card updates where supported; persistent IM-to-thread bindings.",
          scenario: "Ask the bot in a group; start hosted work from IM; stream subtask progress to Feishu cards.",
        },
        {
          title: "Session & thread binding",
          problem: "The same IM chat, desktop session, and collab task must share one thread state.",
          tech: "Channel chats/topics map to server thread IDs in SQLite bindings; desktop session APIs share the gateway; workspace, model, and mode ride session context.",
          scenario: "Continue in desktop mid-IM chat; one progress view across surfaces; isolate threads per group/topic.",
        },
        {
          title: "Streaming & live events",
          problem: "Long replies and multi-subtask runs need partial UI updates and reconnect resilience.",
          tech: "Gateway proxies orchestration SSE with first-token and end-to-end latency traces; background stream workers decoupled from the UI; collab/task SSE per thread; subtask output can bridge to IM streaming cards.",
          scenario: "Desktop token streaming; live task authorize/progress sidebar; Feishu cards mirror sub-agent runs.",
        },
        {
          title: "Background scheduling & push",
          problem: "Cron patrols, proactive channel notifications, and retention must not block chat turns.",
          tech: "Embedded automation scheduler (desktop-aligned config); async task lifecycle event queue; proactive push to Feishu and similar; optional data-retention runner.",
          scenario: "Nightly reports on a schedule; completion cards to a group; schedulers restart with the gateway.",
        },
      ],
    },
    {
      layer: "L3 · Orchestration runtime",
      subtitle: "Supervisor-led Plan collab state machine, structured planning, human exec gate, and DAG runs.",
      modules: [
        {
          title: "Plan mode (collab state machine)",
          problem: "Users need a visible plan before side effects; chat prose cannot bind a subtask DAG or gate execution.",
          tech: "Collab state machine; planning vs execution tool isolation; structured plan bound to subtask DAG; human authorize gate; orchestrator runs dependency waves (see flow above).",
          scenario: "Cursor-style plan-then-confirm; multi-day complex work; human OK before writes/shell.",
        },
        {
          title: "Runtime orchestration",
          problem: "After Plan approval, execution must decompose, merge, and retry—not one turn.",
          tech: "Supervisor start_execution; DAG depends_on waves; async/sync joins; shared context; cycle/round traces.",
          scenario: "Parallel/serial subtasks; partial re-orchestration; execution surface after Plan.",
        },
        {
          title: "Subagent delegation & parallelism",
          problem: "Complex work needs the lead to fan out multiple sub-agents in parallel, with streamed outputs merged back—not one bloated main thread.",
          tech: "Supervisor delegates sub-agents per subtask DAG (parallel lanes); isolated tool surfaces and traces; streamed aggregation for desktop/channel comparison; structured merge into the main task context; external coding sub-agents alongside built-in workers.",
          scenario: "One lane for product code, one for tests, one for research; parallel exploration; retry a failed sub-agent without restarting the whole run.",
        },
        {
          title: "Multi-role",
          problem: "Planner, executor, and reviewer need different prompts and tools.",
          tech: "Per-role prompts and tool surfaces; Supervisor coordination; external coding bridges.",
          scenario: "Plan-then-execute; coding sidecar; reviewer pass.",
        },
        {
          title: "Hosted agents",
          problem: "Background work cannot require an always-open chat window.",
          tech: "Hosted proposals; pause/resume/terminate; sandbox; durable logs; remote channel start.",
          scenario: "24/7 monitoring and batches; human reviews plan first.",
        },
      ],
    },
    {
      layer: "L4 · Capabilities & integration",
      subtitle: "Skill packs, MCP extensions, built-in catalogs, external runtime bridges, and task-scenario orchestration.",
      modules: [
        {
          title: "Skills system",
          problem: "Domain SOPs and reusable procedures should not live only in one-off prompts.",
          tech: "Structured skill packs (public/custom trees); per-agent allowlists injected at runtime; read-the-skill-then-act; online create/update with references/scripts; extension toggles; content validation against unsafe patterns.",
          scenario: "Team SOPs for ops/data/APIs; save successful workflows as skills; different agents bind different skill sets.",
        },
        {
          title: "MCP extensions",
          problem: "Enterprise SaaS, scripts, and third-party services need a standard plug-in path without bloating every prompt.",
          tech: "Multi-server MCP (stdio, SSE, HTTP remote); OAuth and headers; startup cache registered in the tool catalog; pairs with deferred on-demand loading; server-prefixed namespaces avoid collisions.",
          scenario: "GitHub/ticketing/DB MCP servers; intranet HTTP MCP; desktop-side extensions config.",
        },
        {
          title: "Built-in capability catalog",
          problem: "Beyond extensions, harnesses need web, browser, channels, vision, and process tools out of the box—governed and auditable.",
          tech: "Large grouped built-in catalog synced to DB; filtered by model and sub-agent mode; host-direct or sandbox execution; observability records each invocation.",
          scenario: "Web search and page preview; IM channel messaging; browser automation; image analysis; background commands and processes.",
        },
        {
          title: "External runtime bridges",
          problem: "A single lead agent cannot cover dedicated coding clients, Trae windows, or long desktop-hosted runs.",
          tech: "Configurable external ACP agent calls; Claude Code–style coding sidecar delegation; Trae plugin start/status/delegate; hosted proposal cards with apply-and-start aligned to harness state.",
          scenario: "Plan in main thread, code in a sidecar; Trae window collaboration; user-confirmed background hosted runs.",
        },
        {
          title: "Task-scenario capability sets",
          problem: "Planning, coding, web, governance, and evolution need different surfaces—not the full catalog every turn.",
          tech: "Activate/deactivate capability groups per task scenario with multi-scenario unions; planning scenarios can switch exclusively; gated with collab phases and deferred loading; stale scenarios fade in chat.",
          scenario: "Plan first, then workspace writes; enable web only when needed; open governance/evolution scenarios separately.",
        },
      ],
    },
    {
      layer: "L5 · Execution & jobs",
      subtitle: "Bounded workspaces, multi-language code index & AST search, parallel prefetch IO, and scheduled unattended jobs.",
      modules: [
        {
          title: "Bounded workspace",
          problem: "File and shell access without bounds can harm the host or production data.",
          tech: "Per-session local/project workspace roots; separate work, upload, and output areas; per-thread sandbox dirs; path resolution with escape checks; read-only/sandbox policies aligned across desktop and gateway.",
          scenario: "Per-project or tenant isolation; subtasks run in assigned folders; hosted/automation writes stay authorized.",
        },
        {
          title: "Code index & syntax-tree search",
          problem: "Large repos need symbol- and dependency-aware lookup—not full-tree dumps or regex-only scans.",
          tech: "Local index for Python, JavaScript/TypeScript, Java, etc.: Tree-sitter AST symbols (classes, functions, interfaces), optional language-server enrichment; FTS plus symbol hits, file import graph, and type hierarchy; incremental rebuild and file watch; ranked parallel prefetch after search.",
          scenario: "Find types/modules in monorepos; trace calls and inheritance; search index before repo-wide grep.",
        },
        {
          title: "Browse & text search",
          problem: "When the index misses or literal/log snippets are needed, controlled browse and content search still matter.",
          tech: "Layered listing and glob; controlled path resolve; regex/keyword content search as a complement to the index; structured hits for planning and execution.",
          scenario: "Fresh unindexed files; error-string or config grep; small-scope directory recon.",
        },
        {
          title: "Parallel prefetch & batch IO",
          problem: "Many hits after symbol search make serial reads too slow for first response.",
          tech: "Parallel prefetch of ranked files into context after code search; local scheduler batch reads/checks; sub-agents explore in parallel inside the workspace bound; optional parallel lint summaries after edits.",
          scenario: "One search surfaces multi-file context; batch config reads; multi-folder sampling.",
        },
        {
          title: "Scheduled & unattended jobs",
          problem: "Patrols and reports must run on a schedule, decoupled from interactive chat.",
          tech: "Gateway cron/one-shot scheduling with desktop-aligned persistence; optional orchestration runtime; unattended runs skip human clarification interrupts; timeouts and channel summaries; distinct from Plan collab mode.",
          scenario: "Scheduled patrols and reports; overnight batches; channel-triggered automation resume.",
        },
      ],
    },
    {
      layer: "L6 · Memory & knowledge",
      subtitle: "Four roles—conversation profile, tool knowledge, episodic experience, and collab task facts—kept separate from unbounded chat context.",
      modules: [
        {
          title: "Long-term user memory",
          problem: "Long-running work needs durable preferences without shipping full chat history every turn.",
          tech: "Async post-turn extraction with debounced batching; structured profile + facts; token-budget injection; per-agent slots; desktop app view/edit; optional external memory plugin sync.",
          scenario: "Cross-day threads keep work context and recent focus; per-session toggle for injection.",
        },
        {
          title: "Active knowledge base",
          problem: "The agent must explicitly store and later retrieve reusable notes, not rely only on auto summaries.",
          tech: "Explicit write and topic recall; local persistence; per-thread and global namespaces; keyword matching (no embedding stack).",
          scenario: "Project constants, API contracts, last investigation notes saved and fetched on demand.",
        },
        {
          title: "Experience library",
          problem: "Hard-won fixes stay buried in one thread; similar work restarts from zero.",
          tech: "Structured episodic records (title, steps, tags, confidence); save/list/search/update/mark-used; middleware nudge after complex runs; prefetch similar cases before new work.",
          scenario: "Tricky bugs and multi-step workflows become reusable team playbooks.",
        },
        {
          title: "Collab task memory",
          problem: "Plan and multi-subtask runs need aggregated facts for the main task and UI, not one-off replies.",
          tech: "Post–sub-agent facts and output summaries; main-task aggregation; pushed via gateway events—separate from long-term user profile memory.",
          scenario: "Collab sidebar progress; supervisor replay of subtask outcomes; long runs resume with task-level state.",
        },
      ],
    },
    {
      layer: "L7 · Context & cost governance",
      subtitle: "Tool allowlists, deferred loading, graded tool outputs, chat compaction, and token observability—what may run vs how much context outputs consume.",
      modules: [
        {
          title: "Scenario assembly & tool allowlists",
          problem: "Many tools with different roles—each turn needs a clear ceiling on what the model may see and invoke.",
          tech: "Per-agent tool whitelists; union tool groups per task scenario; collab phases (planning, awaiting OK, executing, verify, etc.) further narrow allowed tools; planning vs execution boundaries stay separate.",
          scenario: "No writes or shells during planning; different agent roles get different surfaces; tenants trim available tools.",
        },
        {
          title: "Deferred on-demand loading",
          problem: "Harnesses mount many tools, yet one turn usually needs a subset—full definitions every round inflate first-turn tokens and misuse.",
          tech: "Small resident core; deferred catalog with name-only indexes; prompts distinguish bound vs pending vs deferred tools; load full schemas only when needed.",
          scenario: "Large catalogs stay cheap on turn one; coding-only turns skip web/governance docs.",
        },
        {
          title: "Graded tool-output governance",
          problem: "Reads, search, and shells can return huge payloads—inline everything blows the context window.",
          tech: "Write-time tiers: small inline, medium rule summaries (light trim for code/shell), large persist with refs and head/tail previews; optional LLM summaries for bulky search-like outputs; tool-history cold/hot merge with recent rounds intact; preserve-list for critical outputs; fold repetitive monitor-style replies to the latest.",
          scenario: "Giant logs/search hits do not flood the prompt; long runs keep recent tool chains; full bodies remain on disk.",
        },
        {
          title: "Conversation history compaction",
          problem: "Long human–agent threads also fill context and must be managed separately from tool outputs.",
          tech: "Near window limits, a compaction model summarizes early chat turns; tool side handled by output tiers and history merge so both do not compete for the same budget.",
          scenario: "Multi-day threads stay runnable; audits keep summaries plus recent interaction.",
        },
        {
          title: "Token usage observability",
          problem: "Production needs per-session/per-turn cost signals, not a black-box bill only.",
          tech: "Per-turn usage on messages and session aggregates; combined with allowlists, deferred loading, output tiers, and chat compaction for budgeting and model choice.",
          scenario: "Per-project/session input/output views; before/after policy comparison; capacity planning.",
        },
      ],
    },
    {
      layer: "L8 · Evolution & governance",
      subtitle: "Agent/skill governance, task-driven evolution, and full-stack observability from sessions through models and tools.",
      modules: [
        {
          title: "Agent & skill governance",
          problem: "Many roles and tool mixes need configurable, auditable setup—not one-off prompt edits.",
          tech: "Create/update custom agents under a governance scenario; tool allowlists and skill packs; read-only capability catalogs for assembly; ties to scenario surfaces and hosted runs.",
          scenario: "Per-role agents for ops/dev/business; tenant-trimmed capabilities; versioned skill rollouts.",
        },
        {
          title: "Task-driven self-evolution",
          problem: "Prompts, tool mixes, and skill docs must improve from real workloads, not ship-once.",
          tech: "Evolution scenario guides in-task refinement of agents and skills (prompts, tool grouping, docs); pairs with experience and long-term memory; versioned configs for before/after comparison.",
          scenario: "Internal hard tasks tune the harness; repetitive work becomes skills; co-evolve with model upgrades.",
        },
        {
          title: "Runtime observability & metrics",
          problem: "Opaque chats cannot answer where slowness or errors come from—hard for SRE and cost reviews.",
          tech: "SQLite observability for sessions, model calls, and tool calls; aggregates counts, durations, error rates, tokens; per-thread/time windows; desktop overview and leaderboards.",
          scenario: "Recent sessions and hot threads; high-error or slow tools; model latency and usage comparison.",
        },
        {
          title: "Session latency & tracing",
          problem: "Felt delay spans gateway, first token, model, and middleware—needs segmented diagnosis.",
          tech: "Per user-turn logging of scenarios and visible tools; collab cycle traces for phase changes and model response time; run-latency segments for client preflight, gateway streaming, pre-model middleware; per-thread timeline export.",
          scenario: "Split network vs gateway vs model on slow first token; see which Plan phase stalled; align bottlenecks on long runs.",
        },
        {
          title: "Error analysis & replay",
          problem: "Validation failures, inactive scenarios, HTTP errors need grouping—not raw log spelunking.",
          tech: "Tool invocations store error types and summaries; per-thread timelines (model requests, tool IO, trace lanes); session insight reports with rule-based recommendations; search prior tool traces after compaction.",
          scenario: "Batch-fix a tool’s 403/validation pattern; replay a failed multi-agent collab; feed seven-dimension metrics to review agents.",
        },
      ],
    },
  ],
};
