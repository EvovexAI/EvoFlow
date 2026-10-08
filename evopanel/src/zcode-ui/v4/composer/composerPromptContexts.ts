import {
  buildPromptWithCodeComments,
  parsePromptCodeComments,
  type CodeCommentComposerAttachment,
} from "@/lib/codeCommentContext.js";
import {
  buildPromptWithConversationSelections,
  parsePromptConversationSelections,
  type ConversationSelectionDisplayReference,
} from "@/lib/conversationSelectionReference.js";
import {
  buildPromptWithWebElementContexts,
  parsePromptWebElementContexts,
  type WebElementContextComposerAttachment,
} from "@/lib/webElementContext.js";
import {
  buildPromptWithPptxElementReferences,
  parsePromptPptxElementReferences,
  type PptxElementReference,
} from "@/lib/pptxElementReference.js";

interface ComposerPromptContexts {
  codeComments: readonly CodeCommentComposerAttachment[];
  conversationSelections: readonly ConversationSelectionDisplayReference[];
  webElements: readonly WebElementContextComposerAttachment[];
  pptxElements: readonly PptxElementReference[];
}

export function countComposerPromptContexts(contexts: {
  codeComments: readonly unknown[];
  conversationSelections: readonly unknown[];
  webElements: readonly unknown[];
  pptxElements: readonly unknown[];
}) {
  return (
    contexts.codeComments.length +
    contexts.conversationSelections.length +
    contexts.webElements.length +
    contexts.pptxElements.length
  );
}

/**
 * 四类 context parser 都只识别 prompt 尾块，因此序列化顺序和解析顺序必须严格相反。
 */
export function serializeComposerPromptContexts(
  text: string,
  contexts: ComposerPromptContexts,
): string {
  const withSelections = buildPromptWithConversationSelections(
    text,
    contexts.conversationSelections,
  );
  const withCodeComments = buildPromptWithCodeComments(withSelections, contexts.codeComments);
  const withWebElements = buildPromptWithWebElementContexts(withCodeComments, contexts.webElements);
  return buildPromptWithPptxElementReferences(withWebElements, contexts.pptxElements);
}

export function parseComposerPromptContexts(
  content: string,
  workspace: { workspacePath: string; workspaceIdentity?: string },
): {
  visibleContent: string;
  codeComments: CodeCommentComposerAttachment[];
  conversationSelections: readonly ConversationSelectionDisplayReference[];
  webElements: WebElementContextComposerAttachment[];
  pptxElements: PptxElementReference[];
} {
  const pptx = parsePromptPptxElementReferences(content);
  const web = parsePromptWebElementContexts(pptx.visibleContent, workspace);
  const code = parsePromptCodeComments(web.visibleContent, workspace);
  const selections = parsePromptConversationSelections(code.visibleContent);
  return {
    visibleContent: selections.visibleContent,
    codeComments: code.codeCommentAttachments,
    conversationSelections: selections.references,
    webElements: web.webElementContexts,
    pptxElements: pptx.pptxElementReferences,
  };
}
