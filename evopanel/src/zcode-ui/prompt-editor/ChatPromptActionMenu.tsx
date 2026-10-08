import { ContextMentionOptionContent } from "@/mentions/components/ContextMentionOptionContent.js";
import { useFileMentionProvider } from "@/mentions/providers/fileMentionProvider.js";
import { useSessionsMentionProvider } from "@/mentions/providers/sessionsMentionProvider.js";
import {
  MENTION_FILES_ONLY_DEFAULT_PREVIEW_LIMIT,
  buildVisibleMentionGroups,
} from "@/mentions/mentionSearch.js";
import { getSessionMentionWorkspaceScope } from "@/mentions/mentionPanelRouting.js";
import { useChatViewActiveTaskProvider } from "@/v4/activeTaskProvider.js";
import { useMemo, useRef, useState, type MutableRefObject } from "react";
import type { EditorState } from "lexical";
import { GoalIcon, Info, PaperclipIcon, PlusIcon, Workflow } from "lucide-react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { buildSlashApplyMentionPayload } from "@/lib/slashApplyMentionPayload.js";
import { useSlashCommands } from "@/hooks/useSlashCommands.js";
import { normalizeSlashCommandValue } from "@/slashCommandHelpers.js";
import type { LexicalChatInputHandle } from "@/LexicalChatInput.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { MentionPanel, type MentionPanelSection } from "@/mentions/components/MentionPanel.js";
import { PluginMentionOptionContent } from "@/mentions/components/PluginMentionOptionContent.js";
import { usePluginsMentionProvider } from "@/mentions/providers/pluginsMentionProvider.js";

/**
 * 「添加」分区里紧随附件之后的命令快捷项，选中即插入与 `/` 面板相同的命令标签。
 * 两者都只在消息开头解析/展开，所以只对严格空草稿提供。
 */
const QUICK_COMMANDS = {
  goal: { id: "add-goal", labelId: "chat.goalBanner.label", Icon: GoalIcon },
  workflow: { id: "add-workflow", labelId: "chat.composer.addWorkflow", Icon: Workflow },
} as const;
type QuickCommand = keyof typeof QUICK_COMMANDS;

export function ChatPromptActionMenu({
  actionMenuTitle,
  attachmentAction,
  disabled,
  disabledReason,
  inputApiRef,
  workspacePath,
  workspaceIdentity,
  sessionId,
  container,
  showPlugins,
  excludedSlashCommandNames,
}: {
  actionMenuTitle: string;
  attachmentAction?: {
    label: string;
    onSelect: () => void;
    testId?: string;
    menuItemTestId?: string;
  };
  disabled?: boolean;
  disabledReason?: string;
  inputApiRef: MutableRefObject<LexicalChatInputHandle | null>;
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string | null;
  container: HTMLElement | null;
  showPlugins: boolean;
  excludedSlashCommandNames?: readonly string[];
}) {
  const { intl } = useZCodeIntl();
  const [open, setOpen] = useState(false);
  const [quickCommands, setQuickCommands] = useState<QuickCommand[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const selectionStateRef = useRef<EditorState | undefined>(undefined);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const restoreEditorFocusRef = useRef(false);
  const anchorRef = useMemo(
    () => ({
      current: {
        getBoundingClientRect: () => container?.getBoundingClientRect() ?? new DOMRect(),
      },
    }),
    [container],
  );
  const plugins = usePluginsMentionProvider(
    workspacePath,
    workspaceIdentity,
    sessionId,
    "",
    open && !disabled && showPlugins,
    intl.formatMessage({ id: "chat.mention.plugins.empty" }),
    intl.formatMessage({ id: "chat.mention.plugins.title" }),
  );
  const provider = useChatViewActiveTaskProvider(sessionId, workspacePath, workspaceIdentity);
  const slashCommands = useSlashCommands(workspacePath, workspaceIdentity);
  const files = useFileMentionProvider(
    workspacePath,
    workspaceIdentity,
    "",
    open && !disabled && showPlugins,
    intl.formatMessage({ id: "chat.mention.files.empty" }),
    intl.formatMessage({ id: "chat.mention.files.title" }),
    MENTION_FILES_ONLY_DEFAULT_PREVIEW_LIMIT,
  );
  const sessions = useSessionsMentionProvider(
    provider,
    workspacePath,
    workspaceIdentity,
    "",
    open && !disabled && showPlugins,
    getSessionMentionWorkspaceScope("@"),
    intl.formatMessage({ id: "chat.mention.sessions.empty" }),
    intl.formatMessage({ id: "chat.mention.sessions.title" }),
  );
  const contextGroups = buildVisibleMentionGroups(
    [
      { id: "files", ...files },
      { id: "sessions", ...sessions },
    ].map((group) => ({
      ...group,
      errorText: group.error?.message ?? null,
    })),
  );
  const mentionItems = [...plugins.items, ...contextGroups.flatMap((group) => group.items)];
  const attachmentCount = attachmentAction ? 1 : 0;
  const options = [
    ...(attachmentAction ? [{ disabled: false }] : []),
    ...quickCommands.map(() => ({ disabled: false })),
    ...mentionItems,
  ];
  const sections: MentionPanelSection[] = [
    {
      id: "add",
      title: intl.formatMessage({ id: "chat.composer.addSection" }),
      emptyText: "",
      options: [
        ...(attachmentAction
          ? [
              {
                id: "attach-files",
                label: attachmentAction.label,
                description: "",
                content: (
                  <>
                    <PaperclipIcon className="size-4 shrink-0" />
                    <span
                      className="truncate text-ui-base font-medium"
                      data-testid={attachmentAction.menuItemTestId}
                    >
                      {attachmentAction.label}
                    </span>
                  </>
                ),
              },
            ]
          : []),
        ...quickCommands.map((command) => {
          const { id, labelId, Icon } = QUICK_COMMANDS[command];
          const label = intl.formatMessage({ id: labelId });
          return {
            id,
            label,
            description: "",
            content: (
              <>
                <Icon className="size-4 shrink-0" />
                <span className="truncate text-ui-base font-medium">{label}</span>
              </>
            ),
          };
        }),
      ],
    },
    {
      id: "plugins",
      title: plugins.title,
      emptyText: plugins.emptyText,
      loading: plugins.loading,
      loadingText: intl.formatMessage({ id: "chat.mention.category.loading" }),
      errorText: plugins.error?.message,
      options: plugins.items.map((item) => ({
        ...item,
        label: item.displayLabel ?? item.label,
        content: <PluginMentionOptionContent item={item} />,
      })),
    },
    ...contextGroups.map((group) => ({
      id: group.id,
      title: group.title,
      emptyText: group.emptyText,
      loading: group.loading,
      loadingText: intl.formatMessage({ id: "chat.mention.category.loading" }),
      errorText: group.errorText,
      options: group.items.map((item) => ({
        ...item,
        content: <ContextMentionOptionContent item={item} workspacePath={workspacePath} />,
      })),
    })),
  ].filter((section) => section.id !== "add" || section.options.length > 0);

  const selectOption = (index: number) => {
    if (disabled || !options[index] || options[index].disabled) return;
    setOpen(false);
    if (attachmentAction && index === 0) {
      attachmentAction.onSelect();
      return;
    }
    const command = quickCommands[index - attachmentCount];
    const item = command
      ? buildSlashApplyMentionPayload({
          id: `slash:${command}`,
          trigger: "/",
          value: command,
          label: `/${command}`,
          description: "",
        })
      : mentionItems[index - attachmentCount - quickCommands.length];
    if (!item) return;
    restoreEditorFocusRef.current = true;
    inputApiRef.current?.insertMention(item, selectionStateRef.current);
  };

  return (
    <Popover
      open={open && !disabled}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          // 打开瞬间快照，菜单打开期间候选不平移，键盘选择不会错位。
          // /goal 仍是消息开头命令且是会话级目标：仅新会话空草稿提供，避免在消息中间插入后被忽略。
          // /workflow 同样只在消息开头展开，但不绑定会话状态：任意会话空草稿都提供；
          // 命令目录以 CLI catalog 为权威，catalog 缺 workflow（插件被禁用）时不提供，
          // 否则会把 CLI 不会展开的裸文本发给模型。
          const emptyDraft = inputApiRef.current?.getText() === "";
          const offered = (command: QuickCommand, available: boolean) =>
            emptyDraft && available && !excludedSlashCommandNames?.includes(command);
          setQuickCommands([
            ...(offered("goal", sessionId === null) ? (["goal"] as const) : []),
            ...(offered(
              "workflow",
              slashCommands.some((entry) => normalizeSlashCommandValue(entry.name) === "workflow"),
            )
              ? (["workflow"] as const)
              : []),
          ]);
          selectionStateRef.current = inputApiRef.current?.getEditorState();
          setSelectedIndex(0);
        }
        setOpen(nextOpen);
      }}
    >
      <ControlHintTooltip title={disabledReason ?? actionMenuTitle}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-md"
            className="gap-1 rounded-lg text-ui-base"
            onMouseDown={(event) => event.preventDefault()}
            aria-label={actionMenuTitle}
            data-testid={attachmentAction?.testId}
            disabled={disabled}
            title={disabledReason}
          >
            <PlusIcon className="size-4" />
            <span className="sr-only">{actionMenuTitle}</span>
          </Button>
        </PopoverTrigger>
      </ControlHintTooltip>
      {/* 默认按钮锚点在首次挂载时也会注册；自定义锚点必须随后注册，避免被即将卸载的旧按钮覆盖。 */}
      {container ? <PopoverAnchor virtualRef={anchorRef} /> : null}
      <PopoverContent
        ref={contentRef}
        align="start"
        side="top"
        sideOffset={0}
        // Radix 将虚拟锚点尺寸也写入 trigger-width；使用不存在的 anchor-width 会让虚拟列表塌缩。
        className="w-(--radix-popover-trigger-width) max-w-[calc(100vw-1rem)] gap-0 overflow-visible border-0 bg-transparent p-0 shadow-none"
        tabIndex={-1}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          contentRef.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          if (restoreEditorFocusRef.current) {
            event.preventDefault();
            restoreEditorFocusRef.current = false;
            inputApiRef.current?.focus();
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            event.stopPropagation();
            const delta = event.key === "ArrowDown" ? 1 : -1;
            for (let step = 1; step <= options.length; step++) {
              const next = (selectedIndex + delta * step + options.length) % options.length;
              if (!options[next]?.disabled) {
                setSelectedIndex(next);
                break;
              }
            }
          } else if (event.key === "Enter" || event.key === "Tab" || event.key === " ") {
            event.preventDefault();
            event.stopPropagation();
            selectOption(selectedIndex);
          }
        }}
      >
        <MentionPanel
          title={actionMenuTitle}
          description=""
          listMaxHeight="min(24rem, max(8rem, calc(var(--radix-popover-content-available-height, 32rem) - 6rem)))"
          footer={
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 text-ui-sm text-foreground-subtle">
              {(
                [
                  ["@", "chat.composer.contextShortcut"],
                  ["/", "chat.composer.capabilityShortcut"],
                  ["$", "chat.composer.skillShortcut"],
                ] as const
              ).map(([trigger, id]) => (
                <div key={trigger} className="flex shrink-0 items-center gap-1.5">
                  <code className="flex size-5 shrink-0 items-center justify-center rounded bg-tooltip-tag font-mono text-foreground">
                    {trigger}
                  </code>
                  <span>{intl.formatMessage({ id })}</span>
                </div>
              ))}
              <div className="flex items-center gap-1.5">
                <Info className="size-4 shrink-0" />
                <span>{intl.formatMessage({ id: "chat.composer.contextSearchHint" })}</span>
              </div>
            </div>
          }
          trigger="+"
          sections={sections}
          emptyText=""
          selectedIndex={selectedIndex}
          hasActiveQuery={false}
          onSelect={selectOption}
        />
      </PopoverContent>
    </Popover>
  );
}
