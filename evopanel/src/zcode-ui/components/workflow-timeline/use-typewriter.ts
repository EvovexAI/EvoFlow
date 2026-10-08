import { useEffect, useRef, useState } from "react";

/**
 * 草稿的笔。
 *
 * 模型的脚本按块到达，扫描器看到的是跳变：一整个 `phase("implement")` 在一个 delta 里，有时
 * 两个阶段一起到。笔把跳变还原成书写：一次只写一站、每字 `PEN_MS`，写完一站停 `PEN_GAP_MS`
 * 再揭示下一站——笔没到的站还不在轨道上，哪怕扫描器已经知道它。名字在写到一半时变长（未闭合的
 * `phase("ver` 又来了字）笔接着写；名字变短或前缀变了（不该发生，但流式下要稳）退到公共前缀。
 *
 * `names` 是扫描器当前的站名序列；undefined 表示不是草稿，钩子静默。计时只认**内容**变化
 * （按内容键控），脚本每来一块都换一个数组也不会把正在走的笔打断。
 * `prefers-reduced-motion: reduce` 下整站立即写完（仍一站一站揭示，只是不逐字）。
 *
 * 修订（GUI 崩溃 React #185 的根因）：
 * 笔只在**有站可揭示**时揭示。「还没有任何站时立即揭示」不看站数的话，空草稿（脚本开头的 `meta`
 * 还没写到第一个 `phase(`）会揭示一个不存在的站、下一轮被裁回 0、再揭示……在 effect 里无限 setState。
 * 这个空转本身只烧 CPU，但它让 React 手里永远有一笔待处理的更新；投影帧一旦积压成几十次连续的
 * 同步提交，嵌套更新计数就过 50，React 抛 #185，整块聊天区被错误边界接管。
 */
export const PEN_MS = 24;
export const PEN_GAP_MS = 120;

export interface TypewriterState {
  /** 已揭示的站数（笔到过的站）；后面的站还不在轨道上。 */
  visible: number;
  /** 每个已揭示站已写出的字符数。 */
  shown: readonly number[];
  /** 笔追上了流（没有可写的字、没有可揭示的站）：光标闪烁。 */
  idle: boolean;
}

interface PenState {
  visible: number;
  shown: number[];
}

const SILENT: TypewriterState = { idle: false, shown: [], visible: 0 };

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
}

/** 站名变了（变短 / 前缀变了 / 站数变少）时把笔退回到仍然成立的位置；没变就原样返回。 */
function reconcile(
  state: PenState,
  names: readonly string[],
  previous: readonly string[],
): PenState {
  const visible = Math.min(state.visible, names.length);
  let changed = visible !== state.visible;
  const shown = state.shown.slice(0, visible).map((count, i) => {
    const next = Math.min(count, commonPrefix(previous[i] ?? "", names[i]!));
    if (next !== count) changed = true;
    return next;
  });
  return changed ? { shown, visible } : state;
}

/**
 * 已揭示各站写出的字数。reduced-motion 下整站算写完，**在渲染时派生**而不是 effect 里再 setState 一轮：
 * 站名每个 delta 都在变长，effect 里的那次 setState 恰好落在投影帧的同步提交里，每帧都给嵌套更新计数
 * 记一笔。
 */
function shownOf(state: PenState, names: readonly string[], reduced: boolean): readonly number[] {
  return reduced ? state.shown.map((_, i) => names[i]?.length ?? 0) : state.shown;
}

export function useTypewriter(names: readonly string[] | undefined): TypewriterState {
  const [state, setState] = useState<PenState>({ shown: [], visible: 0 });
  // 分隔符是 NUL（站名里不会出现），["a b"] 与 ["a", "b"] 才不会撞成同一个键。源码里不能直接写一个
  // 裸 NUL 字节，git 把整个文件当二进制看；改成转义写法，内容不变。
  const key = names?.join("\u0000");
  const namesRef = useRef<readonly string[]>([]);
  const lastRef = useRef<readonly string[]>([]);
  if (names !== undefined) namesRef.current = names;

  useEffect(() => {
    if (key === undefined) return undefined;
    const current = namesRef.current;
    const previous = lastRef.current;
    lastRef.current = current;
    const pen = reconcile(state, current, previous);
    if (pen !== state) {
      setState(pen);
      return undefined;
    }
    const reduced = prefersReducedMotion();
    const at = pen.visible - 1;
    const target = at >= 0 ? current[at]! : undefined;
    const written = target === undefined ? 0 : (shownOf(pen, current, reduced)[at] ?? 0);
    if (target !== undefined && written < target.length) {
      // 逐字写当前站（reduced-motion 下 written 已经是整站，不会进到这里）。
      const timer = setTimeout(() => {
        const shown = pen.shown.slice();
        shown[at] = written + 1;
        setState({ shown, visible: pen.visible });
      }, PEN_MS);
      return () => clearTimeout(timer);
    }
    // 当前站写完了（或还没有站）：**有下一站才揭示**——空草稿什么都不做。
    if (current.length <= pen.visible) return undefined;
    const reveal = () => setState({ shown: [...pen.shown, 0], visible: pen.visible + 1 });
    if (target === undefined) {
      reveal();
      return undefined;
    }
    const timer = setTimeout(reveal, PEN_GAP_MS);
    return () => clearTimeout(timer);
  }, [key, state]);

  if (names === undefined) return SILENT;
  const shown = shownOf(state, names, prefersReducedMotion());
  const at = state.visible - 1;
  const idle = at >= 0 && state.visible === names.length && (shown[at] ?? 0) >= names[at]!.length;
  return { idle, shown, visible: state.visible };
}
