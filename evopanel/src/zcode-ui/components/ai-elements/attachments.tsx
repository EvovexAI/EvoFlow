/*
 * Derived from vercel/ai-elements (packages/elements/src/attachments.tsx).
 * Copyright 2023 Vercel, Inc. Licensed under Apache-2.0.
 * Modified by ZCode: local integration, formatting and adaptations.
 * See THIRD-PARTY-NOTICES.md in the repository root for license and provenance.
 */
"use client";

import { Button } from "../ui/button.js";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "../ui/hover-card.js";
import { cn } from "../lib/utils.js";
import type { FileUIPart, SourceDocumentUIPart } from "ai";
import {
  FileTextIcon,
  GlobeIcon,
  ImageIcon,
  Music2Icon,
  PaperclipIcon,
  PlayIcon,
  VideoIcon,
  XIcon,
} from "lucide-react";
import type {
  ComponentProps,
  HTMLAttributes,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import { createContext, useCallback, useContext, useMemo } from "react";

// ============================================================================
// Types
// ============================================================================

export type AttachmentData =
  | (FileUIPart & {
      id: string;
      description?: string;
      displayName?: string;
      sourceKind?: "clipboard-text";
    })
  | (SourceDocumentUIPart & {
      id: string;
      description?: string;
      displayName?: string;
      sourceKind?: "clipboard-text";
    });

export type AttachmentMediaCategory =
  | "image"
  | "video"
  | "audio"
  | "document"
  | "source"
  | "unknown";

export type AttachmentVariant = "grid" | "inline" | "list";

const mediaCategoryIcons: Record<AttachmentMediaCategory, typeof ImageIcon> = {
  audio: Music2Icon,
  document: FileTextIcon,
  image: ImageIcon,
  source: GlobeIcon,
  unknown: PaperclipIcon,
  video: VideoIcon,
};

// ============================================================================
// Utility Functions
// ============================================================================

export const getMediaCategory = (data: AttachmentData): AttachmentMediaCategory => {
  if (data.type === "source-document") {
    return "source";
  }

  const mediaType = data.mediaType ?? "";

  if (mediaType.startsWith("image/")) {
    return "image";
  }
  if (mediaType.startsWith("video/")) {
    return "video";
  }
  if (mediaType.startsWith("audio/")) {
    return "audio";
  }
  if (mediaType.startsWith("application/") || mediaType.startsWith("text/")) {
    return "document";
  }

  return "unknown";
};

export const getAttachmentLabel = (data: AttachmentData): string => {
  if (data.displayName) {
    return data.displayName;
  }

  if (data.type === "source-document") {
    return data.title || data.filename || "Source";
  }

  const category = getMediaCategory(data);
  return data.filename || (category === "image" ? "Image" : "Attachment");
};

const renderAttachmentImage = (url: string, filename: string | undefined, isGrid: boolean) =>
  isGrid ? (
    <img
      alt={filename || "Image"}
      className="size-full object-cover"
      height={96}
      src={url}
      width={96}
    />
  ) : (
    <img
      alt={filename || "Image"}
      className="size-full rounded object-cover"
      height={20}
      src={url}
      width={20}
    />
  );

// ============================================================================
// Contexts
// ============================================================================

interface AttachmentsContextValue {
  variant: AttachmentVariant;
}

const AttachmentsContext = createContext<AttachmentsContextValue | null>(null);

interface AttachmentContextValue {
  data: AttachmentData;
  mediaCategory: AttachmentMediaCategory;
  onRemove?: () => void;
  variant: AttachmentVariant;
}

const AttachmentContext = createContext<AttachmentContextValue | null>(null);

// ============================================================================
// Hooks
// ============================================================================

export const useAttachmentsContext = () =>
  useContext(AttachmentsContext) ?? { variant: "grid" as const };

export const useAttachmentContext = () => {
  const ctx = useContext(AttachmentContext);
  if (!ctx) {
    throw new Error("Attachment components must be used within <Attachment>");
  }
  return ctx;
};

// ============================================================================
// Attachments - Container
// ============================================================================

export type AttachmentsProps = HTMLAttributes<HTMLDivElement> & {
  variant?: AttachmentVariant;
};

export const Attachments = ({
  variant = "grid",
  className,
  children,
  ...props
}: AttachmentsProps) => {
  const contextValue = useMemo(() => ({ variant }), [variant]);

  return (
    <AttachmentsContext.Provider value={contextValue}>
      <div
        className={cn(
          "flex items-start",
          variant === "list" ? "flex-col gap-2" : "flex-wrap gap-2",
          variant === "grid" && "ml-auto w-fit",
          className,
        )}
        {...props}
      >
        {children}
      </div>
    </AttachmentsContext.Provider>
  );
};

// ============================================================================
// Attachment - Item
// ============================================================================

export type AttachmentProps = HTMLAttributes<HTMLDivElement> & {
  data: AttachmentData;
  variant?: AttachmentVariant;
  onRemove?: () => void;
  onOpen?: () => void;
  openLabel?: string;
};

export const Attachment = ({
  data,
  variant: variantOverride,
  onRemove,
  onOpen,
  openLabel,
  className,
  children,
  onClick,
  onKeyDown,
  role,
  tabIndex,
  "aria-label": ariaLabel,
  ...props
}: AttachmentProps) => {
  const { variant: contextVariant } = useAttachmentsContext();
  const variant = variantOverride ?? contextVariant;
  const mediaCategory = getMediaCategory(data);
  const isOpenable = Boolean(onOpen);

  const contextValue = useMemo<AttachmentContextValue>(
    () => ({ data, mediaCategory, onRemove, variant }),
    [data, mediaCategory, onRemove, variant],
  );

  // 上传后的图片附件之前只是普通 div，没有打开预览的交互入口。
  // 这里把可打开附件统一补成 click + Enter/Space，既修复鼠标点击，也保留键盘可访问性。
  const handleClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      onClick?.(event);
      if (event.defaultPrevented) {
        return;
      }
      onOpen?.();
    },
    [onClick, onOpen],
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      onKeyDown?.(event);
      if (event.defaultPrevented || !onOpen) {
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onOpen();
      }
    },
    [onKeyDown, onOpen],
  );

  return (
    <AttachmentContext.Provider value={contextValue}>
      <div
        aria-label={ariaLabel ?? openLabel}
        className={cn(
          "group relative",
          variant === "grid" && "size-24 overflow-hidden rounded-lg",
          variant === "inline" && [
            "flex h-8 select-none items-center gap-0.5",
            "overflow-hidden rounded-md border border-border p-1 pr-2.5",
            "font-medium text-ui-base transition-all",
            "bg-background",
            "[--attachment-bg:var(--color-background)]",
          ],
          variant === "list" && [
            "flex w-full items-center gap-3 rounded-lg border p-3",
            "hover:bg-accent/50",
          ],
          isOpenable && [
            "cursor-pointer hover:border-border-hover hover:text-accent-foreground",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          ],
          !isOpenable && "cursor-default",
          className,
        )}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        role={role ?? (isOpenable ? "button" : undefined)}
        tabIndex={tabIndex ?? (isOpenable ? 0 : undefined)}
        {...props}
      >
        {children}
      </div>
    </AttachmentContext.Provider>
  );
};

// ============================================================================
// AttachmentPreview - Media preview
// ============================================================================

export type AttachmentPreviewProps = HTMLAttributes<HTMLDivElement> & {
  fallbackIcon?: ReactNode;
};

export const AttachmentPreview = ({
  fallbackIcon,
  className,
  ...props
}: AttachmentPreviewProps) => {
  const { data, mediaCategory, variant } = useAttachmentContext();

  const iconSize = variant === "inline" ? "size-3" : "size-4";

  const renderIcon = (Icon: typeof ImageIcon) => (
    <Icon className={cn(iconSize, "text-muted-foreground")} />
  );

  const renderContent = () => {
    if (mediaCategory === "image" && data.type === "file" && data.url) {
      return renderAttachmentImage(data.url, data.filename, variant === "grid");
    }

    // Composer 的 video objectUrl 曾让 inline chip 嵌入一个静音播放器，
    // 从而丢失文件类型图标；完整视频预览由点击后的共享 Dialog 负责。
    if (mediaCategory === "video" && variant === "inline") {
      return renderIcon(mediaCategoryIcons.video);
    }

    if (mediaCategory === "video" && data.type === "file" && data.url) {
      return (
        <video
          aria-hidden="true"
          className="size-full object-cover"
          muted
          playsInline
          preload="metadata"
          src={data.url}
        />
      );
    }

    const Icon = mediaCategoryIcons[mediaCategory];
    return fallbackIcon ?? renderIcon(Icon);
  };

  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden",
        variant === "grid" && "size-full bg-muted",
        variant === "inline" && "size-5 rounded bg-background",
        variant === "list" && "size-12 rounded bg-muted",
        className,
      )}
      {...props}
    >
      {renderContent()}
      {mediaCategory === "video" && variant === "grid" ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 m-auto flex size-7 items-center justify-center rounded-full bg-black/55 text-white shadow-sm backdrop-blur-sm"
          data-attachment-video-play-overlay="true"
        >
          <PlayIcon className="size-4 translate-x-px fill-current" />
        </span>
      ) : null}
    </div>
  );
};

// ============================================================================
// AttachmentInfo - Name and type display
// ============================================================================

export type AttachmentInfoProps = HTMLAttributes<HTMLDivElement> & {
  showMediaType?: boolean;
};

export const AttachmentInfo = ({
  showMediaType = false,
  className,
  ...props
}: AttachmentInfoProps) => {
  const { data, variant } = useAttachmentContext();
  const label = getAttachmentLabel(data);
  const description = data.description;

  if (variant === "grid") {
    return null;
  }

  if (variant === "inline" && description) {
    return (
      <div className={cn("min-w-0 flex-1", className)} {...props}>
        <span className="block truncate">
          {label}
          <span className="text-foreground-subtle"> · {description}</span>
        </span>
      </div>
    );
  }

  return (
    <div className={cn("min-w-0 flex-1", className)} {...props}>
      <span className="block truncate">{label}</span>
      {description ? (
        <span className="block truncate text-muted-foreground text-ui-base">{description}</span>
      ) : null}
      {showMediaType && data.mediaType && (
        <span className="block truncate text-muted-foreground text-ui-base">{data.mediaType}</span>
      )}
    </div>
  );
};

// ============================================================================
// AttachmentRemove - Remove button
// ============================================================================

export type AttachmentRemoveProps = ComponentProps<typeof Button> & {
  alwaysVisible?: boolean;
  label?: string;
  placement?: "default" | "corner";
};

export const AttachmentRemove = ({
  alwaysVisible = false,
  label = "Remove",
  placement = "default",
  className,
  children,
  onClick,
  onPointerDown,
  ...props
}: AttachmentRemoveProps) => {
  const { onRemove, variant } = useAttachmentContext();

  const handleClick = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      onClick?.(event);
      if (event.defaultPrevented) {
        return;
      }
      event.preventDefault();
      onRemove?.();
    },
    [onClick, onRemove],
  );

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      onPointerDown?.(event);
    },
    [onPointerDown],
  );

  if (!onRemove) {
    return null;
  }

  if (variant === "inline" && placement === "default") {
    return (
      <span
        className={cn(
          "pointer-events-none absolute inset-y-0 right-0 z-10 flex items-center transition-opacity duration-150 ease-out",
          alwaysVisible
            ? "opacity-100"
            : "opacity-0 group-hover:opacity-100 focus-within:opacity-100",
        )}
      >
        <span className="h-full w-2 bg-gradient-to-r from-transparent to-[var(--attachment-bg)] transition-colors" />
        <span className="pointer-events-auto flex h-full w-6 items-center justify-center bg-[var(--attachment-bg)] transition-colors">
          <Button
            aria-label={label}
            className={cn("rounded-md", "[&>svg]:size-3", className)}
            onClick={handleClick}
            onPointerDown={handlePointerDown}
            size="icon-xs"
            type="button"
            variant="ghost"
            {...props}
          >
            {children ?? <XIcon />}
            <span className="sr-only">{label}</span>
          </Button>
        </span>
      </span>
    );
  }

  return (
    <Button
      aria-label={label}
      className={cn(
        variant === "grid" && [
          "absolute top-2 right-2 size-6 rounded-full p-0",
          "bg-background/80 backdrop-blur-sm",
          "opacity-0 transition-opacity group-hover:opacity-100",
          "hover:bg-background",
          "[&>svg]:size-3",
        ],
        variant === "list" && ["size-8 shrink-0 rounded p-0", "[&>svg]:size-4"],
        className,
      )}
      onClick={handleClick}
      onPointerDown={handlePointerDown}
      type="button"
      variant="ghost"
      {...props}
    >
      {children ?? <XIcon />}
      <span className="sr-only">{label}</span>
    </Button>
  );
};

// ============================================================================
// AttachmentHoverCard - Hover preview
// ============================================================================

export type AttachmentHoverCardProps = ComponentProps<typeof HoverCard>;

export const AttachmentHoverCard = ({
  openDelay = 0,
  closeDelay = 0,
  ...props
}: AttachmentHoverCardProps) => (
  <HoverCard closeDelay={closeDelay} openDelay={openDelay} {...props} />
);

export type AttachmentHoverCardTriggerProps = ComponentProps<typeof HoverCardTrigger>;

export const AttachmentHoverCardTrigger = (props: AttachmentHoverCardTriggerProps) => (
  <HoverCardTrigger {...props} />
);

export type AttachmentHoverCardContentProps = ComponentProps<typeof HoverCardContent>;

export const AttachmentHoverCardContent = ({
  align = "start",
  className,
  ...props
}: AttachmentHoverCardContentProps) => (
  <HoverCardContent align={align} className={cn("w-auto p-2", className)} {...props} />
);

// ============================================================================
// AttachmentEmpty - Empty state
// ============================================================================

export type AttachmentEmptyProps = HTMLAttributes<HTMLDivElement>;

export const AttachmentEmpty = ({ className, children, ...props }: AttachmentEmptyProps) => (
  <div
    className={cn(
      "flex items-center justify-center p-4 text-muted-foreground text-ui-base",
      className,
    )}
    {...props}
  >
    {children ?? "No attachments"}
  </div>
);
