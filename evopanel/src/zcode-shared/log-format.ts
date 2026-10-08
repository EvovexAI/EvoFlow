/**
 * 日志格式化工具
 *
 * 提供统一的时间戳和日志前缀格式化，供所有进程（main/host/server/renderer）使用。
 * 纯函数，无 Node.js 专有 API 依赖，浏览器环境安全。
 */

/**
 * 格式化时间戳为 "YYYY-MM-DD HH:mm:ss.mmm"
 */
export function formatTimestamp(date: Date = new Date()): string {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  const s = String(date.getSeconds()).padStart(2, "0");
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${y}-${mo}-${d} ${h}:${min}:${s}.${ms}`;
}

/**
 * 生成日志前缀，统一格式：
 * 有 PID: "[YYYY-MM-DD HH:mm:ss.mmm] [pid:12345] [source]"
 * 无 PID: "[YYYY-MM-DD HH:mm:ss.mmm] [source]"
 *
 * Node.js 进程传入 process.pid，浏览器端不传。
 */
export function formatLogPrefix(source: string, pid?: number): string {
  const ts = formatTimestamp();
  const pidPart = pid != null ? ` [pid:${pid}]` : "";
  return `[${ts}]${pidPart} [${source}]`;
}
