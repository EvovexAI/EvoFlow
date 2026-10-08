// discovery barrel 曾把 monotonicity 与 mutation API 一并暴露，
// 形成第二条暴露路径：消费方可能绕过独立 subpath，Desktop 构建也曾因坏 re-export
// 无法启动。单一来源要求“一个 API 恰好一条暴露路径”：本文件只导出 discovery 所需
// config/digest；mutation 与 monotonicity 必须从各自 package subpath 直连消费。
export * from "./workspace-hook-config.js";
export * from "./workspace-hook-digest.js";
