import type { Virtualizer } from "@tanstack/react-virtual";

type GroupedTaskVirtualizerScrollOptions = {
  adjustments?: number;
  behavior?: ScrollBehavior;
};

function isPotentialVerticalScrollContainer(overflowY: string): boolean {
  return /(auto|scroll|overlay)/.test(overflowY);
}

function scrollGroupedTaskVirtualizerToOffset<TScrollElement extends Element>(
  offset: number,
  { adjustments = 0, behavior }: GroupedTaskVirtualizerScrollOptions,
  instance: Virtualizer<TScrollElement, Element>,
) {
  const scrollElement = instance.scrollElement;
  if (!scrollElement) {
    return;
  }
  const toOffset = offset + adjustments;
  const isStaleInitialZeroSync =
    !instance.options.horizontal &&
    offset === 0 &&
    adjustments === 0 &&
    behavior === undefined &&
    scrollElement.scrollTop > 0 &&
    instance.scrollOffset === 0;
  if (isStaleInitialZeroSync) {
    // group 虚拟列表在外层滚动容器中途重新挂载时，react-virtual
    // 可能已在首个 layout effect 缓存默认 scrollOffset=0，随后 _willUpdate
    // 会把这个旧值 scrollTo(0) 到共享容器上，导致列表偶发回顶。
    return;
  }
  if (instance.options.horizontal) {
    scrollElement.scrollTo({ left: toOffset, behavior });
    return;
  }
  scrollElement.scrollTo({ top: toOffset, behavior });
}

export { isPotentialVerticalScrollContainer, scrollGroupedTaskVirtualizerToOffset };
