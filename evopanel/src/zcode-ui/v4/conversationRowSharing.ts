// Conversation row 结构共享（docs/performance/conversation-row-structural-sharing.md）。
//
// Bug 原因：store 收到整份 snapshot / row.upserted 时换上新反序列化的行对象，历史
// snapshot 之间零共享；SessionPane 闭包链又会留住上百份历史 snapshot，同一个 200KB
// 工具 inputText 因此在 heap 里存了一百多份。这里在 UI store 层把“值深相等”的部分换回
// 旧引用，只复用身份、不改语义，所以不进 @zcode/shared 的 apply（客户端 apply 不加语义分支）。
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * 返回与 next 深相等的值，尽量复用 prev 中相等的部分：整体相等返回 prev，部分相等时
 * 新建外壳挂回 prev 的子值（包括内容相同的旧字符串引用）。绝不修改 next——它可能与
 * apply 产出的其他快照共享结构。只递归 JSON 形态（plain object / 数组）。
 */
export function shareStructure<T>(prev: unknown, next: T): T {
  if (Object.is(prev, next)) return prev as T;
  if (Array.isArray(next)) {
    if (!Array.isArray(prev)) return next;
    let allPrev = prev.length === next.length;
    let changed = false;
    const out = next.map((item: unknown, index) => {
      const shared = index < prev.length ? shareStructure(prev[index], item) : item;
      if (shared !== item) changed = true;
      if (index >= prev.length || shared !== prev[index]) allPrev = false;
      return shared;
    });
    if (allPrev) return prev as T;
    return (changed ? out : next) as T;
  }
  if (isPlainObject(next)) {
    if (!isPlainObject(prev)) return next;
    const keys = Object.keys(next);
    let allPrev = keys.length === Object.keys(prev).length;
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      const item = next[key];
      const hasPrev = Object.hasOwn(prev, key);
      const shared = hasPrev ? shareStructure(prev[key], item) : item;
      if (shared !== item) changed = true;
      if (!hasPrev || shared !== prev[key]) allPrev = false;
      out[key] = shared;
    }
    if (allPrev) return prev as T;
    return (changed ? out : next) as T;
  }
  // 原始值：内容相同的字符串换回 prev 引用，让 next 的副本可被 GC。
  return (typeof next === "string" && prev === next ? prev : next) as T;
}

/**
 * 跨 store 的行池：SessionDataLayer 持有，生命周期长于单个 store（keep-warm 过期冷打开
 * 会新建 store，但旧 snapshot 可能仍被留住，要让新行复用它们）。只持 WeakRef，不延长行寿命。
 */
export class ConversationRowPool {
  private readonly rows = new Map<string, WeakRef<ConversationRow>>();
  private readonly registry = new FinalizationRegistry<{
    key: string;
    ref: WeakRef<ConversationRow>;
  }>(({ key, ref }) => {
    // 只删仍指向已回收行的条目，避免误删同 key 后来登记的新行。
    if (this.rows.get(key) === ref) this.rows.delete(key);
  });

  private key(topic: string, rowId: number): string {
    return `${topic}\u0000${rowId}`;
  }

  /** 只登记不比较：流式 row.delta 的新字符串本来就是新的，逐帧深比较是纯开销。 */
  remember(topic: string, row: ConversationRow): void {
    const key = this.key(topic, row.rowId);
    if (this.rows.get(key)?.deref() === row) return;
    const ref = new WeakRef(row);
    this.rows.set(key, ref);
    this.registry.register(row, { key, ref });
  }

  shareRow(topic: string, row: ConversationRow): ConversationRow {
    const prev = this.rows.get(this.key(topic, row.rowId))?.deref();
    const shared = prev ? shareStructure(prev, row) : row;
    this.remember(topic, shared);
    return shared;
  }

  /** 逐行共享；每行都与 prevWindow 同位行相同时复用 prevWindow 数组。 */
  shareWindow(
    topic: string,
    rows: ConversationRow[],
    prevWindow?: readonly ConversationRow[],
  ): ConversationRow[] {
    let allPrev = prevWindow !== undefined && prevWindow.length === rows.length;
    let changed = false;
    const out = rows.map((row, index) => {
      const shared = this.shareRow(topic, row);
      if (shared !== row) changed = true;
      if (allPrev && shared !== prevWindow![index]) allPrev = false;
      return shared;
    });
    if (allPrev) return prevWindow as ConversationRow[];
    return changed ? out : rows;
  }
}
