# EvoFlow 官网定制指南

> 本文档面向希望 **个性化定制 EvoFlow 官网** 的开发者。官网是 EvoFlow 产品的展示门户，包含产品文档、演示页面与品牌信息。
> 与 [ARCHITECTURE.md](./ARCHITECTURE.md)（系统架构）及 [README.md](./README.md)（快速上手）互补。

---

## 1. 品牌信息

### 站点标识

编辑 `packages/content/src/site-identity.ts`：

```typescript
export const siteIdentity = {
  siteUrl: "https://www.evovexai.com",       // 改成你的域名
  contactEmail: "cloud@evovexai.com",        // 改成你的联系邮箱
  publisherName: "Evovex AI",                // 改成你的发布主体名称
} as const;
```

### 品牌文案

编辑 `packages/content/src/site-copy.ts`：

- 更新 `evoVexBrand` 中的品牌名、标语等

### 外部链接

编辑 `packages/content/src/site-links.ts`：

```typescript
export const siteLinks = {
  github: "https://github.com/EvovexAI/EvoFlow",  // 改成你的仓库
  docsSite: "https://www.evovexai.com/docs",       // 改成你的文档页
  download: "https://github.com/EvovexAI/EvoFlow/releases/latest", // 下载链接
  releases: "https://github.com/EvovexAI/EvoFlow/releases",       // 发行版页
  // ...
};
```

---

## 2. 首页内容

### Hero / 功能矩阵 / 场景

编辑 `packages/content/src/home.ts`：

- `hero`：标题、描述、CTA 按钮文案、功能卡片
- `capabilities`：核心差异化、能力矩阵、场景说明
- `scenariosSection`：典型场景卡片
- `evolutionPulse`：演进路线时间线
- `closingNote`：页尾致谢

### 首页路由

页面入口：`apps/web/src/app/page.tsx`
渲染组件：`apps/web/src/components/home/homepage.tsx`

---

## 3. 产品文档

### 文档正文

编辑 `packages/content/src/docs/catalog.ts`：

- 每个文档页面包含 `slug`, `title`, `description`, `body`（中英双语）
- 导航结构在 `docsNavSections` 中定义
- 新增页面：在 `pages` 数组追加条目，并在 `docsNavSections` 中添加到对应分区

### 文档路由

文档页面由 `apps/web/src/app/(marketing)/docs/[...slug]/page.tsx` 自动渲染，从 catalog.ts 按 slug 查找。

### 文档首页

编辑 `apps/web/src/components/docs/docs-home.tsx` 和 `docs-page-client.tsx`。

---

## 4. 平台页面

### 管理后台

编辑 `packages/content/src/platform-pages.ts`：

- `admin`：Admin 首页卡片、指标、时间线
- `adminEvolution`：演进管理
- `adminJobs`：任务管理
- `adminObservability`：可观测性
- `aiHub`：AI 中心
- `evolution`：演进页
- `lab`：实验室
- `mcp`：MCP 页面

### 渲染组件

`apps/web/src/components/platform-pages/` 下的组件负责渲染上述数据。

---

## 5. AI Demo 数据

### Chat / Arena / Artifacts

编辑 `packages/ai/src/` 下的文件：

- `chat/demo-chat.ts`：聊天 Demo 数据
- `arena/comparison.ts`：模型竞技场
- `ai-ui/artifacts.ts`：结构化富内容
- `agents/site-agent.ts`：Site Agent 定义
- `prompts/persona.ts`：AI 人格提示

---

## 6. 个人数据

### 简历与作品

编辑 `packages/content/src/personal.ts`：个人简介
编辑 `packages/content/src/projects.ts`：项目列表
编辑 `packages/content/src/timeline.ts`：时间线

### 简历页面

`apps/web/src/app/resume/page.tsx` + `apps/web/src/components/resume/` 下的组件。

---

## 7. 设计系统

### 颜色

编辑 `apps/web/src/app/globals.css`：

```css
@theme inline {
  --color-primary: oklch(0.78 0.13 295);    /* 紫色 — 改 hue 换主色 */
  --color-secondary: oklch(0.82 0.12 195);   /* 青色 */
  --color-tertiary: oklch(0.82 0.14 75);     /* 琥珀色 */
}
```

### 字体

编辑 `apps/web/src/app/layout.tsx`：

```typescript
const displayFont = Space_Grotesk({ ... });  // 标题
const bodyFont = Manrope({ ... });           // 正文
const labelFont = Inter({ ... });            // 标签
const cjkFont = Noto_Sans_SC({ ... });       // 中文
```

### 背景效果

编辑 `apps/web/src/components/site-background.tsx`：

- 调整粒子数量、orb 颜色、渐变强度
- `useIsMobile()` hook 控制移动端降级

---

## 8. SEO 与元数据

### Layout Metadata

编辑 `apps/web/src/app/layout.tsx`：

- 更新 `SITE_URL` 为你的域名
- 更新 `title`、`description`、Open Graph 元数据
- 更新 JSON-LD 结构化数据

### Sitemap & Robots

- `apps/web/src/app/sitemap.ts`：更新 `SITE_URL`
- `apps/web/src/app/robots.ts`：更新 sitemap URL

### Open Graph Image

编辑 `apps/web/src/app/opengraph-image.tsx`：

- 更新渲染的文本

---

## 9. 部署

### 火山引擎 TOS

```bash
pnpm build:static       # 静态导出构建
pnpm deploy:tos         # 上传到 TOS
```

需要设置环境变量：`TOS_ACCESS_KEY_ID`、`TOS_SECRET_ACCESS_KEY`、`TOS_ENDPOINT`、`TOS_REGION`、`TOS_BUCKET`。

**关键步骤**：
1. 在 TOS 控制台为桶绑定自定义域名
2. 设置**静态网站**默认首页
3. 确保 HTML 文件 `Content-Disposition: inline`
4. 部署后刷新 CDN 缓存

### 其他部署方式

- **Vercel**：连接 GitHub 仓库，设置环境变量即可
- **自托管**：`pnpm build` 后 `next start -p 3000`

---

## 10. 移除不需要的功能

| 功能 | 需修改的文件 |
|------|-------------|
| Live Cursors | 移除 `layout.tsx` 中的 `<LiveCursors />` |
| 粒子背景 | 移除 `site-background.tsx` 中的 `<ParticleField />` |
| 音效 | 移除 `site-header.tsx` 中的 `<SoundToggle />`，删除 `hooks/use-sound.ts` |
| 简历页 | 删除 `/resume` 路由 |
| 终端页 | 删除 `/terminal` 路由 |
| 实验室 | 删除 `/lab` 路由 |
| 管理后台 | 删除 `/admin` 路由 |

---

## 附录

- 完整文档：`/docs/` 路由下的产品文档，数据在 `packages/content/src/docs/catalog.ts`
- 架构说明：`ARCHITECTURE.md`
- 项目基础：`README.md`
