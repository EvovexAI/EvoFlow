function byteToHex(byte: number): string {
  return byte.toString(16).padStart(2, "0");
}

/** 普通 main command 与 background wake 共用 UUID v7（48-bit 时间戳 + 随机位）。 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const ts = BigInt(now);
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  const hex = Array.from(bytes, byteToHex).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function formatUuid(bytes: Uint8Array): string {
  const normalized = new Uint8Array(bytes);
  normalized[6] = (normalized[6]! & 0x0f) | 0x40;
  normalized[8] = (normalized[8]! & 0x3f) | 0x80;

  const segments = [
    normalized.slice(0, 4),
    normalized.slice(4, 6),
    normalized.slice(6, 8),
    normalized.slice(8, 10),
    normalized.slice(10, 16),
  ];

  return segments.map((segment) => Array.from(segment, byteToHex).join("")).join("-");
}

export function createUuid(): string {
  const runtimeCrypto = globalThis.crypto;
  if (runtimeCrypto?.randomUUID) {
    return runtimeCrypto.randomUUID();
  }

  if (runtimeCrypto?.getRandomValues) {
    const bytes = new Uint8Array(16);
    runtimeCrypto.getRandomValues(bytes);
    return formatUuid(bytes);
  }

  // 部分移动端 WebView 只有 `crypto` 对象但没有 `randomUUID()`，
  // 之前 UI 初始化直接调用会在首屏崩掉。这里退回到最小可用的随机实现，
  // 保证移动端至少能生成 tab / history / request 所需的临时 ID。
  const bytes = new Uint8Array(16);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256);
  }
  return formatUuid(bytes);
}
