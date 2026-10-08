import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { JsonLineRecord } from "#src/session/claude-native/jsonLineRecord.js";

function parseJsonLine(filePath: string, line: string, lineNumber: number): JsonLineRecord {
  try {
    return JSON.parse(line) as JsonLineRecord;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`[claude-native] 解析 JSONL 失败 ${filePath}:${lineNumber} ${reason}`);
  }
}

export async function readJsonLinesFile(filePath: string): Promise<JsonLineRecord[]> {
  const raw = await readFile(filePath, "utf-8");
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  return lines.map((line, index) => parseJsonLine(filePath, line, index + 1));
}

export async function readJsonLinesFileHead(
  filePath: string,
  maxLines: number,
): Promise<JsonLineRecord[]> {
  if (maxLines <= 0) {
    return [];
  }

  const records: JsonLineRecord[] = [];
  const stream = createReadStream(filePath, { encoding: "utf-8" });
  const reader = createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  let lineNumber = 0;
  try {
    for await (const line of reader) {
      lineNumber += 1;
      if (line.trim().length === 0) {
        continue;
      }
      records.push(parseJsonLine(filePath, line, lineNumber));
      if (records.length >= maxLines) {
        break;
      }
    }
    return records;
  } finally {
    reader.close();
    stream.destroy();
  }
}
