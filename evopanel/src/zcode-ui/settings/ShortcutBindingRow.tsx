import { Keyboard, Pencil, Trash2 } from "lucide-react";
import type { ShortcutCommandEntry, ShortcutCommandId } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Kbd, KbdGroup } from "@/components/ui/kbd.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatShortcutBindingLabelParts } from "@/shortcuts/label.js";

export interface RecordingState {
  commandId: ShortcutCommandId;
  /** 录制模式：replace = 替换某条绑定（bindingIndex 指向现有条，null = 未分配录第一条）；add = 给命令追加一条。 */
  mode: "replace" | "add";
  /** replace 模式的目标下标；add 模式为 null。 */
  bindingIndex: number | null;
  /** 录制中的实时预览 label；null 表示尚无完整组合。 */
  preview: string | null;
  /** 冲突 / 无效提示（i18n 后文案），标红展示。 */
  error: string | null;
  /** 被其他 app 命令占用时的待确认绑定；「仍要绑定」二次确认后抢绑（系统保留键不给确认入口）。 */
  conflictBinding: string | null;
}

interface ShortcutBindingRowProps {
  entry: ShortcutCommandEntry;
  /** i18n 后的命令名（主组件统一格式化后传入）。 */
  commandLabel: string;
  bindings: readonly string[];
  /** 该命令是否存在用户覆盖条目（true 时键帽用品牌色标出自定义）。 */
  isOverridden: boolean;
  isRecording: boolean;
  recording: RecordingState | null;
  /** Web 端 menu 通道命令：录制入口置灰（默认键被根级回退监听固定消费）。 */
  menuChannelUnavailable: boolean;
  /** 替换某条绑定（index = 生效列表下标；null = 未分配录第一条）。 */
  onRecord: (bindingIndex: number | null) => void;
  onSteal: (binding: string) => void;
  /** 清空全部绑定 = 未分配（显式空数组，不回退默认）。 */
  onClearAll: () => void;
}

/**
 * 快捷键设置页的命令行：左列命令名跨全部绑定垂直居中，右列是该命令的
 * 绑定列表——每条一行：逐键键帽 + 铅笔（点击即替换该条录制）；录制态内嵌在对应
 * 条目位置。暂不支持新增/删除绑定（仅替换），操作列为「清空全部」垃圾桶。
 */
export function ShortcutBindingRow({
  entry,
  commandLabel,
  bindings,
  isOverridden,
  isRecording,
  recording,
  menuChannelUnavailable,
  onRecord,
  onSteal,
  onClearAll,
}: ShortcutBindingRowProps) {
  const { intl } = useZCodeIntl();
  const conflictBinding = isRecording ? recording?.conflictBinding : null;

  // 录制内嵌块：出现在被替换条目 / 追加条目的位置（预览 kbd 抢占焦点）
  function renderRecorder() {
    return (
      <span className="flex min-w-0 flex-col gap-1">
        <span className="flex items-center gap-2">
          <Keyboard className="size-4 text-foreground-subtle" />
          <kbd
            ref={(el) => {
              // 录制开始即抢占焦点：把焦点从可编辑元素（如上方搜索框）里拉出来，
              // 否则中文 IME 会把 Shift+字母吞成组合输入，录制器只能收到
              // isComposing/229 噪声事件，看起来就是「识别不了 Shift 组合」。
              el?.focus();
            }}
            tabIndex={-1}
            className="w-fit rounded-md bg-surface px-2 py-1 font-mono text-ui-sm outline-none"
          >
            {recording?.preview ?? intl.formatMessage({ id: "settings.shortcuts.recording" })}
          </kbd>
        </span>
        {recording?.error ? (
          <span
            className="text-ui-sm text-destructive"
            data-testid={`settings-shortcut-error-${entry.id}`}
          >
            {recording.error}
          </span>
        ) : (
          <span className="text-ui-xs text-foreground-subtlest">
            {intl.formatMessage({ id: "settings.shortcuts.recordingHint" })}
          </span>
        )}
        {conflictBinding ? (
          <Button
            variant="outline"
            size="xs"
            className="w-fit"
            data-testid={`settings-shortcut-steal-${entry.id}`}
            onClick={() => onSteal(conflictBinding)}
          >
            {intl.formatMessage({ id: "settings.shortcuts.stealConfirm" })}
          </Button>
        ) : null}
      </span>
    );
  }

  /**
   * 单条绑定行：逐键键帽（shadcn Kbd 同款，h-5/min-w-5 居中，符号与字母尺寸一致）+
   * 铅笔（点击键帽或铅笔即替换该条）。键帽只覆盖文字色（自定义 = 品牌色），不传 bg：
   * bg-inherit 会经 cn 的 tailwind-merge 覆盖 Kbd 基类 bg-muted 且祖先链全透明，
   * 芯片底色会消失。
   */
  function renderBinding(binding: string, index: number) {
    return (
      <span key={binding} className="flex items-center gap-1.5">
        <button
          type="button"
          disabled={menuChannelUnavailable}
          className="w-fit rounded-lg px-0 py-1 text-left focus-visible:outline-2 focus-visible:outline-offset-4 disabled:cursor-not-allowed disabled:opacity-60"
          aria-label={intl.formatMessage(
            { id: "settings.shortcuts.rebindAria" },
            { command: commandLabel },
          )}
          data-testid={`settings-shortcut-bind-${entry.id}-${index}`}
          onClick={() => onRecord(index)}
        >
          <KbdGroup>
            {formatShortcutBindingLabelParts(binding).map((part, partIndex) => (
              <Kbd key={`${part}-${partIndex}`} className={isOverridden ? "text-brand" : undefined}>
                {part}
              </Kbd>
            ))}
          </KbdGroup>
        </button>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={menuChannelUnavailable}
          aria-label={intl.formatMessage(
            { id: "settings.shortcuts.rebindAria" },
            { command: commandLabel },
          )}
          data-testid={`settings-shortcut-edit-${entry.id}-${index}`}
          onClick={() => onRecord(index)}
        >
          <Pencil className="size-3.5" />
        </Button>
      </span>
    );
  }

  return (
    <div
      className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_80px_72px] items-center border-t border-border px-4 py-3 text-ui-base"
      data-testid={`settings-shortcut-row-${entry.id}`}
    >
      <span className="flex min-w-0 items-center">
        <span className="truncate">{commandLabel}</span>
      </span>
      <span className="flex min-w-0 flex-col items-start gap-1.5">
        {bindings.map((binding, index) =>
          isRecording && recording?.mode === "replace" && recording.bindingIndex === index
            ? renderRecorder()
            : renderBinding(binding, index),
        )}
        {/* 未分配命令录第一条：bindings 为空时录制态占满键位单元格 */}
        {isRecording && recording?.mode === "replace" && recording?.bindingIndex === null
          ? renderRecorder()
          : null}
        {bindings.length === 0 && !isRecording ? (
          <button
            type="button"
            disabled={menuChannelUnavailable}
            className="w-fit rounded-lg px-0 py-1 text-left focus-visible:outline-2 focus-visible:outline-offset-4 disabled:cursor-not-allowed disabled:opacity-60"
            aria-label={intl.formatMessage(
              { id: "settings.shortcuts.rebindAria" },
              { command: commandLabel },
            )}
            data-testid={`settings-shortcut-bind-${entry.id}-unassigned`}
            onClick={() => onRecord(null)}
          >
            <Kbd>{intl.formatMessage({ id: "settings.shortcuts.notSet" })}</Kbd>
          </button>
        ) : null}
      </span>
      {/* 作用域独立成列：global = 全局生效；composer = 仅聊天输入框内生效 */}
      <span
        className="text-ui-sm text-foreground-subtle"
        data-testid={`settings-shortcut-scope-${entry.id}`}
      >
        {entry.scope === "composer"
          ? intl.formatMessage({ id: "settings.shortcuts.scopeComposer" })
          : intl.formatMessage({ id: "settings.shortcuts.scopeGlobal" })}
      </span>
      <Button
        variant="ghost"
        size="icon"
        aria-label={intl.formatMessage(
          { id: "settings.shortcuts.clearAria" },
          { command: commandLabel },
        )}
        // Web 端 menu 通道命令与录制入口同置灰：其默认键被根级回退监听固定消费，
        // 清除成未分配也不会真的失效，放行会产出「显示未分配却仍触发」的分裂状态
        disabled={menuChannelUnavailable || bindings.length === 0}
        onClick={onClearAll}
        data-testid={`settings-shortcut-clear-${entry.id}`}
      >
        <Trash2 className="size-4" />
      </Button>
    </div>
  );
}
