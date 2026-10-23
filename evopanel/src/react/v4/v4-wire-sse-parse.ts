/**
 * V4 frames SSE 块解析（`event: v4.wire`）。
 * 与 transport 解耦，便于单测且避免拉进 ws-client。
 */
export function parseV4WireSseBlocks(buf: string, onWire: (data: string) => void): string {
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
    if (payload) onWire(payload);
  }
  if (rest.length > 512 * 1024) rest = rest.slice(-64 * 1024);
  return rest;
}
