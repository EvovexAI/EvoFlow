import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { cn } from "@/components/lib/utils.js";
import { laneDisplayName } from "@/components/workflow-graph/lane-name.js";
import { phaseDisplayName } from "@/components/workflow-graph/phase-name.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { TimelinePill, TimelineStation, WorkflowTimelineModel } from "./timeline-model.js";
import { ROSTER_PINS_CARD, rosterMore, stationRosterOf } from "./roster-model.js";
import { useTypewriter } from "./use-typewriter.js";
import { WorkflowAgentPill } from "./WorkflowAgentPill.js";
import { WorkflowMoreRow } from "./WorkflowMoreRow.js";
import {
  PILL_GAP,
  PILL_HEIGHT,
  RAIL_ROW,
  STATION_PITCH,
  STATION_WIDTH,
  stationX,
  timelineLayout,
  timelineWidth,
} from "./timeline-geometry.js";
import { WorkflowTimelineArcs } from "./WorkflowTimelineArcs.js";
import { WorkflowStationPlatform, WorkflowStationRow } from "./WorkflowTimelineStation.js";
import { WorkflowTimelineLamps, WorkflowTimelineTracks } from "./WorkflowTimelineTracks.js";
import {
  NO_FOLD,
  flightAfterScroll,
  foldStations,
  ledgeStubWidth,
  railKey,
  stationCameraLeft,
  timelineMaskStyle,
  type CameraFlight,
} from "./timeline-ledge.js";
import { useTimelineViewport } from "./use-timeline-viewport.js";
import {
  WorkflowLedge,
  WorkflowTimelineScrollbar,
  prefersReducedMotion,
} from "./WorkflowTimelineLedge.js";

export { STATION_GAP, STATION_PITCH, STATION_WIDTH, timelineWidth } from "./timeline-geometry.js";

/**
 * 横向时间线：一根轨道、站在轨道上、
 * 药丸挂在站下、弧在轨道上方的空气里。纯 DOM + 一层 SVG（只画弧），没有画布库。
 *
 * 几何常量与设计画布逐字相同（`timeline-geometry.ts`）：站宽 168、站距 24（五站 = 936，装进 960 的
 * 会话列），轨道行 24，弧道距 14。灯落在药丸头像列（站左缘 + 17），名字落在子代理名列（站左缘 + 34）
 * ——站头就是一枚没有背景的药丸。
 *
 * 宽过容器就自由滚动：灯滚出视口的站折叠到那一侧的**边檐**上——同一枚灯、16px 一枚，
 * 落在视口边缘干净的底上；轨道行在檐旁渐隐 40px，药丸只在视口真正的边界渐隐；位置在底部一根 2px 的滚动条里。
 * 原生滚动条隐藏，右缘不再涂渐变，表头也不再需要秩带。镜头照旧对准正在运行的站；镜头在飞时目标站不折
 * （视口在 scrollTo 之前量过，飞行中按陈旧位置算它在视野外是误报）。
 *
 * 草稿（`model.draft`）由笔写出：站按声明序一站一站揭示，轨道段从左伸出、
 * 灯落地、名字逐字写出，光标跟着笔走、追上流时闪烁。笔没到的站还不在轨道上。
 */
function stationHeight(station: TimelineStation): number {
  // 过了阈值的站是五枚钉住的药丸加一行「还有 n 个」：那一行就是第六枚
  // 药丸，所以一站永远不高于六枚药丸。
  const roster = stationRosterOf(station, ROSTER_PINS_CARD);
  const n = roster === undefined ? station.pills.length : roster.pinned.length + 1;
  return n === 0 ? 0 : n * PILL_HEIGHT + (n - 1) * PILL_GAP;
}

/**
 * 时间线的整体高度（弧道 + 轨道行 + 站台行 + 最高的一列药丸）。轮尾摘要展开 /
 * 收起时把外框的高度在两个值之间过渡，所以它必须能在渲染之外算出来——行的排布因此是
 * `timeline-geometry.ts` 里的纯函数。末尾 8px 留白是滚动条的家（药丸下 6px、2px 一根，
 * 悬停 4px）——它贴着底缘叠在留白上，不改高度。
 */
export function timelineHeight(model: WorkflowTimelineModel): number {
  const rows = timelineLayout(model.arcs, model.bands);
  return rows.pillsTop + Math.max(0, ...model.stations.map(stationHeight)) + 8;
}

/** 药丸依次落地的间隔（与设计画布同值）。 */
export const PILL_STAGGER_MS = 30;

function pillName(pill: TimelinePill, format: Parameters<typeof laneDisplayName>[1]): string {
  return pill.runtimeName ?? laneDisplayName(pill.lane, format);
}

export interface WorkflowTimelineProps {
  model: WorkflowTimelineModel;
  className?: string;
  /** 点一个站；缺席即站头不是控件——点击冒泡给宿主（轮尾摘要的整块开关）。 */
  onSelectStation?: (station: TimelineStation) => void;
  /**
   * 点名册站的「还有 n 个」那一行：开 run 详情、落到这一站。与站头的
   * `onSelectStation` 分开门控：轮尾摘要里站头仍是整块开关的一部分，那一行
   * 却是一扇门。缺席即那一行是静态的。
   */
  onOpenMore?: (station: TimelineStation) => void;
  /** 点一枚药丸（有会话开 transcript，没有开占位）；缺席即不可点。 */
  onOpenPill?: (pill: TimelinePill) => void;
  /**
   * 点脚本药丸：开整个 run 的脚本 transcript，
   * 落到这一站；缺席即脚本药丸不可点。与 `onOpenPill` 各自门控各自的车道。
   */
  onOpenWorkspace?: (pill: TimelinePill) => void;
}

export const WorkflowTimeline = memo(function WorkflowTimeline({
  className,
  model,
  onOpenMore,
  onOpenPill,
  onOpenWorkspace,
  onSelectStation,
}: WorkflowTimelineProps) {
  const { intl } = useZCodeIntl();
  const format = intl.formatMessage.bind(intl);
  const markerId = useId();
  const scrollRef = useRef<HTMLDivElement>(null);
  // 滚动层元素同时进状态：草稿首帧 n === 0 返回 null，滚动层晚一帧才挂上——视口钩子以元素为依赖，
  // 元素出现才接监听（以 ref 对象为依赖时首帧的 null 让它永远接不上）。
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const attachScroller = useCallback((element: HTMLDivElement | null) => {
    scrollRef.current = element;
    setScroller(element);
  }, []);
  // 镜头的一班飞行：起飞时记下，落地或用户接手时清空；飞行中目标站不折。
  const [flight, setFlight] = useState<CameraFlight | undefined>(undefined);

  const { arcs } = model;
  const draft = model.draft !== undefined;
  const fullNames = model.stations.map((station) => phaseDisplayName(station.naming, format));
  const pen = useTypewriter(draft ? fullNames : undefined);
  const stations = draft ? model.stations.slice(0, pen.visible) : model.stations;
  const n = stations.length;
  const rails = draft ? model.rails.filter((rail) => rail.to < n) : model.rails;
  // 行的排布：有带时主线落在最下面
  // 一行、分支叠在它上面、站头搬到站台行；没有带时整套式子逐像素退回从前的「弧道 + 轨道行」，
  // DOM 也走原来那一支。
  const layout = timelineLayout(model.arcs, model.bands);
  const { banded, inset, pillsTop } = layout;
  const top = layout.rowY[0]! - RAIL_ROW / 2;
  const width = timelineWidth(n, inset);
  const height = timelineHeight(draft ? { ...model, stations } : model);
  // 药丸按站从左到右、站内从上到下依次落地：第 k 枚延迟 k × 30 ms（「还有 n 个」那一行也排队）。
  let pillOrdinal = 0;
  const nextDelay = () => {
    const delay = PILL_STAGGER_MS * pillOrdinal;
    pillOrdinal += 1;
    return delay;
  };
  // 轨道段按**一对站**查：带里一站可以同时长出主线的一条、
  // 分叉的一条与双线段。
  const railByPair = useMemo(
    () => new Map(rails.map((rail) => [railKey(rail.from, rail.to), rail])),
    [rails],
  );

  // 视口：滚到哪、多宽、内容多宽。量不到（jsdom）时三者为 0，下面什么都不折。
  const viewport = useTimelineViewport(scroller, width);
  // 每次滚动采样后结算飞行：落地或偏离即结束。只由位置决定，不用计时器。
  useEffect(() => {
    setFlight((current) => flightAfterScroll(current, viewport.scrollLeft));
  }, [viewport.scrollLeft]);
  const overflow = viewport.clientWidth > 0 && viewport.scrollWidth > viewport.clientWidth;
  const fold = overflow
    ? foldStations(n, viewport.scrollLeft, viewport.clientWidth, flight?.index, inset)
    : NO_FOLD;
  const folded = useMemo(() => new Set([...fold.left, ...fold.right]), [fold]);
  // 遮罩分两带：轨道带在檐旁渐隐，药丸带只在视口真正的边界渐隐。
  const mask = overflow
    ? timelineMaskStyle(fold, pillsTop - 8, {
        left: viewport.scrollLeft > 0,
        right: viewport.scrollLeft < viewport.scrollWidth - viewport.clientWidth - 1,
      })
    : undefined;

  const scrollTo = useCallback((left: number) => {
    const element = scrollRef.current;
    if (element === null) return;
    element.scrollTo({ behavior: prefersReducedMotion() ? "auto" : "smooth", left });
  }, []);
  // 檐上的灯：镜头把那一站带回正中（与运行站的镜头同一条规则）。
  const selectFolded = useCallback(
    (index: number) =>
      scrollTo(stationCameraLeft(index, scrollRef.current?.clientWidth ?? 0, inset)),
    [inset, scrollTo],
  );
  // 焦点在站头或檐上的灯时，← → 各滚一站。
  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const target = event.target as HTMLElement;
      if (target.closest("[data-testid='workflow-timeline-station'], .wf-ledge") === null) return;
      const element = scrollRef.current;
      if (element === null || element.scrollWidth <= element.clientWidth) return;
      event.preventDefault();
      scrollTo(element.scrollLeft + (event.key === "ArrowLeft" ? -STATION_PITCH : STATION_PITCH));
    },
    [scrollTo],
  );

  // 镜头：宽过容器时把焦点站滚进视野；用户自己滚过就不再抢（只在焦点站变化时重锚）。
  // run 里焦点是正在运行的站（居中）；草稿里焦点跟着笔走——最新揭示的站贴着右缘。
  // 草稿的落点是 index·PITCH + STATION_WIDTH − clientWidth：不能多加一个站距（会 24px 过冲，只有靠浏览器夹紧才落对）。
  const focusIndex = draft ? (n > 0 ? n - 1 : undefined) : model.runningIndex;
  useEffect(() => {
    const element = scrollRef.current;
    if (element === null || focusIndex === undefined) return;
    if (element.scrollWidth <= element.clientWidth) return;
    const left = draft
      ? Math.max(0, stationX(focusIndex, inset) + STATION_WIDTH - element.clientWidth)
      : stationCameraLeft(focusIndex, element.clientWidth, inset);
    // 起飞：目标按可滚范围夹紧；已在目标上就不算飞。
    const target = Math.min(left, element.scrollWidth - element.clientWidth);
    const from = element.scrollLeft;
    setFlight(Math.abs(from - target) <= 1 ? undefined : { from, index: focusIndex, target });
    element.scrollTo({ behavior: prefersReducedMotion() ? "auto" : "smooth", left });
  }, [draft, focusIndex, inset]);

  if (n === 0) return null;

  const stationTitleOf = (phaseId: string): string => {
    const station = model.stations.find((candidate) => candidate.id === phaseId);
    return station === undefined ? phaseId : phaseDisplayName(station.naming, format);
  };
  const stationTitle = (station: TimelineStation): string => {
    const name = phaseDisplayName(station.naming, format);
    return station.onLoop && station.rounds > 0
      ? `${name} · ${intl.formatMessage({ id: "chat.toolCall.workflow.timeline.rounds" }, { count: station.rounds })}`
      : name;
  };

  const renderPill = (pill: TimelinePill) => {
    const enterDelayMs = nextDelay();
    const label = pillName(pill, format);
    // 活的 run 里的子代理药丸一律可开：有会话开 transcript，还没启动的
    // 开同一个 tab 的占位——槽位身份（`pill.slot`）就是它的抓手。没有 run 就没有槽位。
    // 脚本药丸同一套打开语法：活的 run 里有抓手
    // 就可开，落到这一站的第一张卡。没有色相，悬停的描边退回 border-hover（药丸自己的规则）。
    const open =
      onOpenPill !== undefined && pill.slot !== undefined
        ? {
            label: format({ id: "chat.toolCall.workflow.timeline.openAgent" }, { name: label }),
            onOpen: () => onOpenPill(pill),
            testId: "workflow-timeline-pill-open",
          }
        : onOpenWorkspace !== undefined && pill.workspace !== undefined
          ? {
              label: format(
                { id: "chat.toolCall.workflow.timeline.openScript" },
                { phase: stationTitleOf(pill.workspace.phaseId) },
              ),
              onOpen: () => onOpenWorkspace(pill),
              testId: "workflow-timeline-workspace-open",
            }
          : undefined;
    return (
      <WorkflowAgentPill
        enterDelayMs={enterDelayMs}
        key={pill.key}
        avatarIndex={pill.avatarIndex}
        laneClass={pill.laneClass}
        name={label}
        status={pill.status}
        {...(open === undefined ? {} : { open })}
      />
    );
  };

  const ledgeProps = {
    nameOf: (index: number) => fullNames[index]!,
    onSelect: selectFolded,
    rails: railByPair,
    stations,
    top,
  };

  return (
    <div
      className={cn("wf-motion wf-timeline min-w-0", className)}
      data-testid="workflow-timeline"
      onKeyDown={onKeyDown}
    >
      {/* 檐与滚动条叠在滚动层之上，以它（而不是带 padding 的外框）为基准定位。 */}
      <div className="relative">
        <div
          className="wf-scroller overflow-x-auto overflow-y-hidden"
          data-testid="workflow-timeline-scroller"
          data-timeline-fade={
            fold.left.length > 0 && fold.right.length > 0
              ? "both"
              : fold.left.length > 0
                ? "left"
                : fold.right.length > 0
                  ? "right"
                  : undefined
          }
          ref={attachScroller}
          style={mask}
        >
          <div className="relative" style={{ height, width }}>
            <WorkflowTimelineArcs
              arcs={arcs}
              bands={model.bands}
              height={height}
              layout={layout}
              markerId={markerId}
              stations={model.stations}
              width={width}
            >
              {/* 有带时轨道也进这一层 SVG：分叉与汇合是曲线，DOM 的 border 画不出来。 */}
              {banded ? (
                <WorkflowTimelineTracks
                  folded={folded}
                  layout={layout}
                  model={{ bands: model.bands, rails, stations }}
                />
              ) : null}
            </WorkflowTimelineArcs>

            {banded ? (
              <WorkflowTimelineLamps
                draft={draft}
                folded={folded}
                layout={layout}
                stations={stations}
              />
            ) : null}

            {banded ? (
              <WorkflowStationPlatform
                folded={folded}
                fullNames={fullNames}
                layout={layout}
                stations={stations}
                titleOf={stationTitle}
                {...(onSelectStation === undefined ? {} : { onSelectStation })}
              />
            ) : (
              <WorkflowStationRow
                draft={draft}
                folded={folded}
                fullNames={fullNames}
                pen={pen}
                rails={railByPair}
                stations={stations}
                titleOf={stationTitle}
                top={top}
                width={width}
                {...(onSelectStation === undefined ? {} : { onSelectStation })}
              />
            )}

            {stations.map((station, i) => {
              const roster = stationRosterOf(station, ROSTER_PINS_CARD);
              // 名册在就还有话说：一站的药丸全被界淘汰掉时剩下「还有 n 个」那一行，而不是凭空消失。
              if (station.pills.length === 0 && roster === undefined) return null;
              return (
                <div
                  className="absolute flex flex-col"
                  data-station-roster={roster === undefined ? undefined : "true"}
                  data-testid="workflow-timeline-pills"
                  key={station.id}
                  style={{
                    gap: PILL_GAP,
                    left: stationX(i, inset),
                    top: pillsTop,
                    width: STATION_WIDTH,
                  }}
                >
                  {roster === undefined ? (
                    station.pills.map(renderPill)
                  ) : (
                    // 名册站：钉住的五枚沿用药丸的接线，之后一行
                    // 「还有 n 个」——点它开 run 详情、落到这一站（`onOpenMore`，自己的门）。
                    <>
                      {roster.pinned.map(renderPill)}
                      <WorkflowMoreRow
                        enterDelayMs={nextDelay()}
                        more={rosterMore(roster)}
                        {...(onOpenMore === undefined ? {} : { onOpen: () => onOpenMore(station) })}
                      />
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        {/* 边檐：折到视口两侧的站，一排灯落在轨道行上，檐下的内容已被遮罩清空。 */}
        <WorkflowLedge
          indexes={fold.left}
          side="left"
          stubWidth={ledgeStubWidth(fold, "left", viewport.scrollLeft, viewport.clientWidth, inset)}
          {...ledgeProps}
        />
        <WorkflowLedge
          indexes={fold.right}
          side="right"
          stubWidth={ledgeStubWidth(
            fold,
            "right",
            viewport.scrollLeft,
            viewport.clientWidth,
            inset,
          )}
          {...ledgeProps}
        />
        {overflow ? <WorkflowTimelineScrollbar scrollRef={scrollRef} viewport={viewport} /> : null}
      </div>
    </div>
  );
});
