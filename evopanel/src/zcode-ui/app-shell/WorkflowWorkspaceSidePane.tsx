// ============================================================
// 脚本 transcript 面板。
// ============================================================
// 一个 run 的 `files.*` / `git.*` / `world.run` 调用，按执行顺序回放成一本日志簿：阶段是章
// （章头 = 名字 · ⟳n · 横线 · 步数与时长），每一步是两行的条目 + 时间标尺，命令露出输出的尾巴。
// 与 actor transcript 面板同一逻辑层级：run 详情页保留它唯一的那条时间线，这里**不是第二条
// 时间线**——没有轨道、没有灯。
//
// 数据两条路：清单（轻行，`lastEventSequence` 抬升即重查）+ 正文（滚进视口 / 展开时才取，
// 按 tab 缓存）。状态以 journal 为准，活投影只叠 `cached`。

import { Fragment, memo, useEffect, useMemo, useRef, type ReactNode } from "react";
import { HourglassIcon, Repeat2Icon, TerminalIcon, TriangleAlertIcon } from "lucide-react";
import { phaseDisplayName } from "@/components/workflow-graph/phase-name.js";
import { WorkflowRunStatus } from "@/components/workflow-timeline/WorkflowCardChrome.js";
import { useRunningBackgroundTaskElapsedClock } from "@/hooks/useRunningBackgroundTaskElapsedClock.js";
import { useWorkflowRunWorkspace } from "@/hooks/useWorkflowRunWorkspace.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { WorkflowWorkspaceSidePaneTab } from "@/lib/workspaceSidePane.js";
import { buildWorkflowGraphByToolCallId } from "@/v4/workflowRunCardJoin.js";
import { WorkflowWorkspaceCard } from "@/app-shell/WorkflowWorkspaceCard.js";
import {
  buildWorkspaceChapters,
  transcriptOrigin,
  transcriptSummary,
  type WorkspaceChapter,
} from "@/app-shell/workflowWorkspaceLogbook.js";
import {
  buildWorkspaceCards,
  firstCardIndexOfPhase,
  formatWorkspaceDuration,
} from "@/app-shell/workflowWorkspaceTranscript.js";
import type { PaneWorkspaceScope } from "@/v4/paneLayoutStore.js";
import { useConversationProjection } from "@/v4/useConversationProjection.js";
import { useV4Conversation, V4PaneConversationProvider } from "@/v4/V4ConversationContext.js";

/** 条目到场的错位：每个 24 ms，封顶 360 ms——第 16 个之后一起落地，长清单不该等半秒。 */
const CARD_STAGGER_MS = 24;
const CARD_STAGGER_CAP_MS = 360;

interface WorkflowWorkspaceSidePaneProps {
  tab: WorkflowWorkspaceSidePaneTab;
  focused: boolean;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
}

/** 整个 run 还没碰过工作区：占位（与 actor 的「尚未启动」同一形态，措辞换成工作区的）。 */
function WorkspaceNotStarted() {
  const { intl } = useZCodeIntl();
  return (
    <div
      className="wf-arrive flex h-full flex-col items-center justify-center gap-1.5 px-8 py-16 text-center"
      data-testid="workflow-workspace-not-started"
    >
      <span className="mb-2.5 flex size-14 items-center justify-center rounded-full bg-surface text-foreground-subtlest">
        <HourglassIcon className="size-6" />
      </span>
      <p className="text-ui-base font-medium text-foreground">
        {intl.formatMessage({ id: "chat.toolCall.workflow.script.notStarted.title" })}
      </p>
      <p className="max-w-[260px] text-ui-sm leading-normal text-foreground-subtle">
        {intl.formatMessage({ id: "chat.toolCall.workflow.script.notStarted.body" })}
      </p>
    </div>
  );
}

function WorkspaceNotice({ text, testId }: { text: string; testId: string }) {
  return (
    <div
      className="wf-arrive flex h-full flex-col items-center justify-center px-6 text-center"
      data-testid={testId}
    >
      <TriangleAlertIcon className="size-8 text-foreground-subtlest" />
      <p className="mt-3 text-ui-base text-foreground-subtle">{text}</p>
    </div>
  );
}

/** `1 step` / `3 steps`——词典没有复数语法，单数另配一条。 */
function countLabel(
  format: ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"],
  noun: "steps" | "phases",
  count: number,
): string {
  return count === 1
    ? format({ id: `chat.toolCall.workflow.script.summary.${noun}.one` })
    : format({ id: `chat.toolCall.workflow.script.summary.${noun}` }, { count: String(count) });
}

/** 章头：阶段名 · ⟳n · 横线 · `3 steps · 2m 06s`。没有阶段的章不画头。 */
function ChapterHeader({ chapter }: { chapter: WorkspaceChapter }) {
  const { intl } = useZCodeIntl();
  const format = intl.formatMessage.bind(intl);
  if (chapter.phase === undefined) return null;
  return (
    <div
      className="wf-arrive mx-2 mb-2 mt-[22px] flex min-w-0 items-center gap-2.5 first:mt-2.5"
      data-phase-id={chapter.phase.id}
      data-round={chapter.round}
      data-testid="workflow-workspace-chapter"
    >
      <span className="whitespace-nowrap text-ui-base font-semibold tracking-[-0.005em] text-foreground">
        {phaseDisplayName(chapter.phase, format)}
      </span>
      {chapter.round > 1 ? (
        <span className="inline-flex h-4 items-center gap-0.5 rounded bg-surface-hover px-1.5 font-mono text-[10.5px] font-medium text-foreground-subtle">
          <Repeat2Icon className="size-2.5" />
          {chapter.round}
        </span>
      ) : null}
      <span aria-hidden className="wf-ws-rule h-0 flex-1 border-t border-border" />
      <span className="whitespace-nowrap font-mono text-ui-xs tabular-nums text-foreground-subtlest">
        {countLabel(format, "steps", chapter.cards.length)}
        {" · "}
        {formatWorkspaceDuration(chapter.endedAt - chapter.startedAt)}
      </span>
    </div>
  );
}

const WorkflowWorkspaceContent = memo(function WorkflowWorkspaceContent({
  tab,
  onOpenCodeViewer,
}: WorkflowWorkspaceSidePaneProps) {
  const { intl } = useZCodeIntl();
  const format = intl.formatMessage.bind(intl);
  const { layer } = useV4Conversation();

  // 父会话租约走渲染期同步建连（同 actor 面板）：首帧就要有投影，落点与状态叠加都读它。
  const lease = useMemo(() => layer.acquire(tab.parentSessionId), [layer, tab.parentSessionId]);
  useEffect(() => () => lease.release(), [lease]);
  const snapshot = useConversationProjection(lease).snapshot;

  const run = useMemo(
    () => snapshot?.workflowRuns?.runs.find((candidate) => candidate.runId === tab.runId),
    [snapshot?.workflowRuns, tab.runId],
  );
  const graph = useMemo(
    () => buildWorkflowGraphByToolCallId(snapshot?.rows.window).get(tab.toolCallId),
    [snapshot?.rows.window, tab.toolCallId],
  );

  const workspace = useWorkflowRunWorkspace({
    sessionId: tab.parentSessionId,
    runId: tab.runId,
    ...(run === undefined ? {} : { refreshSignal: run.lastEventSequence }),
  });
  const cards = useMemo(
    () => buildWorkspaceCards(workspace.nodes, graph),
    [graph, workspace.nodes],
  );
  const chapters = useMemo(() => buildWorkspaceChapters(cards), [cards]);
  const origin = useMemo(() => transcriptOrigin(cards), [cards]);
  // 跑着的条目「开始于多久前」与表头的总时长每秒推进；没有在跑的就不走钟。
  const runningCount = cards.filter((card) => card.node.status === "running").length;
  const now = useRunningBackgroundTaskElapsedClock(runningCount);
  const summary = useMemo(() => transcriptSummary(cards, now), [cards, now]);

  // 落点（每次打开都重落：`openedAt` 随打开刷新）：那一站的第一张卡；还没到的站落到末尾。
  // 等清单到齐再滚，否则滚的是一个空容器。
  const listRef = useRef<HTMLDivElement>(null);
  const landingKey =
    tab.focusPhaseId === undefined ? undefined : `${tab.focusPhaseId}@${tab.openedAt}`;
  const landedIndex = useMemo(
    () => (tab.focusPhaseId === undefined ? -1 : firstCardIndexOfPhase(cards, tab.focusPhaseId)),
    [cards, tab.focusPhaseId],
  );
  const landedKey = landedIndex < 0 ? undefined : cards[landedIndex]?.key;
  const landedOnceRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (landingKey === undefined || !workspace.loaded) return;
    if (landedOnceRef.current === landingKey) return;
    landedOnceRef.current = landingKey;
    const list = listRef.current;
    if (list === null) return;
    const reduced =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const behavior: ScrollBehavior = reduced ? "auto" : "smooth";
    const target =
      landedKey === undefined
        ? null
        : (list.querySelector<HTMLElement>(`[data-card-key="${landedKey}"]`) ?? null);
    if (target !== null && typeof target.scrollIntoView === "function") {
      target.scrollIntoView({ behavior, block: "start" });
    } else if (typeof list.scrollTo === "function") {
      list.scrollTo({ top: list.scrollHeight, behavior });
    }
  }, [landedKey, landingKey, workspace.loaded]);

  // 首批到场按下标错位；之后追加的卡各自立刻到场（wf-arrive 无延迟）。
  const initialCountRef = useRef<number | null>(null);
  if (initialCountRef.current === null && workspace.loaded) initialCountRef.current = cards.length;
  const initialCount = initialCountRef.current ?? 0;

  const title = tab.workflowName?.trim() || intl.formatMessage({ id: "sidePane.workflowScript" });

  let body: ReactNode;
  if (workspace.unavailable) {
    body = (
      <WorkspaceNotice
        testId="workflow-workspace-unavailable"
        text={format({ id: "chat.toolCall.workflow.script.unavailable" })}
      />
    );
  } else if (workspace.error !== null && !workspace.loaded) {
    body = (
      <WorkspaceNotice
        testId="workflow-workspace-error"
        text={format(
          { id: "chat.toolCall.workflow.script.loadFailed" },
          { error: workspace.error },
        )}
      />
    );
  } else if (workspace.loaded && cards.length === 0) {
    body = <WorkspaceNotStarted />;
  } else {
    let index = 0;
    body = (
      <div
        className="wf-motion flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pb-7 pt-1.5"
        data-testid="workflow-workspace-list"
        ref={listRef}
      >
        {chapters.map((chapter) => (
          <Fragment key={chapter.key}>
            <ChapterHeader chapter={chapter} />
            {chapter.cards.map((card) => {
              const position = index;
              index += 1;
              return (
                <WorkflowWorkspaceCard
                  card={card}
                  enterDelayMs={
                    position < initialCount
                      ? Math.min(CARD_STAGGER_MS * position, CARD_STAGGER_CAP_MS)
                      : 0
                  }
                  key={card.key}
                  landed={card.key === landedKey && landingKey !== undefined}
                  now={card.node.status === "running" ? now : 0}
                  onOpenCodeViewer={onOpenCodeViewer}
                  origin={origin}
                  run={run}
                  runId={tab.runId}
                  sessionId={tab.parentSessionId}
                  workspacePath={tab.workspacePath}
                />
              );
            })}
          </Fragment>
        ))}
        {workspace.truncated ? (
          <p
            className="px-2 pt-3 text-center text-ui-xs text-foreground-subtlest"
            data-testid="workflow-workspace-truncated"
          >
            {format(
              { id: "chat.toolCall.workflow.script.listTruncated" },
              { count: String(cards.length) },
            )}
          </p>
        ) : null}
      </div>
    );
  }

  // 表头第二行：`3 phases · 9 steps · 4m 12s`——清单到齐且非空才说。
  const summaryParts: string[] = [];
  if (workspace.loaded && cards.length > 0) {
    if (summary.phases > 0) summaryParts.push(countLabel(format, "phases", summary.phases));
    summaryParts.push(countLabel(format, "steps", summary.steps));
    summaryParts.push(formatWorkspaceDuration(summary.durationMs));
  }

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-background"
      data-testid="workflow-workspace-pane"
      data-workflow-run-id={tab.runId}
    >
      {/* 表头：终端瓦片 · WORKSPACE 眉题 + run 名 · run 灯与词；第二行是整本日志簿的三个数。 */}
      <div className="wf-motion flex shrink-0 flex-col gap-3 border-b border-border px-5 pb-3.5 pt-4">
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className="wf-arrive flex size-[34px] shrink-0 items-center justify-center rounded-[9px] bg-surface-hover text-foreground-subtle"
          >
            <TerminalIcon className="size-4" />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-ui-xs font-medium uppercase tracking-[0.08em] text-foreground-subtlest">
              {format({ id: "chat.toolCall.workflow.script.title" })}
            </span>
            <span
              className="truncate text-ui-lg font-medium leading-tight text-foreground"
              data-testid="workflow-workspace-title"
            >
              {title}
            </span>
          </div>
          {run ? (
            <WorkflowRunStatus
              className="font-medium"
              run={run}
              testId="workflow-workspace-run-status"
            />
          ) : null}
        </div>
        {summaryParts.length === 0 ? null : (
          <div
            className="flex items-center gap-1.5 pl-[46px] text-ui-sm text-foreground-subtle"
            data-testid="workflow-workspace-summary"
          >
            {summaryParts.map((part, position) => (
              <Fragment key={position}>
                {position > 0 ? (
                  <span aria-hidden className="size-[3px] rounded-full bg-foreground-subtlest" />
                ) : null}
                <span
                  className={position === summaryParts.length - 1 ? "font-mono tabular-nums" : ""}
                >
                  {part}
                </span>
              </Fragment>
            ))}
          </div>
        )}
      </div>
      {body}
    </div>
  );
});

/**
 * 一个 workflow run 的脚本 transcript tab。组合方式照 `WorkflowActorSessionSidePane`：pane scope
 * + 内容；内容自己取数（两条 journal 查询），不嵌 SessionPane——工作区没有会话。
 */
export const WorkflowWorkspaceSidePane = memo(function WorkflowWorkspaceSidePane({
  tab,
  focused,
  onOpenCodeViewer,
}: WorkflowWorkspaceSidePaneProps) {
  const scope = useMemo<PaneWorkspaceScope>(
    () => ({
      workspacePath: tab.workspacePath,
      ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
      ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
    }),
    [tab.remoteSessionId, tab.workspaceIdentity, tab.workspacePath],
  );
  return (
    <V4PaneConversationProvider scope={scope}>
      <WorkflowWorkspaceContent tab={tab} focused={focused} onOpenCodeViewer={onOpenCodeViewer} />
    </V4PaneConversationProvider>
  );
});
