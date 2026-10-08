import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRightIcon, CircleHelpIcon } from "lucide-react";
import type { WorkflowRunPendingQuestion, WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { cn } from "@/components/lib/utils.js";
import { laneDisplayName } from "@/components/workflow-graph/lane-name.js";
import { phaseDisplayName } from "@/components/workflow-graph/phase-name.js";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";
import {
  pillActivity,
  type TimelinePill,
  type WorkflowTimelineModel,
} from "@/components/workflow-timeline/timeline-model.js";
import {
  ROSTER_PINS_PANE,
  pillInstanceKey,
  rosterMore,
  rosterRestCounts,
  rosterRoll,
  stationRosterOf,
} from "@/components/workflow-timeline/roster-model.js";
import {
  WorkflowAgentPill,
  type WorkflowAgentPillOpen,
} from "@/components/workflow-timeline/WorkflowAgentPill.js";
import { WorkflowMoreRow } from "@/components/workflow-timeline/WorkflowMoreRow.js";
import { WorkflowRoll } from "@/components/workflow-timeline/WorkflowRoll.js";
import { RosterMeter } from "@/components/workflow-timeline/WorkflowRosterParts.js";
import { WorkflowRunQuestionRow } from "@/app-shell/WorkflowRunQuestionRow.js";
import {
  AvatarCluster,
  Rounds,
  SpineLamp,
  SpinePieces,
} from "@/app-shell/WorkflowRunSpineParts.js";
import { spineSections } from "@/app-shell/workflowRunSpine.js";
import type { WorkflowActorInstance } from "@/app-shell/workflowRunPanel.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * 运行详情页的脊线：卡上的横向时间线在
 * 这里竖着读。一根轨道从上到下贴着左缘，阶段是轨道上的灯，轨道的墨迹随控制流经过而变深、在进入
 * 正在运行的阶段那一段行进；子代理是挂在灯右侧、拉满本列的药丸（与卡上同一枚），升级问题挂在
 * 提问者那一行下面，再退一步。**不画回边**：那是卡的事，节头上的 `⟳ n` 已经说了这站跑过几轮。
 *
 * 轨道段与灯的墨迹、状态都读 `buildWorkflowTimeline` 的同一个模型（不变式 1：一个模型，三处
 * 消费）。轨道段只在模型有 `rails` 的相邻两站之间画——与卡同一条规则，相邻无边留空。
 *
 * 并行的阶段（模型的**带**）在这里读作缩进：分支轨道从带首节的顶上用曲线离开主轨，整节整节地
 * 竖下来，到汇合站的节顶再回来；分支站的节头与药丸一起右移 12px，主轨照常从它身边穿过。每一节
 * 要画哪些竖轨与曲线由 `workflowRunSpine.ts` 算好，这里只照着摆。**不画回边**（同上）。
 *
 * 折起的阶段在节头带一串头像（至多 3 枚 + `+n`）：折叠不能让「谁在这一站」不可见。
 * 正在运行的阶段自己展开：**每一个**正在跑的站都开（带里两条轨道可以同时在跑），已展开的不动。
 *
 * 参与者过了阈值的站是名册（追记「阶段名册」、「一扇门与一卷名单」）：钉 5 枚药丸（asking → running →
 * failed → 补位），第六枚是门（关着带其余人的计数行），门后是其余人的名单——每人一次、按状态分组、
 * 两列 `row` 药丸；折叠节头上头像串换成迷你量条。界上列不出来的子代理（`station.unlisted`）进门的
 * 人数、计数行与量条，却没有行可落，所以名单末尾用一行淡字交代这个差额。
 *
 * 落点：卡上「还有 n 个」那一行或站头把站 id 交给宿主，tab 带着
 * `focusPhaseId` 到这里——展开这一站、把门打开、节头滚到顶、底色亮一下再退回。一次打开只落一次
 * （键含 openedAt，同一站再点一次会再落）；之后用户滚走不追。
 */
const QUESTION_TICK_MS = 30_000;
/** 落点亮一下的时长：持 400 ms 再用 800 ms 退回（`.wf-landed`）。 */
const LANDING_MS = 1200;

function questionKey(question: WorkflowRunPendingQuestion): string | undefined {
  return question.actorSiteId === undefined || question.actorOrdinal === undefined
    ? undefined
    : `${question.actorSiteId}@${question.actorOrdinal}`;
}

const pillKey = pillInstanceKey;

export const WorkflowRunPhaseList = memo(function WorkflowRunPhaseList({
  graph,
  landing,
  model,
  onOpenActor,
  onOpenWorkspace,
  pendingQuestions,
  run,
}: {
  graph: WorkflowCausalityGraphData;
  model: WorkflowTimelineModel;
  run: WorkflowRunState | undefined;
  pendingQuestions: readonly WorkflowRunPendingQuestion[];
  /** 开 actor transcript tab（没有会话的槽位开占位）。缺席即行不可点——回调的存在本身就是门控。 */
  onOpenActor?: (instance: WorkflowActorInstance) => void;
  /** 开脚本 transcript tab、落到这一站；缺席即脚本行不可点。 */
  onOpenWorkspace?: (phaseId: string) => void;
  /** 落点：`key` 每次打开都不同（`phaseId@openedAt`），同一站再点一次也再落。 */
  landing?: { phaseId: string; key: string };
}) {
  const { intl } = useZCodeIntl();
  const format = intl.formatMessage.bind(intl);
  // 正在运行的站自己展开——带里两条轨道可以同时在跑，**每一个**都要开，不只最右那个。
  // 用一个稳定的键记住这一组 id：投影每动一次模型都换身份，但这一组通常不变。
  const runningKey = model.stations
    .filter((station) => station.status === "running")
    .map((station) => station.id)
    .join("\u0000");
  const runningIds = useMemo(
    () => (runningKey === "" ? [] : runningKey.split("\u0000")),
    [runningKey],
  );
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(runningIds));
  useEffect(() => {
    setOpen((previous) =>
      runningIds.every((id) => previous.has(id)) ? previous : new Set([...previous, ...runningIds]),
    );
  }, [runningIds]);
  const toggle = useCallback((id: string) => {
    setOpen((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  // 名册站的门：开着即列出名单，清单的局部状态，按站记。
  const [listed, setListed] = useState<ReadonlySet<string>>(() => new Set());
  const toggleListed = useCallback((id: string) => {
    setListed((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // 落点：展开 + 开门 + 亮一下；滚动在下一次提交之后（那一节得先展开才有节头可滚）。
  // `landed` 按落点的键记（不是按站）：同一站再落一次，键变了、滚动与亮一下就都再来一遍。
  const rootRef = useRef<HTMLDivElement>(null);
  const landedOnceRef = useRef<string | undefined>(undefined);
  const [landed, setLanded] = useState<{ phaseId: string; key: string } | undefined>(undefined);
  useEffect(() => {
    if (landing === undefined || landedOnceRef.current === landing.key) return undefined;
    landedOnceRef.current = landing.key;
    const { phaseId } = landing;
    setOpen((previous) => (previous.has(phaseId) ? previous : new Set([...previous, phaseId])));
    setListed((previous) => (previous.has(phaseId) ? previous : new Set([...previous, phaseId])));
    setLanded(landing);
    const timer = setTimeout(
      () => setLanded((current) => (current?.key === landing.key ? undefined : current)),
      LANDING_MS,
    );
    return () => clearTimeout(timer);
  }, [landing]);
  useEffect(() => {
    if (landed === undefined) return;
    const root = rootRef.current;
    if (root === null) return;
    const section = [...root.querySelectorAll<HTMLElement>("[data-phase-id]")].find(
      (candidate) => candidate.getAttribute("data-phase-id") === landed.phaseId,
    );
    const head = section?.querySelector<HTMLElement>('[data-testid="workflow-run-phase-toggle"]');
    if (head === undefined || head === null || typeof head.scrollIntoView !== "function") return;
    const reduced =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    head.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
  }, [landed]);

  // 等待时长要自己走：一个在等答案的 run **恰恰不发事件**。定时器只在有问题时存在。
  const [now, setNow] = useState(() => Date.now());
  const hasQuestions = pendingQuestions.length > 0;
  useEffect(() => {
    if (!hasQuestions) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), QUESTION_TICK_MS);
    return () => clearInterval(timer);
  }, [hasQuestions]);

  const questionsByInstance = useMemo(() => {
    const byKey = new Map<string, WorkflowRunPendingQuestion[]>();
    for (const question of pendingQuestions) {
      const key = questionKey(question);
      if (key === undefined) continue;
      const list = byKey.get(key) ?? [];
      list.push(question);
      byKey.set(key, list);
    }
    return byKey;
  }, [pendingQuestions]);
  const attachedKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const station of model.stations) {
      for (const pill of station.pills) {
        const key = pillKey(pill);
        if (key !== undefined) keys.add(key);
      }
    }
    return keys;
  }, [model]);
  const orphanQuestions = pendingQuestions.filter((question) => {
    const key = questionKey(question);
    return key === undefined || !attachedKeys.has(key);
  });
  // 每一节要画的竖轨与曲线（`workflowRunSpine.ts`）：轨道段按**成对**查，不按 from——带里
  // 一站可以同时是双线段与主线段的左端。
  const sections = spineSections(model);
  const nameOf = (pill: TimelinePill) => pill.runtimeName ?? laneDisplayName(pill.lane, format);
  const phaseNameOf = (phaseId: string) => {
    const station = model.stations.find((candidate) => candidate.id === phaseId);
    return station === undefined ? phaseId : phaseDisplayName(station.naming, format);
  };

  // 行交出槽位身份：会话 id 有则随行，没有就开占位 tab。
  const openActor = (pill: TimelinePill) => {
    const slot = pill.slot;
    if (onOpenActor === undefined || slot === undefined) return;
    const sessionId = pill.instance?.sessionId;
    onOpenActor({
      ordinal: slot.ordinal,
      ...(sessionId === undefined ? {} : { sessionId }),
      siteId: slot.siteId,
      status:
        pill.status === "running"
          ? "running"
          : pill.status === "done" || pill.status === "failed"
            ? "completed"
            : "waiting",
      ...(pill.runtimeName === undefined ? {} : { name: pill.runtimeName }),
    });
  };

  /** 药丸的公共接线（名字、状态、可打开）；整行药丸与「列出全部」的密排药丸共用。 */
  const pillProps = (pill: TimelinePill) => {
    const label = nameOf(pill);
    const openable = onOpenActor !== undefined && pill.slot !== undefined;
    // 脚本行同一条打开语法：开整个 run 的脚本 transcript，落到这一站的第一张卡。
    const workspacePhaseId = onOpenWorkspace === undefined ? undefined : pill.workspace?.phaseId;
    const open: WorkflowAgentPillOpen | undefined = openable
      ? {
          data: {
            "data-agent-key": pillKey(pill) ?? "",
            "data-agent-session-id": pill.instance?.sessionId ?? "",
            "data-agent-status": pill.status ?? "pending",
          },
          label: format({ id: "chat.toolCall.workflow.timeline.openAgent" }, { name: label }),
          onOpen: () => openActor(pill),
          testId: "workflow-run-agent-open",
        }
      : workspacePhaseId !== undefined
        ? {
            data: { "data-phase-id": workspacePhaseId },
            label: format(
              { id: "chat.toolCall.workflow.timeline.openScript" },
              { phase: phaseNameOf(workspacePhaseId) },
            ),
            onOpen: () => onOpenWorkspace?.(workspacePhaseId),
            testId: "workflow-run-workspace-open",
          }
        : undefined;
    return {
      avatarIndex: pill.avatarIndex,
      laneClass: pill.laneClass,
      name: label,
      status: pill.status,
      title: label,
      ...(open === undefined ? {} : { open }),
    };
  };

  const renderPill = (pill: TimelinePill) => {
    const activity = pillActivity(graph, run, pill);
    const key = pillKey(pill);
    const questions = key === undefined ? [] : (questionsByInstance.get(key) ?? []);
    const counts: string[] = [];
    if (activity.asks > 0) {
      counts.push(
        format({ id: "chat.toolCall.workflow.graph.card.tasks" }, { count: activity.asks }),
      );
    }
    if (activity.reads > 0) {
      counts.push(
        format({ id: "chat.toolCall.workflow.graph.card.reads" }, { count: activity.reads }),
      );
    }
    // 可打开的药丸是 <button>：块级父元素里它只包住内容，行宽会随名字长短参差。
    // 纵向 flex 容器让每一行拉满本列宽度（与卡上站下的药丸列同一机制）。
    return (
      <div className="flex min-w-0 flex-col" key={pill.key}>
        <WorkflowAgentPill {...pillProps(pill)}>
          {counts.length === 0 ? null : (
            <span className="shrink-0 font-mono text-ui-xs tabular-nums text-foreground-subtlest">
              {counts.join(" · ")}
            </span>
          )}
        </WorkflowAgentPill>
        {/* 问题挂在提问者下面，再退一步（26px）：它属于这一行，不属于这一站。 */}
        {questions.map((question) => (
          <WorkflowRunQuestionRow
            className="ml-[26px]"
            key={question.qid}
            now={now}
            question={question}
          />
        ))}
      </div>
    );
  };

  return (
    <div
      className="wf-motion flex min-h-0 flex-1 flex-col overflow-auto pb-3 pt-2.5"
      data-testid="workflow-run-phases"
      ref={rootRef}
    >
      {model.stations.map((station, index) => {
        const expanded = open.has(station.id);
        const name = phaseDisplayName(station.naming, format);
        const status = station.status ?? "pending";
        const pending = status === "pending";
        const spine = sections[index] ?? { curves: [], rails: [] };
        // 分支站整节右移一格：节头、药丸与灯一起，轨道之间 12px。
        const indent = station.track === 0 ? undefined : { paddingLeft: 39 + 12 * station.track };
        const roster = stationRosterOf(station, ROSTER_PINS_PANE);
        return (
          <section
            className="relative"
            data-phase-id={station.id}
            data-phase-landed={landed?.phaseId === station.id ? "true" : undefined}
            data-phase-open={expanded ? "true" : "false"}
            data-phase-status={status}
            data-phase-track={station.track}
            data-testid="workflow-run-phase"
            key={station.id}
          >
            <SpinePieces section={spine} />
            <button
              aria-expanded={expanded}
              aria-label={intl.formatMessage(
                {
                  id: expanded
                    ? "chat.toolCall.workflow.run.phase.collapse"
                    : "chat.toolCall.workflow.run.phase.expand",
                },
                { name },
              )}
              className={cn(
                "wf-station-open relative flex h-9 w-full items-center gap-2 pl-[39px] pr-3 text-left outline-none transition-colors hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring/40",
                landed?.phaseId === station.id && "wf-landed",
              )}
              data-testid="workflow-run-phase-toggle"
              // 再落时换 key 重挂节头：同一个类名不会让 CSS 动画重来。
              key={landed?.phaseId === station.id ? landed.key : "head"}
              onClick={() => toggle(station.id)}
              style={indent}
              type="button"
            >
              <SpineLamp status={status} track={station.track} />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-ui-base",
                  pending ? "text-foreground-subtle" : "font-medium text-foreground",
                )}
              >
                {name}
              </span>
              <span className="flex shrink-0 items-center gap-2.5 font-mono text-ui-xs tabular-nums text-foreground-subtlest">
                {expanded ? null : roster !== undefined ? (
                  <RosterMeter counts={roster.counts} mini />
                ) : (
                  <AvatarCluster nameOf={nameOf} pills={station.pills} />
                )}
                {station.fraction === undefined ? null : (
                  <span data-testid="workflow-run-phase-fraction">
                    {station.fraction.settled}/{station.fraction.observed}
                  </span>
                )}
                <Rounds station={station} />
                <ChevronRightIcon
                  aria-hidden
                  className={cn("size-3.5 transition-transform", expanded && "rotate-90")}
                />
              </span>
            </button>
            {expanded ? (
              <div
                className="wf-unfold flex flex-col gap-1.5 pb-3 pl-[39px] pr-3 pt-0.5"
                style={indent}
              >
                {roster === undefined ? (
                  station.pills.map(renderPill)
                ) : (
                  <>
                    <div className="flex flex-col gap-1.5" data-testid="workflow-roster-pins">
                      {roster.pinned.map(renderPill)}
                    </div>
                    <WorkflowMoreRow
                      door={{
                        open: listed.has(station.id),
                        tally: rosterRestCounts(roster),
                      }}
                      more={rosterMore(roster)}
                      onOpen={() => toggleListed(station.id)}
                    />
                    {listed.has(station.id) ? (
                      <WorkflowRoll
                        groups={rosterRoll(roster)}
                        unlisted={roster.unlisted.actors}
                        renderRow={(pill, enterDelayMs) => (
                          <WorkflowAgentPill
                            enterDelayMs={enterDelayMs}
                            key={pill.key}
                            size="row"
                            {...pillProps(pill)}
                          >
                            {/* 第六个及以后的提问者落在名单里：尾槽前一枚 ?，问题本身不在这里重复。 */}
                            {pill.asking === true ? (
                              <CircleHelpIcon
                                aria-hidden
                                className="size-3 shrink-0 text-warning"
                                data-testid="workflow-roll-asking"
                              />
                            ) : null}
                          </WorkflowAgentPill>
                        )}
                      />
                    ) : null}
                  </>
                )}
              </div>
            ) : null}
          </section>
        );
      })}
      {orphanQuestions.length === 0 ? null : (
        <div
          className="flex flex-col gap-1 pl-[39px] pr-3 pt-2"
          data-testid="workflow-run-orphan-questions"
        >
          <span className="text-ui-xs font-medium text-foreground-subtle">
            {intl.formatMessage({ id: "chat.toolCall.workflow.run.questions.title" })}
          </span>
          {orphanQuestions.map((question) => (
            <WorkflowRunQuestionRow key={question.qid} now={now} question={question} showAsker />
          ))}
        </div>
      )}
    </div>
  );
});
