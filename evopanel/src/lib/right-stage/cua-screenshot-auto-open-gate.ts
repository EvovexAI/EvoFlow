/**
 * 「轮尾截图是否该自动开右栏」的唯一判据。
 *
 * 抽成纯函数的原因：这条判据散在组件 useEffect 里时漏过一次 `isRunning`，
 * 结果打开任何历史会话，它最后一轮的 CUA 截图都会被重新开进右栏并按**当前**
 * 会话打戳 —— 同一张图（同 toolCallId）于是被复制进多份会话侧栏记忆，
 * 表现为「A 会话画的图，切到 B/C 会话右栏还在显示」。
 *
 * 与 MCP 工作台（applyV4McpWorkbenchAutoOpen）同判据：
 * 只有「当前尾轮 + 该轮正在跑」才允许自动开栏。
 * - 不是尾轮：历史轮，冷加载会连开一堆标签；
 * - 尾轮但没在跑：已结束的会话，用户切过来时不该被塞图。
 */
export function shouldAutoOpenCuaScreenshot(
  isLastTurn: boolean | null | undefined,
  isRunning: boolean | null | undefined,
): boolean {
  return isLastTurn === true && isRunning === true
}
