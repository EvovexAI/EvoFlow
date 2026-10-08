/**
 * v4 命令 ack 可观测性：生产构建下 renderer 日志整体关闭（见 ui/logger.ts），
 * e2e/现场排查需要一个可 probe 的收口。这里把每条命令的 ack 摘要写进 window 上的
 * 有界环形缓冲（与 __zcodeSessionStoreE2E 同口径的调试面），不含消息正文等重 payload。
 */
interface V4CommandAckSummary {
  type: string;
  status: string;
  reasonCode?: string;
  revisionAtDecision?: number;
  at: number;
}

const MAX_ACK_ENTRIES = 50;

type V4AckDebugWindow = Window & {
  __zcodeV4CommandAcksE2E?: V4CommandAckSummary[];
};

export function recordV4CommandAck(summary: V4CommandAckSummary): void {
  if (typeof window === "undefined") return;
  const host = window as V4AckDebugWindow;
  const buffer = (host.__zcodeV4CommandAcksE2E ??= []);
  buffer.push(summary);
  if (buffer.length > MAX_ACK_ENTRIES) {
    buffer.splice(0, buffer.length - MAX_ACK_ENTRIES);
  }
}
