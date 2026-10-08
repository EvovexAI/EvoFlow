import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $getSelection,
  $isRangeSelection,
  $setSelection,
  COMMAND_PRIORITY_HIGH,
  COPY_COMMAND,
  CUT_COMMAND,
  type LexicalEditor,
} from "lexical";
import {
  $getAtomicPromptSelection,
  $getPromptSelectionMarkdown,
} from "@/mentions/promptSerialization.js";

function registerPromptClipboard(editor: LexicalEditor): () => void {
  const handle = (event: ClipboardEvent | KeyboardEvent | null, cut: boolean): boolean => {
    const selection = $getSelection();
    if (
      !$isRangeSelection(selection) ||
      selection.isCollapsed() ||
      !event ||
      !("clipboardData" in event) ||
      !event.clipboardData
    )
      return false;
    const atomic = $getAtomicPromptSelection(selection);
    try {
      event.clipboardData.setData("text/plain", $getPromptSelectionMarkdown(atomic));
    } catch {
      // 根因：返回 false 会继续进入 PlainTextPlugin 的默认 CUT，写入失败仍可能删除选区。
      // 消费失败事件，保留草稿，让用户可以再次复制/剪切。
      event.preventDefault();
      return true;
    }
    event.preventDefault();
    if (cut && editor.isEditable()) {
      $setSelection(atomic);
      atomic.removeText();
    }
    return true;
  };
  const unregisterCopy = editor.registerCommand(
    COPY_COMMAND,
    (event) => handle(event, false),
    COMMAND_PRIORITY_HIGH,
  );
  const unregisterCut = editor.registerCommand(
    CUT_COMMAND,
    (event) => handle(event, true),
    COMMAND_PRIORITY_HIGH,
  );
  return () => {
    unregisterCopy();
    unregisterCut();
  };
}

export function PromptClipboardPlugin() {
  const [editor] = useLexicalComposerContext();
  useEffect(() => registerPromptClipboard(editor), [editor]);
  return null;
}
