import { useState } from "react";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * 用户消息里的引擎附加文本。
 *
 * dwf 子代理收到的每个 ask = 脚本写的指令正文 + driver 追加的尾注（结果标准、`submit_result`
 * 的 JSON Schema），nudge 轮整条都是引擎文本。读者打开子代理 transcript 想看的是「脚本让它干
 * 什么」，尾注是逐字重复的技术样板——所以折进一枚默认收起的披露，但**不抹掉**：调试时得能核对
 * 子代理到底被告知了什么。边界由引擎标记在行的 `epilogueStart` 上，这里只切分与折叠。
 */

/** 把行拆成正文与尾注。越界或缺席 → 无尾注：宁可多显示，也不把正文吃掉。 */
export function splitUserInputEpilogue(
  text: string,
  epilogueStart: number | undefined,
): { body: string; epilogue?: string } {
  if (epilogueStart === undefined || epilogueStart < 0 || epilogueStart > text.length) {
    return { body: text };
  }
  return { body: text.slice(0, epilogueStart), epilogue: text.slice(epilogueStart) };
}

/**
 * 去掉尾注开头的空行与 `---` 分隔线：那根横杠在原文里是「正文到此为止」的记号，而披露本身
 * 已经表达了这条边界，再画一根就是噪音。段落之间的第二根 `---`（质量尾注与 schema 尾注之间）保留。
 */
function trimEpilogueLead(text: string): string {
  return text.replace(/^\s*(?:---[ \t]*\n)?/u, "").trimEnd();
}

export function ConversationUserInputEpilogue({ text }: { text: string }) {
  const { intl } = useZCodeIntl();
  const [open, setOpen] = useState(false);
  const label = intl.formatMessage({ id: "chat.userInput.epilogue.label" });
  return (
    <div data-v4-user-input-epilogue="true" className="flex min-w-0 flex-col gap-1">
      <button
        aria-expanded={open}
        className="flex items-center gap-1 self-start rounded-md text-ui-xs text-foreground-subtlest transition-colors hover:text-foreground"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        {open ? (
          <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0" />
        ) : (
          <ChevronRightIcon aria-hidden="true" className="size-3 shrink-0" />
        )}
        {label}
      </button>
      {open ? (
        // 尾注里有缩进的 JSON Schema，按等宽预格式排；次级色——它是参考材料，不是消息正文。
        <pre
          className="max-h-60 overflow-auto whitespace-pre-wrap break-words font-mono text-ui-sm text-foreground-subtle"
          data-v4-user-input-epilogue-body="true"
        >
          {trimEpilogueLead(text)}
        </pre>
      ) : null}
    </div>
  );
}
