/**
 * 右栏文件预览文本 LRU 缓存。
 *
 * 目标：轮末空闲预取 + 重复点击秒开。桌面端命中后只需一次进程内 stat 校验
 * mtime（preview_stat_file），0 网络往返；Web 端没有本地 stat，调用方应跳过缓存。
 * 陈旧防护：mtime + total 双校验，不匹配即回源重读，绝不满页旧内容。
 */

export interface PreviewTextCacheEntry {
  content: string;
  offset: number;
  bytesRead: number;
  totalBytes: number;
  truncated: boolean;
  isBinary: boolean;
  /** 文件全尺寸（= totalBytes），与 mtimeMs 一起做陈旧校验 */
  total: number;
  mtimeMs: number;
}

const MAX_ENTRIES = 24;

const store = new Map<string, PreviewTextCacheEntry>();

export function previewTextCacheKey(params: {
  resolvedPath: string;
  offset: number;
  length: number;
}): string {
  return `${String(params.resolvedPath || "")}|${params.offset}|${params.length}`;
}

export function readPreviewTextCache(key: string): PreviewTextCacheEntry | undefined {
  const hit = store.get(key);
  if (!hit) return undefined;
  // LRU touch：delete + set 保持插入序，淘汰最旧
  store.delete(key);
  store.set(key, hit);
  return hit;
}

export function writePreviewTextCache(key: string, entry: PreviewTextCacheEntry): void {
  store.delete(key);
  store.set(key, entry);
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

/** 测试与调试用。 */
export function clearPreviewTextCache(): void {
  store.clear();
}
