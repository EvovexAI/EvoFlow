# @ai-site/web — EvoFlow 官网主应用

这是 **EvoFlow 产品官网** 的 Next.js 16 主应用，使用 App Router 架构。

## 快速开始

```bash
# 在 website/ 根目录下
pnpm install
cp .env.example apps/web/.env.local
pnpm dev
```

浏览器打开 `http://localhost:3000`。

## 目录结构

```
apps/web/
├── src/
│   ├── app/                     # App Router 页面与布局
│   │   ├── (marketing)/         # 营销页 (about, docs, evolution, showcase)
│   │   ├── admin/               # 管理后台页面
│   │   ├── lab/                 # 实验页
│   │   ├── resume/              # 简历页
│   │   ├── terminal/            # 终端页
│   │   ├── layout.tsx           # 全局布局
│   │   ├── page.tsx             # 首页
│   │   ├── globals.css          # 全局样式 + Tailwind v4 主题
│   │   └── providers.tsx        # 全局 Provider 包裹
│   ├── components/              # UI 组件
│   │   ├── docs/                # 文档系统组件
│   │   ├── home/                # 首页组件
│   │   ├── showcase/            # 产品演示组件
│   │   ├── terminal/            # 终端组件
│   │   ├── platform-pages/      # 管理后台组件
│   │   ├── resume/              # 简历组件
│   │   ├── ai-ui/               # AI UI 组件
│   │   └── ...                  # 其他通用组件
│   ├── hooks/                   # 自定义 Hooks
│   ├── lib/                     # 工具库
│   └── instrumentation.ts       # 全局 fetch proxy
├── scripts/                     # 构建与部署脚本
├── next.config.ts               # Next.js 配置
├── package.json
└── tsconfig.json
```

## 关键配置

### `next.config.ts`

- `trailingSlash: true` — 静态导出时目录索引友好
- `experimental.viewTransition` — 页面转场动画
- `transpilePackages` — 编译 monorepo 内的包

### 静态导出

```bash
pnpm build:static    # 构建静态导出到 out/
pnpm deploy:tos      # 上传到火山引擎 TOS
```

静态导出由 `scripts/static-export.mjs` 驱动，使用 `--webpack` 构建以规避 Turbopack 的 `~` 文件名问题。

## 路由

详见 [ARCHITECTURE.md](../../ARCHITECTURE.md) 第 5 节「路由设计」。

## 注意

- 本应用**不包含** API 路由（`/api/*`）——所有数据来自 `packages/` 的静态 TypeScript 模块
- AI Demo 使用**客户端模拟数据**，不调用远程 AI API
- 文档正文在 `packages/content/src/docs/catalog.ts` 中管理

## 相关文档

- [ARCHITECTURE.md](../../ARCHITECTURE.md) — 系统架构
- [CUSTOMIZATION.md](../../CUSTOMIZATION.md) — 定制指南
- [README.md](../../README.md) — 项目概览
