import type { ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";
import type { TimelineRail, TimelineStation } from "./timeline-model.js";
import {
  CAPTION_X,
  PLATFORM_ROW,
  RAIL_ROW,
  STATION_PITCH,
  STATION_WIDTH,
  stationX,
  type TimelineLayout,
} from "./timeline-geometry.js";
import { railKey } from "./timeline-ledge.js";
import type { TypewriterState } from "./use-typewriter.js";
import { StationMeta } from "./WorkflowStationMeta.js";
import { stationLampClass } from "./WorkflowTimelineLedge.js";

/**
 * 站头：名字 + 元数据，一枚没有背景的
 * 药丸。没有带时它排在轨道行上、灯的右边；有带时它搬到站台行，
 * 灯留在自己那条轨道上——两处的标记完全一样，所以从 `WorkflowTimeline.tsx` 拆出来共用一份。
 *
 * 不可点的站头是 `span` 而不是禁用的 `button`：浏览器对禁用控件不派发
 * click，整块开关就收不到；span 没有语义，点击照常冒泡。
 */
export function StationHead({
  caret,
  foldClass,
  name,
  onSelect,
  station,
  title,
}: {
  station: TimelineStation;
  name: string;
  /** 草稿里跟着笔走的光标；其余时候 null。 */
  caret: ReactNode;
  foldClass: string;
  title: string;
  /** 缺席即站头不是控件——点击冒泡给宿主（轮尾摘要的整块开关）。 */
  onSelect?: () => void;
}) {
  const pending = station.status === undefined || station.status === "pending";
  const head = (
    <>
      <span
        className={cn(
          "truncate text-ui-caption font-medium",
          pending ? "text-foreground-subtle" : "text-foreground",
        )}
      >
        {name}
        {caret}
      </span>
      <StationMeta station={station} />
    </>
  );
  return onSelect === undefined ? (
    <span
      className={cn(
        "wf-station flex h-6 min-w-0 shrink items-center gap-2 rounded-md text-left",
        foldClass,
      )}
      data-testid="workflow-timeline-station-head"
      title={title}
    >
      {head}
    </span>
  ) : (
    <button
      className={cn(
        "wf-station wf-station-open flex h-6 min-w-0 shrink cursor-pointer items-center gap-2 rounded-md text-left outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40",
        foldClass,
      )}
      onClick={onSelect}
      title={title}
      type="button"
    >
      {head}
    </button>
  );
}

interface RowProps {
  stations: readonly TimelineStation[];
  /** 站的全名，按下标；草稿里笔只写出前几个字。 */
  fullNames: readonly string[];
  folded: ReadonlySet<number>;
  titleOf: (station: TimelineStation) => string;
  onSelectStation?: (station: TimelineStation) => void;
}

/**
 * 轨道行（没有带时）：站头（灯 + 名字 + 元数据）与到下一站的轨道段，一站一格。折到檐上的站只留
 * 轨道段；药丸列不折（用户修订：两侧对称）——它们只随滚动走，在视口真正的边界处渐隐。
 */
export function WorkflowStationRow({
  draft,
  folded,
  fullNames,
  onSelectStation,
  pen,
  rails,
  stations,
  titleOf,
  top,
  width,
}: RowProps & {
  /** 相邻两站之间的轨道段，按 `railKey` 查。 */
  rails: ReadonlyMap<string, TimelineRail>;
  draft: boolean;
  pen: TypewriterState;
  top: number;
  width: number;
}) {
  const n = stations.length;
  return (
    <div className="absolute left-0 flex" style={{ height: RAIL_ROW, top, width }}>
      {stations.map((station, i) => {
        const rail = rails.get(railKey(i, i + 1));
        const full = fullNames[i]!;
        const name = draft ? full.slice(0, pen.shown[i] ?? 0) : full;
        const penHere = draft && i === n - 1;
        const foldClass = cn("wf-foldable", folded.has(i) && "wf-folded");
        return (
          <div
            className="flex h-6 min-w-0 items-center"
            data-station-folded={folded.has(i) ? "true" : undefined}
            data-station-status={station.status ?? "pending"}
            data-testid="workflow-timeline-station"
            key={station.id}
            style={{ width: i < n - 1 ? STATION_PITCH : STATION_WIDTH }}
          >
            <span
              aria-hidden
              className={cn(
                stationLampClass(station.status),
                "mx-3",
                foldClass,
                draft && "wf-land",
              )}
              data-lamp={station.status ?? "pending"}
            />
            <StationHead
              caret={
                penHere ? (
                  // 光标跟着笔：写字时稳住，追上流时闪烁。
                  <span
                    aria-hidden
                    className={cn(
                      "ml-px inline-block h-3 w-px bg-foreground align-[-1px]",
                      pen.idle && "wf-caret",
                    )}
                    data-pen={pen.idle ? "idle" : "writing"}
                    data-testid="workflow-timeline-caret"
                  />
                ) : null
              }
              foldClass={foldClass}
              name={name}
              station={station}
              title={titleOf(station)}
              {...(onSelectStation === undefined
                ? {}
                : { onSelect: () => onSelectStation(station) })}
            />
            {i < n - 1 ? (
              <span
                aria-hidden
                className={cn(
                  "wf-ink relative h-0 min-w-3 flex-1 rounded-full border-t border-foreground-subtlest",
                  draft && "wf-rail-grow",
                  rail === undefined && "invisible",
                  // 行进的段照常画底线，再叠一道不动的光（`.wf-rail-march::after`）：朝着灯渐亮。
                  rail?.ink === "march" && "wf-rail-march",
                )}
                data-rail-from={i}
                data-rail-ink={rail?.ink ?? "none"}
                data-rail-to={i + 1}
                data-testid="workflow-timeline-rail"
                style={{ marginLeft: 10, marginRight: -6 }}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * 站台行：有带时站头一律搬到轨道下面
 * 这一行，灯留在自己的轨道上，分支轨道的站由一条点状引线接回名字——主线的站不需要，它的灯就在
 * 名字正上方。草稿永远没有带，所以这里不必管笔。
 */
export function WorkflowStationPlatform({
  folded,
  fullNames,
  layout,
  onSelectStation,
  stations,
  titleOf,
}: RowProps & { layout: TimelineLayout }) {
  return (
    <>
      {stations.map((station, i) => (
        <div
          className="absolute flex h-6 min-w-0 items-center"
          data-station-folded={folded.has(i) ? "true" : undefined}
          data-station-status={station.status ?? "pending"}
          data-station-track={station.track}
          data-testid="workflow-timeline-station"
          key={station.id}
          style={{
            left: stationX(i, layout.inset) + CAPTION_X,
            top: layout.capY - PLATFORM_ROW / 2,
            width: STATION_WIDTH - CAPTION_X,
          }}
        >
          <StationHead
            caret={null}
            foldClass={cn("wf-foldable", folded.has(i) && "wf-folded")}
            name={fullNames[i]!}
            station={station}
            title={titleOf(station)}
            {...(onSelectStation === undefined ? {} : { onSelect: () => onSelectStation(station) })}
          />
        </div>
      ))}
    </>
  );
}
