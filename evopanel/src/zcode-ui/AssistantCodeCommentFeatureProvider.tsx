import { createContext, useContext, type ReactNode } from "react";

const DEFAULT_ASSISTANT_CODE_COMMENT_CARDS_ENABLED = false;
const AssistantCodeCommentFeatureContext = createContext(
  DEFAULT_ASSISTANT_CODE_COMMENT_CARDS_ENABLED,
);

export function AssistantCodeCommentFeatureProvider({
  children,
  enabled = DEFAULT_ASSISTANT_CODE_COMMENT_CARDS_ENABLED,
}: {
  children: ReactNode;
  enabled?: boolean;
}) {
  return (
    <AssistantCodeCommentFeatureContext.Provider value={enabled}>
      {children}
    </AssistantCodeCommentFeatureContext.Provider>
  );
}

export function useAssistantCodeCommentFeatureEnabled(): boolean {
  return useContext(AssistantCodeCommentFeatureContext);
}
