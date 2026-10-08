import type { ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

const CONVERSATION_BOTTOM_DOCK_TRANSITION_OFFSET_PX = 32;
const CONVERSATION_BOTTOM_DOCK_ENTER_SCALE = 0.96;
const CONVERSATION_BOTTOM_DOCK_EXIT_SCALE = 0.97;
const CONVERSATION_BOTTOM_DOCK_ENTER_DURATION_SECONDS = 0.26;
const CONVERSATION_BOTTOM_DOCK_EXIT_DURATION_SECONDS = 0.18;
const CONVERSATION_BOTTOM_DOCK_TRANSITION_EASING = [0.23, 1, 0.32, 1] as const;

const CONVERSATION_BOTTOM_DOCK_VISIBLE_TRANSFORM = "translate3d(0, 0, 0) scale(1)";
const CONVERSATION_BOTTOM_DOCK_ENTER_TRANSFORM = `translate3d(0, ${CONVERSATION_BOTTOM_DOCK_TRANSITION_OFFSET_PX}px, 0) scale(${CONVERSATION_BOTTOM_DOCK_ENTER_SCALE})`;
const CONVERSATION_BOTTOM_DOCK_EXIT_TRANSFORM = `translate3d(0, ${CONVERSATION_BOTTOM_DOCK_TRANSITION_OFFSET_PX}px, 0) scale(${CONVERSATION_BOTTOM_DOCK_EXIT_SCALE})`;

function resolveConversationBottomDockMotion(prefersReducedMotion: boolean) {
  if (prefersReducedMotion) {
    return {
      initial: false as const,
      animate: {
        opacity: 1,
        transform: CONVERSATION_BOTTOM_DOCK_VISIBLE_TRANSFORM,
        transition: { duration: 0 },
      },
      exit: {
        opacity: 1,
        transform: CONVERSATION_BOTTOM_DOCK_VISIBLE_TRANSFORM,
        transition: { duration: 0 },
      },
    };
  }

  return {
    initial: {
      opacity: 0,
      transform: CONVERSATION_BOTTOM_DOCK_ENTER_TRANSFORM,
    },
    animate: {
      opacity: 1,
      transform: CONVERSATION_BOTTOM_DOCK_VISIBLE_TRANSFORM,
      transition: {
        duration: CONVERSATION_BOTTOM_DOCK_ENTER_DURATION_SECONDS,
        ease: CONVERSATION_BOTTOM_DOCK_TRANSITION_EASING,
      },
    },
    exit: {
      opacity: 0,
      transform: CONVERSATION_BOTTOM_DOCK_EXIT_TRANSFORM,
      transition: {
        duration: CONVERSATION_BOTTOM_DOCK_EXIT_DURATION_SECONDS,
        ease: CONVERSATION_BOTTOM_DOCK_TRANSITION_EASING,
      },
    },
  };
}

export function ConversationBottomDockTransition({
  mode,
  children,
}: {
  mode: "chat" | "confirmation";
  children: ReactNode;
}) {
  const prefersReducedMotion = useReducedMotion() === true;
  const motionConfig = resolveConversationBottomDockMotion(prefersReducedMotion);

  return (
    <div data-testid="conversation-bottom-dock-transition" className="grid w-full">
      {/* chat 与确认区高度不同；共享 grid 单元并底部对齐，避免父高度切换时退出层先跳位再动画。*/}
      <AnimatePresence initial={false} mode="sync">
        <motion.div
          key={mode}
          data-testid="conversation-bottom-dock-transition-layer"
          data-conversation-bottom-dock-mode={mode}
          // grid 子项默认 min-width:auto，最小尺寸等于内容的 min-content；
          // 隐式列轨道是 auto，其下限被这个最小尺寸顶住，于是面板收窄时 composer
          // 仍按 min-content（约 465px）撑开轨道，超出容器宽度后右侧被裁掉。
          // min-w-0 关掉自动最小尺寸，轨道才能跟随容器一起收缩。
          className="col-start-1 row-start-1 w-full min-w-0 origin-bottom self-end will-change-transform"
          initial={motionConfig.initial}
          animate={motionConfig.animate}
          exit={motionConfig.exit}
        >
          {children}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
