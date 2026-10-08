import { useCallback, useEffect, useMemo, useState } from "react";
import {
  PPTX_ELEMENT_REFERENCE_ADD_TO_CHAT_EVENT,
  addPptxElementReference,
  getPptxElementReferenceWorkspaceKey,
  isPptxElementReferenceInWorkspaceScope,
  isPptxElementReferenceAddToChatEvent,
  type PptxElementReference,
} from "@/lib/pptxElementReference.js";

export function usePptxElementReferences(options: {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  listenAddToChatEvents?: boolean;
  scopeId?: string | null;
}) {
  const {
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    listenAddToChatEvents = true,
    scopeId = null,
  } = options;
  const [references, setReferences] = useState<readonly PptxElementReference[]>([]);
  const workspaceKey = getPptxElementReferenceWorkspaceKey(workspacePath, workspaceIdentity);

  useEffect(() => {
    setReferences([]);
  }, [remoteSessionId, scopeId, workspaceKey]);

  const removeReference = useCallback((id: string) => {
    setReferences((items) => items.filter((item) => item.id !== id));
  }, []);
  const clearReferences = useCallback(() => setReferences([]), []);

  useEffect(() => {
    if (!listenAddToChatEvents || typeof window === "undefined") {
      return;
    }
    const handleAdd = (event: Event) => {
      if (!isPptxElementReferenceAddToChatEvent(event)) {
        return;
      }
      const reference = event.detail;
      if (
        !isPptxElementReferenceInWorkspaceScope(reference, {
          workspacePath,
          workspaceIdentity,
          remoteSessionId,
        })
      ) {
        return;
      }
      event.preventDefault();
      setReferences((items) => addPptxElementReference(items, reference));
    };
    window.addEventListener(PPTX_ELEMENT_REFERENCE_ADD_TO_CHAT_EVENT, handleAdd);
    return () => window.removeEventListener(PPTX_ELEMENT_REFERENCE_ADD_TO_CHAT_EVENT, handleAdd);
  }, [listenAddToChatEvents, remoteSessionId, workspaceIdentity, workspaceKey, workspacePath]);

  return useMemo(
    () => ({
      references,
      hasReferences: references.length > 0,
      removeReference,
      clearReferences,
    }),
    [clearReferences, references, removeReference],
  );
}
