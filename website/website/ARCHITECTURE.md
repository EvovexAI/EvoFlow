# AI Site — 系统架构与开发手册

> 本文档面向开发者，详细说明系统架构、技术实现方案、各模块设计细节与开发规范。
> 与 [CUSTOMIZATION.md](./CUSTOMIZATION.md)（个性化指南）互补。

---

## 目录

1. [系统架构总览](#1-系统架构总览)
2. [Monorepo 结构](#2-monorepo-结构)
3. [核心技术栈](#3-核心技术栈)
4. [AI 系统架构](#4-ai-系统架构)
5. [数据层架构](#5-数据层架构)
6. [前端架构](#6-前端架构)
7. [设计系统](#7-设计系统)
8. [实时交互系统](#8-实时交互系统)
9. [WebGPU 粒子系统](#9-webgpu-粒子系统)
10. [安全体系](#10-安全体系)
11. [可观测性](#11-可观测性)
12. [后台任务系统](#12-后台任务系统)
13. [国际化](#13-国际化)
14. [性能优化](#14-性能优化)
15. [开发规范](#15-开发规范)

---

## 1. 系统架构总览

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Client (Browser)                             │
│  React 19 CSR Islands  │  WebGPU / Canvas 2D  │  SSE Streams       │
└────────────────────────────┬────────────────────────────────────────┘
                             │ HTTPS
┌────────────────────────────▼────────────────────────────────────────┐
│                     Nginx (SSL Termination)                         │
│  yoursite.example.com:443 → localhost:3002  │  SSE proxy_buffering off     │
└────────────────────────────┬────────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────────┐
│                     Next.js 16 (App Router)                         │
│                                                                     │
│  ┌─── Presentation ───┐  ┌─── API / BFF ───┐  ┌─── AI Runtime ──┐ │
│  │ RSC + Client Islands│  │ Route Handlers  │  │ AI SDK 6       │ │
│  │ Layouts / Pages     │  │ Server Actions  │  │ Tool Calling   │ │
│  │ View Transitions    │  │ Rate Limiting   │  │ Streaming      │ │
│  └─────────────────────┘  └─────────────────┘  └────────────────┘ │
│                                                                     │
│  ┌─── Design System ──┐  ┌─── Content ─────┐  ┌─── Observability┐ │
│  │ Tokens/Primitives   │  │ Typed schemas   │  │ LLM runs       │ │
│  │ Composites/Motion   │  │ i18n (zh/en)    │  │ Tool calls     │ │
│  │ Glass/Glow/Signal   │  │ Projects/TL     │  │ Visitor tracks │ │
│  └─────────────────────┘  └─────────────────┘  └────────────────┘ │
└────────────────────────────┬────────────────────────────────────────┘
                             │
        ┌────────────────────┼────────────────────┐
        ▼                    ▼                    ▼
┌──────────────┐  ┌──────────────────┐  ┌─────────────────────┐
│  PostgreSQL  │  │  Worker Process  │  │  External APIs      │
│  + pgvector  │  │  (PM2 managed)   │  │  OpenAI GPT-5       │
│              │  │  GitHub Sync     │  │  Anthropic Claude    │
│  knowledge   │  │  Blog Sync       │  │  GitHub API         │
│  observ.     │  │  Coding DNA      │  │  text-embedding-3   │
│  evolution   │  │  Weekly Digest   │  │                     │
└──────────────┘  └──────────────────┘  └─────────────────────┘
```

**核心设计原则：**

- **AI-first**：AI 不是附加功能，是整站的核心驱动力
- **自部署**：不依赖 Vercel 平台，全部运行在自有 ECS
- **类型安全**：端到端 TypeScript strict，Zod schema 校验所有 I/O 边界
- **渐进降级**：WebGPU → Canvas 2D fallback；DB → JSON file fallback；Desktop → Mobile 降级

---

## 2. Monorepo 结构

使用 **pnpm workspaces + Turborepo** 管理，严格划分职责边界：

```
ai-site/
├── apps/
│   ├── web/                     # Next.js 16 主应用
│   │   ├── src/
│   │   │   ├── app/             # App Router (pages, layouts, API routes)
│   │   │   ├── components/      # UI 组件
│   │   │   ├── hooks/           # 自定义 Hooks
│   │   │   ├── lib/             # 工具库 (auth, rate-limit, AI runtime)
│   │   │   ├── middleware.ts    # Auth middleware
│   │   │   └── instrumentation.ts  # 全局 fetch proxy 设置
│   │   ├── next.config.ts
│   │   └── package.json
│   └── worker/                  # 后台任务进程
│       ├── src/
│       │   ├── index.ts         # 入口，cron 调度
│       │   └── jobs/            # 各任务实现
│       └── tsup.config.ts       # 构建配置
├── packages/
│   ├── ai/                      # @ai-site/ai — AI 核心层
│   │   ├── agents/              # Agent 定义 (site-agent, mission)
│   │   ├── ai-ui/               # UI Actions + Artifacts 注册与 schema
│   │   ├── arena/               # 模型竞技场逻辑
│   │   ├── chat/                # Chat schema, demo-chat 构建器
│   │   ├── evolution/           # 进化系统
│   │   ├── jobs/                # Job schema 与 runner
│   │   ├── knowledge/           # 知识库 ingestion
│   │   ├── memory/              # Session memory
│   │   ├── prompts/             # Persona prompt
│   │   ├── providers/           # 模型 provider 配置
│   │   ├── sources/             # GitHub / Blog 数据源
│   │   ├── tools/               # Tool registry
│   │   └── workflows/           # Workflow schema + demo
│   ├── db/                      # @ai-site/db — 数据访问层
│   │   ├── client.ts            # PostgreSQL 连接 + 自动 schema 迁移
│   │   ├── schema/              # DDL (CREATE IF NOT EXISTS)
│   │   └── repos/               # Repository 抽象 (DB + File 双后端)
│   ├── ui/                      # @ai-site/ui — 设计系统
│   │   ├── tokens/              # 色彩 / accent 定义
│   │   ├── primitives/          # GlassPanel, GlowButton, HeroTitle, SignalLine
│   │   └── composites/          # PortalCard, FeatureCard, TimelineRail, etc.
│   ├── content/                 # @ai-site/content — 内容数据层
│   │   ├── home.ts              # 首页内容 (zh/en)
│   │   ├── about.ts             # About 页内容
│   │   ├── projects.ts          # 项目数据
│   │   ├── timeline.ts          # 时间轴数据
│   │   └── locale.ts            # 多语言 schema
│   ├── observability/           # @ai-site/observability — 可观测性
│   │   └── types + logic        # LLM runs, tool calls, sessions
│   └── config/                  # @ai-site/config — 共享配置
│       └── tsconfig/base.json   # TypeScript strict base
├── turbo.json                   # Pipeline: dev/build/lint/typecheck
├── pnpm-workspace.yaml
└── package.json                 # Root scripts
```

### 包间依赖关系

```
apps/web ──→ @ai-site/ai ──→ @ai-site/content
         ──→ @ai-site/db     @ai-site/db
         ──→ @ai-site/ui
         ──→ @ai-site/content
         ──→ @ai-site/observability

apps/worker ──→ @ai-site/ai
            ──→ @ai-site/db
            ──→ @ai-site/content
            ──→ @ai-site/observability
```

### Turborepo Pipeline

```json
{
  "dev":       { "cache": false, "persistent": true },
  "build":     { "outputs": [".next/**", "dist/**"] },
  "lint":      {},
  "typecheck": {},
  "clean":     { "cache": false }
}
```

---

## 3. 核心技术栈

### 3.1 Framework 层

| 技术 | 版本 | 用途 |
|------|------|------|
| **Next.js** | 16.2 | App Router, RSC, Server Actions, Route Handlers |
| **React** | 19.2 | Server Components, `use()`, Suspense |
| **TypeScript** | 5.x | strict mode, 端到端类型安全 |
| **Tailwind CSS** | 4.x | CSS-first 配置，原生 CSS 变量，`@theme inline` |
| **Motion** | 12.38+ | 页面转场、磁性效果、stagger 动画 |

### 3.2 AI 层

| 技术 | 版本 | 用途 |
|------|------|------|
| **AI SDK** | 6.0+ | `streamText`, `tool()`, `stepCountIs`, `generateText` |
| **@ai-sdk/openai** | 3.0+ | OpenAI provider (GPT-5, GPT-5-mini) |
| **@ai-sdk/anthropic** | 3.0+ | Anthropic provider (Claude Sonnet) |
| **Zod** | 4.x | Tool schema, request/response 校验 |
| **pgvector** | — | 1536 维向量索引，RAG 知识检索 |
| **text-embedding-3-large** | — | OpenAI Embedding 模型 |

### 3.3 UI 层

| 技术 | 用途 |
|------|------|
| **@xyflow/react** | Workflow Studio 可视化编辑器 |
| **cmdk** | 全局 AI 命令面板 (⌘K) |
| **Shiki** | 代码语法高亮 |
| **Lucide React** | 一致的图标体系 |
| **react-markdown + remark-gfm** | Markdown 渲染 |
| **@radix-ui/react-dialog** | 无障碍弹窗 |
| **next-themes** | 暗/亮/系统主题切换 |

### 3.4 基础设施

| 组件 | 方案 |
|------|------|
| 服务器 | 阿里云 ECS |
| 进程管理 | PM2 (web + worker) |
| 反向代理 | Nginx + SSL (Let's Encrypt) |
| 数据库 | PostgreSQL 16 + pgvector |
| 包管理 | pnpm 10 + Turborepo |
| Node.js | 22 LTS |

---

## 4. AI 系统架构

### 4.1 分层架构

```
Layer 1: Model Layer
├── OpenAI GPT-5 / GPT-5-mini
├── Anthropic Claude Sonnet
└── text-embedding-3-large

Layer 2: Agent Core (AI SDK 6)
├── streamText — 流式文本生成
├── tool() — 工具定义与调用
├── stepCountIs — 多步推理控制
└── generateText — 单次生成

Layer 3: Application Agents
├── Site Agent — 核心人格，融合知识库
├── Intent Agent — 意图分类路由
├── Arena Agent — 模型对比
└── Workflow Agent — 流程编排

Layer 4: Capabilities
├── RAG Pipeline — 向量检索 + 生成
├── Tool Calling — 导航 / 主题 / 展示
├── Artifacts — 结构化富 UI 输出
├── UI Actions — AI 控 UI 协议
└── Generative UI — AI 触发前端交互
```

### 4.2 Chat 流程详解

```
用户输入 (text/image)
       │
       ▼
┌──────────────┐
│ /api/chat    │  Zod 校验 → 速率限制 → 消息清洗
│ route.ts     │
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ 意图检测      │  CAREER_KEYWORDS → 注入时间线/项目数据
│              │  latestUserMessage → resolveTopic
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ RAG 检索      │  retrieveKnowledge()
│ pgvector     │  → text-embedding-3-large → 向量相似度 → top-k snippets
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ System Prompt│  personaPrompt + 知识上下文 + 工具指引 + 安全规则
│ 构建         │
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ streamText() │  AI SDK 流式生成
│ + tools      │  4 个 tool: navigateTo, toggleTheme, showSkills, showProjects
│              │  stopWhen: stepCountIs(2)
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ NDJSON Stream│  text-delta / tool-result / ui_action / artifacts / meta
│ 输出         │
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ 前端消费      │  ReactMarkdown 渲染 + UiActionCards + CollapsibleArtifacts
│ chat-page    │
└──────────────┘
```

### 4.3 Tool Calling 实现

在 `/api/chat/route.ts` 中定义 4 个 AI SDK tools：

| Tool | Schema (Zod) | 行为 |
|------|-------------|------|
| `navigateTo` | `{ route: enum(13 routes) }` | 前端自动 `router.push`，1.5s 延迟 |
| `toggleTheme` | `{ theme: "light" \| "dark" \| "system" }` | 前端调用 `setTheme()` |
| `showSkills` | `{ filter?: "Frontend" \| "Backend" \| ... }` | 渲染技术栈进度条卡片 |
| `showProjects` | `{ keyword?: string }` | 渲染项目卡片网格 |

工具结果通过 NDJSON `ui_action` 事件传输到前端，由 `UiActionCards` 组件渲染。

### 4.4 Artifacts 系统

AI 可生成结构化富内容，前端通过 `artifact-renderer.tsx` 渲染：

- **Execution Review** — 代码审查面板
- **Knowledge Signal Radar** — 知识信号雷达图
- **Project Timeline** — 项目时间线
- **Tech Radar** — 技术雷达

Artifacts 由 `@ai-site/ai` 的 `createArtifact()` + `buildChatArtifacts()` 构建，schema 驱动。

### 4.5 Model Arena

`/api/arena` 同时向 GPT-5 和 Claude 发送同一问题，流式并排输出：

```typescript
// 伪代码
const [gptStream, claudeStream] = await Promise.all([
  streamText({ model: openai("gpt-5"), ... }),
  streamText({ model: anthropic("claude-sonnet"), ... }),
]);
// 合并为交替 NDJSON 输出
```

前端左右分栏展示，实时对比响应速度和内容质量。

### 4.6 RAG Knowledge Pipeline

```
数据源                    处理                    存储
┌────────────────┐   ┌───────────────┐   ┌──────────────────┐
│ GitHub repos   │──→│ 分块 (chunk)   │──→│ PostgreSQL       │
│ Blog articles  │   │ Embedding      │   │ + pgvector       │
│ Personal data  │   │ text-embed-3   │   │ 1536d IVFFlat    │
│ Timeline       │   │ -large         │   │ knowledge_chunks │
└────────────────┘   └───────────────┘   └──────────────────┘
                                                │
                                                ▼
                                         cosine similarity
                                         top-k retrieval
                                                │
                                                ▼
                                         注入 system prompt
                                         → LLM 生成回答
```

Knowledge ingestion 通过 `/api/knowledge/ingest` 触发，需 `x-admin-secret` 鉴权。
Worker 进程定时同步 GitHub 和 Blog 内容。

---

## 5. 数据层架构

### 5.1 双后端策略

`@ai-site/db` 采用 Repository 模式 + 接口抽象，每个 repo 有 DB 和 File 两种实现：

```
repos/
├── knowledge-chunks.ts          # pgvector 知识库 (DB only)
├── observability-runtime.ts     # 统一入口
│   ├── runtime-observability-db.ts
│   └── runtime-observability-file.ts
├── source-records.ts            # 数据源记录
│   ├── source-records-db.ts
│   └── source-records-file.ts
├── job-runs.ts                  # 任务执行记录
│   ├── job-runs-db.ts
│   └── job-runs-file.ts
└── evolution-runs.ts            # 进化记录
    ├── evolution-runs-db.ts
    └── evolution-runs-file.ts
```

当 `DATABASE_URL` 为空时，自动降级到 `.runtime/*.json` 文件持久化。

### 5.2 数据库 Schema

Schema 在应用启动时通过 `ensureDatabaseSchema()` 自动迁移（`CREATE TABLE IF NOT EXISTS`），无需手动建表。

主要表：

| 表名 | 用途 |
|------|------|
| `knowledge_chunks` | RAG 知识块，含 `embedding vector(1536)` |
| `observability_runs` | LLM 调用记录 |
| `source_sync_state` | 数据源同步状态 |
| `source_records` | 同步的数据源内容 |
| `job_runs` | Worker 任务执行记录 |
| `evolution_runs` | 进化系统运行记录 |

### 5.3 数据库连接管理

```typescript
// packages/db/src/client.ts
const sql = postgres(config.url, {
  connect_timeout: 5,
  idle_timeout: 5,
  max: 1,           // 单连接，适合个人站点
  prepare: false,    // 兼容 pgBouncer
});
```

使用 `withDatabase()` 包装器，自动处理连接不可用的降级。

---

## 6. 前端架构

### 6.1 路由设计

```
/                           首页 (homepage.tsx)
├── /(marketing)/
│   ├── /about              关于页面
│   └── /evolution          进化时间线
├── /ai/
│   ├── /ai/chat            AI 对话 (chat-page.tsx)
│   ├── /ai/agent           Agent 任务控制台
│   ├── /ai/workflow        Workflow Studio (React Flow)
│   ├── /ai/knowledge       RAG 知识库浏览器
│   ├── /ai/arena           模型竞技场
│   ├── /ai/mcp             MCP 工具编排
│   └── /ai/os              Agent OS 控制台
├── /lab/                   实验室
│   └── /lab/[slug]         动态实验页面
├── /terminal               终端界面
├── /admin/                 管理后台 (需认证)
│   ├── /admin/login
│   ├── /admin/evolution
│   ├── /admin/jobs
│   └── /admin/observability
└── /api/                   15 个 API 端点
```

### 6.2 全局 Layout

```
RootLayout (layout.tsx)
├── <html> + 字体变量 (Space Grotesk, Manrope, Inter, Noto Sans SC)
├── <body>
│   ├── JSON-LD 结构化数据
│   ├── Providers (ThemeProvider, LocaleProvider, CommandPaletteProvider)
│   ├── SiteBackground (固定层: aurora + grid + orbs + particles + constellation)
│   ├── <div.relative> (主内容)
│   │   ├── SiteHeader (glass morphism, 沉浸式/默认两种变体)
│   │   ├── {children} (页面内容)
│   │   └── SiteFooter
│   └── LiveCursors (z-9999, pointer-events-none)
```

### 6.3 页面转场

使用 Next.js `experimental.viewTransition` + `template.tsx` 中的 `AnimatePresence` (Motion)：

```typescript
// app/template.tsx
<AnimatePresence mode="wait">
  <motion.div
    initial={{ opacity: 0, y: 8 }}
    animate={{ opacity: 1, y: 0 }}
    exit={{ opacity: 0, y: -8 }}
  >
    {children}
  </motion.div>
</AnimatePresence>
```

### 6.4 Command Palette

`⌘K` / `Ctrl+K` 触发，基于 cmdk 构建，支持三种模式：

| 模式 | 触发 | 功能 |
|------|------|------|
| **Default** | 直接打开 | 页面导航、快捷操作、外部链接 |
| **AI Chat** | 输入 `>` 或点击 AI 按钮 | 内联 AI 对话，支持 Generative UI |
| **Terminal** | 输入 `$` | 终端风格交互 |

```
site-command-palette.tsx
├── 响应式高度 h-[min(480px, calc(100vh-4rem))]
├── 三模式切换 (default / ai / terminal)
├── AI 模式: 复用 demo-chat API
└── 结果渲染: 页面/操作/链接/AI 回复
```

---

## 7. 设计系统

### 7.1 三层架构

```
@ai-site/ui
├── tokens/           Design Tokens
│   └── accents.ts    AccentTone 类型 (primary / secondary / tertiary)
├── primitives/       原语组件
│   ├── glass-panel.tsx    毛玻璃面板
│   ├── glow-button.tsx    发光按钮 (primary / ghost 变体)
│   ├── hero-title.tsx     Hero 标题 (clamp 响应式)
│   ├── signal-line.tsx    信号线装饰
│   ├── surface-card.tsx   表面卡片
│   └── status-chip.tsx    状态标签
└── composites/       复合组件
    ├── portal-card.tsx       门户卡片 (背景图 + 渐变叠加)
    ├── feature-card.tsx      功能卡片
    ├── timeline-rail.tsx     时间线轨道
    ├── terminal-panel.tsx    终端面板
    ├── section-heading.tsx   章节标题
    └── prompt-panel.tsx      提示面板
```

### 7.2 主题系统

基于 `next-themes` + CSS 变量，支持 `dark` / `light` / `system`：

```css
/* globals.css */
@theme inline {
  --color-background: oklch(0.13 0.02 280);
  --color-foreground: oklch(0.95 0.01 280);
  --color-primary: oklch(0.78 0.13 295);
  /* ... 完整 token 体系 */
}

.light {
  --color-background: oklch(0.98 0.005 280);
  --color-foreground: oklch(0.15 0.02 280);
  --color-primary: oklch(0.55 0.22 295);
}
```

### 7.3 动画系统

| 技术 | 场景 |
|------|------|
| **Motion (Framer)** | 磁性效果 (`MagneticWrap`)、stagger 动画 (`StaggerGroup/Item`)、页面转场 (`AnimatePresence`) |
| **CSS Scroll-Driven** | `.scroll-reveal` / `.scroll-reveal-slow` — `animation-timeline: view()` 渐进增强 |
| **CSS @keyframes** | 背景 orb 浮动、粒子脉冲、时间线动画 |
| **Web Audio API** | UI 交互音效 (OscillatorNode + GainNode)，`useSound` hook |

### 7.4 全站背景系统

5 层固定背景叠加（`site-background.tsx`）：

```
Layer 0: Aurora gradient wash      — CSS radial-gradient
Layer 1: Neural dot grid           — CSS repeating pattern, opacity 0.07
Layer 2: Floating gradient orbs    — 3 个 CSS 动画 orb (35s/42s/50s cycles)
Layer 3: WebGPU particle field     — GPU 加速粒子流体 (桌面 1200 / 移动 300 粒子)
Layer 4: Constellation canvas      — Canvas 2D 星座连线 + 鼠标拖尾 (仅桌面)
```

---

## 8. 实时交互系统

### 8.1 匿名多人光标 (Live Cursors)

Figma 风格的实时协作光标：

```
浏览器 A                    服务器                    浏览器 B
    │                         │                         │
    ├── mousemove ──POST──→  │  in-memory Map           │
    │   (throttle 60ms)      │  max 500 cursors         │
    │                         │                         │
    │  ←──── SSE stream ─────┤──── SSE stream ────→    │
    │   (JSON 数组, 1s间隔)    │                         │
    │                         │                         │
    └── LERP 插值渲染 ────────│────── LERP 插值渲染 ──→ │
        (rAF, factor 0.18)   │                         │
```

**移动端降级**：触摸设备 (`pointer: coarse`) 跳过 SSE 连接和 rAF 循环。

### 8.2 访客实时计数

```
/api/visitors (GET)  → SSE stream (每秒推送在线人数 + AI 对话次数)
/api/visitors (POST) → heartbeat (visitorId + 60s 过期)
                     → chat 计数 (action: "chat")
```

内存存储，最多 5000 活跃访客，自动清理过期记录。

---

## 9. WebGPU 粒子系统

### 9.1 架构

```
particle-field.tsx
├── WebGPU 路径 (优先)
│   ├── WGSL Compute Shader — 粒子物理更新 (流场 + 鼠标交互)
│   ├── WGSL Vertex/Fragment Shader — 渲染 (instanced quads, additive blend)
│   └── GPU Buffers — particle buffer (32 bytes/particle), uniform buffers
└── Canvas 2D Fallback
    ├── JavaScript 粒子物理
    ├── 连线绘制 (距离阈值)
    └── 鼠标排斥力
```

### 9.2 WGSL Compute Shader 核心逻辑

```wgsl
// 有机流场 (curl noise 近似)
let angle = sin(px) * cos(py) * 3.14159 + sin(px * 0.7 + py * 1.3) * 1.5;
let flowForce = vec2f(cos(angle), sin(angle)) * 0.00015;

// 鼠标排斥交互
if (params.mouseActive > 0.5) {
    let toMouse = p.pos - vec2f(params.mouseX, params.mouseY);
    let dist = length(toMouse);
    if (dist < params.mouseRadius) {
        let repel = normalize(toMouse) * params.mouseStrength / max(dist * dist, 0.001);
        p.vel += repel;
    }
}
```

### 9.3 性能考量

| 平台 | 粒子数 | 渲染方式 |
|------|--------|---------|
| 桌面 (WebGPU) | 1200 | GPU compute + render pipeline |
| 桌面 (fallback) | 1200 | Canvas 2D |
| 移动端 | 300 | Canvas 2D (WebGPU 通常不支持) |
| `prefers-reduced-motion` | — | 跳过动画 |

---

## 10. 安全体系

### 10.1 认证

**Admin 面板认证流程：**

```
/admin/login → Server Action → HMAC-SHA256 签名 → HTTP-only Cookie → Middleware 校验
```

- 密码比较使用 **constant-time comparison** 防止 timing attack
- Cookie 使用 Web Crypto API 的 HMAC-SHA256 签名
- Middleware 拦截所有 `/admin` 路由（`/admin/login` 除外）

### 10.2 速率限制

所有 API 路由均应用内存级 IP 速率限制：

```typescript
// lib/rate-limit.ts
checkRateLimit(request, routeKey, { windowMs, maxRequests })
```

| 路由 | 窗口 | 最大请求 |
|------|------|---------|
| `/api/chat` | 60s | 20 |
| `/api/cursors` | 10s | 200 |
| `/api/visitors` | 60s | 60 |
| `/api/observability` | 60s | 30 (GET), 10 (POST, admin only) |
| `/api/coding-dna` | 60s | 10 |
| `/api/agent/sessions` | 60s | 20 |

### 10.3 内存容量限制

| 存储 | 上限 | 清理策略 |
|------|------|---------|
| Cursors Map | 500 | 60s 过期 + 超容清理 |
| Visitors Map | 5000 | 自动过期 |
| Rate Limit Map | — | 60s 定期清理 |

### 10.4 输入清洗

`/lib/input-sanitize.ts` 对所有用户输入执行：

- XSS 标签过滤
- 长度限制 (8000 字符 / 消息)
- 图片 Base64 大小限制 (10MB)
- 消息数量限制 (50 条/请求)

### 10.5 知识库 Ingestion 鉴权

`/api/knowledge/ingest` 使用 `x-admin-secret` header + constant-time XOR 比较：

```typescript
let mismatch = 0;
for (let i = 0; i < secret.length; i++) {
  mismatch |= header.charCodeAt(i) ^ secret.charCodeAt(i);
}
return mismatch === 0;
```

---

## 11. 可观测性

### 11.1 追踪维度

| 维度 | 数据 |
|------|------|
| **LLM Runs** | 模型名、输入/输出摘要、token 用量、延迟、状态 |
| **Tool Calls** | 工具名、参数、执行结果 |
| **UI Actions** | AI 触发的 UI 操作类型和参数 |
| **Visitor Sessions** | 在线人数、AI 对话次数、页面路径 |
| **Job Runs** | Worker 任务执行历史、状态、耗时 |
| **Evolution Runs** | 进化系统运行记录 |

### 11.2 Admin 面板

`/admin/observability` — 查看 LLM 调用记录、工具调用、性能指标。

`/admin/jobs` — 查看和触发后台任务。

`/admin/evolution` — 查看进化系统运行历史。

---

## 12. 后台任务系统

### 12.1 Worker 架构

`apps/worker` 作为独立进程运行，通过 cron 调度任务：

| 任务 | Cron | 功能 |
|------|------|------|
| GitHub Sync | `*/30 * * * *` | 同步 GitHub repos、commits、stars |
| Blog Sync | `0 */6 * * *` | 扫描博客目录，更新知识库 |
| Weekly Digest | `0 9 * * 1` | 生成周报摘要 |
| Coding DNA | 随 GitHub Sync | 更新语言分布、活跃度统计 |
| Knowledge Ingest | 手动/API 触发 | 全量重建知识库向量 |

### 12.2 设计原则

- **生成与展示分离**：Worker 写入 DB/文件，Web 只读取
- **幂等性**：每个任务可安全重复执行
- **独立进程**：不阻塞用户请求链路

---

## 13. 国际化

### 13.1 实现方案

使用 cookie-based locale 切换，不走 URL 路径分段：

```
Cookie: site-locale=zh|en
```

- `@ai-site/content` 每个模块导出双语内容 (`zh` / `en`)
- `useLocalizedValue(zhContent, enContent)` hook 根据当前 locale 返回
- `data-locale` 属性挂在 `<html>` 上
- 404 / Error 页面独立双语

### 13.2 内容层

```typescript
// packages/content/src/home.ts
export function getHomeContent(locale: "zh" | "en"): HomeContent {
  return locale === "zh" ? zhContent : enContent;
}
```

所有页面级内容集中在 `@ai-site/content` 管理，前端组件只消费 typed data。

---

## 14. 性能优化

### 14.1 前端

| 优化 | 实现 |
|------|------|
| **动态导入** | `react-markdown`, `shiki`, `ConstellationCanvas`, `ParticleField` 均 `dynamic()` |
| **SSR/RSC** | 页面级数据获取走 Server Components |
| **移动端降级** | `useIsMobile()` hook → 减少粒子数、跳过星座连线、禁用 Live Cursors |
| **prefers-reduced-motion** | CSS 动画减弱、跳过粒子效果 |
| **字体优化** | `next/font/google` 预加载 4 种字体 |
| **图片** | Next.js `Image` 组件自动优化 |

### 14.2 网络

| 优化 | 实现 |
|------|------|
| **Nginx Gzip** | 文本资源压缩 |
| **静态资源长缓存** | `/_next/static/` immutable, 1 year |
| **SSE 禁缓冲** | `/api/*` 路由 `proxy_buffering off` |

### 14.3 服务端

| 优化 | 实现 |
|------|------|
| **代理加速** | `instrumentation.ts` 全局 `undici ProxyAgent` (中国服务器访问 OpenAI) |
| **DB 连接池** | 单连接 + idle timeout 5s |
| **内存限制** | 各 in-memory store 设容量上限 |

---

## 15. 开发规范

### 15.1 代码风格

- **TypeScript strict**：所有 package 继承 `@ai-site/config` base config
- **ESLint**：`eslint-config-next` (core-web-vitals + TypeScript)
- **Prettier**：统一格式化
- **无冗余注释**：不写 `// 导入模块` 类注释，仅注释非显而易见的逻辑

### 15.2 Git 规范

提交消息格式：

```
<type>: <description>

type = feat | fix | refactor | style | perf | docs | chore | test
```

### 15.3 新增功能流程

1. 在 `@ai-site/content` 添加双语内容
2. 在 `@ai-site/ai` (如需) 添加 AI 相关 schema / agent / tool
3. 在 `@ai-site/ui` (如需) 创建设计系统组件
4. 在 `apps/web` 实现页面和 API 路由
5. 添加速率限制和输入校验
6. 更新 `MEMORY.md`

### 15.4 常用命令

```bash
pnpm dev              # 启动所有应用
pnpm dev:web          # 仅启动 web
pnpm dev:worker       # 仅启动 worker
pnpm build            # 构建所有包 + 应用
pnpm typecheck        # TypeScript 类型检查
pnpm lint             # ESLint 检查
pnpm clean            # 清理构建产物
pnpm format           # Prettier 格式化
```

### 15.5 环境变量

详见 [`.env.example`](./.env.example)，核心变量：

| 变量 | 说明 |
|------|------|
| `OPENAI_API_KEY` | OpenAI API 密钥 |
| `OPENAI_CHAT_MODEL` | 主模型 (默认 gpt-5) |
| `DATABASE_URL` | PostgreSQL 连接串 (空 = JSON 文件降级) |
| `ADMIN_BASIC_AUTH_PASSWORD` | Admin 面板密码 |
| `GITHUB_ACCOUNT_USERNAME` | GitHub 用户名 (Coding DNA) |

---

## 附录：文档索引

| 文档 | 内容 |
|------|------|
| [README.md](./README.md) | 项目简介、快速开始、功能列表 |
| **ARCHITECTURE.md** (本文) | 系统架构、技术实现方案、开发规范 |
| [CUSTOMIZATION.md](./CUSTOMIZATION.md) | 个性化定制指南：内容替换、主题配置、功能裁剪 |
| [LICENSE](./LICENSE) | MIT 开源协议 |
