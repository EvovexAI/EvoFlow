# 开发指南 — EvoFlow 官网

本项目是 `EvoFlow` 工作空间内的 **官网**，基于 **Next.js 16 App Router** + **React 19** + **Tailwind CSS v4** + **Motion (Framer) 12**。

## 关键约定

- **App Router**：所有路由在 `src/app/` 下，默认使用 Server Components
- **Tailwind v4**：CSS-first 配置，通过 `@theme inline` 定义，**没有** `tailwind.config.ts`
- **Monorepo**：共享包在 `packages/*` 下，通过 `@ai-site/content`、`@ai-site/ai`、`@ai-site/ui`、`@ai-site/db`、`@ai-site/observability` 导入
- **i18n**：Cookie-based locale (`zh`/`en`)，Client Components 使用 `useLocalizedValue` hook
- **静态导出**：`NEXT_PUBLIC_STATIC_EXPORT=1` 时启用 `output: "export"`，不生成 API 路由
- **文档内容**：产品文档正文在 `packages/content/src/docs/catalog.ts` 中，不在 `apps/web/` 下

## 内容管理

- 页面级别的文案：`packages/content/src/` 下的 TypeScript 文件
- 产品文档（`/docs/`）：`packages/content/src/docs/catalog.ts`
- AI Demo 数据：`packages/ai/src/` 下各模块

## 构建与部署

```bash
pnpm dev              # 开发
pnpm build            # 生产构建
pnpm build:static     # 静态导出（用于 TOS 部署）
pnpm deploy:tos       # 上传到火山引擎 TOS
pnpm typecheck        # 类型检查
pnpm lint             # ESLint 检查
```

## 相关文档

详细架构说明见 [ARCHITECTURE.md](../../ARCHITECTURE.md)。
