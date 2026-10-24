/**
 * V4 frames SSE 块解析（`event: v4.wire`）。
 * 与 transport 解耦，便于单测且避免拉进 ws-client。
 *
 * 缓冲上限必须远大于「历史会话整窗 snapshot」：Tauri `gateway_proxy_stream`
 * 按 32KiB 切块下发，单帧常跨多次 read 拼到数 MB。旧逻辑在 rest>512KiB
 * 时砍到尾 64KiB，会把尚未收完的 `event: v4.wire` 静默毁掉 → 客户端
 * subscribe ACK 成功但永远收不到 `frame_snapshot`，面板卡在「加载中」
 * （日志：`store=live` + `connecting_stuck` / earlyStaged=0）。
 */
/** 与 zcode initial staging 量级对齐；正常 snapshot 远小于此。 */
const V4_WIRE_SSE_REST_MAX_BYTES = 32 * 1024 * 1024;

export type ParseV4WireSseHooks = {
  /** 未收齐的 SSE 尾缓冲字节数（跨 chunk 拼大 snapshot 时会涨）。 */
  onIncompleteRest?: (bytes: number) => void;
  /** 刚解出一帧完整 v4.wire 的 data 字节数。 */
  onFrameBytes?: (bytes: number) => void;
};

export function parseV4WireSseBlocks(
  buf: string,
  onWire: (data: string) => void,
  hooks?: ParseV4WireSseHooks,
): string {
  let rest = String(buf || "").replace(/\r\n/g, "\n");
  let sep: number;
  while ((sep = rest.indexOf("\n\n")) >= 0) {
    const block = rest.slice(0, sep);
    rest = rest.slice(sep + 2);
    if (!block.trim() || block.trimStart().startsWith(":")) continue;
    let eventName = "";
    const dataLines: string[] = [];
    for (const raw of block.split("\n")) {
      const line = raw.replace(/\r$/, "");
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (eventName !== "v4.wire" || !dataLines.length) continue;
    const payload = dataLines.join("\n");
    if (payload) {
      try {
        hooks?.onFrameBytes?.(payload.length);
      } catch {
        /* ignore */
      }
      onWire(payload);
    }
  }
  if (rest.length > 0) {
    try {
      hooks?.onIncompleteRest?.(rest.length);
    } catch {
      /* ignore */
    }
  }
  if (rest.length > V4_WIRE_SSE_REST_MAX_BYTES) {
    // 极端失控流才丢最旧前缀；保留 1MiB 尾部尝试重新对齐到下一事件边界。
    rest = rest.slice(-1024 * 1024);
  }
  return rest;
}
