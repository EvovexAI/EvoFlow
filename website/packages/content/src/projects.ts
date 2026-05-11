import { projectSchema } from "./schemas";

export const projects = [
  projectSchema.parse({
    slug: "evoflow-core",
    title: "EvoFlow Core",
    summary:
      "多智能体编排、Plan 模式、任务调度与安全护栏，连接模型与真实工作流。",
    tags: ["agents", "orchestration", "open-source"],
  }),
  projectSchema.parse({
    slug: "evopanel",
    title: "EvoPanel",
    summary: "桌面端体验，将 EvoFlow 能力带到本地开发与日常使用场景。",
    tags: ["desktop", "tauri", "devtools"],
  }),
  projectSchema.parse({
    slug: "skills-ecosystem",
    title: "Skills 生态",
    summary: "可扩展技能与 MCP 集成，把外部工具与业务系统接到同一套编排层。",
    tags: ["skills", "mcp", "extensions"],
  }),
];
