const RADIX_MIN_THUMB_SIZE = 18;
const CONVERSATION_SHARE_VISUAL_THUMB_SCALE = 0.5;

interface ConversationShareScrollbarMetricsInput {
  trackSize: number;
  viewportSize: number;
  contentSize: number;
  scrollOffset: number;
}

interface ConversationShareScrollbarIndicatorMetrics {
  visible: boolean;
  size: number;
  offset: number;
}

export function resolveConversationShareScrollbarIndicatorMetrics({
  trackSize,
  viewportSize,
  contentSize,
  scrollOffset,
}: ConversationShareScrollbarMetricsInput): ConversationShareScrollbarIndicatorMetrics {
  const safeTrackSize = Math.max(0, trackSize);
  const safeViewportSize = Math.max(0, viewportSize);
  const safeContentSize = Math.max(0, contentSize);
  const maxScrollOffset = Math.max(0, safeContentSize - safeViewportSize);

  if (safeTrackSize === 0 || safeViewportSize === 0 || maxScrollOffset === 0) {
    return { visible: false, size: 0, offset: 0 };
  }

  const radixThumbSize = Math.max(
    RADIX_MIN_THUMB_SIZE,
    safeTrackSize * (safeViewportSize / safeContentSize),
  );
  const size = Math.min(safeTrackSize, radixThumbSize * CONVERSATION_SHARE_VISUAL_THUMB_SCALE);
  const progress = Math.min(1, Math.max(0, scrollOffset / maxScrollOffset));

  return {
    visible: true,
    size,
    offset: progress * (safeTrackSize - size),
  };
}
