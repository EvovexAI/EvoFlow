import type { NextConfig } from "next";

/** Only set by `scripts/static-export.mjs` — avoids clashing with unrelated env */
const isStaticExport = process.env.EVOFLOW_STATIC_EXPORT === "1";

const nextConfig: NextConfig = {
  ...(isStaticExport ? { output: "export" as const } : {}),
  ...(isStaticExport ? { images: { unoptimized: true } } : {}),
  env: {
    NEXT_PUBLIC_STATIC_EXPORT: isStaticExport ? "1" : "",
  },
  ...(!isStaticExport
    ? {
        async redirects() {
          return [
            { source: "/docs/chat/models-modes", destination: "/docs/chat/models-scenes", permanent: false },
            { source: "/docs/chat/session", destination: "/docs/chat/memory-hosted-workspace", permanent: false },
            { source: "/docs/tasks/execution", destination: "/docs/tasks/center", permanent: false },
            { source: "/docs/tasks/scheduler", destination: "/docs/tasks/cron", permanent: false },
            { source: "/docs/settings/channels", destination: "/docs/config/channels", permanent: false },
            { source: "/docs/settings/models", destination: "/docs/config/models", permanent: false },
            { source: "/docs/settings/agents", destination: "/docs/config/agents", permanent: false },
            { source: "/docs/settings/skills", destination: "/docs/ext/skills", permanent: false },
            { source: "/docs/settings/memory", destination: "/docs/data/memory-files", permanent: false },
            { source: "/docs/settings/workspace", destination: "/docs/chat/memory-hosted-workspace", permanent: false },
            { source: "/docs/settings/tools", destination: "/docs/ext/tools", permanent: false },
            { source: "/docs/settings/mcp", destination: "/docs/ext/tools", permanent: false },
          ];
        },
      }
    : {}),
  experimental: {
    viewTransition: true,
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
