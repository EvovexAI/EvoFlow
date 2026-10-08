import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { createGunzip, gzip } from "node:zlib";
import { normalizeSkillSyncRelativePath, resolveSkillSyncPathWithin } from "./skillSyncPath.js";
import { createSkillSyncSizeLimitError } from "./skillSyncErrors.js";

const gzipAsync = promisify(gzip);
const TAR_BLOCK_SIZE = 512;
const TAR_END_BLOCK_BYTES = TAR_BLOCK_SIZE * 2;

interface SkillSyncArchiveEntry {
  sourcePath: string;
  archivePath: string;
}

interface SkillSyncArchiveExtractOptions {
  maxExtractedBytes?: number;
}

export async function createSkillSyncArchive(
  entries: readonly SkillSyncArchiveEntry[],
): Promise<Uint8Array> {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    await appendTarEntry(parts, entry.sourcePath, normalizeArchivePath(entry.archivePath));
  }
  parts.push(Buffer.alloc(TAR_END_BLOCK_BYTES));
  return await gzipAsync(Buffer.concat(parts));
}

export async function extractSkillSyncArchive(
  archive: Uint8Array,
  targetDir: string,
  options: SkillSyncArchiveExtractOptions = {},
): Promise<void> {
  const targetRoot = resolve(targetDir);
  await mkdir(targetRoot, { recursive: true });
  const maxExtractedBytes = options.maxExtractedBytes;
  const input = Readable.from([Buffer.from(archive)]);
  const gunzipStream = createGunzip();
  const reader = new TarStreamReader(input.pipe(gunzipStream));
  let extractedBytes = 0;

  try {
    while (true) {
      const header = await reader.readExactly(TAR_BLOCK_SIZE);
      if (header === null) {
        break;
      }
      if (header.every((byte) => byte === 0)) {
        await reader.drain();
        break;
      }

      const size = readTarOctal(header, 124, 12);
      if (!Number.isSafeInteger(size) || size < 0) {
        throw new Error("invalid skill sync archive entry size");
      }
      const typeFlag = readTarString(header, 156, 1) || "0";
      const archivePath = normalizeArchivePath(readTarEntryPath(header));
      const targetPath = resolveWithin(targetRoot, archivePath);

      if (typeFlag === "5") {
        await reader.skipExactly(tarPaddedBytes(size));
        await mkdir(targetPath, { recursive: true });
        continue;
      }

      if (typeFlag !== "0" && typeFlag !== "\0") {
        throw new Error(`unsupported skill archive entry type: ${typeFlag}`);
      }

      const nextExtractedBytes = extractedBytes + size;
      if (
        !Number.isSafeInteger(nextExtractedBytes) ||
        (maxExtractedBytes !== undefined && nextExtractedBytes > maxExtractedBytes)
      ) {
        throw createSkillSyncSizeLimitError({
          actualBytes: nextExtractedBytes,
          maxBytes: maxExtractedBytes ?? Number.MAX_SAFE_INTEGER,
          phase: "extracted-content",
        });
      }

      const data = await reader.readExactly(size);
      if (data === null) {
        throw new Error("truncated skill sync archive entry");
      }
      await reader.skipExactly(tarPaddedBytes(size) - size);
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, data);
      extractedBytes = nextExtractedBytes;
    }
  } finally {
    // 发现大小超限或归档损坏时主动销毁流，避免 gzip 在后台继续膨胀或触发未处理错误。
    input.destroy();
    gunzipStream.destroy();
  }
}

function tarPaddedBytes(size: number): number {
  return Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
}

class TarStreamReader {
  private readonly iterator: AsyncIterator<Buffer>;
  private readonly chunks: Buffer[] = [];
  private bufferedBytes = 0;
  private done = false;

  constructor(stream: AsyncIterable<Buffer>) {
    this.iterator = stream[Symbol.asyncIterator]();
  }

  async readExactly(byteCount: number): Promise<Buffer | null> {
    if (byteCount === 0) {
      return Buffer.alloc(0);
    }
    await this.fill(byteCount);
    if (this.bufferedBytes === 0) {
      return null;
    }
    if (this.bufferedBytes < byteCount) {
      throw new Error("truncated skill sync archive");
    }

    const output = Buffer.allocUnsafe(byteCount);
    this.consume(byteCount, output);
    return output;
  }

  async skipExactly(byteCount: number): Promise<void> {
    if (byteCount === 0) {
      return;
    }
    await this.fill(byteCount);
    if (this.bufferedBytes < byteCount) {
      throw new Error("truncated skill sync archive");
    }
    this.consume(byteCount);
  }

  async drain(): Promise<void> {
    while (!this.done) {
      const next = await this.iterator.next();
      if (next.done) {
        this.done = true;
      }
    }
  }

  private async fill(byteCount: number): Promise<void> {
    while (!this.done && this.bufferedBytes < byteCount) {
      const next = await this.iterator.next();
      if (next.done) {
        this.done = true;
        break;
      }
      if (next.value.length === 0) {
        continue;
      }
      this.chunks.push(next.value);
      this.bufferedBytes += next.value.length;
    }
  }

  private consume(byteCount: number, output?: Buffer): void {
    let remaining = byteCount;
    let outputOffset = 0;
    while (remaining > 0) {
      const chunk = this.chunks[0];
      if (!chunk) {
        throw new Error("truncated skill sync archive");
      }
      const consumed = Math.min(remaining, chunk.length);
      if (output) {
        chunk.copy(output, outputOffset, 0, consumed);
        outputOffset += consumed;
      }
      if (consumed === chunk.length) {
        this.chunks.shift();
      } else {
        this.chunks[0] = chunk.subarray(consumed);
      }
      this.bufferedBytes -= consumed;
      remaining -= consumed;
    }
  }
}

async function appendTarEntry(
  parts: Buffer[],
  sourcePath: string,
  archivePath: string,
): Promise<void> {
  const sourceStat = await lstat(sourcePath);

  if (sourceStat.isDirectory()) {
    const directoryEntryPath = ensureTrailingSlash(archivePath);
    parts.push(
      createTarHeader({
        entryPath: directoryEntryPath,
        mode: sourceStat.mode,
        mtimeSeconds: Math.floor(sourceStat.mtimeMs / 1000),
        size: 0,
        typeFlag: "5",
      }),
    );
    const children = (await readdir(sourcePath, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const child of children) {
      await appendTarEntry(
        parts,
        join(sourcePath, child.name),
        normalizeArchivePath(posix.join(archivePath, child.name)),
      );
    }
    return;
  }

  if (!sourceStat.isFile() && !sourceStat.isDirectory()) {
    throw new Error(`unsupported skill archive source: ${sourcePath}`);
  }

  const content = await readFile(sourcePath);
  parts.push(
    createTarHeader({
      entryPath: archivePath,
      mode: sourceStat.mode,
      mtimeSeconds: Math.floor(sourceStat.mtimeMs / 1000),
      size: content.length,
      typeFlag: "0",
    }),
    content,
    Buffer.alloc(Math.ceil(content.length / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE - content.length),
  );
}

function createTarHeader(options: {
  entryPath: string;
  mode: number;
  mtimeSeconds: number;
  size: number;
  typeFlag: "0" | "5";
}): Buffer {
  const header = Buffer.alloc(TAR_BLOCK_SIZE);
  const { name, prefix } = splitTarEntryPath(options.entryPath);

  writeTarString(header, name, 0, 100);
  writeTarOctal(header, options.mode & 0o777, 100, 8);
  writeTarOctal(header, 0, 108, 8);
  writeTarOctal(header, 0, 116, 8);
  writeTarOctal(header, options.size, 124, 12);
  writeTarOctal(header, options.mtimeSeconds, 136, 12);
  header.fill(0x20, 148, 156);
  writeTarString(header, options.typeFlag, 156, 1);
  writeTarString(header, "ustar", 257, 6);
  writeTarString(header, "00", 263, 2);
  writeTarString(header, "zcode", 265, 32);
  writeTarString(header, "zcode", 297, 32);
  writeTarString(header, prefix, 345, 155);
  writeTarChecksum(
    header,
    header.reduce((sum, byte) => sum + byte, 0),
  );
  return header;
}

function splitTarEntryPath(entryPath: string): { name: string; prefix: string } {
  if (Buffer.byteLength(entryPath) <= 100) {
    return { name: entryPath, prefix: "" };
  }

  const segments = entryPath.split("/");
  for (let index = segments.length - 1; index > 0; index -= 1) {
    const prefix = segments.slice(0, index).join("/");
    const name = segments.slice(index).join("/");
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }

  throw new Error(`skill archive path is too long: ${entryPath}`);
}

function readTarEntryPath(header: Buffer): string {
  const name = readTarString(header, 0, 100);
  const prefix = readTarString(header, 345, 155);
  return prefix ? `${prefix}/${name}` : name;
}

function readTarString(buffer: Buffer, offset: number, length: number): string {
  const slice = buffer.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8");
}

function readTarOctal(buffer: Buffer, offset: number, length: number): number {
  const raw = readTarString(buffer, offset, length).trim();
  return raw ? Number.parseInt(raw, 8) : 0;
}

function writeTarString(buffer: Buffer, value: string, offset: number, length: number): void {
  buffer.write(value, offset, length, "utf8");
}

function writeTarOctal(buffer: Buffer, value: number, offset: number, length: number): void {
  const encoded = Math.trunc(value)
    .toString(8)
    .padStart(length - 1, "0");
  writeTarString(buffer, encoded.slice(-(length - 1)), offset, length - 1);
}

function writeTarChecksum(buffer: Buffer, checksum: number): void {
  const encoded = checksum.toString(8).padStart(6, "0").slice(-6);
  writeTarString(buffer, encoded, 148, 6);
  buffer[154] = 0;
  buffer[155] = 0x20;
}

function normalizeArchivePath(path: string): string {
  return normalizeSkillSyncRelativePath(path, {
    unsafePathLabel: "unsafe skill archive path",
  });
}

function resolveWithin(targetRoot: string, archivePath: string): string {
  return resolveSkillSyncPathWithin(targetRoot, archivePath, {
    unsafePathLabel: "unsafe skill archive path",
  });
}

function ensureTrailingSlash(path: string): string {
  return path.endsWith("/") ? path : `${path}/`;
}
