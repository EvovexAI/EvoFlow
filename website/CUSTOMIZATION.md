# Customization Guide

This guide walks you through personalizing the AI Site template to make it your own.

---

## 1. Personal Information

### Name & Bio

Edit `packages/content/src/personal.ts`:

```typescript
// Replace with your actual info
name: "Your Name",
title: "Your Title",
summary: "Your professional summary...",
```

### Homepage Hero

Edit `packages/content/src/home.ts`:

- Update the `hero` section with your name and tagline
- The file has both `zh` (Chinese) and `en` (English) content blocks

### About Page

Edit `apps/web/src/components/about-page.tsx`:

- Replace the bio text in both `zhBio` and `enBio`

### Brand Text

Edit `packages/content/src/site-copy.ts`:

- Change `brand` to your name or brand
- Update navigation labels if needed

### Site Header

Edit `apps/web/src/components/site-header.tsx`:

- Find the brand/logo text and replace with your name

### Site Footer

Edit `apps/web/src/components/site-footer.tsx`:

- Update the copyright text

---

## 2. External Links

Edit `packages/content/src/site-links.ts`:

```typescript
export const siteLinks = {
  resume: "https://your-resume-url.com",
  blog: "https://your-blog-url.com",
  github: "https://github.com/your-username",
};
```

---

## 3. Projects

Edit `packages/content/src/projects.ts`:

Replace the example projects with your own. Each project needs:

```typescript
{
  slug: "project-slug",
  title: "Project Title",
  description: "What it does...",
  tags: ["React", "AI", "TypeScript"],
  href: "https://github.com/you/project",
}
```

---

## 4. Career Timeline

Edit `packages/content/src/timeline.ts`:

Replace with your own career milestones. Maintain the same TypeScript structure.

---

## 5. AI Persona

### System Prompt

Edit `packages/ai/src/prompts/persona.ts`:

This is the core personality of your AI assistant. Customize it to:
- Reflect your background and expertise
- Match your communication style
- Include specific knowledge areas

### Agent Name

Edit `packages/ai/src/agents/site-agent.ts`:

```typescript
export const siteAgent = {
  name: 'YourAgentName',
  // ...
};
```

---

## 6. SEO & Metadata

### Layout Metadata

Edit `apps/web/src/app/layout.tsx`:

- Update `SITE_URL` to your domain
- Update all `title`, `description`, and Open Graph metadata
- Update the JSON-LD structured data

### Sitemap & Robots

- `apps/web/src/app/sitemap.ts` — update `SITE_URL`
- `apps/web/src/app/robots.ts` — update sitemap URL

### Open Graph Image

Edit `apps/web/src/app/opengraph-image.tsx`:

- Update the text rendered on the OG image

---

## 7. Design System

### Colors

Edit `apps/web/src/app/globals.css`:

The theme uses CSS variables under `@theme inline`. Key tokens:

```css
--color-primary: oklch(0.78 0.13 295);    /* Purple — change hue for different accent */
--color-secondary: oklch(0.82 0.12 195);   /* Cyan */
--color-tertiary: oklch(0.82 0.14 75);     /* Amber */
```

### Fonts

Edit `apps/web/src/app/layout.tsx`:

The template uses 4 Google Fonts. Replace with your preferred fonts:

```typescript
const displayFont = Space_Grotesk({ ... });  // Headlines
const bodyFont = Manrope({ ... });           // Body text
const labelFont = Inter({ ... });            // Labels
const cjkFont = Noto_Sans_SC({ ... });       // Chinese text
```

### Background Effects

Edit `apps/web/src/components/site-background.tsx`:

- Adjust particle count, orb colors, gradient intensity
- The `useIsMobile()` hook controls mobile degradation

---

## 8. Environment Variables

Copy `.env.example` to `apps/web/.env.local` and configure:

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_SITE_URL` | Your production domain |
| `OPENAI_API_KEY` | Your OpenAI API key |
| `OPENAI_CHAT_MODEL` | Model to use (e.g. `gpt-4o`, `gpt-4o-mini`) |
| `ANTHROPIC_API_KEY` | (Optional) For Model Arena |
| `DATABASE_URL` | (Optional) PostgreSQL connection. Empty = JSON file fallback |
| `GITHUB_ACCOUNT_USERNAME` | Your GitHub username for Coding DNA |
| `ADMIN_BASIC_AUTH_PASSWORD` | Password for the `/admin` panel |

---

## 9. Deployment

### Vercel

The simplest option — just connect your GitHub repo to Vercel and set environment variables.

### Self-hosted

1. Build: `pnpm build`
2. Upload to your server
3. Run with PM2: `pm2 start node_modules/next/dist/bin/next --name ai-site -- start -p 3000`
4. Set up Nginx as reverse proxy with SSL

### Database

- Without `DATABASE_URL`: the app uses `.runtime/*.json` files for persistence (good for development)
- With PostgreSQL: install pgvector extension, set `DATABASE_URL` — schema auto-migrates on startup

---

## 10. Removing Unused Features

Each feature is modular. To remove one:

| Feature | Files to remove/modify |
|---------|----------------------|
| Live Cursors | Remove `<LiveCursors />` from `layout.tsx`, delete `api/cursors/` |
| WebGPU Particles | Remove `<ParticleField />` from `site-background.tsx` |
| Model Arena | Remove `/ai/arena` route |
| Terminal | Remove `/terminal` route |
| Sound Effects | Remove `<SoundToggle />` from header, delete `hooks/use-sound.ts` |
| Coding DNA | Remove section from `homepage.tsx`, delete `api/coding-dna/` |
