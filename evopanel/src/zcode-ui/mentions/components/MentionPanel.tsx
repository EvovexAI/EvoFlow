/* oxlint-disable eslint(max-lines) -- 提示面板集中承载虚拟列表和 E2E 定位属性，暂不为少量测试属性拆组件。 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  TID_PROMPT_SUGGESTION_OPTION,
  TID_PROMPT_SUGGESTION_PANEL,
  TID_PROMPT_SUGGESTION_SECTION,
  TID_PROMPT_SUGGESTION_STATUS,
  testId,
} from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { Info, LoaderIcon } from "lucide-react";
import {
  EMPTY_SCROLL_MASK_STATE,
  getVerticalScrollMaskStyle,
  resolveVerticalScrollMaskState,
  type ScrollMaskState,
} from "@/mentions/components/scrollMask.js";

export interface MentionPanelOption {
  id: string;
  label: string;
  description: string;
  content?: ReactNode;
  meta?: ReactNode;
  /** 禁选态（如同名 Plugin 冲突 fail closed）：可见但不可点击，键盘导航由上层跳过。 */
  disabled?: boolean;
  /** 禁选原因；无自定义 content 时展示在描述位。 */
  disabledReason?: string;
}

export interface MentionPanelSection {
  id: string;
  title: string;
  options: MentionPanelOption[];
  emptyText: string;
  loadingText?: string;
  loading?: boolean;
  errorText?: string | null;
}

interface MentionPanelProps {
  title: string;
  description: string;
  footer?: ReactNode;
  listMaxHeight?: string;
  trigger: string;
  sections: MentionPanelSection[];
  emptyText: string;
  selectedIndex: number;
  hasActiveQuery: boolean;
  onSelect: (index: number) => void;
}

type VirtualRow =
  | {
      kind: "section_header";
      sectionId: string;
      title: string;
    }
  | {
      kind: "status";
      sectionId: string;
      content: "loading" | "error" | "empty";
      text: string;
    }
  | {
      kind: "option";
      sectionId: string;
      option: MentionPanelOption;
      flatOptionIndex: number;
    };

const OPTION_ROW_HEIGHT = 34;
const STATUS_ROW_HEIGHT = 40;
const SECTION_HEADER_ROW_HEIGHT = 34;

// 分组标题改用 base 字号后，旧的 28px 虚拟行装不下默认行高与 12px 上下 padding。
// 使用与命令项一致的 32px 可见高度和 34px 虚拟行高度，避免裁切或覆盖下一行。
const SECTION_HEADER_CLASS_NAME =
  "flex h-8 items-center px-3 text-ui-base font-semibold uppercase tracking-wide text-foreground-subtle";

function buildVirtualRows(sections: MentionPanelSection[]): VirtualRow[] {
  const rows: VirtualRow[] = [];
  let flatOptionIndex = 0;
  const shouldRenderSectionHeader = sections.length > 1;

  for (const section of sections) {
    if (shouldRenderSectionHeader && section.title.trim().length > 0) {
      rows.push({
        kind: "section_header",
        sectionId: section.id,
        title: section.title,
      });
    }

    if (section.errorText) {
      rows.push({
        kind: "status",
        sectionId: section.id,
        content: "error",
        text: section.errorText,
      });
    } else if (section.loading) {
      rows.push({
        kind: "status",
        sectionId: section.id,
        content: "loading",
        text: section.loadingText ?? section.emptyText,
      });
    } else if (section.options.length === 0) {
      rows.push({
        kind: "status",
        sectionId: section.id,
        content: "empty",
        text: section.emptyText,
      });
    } else {
      for (const option of section.options) {
        rows.push({
          kind: "option",
          sectionId: section.id,
          option,
          flatOptionIndex,
        });
        flatOptionIndex += 1;
      }
    }
  }

  return rows;
}

export function MentionPanel({
  title,
  description,
  footer,
  listMaxHeight,
  sections,
  emptyText,
  selectedIndex,
  hasActiveQuery,
  onSelect,
  trigger,
}: MentionPanelProps) {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [hoveredOptionIndex, setHoveredOptionIndex] = useState<number | null>(null);
  const [scrollMaskState, setScrollMaskState] = useState<ScrollMaskState>(EMPTY_SCROLL_MASK_STATE);

  const virtualRows = useMemo(() => buildVirtualRows(sections), [sections]);

  const virtualizer = useVirtualizer({
    count: virtualRows.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: (index) =>
      virtualRows[index]?.kind === "option"
        ? OPTION_ROW_HEIGHT
        : virtualRows[index]?.kind === "section_header"
          ? SECTION_HEADER_ROW_HEIGHT
          : STATUS_ROW_HEIGHT,
    overscan: 8,
  });
  const totalVirtualSize = virtualizer.getTotalSize();

  const updateScrollMaskState = useCallback(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) {
      setScrollMaskState(EMPTY_SCROLL_MASK_STATE);
      return;
    }

    const nextState = resolveVerticalScrollMaskState({
      clientHeight: scrollContainer.clientHeight,
      scrollHeight: scrollContainer.scrollHeight,
      scrollTop: scrollContainer.scrollTop,
    });

    setScrollMaskState((current) =>
      current.showTop === nextState.showTop && current.showBottom === nextState.showBottom
        ? current
        : nextState,
    );
  }, []);

  const scrollMaskStyle = useMemo(
    () => getVerticalScrollMaskStyle(scrollMaskState),
    [scrollMaskState],
  );

  // Scroll selected option into view
  const selectedVirtualIndex = useMemo(
    () =>
      virtualRows.findIndex(
        (row) => row.kind === "option" && row.flatOptionIndex === selectedIndex,
      ),
    [virtualRows, selectedIndex],
  );

  useEffect(() => {
    if (selectedVirtualIndex >= 0) {
      virtualizer.scrollToIndex(selectedVirtualIndex, { align: "auto" });
    }
  }, [selectedVirtualIndex, virtualizer]);

  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) {
      setScrollMaskState(EMPTY_SCROLL_MASK_STATE);
      return;
    }

    let frameId: number | null = null;
    const scheduleUpdate = () => {
      if (frameId !== null) {
        return;
      }
      frameId = requestAnimationFrame(() => {
        frameId = null;
        updateScrollMaskState();
      });
    };

    updateScrollMaskState();
    scrollContainer.addEventListener("scroll", scheduleUpdate, {
      passive: true,
    });

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(scheduleUpdate);
      resizeObserver.observe(scrollContainer);
      const contentElement = scrollContainer.firstElementChild;
      if (contentElement) {
        resizeObserver.observe(contentElement);
      }
    } else {
      window.addEventListener("resize", scheduleUpdate);
    }

    return () => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
      scrollContainer.removeEventListener("scroll", scheduleUpdate);
      resizeObserver?.disconnect();
      if (typeof ResizeObserver === "undefined") {
        window.removeEventListener("resize", scheduleUpdate);
      }
    };
  }, [totalVirtualSize, updateScrollMaskState, virtualRows.length]);

  return (
    <div
      className="mb-1 overflow-hidden rounded-2xl border border-border bg-menu shadow-xs"
      data-testid={TID_PROMPT_SUGGESTION_PANEL}
      data-trigger={trigger}
    >
      {virtualRows.length > 0 ? (
        <div
          ref={scrollContainerRef}
          className="max-h-56 overflow-y-auto px-1 py-0.75"
          role="listbox"
          aria-label={title}
          onMouseLeave={() => setHoveredOptionIndex(null)}
          style={{ ...scrollMaskStyle, ...(listMaxHeight ? { maxHeight: listMaxHeight } : {}) }}
        >
          <div
            style={{
              height: `${totalVirtualSize}px`,
              width: "100%",
              position: "relative",
            }}
          >
            {virtualizer.getVirtualItems().map((virtualItem) => {
              const row = virtualRows[virtualItem.index];
              if (!row) return null;

              return (
                <div
                  key={virtualItem.key}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    height: `${virtualItem.size}px`,
                    transform: `translateY(${virtualItem.start}px)`,
                  }}
                >
                  {row.kind === "status" ? (
                    <StatusRow row={row} />
                  ) : row.kind === "section_header" ? (
                    <SectionHeaderRow row={row} />
                  ) : (
                    <OptionRow
                      row={row}
                      isSelected={row.flatOptionIndex === selectedIndex}
                      isHovered={row.flatOptionIndex === hoveredOptionIndex}
                      onSelect={onSelect}
                      onHover={setHoveredOptionIndex}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ) : hasActiveQuery && emptyText ? (
        <div className="flex items-center justify-between px-4 py-3 text-ui-base text-foreground-subtlest">
          {emptyText}
        </div>
      ) : null}
      {!hasActiveQuery && footer ? footer : null}
      {!hasActiveQuery && description ? (
        <div className="flex items-center gap-2 px-4 py-3 text-ui-base text-foreground-subtle">
          <Info className="size-4 shrink-0 text-foreground" />
          <span>{description}</span>
        </div>
      ) : null}
    </div>
  );
}

function SectionHeaderRow({ row }: { row: Extract<VirtualRow, { kind: "section_header" }> }) {
  return (
    <div
      className={SECTION_HEADER_CLASS_NAME}
      data-testid={testId(TID_PROMPT_SUGGESTION_SECTION, row.sectionId)}
      data-section-id={row.sectionId}
    >
      {row.title}
    </div>
  );
}

function StatusRow({ row }: { row: Extract<VirtualRow, { kind: "status" }> }) {
  if (row.content === "loading") {
    return (
      <div
        className="flex items-center gap-2 rounded-xl px-5 py-2 text-ui-base text-foreground-subtle"
        data-testid={testId(TID_PROMPT_SUGGESTION_STATUS, row.sectionId)}
        data-section-id={row.sectionId}
        data-status="loading"
      >
        <LoaderIcon className="size-3.5 shrink-0 animate-spin" />
        <span>{row.text}</span>
      </div>
    );
  }

  if (row.content === "error") {
    return (
      <div
        className="rounded-xl bg-destructive px-5 py-2 text-ui-base text-destructive-foreground"
        data-testid={testId(TID_PROMPT_SUGGESTION_STATUS, row.sectionId)}
        data-section-id={row.sectionId}
        data-status="error"
      >
        {row.text}
      </div>
    );
  }

  return (
    <div
      className="rounded-xl px-5 py-2 text-ui-base text-foreground-subtlest"
      data-testid={testId(TID_PROMPT_SUGGESTION_STATUS, row.sectionId)}
      data-section-id={row.sectionId}
      data-status="empty"
    >
      {row.text}
    </div>
  );
}

function OptionRow({
  row,
  isSelected,
  isHovered,
  onSelect,
  onHover,
}: {
  row: Extract<VirtualRow, { kind: "option" }>;
  isSelected: boolean;
  isHovered: boolean;
  onSelect: (index: number) => void;
  onHover: (index: number | null) => void;
}) {
  const { option, flatOptionIndex } = row;
  const isDisabled = option.disabled === true;

  return (
    <div className="py-px w-full">
      <button
        type="button"
        role="option"
        aria-selected={isSelected}
        aria-disabled={isDisabled}
        disabled={isDisabled}
        data-testid={testId(TID_PROMPT_SUGGESTION_OPTION, option.id)}
        data-section-id={row.sectionId}
        data-option-id={option.id}
        data-option-index={flatOptionIndex}
        data-selected={isSelected ? "true" : "false"}
        data-disabled={isDisabled ? "true" : "false"}
        className={cn(
          "flex h-8 w-full items-center gap-3 rounded-xl px-3 text-left transition-colors",
          isDisabled
            ? "cursor-not-allowed opacity-50"
            : isSelected
              ? "bg-selected"
              : isHovered
                ? "bg-hover"
                : "hover:bg-hover",
        )}
        onMouseDown={(event) => {
          event.preventDefault();
          // 禁选项不触发选择：fail closed，冲突 Plugin 不能被插入。
          if (isDisabled) {
            return;
          }
          onSelect(flatOptionIndex);
        }}
        onMouseEnter={() => onHover(isDisabled ? null : flatOptionIndex)}
      >
        {option.content ? (
          <>{option.content}</>
        ) : (
          <span className="min-w-0 flex-1 flex">
            <span className="flex items-center gap-2 flex-auto">
              <span className="truncate text-ui-base font-medium text-foreground">
                {option.label}
              </span>
              {option.meta ? (
                <span className="shrink-0 text-ui-xs text-foreground-subtlest">{option.meta}</span>
              ) : null}
            </span>
            <span className="mt-1 block truncate text-ui-xs text-foreground-subtlest">
              {isDisabled && option.disabledReason ? option.disabledReason : option.description}
            </span>
          </span>
        )}
      </button>
    </div>
  );
}
