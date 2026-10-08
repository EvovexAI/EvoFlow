// ============================================================
// 脚本 transcript 的一个条目
// ============================================================
// 日志簿的一行：左边 28px 的种类瓦片（失败泛红、运行泛琥珀），中间两行——动词 + 对象、然后
// 结果行（`exit 1` 红、`41 files`、耗时、字节、replayed 芯片）——右边时间标尺（`+1:12`，跑着的
// 说 now）。收起的命令下面露出输出的尾巴（peek）；展开是完整面板。Read 只有摘要行，文件芯片开
// 代码查看器看**现在**的文件。状态以 journal 为准，活投影只叠 `cached`。

import {
  memo,
  useCallback,
  useMemo,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import {
  ChevronRightIcon,
  FileIcon,
  GitBranchIcon,
  SearchIcon,
  SquareTerminalIcon,
  TerminalIcon,
} from "lucide-react";
import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import { ReadFileChip, type ReadSummary } from "@/ToolCallBlocks/renderers/read.js";
import { WorkspaceCardBody } from "@/app-shell/WorkflowWorkspaceCardBody.js";
import { WorkspacePeek } from "@/app-shell/WorkflowWorkspacePeek.js";
import {
  formatAgo,
  formatOffset,
  rememberedOpen,
  setRememberedOpen,
} from "@/app-shell/workflowWorkspaceLogbook.js";
import {
  formatWorkspaceBytes,
  formatWorkspaceDuration,
  isTimeoutError,
  workspaceCardStatus,
  type WorkspaceCardModel,
} from "@/app-shell/workflowWorkspaceTranscript.js";

const KIND_ICON = {
  read: <FileIcon className="size-3.5" />,
  search: <SearchIcon className="size-3.5" />,
  git: <GitBranchIcon className="size-3.5" />,
  terminal: <SquareTerminalIcon className="size-3.5" />,
  step: <TerminalIcon className="size-3.5" />,
} as const;

const CODE_CLASS = "truncate font-mono text-[12.5px] text-foreground";

interface WorkflowWorkspaceCardProps {
  card: WorkspaceCardModel;
  sessionId: string;
  runId: string;
  run: WorkflowRunState | undefined;
  /** 时间标尺的零点（第一张卡的准入时刻）；缺席即不画时刻。 */
  origin: number | undefined;
  /** 当前时刻（运行中的卡每秒推进）。 */
  now: number;
  /** 到场错位（每张 24 ms，封顶在面板侧）；缺席即立刻。 */
  enterDelayMs?: number;
  /** 落点那张卡：到位后底色亮一下。 */
  landed?: boolean;
  /** 工作区根：Read 卡的相对路径据此补成绝对路径再交给代码查看器。 */
  workspacePath: string;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
}

function readSummaryOf(path: string, workspacePath: string): ReadSummary {
  const absolute =
    path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) ? path : `${workspacePath}/${path}`;
  const descriptor = resolveFileDisplayDescriptor(absolute);
  return {
    path: absolute,
    fileName: descriptor.fileName,
    filePath: descriptor.filePath,
    fileIconSrc: descriptor.fileIconSrc,
    entryType: "file",
  };
}

/** 结果行的零件之间放一颗小点。 */
function joined(parts: readonly ReactNode[]): ReactNode[] {
  const out: ReactNode[] = [];
  parts.forEach((part, index) => {
    if (part === null || part === undefined) return;
    if (out.length > 0) {
      out.push(
        <span
          aria-hidden
          className="size-[3px] shrink-0 rounded-full bg-foreground-subtlest opacity-70"
          key={`sep-${index}`}
        />,
      );
    }
    out.push(<span key={index}>{part}</span>);
  });
  return out;
}

export const WorkflowWorkspaceCard = memo(function WorkflowWorkspaceCard({
  card,
  enterDelayMs,
  landed = false,
  now,
  onOpenCodeViewer,
  origin,
  run,
  runId,
  sessionId,
  workspacePath,
}: WorkflowWorkspaceCardProps) {
  const { intl } = useZCodeIntl();
  const format = intl.formatMessage.bind(intl);
  const { node, kind } = card;
  const { status, replayed } = workspaceCardStatus(node, run);
  const isRunning = status === "running";
  const exitCode = node.summary?.exitCode;
  const failed = status === "failed" || (exitCode !== undefined && exitCode !== 0);
  const durationMs = Math.max(0, node.updatedAt - node.createdAt);

  // Read 只有摘要行；其余可展开（running 的命令也可展开看命令行）。展开态按卡记忆。
  const expandable = kind !== "read";
  const persistKey = `${sessionId}:${runId}:${card.key}`;
  const [open, setOpen] = useState(() => rememberedOpen(persistKey));
  const toggle = useCallback(() => {
    setOpen((previous) => {
      setRememberedOpen(persistKey, !previous);
      return !previous;
    });
  }, [persistKey]);
  const onClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      // 正文与 peek 里的点击（选文本、Copy、文件芯片）不折叠。
      if ((event.target as HTMLElement).closest("[data-ws-body],button,a") !== null) return;
      toggle();
    },
    [toggle],
  );
  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggle();
      }
    },
    [toggle],
  );

  const readSummary = useMemo(
    () => (kind === "read" ? readSummaryOf(card.primary, workspacePath) : null),
    [card.primary, kind, workspacePath],
  );
  const openRead = useCallback(() => {
    if (readSummary === null || onOpenCodeViewer === undefined) return;
    onOpenCodeViewer({ type: "file", title: readSummary.fileName, path: readSummary.path });
  }, [onOpenCodeViewer, readSummary]);

  // 第一行：动词 + 对象。
  const verb =
    kind === "read"
      ? format({ id: "chat.toolCall.workflow.script.verb.read" })
      : kind === "search"
        ? format({ id: "chat.toolCall.workflow.script.verb.searched" })
        : kind === "git"
          ? "git"
          : kind === "terminal"
            ? format({
                id: isRunning ? "chat.toolCall.execute.running" : "chat.toolCall.execute.ran",
              })
            : format({ id: "chat.toolCall.workflow.script.kind.step" });
  const object: ReactNode =
    kind === "read" && readSummary !== null ? (
      <span className="inline-flex h-5 min-w-0 max-w-full items-center rounded-[5px] border border-border bg-card px-1.5 text-ui-sm [&_button]:text-foreground [&_span]:text-foreground">
        <ReadFileChip
          summary={readSummary}
          clickable={onOpenCodeViewer !== undefined}
          onClick={openRead}
        />
      </span>
    ) : kind === "search" ? (
      <span className="flex min-w-0 items-baseline gap-1.5 truncate">
        <code className={CODE_CLASS}>{card.primary}</code>
        {card.secondary === undefined ? null : (
          <>
            <span className="text-foreground-subtlest">
              {format({ id: "chat.toolCall.workflow.script.search.in" })}
            </span>
            <code className={CODE_CLASS}>{card.secondary}</code>
          </>
        )}
      </span>
    ) : kind === "git" ? (
      <code className={CODE_CLASS}>{card.primary.replace(/^git /, "")}</code>
    ) : kind === "terminal" ? (
      <code className={CODE_CLASS}>{card.command ?? card.primary}</code>
    ) : (
      <span className="truncate text-foreground">{card.primary}</span>
    );

  // 第二行：结果。状态词换值时新词进场。
  const statusWord =
    status === "failed"
      ? isTimeoutError(node.error)
        ? format({ id: "chat.toolCall.workflow.script.status.timedOut" })
        : (node.error?.code ?? format({ id: "chat.toolCall.workflow.graph.status.failed" }))
      : exitCode !== undefined
        ? format({ id: "chat.toolCall.workflow.script.status.exit" }, { code: String(exitCode) })
        : undefined;
  const statusNode =
    statusWord === undefined ? null : (
      <span
        className={cn("wf-swap font-semibold", failed ? "text-destructive" : "text-success")}
        data-failed={failed ? "true" : undefined}
        data-testid="workflow-workspace-status"
        key={statusWord}
        title={
          status === "failed"
            ? (node.error?.message ?? node.error?.code)
            : failed
              ? card.command
              : undefined
        }
      >
        {statusWord}
      </span>
    );
  const replayedNode = replayed ? (
    <span
      className="inline-flex h-4 items-center rounded-[4px] border border-dashed border-border px-1 text-[10.5px] leading-none text-foreground-subtlest"
      data-testid="workflow-workspace-replayed"
      title={format({ id: "chat.toolCall.workflow.script.status.replayedHint" })}
    >
      {format({ id: "chat.toolCall.workflow.script.status.replayed" })}
    </span>
  ) : null;
  const bytes = node.summary?.resultBytes;
  const count = node.summary?.resultCount;
  const countNode =
    count === undefined ? null : (
      <b className="font-medium text-foreground-subtle">
        {format(
          {
            id:
              card.op === "grep"
                ? "chat.toolCall.workflow.script.result.matches"
                : "chat.toolCall.workflow.script.result.files",
          },
          { count: String(count) },
        )}
      </b>
    );
  const resultParts: ReactNode[] = isRunning
    ? [
        format(
          { id: "chat.toolCall.workflow.script.startedAgo" },
          { ago: formatAgo(now - node.createdAt) },
        ),
      ]
    : status === "failed"
      ? [statusNode, formatWorkspaceDuration(durationMs)]
      : kind === "read"
        ? [
            <span className="truncate font-mono" key="path">
              {card.primary}
            </span>,
            bytes === undefined ? null : formatWorkspaceBytes(bytes),
            replayedNode,
          ]
        : kind === "search"
          ? [countNode, formatWorkspaceDuration(durationMs), replayedNode]
          : kind === "terminal"
            ? [
                statusNode,
                formatWorkspaceDuration(durationMs),
                formatWorkspaceBytes(node.summary?.stdoutBytes ?? bytes ?? 0),
                replayedNode,
              ]
            : [
                countNode,
                bytes === undefined ? null : formatWorkspaceBytes(bytes),
                formatWorkspaceDuration(durationMs),
                replayedNode,
              ];
  if (node.inputTruncated) {
    resultParts.push(
      <span title={format({ id: "chat.toolCall.workflow.script.args.truncated" })}>…</span>,
    );
  }

  const style: CSSProperties =
    enterDelayMs === undefined || enterDelayMs <= 0
      ? {}
      : { animationDelay: `${enterDelayMs}ms`, animationFillMode: "backwards" };

  return (
    <div
      aria-expanded={expandable ? open : undefined}
      className={cn(
        "wf-ws-entry wf-arrive group/ws grid grid-cols-[28px_minmax(0,1fr)_auto] items-start gap-x-3 rounded-[9px] px-2 pb-2.5 pt-[9px] outline-none",
        expandable &&
          "cursor-pointer hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring/40",
        landed && "wf-ws-landed",
      )}
      data-card-key={card.key}
      data-open={open ? "true" : undefined}
      data-ordinal={node.ordinal}
      data-phase-id={card.phase?.id}
      data-site-id={node.siteId}
      data-status={status}
      data-testid="workflow-workspace-card"
      onClick={expandable ? onClick : undefined}
      onKeyDown={expandable ? onKeyDown : undefined}
      role={expandable ? "button" : undefined}
      style={style}
      tabIndex={expandable ? 0 : undefined}
    >
      <span
        aria-hidden
        className={cn(
          "mt-px flex size-7 items-center justify-center rounded-[7px] bg-surface text-foreground-subtle transition-colors",
          failed &&
            "bg-[color-mix(in_oklab,var(--color-destructive)_10%,transparent)] text-destructive",
          isRunning && "bg-[color-mix(in_oklab,var(--color-warning)_12%,transparent)] text-warning",
        )}
      >
        {KIND_ICON[kind]}
      </span>
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 items-baseline gap-1.5 text-ui-base leading-[18px]">
          <span
            className={cn(
              "shrink-0 font-medium text-foreground-subtle",
              isRunning && "wf-ws-shine",
            )}
          >
            {verb}
          </span>
          {object}
          {expandable ? (
            <ChevronRightIcon
              className={cn(
                "ml-0.5 size-3.5 shrink-0 self-center text-foreground-subtlest opacity-0 transition-[opacity,transform] duration-[160ms] group-hover/ws:opacity-100 group-focus-visible/ws:opacity-100",
                open && "rotate-90 opacity-100",
              )}
            />
          ) : null}
        </div>
        <div
          className="flex flex-wrap items-center gap-1.5 text-ui-sm leading-4 text-foreground-subtlest"
          data-testid="workflow-workspace-result"
        >
          {joined(resultParts)}
        </div>
        {kind === "terminal" && !open && status === "completed" ? (
          <WorkspacePeek node={node} runId={runId} sessionId={sessionId} />
        ) : null}
        {expandable && open ? (
          <WorkspaceCardBody card={card} runId={runId} sessionId={sessionId} />
        ) : null}
      </div>
      <span
        className="flex items-center gap-1.5 whitespace-nowrap font-mono text-ui-xs leading-[18px] tabular-nums text-foreground-subtlest"
        data-testid="workflow-workspace-when"
      >
        {isRunning ? (
          <>
            <span aria-hidden className="wf-lamp-running size-1.5 rounded-full bg-warning" />
            {format({ id: "chat.toolCall.workflow.script.now" })}
          </>
        ) : origin === undefined ? null : (
          formatOffset(node.createdAt - origin)
        )}
      </span>
    </div>
  );
});
