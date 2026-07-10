import { projectSchema } from "./schemas";

export const projects = [
  projectSchema.parse({
    slug: "evoflow-core",
    title: "EvoFlow Core",
    summary:
      "多智能体编排、Plan 模式、任务调度与安全护栏，连接模型与真实工作流。",
    tags: ["agents", "orchestration", "github"],
  }),
  projectSchema.parse({
    slug: "evoflow-desktop",
    title: "EvoFlow 桌面端",
    summary: "EvoFlow 桌面客户端，连接 Gateway，服务本地开发与日常使用。",
    tags: ["desktop", "tauri", "devtools"],
  }),
  projectSchema.parse({
    slug: "skills-ecosystem",
    title: "Skills 生态",
    summary: "可扩展技能与 MCP 集成，把外部工具与业务系统接到同一套编排层。",
    tags: ["skills", "mcp", "extensions"],
  }),
];
