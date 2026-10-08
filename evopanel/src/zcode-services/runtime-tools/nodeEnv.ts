import { resolveZCodeRuntimeEnv } from "@zcode/shared";

type EffectiveNodeEnv = "development" | "production";

function resolveEffectiveNodeEnv(
  env: Record<string, string | undefined> = process.env,
): EffectiveNodeEnv {
  const runtimeEnv = resolveZCodeRuntimeEnv(env);
  // NODE_ENV 是用户 shell 和 Node 生态都会使用的通用变量，不能作为 ZCode 运行时判据。
  // 这里只认 app/CLI 显式注入的 ZCODE_RUNTIME_ENV，避免 Bash 或登录 shell 里的 NODE_ENV 泄漏进
  // host/agent 运行时；test 运行时按普通模式处理，不打开开发调试日志。
  return runtimeEnv === "development" ? "development" : "production";
}

export function isEffectiveDevelopmentNodeEnv(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return resolveEffectiveNodeEnv(env) === "development";
}
