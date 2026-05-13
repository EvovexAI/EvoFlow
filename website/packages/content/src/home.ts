import { defaultLocale, type LocalizedValue, type SiteLocale } from "./locales";
import { siteLinks } from "./site-links";

type Accent = "primary" | "secondary" | "tertiary";

/** 站内文档路径，与 packages/content/src/docs/catalog.ts 一致 */
function siteDocHref(...segments: string[]): string {
  return `${siteLinks.docsSite}/${segments.join("/")}`;
}

export const homeContentByLocale: LocalizedValue<{
  hero: {
    title: string;
    description: string;
    /** 第二块：功能汇总区标题与导语 */
    featureSummary: {
      eyebrow: string;
      title: string;
      description: string;
    };
    /** 每项一条小卡片（首页 Hero：顶层支柱） */
    featureCards: Array<{
      title: string;
      description: string;
      accent: Accent;
    }>;
    /** 核心差异化下方的功能架构：按层次分组的小卡 */
    productArchitecture: {
      eyebrow: string;
      title: string;
      description: string;
      layers: Array<{
        label: string;
        modules: Array<{
          title: string;
          description: string;
          accent: Accent;
        }>;
      }>;
    };
  };
  capabilities: {
    eyebrow: string;
    title: string;
    description: string;
    /** 编排→交付主路径（首页能力矩阵标题区下方流程带） */
    closedLoopFlow: {
      label: string;
      /** 步骤卡片左上角序号前缀，如「步骤」/「Step」 */
      stepPrefix: string;
      /** 高亮第 1 步时的小标签，与 Plan 模式呼应 */
      planStepTag: string;
      steps: Array<{
        title: string;
        summary: string;
        accent: Accent;
      }>;
    };
    /** 能力矩阵顶部：控制面 + Plan 模式（架构图式焦点，先于五步闭环） */
    focusBand: {
      supervisorCaption: string;
      supervisorTitle: string;
      supervisorHook: string;
      supervisorRoles: Array<{ label: string; text: string }>;
      planBadge: string;
      planTitle: string;
      planPoints: string[];
      arrowLabel: string;
    };
    primaryCard: {
      eyebrow: string;
      title: string;
      description: string;
      /** 卡片内横向流程带三格文案，与要点呼应（固定 3 项） */
      flowStrip: readonly [string, string, string];
      bullets: string[];
    };
    secondaryCard: {
      eyebrow: string;
      title: string;
      description: string;
      flowStrip: readonly [string, string, string];
      bullets: string[];
    };
    /** 能力矩阵底部：分条说明 + 文档链接；eyebrow / description / intro 可为空，仅展示 title */
    scenarioFloor: {
      eyebrow: string;
      title: string;
      description: string;
      intro: string;
      panels: Array<{
        anchorId: string;
        title: string;
        accent: Accent;
        /** 动机与机制合一，控制篇幅 */
        lead: string;
        /** 场景与价值要点，宜 4–6 条 */
        highlights: string[];
        tags?: string[];
        links?: Array<{ href: string; label: string }>;
      }>;
    };
  };
  scenariosSection: {
    eyebrow: string;
    title: string;
    description: string;
    /** 场景卡片内三段正文的小标题（与 context / flow / outcomes 对应） */
    cardHeadings: {
      context: string;
      flow: string;
      outcomes: string;
    };
    scenarios: Array<{
      title: string;
      context: string;
      flow: string;
      outcomes: string[];
      accent: Accent;
    }>;
  };
  evolutionPulse: {
    eyebrow: string;
    title: string;
    events: Array<{
      date: string;
      title: string;
      accent: Accent;
      offset: string;
    }>;
  };
  /** 首页末尾致谢（替代原站内入口区块） */
  closingNote: string;
}> = {
  zh: {
    hero: {
      title: "驾驭超级 Agent 的编排框架",
      description:
        "多步任务常卡在「做到一半就断、难以续跑」，一大原因是闲聊式界面缺乏总控与状态；同时工具与长提示一把塞进上下文，Token 消耗和费用会快速上去。EvoFlow 面向需要多日推进、跨系统协作的智能体长任务：由超级总控智能体（Supervisor）把规划、依赖与监督串成可恢复的闭环，并以分阶段协作加上「工具渐进暴露」（首轮不摊开大清单、按需挂载扩展）把上下文压在必要范围内。本站介绍产品能力与演进路线。",
      featureSummary: {
        eyebrow: "产品概览",
        title: "核心差异化 · 八大支柱",
        description:
          "优先解决「任务跑不完、易中断」与「上下文膨胀、Token 消耗大」；下面八条为差异化支柱摘要，再向下可见总控拆解与能力矩阵。",
      },
      featureCards: [
        {
          title: "长任务与可恢复编排",
          description:
            "针对多步任务易中断、难闭环：跨系统与跨会话仍可监督、排队与重试，必要时局部重编排，尽量把事情跑到验收，而不是停在半截对话里。",
          accent: "primary" as Accent,
        },
        {
          title: "多智能体与超级总控智能体（Supervisor）协作",
          description:
            "由超级总控智能体（Supervisor）统筹全局目标与进度，基于子智能体能力画像实现任务精准分发，达到任务与能力最优匹配；子智能体支持并行执行，子任务间结构化上下文自动传递；总控全链路感知子智能体运行状态，支持全局进度调控、异常纠错与局部重编排；全流程可解释、可追溯。",
          accent: "secondary" as Accent,
        },
        {
          title: "场景与工作阶段",
          description:
            "按任务类型（对话、规划、改文件、检索等）进入不同工作形态，并与「先规划、再确认、后执行」等阶段配合：规划阶段侧重对齐目标与约束，确认后再放开实施类操作，降低误触风险。",
          accent: "tertiary" as Accent,
        },
        {
          title: "工具渐进暴露与技能 / MCP 市场",
          description:
            "工具侧强调渐进暴露：冷启动只挂核心与检索类能力，扩展工具按需挂载，减轻上下文与 Token。技能执行沿用「先读说明、再按步骤落地」等既有模式；在此基础上新增技能市场、MCP 市场，可从市场安装并统一管理已接入的技能与 MCP。",
          accent: "primary" as Accent,
        },
        {
          title: "核心问题与子问题状态",
          description:
            "抓住当前核心目标；仅在你明确多线事项时列出带子问题的进度，并把验收与边界写进快照回注后续回合。目标含糊或你转向时会再对齐，减少跑偏。",
          accent: "secondary" as Accent,
        },
        {
          title: "Claude Code 多会话协同",
          description:
            "支持与 Claude Code 实时对话交互，也可在超级总控模式下作为子代理承接编码、调试等专项任务；支持多 Claude Code 会话并行分工与结果汇总，兼顾自主交互与编排管控能力。",
          accent: "primary" as Accent,
        },
        {
          title: "托管智能体与长期任务托管",
          description:
            "针对持续运行的后台任务：独立沙箱隔离执行，支持7×24小时后台托管运行，实时监控运行状态与输出日志，支持暂停、恢复与终止操作，运行结果与日志持久化可追溯，适合巡检、监控、自动化运维等需要长期驻留的任务场景。",
          accent: "secondary" as Accent,
        },
        {
          title: "智能体进化",
          description:
            "把智能体配置治理与技能包生命周期放在同一能力面：创建与维护智能体（模型、工具分组与白名单、外部扩展与技能说明注入等），并行管理技能的启用、说明与资源更新；二者协同迭代、持续优化，变更可被运行侧重新读取，总控对话里出现的技能名与当前启用及允许范围一致。",
          accent: "tertiary" as Accent,
        },
      ],
      productArchitecture: {
        eyebrow: "",
        title: "产品架构",
        description: "",
        layers: [
          {
            label: "编排与执行",
            modules: [
              {
                title: "编排运行时",
                description:
                  "超级总控与子智能体、中间件与工具装配；支持基于子智能体能力画像的任务精准分发，任务与能力最优匹配；子智能体支持并行执行，子任务间结构化上下文自动传递；长任务执行中仍可在对话侧实时干预编排，并流式同步子任务产出与进度。",
                accent: "primary" as Accent,
              },
              {
                title: "托管智能体运行时",
                description: "长期运行智能体的独立托管环境，沙箱隔离执行，支持全生命周期管控与状态观测。",
                accent: "secondary" as Accent,
              },
              {
                title: "沙箱执行",
                description: "隔离执行环境：承载命令、文件与解析等高风险动作。",
                accent: "primary" as Accent,
              },
            ],
          },
          {
            label: "状态与工具",
            modules: [
              {
                title: "记忆与任务状态",
                description:
                  "长期记忆、会话与任务状态、主线意图快照；记忆注入可按策略开关，并与线程工作空间数据面配套。",
                accent: "secondary" as Accent,
              },
              {
                title: "技能与 MCP",
                description:
                  "技能包与 MCP 扩展业务工具；提供技能市场、MCP 市场以浏览安装并统一管理已装技能与 MCP；治理面可为智能体配置启用范围，并与工具组合策略相配合。",
                accent: "tertiary" as Accent,
              },
            ],
          },
          {
            label: "渠道与终端",
            modules: [
              {
                title: "IM 渠道",
                description: "飞书、Slack、Telegram 等与同一运行时对接，统一线程与投递；支持 `/claude`（直连 Claude Code，可选会话ID续接）、`/new`（新建会话线程）、`/lead`（切回主智能体）、`/status`（查看会话状态）等快捷命令。",
                accent: "primary" as Accent,
              },
              {
                title: "EvoPanel 桌面端",
                description:
                  "装在开发者电脑上的客户端：技能包与 MCP 与部署环境对齐，便于本地调试工具调用、跟进任务进度与执行轨迹。",
                accent: "tertiary" as Accent,
              },
              {
                title: "研发协同（Claude Code · Trae）",
                description:
                  "与 Claude Code 协同并可治理；Trae 本机通道；子任务可委派至部署侧可配置的外部编码助手。",
                accent: "secondary" as Accent,
              },
            ],
          },
          {
            label: "治理与运维",
            modules: [
              {
                title: "护栏与自动化",
                description:
                  "工具调用策略、执行轨迹与观测；定时/持续类任务可托管，并可与飞书等渠道做结果投递。",
                accent: "secondary" as Accent,
              },
              {
                title: "任务中心与观测",
                description: "任务可重跑；支持查询进度、状态与结果，便于排障与验收对齐。",
                accent: "tertiary" as Accent,
              },
              {
                title: "治理与工作空间",
                description:
                  "按任务/线程隔离的工作空间；可管控智能体提示词、工具与技能，及与之关联的定时与自动化策略。",
                accent: "primary" as Accent,
              },
            ],
          },
        ],
      },
    },
    capabilities: {
      eyebrow: "能力矩阵",
      title: "从编排到交付的完整闭环",
      description:
        "阅读顺序：Hero 区八大差异化支柱摘要 → 控制面与 Plan 模式、五步闭环；随后为编排与执行两项主说明；下方「运行能力说明」分条介绍 EvoPanel、编码委派、工作场景、工具渐进暴露与技能/MCP 市场、记忆、工作目录、定时任务、智能体进化等；仅 EvoPanel 条目提供站内文档入口，其余以正文为主。",
      focusBand: {
        supervisorCaption: "控制面",
        supervisorTitle: "超级总控智能体（Supervisor）",
        supervisorHook:
          "面向长周期任务的单一总控路径：经多轮澄清对齐意图与边界，形成可执行 Plan，并展开为具依赖关系的子任务直至闭环交付。",
        supervisorRoles: [
          { label: "澄清", text: "在订立 Plan 前明确目标范围、非目标与验收口径。" },
          { label: "分解", text: "将 Plan 落实为有向子任务图（DAG），管理先后、分支、汇合及上下文传递。" },
          { label: "监督", text: "持续掌握全局与子任务状态，支持纠错、重试与局部重编排。" },
        ],
        planBadge: "Plan 模式",
        planTitle: "对齐优先，再分解执行",
        planPoints: [
          "在工具调用与执行细化之前，将目标与验收条件固化于 Plan，以降低返工成本。",
          "当目标或边界发生变更时，由 Supervisor 触发再对齐，并同步更新后续子任务结构。",
        ],
        arrowLabel: "上述机制驱动下方五步闭环；第一步对应规划对齐（Plan 入口）。",
      },
      closedLoopFlow: {
        label: "闭环流程",
        stepPrefix: "步骤",
        planStepTag: "Plan 入口",
        steps: [
          {
            title: "规划对齐",
            summary: "明确谁规划、核心目标、边界与验收标准。",
            accent: "primary" as Accent,
          },
          {
            title: "分解执行",
            summary: "谁执行子任务、依赖先后、异步与汇合。",
            accent: "secondary" as Accent,
          },
          {
            title: "受控落地",
            summary: "子任务实际调用工具与外部接口；护栏与策略收敛权限，轨迹可解释。",
            accent: "tertiary" as Accent,
          },
          {
            title: "状态与集成",
            summary: "记忆与任务状态沉淀；技能与渠道把外部系统接进编排。",
            accent: "primary" as Accent,
          },
          {
            title: "观测与交付",
            summary: "进度可视、人工纠错与收口；定时与推送汇总结果。",
            accent: "secondary" as Accent,
          },
        ],
      },
      primaryCard: {
        eyebrow: "编排",
        title: "Plan、任务依赖与运行观测",
        description:
          "与上文「澄清—分解—监督」一致：Plan 审定后展开为显式依赖的子任务；步骤间以结构化上下文与工件传递；异步分支于同步闸口汇合。适用于工单链路、运维处置、研发流水线及跨日项目。",
        flowStrip: ["Plan", "子任务 DAG", "监督 · 快照"] as const,
        bullets: [
          "Plan 闸口：子任务拆解前固化验收口径与边界",
          "DAG：上游完成后解锁下游；共享上下文承载中间结果",
          "异步与同步闸口：在风险可控范围内并行；业务要求对齐处设置同步汇合",
          "监督：全局与子任务状态可视；支持纠错、重试与局部重编排",
          "主线快照：核心目标及子问题（按需）回注；发生方向变更时触发再对齐",
        ],
      },
      secondaryCard: {
        eyebrow: "执行",
        title: "子任务执行与策略约束",
        description:
          "子任务在目标环境中执行工具调用、脚本与外部 API，须符合既定策略边界；执行结果回写至共享上下文并纳入遥测。访问控制决策应具备可解释性与可审计性。针对高风险操作，可按部署启用隔离执行（例如沙箱）以收敛影响半径；该能力定位为可选加固，而非默认产品主张。",
        flowStrip: ["调用与输出", "策略与鉴权", "隔离加固（可选）"] as const,
        bullets: [
          "执行路径：由子任务驱动工具与系统集成调用，产出结构化结果供下游消费与观测。",
          "策略与鉴权：基于租户、环境与资源维度收敛权限；允许或拒绝决策须可追溯、可复盘。",
          "风险加固：对特定操作按需启用隔离执行（如沙箱），以限制影响范围；按部署配置启用。",
        ],
      },
      scenarioFloor: {
        eyebrow: "",
        title: "运行能力说明",
        description: "",
        intro: "",
        panels: [
          {
            anchorId: "capability-evopanel",
            title: "EvoPanel",
            accent: "primary" as Accent,
            lead:
              "EvoPanel 是 EvoFlow 的核心桌面客户端：与网关直连，承载你与智能体的实时对话、线程与任务操作、协作阶段与场景切换，以及自动化、观测等高频入口。多数日常编排、追问与验收都在此完成；服务端负责执行策略与编排语义，桌面端负责呈现、交互与控制台视图（含委派给外部编码助手时的输出流）。",
            highlights: [
              "主工作台：对话、工具调用与流式回复与后端一致，适合作为值班与业务侧的主要操作面。",
              "与编排协同：总控在服务端推进子任务与依赖时，可在桌面侧并行查看进度、切换工作场景、对照轨迹。",
              "可扩展入口：任务中心、定时规则、联调与排障相关能力集中可达，减少在多个工具间来回切换。",
            ],
            links: [{ href: siteDocHref("getting-started"), label: "详细文档：快速开始" }],
          },
          {
            anchorId: "capability-claude-code-orchestration",
            title: "Claude Code 编排",
            accent: "tertiary" as Accent,
            lead:
              "Claude Code 以「外部子代理」方式接入：总控可把具体编码、改库、排错等任务委派给它，由本机或你惯用的 Claude Code 环境执行；编排侧负责下达与收口。同一外部会话内支持多轮往返对话，不必为每一句追问重建会话。Claude Code 的产出会流式回传，在桌面版控制台中可近实时看到过程与结果，便于与主线编排对照验收。",
            highlights: [
              "定位：相对总控的独立编码执行面，通过受控会话桥接，适合把「写、改、跑、看日志」交给 Claude Code，总控保留拆分、追问与汇总。",
              "委派与会话：可按子任务派发；需要时在同一会话里连续多轮下达与纠偏，也可显式开启新会话隔离上下文。",
              "可观测性：桌面端控制台展示 Claude Code 侧输出流，长步骤不必盲等对话窗，排障与对齐验收更直观。",
            ],
          },
          {
            anchorId: "capability-scenario-switching",
            title: "场景切换",
            accent: "primary" as Accent,
            lead:
              "产品提供多种工作场景（如默认对话、规划与执行、文件与命令、联网检索、治理与自动化、特定运行时、能力自进化等）。可在对话中按需启用或退出；多种场景同时生效时，可调用的工具为其合并结果，避免无关工具长期占用上下文。进入规划类场景时，可与前台协作状态联动，便于先对齐再拆分任务。",
            highlights: [
              "规划侧重：在不动生产文件的前提下做方案与子任务编排，必要时可委派子代理做只读摸底",
              "文件侧重：在明确需要本地读写或命令执行时启用，与仅规划不写盘区分开",
              "联网侧重：以外部检索与网页信息为主时使用",
              "治理侧重：智能体进化（含智能体管理与技能管理）、定时自动化等；列出或修改定时规则应走自动化相关能力，勿与纯粹的规划对话场景混淆",
              "多轮回到闲聊时可自动淡化已过期的场景挂载，避免工具面无谓膨胀",
            ],
          },
          {
            anchorId: "capability-progressive-tools",
            title: "工具渐进暴露与市场化管理技能 / MCP",
            accent: "tertiary" as Accent,
            lead:
              "工具侧由 EvoFlow 做渐进暴露：首轮不挂上全部可选工具说明，核心与检索类能力先行，扩展工具在确认需要时再检索挂载，压缩提示长度与首响延迟；可与场景合并后的工具白名单一起裁剪误触面。技能与 MCP 的执行范式（先读说明再步骤化落地等）沿用运行时既有能力；在此基础上提供技能市场、MCP 市场，用于从市场安装、启用、卸载或统一管理已接入的技能包与 MCP，与治理面的智能体配置衔接。",
            highlights: [
              "工具：按需挂载扩展能力，避免首轮摊开大清单（与子会话独立工具面、场景合并裁剪相配合）",
              "技能市场 / MCP 市场：安装与已装项治理集中在市场与管理面，不必只靠手工拷目录",
              "技能执行仍遵循先读技能说明、再按步骤调用，不把整套说明一次性塞进上下文",
              "智能体侧继续用工具分组、白名单与扩展声明收敛可调用的 MCP / 技能范围",
            ],
          },
          {
            anchorId: "capability-memory",
            title: "长期记忆与上下文治理",
            accent: "primary" as Accent,
            lead:
              "提供写入记忆与回忆能力，把需要在多轮之间保留的要点写入本机知识库文件，按会话隔离并支持全局条目，检索方式为关键词匹配，不依赖向量模型。本站在线助手中使用的资料检索与向量索引属于另一套能力，与运行时记忆互补，请勿混用。",
            highlights: [
              "可记录标题、摘要与类别，便于后续按词召回",
              "数据落在本机指定目录，便于备份迁移与排障",
              "在侧重能力演进的场景下，可与治理类能力一并挂载，便于统一维护",
              "与任务协作、线程状态等机制搭配使用，各负其责",
            ],
            tags: ["写入记忆", "回忆", "按会话", "关键词"],
          },
          {
            anchorId: "capability-workspace",
            title: "工作空间",
            accent: "secondary" as Accent,
            lead:
              "定时自动化与本地执行均支持为单次运行指定工作目录；桌面或网关侧也可绑定本机根路径，让文件类与命令类能力在可控范围内操作。是否允许写盘与执行系统命令，由部署环境与安全策略决定。",
            highlights: [
              "自动化与本地执行可为单次运行指定工作目录，并在界面或配置里限制最长运行时间等（以你部署的版本为准）",
              "文件与命令在约定根路径下执行，便于配合只读或沙箱策略",
              "不同任务可配置不同工作目录，互不影响",
            ],
          },
          {
            anchorId: "capability-scheduled-jobs",
            title: "定时任务",
            accent: "tertiary" as Accent,
            lead:
              "网关在后台按固定周期扫描自动化任务目录中的任务描述文件，到达约定时间即触发执行；可配置周期规则、提示词内容，以及是否在触发时调用编排运行时、是否向飞书推送摘要等。每次触发是独立的自动化运行，与当前聊天窗里的人工编排任务不同；如需要，也可配置是否在多次触发之间复用同一会话。",
            highlights: [
              "在侧栏「定时任务」里创建与管理规则；支持按周期或重复方式触发（以界面为准）",
              "可选在触发时走编排运行时，并可设置超时等保护",
              "若部署方提供诊断入口，可确认后台调度是否在正常运行",
            ],
          },
          {
            anchorId: "capability-agent-evolution",
            title: "智能体进化",
            accent: "primary" as Accent,
            lead:
              "「智能体进化」把对智能体的配置治理与对技能包的生命周期管理放在同一能力面：在治理类工作场景下，既可维护「谁在用哪个模型、能调哪些工具、是否接入外部扩展、要不要向模型注入某套技能说明」，也可维护「技能包是否启用、说明与脚本如何更新」；网关启动时按配置装配，技能执行前仍遵循先读说明、再按步骤操作，避免一次性塞满上下文。",
            highlights: [
              "智能体管理：创建、更新与列出智能体；配置工具分组与工具白名单；声明允许的外部扩展连接；技能说明可选注入，不填则减少提示噪声。",
              "技能管理：技能以说明与目录资源形式存在；可控制启用与停用；配置变更后运行侧可重新读取；总控对话里出现的技能名与当前启用及允许范围一致。",
              "二者协同：在同一治理语境下迭代「智能体定义」与「技能包」，使运行时表现与运维脚本、界面配置同步。",
            ],
          },
        ],
      },
    },
    scenariosSection: {
      eyebrow: "典型场景",
      title: "编排怎么落在日常里",
      description: "六种常见搭法示意；需自行对接系统与配置，不是开箱即用的行业方案。",
      cardHeadings: {
        context: "要解决的事",
        flow: "可以怎么做",
        outcomes: "能稳住什么",
      },
      scenarios: [
        {
          title: "长任务：Plan 与多子代理编码",
          context:
            "从方案到联调跨度长、参与面多：既要先把目标、依赖和验收口径钉住（典型是长任务里的 Plan），又要在落地阶段让多条工作线并行推进，而不是所有人堵在同一条对话里。",
          flow:
            "前半程用规划类场景 + Plan：总控把里程碑、依赖、风险与验收写进子任务图，长链路有「闸口」再往下走。进入实现后，总控可同时派发多个子代理分工并行，例如一轨写业务代码、一轨补单测与契约、一轨同步文档或脚手架；需要深改或专用编码环境时再挂外部编码子代理（如 Claude Code），多轨输出在桌面端对照，最后在总控处汇合与收口。大范围写盘或高危命令再显式切场景或收窄权限。",
          outcomes: [
            "Plan 管住长任务口径与先后，减少半路改向成本",
            "多子代理并行缩短墙钟时间，开发与测试等可同步推进",
            "轨迹上能看清各轨产出与合并点，便于评审、回滚与责任划分",
          ],
          accent: "primary" as Accent,
        },
        {
          title: "定时任务与飞书汇报",
          context:
            "巡检、日报、指标汇总等希望按固定节奏自动跑，跑完要把结果摘要推到飞书群或相关负责人，而不是靠人肉盯窗口。",
          flow:
            "在自动化任务目录编写任务文件：写清周期或重复规则、提示词与可选的编排触发；打开飞书推送相关配置并指定会话或群。由网关调度器到期触发；每次运行独立留痕，需要时可再调编排运行时生成结构化结论再推送。失败重试与告警可与你方运维通道衔接。",
          outcomes: [
            "定时与日常对话解耦，避免聊天窗里「忘了跑」",
            "飞书侧收到可读的执行摘要，便于值班与留档",
            "任务文件与网关诊断方式统一，运营与研发对齐同一套约定",
          ],
          accent: "secondary" as Accent,
        },
        {
          title: "专员智能体与技能进化",
          context:
            "不同用户、不同业务线希望有「对口」的智能体：工具面、模型与提示各不相同；技能包也会随业务迭代需要修文档、修脚本、持续优化。",
          flow:
            "在治理类场景下，根据意图创建或更新专用智能体配置（模型、工具分组与白名单、可接扩展等），相当于为场景配好专员。技能侧可启停、修订说明与附属资源，把修复与演进纳入同一套「智能体进化」能力面；变更可被运行侧重新读取，总控对话里出现的技能名与启用范围一致。",
          outcomes: [
            "专员化配置把能力面收敛到业务所需，减少一锅端",
            "技能可迭代、可治理，与智能体定义同步演进",
            "详细配置与治理步骤见仓库内文档说明",
          ],
          accent: "tertiary" as Accent,
        },
        {
          title: "记忆与内部助手",
          context:
            "内部问答要贴文档与接口口径，长对话里用户已确认的约束还不能丢；工具面又不能无限膨胀。",
          flow:
            "内部助手侧：收紧智能体的工具分组与白名单，按需开联网或治理类场景，用澄清补齐缺失条件。记忆侧：把「已说死」的口径、偏好与工单锚点用写入记忆与回忆在多轮间固定。本站在线助手的资料索引与运行时记忆是两套通路，勿混用；外部资料可走扩展或联网检索。",
          outcomes: [
            "助手回答是否贴谱，取决于检索、扩展与提示策略",
            "记忆与资料各负其责，减少上下文里自相矛盾",
            "桌面端便于对照网关行为与协作状态",
          ],
          accent: "primary" as Accent,
        },
        {
          title: "跨系统办事",
          context:
            "监控、工单、代码仓各管一摊；你想把「查状态—写备注—跑脚本」拆成可重试的小步，并且事后能看清当时走了哪些能力。",
          flow:
            "先切到规划类场景，由总控列子任务；对外只走你已接好的扩展工具或自建接口。排查尽量只读；真要改文件再切文件类场景。工单号、结论等可写入记忆，下一轮用回忆拉回。",
          outcomes: [
            "每一步留在网关轨迹里，复盘有据",
            "写库、改生产仍绑在你方凭证与沙箱上",
            "接哪一家厂商，只由配置决定，产品不内置绑定",
          ],
          accent: "primary" as Accent,
        },
        {
          title: "运维并行处置",
          context:
            "日志、指标、远程命令多头并进；你想先分段消化，再在主线汇合，高危动作还要收得住。",
          flow:
            "子代理分段拉日志、跑只读命令，总控负责汇总；是否开放命令类子代理，看沙箱与注册子代理。并行上限由运行参数卡住。",
          outcomes: [
            "长输出沉在子会话，主线只留结论",
            "失败可以按子任务重试，不必整段对话重来",
            "和告警、值班台的衔接仍走你方扩展或接口",
          ],
          accent: "secondary" as Accent,
        },
      ],
    },
    evolutionPulse: {
      eyebrow: "路线图",
      title: "EvoFlow 演进节点",
      /** offset 与桌面轨道动效同步（约 8%–90%） */
      events: [
        {
          date: "基线",
          title: "承接 DeerFlow 2.0：多包工程与编排核",
          accent: "primary" as Accent,
          offset: "8%",
        },
        {
          date: "编排",
          title: "长任务可恢复编排与 Supervisor 多智能体协作",
          accent: "primary" as Accent,
          offset: "24%",
        },
        {
          date: "形态",
          title: "场景与工作阶段；工具渐进暴露与技能 / MCP 市场",
          accent: "tertiary" as Accent,
          offset: "40%",
        },
        {
          date: "状态",
          title: "任务状态、记忆与快照回注",
          accent: "secondary" as Accent,
          offset: "54%",
        },
        {
          date: "协同",
          title: "Claude Code · Trae 研发协同",
          accent: "secondary" as Accent,
          offset: "71%",
        },
        {
          date: "交付",
          title: "EvoPanel 桌面端",
          accent: "tertiary" as Accent,
          offset: "88%",
        },
      ],
    },
    closingNote: "感谢支持，感谢观看。",
  },
  en: {
    hero: {
      title: "Orchestration for serious agent workloads",
      description:
        "Multi-step work often stalls halfway—chat-style UIs lack durable control and state—while stuffing every tool and wall of text into context drives token use and cost up fast. EvoFlow targets agent workloads that span days and systems: a lead Supervisor ties planning, dependencies, and oversight into recoverable runs, with phased collaboration plus progressive tool exposure (small cold-start toolsets, mount extensions on demand) so context stays as small as practical. This site explains product capabilities and roadmap.",
      featureSummary: {
        eyebrow: "Product pillars",
        title: "What makes EvoFlow different",
        description:
          "We focus first on stalled long tasks and heavy context/token use—eight differentiation pillars summarized below; scroll on for the Supervisor breakdown and the full capability matrix.",
      },
      featureCards: [
        {
          title: "Long-running, recoverable orchestration",
          description:
            "For work that too often stops mid-flight: supervised queues, retries, and partial re-orchestration across systems and sessions aim to reach acceptance—not stall in ad-hoc chat turns.",
          accent: "primary" as Accent,
        },
        {
          title: "Multi-agent collaboration",
          description:
            "A lead Supervisor owns goals and pacing while specialist agents execute—who plans, who runs work, and when branches merge is explicit in the runtime story.",
          accent: "secondary" as Accent,
        },
        {
          title: "Scenarios & collaboration phases",
          description:
            "Switch posture by task type—conversation, planning, file work, web research, and more—and run it alongside phased collaboration: align goals under planning, confirm, then execute so risky actions stay gated until you proceed.",
          accent: "tertiary" as Accent,
        },
        {
          title: "Progressive tool exposure & skill / MCP marketplace",
          description:
            "Tools stay progressively exposed: a tight cold-start surface plus on-demand mounting for optional tools to curb context and tokens. Skill execution keeps the established read-the-pack-then-act pattern; EvoFlow adds skill and MCP marketplaces to install, enable, and manage bundled skills and MCP servers from one place.",
          accent: "primary" as Accent,
        },
        {
          title: "Core objective & sub-problem state",
          description:
            "Distill the primary goal; track sub-problems with statuses only when parallel work is explicit. Fold acceptance and boundaries into a snapshot fed back into guidance—realign on fuzzy intent or when you pivot.",
          accent: "secondary" as Accent,
        },
        {
          title: "Claude Code Multi-session Collaboration",
          description:
            "Supports real-time interactive conversations with Claude Code, or operating as a sub-agent under the Supervisor to undertake specialized tasks such as coding and debugging; enables parallel task division across multiple Claude Code sessions and result aggregation, balancing both autonomous interaction and orchestration control capabilities.",
          accent: "primary" as Accent,
        },
        {
          title: "Hosted agents for long-running workloads",
          description:
            "For always-on background work: sandbox-isolated execution, 24/7 hosted runs with live status and logs, pause/resume/terminate controls, and durable outcomes—suited to patrol jobs, monitoring, and automation that must stay resident without babysitting a chat window.",
          accent: "secondary" as Accent,
        },
        {
          title: "Agent evolution",
          description:
            "Keeps agent governance and skill-pack lifecycle on one surface: maintain agent definitions (models, tool groups and allowlists, external extensions, optional skill-injection), while enabling, revising, and optimizing skills in lockstep; changes can be reloaded at runtime so the Supervisor sees skill names that match what is enabled and permitted.",
          accent: "tertiary" as Accent,
        },
      ],
      productArchitecture: {
        eyebrow: "",
        title: "Product architecture",
        description: "",
        layers: [
          {
            label: "Orchestration & execution",
            modules: [
              {
                title: "Agent runtime",
                description:
                  "Lead and worker agents, middleware, and tool wiring; keep steering in chat during long runs with streaming sub-task output.",
                accent: "primary" as Accent,
              },
              {
                title: "Sandbox execution",
                description: "Isolated environments for commands, files, and parsing where risk must be bounded.",
                accent: "primary" as Accent,
              },
            ],
          },
          {
            label: "State & tooling",
            modules: [
              {
                title: "Memory & mission state",
                description:
                  "Durable memory, session/job state, and mission snapshots; memory injection can be policy-gated with per-thread workspace data.",
                accent: "secondary" as Accent,
              },
              {
                title: "Skills & MCP",
                description:
                  "Skill packs and MCP adapters for business tools; skill and MCP marketplaces to install and centrally manage deployed packs and servers—plus governance hooks so agents only surface approved mixes.",
                accent: "tertiary" as Accent,
              },
            ],
          },
          {
            label: "Channels & surfaces",
            modules: [
              {
                title: "Messaging channels",
                description: "Feishu, Slack, Telegram, and similar bridges onto the same threads and delivery; supports slash commands: `/claude` (direct connection to Claude Code with optional session ID resumption), `/new` (new conversation thread), `/lead` (switch back to lead agent), `/status` (view session state).",
                accent: "primary" as Accent,
              },
              {
                title: "EvoPanel desktop",
                description:
                  "Desktop client with the same skill packs and MCP wiring as your deployment—debug tool runs locally and follow job progress and traces.",
                accent: "tertiary" as Accent,
              },
              {
                title: "Engineering adapters (Claude Code · Trae)",
                description:
                  "Claude Code workflows with governance hooks; Trae desktop bridge; coding subtasks delegated to external adapters you configure.",
                accent: "secondary" as Accent,
              },
            ],
          },
          {
            label: "Governance & operations",
            modules: [
              {
                title: "Guardrails & automation",
                description:
                  "Tool policy, traces, and telemetry; cron-like schedules with durable runs and optional channel pushes.",
                accent: "secondary" as Accent,
              },
              {
                title: "Task center & observability",
                description:
                  "Rerun jobs, inspect progress and states, and fetch outcomes—built for triage and acceptance checks.",
                accent: "tertiary" as Accent,
              },
              {
                title: "Governance & workspace",
                description:
                  "Per-job/thread workspaces; manage agent prompts, tools, skills, and the schedules/automation policies tied to them.",
                accent: "primary" as Accent,
              },
            ],
          },
        ],
      },
    },
    capabilities: {
      eyebrow: "Capabilities",
      title: "From orchestration to delivery",
      description:
        "Recommended order: the eight hero pillars, then control plane and Plan mode, then the five-step journey, followed by the orchestration and execution cards; the Runtime capabilities section below lists EvoPanel, coding delegation, scenarios, progressive tool exposure plus skill/MCP marketplaces, memory, workspace, schedules, and agent evolution. Only the EvoPanel panel links to on-site getting-started docs; the rest are explained in copy.",
      focusBand: {
        supervisorCaption: "Control plane",
        supervisorTitle: "Lead Supervisor",
        supervisorHook:
          "A single supervisory path for long-running work: clarify intent and boundaries, publish an executable plan, expand it into dependent subtasks, and carry the mission through to closure.",
        supervisorRoles: [
          { label: "Clarify", text: "Define scope, non-goals, and acceptance criteria before the plan is locked." },
          { label: "Decompose", text: "Materialize the plan as a directed task graph (DAG) with ordering, branches, joins, and context handoffs." },
          { label: "Supervise", text: "Maintain global and per-subtask situational awareness; support correction, retry, and partial re-orchestration." },
        ],
        planBadge: "Plan mode",
        planTitle: "Alignment before decomposition",
        planPoints: [
          "Record goals and acceptance in the plan prior to tool calls and execution-level elaboration, reducing rework.",
          "When goals or boundaries change, the Supervisor re-aligns and updates downstream task structure accordingly.",
        ],
        arrowLabel: "This control flow drives the five-step journey below; step 1 corresponds to the plan entry point.",
      },
      closedLoopFlow: {
        label: "Closed-loop flow",
        stepPrefix: "Step",
        planStepTag: "Plan entry",
        steps: [
          {
            title: "Align & plan",
            summary: "Clarify who owns planning, goals, boundaries, and acceptance checks.",
            accent: "primary" as Accent,
          },
          {
            title: "Decompose & run",
            summary: "Who executes subtasks, dependency order, async work, and merge points.",
            accent: "secondary" as Accent,
          },
          {
            title: "Controlled execution",
            summary: "Subtasks invoke tools and external APIs; guardrails tighten scope with explainable traces.",
            accent: "tertiary" as Accent,
          },
          {
            title: "State & integrate",
            summary: "Durable memory and task state; skills and channels wire business systems in.",
            accent: "primary" as Accent,
          },
          {
            title: "Observe & ship",
            summary: "Progress visibility, human correction, closure—plus schedules and pushes for summaries.",
            accent: "secondary" as Accent,
          },
        ],
      },
      primaryCard: {
        eyebrow: "Orchestration",
        title: "Orchestration detail: plan, task dependencies, and observability",
        description:
          "Consistent with Clarify / Decompose / Supervise above: once the plan is approved, work expands into explicit dependencies; structured context and artifacts move between steps; asynchronous branches reconcile at synchronous gates. Suitable for ticket chains, operations, engineering pipelines, and multi-day programs.",
        flowStrip: ["Plan", "Task DAG", "Oversight"] as const,
        bullets: [
          "Plan gate: freeze acceptance criteria and boundaries before subtasks are instantiated",
          "DAG semantics: downstream work unlocks after upstream completion; shared context carries intermediate results",
          "Asynchronous and synchronous gates: parallelize within risk bounds; enforce alignment where the business requires it",
          "Supervision: global and per-subtask visibility; correction, retry, and partial re-orchestration",
          "Mission snapshot: feed back primary goals and optional sub-problems; trigger re-alignment on directional change",
        ],
      },
      secondaryCard: {
        eyebrow: "Execution",
        title: "Subtask execution and policy enforcement",
        description:
          "Subtasks invoke tools, scripts, and external APIs within declared policy boundaries in the target environment; results are written to shared context and telemetry. Access-control decisions should remain explainable and auditable. For high-risk operations, deployments may enable isolated execution (for example, sandboxing) to limit blast radius; this is an optional hardening measure rather than the default product claim.",
        flowStrip: ["Invoke & output", "Policy & auth", "Isolation (optional)"] as const,
        bullets: [
          "Execution path: subtasks drive tool and system integration calls and emit structured results for downstream consumption and observability.",
          "Policy and authorization: tighten permissions by tenant, environment, and resource class; allow or deny decisions must be traceable and reviewable.",
          "Risk hardening: enable isolated execution for selected operations when required by the deployment configuration.",
        ],
      },
      scenarioFloor: {
        eyebrow: "",
        title: "Runtime capabilities",
        description: "",
        intro: "",
        panels: [
          {
            anchorId: "capability-evopanel",
            title: "EvoPanel",
            accent: "primary" as Accent,
            lead:
              "EvoPanel is the flagship EvoFlow desktop client: it connects directly to the Gateway and hosts streaming conversations, thread and task navigation, collaboration phases, scenario presets, and common entry points for automation and observability. Most day-to-day orchestration, follow-ups, and acceptance checks happen here; the server enforces policy and graph semantics while the desktop focuses on interaction, telemetry, and consoles—including streamed output from delegated coding agents.",
            highlights: [
              "Primary workspace: chat, tool calls, and streaming responses stay consistent with backend behavior for operators and business users.",
              "Works with orchestration: follow subtasks and dependencies on the desktop while the lead advances the graph on the server.",
              "Single surface for task center, schedules, and triage-style workflows without constantly switching tools.",
            ],
            links: [{ href: siteDocHref("getting-started"), label: "Docs: Getting started" }],
          },
          {
            anchorId: "capability-claude-code-orchestration",
            title: "Claude Code orchestration",
            accent: "tertiary" as Accent,
            lead:
              "Claude Code is integrated as an external coding sub-agent: the lead delegates concrete coding, refactors, and debugging to Claude Code running in your local or preferred environment, while orchestration handles assignment and follow-up. The same external session supports multiple conversational turns—you can steer and iterate without starting from scratch each time. Outputs stream back; the desktop console shows Claude Code activity in near real time so you can align with the main thread without blind waits.",
            highlights: [
              "Role: an execution sidecar for coding work, bridged with a narrow tool path; the lead still owns decomposition, Q&A, and consolidation.",
              "Delegation & session: assign subtasks to Claude Code; reuse one session for back-and-forth, or open a fresh session when you need isolation.",
              "Visibility: the desktop client surfaces streaming Claude Code output so long runs are observable and easier to validate or triage.",
            ],
          },
          {
            anchorId: "capability-scenario-switching",
            title: "Scenario switching",
            accent: "primary" as Accent,
            lead:
              "The product ships multiple work scenarios—such as default chat, planning and execution, files and commands, web research, governance and automation, specific runtimes, and capability evolution. You can turn them on or off as the conversation needs. When several scenarios are active together, the callable tools are merged so you keep the right breadth without leaving unused tools attached forever. Planning-oriented scenarios can align with front-of-house collaboration state so you agree before decomposition.",
            highlights: [
              "Planning-first: shape plans and subtasks without touching production files unless you explicitly choose to; read-only reconnaissance stays separate from write-heavy work.",
              "Files-first: enable when you truly need local read/write or shell-style execution, distinct from planning-only chat.",
              "Web-first: lean on external search and page fetch when fresh web context matters.",
              "Governance-first: agent evolution (agent plus skill management), schedules, and automation—manage recurring jobs through automation flows rather than treating planning chat as a scheduler UI.",
              "When the thread drifts back to casual chat, stale scenario attachments can drop away so the tool surface does not balloon.",
            ],
          },
          {
            anchorId: "capability-progressive-tools",
            title: "Progressive tools & skill / MCP marketplace",
            accent: "tertiary" as Accent,
            lead:
              "EvoFlow exposes tools progressively: the first turns emphasize core and lookup-style capabilities, and broader optional tools attach only after intent is clear—together with scenario-based allowlists this keeps prompts shorter and first responses snappier. Skill and MCP execution still follows read-the-pack-instructions-then-step discipline. Skill and MCP marketplaces let you install, enable, disable, or centrally manage packs and connections instead of juggling folders by hand, aligned with agent governance screens.",
            highlights: [
              "Tools: optional capabilities mount on demand instead of dumping the full catalog up front, complementing per-scenario tool surfaces.",
              "Marketplaces: browse, install, and govern skills and MCP alongside agent definitions.",
              "Skills: load instructions progressively—read the pack guide first, then act—rather than pasting entire bundles into context.",
              "Agents: tool groups, allowlists, and extension declarations keep sub-agents and workers on narrower surfaces when configured.",
            ],
          },
          {
            anchorId: "capability-memory",
            title: "Durable memory & context governance",
            accent: "primary" as Accent,
            lead:
              "Runtime memory lets assistants store and recall durable notes across turns: titles, summaries, and categories you can retrieve later with keyword search—no embedding model required on this path. Data stays in local knowledge files scoped by conversation with optional global entries, which makes backup and support straightforward. This is separate from the marketing site assistant’s own indexed knowledge; do not mix the two when explaining behavior to end users.",
            highlights: [
              "Structured entries make later recall predictable.",
              "Local storage keeps data under your deployment’s control.",
              "Governance-heavy scenarios can surface memory tooling next to agent and skill maintenance.",
              "Collaborative task and thread state complements memory; each mechanism has its own job.",
            ],
            tags: ["Memory", "Recall", "Per thread", "Keywords"],
          },
          {
            anchorId: "capability-workspace",
            title: "Workspace",
            accent: "secondary" as Accent,
            lead:
              "Automations and local execution can pin a working directory per run so file and command helpers operate inside a known root. The desktop client can also bind a default workspace folder for everyday tasks. Whether writes or shell commands are allowed depends on your deployment’s safety posture—treat sandboxing as an operator choice, not an implicit guarantee.",
            highlights: [
              "Per-run workspace plus optional time limits are configured where automations are authored (exact controls depend on your build).",
              "File and command tools respect the configured root so read-only or sandbox policies are easier to reason about.",
              "Different jobs can use different roots without sharing state by accident.",
            ],
          },
          {
            anchorId: "capability-scheduled-jobs",
            title: "Scheduled jobs",
            accent: "tertiary" as Accent,
            lead:
              "A background scheduler watches the automation definitions your operators maintain and fires each job when its calendar rule matches. Every firing is its own automation run, distinct from the interactive chat thread you have open—though you can choose whether later runs reuse a thread when your deployment supports it. Optional hooks can invoke the orchestration runtime, push summaries to channels such as Feishu, or honor memory settings per job.",
            highlights: [
              "Create and tune schedules from the sidebar **Scheduled jobs** UI with recurring or one-off patterns as shipped in your version.",
              "Optionally route triggers through the orchestration runtime with timeouts and guardrails.",
              "When admins expose diagnostics, you can confirm the scheduler is healthy without reading raw logs.",
            ],
          },
          {
            anchorId: "capability-agent-evolution",
            title: "Agent evolution",
            accent: "primary" as Accent,
            lead:
              "Agent evolution is one surface for both agent governance and skill lifecycle: in governance-oriented scenarios you define which models, tool groups, allowlists, and external connections each agent may use, and whether skill guides should be injected into prompts. In parallel you enable or retire skill packs, refresh their instructions, and keep packaging aligned with what operators expect at runtime. The gateway loads these definitions on startup; skill execution still begins by reading the pack instructions, not by dumping entire bundles into context.",
            highlights: [
              "Agent management: create and update agents, tune tool exposure, attach permitted external tools, and optionally inject skill narratives.",
              "Skill management: enable or disable packs and revise their instructions; configuration reloads pick up changes so the lead only advertises allowed names.",
              "Together: iterate agents and skills in one governance loop so runtime behavior matches what your team maintains in the product UI.",
            ],
          },
        ],
      },
    },
    scenariosSection: {
      eyebrow: "Scenarios",
      title: "Orchestration in day-to-day work",
      description:
        "Six composition patterns—illustrative only. You wire the systems, credentials, and extensions; nothing here is a shipped vertical SKU.",
      cardHeadings: {
        context: "The problem",
        flow: "How to orchestrate it",
        outcomes: "What stays under control",
      },
      scenarios: [
        {
          title: "Long-running work: Plan + parallel coding agents",
          context:
            "Design-to-integration spans weeks and many stakeholders: you need Plan to freeze goals, dependencies, and acceptance before the repo moves—and you still want parallel execution lanes instead of everyone queuing in one chat.",
          flow:
            "Phase one stays in a planning-style scenario with Plan: the lead materializes milestones, risks, and acceptance into a subtask graph so long chains have explicit gates. During implementation the lead can fan out multiple subagents at once—for example one track for product code, another for tests/contracts, another for docs or scaffolding—while optional external coding workers (such as Claude Code) handle deeper refactors. EvoPanel surfaces each lane’s streaming output for comparison before the lead merges and closes. Switch scenarios or tighten permissions when broad writes or privileged commands are intentional.",
          outcomes: [
            "Plan keeps long-horizon intent ordered so you do not thrash mid-flight",
            "Parallel child agents shorten wall-clock time across dev, test, and docs tracks",
            "Traces show who produced what and where lanes merged, which helps review and rollback calls",
          ],
          accent: "primary" as Accent,
        },
        {
          title: "Scheduled jobs and Feishu reporting",
          context:
            "Checks, digests, and rollups should run on a cadence—and when they finish, the right Feishu chat or owner should get a readable summary without someone babysitting a browser window.",
          flow:
            "Author automation task files with schedule or recurrence rules, prompts, and optional orchestration-on-trigger. Enable Feishu push settings and target chats. The Gateway scheduler fires each run independently with traceable output; optionally invoke the orchestration runtime to produce structured conclusions before the push. Wire retries and paging to your gateway plus external alerting as needed.",
          outcomes: [
            "Schedules stay decoupled from day-to-day chat so runs do not get forgotten",
            "Feishu receives actionable summaries for on-call and audit trails",
            "One automation task contract and shared diagnostics keep ops and engineering aligned",
          ],
          accent: "secondary" as Accent,
        },
        {
          title: "Specialist agents and skill evolution",
          context:
            "Different users or product lines want purpose-built agents—models, tools, and prompts differ—and skill packs need ongoing fixes to docs, scripts, and behavior as the business moves.",
          flow:
            "In governance-style scenarios, create or update dedicated agent profiles from intent: model choice, tool groups and allowlists, which extensions may attach, and so on—each profile behaves like a specialist. Govern skills alongside them: enable or disable packs, revise SKILL content and sidecar assets, and reload changes so runtime wiring matches. Agent evolution keeps definitions and skill lifecycles in one operational surface.",
          outcomes: [
            "Specialist configs shrink the tool surface to what each lane actually needs",
            "Skills iterate under governance instead of drifting silently",
            "Repository docs spell out configuration and governance in depth",
          ],
          accent: "tertiary" as Accent,
        },
        {
          title: "Memory and internal assistants",
          context:
            "Internal answers must respect docs and API contracts, while long chats still need user-approved constraints pinned across turns—and the callable tool list must not balloon.",
          flow:
            "For internal copilots: tighten tool groups and allowlists, turn on web-style scenarios only when external lookup is intended, use governance scenarios when editing agents or schedules, and collect missing fields with clarification. For memory: persist anchors, preferences, and ticket handles with remember/recall. Keep hosted site knowledge indexes separate from JSONL runtime memory; pull external documents through extensions or web search under policy.",
          outcomes: [
            "Grounding quality follows your retrieval stack, extensions, and prompts",
            "Memory and hosted knowledge stay in separate lanes to avoid contradictions",
            "EvoPanel makes it easy to compare UI state with Gateway behavior",
          ],
          accent: "primary" as Accent,
        },
        {
          title: "Cross-system routines",
          context:
            "Monitoring, tickets, and repos each speak their own API. You want small retriable steps—fetch status, leave a note, run a script—and a replayable trace of what ran.",
          flow:
            "Switch to a planning-style scenario so the lead can track subtasks. Call your systems through the extensions you already expose or through bespoke HTTP tools. Stay read-only while diagnosing; move to a file-oriented scenario only when writes are intentional. Pin ticket IDs or conclusions with remember/recall.",
          outcomes: [
            "Gateway traces preserve ordering for postmortems",
            "Sensitive writes remain tied to your credentials and sandbox posture",
            "Vendor coverage is entirely configuration-driven",
          ],
          accent: "primary" as Accent,
        },
        {
          title: "Ops triage with parallel help",
          context:
            "Logs, metrics, and remote checks arrive in parallel. You want partial summaries merged on the lead path while risky commands stay fenced.",
          flow:
            "Delegate read-only pulls to child agents and let the lead merge results. Command-style workers appear only when your sandbox and registered subagents allow them. Concurrency caps come from runtime settings.",
          outcomes: [
            "Verbose output stays in child sessions; the lead keeps the narrative",
            "Retry failed slices without replaying the whole chat when tasks are split cleanly",
            "Paging and CMDB hooks still ride the extensions you configure",
          ],
          accent: "secondary" as Accent,
        },
      ],
    },
    evolutionPulse: {
      eyebrow: "Roadmap",
      title: "Milestones across EvoFlow",
      events: [
        {
          date: "BASE",
          title: "DeerFlow 2.0 baseline: multi-package layout and orchestration core",
          accent: "primary" as Accent,
          offset: "8%",
        },
        {
          date: "RUN",
          title: "Recoverable long runs and Supervisor-led multi-agent collaboration",
          accent: "primary" as Accent,
          offset: "24%",
        },
        {
          date: "SHAPE",
          title: "Scenarios & phases; progressive tools plus skill / MCP marketplaces",
          accent: "tertiary" as Accent,
          offset: "40%",
        },
        {
          date: "STATE",
          title: "Mission state, memory, and snapshot handoffs",
          accent: "secondary" as Accent,
          offset: "54%",
        },
        {
          date: "DEV",
          title: "Claude Code · Trae dev integrations",
          accent: "secondary" as Accent,
          offset: "71%",
        },
        {
          date: "SHIP",
          title: "EvoPanel desktop client",
          accent: "tertiary" as Accent,
          offset: "88%",
        },
      ],
    },
    closingNote: "Thanks for your support—and thanks for reading.",
  },
};

export const homeContent = homeContentByLocale[defaultLocale];

export function getHomeContent(locale: SiteLocale) {
  return homeContentByLocale[locale];
}
