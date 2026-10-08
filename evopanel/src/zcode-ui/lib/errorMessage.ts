export function getErrorMessage(error: unknown): string {
  const rawMessage =
    error instanceof Error ? error.message : typeof error === "string" ? error : String(error);

  // 远程连接链路里有的错误已经带了 "Error: ..." 前缀，
  // 上层再包装成 Error 或直接 String(error) 展示时，会叠成 "Error: Error: ..."。
  // 这里统一剥掉重复前缀，只保留真正有意义的错误内容。
  return rawMessage.replace(/^(Error:\s*)+/i, "").trim();
}
