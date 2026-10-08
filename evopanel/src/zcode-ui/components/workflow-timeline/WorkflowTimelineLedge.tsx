import {
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { cn } from "@/components/lib/utils.js";
import { STATUS_DOT } from "@/components/workflow-graph/run-status-presentation.js";
import type { StepRunStatus } from "@/components/workflow-graph/types.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { TimelineRail, TimelineStation } from "./timeline-model.js";
import { LEDGE_PITCH, LEDGE_LAMP, ledgeLamps, railKey, scrollbarThumb } from "./timeline-ledge.js";
import type { TimelineViewport } from "./use-timeline-viewport.js";

/**
 * 边檐与滚动条。
 *
 * 边檐：折叠到视口一侧的站，画成一排同一枚 10px 灯（16px 一枚），之间是那条边的墨色小轨道段，
 * 靠内容的一端一段短轨道接到第一个开着的站，远端是超出五枚时的 `+n`。每枚灯是按钮：点一下，
 * 镜头把那一站带回来。折叠的站在内容里不画——檐上那枚灯**就是**它。
 *
 * 滚动条：时间线底部 2px 一根，轨道 border 色、拇指 foreground-subtlest；静止时 opacity 0，指针在
 * 卡上或正在滚时露出，悬停轨道加粗到 4px；拇指可拖，点轨道翻页。原生滚动条隐藏。
 */

/** 站灯：`STATUS_DOT` 词汇表，running 外加 3px 光晕（呼吸）——它是画面上唯一发光的东西。 */
export function stationLampClass(status: StepRunStatus | undefined): string {
  const resolved = status ?? "pending";
  return cn(
    "wf-lamp size-2.5 shrink-0 rounded-full",
    STATUS_DOT[resolved],
    resolved === "running" && "wf-lamp-running motion-reduce:animate-none",
  );
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

// 补线需与静态主轨道同为 1px，避免滚动边缘出现粗细接缝。
// 双线段：檐上两站并行时不是一条线，
// 而是两条 1px、相距 2px——檐把带压扁了，分叉与汇合画不下，两条并排的线是这里唯一还说得出
// 「同时」的记号。
function Segment({ rail, width }: { rail: TimelineRail | undefined; width: number }) {
  if (rail?.kind === "twin") {
    return (
      <span
        aria-hidden
        className="relative h-0 shrink-0"
        data-ledge-ink={rail.ink}
        data-ledge-twin="true"
        style={{ width }}
      >
        <span
          className="absolute inset-x-0 h-0 border-t border-foreground-subtlest"
          style={{ top: -1 }}
        />
        <span
          className="absolute inset-x-0 h-0 border-t border-foreground-subtlest"
          style={{ top: 1 }}
        />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className={cn(
        "h-0 shrink-0 border-t border-foreground-subtlest",
        rail === undefined && "invisible",
      )}
      data-ledge-ink={rail?.ink ?? "none"}
      style={{ width }}
    />
  );
}

export function WorkflowLedge({
  indexes,
  nameOf,
  onSelect,
  rails,
  side,
  stations,
  stubWidth,
  top,
}: {
  side: "left" | "right";
  /** 折叠到这一侧的站（升序）。 */
  indexes: readonly number[];
  stations: readonly TimelineStation[];
  /** 相邻站之间的轨道段，按**一对站**索引（`railKey`）：带里一站会长出好几条段。 */
  rails: ReadonlyMap<string, TimelineRail>;
  /** 檐到第一个开着的站之间那段短轨道的宽；0 = 不画。 */
  stubWidth: number;
  /** 轨道行的顶（檐与灯同高）。 */
  top: number;
  nameOf: (index: number) => string;
  onSelect: (index: number) => void;
}) {
  const { intl } = useZCodeIntl();
  if (indexes.length === 0) return null;
  const { shown, more } = ledgeLamps(indexes, side);
  const stubRail =
    side === "left"
      ? rails.get(railKey(indexes[indexes.length - 1]!, indexes[indexes.length - 1]! + 1))
      : rails.get(railKey(indexes[0]! - 1, indexes[0]!));
  const stub = stubWidth > 0 ? <Segment rail={stubRail} width={stubWidth} /> : null;
  const count =
    more > 0 ? (
      <span
        className="shrink-0 text-center font-mono text-ui-2xs text-foreground-subtlest"
        data-testid="workflow-timeline-ledge-more"
        style={{ width: 26 }}
      >
        +{more}
      </span>
    ) : null;
  const lamps = shown.map((index, k) => {
    const station = stations[index]!;
    const label = `${nameOf(index)} · ${intl.formatMessage({ id: `chat.toolCall.workflow.graph.status.${station.status ?? "pending"}` })}`;
    return (
      <span className="flex items-center" key={station.id}>
        {k > 0 ? (
          <Segment
            rail={rails.get(railKey(shown[k - 1]!, index))}
            width={LEDGE_PITCH - LEDGE_LAMP}
          />
        ) : null}
        <button
          aria-label={label}
          className="wf-ledge-lamp relative flex shrink-0 cursor-pointer items-center justify-center rounded-full outline-none before:absolute before:-inset-1 before:content-[''] focus-visible:ring-2 focus-visible:ring-ring/40"
          data-station-index={index}
          data-testid="workflow-timeline-ledge-lamp"
          onClick={() => onSelect(index)}
          style={{ height: LEDGE_LAMP, width: LEDGE_LAMP }}
          title={label}
          type="button"
        >
          <span
            aria-hidden
            className={cn(stationLampClass(station.status), "wf-land")}
            data-lamp={station.status ?? "pending"}
          />
        </button>
      </span>
    );
  });
  return (
    <div
      aria-label={intl.formatMessage(
        { id: `chat.toolCall.workflow.timeline.ledge.${side === "left" ? "earlier" : "later"}` },
        { count: indexes.length },
      )}
      className={cn(
        "wf-ledge pointer-events-auto absolute flex h-6 items-center",
        side === "left" ? "left-0 pl-2" : "right-0 pr-2",
      )}
      data-testid={`workflow-timeline-ledge-${side}`}
      role="group"
      style={{ top }}
    >
      {side === "left" ? count : stub}
      {lamps}
      {side === "left" ? stub : count}
    </div>
  );
}

/**
 * 拖完拇指或点完轨道，浏览器还会补发一次 click，它会沿着 DOM 冒到宿主卡片——轮尾摘要卡把
 * 「空白处点一下」当成折叠 / 展开，而它的子控件谓词只认 button / a / 表单件，不认 scrollbar。
 * 用户拖一下滑块，卡片就折起来了。滚动条的点击到此为止：它已经把这次交互消费掉了。
 */
function stopClick(event: ReactMouseEvent<HTMLDivElement>) {
  event.stopPropagation();
}

export function WorkflowTimelineScrollbar({
  scrollRef,
  viewport,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  viewport: TimelineViewport;
}) {
  const { intl } = useZCodeIntl();
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ pointerId: number; startX: number; startLeft: number } | null>(null);
  const thumb = scrollbarThumb(viewport.scrollLeft, viewport.clientWidth, viewport.scrollWidth);
  if (thumb === undefined) return null;
  const range = viewport.scrollWidth - viewport.clientWidth;
  const ratio = viewport.scrollWidth / viewport.clientWidth;

  const onThumbDown = (event: ReactPointerEvent<HTMLSpanElement>) => {
    event.stopPropagation();
    event.preventDefault();
    drag.current = {
      pointerId: event.pointerId,
      startLeft: viewport.scrollLeft,
      startX: event.clientX,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };
  const onThumbMove = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const state = drag.current;
    const element = scrollRef.current;
    if (state === null || element === null || state.pointerId !== event.pointerId) return;
    element.scrollLeft = state.startLeft + (event.clientX - state.startX) * ratio;
  };
  const onThumbUp = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setDragging(false);
  };
  const onTrackDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    const element = scrollRef.current;
    if (element === null) return;
    const x = event.clientX - event.currentTarget.getBoundingClientRect().left;
    const direction = x < thumb.left ? -1 : 1;
    element.scrollBy({
      behavior: prefersReducedMotion() ? "auto" : "smooth",
      left: direction * viewport.clientWidth,
    });
  };
  return (
    <div
      aria-label={intl.formatMessage({ id: "chat.toolCall.workflow.timeline.scrollbar" })}
      aria-orientation="horizontal"
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={Math.round((100 * Math.min(viewport.scrollLeft, range)) / range)}
      className="wf-sb absolute inset-x-0 bottom-0 h-0.5 cursor-pointer rounded-full bg-border"
      data-dragging={dragging ? "true" : undefined}
      data-scrolling={viewport.scrolling ? "true" : undefined}
      data-testid="workflow-timeline-scrollbar"
      onClick={stopClick}
      onPointerDown={onTrackDown}
      role="scrollbar"
    >
      <span
        className="wf-sb-thumb absolute inset-y-0 rounded-full bg-foreground-subtlest"
        data-testid="workflow-timeline-scrollbar-thumb"
        onPointerDown={onThumbDown}
        onPointerMove={onThumbMove}
        onPointerUp={onThumbUp}
        style={{ left: thumb.left, width: thumb.width }}
      />
    </div>
  );
}
