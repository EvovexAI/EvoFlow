# AI Site

An open-source, AI-native personal website template with cinematic design, intelligent interactions, and a self-evolving knowledge base.

Built with **Next.js 16**, **React 19**, **AI SDK 6**, **WebGPU**, and a custom design system.

**Live Demo → [conorliu.com](https://conorliu.com)**

---

## 本地开发（简体中文）

本目录是 EvoFlow 工作空间内的 **官网**：基于 **Next.js 16** 的 **pnpm workspace + Turborepo** 单体仓库，应用入口在 `apps/web/`。

### 环境要求

- **Node.js** 22+
- **pnpm** 10+（与仓库根目录 `package.json` 中的 `packageManager` 保持一致）

### 安装与启动

在 **`website/`** 目录下执行：

```bash
pnpm install
cp .env.example apps/web/.env.local
```

编辑 `apps/web/.env.local`，至少按需填写：`OPENAI_API_KEY`、`OPENAI_CHAT_MODEL`、`GITHUB_ACCOUNT_USERNAME`、`ADMIN_BASIC_AUTH_PASSWORD` 等（完整说明见下文 **Configure** 表格）。

```bash
pnpm dev
```

浏览器打开：**http://localhost:3000**

产品演示页（Plan 视频/截图、界面预览，素材来自仓库 `docs/assets/`）：**http://localhost:3000/showcase/**（`pnpm dev` 会自动执行 `pnpm sync:media` 同步媒体文件）。

若只想启动 Web 应用（等价于在 monorepo 里只跑 `@ai-site/web`）：

```bash
pnpm dev:web
```

### 生产构建与运行

```bash
pnpm build
pnpm --filter @ai-site/web start
```

默认监听 **3000** 端口（Next.js `next start`）。

---

## Features

- **AI Chat with Tool Calling** — conversational AI agent that can navigate the site, switch themes, render rich UI artifacts
- **Generative UI** — AI-driven UI actions via tool calls (navigation, theme switching, skill visualization, project cards)
- **RAG Knowledge Base** — pgvector-powered retrieval-augmented generation with auto-ingestion
- **WebGPU Particle System** — GPU-accelerated particle flow field with Canvas 2D fallback and mouse interaction
- **Anonymous Live Cursors** — Figma-style real-time multi-cursor via Server-Sent Events
- **Model Arena** — side-by-side GPT vs Claude streaming comparison
- **Workflow Studio** — visual workflow editor built with React Flow
- **Agent OS Console** — session management, run tracing, tool call inspection
- **Coding DNA** — live GitHub stats and language distribution visualization
- **Cinematic Design System** — glass morphism, glow effects, scroll-driven animations, sound design
- **Command Palette** — ⌘K global command palette with AI chat, navigation, and terminal modes
- **i18n** — built-in Chinese / English support
- **Dark / Light Theme** — full theme support with system preference detection
- **Mobile Responsive** — adaptive layout, touch-friendly, performance degradation on mobile

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 (App Router, RSC, Server Actions) |
| Runtime | React 19, TypeScript 5 (strict) |
| Styling | Tailwind CSS 4, CSS variables, next-themes |
| Animation | Motion (Framer Motion) 12, CSS scroll-driven animations, View Transitions API |
| AI | Vercel AI SDK 6, OpenAI, Anthropic, pgvector RAG |
| Graphics | WebGPU (WGSL shaders), Canvas 2D fallback |
| Workflow | @xyflow/react (React Flow) |
| Command Palette | cmdk |
| Database | PostgreSQL 16 + pgvector |
| Monorepo | pnpm workspaces + Turborepo |

---

## Project Structure

```
ai-site/
├── apps/
│   ├── web/                  # Next.js 16 main application
│   │   ├── src/app/          # App Router pages, layouts, API routes
│   │   ├── src/components/   # UI components
│   │   ├── src/hooks/        # Custom hooks
│   │   └── src/lib/          # Utilities (auth, AI runtime, rate limiting)
│   └── worker/               # Background job runner
├── packages/
│   ├── ai/                   # AI runtime: agents, chat, arena, workflows, artifacts
│   ├── db/                   # PostgreSQL client, repositories, schema
│   ├── ui/                   # Design system: tokens, primitives, composites
│   ├── content/              # Site copy, locales, projects, timeline data
│   ├── observability/        # LLM run tracking, tool calls, visitor sessions
│   └── config/               # Shared TypeScript config
├── ARCHITECTURE.md           # System architecture & development manual
├── CUSTOMIZATION.md          # How to personalize the template
└── turbo.json                # Turborepo pipeline config
```

---

## Quick Start

### Prerequisites

- **Node.js** 22+
- **pnpm** 10+
- **PostgreSQL** 16 with pgvector (optional — falls back to JSON files)

### Install

```bash
git clone https://github.com/YOUR_USERNAME/ai-site.git
cd ai-site
pnpm install
```

### Configure

```bash
cp .env.example apps/web/.env.local
```

Edit `apps/web/.env.local`:

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | Yes | OpenAI API key |
| `OPENAI_CHAT_MODEL` | Yes | Primary model (e.g. `gpt-4o`) |
| `ANTHROPIC_API_KEY` | For Arena | Anthropic API key |
| `DATABASE_URL` | Optional | PostgreSQL connection string |
| `GITHUB_ACCOUNT_USERNAME` | Yes | Your GitHub username |
| `ADMIN_BASIC_AUTH_PASSWORD` | Yes | Admin panel password |

### Run

```bash
pnpm dev
```

Open `http://localhost:3000`.

### Build

```bash
pnpm build
```

---

## Personalization

See **[CUSTOMIZATION.md](./CUSTOMIZATION.md)** for a complete guide on how to:

- Replace the placeholder name and bio with your own
- Add your projects and career timeline
- Configure AI persona and behavior
- Customize the design system (colors, fonts, effects)
- Set up your own domain and deployment

---

## Pages

| Route | Description |
|-------|-------------|
| `/` | Homepage — hero, capabilities, Coding DNA, Evolution Pulse |
| `/about` | About page with career timeline |
| `/ai/chat` | AI chat with multimodal input |
| `/ai/agent` | Agent mission control |
| `/ai/workflow` | Visual workflow editor |
| `/ai/knowledge` | RAG knowledge base |
| `/ai/arena` | Model Arena (GPT vs Claude) |
| `/ai/mcp` | MCP tool orchestration |
| `/ai/os` | Agent OS console |
| `/evolution` | Evolution timeline |
| `/lab` | Experiment lab |
| `/terminal` | Terminal interface |
| `/admin` | Admin dashboard (protected) |

---

## Deployment

### 火山引擎 TOS 静态站（EvoFlow 官网导出）

静态导出 + 上传到 TOS 的脚本在 `apps/web/scripts/`（CI：仓库根目录 `.github/workflows/deploy-site-tos.yml`）。

```bash
# 在 website/ 下
pnpm build:static
cd apps/web && node scripts/deploy-tos.mjs
```

环境变量：`TOS_ACCESS_KEY_ID`、`TOS_SECRET_ACCESS_KEY`、`TOS_ENDPOINT`、`TOS_REGION`、`TOS_BUCKET`；可选 `TOS_PREFIX`、`TOS_DRY_RUN=1`。上传脚本会为 `.html` 设置 `Content-Type: text/html` 与 **`Content-Disposition: inline`**。

**浏览器里要像网站一样打开，而不是下载 HTML 文件，必须在控制台完成：**

1. 桶 **基础设置 → 静态网站**：设置默认首页（如 `index.html`），按需设置 404 页。  
2. **域名管理**：为当前桶 [绑定自定义域名](https://www.volcengine.com/docs/6349/128983)，DNS 按控制台提示解析。  
3. 对外分享使用 **`https://你的域名/`**，不要使用 `https://<桶名>.tos-<地域>.volces.com/...` 默认域名。官方说明：默认域名访问 HTML 时会在响应中加 `Content-Disposition: attachment`，浏览器会触发下载（见 [设置静态网站](https://www.volcengine.com/docs/6349/114714?lang=zh) 注意事项）。

若曾用旧脚本上传过对象，请重新执行一次上传（或等价覆盖对象）并视情况刷新 CDN 缓存，以便新的 `Content-Disposition` 生效。

**`Failed to load chunk /_next/static/chunks/...`（各页点进去报错）：**

1. **部署版本不一致**：HTML 引用了某次构建的 JS，但 CDN/桶里已是另一次构建（或只上传了一半）。处理：完整执行 `pnpm build:static` + `deploy-tos.mjs`，在火山 CDN 控制台 **刷新全站或 `/_next/static/*`**，用户 **硬刷新**（Ctrl+F5）。
2. **chunk 文件名含 `~`**：Next 16.2 默认 Turbopack 会生成如 `0mkqu0ms~6lkc.js`，部分 WAF/CDN 会拦截。本站静态构建已改为 **`next build --webpack`**（见 `apps/web/scripts/static-export.mjs`），重新构建并上传后 chunk 名一般为纯 hash，无 `~`。
3. **勿用桶默认域名测站**：务必用已绑定自定义域名访问（见上文），否则异常响应也可能表现为 chunk 加载失败。

**路径与 404：** 静态导出默认会生成 `docs.html` 这类「扁平」文件名；在仅按对象键访问的 TOS/静态桶上，浏览器访问 **`/docs`** 往往拿不到 **`docs.html`**，会落到桶的 **404 页**（本站文案即「页面未找到」）。本仓库在 **`apps/web/next.config.ts`** 里对静态导出启用了 **`trailingSlash: true`**，使路由落在 **`docs/index.html`** 等形式，与「目录 + 默认首页」的静态站行为一致；**重新执行 `pnpm build:static` 并上传 `out/`** 后，`/docs/` 与站内链接即可正常访问。

### Vercel (Recommended)

```bash
npx vercel
```

### Self-hosted (PM2 + Nginx)

```bash
# Build locally
pnpm build

# On your server
pm2 start node_modules/next/dist/bin/next --name ai-site-web -- start -p 3000
```

### Docker (Coming Soon)

---

## Contributing

Contributions are welcome! Please open an issue first to discuss what you'd like to change.

## License

[MIT](./LICENSE)
