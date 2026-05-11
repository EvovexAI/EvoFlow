# Development Guidelines

This is a Next.js 16+ App Router project using React 19, Tailwind CSS v4, and AI SDK v6.

## Key Conventions

- **App Router**: All routes under `src/app/`, use Server Components by default
- **Tailwind v4**: CSS-first configuration via `@theme inline` — no `tailwind.config.ts`
- **AI SDK v6**: Use `inputSchema` (not `parameters`) for `tool()` definitions, `stepCountIs` for step limits
- **Monorepo**: Shared packages under `packages/*` — import via `@ai-site/content`, `@ai-site/ai`, `@ai-site/ui`
- **i18n**: Cookie-based locale (`zh`/`en`), use `useLocalizedValue` hook for client components

## Before Making Changes

Read the relevant docs in `node_modules/next/dist/docs/` for Next.js API specifics — this version may differ from your training data.
