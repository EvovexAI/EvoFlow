// V4 wire 的跨 Node/browser 二进制纯函数。独立成小模块，避免 codec 主文件
// 同时承载 schema、分片状态机和编码细节。
import { z } from "zod";

export const topicWireBase64Schema = z
  .string()
  .min(4)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u);

export function crc32WireBytes(bytes: Uint8Array): string {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function encodeWireBytesBase64(bytes: Uint8Array): string {
  let result = "";
  let block: string[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 3) {
    const a = bytes[offset] ?? 0;
    const hasB = offset + 1 < bytes.byteLength;
    const hasC = offset + 2 < bytes.byteLength;
    const b = hasB ? (bytes[offset + 1] ?? 0) : 0;
    const c = hasC ? (bytes[offset + 2] ?? 0) : 0;
    block.push(
      BASE64_ALPHABET[a >>> 2]!,
      BASE64_ALPHABET[((a & 0x03) << 4) | (b >>> 4)]!,
      hasB ? BASE64_ALPHABET[((b & 0x0f) << 2) | (c >>> 6)]! : "=",
      hasC ? BASE64_ALPHABET[c & 0x3f]! : "=",
    );
    if (block.length >= 16_384) {
      result += block.join("");
      block = [];
    }
  }
  return result + block.join("");
}

export function decodeWireBase64(value: string): Uint8Array | null {
  if (!topicWireBase64Schema.safeParse(value).success) return null;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const output = new Uint8Array((value.length / 4) * 3 - padding);
  let writeOffset = 0;
  for (let offset = 0; offset < value.length; offset += 4) {
    const a = BASE64_ALPHABET.indexOf(value[offset]!);
    const b = BASE64_ALPHABET.indexOf(value[offset + 1]!);
    const c = value[offset + 2] === "=" ? 0 : BASE64_ALPHABET.indexOf(value[offset + 2]!);
    const d = value[offset + 3] === "=" ? 0 : BASE64_ALPHABET.indexOf(value[offset + 3]!);
    if (a < 0 || b < 0 || c < 0 || d < 0) return null;
    const combined = (a << 18) | (b << 12) | (c << 6) | d;
    if (writeOffset < output.length) output[writeOffset++] = combined >>> 16;
    if (writeOffset < output.length) {
      output[writeOffset++] = (combined >>> 8) & 0xff;
    }
    if (writeOffset < output.length) output[writeOffset++] = combined & 0xff;
  }
  return output;
}
