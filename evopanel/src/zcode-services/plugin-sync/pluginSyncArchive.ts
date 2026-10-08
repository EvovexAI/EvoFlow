import { chmod, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import { normalizePluginSyncRelativePath, resolvePluginSyncPathWithin } from "./pluginSyncPath.js";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const TAR_BLOCK_SIZE = 512;
const TAR_END_BLOCK_BYTES = TAR_BLOCK_SIZE * 2;

export const PLUGIN_SYNC_METADATA_ARCHIVE_PATH = ".zcode-plugin-sync.json";

type PluginSyncArchiveEntry =
  | {
      sourcePath: string;
      archivePath: string;
    }
  | {
      content: string | Uint8Array;
      archivePath: string;
      mode?: number;
      mtimeMs?: number;
    };

export interface PluginSyncArchiveMetadata {
  plugins: Array<{
    name: string;
    pluginId: string;
    directoryName: string;
    enabled?: boolean;
  }>;
  marketplaceSources?: Array<{
    marketplaceId: string;
    directoryName: string;
  }>;
}

interface PluginSyncArchiveExtractOptions {
  maxExtractedBytes?: number;
}

export async function createPluginSyncArchive(params: {
  entries: readonly PluginSyncArchiveEntry[];
  metadata: PluginSyncArchiveMetadata;
}): Promise<Uint8Array> {
  const parts: Buffer[] = [];
  for (const entry of params.entries) {
    if ("sourcePath" in entry) {
      await appendTarEntry(parts, entry.sourcePath, normalizeArchivePath(entry.archivePath));
    } else {
      appendTarFile(
        parts,
        normalizeArchivePath(entry.archivePath),
        typeof entry.content === "string"
          ? Buffer.from(entry.content, "utf-8")
          : Buffer.from(entry.content),
        entry.mode,
        entry.mtimeMs,
      );
    }
  }
  appendTarFile(
    parts,
    PLUGIN_SYNC_METADATA_ARCHIVE_PATH,
    Buffer.from(`${JSON.stringify(params.metadata, null, 2)}\n`, "utf-8"),
  );
  parts.push(Buffer.alloc(TAR_END_BLOCK_BYTES));
  return await gzipAsync(Buffer.concat(parts));
}

export async function extractPluginSyncArchive(
  archive: Uint8Array,
  targetDir: string,
  options: PluginSyncArchiveExtractOptions = {},
): Promise<void> {
  const targetRoot = resolve(targetDir);
  await mkdir(targetRoot, { recursive: true });
  const maxExtractedBytes = options.maxExtractedBytes;
  const buffer = await gunzipWithLimit(archive, maxExtractedBytes);
  let offset = 0;
  let extractedBytes = 0;

  while (offset + TAR_BLOCK_SIZE <= buffer.length) {
    const header = buffer.subarray(offset, offset + TAR_BLOCK_SIZE);
    offset += TAR_BLOCK_SIZE;
    if (header.every((byte) => byte === 0)) {
      break;
    }

    const size = readTarOctal(header, 124, 12);
    const dataStart = offset;
    const dataEnd = dataStart + size;
    if (dataEnd > buffer.length) {
      throw new Error("truncated plugin sync archive entry");
    }
    const data = buffer.subarray(dataStart, dataEnd);
    offset = dataStart + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;

    const typeFlag = readTarString(header, 156, 1) || "0";
    const archivePath = normalizeArchivePath(readTarEntryPath(header));
    const targetPath = resolveWithin(targetRoot, archivePath);
    if (typeFlag === "5") {
      await mkdir(targetPath, { recursive: true });
    } else if (typeFlag === "0" || typeFlag === "\0") {
      extractedBytes += size;
      if (maxExtractedBytes !== undefined && extractedBytes > maxExtractedBytes) {
        throw new Error(
          `plugin sync archive exceeds limit: ${extractedBytes}/${maxExtractedBytes}`,
        );
      }
      const fileMode = readTarMode(header);
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, data, { mode: fileMode });
      if (process.platform !== "win32") {
        // writeFile 新建文件会受远端 umask 影响；plugin 脚本的可执行位必须按归档 header 恢复。
        await chmod(targetPath, fileMode);
      }
    } else {
      throw new Error(`unsupported plugin archive entry type: ${typeFlag}`);
    }
  }
}

async function gunzipWithLimit(
  archive: Uint8Array,
  maxExtractedBytes: number | undefined,
): Promise<Buffer> {
  if (maxExtractedBytes === undefined) {
    return await gunzipAsync(Buffer.from(archive));
  }
  const maxTarBytes = maxExtractedBytes + TAR_END_BLOCK_BYTES + TAR_BLOCK_SIZE * 512;
  try {
    return await gunzipAsync(Buffer.from(archive), {
      maxOutputLength: maxTarBytes,
    });
  } catch (error) {
    throw new Error(
      `plugin sync archive exceeds limit: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
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

  if (!sourceStat.isFile()) {
    throw new Error(`unsupported plugin archive source: ${sourcePath}`);
  }

  appendTarFile(
    parts,
    archivePath,
    await readFile(sourcePath),
    sourceStat.mode,
    sourceStat.mtimeMs,
  );
}

function appendTarFile(
  parts: Buffer[],
  archivePath: string,
  content: Buffer,
  mode = 0o644,
  mtimeMs = Date.now(),
): void {
  parts.push(
    createTarHeader({
      entryPath: normalizeArchivePath(archivePath),
      mode,
      mtimeSeconds: Math.floor(mtimeMs / 1000),
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

  throw new Error(`plugin archive path is too long: ${entryPath}`);
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

function readTarMode(header: Buffer): number {
  const mode = readTarOctal(header, 100, 8);
  if (!Number.isFinite(mode) || mode <= 0) {
    return 0o644;
  }
  return mode & 0o777;
}

function writeTarString(buffer: Buffer, value: string, offset: number, length: number): void {
  const source = Buffer.from(value, "utf8");
  if (source.length > length) {
    throw new Error(`plugin archive header value is too long: ${value}`);
  }
  source.copy(buffer, offset);
}

function writeTarOctal(buffer: Buffer, value: number, offset: number, length: number): void {
  const encoded = value.toString(8).padStart(length - 1, "0");
  writeTarString(buffer, encoded, offset, length - 1);
  buffer[offset + length - 1] = 0;
}

function writeTarChecksum(buffer: Buffer, checksum: number): void {
  const encoded = checksum.toString(8).padStart(6, "0");
  writeTarString(buffer, encoded, 148, 6);
  buffer[154] = 0;
  buffer[155] = 0x20;
}

function ensureTrailingSlash(path: string): string {
  return path.endsWith("/") ? path : `${path}/`;
}

function normalizeArchivePath(path: string): string {
  return normalizePluginSyncRelativePath(path, {
    unsafePathLabel: "unsafe plugin archive path",
  });
}

function resolveWithin(targetRoot: string, archivePath: string): string {
  return resolvePluginSyncPathWithin(targetRoot, archivePath, {
    unsafePathLabel: "unsafe plugin archive path",
  });
}
