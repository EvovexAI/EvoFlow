export function getContextQuotaMeterGridClass(count: number): string {
  // Start/Coding 额度来自服务端快照，实际可能是 1/2/3 条；官方 MCP
  // 已改为网格下方的贯穿行，因此即使误传更大计数也不能把 320px 浮层压成四列。
  // 固定三列会让两条额度留下空洞，也会让单条额度被无意义压窄。
  if (count <= 1) {
    return "grid-cols-1";
  }
  if (count === 2) {
    return "grid-cols-2";
  }
  if (count === 3) {
    return "grid-cols-3";
  }
  return "grid-cols-3";
}
