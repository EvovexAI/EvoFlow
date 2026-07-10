import type { NextConfig } from "next";

/** Only set by `scripts/static-export.mjs` — avoids clashing with unrelated env */
const isStaticExport = process.env.EVOFLOW_STATIC_EXPORT === "1";

const nextConfig: NextConfig = {
  ...(isStaticExport ? { output: "export" as const } : {}),
  /** Static HTML in public/ (presentations, export) and TOS buckets expect directory index URLs. */
  trailingSlash: true,
  ...(isStaticExport ? { images: { unoptimized: true } } : {}),
  env: {
    NEXT_PUBLIC_STATIC_EXPORT: isStaticExport ? "1" : "",
  },
  ...(!isStaticExport
    ? {
        async rewrites() {
          return {
            beforeFiles: [
              {
                source: "/presentations/:path*/",
                destination: "/presentations/:path*/index.html",
              },
            ],
          };
        },
        async redirects() {
          return [
            { source: "/docs/hosted/overview", destination: "/docs/chat/goal", permanent: true },
            { source: "/docs/chat/hosted", destination: "/docs/chat/goal", permanent: true },
            { source: "/docs/chat/hosted/", destination: "/docs/chat/goal/", permanent: true },
            { source: "/docs/chat/session", destination: "/docs/chat/composer", permanent: false },
            { source: "/docs/chat/memory-hosted-workspace", destination: "/docs/chat/composer", permanent: false },
            { source: "/docs/chat/models-scenes", destination: "/docs/chat/composer", permanent: false },
            { source: "/docs/chat/memory", destination: "/docs/chat/composer", permanent: false },
            { source: "/docs/chat/session-modes", destination: "/docs/chat/composer", permanent: false },
            { source: "/docs/chat/creativity", destination: "/docs/chat/composer", permanent: false },
            { source: "/docs/chat/evopanel", destination: "/docs/getting-started", permanent: true },
            { source: "/docs/chat/evopanel/", destination: "/docs/getting-started/", permanent: true },
            { source: "/docs/chat/plan-collab", destination: "/docs/chat/composer", permanent: false },
            { source: "/docs/chat/workspace", destination: "/docs/chat/composer", permanent: false },
            { source: "/docs/tasks/execution", destination: "/docs/tasks/center", permanent: false },
            { source: "/docs/tasks/scheduler", destination: "/docs/tasks/cron", permanent: false },
            { source: "/docs/settings/channels", destination: "/docs/config/channels", permanent: false },
            { source: "/docs/settings/models", destination: "/docs/getting-started", permanent: false },
            { source: "/docs/config/models", destination: "/docs/getting-started", permanent: false },
            { source: "/docs/settings/agents", destination: "/docs/config/agents", permanent: false },
            { source: "/docs/settings/skills", destination: "/docs/ext/skills", permanent: false },
            { source: "/docs/settings/memory", destination: "/docs/panel/memory-tab", permanent: false },
            { source: "/docs/data/memory-files", destination: "/docs/panel/memory-tab", permanent: false },
            { source: "/docs/panel/about", destination: "/docs/getting-started", permanent: false },
            { source: "/docs/debug/agent-trace", destination: "/docs/getting-started", permanent: false },
            { source: "/docs/settings/workspace", destination: "/docs/chat/composer", permanent: false },
            { source: "/docs/settings/tools", destination: "/docs/ext/tools", permanent: false },
            { source: "/docs/settings/mcp", destination: "/docs/ext/tools", permanent: false },
          ];
        },
      }
    : {}),
  experimental: {
    // viewTransition + static export /docs client nav can trigger "module factory is not available"
    viewTransition: !isStaticExport,
  },
  transpilePackages: [
    "@ai-site/ui",
    "@ai-site/ai",
    "@ai-site/db",
    "@ai-site/content",
    "@ai-site/observability",
  ],
};

export default nextConfig;
