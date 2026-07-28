# EvoFlow 官网 — 技术架构与开发手册

> 本文档面向开发者，说明 **EvoFlow 官网**（`website/`）的系统架构、技术栈、目录结构、开发流程与部署方式。
> 与 [CUSTOMIZATION.md](./CUSTOMIZATION.md)（内容与风格定制指南）及 [README.md](./README.md)（用户快速上手）互补。

---

## 1. 项目定位

本目录是 **EvoFlow 产品官网**，不是个人 AI 模板网站。官网的目标是：

- 展示 EvoFlow 产品能力矩阵、典型场景与演进路线
- 提供产品文档（侧栏 `/docs/` 导航）
- 提供产品演示（`/showcase/`）
- 集成 AI 交互 Demo（Arena、Chat、Workflow 等页面的骨架与模拟数据）
- 引导用户下载、安装与部署

官网采用 **静态导出（Static Export）**，部署到 **火山引擎 TOS** 对象存储，通过 CDN 分发。

---

## 2. 系统架构总览

```
┌──────────────────────────────────────────────────────────────┐
│                     Client (Browser)                          │
│  React 19 CSR Islands  │  Canvas 2D  │  Motion Animations   │
└──────────────────────────────┬────────────────────────────────┘
                               │ HTTPS (CDN)
┌──────────────────────────────▼────────────────────────────────┐
│             火山引擎 TOS (对象存储 + CDN)                       │
│  静态文件: HTML, JS, CSS, 图片, 字体                           │
│  Content-Disposition: inline  (保证 HTML 不触发下载)           │
└──────────────────────────────┬────────────────────────────────┘
                               │
┌──────────────────────────────▼────────────────────────────────┐
│                     Next.js 16 (Static Export)                 │
│                                                               │
│  ┌─── Presentation ───┐  ┌─── Content ─────┐  ┌─── AI Demo ─┐│
│  │ RSC + Client Islands│  │ Typed schemas   │  │ Chat warp   ││
│  │ Pages / Layouts     │  │ i18n (zh/en)    │  │ Arena mock  ││
│  │ View Transitions    │  │ Docs catalog    │  │ Artifacts   ││
│  └─────────────────────┘  └────────────────┘  └─────────────┘│
│                                                               │
│  ┌─── Design System ──┐  ┌─── Platform ────┐                  │
│  │ Tokens/Primitives   │  │ Admin pages     │                  │
│  │ Composites/Motion   │  │ Lab pages       │                  │
│  │ Glass/Glow/Signal   │  │ Showcase pages  │                  │
│  └─────────────────────┘  └────────────────┘                  │
└───────────────────────────────────────────────────────────────┘
```

**核心设计原则：**

- **静态导出**：`next build` 输出纯静态 HTML + JS + CSS，无运行时服务端依赖
- **类型安全**：端到端 TypeScript strict，Zod schema 校验数据边界
- **渐进降级**：Canvas 2D fallback（WebGPU 粒子仅用于演示）、Desktop → Mobile 降级
- **i18n 内置**：Cookie 驱动的中/英双语，内容层统一管理
- **演示数据与真实数据分离**：`packages/ai/` 中的 demo 数据仅用于骨架页面展示

---

## 3. Monorepo 结构

使用 **pnpm workspaces + Turborepo** 管理：

```
website/
├── apps/
│   └── web/                     # Next.js 16 主应用
│       ├── src/
│       │   ├── app/             # App Router (pages, layouts)
│       │   │   ├── (marketing)/ # 营销页分组 (about, docs, evolution, showcase)
│       │   │   ├── admin/       # 管理后台 (client-side only)
│       │   │   ├── lab/         # 实验页
│       │   │   ├── resume/      # 简历页
│       │   │   ├── terminal/    # 终端模拟页
│       │   │   └── r/           # 重定向页面
│       │   ├── components/      # UI 组件 (home, docs, ai-ui, showcase, etc.)
│       │   ├── hooks/           # 自定义 Hooks
│       │   ├── lib/             # 工具库 (auth, rate-limit, i18n, shiki)
│       │   └── instrumentation.ts
│       ├── next.config.ts
│       ├── scripts/             # 构建脚本
│       └── package.json
├── packages/
│   ├── ai/                      # @ai-site/ai — AI Demo 层
│   │   ├── src/agents/          # Agent 定义 (site-agent, mission)
│   │   ├── src/ai-ui/           # UI Actions + Artifacts
│   │   ├── src/arena/           # 模型竞技场逻辑
│   │   ├── src/chat/            # Chat schema, demo-chat 构建器
│   │   ├── src/evolution/       # 进化系统
│   │   ├── src/jobs/            # Job schema 与 runner
│   │   ├── src/knowledge/       # 知识库 ingestion
│   │   ├── src/memory/          # Session memory
│   │   ├── src/prompts/         # Persona prompt
│   │   ├── src/providers/       # 模型 provider 配置
│   │   ├── src/sources/         # GitHub / Blog 数据源
│   │   ├── src/tools/           # Tool registry
│   │   └── src/workflows/       # Workflow schema + demo
│   ├── content/                 # @ai-site/content — 站点内容数据层
│   │   ├── src/home.ts          # 首页内容 (zh/en)
│   │   ├── src/personal.ts      # 站点个人信息
│   │   ├── src/projects.ts      # 项目数据
│   │   ├── src/timeline.ts      # 时间轴数据
│   │   ├── src/site-copy.ts     # 品牌文案
│   │   ├── src/site-identity.ts # 域名、邮箱、发布主体
│   │   ├── src/site-links.ts    # 外部链接
│   │   ├── src/site-stats.ts    # 站点统计
│   │   ├── src/platform-pages.ts # 管理后台页面数据
│   │   ├── src/docs/catalog.ts  # 产品文档正文（zh/en 双语）
│   │   ├── src/locales.ts       # 多语言 schema
│   │   └── src/index.ts         # 统一导出
│   ├── ui/                      # @ai-site/ui — 设计系统
│   │   ├── src/tokens/          # 色彩 / accent 定义
│   │   ├── src/primitives/      # GlassPanel, GlowButton, HeroTitle, SignalLine
│   │   └── src/composites/      # FeatureCard, SectionHeading, TimelineRail, etc.
│   ├── observability/           # @ai-site/observability — 可观测性 Demo 数据
│   │   └── src/                 # LLM runs, tool calls, visitor sessions
│   ├── db/                      # @ai-site/db — 数据访问层 Demo
│   │   └── src/                 # Repository 模式, 文件持久化降级
│   └── config/                  # @ai-site/config — 共享 TypeScript 配置
│       └── tsconfig/base.json
├── scripts/                     # 根级脚本 (sync-docs-media, sync-presentations)
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

## 4. 核心技术栈

### 4.1 Framework 层

| 技术 | 版本 | 用途 |
|------|------|------|
| **Next.js** | 16.2 | App Router, RSC, Server Components, Static Export |
| **React** | 19.2 | Server Components, `use()`, Suspense |
| **TypeScript** | 5.x | strict mode, 端到端类型安全 |
| **Tailwind CSS** | 4.x | CSS-first 配置，`@theme inline` |
| **Motion (Framer)** | 12.38+ | 页面转场、磁性效果、stagger 动画 |

### 4.2 AI Demo 层

| 技术 | 版本 | 用途 |
|------|------|------|
| **AI SDK** | 6.0+ | `streamText`, `tool()`, `generateText` |
| **@ai-sdk/openai** | 3.0+ | OpenAI provider |
| **@ai-sdk/anthropic** | 3.0+ | Anthropic provider |
| **Zod** | 4.x | Tool schema, 数据校验 |
| **Shiki** | 4.x | 代码语法高亮 |

### 4.3 UI 层

| 技术 | 用途 |
|------|------|
| **cmdk** | 全局 AI 命令面板 (⌘K) |
| **Lucide React** | 一致的图标体系 |
| **react-markdown + remark-gfm** | Markdown 渲染 |
| **@radix-ui/react-dialog** | 无障碍弹窗 |
| **next-themes** | 暗/亮/系统主题切换 |
| **html2canvas + jspdf** | 简历导出 |
| **docx** | 简历 Word 导出 |

### 4.4 基础设施

| 组件 | 方案 |
|------|------|
| 部署目标 | 火山引擎 TOS（对象存储 + CDN） |
| 包管理 | pnpm 10 + Turborepo |
| Node.js | 22 LTS |

---

## 5. 路由设计

```
/                           首页 (homepage.tsx)
├── /(marketing)/
│   ├── /about              关于页面
│   ├── /docs               文档首页
│   ├── /docs/[...slug]     文档正文（从 catalog.ts 渲染）
│   ├── /evolution          演进时间线
│   └── /showcase           产品演示
├── /admin                  管理后台 (需认证)
│   ├── /admin/login        Admin 登录
│   ├── /admin/evolution    演进管理
│   ├── /admin/jobs         任务管理
│   └── /admin/observability 可观测性
├── /lab                    实验室
│   └── /lab/[slug]         动态实验页面
├── /r/[slug]               重定向页面
├── /resume                 简历
├── /terminal               终端界面
└── /api/                   无 API 路由（静态导出，不使用运行时 API）
```

**注意**：`/api/*` 路由**不存在**。页面数据全部来自 `packages/content/` 的静态 TypeScript 模块，在构建时或客户端直接读取。演示性 AI 对话（Arena、Chat）使用客户端模拟数据，不调用远程 API。

---

## 6. 全局 Layout

```
RootLayout (layout.tsx)
├── <html> + 字体变量 (Space Grotesk, Manrope, Inter, Noto Sans SC)
├── <body>
│   ├── JSON-LD 结构化数据
│   ├── Providers (ThemeProvider, LocaleProvider, CommandPaletteProvider)
│   ├── SiteBackground (固定层: aurora + grid + orbs + particles + constellation)
│   ├── <div.relative> (主内容)
│   │   ├── SiteHeader (glass morphism)
│   │   ├── {children} (页面内容)
│   │   └── SiteFooter
│   └── LiveCursors (z-9999, pointer-events-none)
```

---

## 7. 设计系统

### 7.1 三层架构

```
@ai-site/ui
├── tokens/           Design Tokens
│   ├── accents.ts    AccentTone 类型 (primary / secondary / tertiary)
│   └── colors.ts     色彩定义
├── primitives/       原语组件
│   ├── glass-panel.tsx    毛玻璃面板
│   ├── glow-button.tsx    发光按钮
│   ├── hero-title.tsx     Hero 标题
│   ├── signal-line.tsx    信号线装饰
│   ├── signal-pill.tsx    信号标签
│   ├── surface-card.tsx   表面卡片
│   └── status-chip.tsx    状态标签
└── composites/       复合组件
    ├── feature-card.tsx      功能卡片
    ├── metric-tile.tsx       指标磁贴
    ├── page-intro.tsx        页面介绍区
    ├── prompt-panel.tsx      提示面板
    ├── section-heading.tsx   章节标题
    ├── signal-bar.tsx        信号条
    ├── terminal-panel.tsx    终端面板
    └── timeline-rail.tsx     时间线轨道
```

### 7.2 主题系统

基于 `next-themes` + CSS 变量，支持 `dark` / `light` / `system`。

### 7.3 动画系统

| 技术 | 场景 |
|------|------|
| **Motion (Framer)** | 磁性效果、stagger 动画、页面转场 |
| **CSS Scroll-Driven** | `.scroll-reveal` — 渐进增强 |
| **CSS @keyframes** | 背景 orb 浮动、粒子脉冲 |

### 7.4 全站背景系统

5 层固定背景叠加（`site-background.tsx`）：

```
Layer 0: Aurora gradient wash      — CSS radial-gradient
Layer 1: Neural dot grid           — CSS repeating pattern
Layer 2: Floating gradient orbs    — 3 个 CSS 动画 orb
Layer 3: WebGPU particle field     — GPU 加速粒子流体 (桌面 1200 / 移动 300 粒子)
Layer 4: Constellation canvas      — Canvas 2D 星座连线 (仅桌面)
```

---

## 8. 内容与文档系统

### 8.1 内容层

所有页面级内容集中在 `@ai-site/content` 管理，前端组件只消费 typed data：

```typescript
// packages/content/src/home.ts
export function getHomeContent(locale: "zh" | "en"): HomeContent {
  return locale === "zh" ? zhContent : enContent;
}
```

### 8.2 文档系统

产品文档正文存储在 `packages/content/src/docs/catalog.ts`，中英双语，TypeScript 静态类型。文档导航结构在 `docsNavSections` 中定义，与 EvoFlow 桌面端菜单结构对齐：

- **快速开始**：入门、快捷指令、编码助手、快速创建角色/技能/自动化
- **实时对话**：输入栏与选项、右侧 Stage、目标
- **侧栏菜单**：任务中心、自动化、技能、MCP、预设角色
- **设置**：通用、模型、IM 通信、记忆

文档页面由 `apps/web/src/app/(marketing)/docs/[...slug]/page.tsx` 路由渲染，从 catalog.ts 按 slug 查找正文。

### 8.3 国际化

Cookie-based locale 切换（`site-locale=zh|en`），不走 URL 路径分段：

- `@ai-site/content` 每个模块导出双语内容
- `useLocalizedValue(zhContent, enContent)` hook 根据 locale 返回
- `data-locale` 属性挂在 `<html>` 上

---

## 9. 实时交互系统（Demo）

### 9.1 匿名多人光标 (Live Cursors)

Figma 风格的实时协作光标，**仅用于演示**：

- 内存存储，最多 500 光标
- SSE 推送（1s 间隔），LERP 插值渲染
- 移动端 (`pointer: coarse`) 跳过

### 9.2 访客实时计数

**仅用于演示**，使用内存存储 + 模拟数据，最多 5000 活跃访客。

---

## 10. 静态导出与部署

### 10.1 构建流程

```bash
pnpm build:static      # 构建静态导出
pnpm deploy:tos        # 上传到火山引擎 TOS
```

构建脚本 `apps/web/scripts/static-export.mjs`：
1. 设置 `EVOFLOW_STATIC_EXPORT=1` 环境变量
2. 使用 `next build --webpack`（避免 Turbopack 的 `~` 文件名导致 WAF 拦截）
3. 输出到 `apps/web/out/`

### 10.2 部署配置

部署脚本 `apps/web/scripts/deploy-tos.mjs` 环境变量：

| 变量 | 说明 |
|------|------|
| `TOS_ACCESS_KEY_ID` | TOS 访问密钥 |
| `TOS_SECRET_ACCESS_KEY` | TOS 秘密密钥 |
| `TOS_ENDPOINT` | TOS 端点 |
| `TOS_REGION` | 区域 |
| `TOS_BUCKET` | 桶名 |
| `TOS_PREFIX` | (可选) 前缀 |
| `TOS_DRY_RUN` | (可选) 1=试运行 |

### 10.3 注意事项

- 必须为桶绑定自定义域名，设置**静态网站**默认首页
- HTML 文件需设置 `Content-Disposition: inline`（否则浏览器触发下载）
- 部署后需在 CDN 控制台刷新缓存

---

## 11. 性能优化

### 11.1 前端

| 优化 | 实现 |
|------|------|
| **动态导入** | `react-markdown`, `shiki`, `ConstellationCanvas`, `ParticleField` 均 `dynamic()` |
| **SSR/RSC** | 页面级数据获取走 Server Components |
| **移动端降级** | `useIsMobile()` → 减少粒子数、跳过星座连线、禁用 Live Cursors |
| **prefers-reduced-motion** | CSS 动画减弱、跳过粒子效果 |
| **字体优化** | `next/font/google` 预加载 4 种字体 |
| **图片** | Next.js `Image` 组件自动优化 |

### 11.2 网络

| 优化 | 实现 |
|------|------|
| **CDN 缓存** | 所有静态资源通过 CDN 分发 |
| **静态资源长缓存** | `/_next/static/` immutable, 1 year |
| **Gzip** | CDN 层文本压缩 |

---

## 12. 开发规范

### 12.1 代码风格

- **TypeScript strict**：所有 package 继承 `@ai-site/config` base config
- **ESLint**：`eslint-config-next` (core-web-vitals + TypeScript)
- **Prettier**：统一格式化
- **无冗余注释**：不写 `// 导入模块` 类注释，仅注释非显而易见的逻辑

### 12.2 Git 规范

```
<type>: <description>

type = feat | fix | refactor | style | perf | docs | chore | test
```

### 12.3 新增功能流程

1. 在 `@ai-site/content` 添加双语内容（或更新文档 catalog）
2. 在 `@ai-site/ui` (如需) 创建设计系统组件
3. 在 `apps/web` 实现页面和路由
4. 需要时更新 `packages/content/src/docs/catalog.ts` 中的产品文档
5. 运行 `pnpm build:static` 验证构建无误

### 12.4 常用命令

```bash
pnpm dev              # 启动开发服务器
pnpm dev:web          # 仅启动 web
pnpm build            # 构建所有包
pnpm build:static     # 静态导出构建
pnpm typecheck        # TypeScript 类型检查
pnpm lint             # ESLint 检查
pnpm clean            # 清理构建产物
pnpm format           # Prettier 格式化
pnpm deploy:tos       # 部署到 TOS
```

### 12.5 环境变量

详见 [`.env.example`](./.env.example)，核心变量：

| 变量 | 说明 |
|------|------|
| `OPENAI_API_KEY` | OpenAI API 密钥（Demo 功能可选） |
| `OPENAI_CHAT_MODEL` | 主模型 |
| `ANTHROPIC_API_KEY` | Anthropic API 密钥（Demo 可选） |
| `DATABASE_URL` | PostgreSQL 连接串（静态导出不使用） |
| `ADMIN_BASIC_AUTH_PASSWORD` | Admin 面板密码 |
| `GITHUB_ACCOUNT_USERNAME` | GitHub 用户名（Coding DNA） |
| `NEXT_PUBLIC_SITE_URL` | 生产域名 |

---

## 附录：文档索引

| 文档 | 内容 |
|------|------|
| [README.md](./README.md) | 项目简介、快速开始、功能列表 |
| **ARCHITECTURE.md** (本文) | 系统架构、技术实现方案、开发规范 |
| [CUSTOMIZATION.md](./CUSTOMIZATION.md) | 个性化定制指南：内容替换、主题配置、功能裁剪 |
| [LICENSE](./LICENSE) | MIT 开源协议 |
