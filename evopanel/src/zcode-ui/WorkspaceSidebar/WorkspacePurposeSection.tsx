import type { CSSProperties, ReactNode } from "react";
import { ChevronDown, ChevronRight, GripVertical } from "lucide-react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";

export function WorkspacePurposeSection({
  title,
  open,
  onOpenChange,
  action,
  children,
  testId,
  sortableId,
  dragHandleLabel,
}: {
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  action: ReactNode;
  children: ReactNode;
  testId: string;
  sortableId: string;
  dragHandleLabel: string;
}) {
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: sortableId });
  const style: CSSProperties = {
    transform: transform
      ? CSS.Transform.toString({ ...transform, scaleX: 1, scaleY: 1 })
      : undefined,
    transition,
    zIndex: isDragging ? 10 : undefined,
    opacity: isDragging ? 0.85 : 1,
  };

  return (
    <section
      ref={setNodeRef}
      style={style}
      data-testid={testId}
      aria-label={title}
      className="group/purpose-section relative"
    >
      <Collapsible open={open} onOpenChange={onOpenChange}>
        <div className="flex h-7 min-w-0 items-center">
          <CollapsibleTrigger asChild>
            {/* purpose 分组标题之前使用 13px，比同级“已置顶”更小。
                这里统一为 section title 的 text-ui-base，避免可折叠能力改变标题层级。 */}
            <button
              type="button"
              className="flex h-7 min-w-0 flex-1 items-center gap-1 px-2.5 text-left text-ui-base font-medium text-foreground-subtlest outline-none transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30"
            >
              <span className="min-w-0 truncate">{title}</span>
              {open ? (
                <ChevronDown
                  aria-hidden="true"
                  data-purpose-section-chevron="expanded"
                  className="size-3.5 shrink-0 opacity-0 transition-opacity group-hover/purpose-section:opacity-100 group-focus-within/purpose-section:opacity-100 [@media(hover:none)]:opacity-100"
                />
              ) : (
                <ChevronRight
                  aria-hidden="true"
                  data-purpose-section-chevron="collapsed"
                  className="size-3.5 shrink-0 opacity-0 transition-opacity group-hover/purpose-section:opacity-100 group-focus-within/purpose-section:opacity-100 [@media(hover:none)]:opacity-100"
                />
              )}
            </button>
          </CollapsibleTrigger>
          <div className="flex shrink-0 items-center pr-1.5 opacity-0 transition-opacity group-hover/purpose-section:opacity-100 group-focus-within/purpose-section:opacity-100 has-[[data-state=open]]:opacity-100 [@media(hover:none)]:opacity-100">
            <button
              ref={setActivatorNodeRef}
              type="button"
              aria-label={dragHandleLabel}
              data-purpose-section-drag-handle={sortableId}
              className="flex size-6 touch-none cursor-grab items-center justify-center rounded-md text-foreground-subtlest outline-none hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30 active:cursor-grabbing"
              {...attributes}
              {...listeners}
            >
              <GripVertical aria-hidden="true" className="size-3.5" />
            </button>
            {action}
          </div>
        </div>
        <CollapsibleContent>{children}</CollapsibleContent>
      </Collapsible>
    </section>
  );
}
