import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { cn } from "@/components/lib/utils.js";
import { resolveConversationShareSelectionScrimMotion } from "@/v4/conversationShareModeMotion.js";

export function ConversationShareSelectionScrim({
  visible,
  interactive = false,
  onBackdropClick,
}: {
  visible: boolean;
  interactive?: boolean;
  onBackdropClick?: () => void;
}) {
  const prefersReducedMotion = useReducedMotion() === true;
  const motionConfig = resolveConversationShareSelectionScrimMotion(prefersReducedMotion);

  return (
    <AnimatePresence initial={false}>
      {visible ? (
        <motion.div
          key="conversation-share-selection-scrim"
          data-testid="conversation-share-selection-scrim"
          data-conversation-share-mode-motion="scrim"
          data-conversation-share-backdrop-interactive={interactive ? "true" : "false"}
          className={cn(
            "absolute inset-0 z-10 bg-background/60",
            interactive ? "pointer-events-auto" : "pointer-events-none",
          )}
          onClick={interactive ? onBackdropClick : undefined}
          initial={motionConfig.initial}
          animate={motionConfig.animate}
          exit={motionConfig.exit}
          transition={motionConfig.transition}
        />
      ) : null}
    </AnimatePresence>
  );
}
